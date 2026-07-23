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

test('staged release validation rejects dependency changes and missing build output', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-stage-validate-'));
  const current = path.join(root, 'current');
  const staged = path.join(root, 'staged');
  await write(current, 'package-lock.json', '{"same":true}');
  await write(staged, 'package-lock.json', '{"changed":true}');
  await assert.rejects(() => validateStagedRelease({ currentRoot: current, stagedRoot: staged }), /dependency-changing/i);

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
