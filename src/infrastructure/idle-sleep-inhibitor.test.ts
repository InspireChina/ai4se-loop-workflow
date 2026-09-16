import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createNativeIdleSleepInhibitor, idleSleepHelper } from './idle-sleep-inhibitor';

test('platform helper specifications request only idle/system sleep, never display, away mode, or persistent settings', () => {
  assert.deepEqual(idleSleepHelper('darwin', '/node', 123).args, ['-i', '-w', '123']);
  const linux = idleSleepHelper('linux', '/node', 123);
  assert.ok(linux.args.includes('--what=idle'));
  assert.ok(linux.args.includes('/node'));
  assert.match(linux.args.at(-1)!, /stdin.*end/);
  const windows = idleSleepHelper('win32');
  assert.equal(windows.command, 'powershell.exe');
  const code = Buffer.from(windows.args.at(-1)!, 'base64').toString('utf16le');
  assert.match(code, /2147483649/); assert.match(code, /2147483648/);
  assert.match(code, /ReadLineAsync/); assert.match(code, /finally/);
  assert.doesNotMatch(code, /DISPLAY_REQUIRED|AWAYMODE|powercfg/i);
  assert.throws(() => idleSleepHelper('aix'), /尚无/);
});

function processFixture(program: string) {
  let child!: ChildProcess;
  const launch: typeof spawn = ((_command: string, _args: string[], options: Parameters<typeof spawn>[2]) => {
    child = spawn(process.execPath, ['-e', program], options);
    return child;
  }) as typeof spawn;
  return { launch, child: () => child };
}

test('native helper lifecycle waits for readiness and confirms actual child exit on idempotent release', async () => {
  const h = processFixture("process.stdin.resume();console.log('LOOPWORK_IDLE_SLEEP_READY');setInterval(()=>{},1000)");
  const handle = await createNativeIdleSleepInhibitor({ platform: 'win32', spawn: h.launch })(new AbortController().signal);
  assert.equal(handle.isActive(), true);
  await handle.release(); await handle.release();
  assert.equal(handle.isActive(), false);
  assert.throws(() => process.kill(h.child().pid!, 0));
});

test('helper startup rejection retains bounded stderr and kills the real fixture process before returning failure', async () => {
  const h = processFixture("console.error('native permission denied');process.exit(1)");
  await assert.rejects(createNativeIdleSleepInhibitor({ platform: 'linux', spawn: h.launch })(new AbortController().signal), /native permission denied/);
  assert.throws(() => process.kill(h.child().pid!, 0));
});

test('helper startup timeout and cancellation do not leave a live native fixture process', async () => {
  for (const cancel of [false, true]) {
    const h = processFixture('process.stdin.resume();setInterval(()=>{},1000)');
    const controller = new AbortController();
    const started = createNativeIdleSleepInhibitor({ platform: 'win32', spawn: h.launch, readinessTimeoutMs: 80 })(controller.signal);
    if (cancel) controller.abort();
    await assert.rejects(started, cancel ? /取消/ : /超时/);
    assert.throws(() => process.kill(h.child().pid!, 0));
  }
});

test('actual local macOS idle assertion appears in pmset and disappears after helper release', async () => {
  if (process.platform !== 'darwin') return;
  let child!: ChildProcess;
  const launch: typeof spawn = ((command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
    child = spawn(command, args, options); return child;
  }) as typeof spawn;
  const handle = await createNativeIdleSleepInhibitor({ spawn: launch })(new AbortController().signal);
  try {
    const assertions = execFileSync('/usr/bin/pmset', ['-g', 'assertions'], { encoding: 'utf8', timeout: 5_000 });
    assert.match(assertions, new RegExp(`pid ${child.pid}\\(caffeinate\\)`));
    assert.match(assertions, /PreventUserIdleSystemSleep/);
  } finally { await handle.release(); }
  assert.throws(() => process.kill(child.pid!, 0));
  const after = execFileSync('/usr/bin/pmset', ['-g', 'assertions'], { encoding: 'utf8', timeout: 5_000 });
  assert.doesNotMatch(after, new RegExp(`pid ${child.pid}\\(caffeinate\\)`));
});

test('actual macOS assertion is released after its owning Node host is forcibly terminated', async () => {
  if (process.platform !== 'darwin') return;
  const program = `
    import { spawn } from 'node:child_process';
    import { createNativeIdleSleepInhibitor } from './src/infrastructure/idle-sleep-inhibitor.ts';
    let helper;
    await createNativeIdleSleepInhibitor({spawn:(command,args,options)=>{helper=spawn(command,args,options);return helper;}})(new AbortController().signal);
    console.log(JSON.stringify({helperPid:helper.pid}));
  `;
  const host = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<void>(resolve => host.once('close', () => resolve()));
  let diagnostic = ''; host.stderr.on('data', chunk => { diagnostic += chunk.toString(); });
  try {
    const helperPid = await new Promise<number>((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error(`Power host not ready: ${diagnostic}`)), 5_000);
      host.stdout.on('data', chunk => {
        output += chunk.toString();
        if (output.includes('\n')) { clearTimeout(timeout); resolve(JSON.parse(output.split('\n')[0]!).helperPid); }
      });
      host.once('close', () => { clearTimeout(timeout); reject(new Error(`Power host exited before readiness: ${diagnostic}`)); });
    });
    process.kill(helperPid, 0);
    host.kill('SIGKILL'); await exited;
    let alive = true; const deadline = Date.now() + 5_000;
    while (alive && Date.now() < deadline) {
      try { process.kill(helperPid, 0); await delay(25); } catch { alive = false; }
    }
    assert.equal(alive, false, 'caffeinate -w must release after host death');
    const after = execFileSync('/usr/bin/pmset', ['-g', 'assertions'], { encoding: 'utf8', timeout: 5_000 });
    assert.doesNotMatch(after, new RegExp(`pid ${helperPid}\\(caffeinate\\)`));
  } finally { if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL'); await exited; }
});
