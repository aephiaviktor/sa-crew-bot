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
  assert.deepEqual(validateRpcLimiterPayload({ rpcUrl: 'https://rpc.invalid', rpcRequestsPerSecond: '10', providerRole: 'fallback' }), {
    rpcUrl: 'https://rpc.invalid',
    rpcRequestsPerSecond: '10',
    providerRole: 'fallback',
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

test('sensitive settings use OS-protected storage and are redacted from renderer IPC', async () => {
  const mainSource = await fs.readFile(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  const rendererSource = await fs.readFile(path.join(__dirname, '..', 'electron', 'renderer.js'), 'utf8');
  assert.match(mainSource, /safeStorage\.isAsyncEncryptionAvailable\(\)/);
  assert.match(mainSource, /safeStorage\.isEncryptionAvailable\(\)/);
  assert.match(mainSource, /safeStorage\.encryptStringAsync/);
  assert.match(mainSource, /safeStorage\.decryptStringAsync/);
  assert.match(mainSource, /safeStorage\.encryptString\(value\)/);
  assert.match(mainSource, /safeStorage\.decryptString\(value\)/);
  assert.match(mainSource, /SECRET_SETTING_KEYS = \['AEPHIA_API_KEY', 'HOT_WALLET_SECRET', 'RPC_URL'\]/);
  assert.doesNotMatch(mainSource, /\[stored in RPC Limiter\]/);
  assert.match(mainSource, /providers:\s*\{/);
  assert.match(mainSource, /main:\s*\{/);
  assert.match(mainSource, /fallback:\s*\{/);
  assert.match(rendererSource, /secureFieldNames = new Set\(\['AEPHIA_API_KEY', 'HOT_WALLET_SECRET', 'RPC_URL'\]\)/);
  assert.match(rendererSource, /if \(button\.dataset\.tab === 'setup'\) setSensitiveVisible\(false\)/);
});

test('only the current RPC limiter URLs use the revealable blur control', async () => {
  const html = await fs.readFile(path.join(__dirname, '..', 'electron', 'renderer.html'), 'utf8');
  assert.match(html, /class="sensitive-field" id="rpc-limiter-main-url"/);
  assert.match(html, /class="sensitive-field" id="rpc-limiter-fallback-url"/);
  assert.doesNotMatch(html, /class="sensitive-field" name="AEPHIA_API_KEY"/);
  assert.doesNotMatch(html, /class="sensitive-field" name="HOT_WALLET_SECRET"/);
  assert.doesNotMatch(html, /class="sensitive-field" name="RPC_URL"/);
});

test('RPC limiter send preserves blank URL intent and serializes its provider role', async () => {
  const main = await fs.readFile(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  const renderer = await fs.readFile(path.join(__dirname, '..', 'electron', 'renderer.js'), 'utf8');

  assert.doesNotMatch(main, /config\.RPC_URL\s*=\s*\(await loadSettings\(true\)\)\.RPC_URL/);
  assert.match(renderer, /providerRole:.*checked \? 'fallback' : 'main'/);
  assert.match(renderer, /RPC Limiter \$\{roleLabel\} slot \$\{actionLabel\}/);
});
