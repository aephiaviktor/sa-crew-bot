'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { dependencyInstallRequired } = require('./update-dependencies');

async function pathExists(target, fsImpl = fs) {
  try { await fsImpl.access(target); return true; } catch { return false; }
}

async function validateStagedRelease({ currentRoot, stagedRoot, fsImpl = fs }) {
  const currentLock = await fsImpl.readFile(path.join(currentRoot, 'package-lock.json'), 'utf8').catch(() => null);
  const stagedLock = await fsImpl.readFile(path.join(stagedRoot, 'package-lock.json'), 'utf8').catch(() => null);
  if (dependencyInstallRequired(currentLock, stagedLock)) {
    throw new Error('This is a dependency-changing release. Fast in-app update was cancelled; the current installation was not changed.');
  }

  const requiredFiles = [
    'package.json',
    path.join('dist', 'crew_bid_bot.js'),
    path.join('electron', 'main.js'),
    path.join('electron', 'restart-helper.js'),
    path.join('electron', 'restart-status.ps1'),
  ];
  for (const relativePath of requiredFiles) {
    if (!await pathExists(path.join(stagedRoot, relativePath), fsImpl)) {
      throw new Error(`Staged release is missing required build output: ${relativePath}`);
    }
  }
}

async function moveIfPresent(source, destination, fsImpl = fs) {
  if (!await pathExists(source, fsImpl)) return;
  await fsImpl.rm(destination, { recursive: true, force: true });
  await fsImpl.rename(source, destination);
}

async function performAtomicSwap({ appRoot, stagedRoot, rollbackRoot, fsImpl = fs }) {
  const staleRollback = `${rollbackRoot}.stale-${Date.now()}`;
  if (await pathExists(rollbackRoot, fsImpl)) await fsImpl.rename(rollbackRoot, staleRollback);

  let appMoved = false;
  try {
    await fsImpl.rename(appRoot, rollbackRoot);
    appMoved = true;
    await moveIfPresent(path.join(rollbackRoot, 'node_modules'), path.join(stagedRoot, 'node_modules'), fsImpl);
    await moveIfPresent(path.join(rollbackRoot, 'analysis'), path.join(stagedRoot, 'analysis'), fsImpl);
    await fsImpl.rename(stagedRoot, appRoot);
  } catch (error) {
    if (appMoved && !await pathExists(appRoot, fsImpl)) {
      await moveIfPresent(path.join(stagedRoot, 'node_modules'), path.join(rollbackRoot, 'node_modules'), fsImpl).catch(() => undefined);
      await moveIfPresent(path.join(stagedRoot, 'analysis'), path.join(rollbackRoot, 'analysis'), fsImpl).catch(() => undefined);
      await fsImpl.rename(rollbackRoot, appRoot).catch(() => undefined);
    }
    throw error;
  }

  if (await pathExists(staleRollback, fsImpl)) {
    void fsImpl.rm(staleRollback, { recursive: true, force: true }).catch(() => undefined);
  }
}

module.exports = { performAtomicSwap, validateStagedRelease };
