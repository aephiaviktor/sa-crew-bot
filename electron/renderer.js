const mainFields = [
  'SIDE',
  'BID_STATE',
  'BID_ID',
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
const limitOrdersBodyEl = document.getElementById('limit-orders-body');
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
const addLimitOrderRowBtn = document.getElementById('add-limit-order-row-btn');
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
let lastUpdateCheckCycleCompletedAt = null;
let updateCheckInProgress = false;
let limitOrderRows = [];

function makeRowId() {
  return 'row-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function normalizeLimitOrderRow(row = {}) {
  return {
    id: String(row.id || makeRowId()),
    side: row.side === 'sell' ? 'sell' : 'buy',
    bidState: String(row.bidState ?? row.BID_STATE ?? '').trim(),
    bidId: String(row.bidId ?? row.BID_ID ?? '').trim(),
    quantity: String(row.quantity ?? row.QUANTITY ?? '').trim(),
    maxBidSol: String(row.maxBidSol ?? row.MAX_BID_SOL ?? '').trim(),
    traitsLabel: String(row.traitsLabel ?? '').trim()
  };
}

function fallbackLimitOrderFromConfig(config = {}) {
  return normalizeLimitOrderRow({
    side: config.SIDE,
    bidState: config.BID_STATE,
    bidId: config.BID_ID,
    quantity: config.QUANTITY,
    maxBidSol: config.MAX_BID_SOL
  });
}

function getLimitOrderRowsFromDom() {
  if (!limitOrdersBodyEl) {
    return limitOrderRows;
  }

  return Array.from(limitOrdersBodyEl.querySelectorAll('tr[data-row-id]')).map((rowEl) =>
    normalizeLimitOrderRow({
      id: rowEl.dataset.rowId,
      side: rowEl.querySelector('[data-field="side"]')?.value,
      bidState: rowEl.querySelector('[data-field="bidState"]')?.value,
      bidId: rowEl.querySelector('[data-field="bidId"]')?.value,
      quantity: rowEl.querySelector('[data-field="quantity"]')?.value,
      maxBidSol: rowEl.querySelector('[data-field="maxBidSol"]')?.value,
      traitsLabel: rowEl.querySelector('[data-field="traitsLabel"]')?.textContent
    })
  );
}

function setRowHintText(rowEl) {
  const side = rowEl.querySelector('[data-field="side"]')?.value || 'buy';
  const quantityHint = rowEl.querySelector('[data-role="quantity-hint"]');
  const priceHint = rowEl.querySelector('[data-role="price-hint"]');
  if (quantityHint) quantityHint.textContent = side === 'sell' ? 'Min sell quantity' : 'Max buy quantity';
  if (priceHint) priceHint.textContent = side === 'sell' ? 'Min price' : 'Max price';
}

function renderLimitOrderRows(rows) {
  limitOrderRows = (Array.isArray(rows) && rows.length ? rows : [{}]).map(normalizeLimitOrderRow);

  if (!limitOrdersBodyEl) {
    return;
  }

  limitOrdersBodyEl.innerHTML = '';
  for (const [index, row] of limitOrderRows.entries()) {
    const tr = document.createElement('tr');
    tr.dataset.rowId = row.id;
    tr.innerHTML = `
      <td>
        <select data-field="side" name="SIDE_${index}">
          <option value="buy"${row.side === 'buy' ? ' selected' : ''}>buy</option>
          <option value="sell"${row.side === 'sell' ? ' selected' : ''}>sell</option>
        </select>
      </td>
      <td>
        <div class="cell-stack">
          <input data-field="bidState" name="BID_STATE_${index}" type="text" value="${escapeHtml(row.bidState)}" />
          <span class="cell-hint">Tensor bid state</span>
        </div>
      </td>
      <td>
        <div class="cell-stack">
          <input data-field="bidId" name="BID_ID_${index}" type="text" value="${escapeHtml(row.bidId)}" />
          <span class="cell-hint">Tensor bid id</span>
        </div>
      </td>
      <td>
        <div class="cell-stack">
          <input data-field="quantity" name="QUANTITY_${index}" type="number" value="${escapeHtml(row.quantity)}" />
          <span class="cell-hint" data-role="quantity-hint">Max buy quantity</span>
        </div>
      </td>
      <td>
        <div class="cell-stack">
          <input data-field="maxBidSol" name="MAX_BID_SOL_${index}" type="text" value="${escapeHtml(row.maxBidSol)}" />
          <span class="cell-hint" data-role="price-hint">Max price</span>
        </div>
      </td>
      <td>
        <span class="trait-display" data-field="traitsLabel">${escapeHtml(row.traitsLabel || '—')}</span>
      </td>
      <td class="remove-cell">
        <div class="cell-stack">
          <button class="cancel-order-btn" type="button" data-action="cancel-row">Cancel Order</button>
          <button class="remove-row-btn" type="button" data-action="remove-row">Remove</button>
        </div>
      </td>
    `;
    setRowHintText(tr);
    tr.querySelector('[data-field="side"]')?.addEventListener('change', () => setRowHintText(tr));
    tr.querySelector('[data-action="remove-row"]')?.addEventListener('click', () => {
      const nextRows = getLimitOrderRowsFromDom().filter((candidate) => candidate.id !== row.id);
      renderLimitOrderRows(nextRows.length ? nextRows : [normalizeLimitOrderRow({})]);
      setMainActionFeedback('Row removed. Save settings to apply.', 'info');
    });
    tr.querySelector('[data-action="cancel-row"]')?.addEventListener('click', async (event) => {
      await cancelActiveBidFromUi(event.currentTarget, row.id);
    });
    limitOrdersBodyEl.appendChild(tr);
  }
}

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

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function updateLimitOrderHints() {
  for (const rowEl of Array.from(limitOrdersBodyEl?.querySelectorAll('tr[data-row-id]') || [])) {
    setRowHintText(rowEl);
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
  const rows = getLimitOrderRowsFromDom();
  data.LIMIT_ORDERS = rows;
  const first = rows[0] || {};
  data.SIDE = first.side || data.SIDE || 'buy';
  data.BID_STATE = first.bidState || '';
  data.BID_ID = first.bidId || '';
  data.QUANTITY = first.quantity || '';
  data.MAX_BID_SOL = first.maxBidSol || '';
  return data;
}

function writeFormConfig(config) {
  const rows = Array.isArray(config?.LIMIT_ORDERS) && config.LIMIT_ORDERS.length
    ? config.LIMIT_ORDERS
    : [fallbackLimitOrderFromConfig(config)];
  renderLimitOrderRows(rows);

  for (const key of fields) {
    const element = mainForm.elements.namedItem(key) || form.elements.namedItem(key);
    if (element) {
      element.value = config[key] ?? '';
    }
  }
  updateLimitOrderHints();
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
  if (updateCheckInProgress) {
    return;
  }

  updateCheckInProgress = true;
  try {
    const result = await window.botApi.checkUpdate();
    if (result?.ok) {
      setUpdateButtonAvailable(result.updateAvailable);
    }
  } catch {
    setUpdateButtonAvailable(false);
  } finally {
    updateCheckInProgress = false;
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
  if (status?.lastCycleCompletedAt && status.lastCycleCompletedAt !== lastUpdateCheckCycleCompletedAt) {
    lastUpdateCheckCycleCompletedAt = status.lastCycleCompletedAt;
    void refreshUpdateButtonState();
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
  for (const [index, rowEl] of Array.from(limitOrdersBodyEl?.querySelectorAll('tr[data-row-id]') || []).entries()) {
    const order = incomingOpenOrders[index];
    const traitsEl = rowEl.querySelector('[data-field="traitsLabel"]');
    const bidStateEl = rowEl.querySelector('[data-field="bidState"]');
    const bidIdEl = rowEl.querySelector('[data-field="bidId"]');
    if (traitsEl) {
      traitsEl.textContent = order?.traitsLabel || (index === 0 ? status?.currentOrderTraitsLabel : '') || '—';
      traitsEl.title = traitsEl.textContent;
    }
    if (bidStateEl && order?.bidState) {
      bidStateEl.value = order.bidState;
    }
    if (bidIdEl && order?.bidId) {
      bidIdEl.value = order.bidId;
    }
  }

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

mainForm.elements.namedItem('SIDE')?.addEventListener('change', updateLimitOrderHints);

async function cancelActiveBidFromUi(sourceButton, rowId = null) {
  if (sourceButton) {
    sourceButton.disabled = true;
  }
  if (cancelBidBtn && cancelBidBtn !== sourceButton) {
    cancelBidBtn.disabled = true;
  }

  try {
    const result = await window.botApi.cancelBid(rowId);

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
    if (sourceButton) {
      sourceButton.disabled = false;
    }
    if (cancelBidBtn && cancelBidBtn !== sourceButton) {
      cancelBidBtn.disabled = false;
    }
  }
}

cancelBidBtn?.addEventListener('click', async () => {
  await cancelActiveBidFromUi(cancelBidBtn);
});

addLimitOrderRowBtn?.addEventListener('click', () => {
  const rows = getLimitOrderRowsFromDom();
  renderLimitOrderRows([
    ...rows,
    normalizeLimitOrderRow({
      side: 'buy',
      bidState: '',
      bidId: '',
      quantity: rows[0]?.quantity || '',
      maxBidSol: rows[0]?.maxBidSol || ''
    })
  ]);
  setMainActionFeedback('Row added. Save settings to apply.', 'info');
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
