const mainFields = [
  'SIDE',
  'QUANTITY',
  'MAX_BID_SOL'
];

const setupFields = [
  'AEPHIA_API_KEY',
  'RPC_URL',
  'HOT_WALLET_SECRET',
  'COLLECTION_SLUG_UUID',
  'TARGET_ID',
  'MAKER_BROKER',
  'BID_STATE',
  'BID_ID',
  'MARGIN_ACCOUNT',
  'BID_STEP_SOL',
  'MIN_BID_SOL',
  'CHECK_INTERVAL_MINUTES',
  'MIN_RELEVANT_BID_QUANTITY'
];

const fields = [...mainFields, ...setupFields];
const STATUS_POLL_MS = 60000;
let appVersion = 'unknown';

const mainForm = document.getElementById('main-form');
const form = document.getElementById('config-form');
const logsEl = document.getElementById('logs');
const saveBtn = document.getElementById('save-btn');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const mainActionFeedbackEl = document.getElementById('main-action-feedback');
const toggleSensitiveBtn = document.getElementById('toggle-sensitive-btn');
const tabButtons = Array.from(document.querySelectorAll('.tab-button'));
const tabPanels = Array.from(document.querySelectorAll('.tab-panel'));

const runningPillEl = document.getElementById('running-pill');
const walletAddressEl = document.getElementById('wallet-address');
const solBalanceEl = document.getElementById('sol-balance');
const marginSolBalanceEl = document.getElementById('margin-sol-balance');
const botRuntimeEl = document.getElementById('bot-runtime');
const lastCycleAtEl = document.getElementById('last-cycle-at');
const nextCycleInEl = document.getElementById('next-cycle-in');

const currentBidEl = document.getElementById('current-bid');
const bestCompetingBidEl = document.getElementById('best-competing-bid');
const bestAskEl = document.getElementById('best-ask');
const targetBidEl = document.getElementById('target-bid');
const marginNrEl = document.getElementById('margin-nr');
const lastActionEl = document.getElementById('last-action');
const lastCheckAtEl = document.getElementById('last-check-at');
const cancelBidBtn = document.getElementById('cancel-bid-btn');
const updateBtn = document.getElementById('update-btn');
const updateModal = document.getElementById('update-modal');
const updateCurrentVersionEl = document.getElementById('update-current-version');
const updateLatestVersionEl = document.getElementById('update-latest-version');
const updateMessageEl = document.getElementById('update-message');
const updateConfirmBtn = document.getElementById('update-confirm-btn');
const updateCancelBtn = document.getElementById('update-cancel-btn');

const openOrdersCountEl = document.getElementById('open-orders-count');
const openOrdersListEl = document.getElementById('open-orders-list');
const recentActivityCountEl = document.getElementById('recent-activity-count');
const recentActivityListEl = document.getElementById('recent-activity-list');

let sensitiveVisible = false;
let statusPollHandle = null;
let lastKnownOpenOrders = [];
let lastKnownRecentActivity = [];
let lastUiRefreshAtMs = null;
let availableUpdate = null;

function setUpdateButtonAvailable(available) {
  updateBtn?.classList.toggle('update-available', Boolean(available));
}

function setRunning(running) {
  startBtn.disabled = running;
  stopBtn.disabled = !running;

  if (runningPillEl) {
    runningPillEl.textContent = running ? 'Running' : 'Stopped';
    runningPillEl.classList.toggle('running', running);
    runningPillEl.classList.toggle('stopped', !running);
  }
}

function setSensitiveVisible(visible) {
  sensitiveVisible = visible;
  form.classList.toggle('sensitive-hidden', !visible);
  toggleSensitiveBtn.textContent = visible ? 'Hide Sensitive Fields' : 'Show Sensitive Fields';
}

function setActiveTab(tabName) {
  for (const button of tabButtons) {
    const active = button.dataset.tab === tabName;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  }

  for (const panel of tabPanels) {
    panel.classList.toggle('active', panel.dataset.panel === tabName);
  }
}

