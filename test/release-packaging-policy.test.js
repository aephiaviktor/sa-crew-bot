const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

test('SA Crew Bot uses packaged GitHub Release updates rather than main-branch source archives', () => {
  const mainSource = fs.readFileSync(path.join(root, 'electron/main.js'), 'utf8');
  assert.match(mainSource, /require\('electron-updater'\)/);
  assert.match(mainSource, /releases\/latest/);
  assert.match(mainSource, /autoUpdater\.checkForUpdates\(\)/);
  assert.match(mainSource, /autoUpdater\.downloadUpdate\(\)/);
  assert.match(mainSource, /autoUpdater\.quitAndInstall\(true, true\)/);
  assert.doesNotMatch(mainSource, /raw\.githubusercontent\.com/);
  assert.doesNotMatch(mainSource, /archive\/refs\/heads\/main\.tar\.gz/);
});

test('Windows package is one-click and publishes complete updater metadata', () => {
  const packageJson = require('../package.json');
  assert.equal(packageJson.build.appId, 'com.aephia.sa-crew-bot');
  assert.equal(packageJson.build.productName, 'SA Crew Bot');
  assert.equal(packageJson.build.nsis.oneClick, true);
  assert.equal(packageJson.build.nsis.allowToChangeInstallationDirectory, false);
  assert.ok(packageJson.dependencies['electron-updater']);
  assert.equal(packageJson.dependencies.electron, undefined);
  assert.ok(packageJson.devDependencies.electron);
  assert.ok(packageJson.devDependencies['electron-builder']);
  for (const legacyFile of ['atomic-update.js', 'update-dependencies.js', 'restart-helper.js', 'restart-status.ps1']) {
    assert.ok(packageJson.build.files.includes(`!electron/${legacyFile}`), `${legacyFile} must not ship in the packaged app`);
  }

  const workflow = fs.readFileSync(path.join(root, '.github/workflows/windows-release.yml'), 'utf8');
  assert.match(workflow, /push:\s*\n\s*tags:/);
  assert.match(workflow, /npm run dist:win/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /gh release upload/);
  assert.match(workflow, /SA-Crew-Bot-Setup-\$version\.exe/);
  assert.match(workflow, /latest\.yml/);
});

test('release updater refuses source-mode installation and preserves the canonical user-data directory', () => {
  const mainSource = fs.readFileSync(path.join(root, 'electron/main.js'), 'utf8');
  assert.match(mainSource, /if \(!app\.isPackaged\)/);
  assert.match(mainSource, /Release updates are available only in the packaged application/);
  assert.match(mainSource, /app\.setPath\('userData', path\.join\(app\.getPath\('appData'\), 'sa-crew-bot'\)\)/);
});
