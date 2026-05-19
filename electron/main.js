const { app, BrowserWindow, ipcMain, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const packageJson = require('../package.json');

app.disableHardwareAcceleration();

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
  CHECK_INTERVAL_MINUTES: '30'
};

let mainWindow = null;
let bot = null;
let botRunning = false;

const AEPHIA_TOKEN_VALIDATE_URL = 'https://api.aephia.com/token/validate';
const APP_DISPLAY_NAME = 'SA Crew Bot';

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
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(payload) {
  const merged = { ...(await loadSettings()), ...(payload || {}) };
  await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

async function persistBidIdentityFromStatus(status) {
  if (!status || !status.bidId) {
    return;
  }

  const current = await loadSettings();
  const nextBidId = String(status.bidId || '').trim();
  const nextBidState = String(status.bidState || '').trim();

  if (current.BID_ID === nextBidId && current.BID_STATE === nextBidState) {
    return;
  }

  await saveSettings({ BID_ID: nextBidId, BID_STATE: nextBidState });
  logger.info(`Persisted bid identity to settings: BID_ID=${nextBidId}, BID_STATE=${nextBidState || '(empty)'}`);
}

function makeBotConfig(s) {
  return {
    rpcUrl: s.RPC_URL,
    hotWalletSecret: s.HOT_WALLET_SECRET,
    side: s.SIDE === 'sell' ? 'sell' : 'buy',
    collectionSlugUuid: s.COLLECTION_SLUG_UUID,
    targetId: s.TARGET_ID,
    makerBroker: s.MAKER_BROKER,
    bidState: s.BID_STATE,
    bidId: s.BID_ID,
    marginAccount: s.MARGIN_ACCOUNT,
    quantity: Number(s.QUANTITY),
    minBidSol: Number(s.MIN_BID_SOL),
    maxBidSol: Number(s.MAX_BID_SOL),
    bidStepSol: Number(s.BID_STEP_SOL),
    checkIntervalMinutes: Number(s.CHECK_INTERVAL_MINUTES),
    whitelist: s.WHITELIST
  };
}

async function startBotFromSettings() {
  if (botRunning) {
    return;
  }

  const settings = await loadSettings();
  await validateAephiaApiKeyOrThrow(settings);
  bot = new CrewBidBot(makeBotConfig(settings), logger);
  botRunning = true;

  broadcast('bot-status', {
    running: true,
    status: bot.getStatus()
  });

  void bot.start().catch((err) => {
    logger.error('Bot exited with error:', err);
    botRunning = false;
    bot = null;
    broadcast('bot-status', {
      running: false,
      status: null
    });
  });
}

async function stopBot() {
  if (!bot || !botRunning) {
    return;
  }

  await bot.stop();
  botRunning = false;

  broadcast('bot-status', {
    running: false,
    status: bot ? bot.getStatus() : null
  });

  bot = null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 860,
    icon: path.join(__dirname, '..', 'assets', 'sa_crew_bot_avatar.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer.html'));
}

ipcMain.handle('settings:get', async () => {
  return await loadSettings();
});

ipcMain.handle('settings:save', async (_event, payload) => {
  return await saveSettings(payload);
});

ipcMain.handle('bot:start', async () => {
  await startBotFromSettings();
  return { running: botRunning };
});

ipcMain.handle('bot:stop', async () => {
  await stopBot();
  return { running: botRunning };
});

ipcMain.handle('bot:apply-settings-now', async () => {
  if (!bot || !botRunning) {
    return { ok: false, status: 'bot_not_running' };
  }

  const settings = await loadSettings();
  const nextConfig = makeBotConfig(settings);
  bot.applyConfigUpdates(nextConfig);
  await bot.runImmediateCycle();

  const status = bot.getStatus();
  await persistBidIdentityFromStatus(status);
  broadcast('bot-status', { running: true, status });

  return { ok: true, status: 'applied' };
});

ipcMain.handle('bot:get-status', async () => {
  if (!bot) {
    return {
      running: false,
      wallet: null,
      bidState: null,
      bidId: null,
      marginAccount: null,
      currentBidLamports: null,
      bestCompetingBidLamports: null,
      bestAskLamports: null,
      targetBidLamports: null,
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

  const status = bot.getStatus();
  await persistBidIdentityFromStatus(status);
  return status;
});

ipcMain.handle('bot:cancel-bid', async () => {
  if (!bot || !botRunning) {
    return {
      ok: false,
      status: 'bot_not_running'
    };
  }

  try {
    const changed = await bot.cancelBidNow();
    const status = bot.getStatus();

    broadcast('bot-status', {
      running: botRunning,
      status
    });

    return {
      ok: true,
      status: changed ? 'cancelled' : 'no_active_bid',
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
