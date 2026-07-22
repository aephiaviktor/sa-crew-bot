const test = require('node:test');
const assert = require('node:assert/strict');

const { dependencyInstallRequired } = require('../electron/update-dependencies');

function lock(version = '0.2.12') {
  return JSON.stringify({
    name: 'sa-crew-bot',
    version,
    lockfileVersion: 3,
    packages: {
      '': {
        name: 'sa-crew-bot',
        version,
        dependencies: { electron: '^42.1.0' },
      },
      'node_modules/electron': {
        version: '42.4.1',
        resolved: 'https://registry.npmjs.org/electron/-/electron-42.4.1.tgz',
        integrity: 'sha512-example',
      },
    },
  });
}

test('updater skips dependency installation when only app version metadata changed', () => {
  assert.equal(dependencyInstallRequired(lock('0.2.11'), lock('0.2.12')), false);
});

test('updater installs dependencies when the normalized lockfile changed', () => {
  const changed = JSON.parse(lock());
  changed.packages['node_modules/electron'].version = '42.5.0';
  assert.equal(dependencyInstallRequired(lock('0.2.11'), JSON.stringify(changed)), true);
});

test('updater installs dependencies when either lockfile is unavailable or malformed', () => {
  assert.equal(dependencyInstallRequired(null, lock()), true);
  assert.equal(dependencyInstallRequired(lock(), '{not-json'), true);
});
