const { spawn } = require('child_process');

function parseRestartArguments(argv) {
  const args = argv.slice(2);
  const parentPid = Number.parseInt(args[0], 10);
  const [, taskName, appName, expectedVersion, appRoot, verifierPath, logPath] = args;
  if (!Number.isInteger(parentPid) || args.length < 7) return null;
  if (!taskName || !appName || !expectedVersion || !appRoot || !verifierPath || !logPath) return null;
  return { parentPid, taskName, appName, expectedVersion, appRoot, verifierPath, logPath };
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
    ],
    {
      cwd: options.appRoot,
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
    getScheduledTaskState: readTaskState = getScheduledTaskState,
    runScheduledTask: startTask = runScheduledTask,
    launchVerifier: startVerifier = launchVerifier,
  } = options;

  const taskDeadline = Date.now() + taskReadyWaitMs;
  while (await readTaskState(taskName) !== 3) {
    if (Date.now() >= taskDeadline) {
      startVerifier(options);
      return false;
    }
    await sleep(taskPollIntervalMs);
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
  if (!restartOptions) process.exit(2);
  const launched = await launchAfterTaskReady(restartOptions);
  process.exit(launched ? 0 : 3);
}

if (require.main === module) {
  void main().catch(() => process.exit(1));
}

module.exports = {
  getScheduledTaskState,
  launchAfterTaskReady,
  launchVerifier,
  parseRestartArguments,
  runScheduledTask,
};
