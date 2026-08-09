const { pathToFileURL } = require('node:url');

const SETTINGS_FIELDS = new Set([
  'AEPHIA_API_KEY', 'RPC_URL', 'HOT_WALLET_SECRET', 'SIDE', 'COLLECTION_SLUG_UUID',
  'TARGET_ID', 'MAKER_BROKER', 'BID_STATE', 'BID_ID', 'MARGIN_ACCOUNT', 'QUANTITY',
  'MAX_BID_SOL', 'BID_STEP_SOL', 'RPC_REQUESTS_PER_SECOND',
  'RPC_TX_SEND_RATE_LIMIT_PER_SECOND', 'USE_RPC_LIMITER', 'CHECK_INTERVAL_MINUTES',
  'MIN_RELEVANT_BID_QUANTITY', 'LIMIT_ORDERS',
]);
const RPC_LIMITER_FIELDS = new Set([
  'rpcUrl', 'rpcRequestsPerSecond', 'txRequestsPerSecond', 'providerRole',
]);
const LIMIT_ORDER_FIELDS = new Set([
  'id', 'side', 'bidState', 'bidId', 'quantity', 'refillBelowQuantity', 'minBidSol', 'maxBidSol', 'traitsLabel',
]);

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object.`);
  }
}

function assertBoundedPrimitive(value, field) {
  if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'string' && value.length > 20000)) {
    throw new TypeError(`Invalid value for ${field}.`);
  }
}

function validateLimitOrders(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new TypeError('LIMIT_ORDERS must contain between 1 and 100 orders.');
  }
  return value.map((row) => {
    assertPlainObject(row, 'Limit order');
    const clean = {};
    for (const [key, fieldValue] of Object.entries(row)) {
      if (!LIMIT_ORDER_FIELDS.has(key)) throw new TypeError(`Unknown limit-order field: ${key}`);
      assertBoundedPrimitive(fieldValue, key);
      clean[key] = fieldValue;
    }
    return clean;
  });
}

function validateObjectFields(payload, allowedFields, label) {
  assertPlainObject(payload, label);
  const clean = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!allowedFields.has(key)) throw new TypeError(`Unknown ${label.toLowerCase()} field: ${key}`);
    assertBoundedPrimitive(value, key);
    clean[key] = value;
  }
  return clean;
}

function validateSettingsPayload(payload) {
  assertPlainObject(payload, 'Settings payload');
  const clean = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!SETTINGS_FIELDS.has(key)) throw new TypeError(`Unknown settings field: ${key}`);
    clean[key] = key === 'LIMIT_ORDERS' ? validateLimitOrders(value) : (assertBoundedPrimitive(value, key), value);
  }
  return clean;
}

function validateRpcLimiterPayload(payload) {
  return validateObjectFields(payload, RPC_LIMITER_FIELDS, 'RPC limiter');
}

function validateCancelBidPayload(rowId) {
  if (rowId === undefined || rowId === null || rowId === '') return null;
  if (typeof rowId !== 'string' || rowId.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(rowId)) {
    throw new TypeError('Invalid order id.');
  }
  return rowId;
}

function assertTrustedIpcEvent(event, rendererPath) {
  const expectedUrl = pathToFileURL(rendererPath).toString();
  const actualUrl = event?.senderFrame?.url || '';
  if (actualUrl !== expectedUrl) {
    throw new Error(`Rejected IPC sender: ${actualUrl || '(unknown)'}`);
  }
}

module.exports = {
  assertTrustedIpcEvent,
  validateCancelBidPayload,
  validateRpcLimiterPayload,
  validateSettingsPayload,
};
