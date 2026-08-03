const { app, BrowserWindow, ipcMain, Menu, dialog, powerSaveBlocker, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const { spawn } = require('child_process');
const lockfile = require('proper-lockfile');
const packageJson = require('../package.json');
const { dependencyInstallRequired } = require('./update-dependencies');
const { validateStagedRelease } = require('./atomic-update');
const stableIcon = require('./lib/stable-icon');
const { atomicWriteFile } = require('./lib/atomic-write');
const { createSecureSettingsStore } = require('./lib/secure-settings');
const { normalizeOrderPrices, parseOrderPriceRange } = require('./lib/order-price-limits');
const {
  assertTrustedIpcEvent,
  validateCancelBidPayload,
  validateRpcLimiterPayload,
  validateSettingsPayload,
} = require('./lib/ipc-security');

app.disableHardwareAcceleration();

// Disable Chromium background throttling. SA Crew Bid Bot is a 24/7
// automation process and must remain responsive even when its window
// is covered, minimized, or otherwise inactive on Windows.
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

const { resolvePaths } = require('rpc_limiter');
const { readState: readRpcLimiterState, writeStateSync: writeRpcLimiterStateSync, bumpRevision: bumpRpcLimiterRevision } = require('rpc_limiter/dist/state');
const { applyRpcLimiterSettings, resolveLimiterConnectionUrls } = require('./lib/rpc-limiter-settings-policy');
const { CrewBidBot } = require('../dist/crew_bid_bot');

const DEFAULT_SETTINGS = {
  AEPHIA_API_KEY: '',
  RPC_URL: 'https://api.mainnet-beta.solana.com',
  HOT_WALLET_SECRET: '',
  SIDE: 'buy',
  COLLECTION_SLUG_UUID: '42c0b80a-5945-4a18-84d3-467af9ccb9a2',
  TARGET_ID: '13oBYyDzdGJxMJPdzRjmCBALL5akjJkarK1C43SUt2Ep',
  MAKER_BROKER: 'DrFkK9QyDPDHHAgRi5jkAFkqeNDf4wkcyDtAv2CeL9tk',
  BID_STATE: '69xTWPeK7dprt2N1mHXdUyFsDN3uNhmL9CgeQ64FBhH4',
  BID_ID: 'DXBu4AQXu9XbeGWFC2awMfWKLFzuzdProppD6WU7jQ5V',
  MARGIN_ACCOUNT: '3sMSSpBbMNDBiAnzzHNVmXN7Epb9DKaRK3Ng7HtUMuEH',
  QUANTITY: '10',
  MAX_BID_SOL: '0.008',
  BID_STEP_SOL: '0.00001',
  RPC_REQUESTS_PER_SECOND: '10',
  RPC_TX_SEND_RATE_LIMIT_PER_SECOND: '1',
  USE_RPC_LIMITER: 'false',
  CHECK_INTERVAL_MINUTES: '30',
  MIN_RELEVANT_BID_QUANTITY: '',
  LIMIT_ORDERS: null
};

let mainWindow = null;
let botEntries = [];
let botRunning = false;
let relaunchScheduled = false;

// Never allow two automation instances to operate on the same settings/wallet.
// A second launch (manual, Startup, or scheduled task) focuses the existing app.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.exit(0);
}

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

const AEPHIA_TOKEN_VALIDATE_URL = 'https://api.aephia.com/token/validate';
const GITHUB_REPO = 'aephiaviktor/sa-crew-bot';
const GITHUB_MAIN_PACKAGE_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/package.json`;
const GITHUB_MAIN_ARCHIVE_URL = `https://github.com/${GITHUB_REPO}/archive/refs/heads/main.tar.gz`;
const APP_DISPLAY_NAME = 'SA Crew Bot';
const RESTART_TASK_NAME = 'SA Crew Bot';
const APP_ROOT = path.join(__dirname, '..');
const APP_USER_MODEL_ID = 'com.aephia.sa-crew-bot';
const RPC_LIMITER_UPDATED_BY = 'SA Crew Bot';
const UPDATE_TOTAL_BUDGET_MS = 30_000;
const UPDATE_RESTART_RESERVE_MS = 4_000;
const SECRET_SETTING_KEYS = ['AEPHIA_API_KEY', 'HOT_WALLET_SECRET', 'RPC_URL'];
let secureSettingsStore = null;

