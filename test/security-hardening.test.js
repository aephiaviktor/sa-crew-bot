const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { atomicWriteFile } = require('../electron/lib/atomic-write');
const {
  assertTrustedIpcEvent,
  validateCancelBidPayload,
  validateRpcLimiterPayload,
  validateSettingsPayload,
} = require('../electron/lib/ipc-security');

function eventFor(url) {
  return { senderFrame: { url } };
}

test('atomic settings writes replace the target and leave no temporary file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-crew-settings-test-'));
  const target = path.join(dir, 'crew-bid-settings.json');
  await fs.writeFile(target, '{"old":true}', 'utf8');

  await atomicWriteFile(target, '{"new":true}', 'utf8');

  assert.equal(await fs.readFile(target, 'utf8'), '{"new":true}');
  assert.deepEqual(await fs.readdir(dir), ['crew-bid-settings.json']);
  await fs.rm(dir, { recursive: true, force: true });
});

test('IPC accepts only the main local renderer document', () => {
  const rendererPath = path.join(os.tmpdir(), 'renderer.html');
  const rendererUrl = pathToFileURL(rendererPath).toString();

  assert.doesNotThrow(() => assertTrustedIpcEvent(eventFor(rendererUrl), rendererPath));
  assert.throws(
    () => assertTrustedIpcEvent(eventFor('https://attacker.invalid/'), rendererPath),
    /Rejected IPC sender/,
  );
});

test('settings IPC rejects unknown keys and non-primitive values', () => {
  assert.deepEqual(validateSettingsPayload({ BID_STEP_SOL: '0.01', USE_RPC_LIMITER: true }), {
    BID_STEP_SOL: '0.01',
    USE_RPC_LIMITER: true,
  });
  assert.throws(() => validateSettingsPayload({ injected: '<img onerror=alert(1)>' }), /Unknown settings field/);
  assert.throws(() => validateSettingsPayload({ BID_STEP_SOL: { nested: true } }), /Invalid value/);
});

test('RPC limiter and cancel-bid IPC payloads are bounded', () => {
  assert.deepEqual(validateRpcLimiterPayload({ RPC_URL: 'https://rpc.invalid', RPC_REQUESTS_PER_SECOND: '10' }), {
    RPC_URL: 'https://rpc.invalid',
    RPC_REQUESTS_PER_SECOND: '10',
  });
  assert.throws(() => validateRpcLimiterPayload({ HOT_WALLET_SECRET: 'nope' }), /Unknown RPC limiter field/i);
  assert.equal(validateCancelBidPayload('order-1'), 'order-1');
  assert.throws(() => validateCancelBidPayload('x'.repeat(257)), /Invalid order id/);
});

test('renderer CSP is restrictive and remote status values are not interpolated into innerHTML', async () => {
  const html = await fs.readFile(path.join(__dirname, '..', 'electron', 'renderer.html'), 'utf8');
  const renderer = await fs.readFile(path.join(__dirname, '..', 'electron', 'renderer.js'), 'utf8');

  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /script-src 'self'/);
  assert.match(html, /object-src 'none'/);
  assert.doesNotMatch(renderer, /item\.innerHTML\s*=/);
  assert.doesNotMatch(renderer, /openOrdersListEl\.innerHTML\s*=/);
  assert.doesNotMatch(renderer, /recentActivityListEl\.innerHTML\s*=/);
});
