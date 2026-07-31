const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { performAtomicSwap, validateStagedRelease } = require('../electron/atomic-update');

async function write(root, relativePath, contents) {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, 'utf8');
}

test('staged release validation requires installed dependencies when the lockfile changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-stage-validate-'));
  const current = path.join(root, 'current');
  const staged = path.join(root, 'staged');
  await write(current, 'package-lock.json', '{"same":true}');
  await write(staged, 'package-lock.json', '{"changed":true}');
  await assert.rejects(() => validateStagedRelease({ currentRoot: current, stagedRoot: staged }), /dependencies were not installed/i);

  for (const file of [
    'package.json',
    'dist/crew_bid_bot.js',
    'electron/main.js',
    'electron/restart-helper.js',
    'electron/restart-status.ps1',
    'node_modules/rpc_limiter/package.json',
  ]) await write(staged, file, 'present');

  await validateStagedRelease({ currentRoot: current, stagedRoot: staged, dependenciesInstalled: true });
  await fs.rm(root, { recursive: true, force: true });
});

test('staged release validation rejects missing build output when dependencies are unchanged', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-stage-build-'));
  const current = path.join(root, 'current');
  const staged = path.join(root, 'staged');
  await write(current, 'package-lock.json', '{"same":true}');
  await write(staged, 'package-lock.json', '{"same":true}');
  await assert.rejects(() => validateStagedRelease({ currentRoot: current, stagedRoot: staged }), /build output/i);
  await fs.rm(root, { recursive: true, force: true });
});

test('atomic swap activates staged source while preserving dependencies and analysis', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-atomic-swap-'));
  const appRoot = path.join(root, 'app');
  const stagedRoot = path.join(root, 'stage');
  const rollbackRoot = path.join(root, 'rollback');
  await write(appRoot, 'package.json', '{"version":"old"}');
  await write(appRoot, 'node_modules/marker.txt', 'dependencies');
  await write(appRoot, 'analysis/log.txt', 'history');
  await write(stagedRoot, 'package.json', '{"version":"new"}');
  await write(stagedRoot, 'dist/crew_bid_bot.js', 'built');

  await performAtomicSwap({ appRoot, stagedRoot, rollbackRoot });

  assert.equal(await fs.readFile(path.join(appRoot, 'package.json'), 'utf8'), '{"version":"new"}');
  assert.equal(await fs.readFile(path.join(appRoot, 'node_modules/marker.txt'), 'utf8'), 'dependencies');
  assert.equal(await fs.readFile(path.join(appRoot, 'analysis/log.txt'), 'utf8'), 'history');
  assert.equal(await fs.readFile(path.join(rollbackRoot, 'package.json'), 'utf8'), '{"version":"old"}');
  await fs.rm(root, { recursive: true, force: true });
});

test('atomic swap keeps newly installed staged dependencies and preserves old dependencies for rollback', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-atomic-deps-'));
  const appRoot = path.join(root, 'app');
  const stagedRoot = path.join(root, 'stage');
  const rollbackRoot = path.join(root, 'rollback');
  await write(appRoot, 'package.json', '{"version":"old"}');
  await write(appRoot, 'node_modules/marker.txt', 'old-dependencies');
  await write(stagedRoot, 'package.json', '{"version":"new"}');
  await write(stagedRoot, 'node_modules/marker.txt', 'new-dependencies');

  await performAtomicSwap({ appRoot, stagedRoot, rollbackRoot });

  assert.equal(await fs.readFile(path.join(appRoot, 'node_modules/marker.txt'), 'utf8'), 'new-dependencies');
  assert.equal(await fs.readFile(path.join(rollbackRoot, 'node_modules/marker.txt'), 'utf8'), 'old-dependencies');
  await fs.rm(root, { recursive: true, force: true });
});