function readFormConfig() {
  const data = {};
  for (const key of fields) {
    const element = mainForm.elements.namedItem(key) || form.elements.namedItem(key);
    data[key] = element ? String(element.value ?? '').trim() : '';
  }
  return data;
}

function writeFormConfig(config) {
  for (const key of fields) {
    const element = mainForm.elements.namedItem(key) || form.elements.namedItem(key);
    if (element) {
      element.value = config[key] ?? '';
    }
  }
}

function appendLog(line) {
  logsEl.textContent += `${line}\n`;
  logsEl.scrollTop = logsEl.scrollHeight;
}

function setMainActionFeedback(message, tone = 'info') {
  if (!mainActionFeedbackEl) {
    return;
  }

  mainActionFeedbackEl.textContent = message || '';
  mainActionFeedbackEl.classList.toggle('error', tone === 'error');
  mainActionFeedbackEl.classList.toggle('success', tone === 'success');
}

function formatNumber(value, maximumFractionDigits = 6) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—';
  }
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits
  }).format(value);
}

function formatLamportsToSol(value) {
  const lamports = Number(value ?? NaN);
  if (!Number.isFinite(lamports)) {
    return '—';
  }
  return `${(lamports / 1_000_000_000).toFixed(6)} SOL`;
}

function formatTimestamp(value) {
  if (!value) {
    return '—';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return date.toLocaleString();
}

function formatRelativeDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
    return '—';
  }

  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }

  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}

function formatRuntime(startedAt, running) {
  const versionSuffix = ' | v' + appVersion;

  if (!running || !startedAt) {
    return 'Stopped' + versionSuffix;
  }

  const start = new Date(startedAt);
  if (Number.isNaN(start.getTime())) {
    return 'Running' + versionSuffix;
  }

  const elapsed = Date.now() - start.getTime();
  return 'Running for ' + formatRelativeDuration(elapsed) + versionSuffix;
}

function setUpdateModalOpen(open) {
  if (updateModal) {
    updateModal.hidden = !open;
  }
}

function renderUpdateModalState(result, error = null) {
  const currentVersion = result?.currentVersion || appVersion;
  const latestVersion = result?.remoteVersion || result?.currentVersion || appVersion;

  if (result?.ok) {
    setUpdateButtonAvailable(result.updateAvailable);
  }

  updateCurrentVersionEl.textContent = 'v' + currentVersion;
  updateLatestVersionEl.textContent = result ? 'v' + latestVersion : 'Unknown';
  updateConfirmBtn.disabled = !result?.updateAvailable || result?.hasLocalChanges;

  if (error) {
    updateLatestVersionEl.textContent = 'Unavailable';
    updateMessageEl.textContent = 'Update check failed: ' + (error?.message || String(error));
    updateConfirmBtn.textContent = 'Update';
    return;
  }

  if (result && !result.ok) {
    updateLatestVersionEl.textContent = 'Unavailable';
    updateMessageEl.textContent = 'Update check failed: ' + (result.message || 'unknown error');
    updateConfirmBtn.textContent = 'Update';
    return;
  }

  if (result?.hasLocalChanges) {
    updateMessageEl.textContent = 'Local source changes are present. Commit or stash them before updating.';
    updateConfirmBtn.textContent = 'Update';
    return;
  }

  if (result?.updateAvailable) {
    updateMessageEl.textContent = 'A newer SA Crew Bot version is available on GitHub.';
    updateConfirmBtn.textContent = 'Update to v' + latestVersion;
    return;
  }

  updateMessageEl.textContent = 'SA Crew Bot is already up to date.';
  updateConfirmBtn.textContent = 'Update';
}

