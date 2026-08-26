const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

test('packaged updater installs official release artifacts without compiling on the target machine', async () => {
  const main = await fs.readFile(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert.match(main, /autoUpdater\.downloadUpdate\(\)/);
  assert.match(main, /autoUpdater\.quitAndInstall\(true, true\)/);
  assert.doesNotMatch(main, /typescript['"], ['"]bin['"], ['"]tsc/);
  assert.doesNotMatch(main, /npm\.cmd|main\.tar\.gz|stagedNodeModules/);
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
