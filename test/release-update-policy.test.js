const assert = require('node:assert/strict');
const test = require('node:test');
const { determineReleaseAction, normalizeAppVersion } = require('../electron/release-update-policy');

test('release policy updates only from newer published semantic versions', () => {
  assert.deepEqual(determineReleaseAction('0.2.27', 'v0.2.28'), {
    action: 'update', currentVersion: '0.2.27', latestVersion: '0.2.28',
  });
  assert.deepEqual(determineReleaseAction('0.2.28', 'v0.2.28'), {
    action: 'none', currentVersion: '0.2.28', latestVersion: '0.2.28',
  });
});

test('release policy can restore a development build newer than the official release', () => {
  assert.equal(determineReleaseAction('0.2.29', '0.2.28').action, 'restore');
});

test('release policy rejects malformed release tags', () => {
  assert.throws(() => normalizeAppVersion('main'), /Invalid application version/);
});