async function cleanupStaleUpdateDirectories() {
  const parentDir = path.dirname(APP_ROOT);
  const appName = path.basename(APP_ROOT);
  const entries = await fs.readdir(parentDir, { withFileTypes: true }).catch(() => []);
  const stalePrefixes = [
    '.sa-crew-bot-update-',
    '.sa-crew-bid-bot-rollback.stale-',
    `${appName}.failed-`,
  ];
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && stalePrefixes.some((prefix) => entry.name.startsWith(prefix)))
    .map((entry) => fs.rm(path.join(parentDir, entry.name), { recursive: true, force: true }).catch(() => undefined)));
}

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

// Keep the Windows icon outside the app tree so updates cannot invalidate it.
const WINDOW_ICON_STABLE = stableIcon.init({
  appKey: 'sa-crew-bid-bot',
  appUserModelId: APP_USER_MODEL_ID,
  sourceIconPath: path.join(APP_ROOT, 'assets', 'sa_crew_bot_avatar.ico'),
});

function getWindowIconPath() {
  if (process.platform === 'win32') return WINDOW_ICON_STABLE;
  return path.join(APP_ROOT, 'assets', 'sa_crew_bot_avatar.png');
}

function serializeCrashValue(value) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      code: value.code,
    };
  }
  if (value && typeof value === 'object') {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return String(value);
    }
  }
  return value;
}

function logCrashEvent(type, details = {}) {
  const logPath = path.join(APP_ROOT, 'analysis', 'crash-events.jsonl');
  const event = {
    timestamp: new Date().toISOString(),
    app: APP_DISPLAY_NAME,
    appId: APP_USER_MODEL_ID,
    profile: null,
    pid: process.pid,
    ppid: process.ppid,
    platform: process.platform,
    versions: {
      app: packageJson.version || 'unknown',
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
    type,
    details: serializeCrashValue(details),
  };
  try {
    fsSync.mkdirSync(path.dirname(logPath), { recursive: true });
    fsSync.appendFileSync(logPath, `${JSON.stringify(event)}\n`, 'utf8');
  } catch (err) {
    console.error('[SaCrewBot] failed to write crash event:', err);
  }
  console.error('[SaCrewBot] crash event:', JSON.stringify({ type, details: event.details }));
}

function attachWindowCrashLogging(win) {
  if (!win || !win.webContents) return;
  win.webContents.on('render-process-gone', (_event, details) => {
    logCrashEvent('window-render-process-gone', {
      title: win.getTitle(),
      url: win.webContents.getURL(),
      details,
    });
  });
  win.webContents.on('unresponsive', () => {
    logCrashEvent('window-unresponsive', {
      title: win.getTitle(),
      url: win.webContents.getURL(),
    });
  });
}

function installCrashEventLogging() {
  process.on('uncaughtExceptionMonitor', (error) => {
    logCrashEvent('uncaughtExceptionMonitor', error);
  });
  process.on('unhandledRejection', (reason) => {
    logCrashEvent('unhandledRejection', reason);
  });
  process.on('exit', (code) => {
    logCrashEvent('process-exit', { code });
  });
  app.on('render-process-gone', (_event, webContents, details) => {
    logCrashEvent('app-render-process-gone', {
      id: webContents?.id,
      url: typeof webContents?.getURL === 'function' ? webContents.getURL() : '',
      details,
    });
  });
  app.on('child-process-gone', (_event, details) => {
    logCrashEvent('child-process-gone', details);
  });
  app.on('gpu-process-crashed', (_event, killed) => {
    logCrashEvent('gpu-process-crashed', { killed });
  });
}

function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '');
}

function compareVersions(left, right) {
  const leftParts = normalizeVersion(left).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = normalizeVersion(right).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    if ((leftParts[index] || 0) > (rightParts[index] || 0)) return 1;
    if ((leftParts[index] || 0) < (rightParts[index] || 0)) return -1;
  }
  return 0;
}

async function fetchGithubJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'sa-crew-bot-updater'
    }
  });
  if (!response.ok) throw new Error(`GitHub request failed: HTTP ${response.status}`);
  return await response.json();
}

async function getLatestGithubVersion() {
  const remotePackage = await fetchGithubJson(GITHUB_MAIN_PACKAGE_URL);
  const version = normalizeVersion(remotePackage?.version);
  if (!version) throw new Error('No package version found on GitHub main.');
  return { version, branch: 'main', tarballUrl: GITHUB_MAIN_ARCHIVE_URL };
}

async function getUpdateState() {
  const currentVersion = packageJson.version || 'unknown';
  const latest = await getLatestGithubVersion();
  const versionUpdateAvailable = compareVersions(latest.version, currentVersion) > 0;
  return {
    currentVersion,
    runtimeVersion: currentVersion,
    localSourceVersion: currentVersion,
    remoteVersion: latest.version,
    updateAvailable: versionUpdateAvailable,
    versionUpdateAvailable,
    commitUpdateAvailable: false,
    hasLocalChanges: false
  };
}

function runProjectCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || APP_ROOT,
      shell: options.shell ?? process.platform === 'win32',
      windowsHide: true,
      env: options.env || process.env,
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('error', reject);
    let timedOut = false;
    const timeout = options.timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs) : null;
    child.on('close', (code) => {
      if (timeout) clearTimeout(timeout);
      if (code === 0) resolve(output);
      else if (timedOut) reject(new Error(`${command} exceeded the update time budget.`));
      else reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}: ${output.slice(-2000)}`));
    });
  });
}

async function downloadFile(url, targetPath, timeoutMs) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'sa-crew-bot-updater' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  await fs.writeFile(targetPath, Buffer.from(await response.arrayBuffer()));
}

function scheduleAppRelaunch(expectedVersion, updatePlan) {
  if (relaunchScheduled) return Promise.resolve();
  relaunchScheduled = true;

  const restartHelperExecutable = process.platform === 'win32' ? 'node.exe' : process.execPath;
  const restartHelper = spawn(restartHelperExecutable, [
    path.join(__dirname, 'restart-helper.js'),
    String(process.pid),
    RESTART_TASK_NAME,
    APP_DISPLAY_NAME,
    expectedVersion,
    APP_ROOT,
    path.join(__dirname, 'restart-status.ps1'),
    path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'SACrewBot', 'logs', 'supervisor.log'),
    updatePlan.stagedRoot,
    updatePlan.rollbackRoot,
    String(updatePlan.deadlineEpochMs),
  ], {
    cwd: path.dirname(APP_ROOT),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  });
  return new Promise((resolve, reject) => {
    restartHelper.once('error', (error) => {
      relaunchScheduled = false;
      reject(error);
    });
    restartHelper.once('spawn', () => {
      restartHelper.unref();
      // A clean exit lets the supervisor task become Ready. The detached helper
      // swaps the staged tree, starts the canonical task, and verifies startup.
      setTimeout(() => app.exit(0), 1200);
      resolve();
    });
  });
}

async function downloadUpdate() {
  const latest = await getLatestGithubVersion();
  const currentVersion = packageJson.version || 'unknown';
  if (compareVersions(latest.version, currentVersion) <= 0) return false;

  let deadlineEpochMs = Date.now() + UPDATE_TOTAL_BUDGET_MS;
  const remaining = () => deadlineEpochMs - Date.now() - UPDATE_RESTART_RESERVE_MS;
  const requireRemainingTime = () => {
    const milliseconds = remaining();
    if (milliseconds <= 0) {
      throw new Error('Update staging exceeded the 30-second time budget. The current installation was not changed.');
    }
    return milliseconds;
  };
  const parentDir = path.dirname(APP_ROOT);
  const workDir = await fs.mkdtemp(path.join(parentDir, '.sa-crew-bot-update-'));
  const stagedRoot = `${workDir}-staged`;
  const rollbackRoot = path.join(parentDir, '.sa-crew-bid-bot-rollback');
  const archivePath = path.join(workDir, 'main.tar.gz');
  try {
    await downloadFile(latest.tarballUrl, archivePath, requireRemainingTime());
    await runProjectCommand('tar', ['-xzf', archivePath, '-C', workDir], {
      cwd: workDir,
      timeoutMs: requireRemainingTime(),
    });
    const entries = await fs.readdir(workDir, { withFileTypes: true });
    const extracted = entries.find((entry) => entry.isDirectory() && entry.name.startsWith('sa-crew-bot-'));
    if (!extracted) throw new Error('Downloaded update archive did not contain the expected project folder.');

    const extractedRoot = path.join(workDir, extracted.name);
    const currentLockText = await fs.readFile(path.join(APP_ROOT, 'package-lock.json'), 'utf8').catch(() => null);
    const nextLockText = await fs.readFile(path.join(extractedRoot, 'package-lock.json'), 'utf8').catch(() => null);
    const installDependencies = dependencyInstallRequired(currentLockText, nextLockText);
    if (installDependencies) {
      emitUpdateProgress('dependencies', 'Installing updated dependencies safely...');
      await runProjectCommand(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--no-audit', '--no-fund'], {
        cwd: extractedRoot,
        timeoutMs: 300_000,
      });
      deadlineEpochMs = Date.now() + UPDATE_TOTAL_BUDGET_MS;
    }

    await fs.rename(extractedRoot, stagedRoot);
    // Releases commit their compiled dist/ output. Validate that output instead of
    // rebuilding on the target machine, where compilation can exhaust the update budget.
    await validateStagedRelease({ currentRoot: APP_ROOT, stagedRoot, dependenciesInstalled: installDependencies });
    requireRemainingTime();
    return { stagedRoot, rollbackRoot, deadlineEpochMs };
  } catch (error) {
    await fs.rm(stagedRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function installApplicationMenu() {
  const appVersion = packageJson.version || 'unknown';
  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About',
          click: () => {
            dialog.showMessageBox(mainWindow || undefined, {
              type: 'info',
              title: `About ${APP_DISPLAY_NAME}`,
              message: `${APP_DISPLAY_NAME} v${appVersion}`,
              detail: `Electron ${process.versions.electron}\nChrome ${process.versions.chrome}\nNode ${process.versions.node}`,
              buttons: ['OK'],
            });
          },
        },
      ],
    },
  ]);

  Menu.setApplicationMenu(menu);
}

function getAephiaApiKey(config) {
  return String(config?.AEPHIA_API_KEY || '').trim();
}

async function validateAephiaApiKeyOrThrow(config) {
  const token = getAephiaApiKey(config);
  if (!token) {
    throw new Error('Aephia API key missing. Add/refresh your Aephia token in settings before starting the bot.');
  }

  let response;
  try {
    response = await fetch(AEPHIA_TOKEN_VALIDATE_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new Error('Aephia token service/network unavailable. Temporary service problem; token was not marked invalid.');
  }

  if (response.status === 204) return;
  if (response.status === 401) {
    throw new Error('Aephia token auth failed. Refresh/reclaim your Aephia token in settings.');
  }
  if (response.status === 405) {
    throw new Error('Aephia token validation method rejected. Bot must use GET /token/validate.');
  }
  if (response.status >= 500) {
    throw new Error('Aephia token service unavailable. Temporary service problem; token was not marked invalid.');
  }
  throw new Error(`Unexpected Aephia token validation response: HTTP ${response.status}`);
}

function parseBooleanSetting(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function getRpcLimiterPaths() {
  return resolvePaths();
}

function buildProviderUrl(p) {
  const base = String(p?.rpcBaseUrl || '').trim();
  const apiKey = String(p?.apiKey || '').trim();
  if (!base) return '';
  if (!apiKey) return base;
  try {
    const url = new URL(base);
    url.searchParams.set('api-key', apiKey);
    return url.toString();
  } catch {
    const separator = base.includes('?') ? '&' : '?';
    return `${base}${separator}api-key=${encodeURIComponent(apiKey)}`;
  }
}

function getRpcLimiterStatus() {
  const paths = getRpcLimiterPaths();
  const state = readRpcLimiterState(paths.stateFile, Date.now());
  // Migration: pre-multi-provider state files stored rpcBaseUrl / apiKey
  // at the top level. Copy them into state.providers.main in memory so
  // existing configurations keep working without re-sending settings.
  if (!state.providers || (!state.providers.main?.rpcBaseUrl && !state.providers.fallback?.rpcBaseUrl)) {
    const legacyBase = String(state.rpcBaseUrl || '').trim();
    if (legacyBase) {
      state.providers = {
        main: { rpcBaseUrl: legacyBase, apiKey: String(state.apiKey || '').trim() },
        fallback: {},
      };
    }
  }
  const now = Date.now();
  const providers = state.providers || { main: {}, fallback: {} };
  const inCooldown = (p) => Boolean(p?.cooldownUntilMs && p.cooldownUntilMs > now);
  const available = (p) => Boolean(p?.rpcBaseUrl) && !inCooldown(p);

  const mainAvail = available(providers.main);
  const fallbackAvail = available(providers.fallback);
  let activeProvider = null;
  if (mainAvail && !fallbackAvail) activeProvider = 'main';
  else if (!mainAvail && fallbackAvail) activeProvider = 'fallback';

  return {
    path: paths.stateFile,
    enabled: Boolean(state.enabled),
    providers: {
      main: {
        url: buildProviderUrl(providers.main),
        cooldown: inCooldown(providers.main),
        cooldownUntil: providers.main?.cooldownUntilMs || null,
        failures: providers.main?.failures || 0
      },
      fallback: {
        url: buildProviderUrl(providers.fallback),
        cooldown: inCooldown(providers.fallback),
        cooldownUntil: providers.fallback?.cooldownUntilMs || null,
        failures: providers.fallback?.failures || 0
      }
    },
    activeProvider,
    buckets: state.buckets || {},
    updatedBy: state.updatedBy || '',
    updatedAt: state.updatedAt || '',
    revision: state.revision ?? 0
  };
}

async function withRpcLimiterLock(fn) {
  const paths = getRpcLimiterPaths();
  fsSync.mkdirSync(path.dirname(paths.lockfile), { recursive: true });
  if (!fsSync.existsSync(paths.lockfile)) {
    fsSync.writeFileSync(paths.lockfile, '');
  }

  const release = await lockfile.lock(paths.lockfile, {
    stale: 5000,
    retries: { retries: 50, minTimeout: 5, maxTimeout: 50, factor: 1.2 },
    realpath: false
  });
  try {
    return fn(paths);
  } finally {
    await release().catch(() => undefined);
  }
}

async function sendSettingsToRpcLimiter(config) {
  let operation;
  await withRpcLimiterLock((paths) => {
    const state = readRpcLimiterState(paths.stateFile, Date.now());
    operation = applyRpcLimiterSettings(state, {
      providerRole: config.providerRole,
      rpcUrl: config.RPC_URL,
      rpcRequestsPerSecond: config.RPC_REQUESTS_PER_SECOND,
      txRequestsPerSecond: config.RPC_TX_SEND_RATE_LIMIT_PER_SECOND,
    });
    state.updatedBy = RPC_LIMITER_UPDATED_BY;
    state.updatedAt = new Date().toISOString();
    bumpRpcLimiterRevision(state);
    writeRpcLimiterStateSync(paths.stateFile, state);
  });

  return { ...getRpcLimiterStatus(), operation };
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'crew-bid-settings.json');
}

function secureSettingsPath() {
  return path.join(app.getPath('userData'), 'crew-bid-secrets.enc.json');
}

async function getSecureSettingsStore() {
  if (secureSettingsStore) return secureSettingsStore;
  const asyncAvailable = await safeStorage.isAsyncEncryptionAvailable();
  const syncAvailable = safeStorage.isEncryptionAvailable();
  if (!asyncAvailable && !syncAvailable) {
    throw new Error('OS-protected secure storage is unavailable. Secrets were not saved.');
  }
  secureSettingsStore = createSecureSettingsStore({
    filePath: secureSettingsPath(),
    encryptString: asyncAvailable
      ? (value) => safeStorage.encryptStringAsync(value)
      : async (value) => safeStorage.encryptString(value),
    decryptString: asyncAvailable
      ? (value) => safeStorage.decryptStringAsync(value)
      : async (value) => ({ result: safeStorage.decryptString(value), shouldReEncrypt: false }),
    atomicWriteFile,
  });
  return secureSettingsStore;
}

function formatLogChunk(args) {
  return args
    .map((arg) => {
      if (arg instanceof Error) {
        return arg.stack || arg.message;
      }
      if (typeof arg === 'string') {
        return arg;
      }
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
}

function broadcast(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

const logger = {
  info: (...args) => {
    const message = formatLogChunk(args);
    console.log(message);
    broadcast('bot-log', { timestamp: new Date().toISOString(), level: 'INFO', message });
  },
  warn: (...args) => {
    const message = formatLogChunk(args);
    console.warn(message);
    broadcast('bot-log', { timestamp: new Date().toISOString(), level: 'WARN', message });
  },
  error: (...args) => {
    const message = formatLogChunk(args);
    console.error(message);
    broadcast('bot-log', { timestamp: new Date().toISOString(), level: 'ERROR', message });
  }
};

async function loadSettings(includeSecrets = false) {
  let stored = {};
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8');
    stored = JSON.parse(raw);
  } catch {}

  const secureStore = await getSecureSettingsStore();
  let secure = await secureStore.read();
  const migration = {};
  let hadPlaintextSecretFields = false;
  for (const key of SECRET_SETTING_KEYS) {
    if (Object.hasOwn(stored, key)) hadPlaintextSecretFields = true;
    if (!secure[key] && String(stored[key] || '').trim()) migration[key] = stored[key];
    delete stored[key];
  }
  if (Object.keys(migration).length) secure = await secureStore.update(migration);
  if (hadPlaintextSecretFields) {
    await atomicWriteFile(settingsPath(), JSON.stringify(stored, null, 2), 'utf8');
  }

  const settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...stored, ...secure });
  if (includeSecrets) return settings;
  for (const key of SECRET_SETTING_KEYS) settings[key] = '';
  settings.SECURE_SETTINGS_STATUS = Object.fromEntries(
    SECRET_SETTING_KEYS.map((key) => [key, Boolean(secure[key])])
  );
  return settings;
}

async function saveSettings(payload) {
  const secureStore = await getSecureSettingsStore();
  const secretPatch = {};
  for (const key of SECRET_SETTING_KEYS) {
    if (String(payload?.[key] || '').trim()) secretPatch[key] = payload[key];
  }
  if (Object.keys(secretPatch).length) await secureStore.update(secretPatch);
  const current = await loadSettings(true);
  const nonSecretPayload = { ...(payload || {}) };
  for (const key of SECRET_SETTING_KEYS) delete nonSecretPayload[key];
  const merged = normalizeSettings({ ...current, ...nonSecretPayload });
  for (const key of SECRET_SETTING_KEYS) delete merged[key];
  delete merged.SECURE_SETTINGS_STATUS;
  await atomicWriteFile(settingsPath(), JSON.stringify(merged, null, 2), 'utf8');
  return loadSettings(false);
}

async function getEffectiveBotSettings() {
  const settings = await loadSettings(true);
  const useRpcLimiter = parseBooleanSetting(settings.USE_RPC_LIMITER);
  const botSettings = { ...settings };

  if (useRpcLimiter) {
    const rpcLimiter = getRpcLimiterStatus();
    const limiterUrls = resolveLimiterConnectionUrls(rpcLimiter.providers);
    botSettings.RPC_URL = limiterUrls.rpcUrl;
    botSettings.RPC_URL_FALLBACK = limiterUrls.rpcUrlFallback;
  }

  return botSettings;
}

function makeOrderId() {
  return 'order-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function normalizeLimitOrder(row, index, settings) {
  const fallback = settings || DEFAULT_SETTINGS;
  const prices = normalizeOrderPrices(row, fallback.MIN_BID_SOL, fallback.MAX_BID_SOL);
  return {
    id: String(row?.id || makeOrderId()),
    side: row?.side === 'sell' ? 'sell' : 'buy',
    bidState: String(row?.bidState ?? row?.BID_STATE ?? fallback.BID_STATE ?? '').trim(),
    bidId: String(row?.bidId ?? row?.BID_ID ?? fallback.BID_ID ?? '').trim(),
    quantity: String(row?.quantity ?? row?.QUANTITY ?? fallback.QUANTITY ?? '10').trim(),
    refillBelowQuantity: String(row?.refillBelowQuantity ?? row?.REFILL_BELOW_QUANTITY ?? '').trim(),
    minBidSol: prices.minBidSol,
    maxBidSol: prices.maxBidSol
  };
}

function normalizeSettings(settings) {
  const normalized = { ...settings };
  normalized.MIN_RELEVANT_BID_QUANTITY ||= normalized.QUANTITY;

  const rows = Array.isArray(normalized.LIMIT_ORDERS) && normalized.LIMIT_ORDERS.length
    ? normalized.LIMIT_ORDERS
    : [
        {
          side: normalized.SIDE,
          bidState: normalized.BID_STATE,
          bidId: normalized.BID_ID,
          quantity: normalized.QUANTITY,
          refillBelowQuantity: '',
          minBidSol: normalized.MIN_BID_SOL,
          maxBidSol: normalized.MAX_BID_SOL
        }
      ];

  normalized.LIMIT_ORDERS = rows.map((row, index) => normalizeLimitOrder(row, index, normalized));
  const first = normalized.LIMIT_ORDERS[0];
  normalized.SIDE = first.side;
  normalized.BID_STATE = first.bidState;
  normalized.BID_ID = first.bidId;
  normalized.QUANTITY = first.quantity;
  normalized.MAX_BID_SOL = first.maxBidSol;
  delete normalized.MIN_BID_SOL;

  return normalized;
}

async function persistBidIdentityFromStatus(status, rowId) {
  if (!status || !status.bidId) {
    return;
  }

  const current = await loadSettings(true);
  const nextBidId = String(status.bidId || '').trim();
  const nextBidState = String(status.bidState || '').trim();
  const currentRows = Array.isArray(current.LIMIT_ORDERS) ? current.LIMIT_ORDERS : [];
  const previousRow = currentRows.find((row) => row.id === rowId);
  const nextRows = currentRows.map((row) =>
    row.id === rowId ? { ...row, bidId: nextBidId, bidState: nextBidState } : row
  );

  if (previousRow?.bidId === nextBidId && previousRow?.bidState === nextBidState) {
    return;
  }

  await saveSettings({ LIMIT_ORDERS: nextRows });
  logger.info('Persisted bid identity to settings for ' + rowId + ': BID_ID=' + nextBidId + ', BID_STATE=' + (nextBidState || '(empty)'));
}

function makeBotConfig(s, row) {
  const order = normalizeLimitOrder(row || {}, 0, s);
  const { minBidSol, maxBidSol } = parseOrderPriceRange(order.minBidSol, order.maxBidSol);
  const quantity = Number(order.quantity);
  const refillBelowQuantity = Number(order.refillBelowQuantity);
  const minRelevantBidQuantity = Number(s.MIN_RELEVANT_BID_QUANTITY);

  return {
    rowId: order.id,
    rpcUrl: s.RPC_URL,
    hotWalletSecret: s.HOT_WALLET_SECRET,
    side: order.side === 'sell' ? 'sell' : 'buy',
    skill: s.SKILL,
    aptitude: s.APTITUDE,
    collectionSlugUuid: s.COLLECTION_SLUG_UUID,
    targetId: s.TARGET_ID,
    makerBroker: s.MAKER_BROKER,
    bidState: order.bidState,
    bidId: order.bidId,
    marginAccount: s.MARGIN_ACCOUNT,
    quantity,
    refillBelowQuantity: order.refillBelowQuantity !== '' && Number.isFinite(refillBelowQuantity) && refillBelowQuantity > 0
      ? Math.floor(refillBelowQuantity)
      : null,
    minRelevantBidQuantity: Number.isFinite(minRelevantBidQuantity) && minRelevantBidQuantity > 0 ? minRelevantBidQuantity : quantity,
    minBidSol,
    maxBidSol,
    bidStepSol: Number(s.BID_STEP_SOL),
    checkIntervalMinutes: Number(s.CHECK_INTERVAL_MINUTES),
    useRpcLimiter: parseBooleanSetting(s.USE_RPC_LIMITER)
  };
}

function emptyStatus() {
  return {
    running: false,
    rowStatuses: [],
    wallet: null,
    bidState: null,
    bidId: null,
    marginAccount: null,
    currentBidLamports: null,
    bestCompetingBidLamports: null,
    competingBidLamports: [],
    bestAskLamports: null,
    targetBidLamports: null,
    currentOrderTraitsLabel: '—',
    lastCheckAt: null,
    lastAction: null,
    lastUpdatedAt: null,
    startedAt: null,
    lastCycleStartedAt: null,
    lastCycleCompletedAt: null,
    lastCycleDurationMs: null,
    checkIntervalMinutes: null,
    solBalance: null,
    marginAccountSolBalance: null,
    openOrders: [],
    recentActivity: []
  };
}

async function getCombinedBotStatus() {
  if (!botEntries.length) {
    return emptyStatus();
  }

  const statuses = await Promise.all(
    botEntries.map(async (entry) => {
      const status = await entry.bot.getStatus();
      await persistBidIdentityFromStatus(status, entry.row.id);
      return { entry, status };
    })
  );
  const first = statuses[0]?.status || emptyStatus();

  return {
    ...first,
    running: botRunning,
    rowStatuses: statuses.map(({ entry, status }) => ({
      rowId: entry.row.id,
      bidState: status.bidState || entry.row.bidState || null,
      bidId: status.bidId || entry.row.bidId || null,
      traitsLabel: status.currentOrderTraitsLabel || '—'
    })),
    openOrders: statuses.flatMap(({ status }) => status.openOrders || []),
    recentActivity: statuses
      .flatMap(({ status, entry }) =>
        (status.recentActivity || []).map((activity) => ({
          ...activity,
          message: 'Order ' + (entry.index + 1) + ': ' + (activity.message || '')
        }))
      )
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 16)
  };
}

async function startBotFromSettings() {
  if (botRunning) {
    return;
  }

  const settings = await getEffectiveBotSettings();
  await validateAephiaApiKeyOrThrow(settings);
  botEntries = settings.LIMIT_ORDERS.map((row, index) => ({
    row,
    index,
    bot: new CrewBidBot(makeBotConfig(settings, row), logger)
  }));
  botRunning = true;

  broadcast('bot-status', {
    running: true,
    status: await getCombinedBotStatus()
  });

  void Promise.all(botEntries.map((entry) => entry.bot.start())).catch((err) => {
    logger.error('Bot exited with error:', err);
    botRunning = false;
    botEntries = [];
    broadcast('bot-status', {
      running: false,
      status: null
    });
  });
}

async function stopBot() {
  if (!botEntries.length || !botRunning) {
    return;
  }

  await Promise.all(botEntries.map((entry) => entry.bot.stop()));
  botRunning = false;

  broadcast('bot-status', {
    running: false,
    status: await getCombinedBotStatus()
  });

  botEntries = [];
}

function createWindow() {
  const iconPath = getWindowIconPath();
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 860,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  stableIcon.applyToWindow(mainWindow, iconPath);
  attachWindowCrashLogging(mainWindow);

  mainWindow.loadFile(path.join(__dirname, 'renderer.html'));
}

installCrashEventLogging();

const rendererPath = path.join(__dirname, 'renderer.html');

function handleTrustedIpc(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedIpcEvent(event, rendererPath);
    return handler(...args);
  });
}

handleTrustedIpc('settings:get', async () => {
  return await loadSettings();
});

handleTrustedIpc('settings:save', async (payload) => {
  return await saveSettings(validateSettingsPayload(payload));
});

handleTrustedIpc('rpc-limiter:get-status', async () => {
  return getRpcLimiterStatus();
});

handleTrustedIpc('rpc-limiter:send-settings', async (payload) => {
  const config = validateRpcLimiterPayload(payload);
  return await sendSettingsToRpcLimiter(config);
});

handleTrustedIpc('bot:start', async () => {
  try {
    await startBotFromSettings();
    return { ok: true, running: botRunning };
  } catch (err) {
    logger.error('Start bot failed:', err);
    botRunning = false;
    botEntries = [];
    broadcast('bot-status', {
      running: false,
      status: null
    });
    return {
      ok: false,
      running: false,
      message: err?.message || String(err)
    };
  }
});

handleTrustedIpc('bot:stop', async () => {
  await stopBot();
  return { running: botRunning };
});

handleTrustedIpc('bot:apply-settings-now', async () => {
  if (!botEntries.length || !botRunning) {
    return { ok: false, status: 'bot_not_running' };
  }

  await stopBot();
  await startBotFromSettings();
  const status = await getCombinedBotStatus();
  broadcast('bot-status', { running: true, status });

  return { ok: true, status: 'applied' };
});

handleTrustedIpc('bot:get-status', async () => {
  return await getCombinedBotStatus();
});

handleTrustedIpc('bot:cancel-bid', async (rowId) => {
  rowId = validateCancelBidPayload(rowId);
  if (!botEntries.length || !botRunning) {
    return {
      ok: false,
      status: 'bot_not_running'
    };
  }

  try {
    const targetEntries = rowId ? botEntries.filter((entry) => entry.row.id === rowId) : botEntries;
    if (!targetEntries.length) {
      return {
        ok: false,
        status: 'order_not_found'
      };
    }
    const results = await Promise.all(targetEntries.map((entry) => entry.bot.cancelBidNow()));
    const status = await getCombinedBotStatus();

    broadcast('bot-status', {
      running: botRunning,
      status
    });

    return {
      ok: true,
      status: results.some(Boolean) ? 'cancelled' : 'no_active_bid',
      botStatus: status
    };
  } catch (err) {
    logger.error('Cancel bid failed:', err);
    return {
      ok: false,
      status: 'error',
      message: err?.message || String(err)
    };
  }
});

handleTrustedIpc('app:get-version', async () => {
  return {
    version: packageJson.version || 'unknown'
  };
});

handleTrustedIpc('app:check-update', async () => {
  try {
    return { ok: true, ...(await getUpdateState()) };
  } catch (err) {
    return { ok: false, message: err?.message || String(err) };
  }
});

handleTrustedIpc('app:apply-update', async () => {
  let stoppedBotForUpdate = false;
  let updatePlan = null;
  try {
    const before = await getUpdateState();
    if (!before.updateAvailable) return { ok: true, status: 'up_to_date', ...before };
    updatePlan = await downloadUpdate();
    if (botRunning) {
      await stopBot();
      stoppedBotForUpdate = true;
    }
    await scheduleAppRelaunch(before.remoteVersion, updatePlan);
    return {
      ok: true,
      status: 'updated',
      stoppedBotForUpdate,
      relaunching: true,
      currentVersion: before.remoteVersion,
      remoteVersion: before.remoteVersion,
      updateAvailable: false,
      versionUpdateAvailable: false,
      commitUpdateAvailable: false,
      hasLocalChanges: false
    };
  } catch (err) {
    if (updatePlan?.stagedRoot && !relaunchScheduled) {
      await fs.rm(updatePlan.stagedRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    if (stoppedBotForUpdate) {
      try { await startBotFromSettings(); } catch (restartErr) { logger.error('Bot restart after failed update failed:', restartErr); }
    }
    return { ok: false, status: 'error', message: err?.message || String(err) };
  }
});

app.whenReady().then(async () => {
  const powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension')
  console.log(`[SA-Crew] prevent-app-suspension blocker=${powerSaveBlockerId} active=${powerSaveBlocker.isStarted(powerSaveBlockerId)}`)

  installApplicationMenu();
  void cleanupStaleUpdateDirectories();
  createWindow();

  try {
    await startBotFromSettings();
  } catch (err) {
    logger.error('Auto-start failed:', err);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', async (event) => {
  if (botRunning) {
    event.preventDefault();
    try {
      await stopBot();
    } finally {
      app.exit(0);
    }
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