async function openUpdateDialog() {
  availableUpdate = null;
  updateCurrentVersionEl.textContent = 'v' + appVersion;
  updateLatestVersionEl.textContent = 'Checking...';
  updateMessageEl.textContent = 'Checking GitHub for the latest version...';
  updateConfirmBtn.textContent = 'Update';
  updateConfirmBtn.disabled = true;
  updateCancelBtn.disabled = false;
  setUpdateModalOpen(true);

  try {
    availableUpdate = await window.botApi.checkUpdate();
    renderUpdateModalState(availableUpdate);
  } catch (err) {
    availableUpdate = null;
    renderUpdateModalState(null, err);
    appendLog('[' + new Date().toISOString() + '] [ERROR] Update check failed: ' + (err?.message || String(err)));
  }
}

async function refreshUpdateButtonState() {
  try {
    const result = await window.botApi.checkUpdate();
    if (result?.ok) {
      setUpdateButtonAvailable(result.updateAvailable);
    }
  } catch {
    setUpdateButtonAvailable(false);
  }
}

function formatCycleInterval(minutes) {
  const normalized = Number(minutes);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return '—';
  }

  return Math.round(normalized) + 'm';
}

function shortenWallet(value) {
  if (!value || typeof value !== 'string' || value === '—') {
    return '—';
  }
  if (value.length <= 18) {
    return value;
  }
  return `${value.slice(0, 6)}…${value.slice(-6)}`;
}

function setListCount(element, count) {
  element.textContent = String(count ?? 0);
}

function renderOpenOrders(orders) {
  openOrdersListEl.innerHTML = '';
  setListCount(openOrdersCountEl, orders.length);

  if (!orders.length) {
    openOrdersListEl.innerHTML = '<div class="empty-state">No open orders</div>';
    return;
  }

  for (const order of orders) {
    const item = document.createElement('div');
    item.className = 'status-item order-item';

    const quantityLabel = typeof order.quantity === 'number' ? formatNumber(order.quantity, 0) : '—';
    const remainingLabel = typeof order.remaining === 'number' ? formatNumber(order.remaining, 0) : quantityLabel;

    item.innerHTML = `
      <div class="status-item-top">
        <div class="order-left">
          <span class="order-asset">${order.label || 'Crew Bid'}</span>
          <span class="badge ${order.side === 'sell' ? 'sell' : 'buy'}">${order.side || 'buy'}</span>
          ${order.marketLeader === 'bb' ? '<span class="badge leader">BB</span>' : ''}
        </div>
        <div class="order-right">
          <span class="order-metric">
            <span class="order-metric-label">Price</span>
            <span>${formatLamportsToSol(order.priceLamports)}</span>
          </span>
          <span class="order-metric">
            <span class="order-metric-label">Qty</span>
            <span>${remainingLabel} / ${quantityLabel}</span>
          </span>
        </div>
      </div>
      <div class="status-item-row">
        <span class="status-item-subtle">Order</span>
        <span class="status-item-value">${order.bidState || order.bidId || '—'}</span>
      </div>
    `;

    openOrdersListEl.appendChild(item);
  }
}

function getActivityTone(entry) {
  if (entry.event === 'FILLED') {
    return 'filled';
  }
  if (entry.event === 'START') {
    return 'start';
  }
  if (entry.event === 'MARGIN_LOW') {
    return 'margin-low';
  }
  if (entry.event === 'MARGIN_EMPTY') {
    return 'margin-empty';
  }
  return 'default';
}

function getActivityBadge(entry) {
  if (entry.event === 'FILLED') {
    return '<span class="badge activity-badge filled">FILLED</span>';
  }
  if (entry.event === 'START') {
    return '<span class="badge activity-badge start">START</span>';
  }
  if (entry.event === 'MARGIN_LOW') {
    return '<span class="badge activity-badge margin-low">MARGIN LOW</span>';
  }
  if (entry.event === 'MARGIN_EMPTY') {
    return '<span class="badge activity-badge margin-empty">MARGIN EMPTY</span>';
  }
  return '';
}

