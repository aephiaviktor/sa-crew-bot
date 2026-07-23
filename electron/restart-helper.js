const { spawn } = require('child_process');
const { performAtomicSwap } = require('./atomic-update');

function parseRestartArguments(argv, now = Date.now) {
  const args = argv.slice(2);
  const parentPid = Number.parseInt(args[0], 10);
  const [, taskName, appName, expectedVersion, appRoot, verifierPath, logPath, stagedRoot, rollbackRoot, deadlineText] = args;
  if (!Number.isInteger(parentPid) || args.length < 7) return null;
  if (!taskName || !appName || !expectedVersion || !appRoot || !verifierPath || !logPath) return null;

  if (args.length === 7) {
    const pathModule = require('node:path');
    const pathApi = /^[A-Za-z]:[\\/]/.test(appRoot) ? pathModule.win32 : pathModule;
    const parentDir = pathApi.dirname(appRoot);
    return {
      parentPid,
      taskName,
      appName,
      expectedVersion,
      appRoot,
      verifierPath,
      logPath,
      stagedRoot: null,
      rollbackRoot: pathApi.join(parentDir, '.sa-crew-bid-bot-rollback.unavailable'),
      deadlineEpochMs: now() + 30_000,
      legacyUpdate: true,
    };
  }

  const deadlineEpochMs = Number.parseInt(deadlineText, 10);
  if (args.length < 10 || !Number.isFinite(deadlineEpochMs) || !stagedRoot || !rollbackRoot) return null;
  return { parentPid, taskName, appName, expectedVersion, appRoot, verifierPath, logPath, stagedRoot, rollbackRoot, deadlineEpochMs, legacyUpdate: false };
}

function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
  });
}

async function getScheduledTaskState(taskName, spawnProcess = spawn) {
  const child = spawnProcess(
    'powershell.exe',
    ['-NoProfile', '-Command', '[int](Get-ScheduledTask -TaskName $env:SA_CREW_RESTART_TASK).State'],
    {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, SA_CREW_RESTART_TASK: taskName },
    },
  );
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  const succeeded = await waitForExit(child);
  return succeeded ? Number.parseInt(output.trim(), 10) : null;
}

async function runScheduledTask(taskName, spawnProcess = spawn) {
  const child = spawnProcess('schtasks.exe', ['/Run', '/TN', taskName], {
    windowsHide: true,
    stdio: 'ignore',
  });
  return waitForExit(child);
}

function launchVerifier(options, spawnProcess = spawn) {
  const child = spawnProcess(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', options.verifierPath,
      '-AppName', options.appName,
      '-ExpectedVersion', options.expectedVersion,
      '-AppRoot', options.appRoot,
      '-TaskName', options.taskName,
      '-LogPath', options.logPath,
      '-RollbackRoot', options.rollbackRoot,
      '-DeadlineEpochMs', String(options.deadlineEpochMs),
    ],
    {
      cwd: require('node:path').dirname(options.appRoot),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  child.unref();
}

async function launchAfterTaskReady(options) {
  const {
    taskName,
    taskPollIntervalMs = 250,
    taskReadyWaitMs = 300_000,
    deadlineEpochMs = Number.POSITIVE_INFINITY,
    legacyUpdate = false,
    getScheduledTaskState: readTaskState = getScheduledTaskState,
    runScheduledTask: startTask = runScheduledTask,
    launchVerifier: startVerifier = launchVerifier,
    performAtomicSwap: swapRelease = performAtomicSwap,
  } = options;

  const taskDeadline = Date.now() + taskReadyWaitMs;
  while (await readTaskState(taskName) !== 3) {
    if (Date.now() >= Math.min(taskDeadline, deadlineEpochMs)) {
      startVerifier(options);
      return false;
    }
    await sleep(taskPollIntervalMs);
  }

  if (!legacyUpdate) {
    try {
      await swapRelease(options);
    } catch {
      await startTask(taskName).catch(() => false);
      startVerifier({ ...options, rollbackRoot: `${options.rollbackRoot}.unavailable` });
      return false;
    }
  }

  if (!await startTask(taskName)) {
    startVerifier(options);
    return false;
  }
  startVerifier(options);
  return true;
}

async function main() {
  const restartOptions = parseRestartArguments(process.argv);
  if (!restartOptions) {
    process.exitCode = 2;
    return;
  }
  const launched = await launchAfterTaskReady(restartOptions);
  process.exitCode = launched ? 0 : 3;
}

if (require.main === module) {
  void main().catch(() => { process.exitCode = 1; });
}

module.exports = {
  getScheduledTaskState,
  launchAfterTaskReady,
  launchVerifier,
  parseRestartArguments,
  runScheduledTask,
};
