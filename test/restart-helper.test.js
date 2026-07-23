const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { getScheduledTaskState, launchAfterTaskReady, parseRestartArguments } = require('../electron/restart-helper');

test('restart helper accepts the supervisor-aware argument contract', () => {
  const parsed = parseRestartArguments([
    'electron.exe', 'restart-helper.js', '123', 'SA Crew Bot', 'SA Crew Bot', '0.2.12',
    'C:\\Apps\\sa-crew-bid-bot', 'C:\\Apps\\sa-crew-bid-bot\\electron\\restart-status.ps1',
    'C:\\logs\\supervisor.log', 'C:\\Apps\\.sa-stage', 'C:\\Apps\\.sa-rollback', '2000000000000',
  ]);

  assert.deepEqual(parsed, {
    parentPid: 123,
    taskName: 'SA Crew Bot',
    appName: 'SA Crew Bot',
    expectedVersion: '0.2.12',
    appRoot: 'C:\\Apps\\sa-crew-bid-bot',
    verifierPath: 'C:\\Apps\\sa-crew-bid-bot\\electron\\restart-status.ps1',
    logPath: 'C:\\logs\\supervisor.log',
    stagedRoot: 'C:\\Apps\\.sa-stage',
    rollbackRoot: 'C:\\Apps\\.sa-rollback',
    deadlineEpochMs: 2000000000000,
  });
});

test('restart helper reads the named Windows task state', async () => {
  const state = await getScheduledTaskState('SA Crew Bot', (command, args, options) => {
    assert.equal(command, 'powershell.exe');
    assert.match(args.at(-1), /SA_CREW_RESTART_TASK/);
    assert.equal(options.env.SA_CREW_RESTART_TASK, 'SA Crew Bot');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('3\r\n'));
      child.emit('close', 0);
    });
    return child;
  });

  assert.equal(state, 3);
});

test('restart helper waits for Ready, starts the task, then launches the verifier', async () => {
  const states = [4, 4, 3];
  const events = [];
  const launched = await launchAfterTaskReady({
    taskName: 'SA Crew Bot',
    taskPollIntervalMs: 0,
    taskReadyWaitMs: 100,
    getScheduledTaskState: async () => {
      const state = states.shift();
      events.push(`state:${state}`);
      return state;
    },
    runScheduledTask: async () => { events.push('run'); return true; },
    performAtomicSwap: async () => { events.push('swap'); },
    launchVerifier: () => { events.push('verify'); },
  });

  assert.equal(launched, true);
  assert.deepEqual(events, ['state:4', 'state:4', 'state:3', 'swap', 'run', 'verify']);
});

test('restart helper launches failure verification if Ready never arrives', async () => {
  let verifierStarted = false;
  const launched = await launchAfterTaskReady({
    taskName: 'SA Crew Bot',
    taskReadyWaitMs: 0,
    getScheduledTaskState: async () => 4,
    runScheduledTask: async () => { throw new Error('task must not start'); },
    performAtomicSwap: async () => { throw new Error('swap must not run'); },
    launchVerifier: () => { verifierStarted = true; },
  });

  assert.equal(launched, false);
  assert.equal(verifierStarted, true);
});

test('restart helper launches failure verification if the task cannot start', async () => {
  let verifierStarted = false;
  const launched = await launchAfterTaskReady({
    taskName: 'SA Crew Bot',
    getScheduledTaskState: async () => 3,
    runScheduledTask: async () => false,
    performAtomicSwap: async () => undefined,
    launchVerifier: () => { verifierStarted = true; },
  });

  assert.equal(launched, false);
  assert.equal(verifierStarted, true);
});

test('restart helper restarts the unchanged app without rollback when atomic swap fails', async () => {
  const events = [];
  const launched = await launchAfterTaskReady({
    taskName: 'SA Crew Bot',
    rollbackRoot: 'C:\\Apps\\rollback',
    getScheduledTaskState: async () => 3,
    performAtomicSwap: async () => { throw new Error('swap failed'); },
    runScheduledTask: async () => { events.push('run-old'); return true; },
    launchVerifier: (options) => { events.push(options.rollbackRoot); },
  });

  assert.equal(launched, false);
  assert.deepEqual(events, ['run-old', 'C:\\Apps\\rollback.unavailable']);
});