function renderRecentActivity(items) {
  recentActivityListEl.innerHTML = '';
  setListCount(recentActivityCountEl, items.length);

  if (!items.length) {
    recentActivityListEl.innerHTML = '<div class="empty-state">No recent activity</div>';
    return;
  }

  for (const entry of items) {
    const tone = getActivityTone(entry);
    const item = document.createElement('div');
    item.className = `status-item activity-item activity-item-${tone}`;

    item.innerHTML = `
      <div class="status-item-top">
        <div class="activity-left">
          <span class="activity-title">${entry.title || entry.event || 'Activity'}</span>
          ${getActivityBadge(entry)}
        </div>
        <div class="activity-right">
          <span class="activity-metric">
            <span class="activity-metric-label">At</span>
            <span>${formatTimestamp(entry.timestamp)}</span>
          </span>
        </div>
      </div>
      <div class="status-item-row">
        <span class="status-item-subtle">Details</span>
        <span class="status-item-value">${entry.message || '—'}</span>
      </div>
    `;

    recentActivityListEl.appendChild(item);
  }
}

function renderStatusSnapshot(status) {
  const hasStatusPayload = status && Object.keys(status).length > 0;
  if (!hasStatusPayload) {
    return;
  }

  const running = Boolean(status?.running);
  setRunning(running);
  lastUiRefreshAtMs = Date.now();

  const bidIdField = form.elements.namedItem('BID_ID');
  if (bidIdField && status?.bidId) {
    bidIdField.value = status.bidId;
  }
  const bidStateField = form.elements.namedItem('BID_STATE');
  if (bidStateField && typeof status?.bidState === 'string') {
    bidStateField.value = status.bidState;
  }

  currentBidEl.textContent = formatLamportsToSol(status?.currentBidLamports);
  bestCompetingBidEl.textContent = formatLamportsToSol(status?.bestCompetingBidLamports);
  bestAskEl.textContent = formatLamportsToSol(status?.bestAskLamports);
  targetBidEl.textContent = formatLamportsToSol(status?.targetBidLamports);
  lastActionEl.textContent = status?.lastAction || '—';
  lastCheckAtEl.textContent = formatTimestamp(status?.lastCheckAt);

  if (walletAddressEl) {
    walletAddressEl.textContent = shortenWallet(status?.wallet || '—');
    walletAddressEl.title = status?.wallet || '—';
  }
  if (solBalanceEl) {
    solBalanceEl.textContent = typeof status?.solBalance === 'number' ? `${formatNumber(status.solBalance, 6)} SOL` : '—';
  }
  if (marginSolBalanceEl) {
    marginSolBalanceEl.textContent =
      typeof status?.marginAccountSolBalance === 'number' ? `${formatNumber(status.marginAccountSolBalance, 6)} SOL` : '—';
  }
  if (botRuntimeEl) {
    if (!status?.startedAt && running) {
      botRuntimeEl.textContent = formatRuntime(new Date().toISOString(), true);
    } else {
      botRuntimeEl.textContent = formatRuntime(status?.startedAt, running);
    }
  }
  if (lastCycleAtEl) {
    lastCycleAtEl.textContent = formatTimestamp(status?.lastCycleCompletedAt);
  }
  if (nextCycleInEl) {
    const configuredInterval = Number((form.elements.namedItem('CHECK_INTERVAL_MINUTES') || {}).value ?? NaN);
    const intervalMinutes = Number.isFinite(Number(status?.checkIntervalMinutes))
      ? Number(status.checkIntervalMinutes)
      : configuredInterval;
    const cycleLabel = formatCycleInterval(intervalMinutes);
    nextCycleInEl.textContent = cycleLabel;
  }

  const incomingOpenOrders = Array.isArray(status?.openOrders) ? status.openOrders : [];
  const incomingRecentActivity = Array.isArray(status?.recentActivity) ? status.recentActivity : [];

  if (incomingOpenOrders.length > 0) {
    lastKnownOpenOrders = incomingOpenOrders;
  } else if (!running) {
    lastKnownOpenOrders = [];
  }

  if (incomingRecentActivity.length > 0) {
    lastKnownRecentActivity = incomingRecentActivity;
  } else if (!running) {
    lastKnownRecentActivity = [];
  }

  const shouldUseFallbackOpenOrders = running && incomingOpenOrders.length === 0 && lastKnownOpenOrders.length > 0;
  const shouldUseFallbackActivity = running && incomingRecentActivity.length === 0 && lastKnownRecentActivity.length > 0;

  renderOpenOrders(shouldUseFallbackOpenOrders ? lastKnownOpenOrders : incomingOpenOrders);
  renderRecentActivity(shouldUseFallbackActivity ? lastKnownRecentActivity : incomingRecentActivity);
}

