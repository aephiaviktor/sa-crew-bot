'use strict';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

function normalizePackageLock(lockText) {
  if (typeof lockText !== 'string' || !lockText.trim()) return null;
  try {
    const lock = JSON.parse(lockText);
    if (!lock || typeof lock !== 'object' || Array.isArray(lock)) return null;
    delete lock.version;
    if (lock.packages?.[''] && typeof lock.packages[''] === 'object') {
      delete lock.packages[''].version;
    }
    return JSON.stringify(canonicalize(lock));
  } catch (_error) {
    return null;
  }
}

function dependencyInstallRequired(currentLockText, nextLockText) {
  const currentLock = normalizePackageLock(currentLockText);
  const nextLock = normalizePackageLock(nextLockText);
  return !currentLock || !nextLock || currentLock !== nextLock;
}

module.exports = {
  dependencyInstallRequired,
  normalizePackageLock,
};
