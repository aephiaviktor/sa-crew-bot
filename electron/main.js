const { app, BrowserWindow, ipcMain, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const lockfile = require('proper-lockfile');
const packageJson = require('../package.json');

app.disableHardwareAcceleration();

const { resolvePaths } = require('rpc_limiter');
const { readState: readRpcLimiterState, writeStateSync: writeRpcLimiterStateSync, bumpRevision: bumpRpcLimiterRevision } = require('rpc_limiter/dist/state');
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
  MIN_BID_SOL: '0.001',
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

const AEPHIA_TOKEN_VALIDATE_URL = 'https://api.aephia.com/token/validate';
const APP_DISPLAY_NAME = 'SA Crew Bot';
const APP_ROOT = path.join(__dirname, '..');
const APP_USER_MODEL_ID = 'com.aephia.sa-crew-bot';
const RPC_LIMITER_UPDATED_BY = 'SA Crew Bot';
const execFileAsync = promisify(execFile);

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

function getWindowIconPath() {
  return path.join(APP_ROOT, 'assets', process.platform === 'win32' ? 'sa_crew_bot_avatar.ico' : 'sa_crew_bot_avatar.png');
}

function shortCommit(value) {
  return String(value || '').trim().slice(0, 7) || 'unknown';
}

function compareVersions(left, right) {
  const leftParts = String(left || '').split('.').map((part) => Number.parseInt(part, 10));
  const rightParts = String(right || '').split('.').map((part) => Number.parseInt(part, 10));
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = Number.isFinite(leftParts[index]) ? leftParts[index] : 0;
    const rightPart = Number.isFinite(rightParts[index]) ? rightParts[index] : 0;
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }

  return 0;
}

async function runProjectCommand(command, args, options = {}) {
  const result = await execFileAsync(command, args, {
    cwd: APP_ROOT,
    timeout: options.timeout || 120000,
    maxBuffer: options.maxBuffer || 1024 * 1024
  });
  return {
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim()
  };
}

async function gitOutput(args, options) {
  const result = await runProjectCommand('git', args, options);
  return result.stdout;
}

function scheduleAppRelaunch() {
  if (relaunchScheduled) {
    return;
  }

  relaunchScheduled = true;
  setTimeout(() => {
    app.relaunch();
    app.exit(0);
  }, 1200);
}