async function refreshBotStatus() {
  try {
    const status = await window.botApi.getBotStatus();
    renderStatusSnapshot(status || {});
  } catch (err) {
    appendLog(`[${new Date().toISOString()}] [ERROR] Failed to fetch bot status: ${err?.message || String(err)}`);
  }
}

function startStatusPolling() {
  stopStatusPolling();
  statusPollHandle = window.setInterval(() => {
    void refreshBotStatus();
  }, STATUS_POLL_MS);
}

function stopStatusPolling() {
  if (statusPollHandle) {
    window.clearInterval(statusPollHandle);
    statusPollHandle = null;
  }
}

async function boot() {
  const versionInfo = await window.botApi.getAppVersion();
  appVersion = versionInfo?.version || appVersion;

  const settings = await window.botApi.getSettings();
  writeFormConfig(settings);
  setSensitiveVisible(false);
  setRunning(false);
  setActiveTab('main');

  window.botApi.onLog((entry) => {
    appendLog(`[${entry.timestamp}] [${entry.level}] ${entry.message}`);

    const message = String(entry?.message || '');
    if (message.includes('Bid') || message.includes('Cancelling') || message.includes('Tensor') || message.includes('cycle')) {
      void refreshBotStatus();
    }
  });

  window.botApi.onStatus((entry) => {
    if (entry?.status && Object.keys(entry.status).length > 0) {
      renderStatusSnapshot(entry.status);
    }
    setRunning(Boolean(entry?.running));
  });

  for (const button of tabButtons) {
    button.addEventListener('click', () => {
      setActiveTab(button.dataset.tab);
    });
  }

  await refreshBotStatus();
  void refreshUpdateButtonState();
  startStatusPolling();
}

saveBtn.addEventListener('click', async () => {
  setMainActionFeedback('Saving settings...');
  saveBtn.disabled = true;

  try {
    const result = await window.botApi.saveSettings(readFormConfig());
    writeFormConfig(result);
    appendLog(`[${new Date().toISOString()}] [INFO] Settings saved`);
    setMainActionFeedback('Settings saved.', 'success');

    const wasRunning = startBtn.disabled;
    if (wasRunning) {
      appendLog(`[${new Date().toISOString()}] [INFO] Applying settings immediately...`);
      const applyResult = await window.botApi.applySettingsNow();
      if (!applyResult?.ok) {
        appendLog(`[${new Date().toISOString()}] [WARN] Live apply failed, restarting bot...`);
        await window.botApi.stopBot();
        const startResult = await window.botApi.startBot();
        if (!startResult?.ok) {
          throw new Error(startResult?.message || 'Bot restart failed');
        }
      }
      await refreshBotStatus();
    }
  } catch (err) {
    const message = err?.message || String(err);
    setMainActionFeedback(message, 'error');
    appendLog(`[${new Date().toISOString()}] [ERROR] ${message}`);
  } finally {
    saveBtn.disabled = false;
  }
});

