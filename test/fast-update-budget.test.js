const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

test('staged compiler receives most of the 30-second budget and bypasses the Windows shell', async () => {
  const main = await fs.readFile(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert.match(main, /UPDATE_TOTAL_BUDGET_MS = 30_000/);
  assert.match(main, /UPDATE_RESTART_RESERVE_MS = 4_000/);
  assert.match(main, /timeoutMs: requireRemainingTime\(\),\s*shell: false,/);
});

test('release archive carries incremental build output for legacy-updater bootstrap', async () => {
  const tsconfig = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'tsconfig.json'), 'utf8'));
  assert.equal(tsconfig.compilerOptions.incremental, true);
  assert.equal(tsconfig.compilerOptions.tsBuildInfoFile, 'dist/.tsbuildinfo');
  for (const file of ['crew_bid_bot.js', 'tensor_market.js', '.tsbuildinfo']) {
    await fs.access(path.join(__dirname, '..', 'dist', file));
  }
});

test('apply failures remain update failures rather than being mislabeled as update-check failures', async () => {
  const renderer = await fs.readFile(path.join(__dirname, '..', 'electron', 'renderer.js'), 'utf8');
  assert.match(renderer, /Update failed safely:/);
  assert.match(renderer, /Current version remains installed/);
});