async function readRemotePackageJson() {
  try {
    const raw = await gitOutput(['show', 'origin/main:package.json']);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readLocalPackageJson() {
  try {
    const raw = await fs.readFile(path.join(APP_ROOT, 'package.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return packageJson;
  }
}

async function getUpdateState(fetchRemote) {
  if (fetchRemote) {
    await gitOutput(['fetch', '--prune', 'origin', 'main'], { timeout: 120000 });
  }

  const [currentCommit, remoteCommit, statusOutput] = await Promise.all([
    gitOutput(['rev-parse', 'HEAD']),
    gitOutput(['rev-parse', 'origin/main']),
    gitOutput(['status', '--porcelain'])
  ]);
  const localPackage = await readLocalPackageJson();
  const remotePackage = await readRemotePackageJson();
  const runtimeVersion = packageJson.version || 'unknown';
  const localSourceVersion = localPackage?.version || runtimeVersion;
  const currentVersion = runtimeVersion;
  const remoteVersion = remotePackage?.version || null;
  const commitUpdateAvailable = currentCommit !== remoteCommit;
  const versionUpdateAvailable = remoteVersion ? compareVersions(remoteVersion, currentVersion) > 0 : false;

  return {
    currentVersion,
    runtimeVersion,
    localSourceVersion,
    remoteVersion,
    currentCommit,
    remoteCommit,
    currentShortCommit: shortCommit(currentCommit),
    remoteShortCommit: shortCommit(remoteCommit),
    updateAvailable: versionUpdateAvailable || commitUpdateAvailable,
    versionUpdateAvailable,
    commitUpdateAvailable,
    hasLocalChanges: statusOutput.length > 0
  };
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

function buildSharedRpcUrl(state) {
  const base = String(state?.rpcBaseUrl || '').trim();
  const apiKey = String(state?.apiKey || '').trim();
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

  return {
    path: paths.stateFile,
    enabled: Boolean(state.enabled),
    rpcBaseUrl: state.rpcBaseUrl || '',
    apiKey: state.apiKey || '',
    currentRpcUrl: buildSharedRpcUrl(state),
    buckets: state.buckets || {},
    updatedBy: state.updatedBy || '',
    updatedAt: state.updatedAt || '',
    revision: state.revision ?? 0
  };
}

function parseRpcUrlForLimiter(rawValue) {
  const raw = String(rawValue || '').trim();
  if (!raw) {
    throw new Error('RPC URL is empty.');
  }

  const url = new URL(raw);
  const apiKey = url.searchParams.get('api-key') || '';
  url.searchParams.delete('api-key');
  const remainingQuery = url.searchParams.toString();
  const pathname = url.pathname === '/' ? '' : url.pathname;
  const rpcBaseUrl = `${url.origin}${pathname}${remainingQuery ? `?${remainingQuery}` : ''}`;

  return { rpcBaseUrl, apiKey };
}

function parsePositiveRate(value, fieldName) {
  const parsed = Number.parseFloat(String(value ?? '').trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive number.`);
  }
  return parsed;
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
  const { rpcBaseUrl, apiKey } = parseRpcUrlForLimiter(config.RPC_URL);
  const rpcRequestsPerSecond = parsePositiveRate(config.RPC_REQUESTS_PER_SECOND, 'Requests / sec');
  const txPerSecond = parsePositiveRate(config.RPC_TX_SEND_RATE_LIMIT_PER_SECOND, 'sendTransaction / sec');
  const rpcIntervalMs = Math.max(1, Math.round(1000 / rpcRequestsPerSecond));
  const txIntervalMs = Math.max(1, Math.round(1000 / txPerSecond));

  await withRpcLimiterLock((paths) => {
    const state = readRpcLimiterState(paths.stateFile, Date.now());
    state.enabled = true;
    state.rpcBaseUrl = rpcBaseUrl;
    state.apiKey = apiKey;
    state.buckets = state.buckets || {};
    state.buckets['rpc:shared'] = {
      ...(state.buckets['rpc:shared'] || { nextSlotMs: 0 }),
      intervalMs: rpcIntervalMs
    };
    state.buckets['tx:shared'] = {
      ...(state.buckets['tx:shared'] || { nextSlotMs: 0 }),
      intervalMs: txIntervalMs
    };
    state.updatedBy = RPC_LIMITER_UPDATED_BY;
    state.updatedAt = new Date().toISOString();
    bumpRpcLimiterRevision(state);
    writeRpcLimiterStateSync(paths.stateFile, state);
  });

  return getRpcLimiterStatus();
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'crew-bid-settings.json');
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

async function loadSettings() {
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8');
    const settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    return normalizeSettings(settings);
  } catch {
    const settings = { ...DEFAULT_SETTINGS };
    return normalizeSettings(settings);
  }
}

async function saveSettings(payload) {
  const merged = normalizeSettings({ ...(await loadSettings()), ...(payload || {}) });
  await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

async function getEffectiveBotSettings() {
  const settings = await loadSettings();
  const useRpcLimiter = parseBooleanSetting(settings.USE_RPC_LIMITER);
  const botSettings = { ...settings };

  if (useRpcLimiter) {
    const rpcLimiter = getRpcLimiterStatus();
    if (!rpcLimiter.currentRpcUrl) {
      throw new Error('Use RPC Limiter is enabled, but no Current RPC Limiter URL is configured. Send settings to RPC Limiter first.');
    }
    botSettings.RPC_URL = rpcLimiter.currentRpcUrl;
  }

  return botSettings;
}

function makeOrderId() {
  return 'order-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function normalizeLimitOrder(row, index, settings) {
  const fallback = settings || DEFAULT_SETTINGS;
  return {
    id: String(row?.id || makeOrderId()),
    side: row?.side === 'sell' ? 'sell' : 'buy',
    bidState: String(row?.bidState ?? row?.BID_STATE ?? fallback.BID_STATE ?? '').trim(),
    bidId: String(row?.bidId ?? row?.BID_ID ?? fallback.BID_ID ?? '').trim(),
    quantity: String(row?.quantity ?? row?.QUANTITY ?? fallback.QUANTITY ?? '10').trim(),
    maxBidSol: String(row?.maxBidSol ?? row?.MAX_BID_SOL ?? fallback.MAX_BID_SOL ?? '0.008').trim()
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

  return normalized;
}

async function persistBidIdentityFromStatus(status, rowId) {
  if (!status || !status.bidId) {
    return;
  }

  const current = await loadSettings();
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
  const quantity = Number(order.quantity);
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
    minRelevantBidQuantity: Number.isFinite(minRelevantBidQuantity) && minRelevantBidQuantity > 0 ? minRelevantBidQuantity : quantity,
    minBidSol: Number(s.MIN_BID_SOL),
    maxBidSol: Number(order.maxBidSol),
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
      nodeIntegration: false
    }
  });

  if (typeof mainWindow.setIcon === 'function') {
    mainWindow.setIcon(iconPath);
  }

  mainWindow.loadFile(path.join(__dirname, 'renderer.html'));
}

ipcMain.handle('settings:get', async () => {
  return await loadSettings();
});

ipcMain.handle('settings:save', async (_event, payload) => {
  return await saveSettings(payload);
});

ipcMain.handle('rpc-limiter:get-status', async () => getRpcLimiterStatus());

ipcMain.handle('rpc-limiter:send-settings', async (_event, payload) => {
  return await sendSettingsToRpcLimiter(payload || {});
});

ipcMain.handle('bot:start', async () => {
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

ipcMain.handle('bot:stop', async () => {
  await stopBot();
  return { running: botRunning };
});

ipcMain.handle('bot:apply-settings-now', async () => {
  if (!botEntries.length || !botRunning) {
    return { ok: false, status: 'bot_not_running' };
  }

  await stopBot();
  await startBotFromSettings();
  const status = await getCombinedBotStatus();
  broadcast('bot-status', { running: true, status });

  return { ok: true, status: 'applied' };
});

ipcMain.handle('bot:get-status', async () => {
  return await getCombinedBotStatus();
});

ipcMain.handle('bot:cancel-bid', async (_event, rowId) => {
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

ipcMain.handle('app:get-version', async () => {
  return {
    version: packageJson.version || 'unknown'
  };
});

ipcMain.handle('app:check-update', async () => {
  try {
    const state = await getUpdateState(true);
    return {
      ok: true,
      ...state
    };
  } catch (err) {
    return {
      ok: false,
      message: err?.message || String(err)
    };
  }
});

ipcMain.handle('app:apply-update', async () => {
  let stoppedBotForUpdate = false;
  try {
    const before = await getUpdateState(true);
    if (!before.updateAvailable) {
      return {
        ok: true,
        status: 'up_to_date',
        ...before
      };
    }

    if (before.hasLocalChanges) {
      return {
        ok: false,
        status: 'local_changes',
        message: 'Local source changes are present. Commit or stash them before updating.',
        ...before
      };
    }

    if (botRunning) {
      await stopBot();
      stoppedBotForUpdate = true;
    }

    await gitOutput(['pull', '--ff-only', 'origin', 'main'], { timeout: 120000 });
    await runProjectCommand('npm', ['install'], { timeout: 240000, maxBuffer: 4 * 1024 * 1024 });
    await runProjectCommand('npm', ['run', 'build'], { timeout: 240000, maxBuffer: 4 * 1024 * 1024 });

    const after = await getUpdateState(false);
    scheduleAppRelaunch();
    return {
      ok: true,
      status: 'updated',
      previousCommit: before.currentCommit,
      previousShortCommit: before.currentShortCommit,
      stoppedBotForUpdate,
      relaunching: true,
      ...after
    };
  } catch (err) {
    if (stoppedBotForUpdate) {
      try {
        await startBotFromSettings();
      } catch (restartErr) {
        logger.error('Bot restart after failed update failed:', restartErr);
      }
    }

    return {
      ok: false,
      status: 'error',
      message: err?.message || String(err)
    };
  }
});

app.whenReady().then(async () => {
  installApplicationMenu();
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