startBtn.addEventListener('click', async () => {
  setMainActionFeedback('Starting bot...');
  startBtn.disabled = true;

  try {
    await window.botApi.saveSettings(readFormConfig());
    const result = await window.botApi.startBot();
    if (!result?.ok) {
      throw new Error(result?.message || 'Bot failed to start');
    }
    await refreshBotStatus();
    setMainActionFeedback('Bot started.', 'success');
  } catch (err) {
    const message = err?.message || String(err);
    setRunning(false);
    setMainActionFeedback(message, 'error');
    appendLog(`[${new Date().toISOString()}] [ERROR] Start bot failed: ${message}`);
  }
});

stopBtn.addEventListener('click', async () => {
  setMainActionFeedback('Stopping bot...');
  stopBtn.disabled = true;

  try {
    await window.botApi.stopBot();
    await refreshBotStatus();
    setMainActionFeedback('Bot stopped.', 'success');
  } catch (err) {
    const message = err?.message || String(err);
    setMainActionFeedback(message, 'error');
    appendLog(`[${new Date().toISOString()}] [ERROR] Stop bot failed: ${message}`);
  }
});

toggleSensitiveBtn.addEventListener('click', () => {
  setSensitiveVisible(!sensitiveVisible);
});

cancelBidBtn?.addEventListener('click', async () => {
  cancelBidBtn.disabled = true;
  try {
    const result = await window.botApi.cancelBid();

    if (result?.ok) {
      appendLog(`[${new Date().toISOString()}] [INFO] Cancel bid ${result.status}`);
      renderStatusSnapshot(result.botStatus || {});
    } else {
      appendLog(
        `[${new Date().toISOString()}] [ERROR] Cancel bid failed: ${result?.message || result?.status || 'unknown error'}`
      );
    }
  } catch (err) {
    appendLog(`[${new Date().toISOString()}] [ERROR] ${err?.message || String(err)}`);
  } finally {
    cancelBidBtn.disabled = false;
  }
});

updateBtn?.addEventListener('click', () => {
  void openUpdateDialog();
});

updateCancelBtn?.addEventListener('click', () => {
  setUpdateModalOpen(false);
});

updateModal?.addEventListener('click', (event) => {
  if (event.target === updateModal) {
    setUpdateModalOpen(false);
  }
});

updateConfirmBtn?.addEventListener('click', async () => {
  if (!availableUpdate?.updateAvailable) return;
  updateConfirmBtn.disabled = true;
  updateCancelBtn.disabled = true;
  updateMessageEl.textContent = 'Updating SA Crew Bot from GitHub...';
  appendLog('[' + new Date().toISOString() + '] [INFO] Updating SA Crew Bot from GitHub...');

  try {
    const result = await window.botApi.applyUpdate();

    if (result?.ok && result.status === 'updated') {
      renderUpdateModalState(result);
      updateMessageEl.textContent = 'Updated to v' + (result.remoteVersion || result.currentVersion || appVersion) + '. Restarting app...';
      appendLog('[' + new Date().toISOString() + '] [INFO] App updated. Restarting automatically...');
    } else if (result?.ok) {
      renderUpdateModalState(result);
      appendLog('[' + new Date().toISOString() + '] [INFO] App update status: ' + (result.status || 'ok'));
    } else {
      renderUpdateModalState(availableUpdate, new Error(result?.message || 'unknown error'));
      appendLog('[' + new Date().toISOString() + '] [ERROR] App update failed: ' + (result?.message || 'unknown error'));
    }
  } catch (err) {
    renderUpdateModalState(availableUpdate, err);
    appendLog('[' + new Date().toISOString() + '] [ERROR] App update failed: ' + (err?.message || String(err)));
  } finally {
    updateCancelBtn.disabled = false;
  }
});

window.addEventListener('beforeunload', () => {
  stopStatusPolling();
});

boot().catch((err) => {
  appendLog(`[${new Date().toISOString()}] [ERROR] ${err?.message || String(err)}`);
});
