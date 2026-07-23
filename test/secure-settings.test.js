const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createSecureSettingsStore } = require('../electron/lib/secure-settings');
const { atomicWriteFile } = require('../electron/lib/atomic-write');

test('secure settings persist only encrypted base64 and decrypt on read', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-secure-settings-'));
  const filePath = path.join(dir, 'secrets.json');
  const store = createSecureSettingsStore({
    filePath,
    encryptString: async (value) => Buffer.from(`encrypted:${value}`),
    decryptString: async (value) => ({ result: value.toString().replace(/^encrypted:/, ''), shouldReEncrypt: false }),
    atomicWriteFile,
  });

  await store.update({ HOT_WALLET_SECRET: '[1,2,3]', RPC_URL: 'https://rpc.invalid/?api-key=secret' });
  const raw = await fs.readFile(filePath, 'utf8');
  assert.doesNotMatch(raw, /\[1,2,3\]|api-key=secret/);
  assert.deepEqual(await store.read(), {
    HOT_WALLET_SECRET: '[1,2,3]',
    RPC_URL: 'https://rpc.invalid/?api-key=secret',
  });
  await fs.rm(dir, { recursive: true, force: true });
});

test('blank secure-setting updates preserve the existing encrypted value', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-secure-settings-'));
  const filePath = path.join(dir, 'secrets.json');
  const store = createSecureSettingsStore({
    filePath,
    encryptString: async (value) => Buffer.from(value),
    decryptString: async (value) => ({ result: value.toString(), shouldReEncrypt: false }),
    atomicWriteFile,
  });
  await store.update({ AEPHIA_API_KEY: 'kept' });
  await store.update({ AEPHIA_API_KEY: '' });
  assert.equal((await store.read()).AEPHIA_API_KEY, 'kept');
  await fs.rm(dir, { recursive: true, force: true });
});
