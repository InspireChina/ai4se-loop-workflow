import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  inspectProcessIdentity,
  processIdentityCommand,
  processIdentityMatches,
  waitForProcessIdentity,
  waitForProcessExit,
  terminateProcessTree,
  inspectProcessGroup,
  parseProcessGroupSnapshot,
  terminateProcessGroup,
  terminateProcessGroupTree,
  windowsTaskkillCommand,
} from './process-tree';

test('process-group snapshots include orphan members and preserve identity markers', () => {
  const snapshot = '100 100 Mon Sep 14 01:02:03 2026\n101 100 Mon Sep 14 01:02:04 2026\n200 200 Mon Sep 14 01:03:04 2026\n';
  assert.deepEqual(parseProcessGroupSnapshot(snapshot, 100), [
    { pid: 100, startMarker: 'Mon Sep 14 01:02:03 2026' },
    { pid: 101, startMarker: 'Mon Sep 14 01:02:04 2026' },
  ]);
});

test('combined POSIX containment terminates descendants that escape into their own process group', { skip: process.platform === 'win32', timeout: 15_000 }, async () => {
  const root = spawn(process.execPath, ['-e', `
    const child=require('node:child_process').spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
      {detached:true,stdio:'ignore'});
    console.log(child.pid);setInterval(()=>{},1000);
  `], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let escaped = 0;
  try {
    escaped = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('escaped descendant did not start')), 3_000);
      root.stdout.once('data', bytes => { clearTimeout(timer); resolve(Number(bytes.toString().trim())); });
    });
    const identity = await inspectProcessIdentity(root.pid!); assert.ok(identity);
    assert.notEqual((await inspectProcessGroup(root.pid!))?.some(member => member.pid === escaped), true,
      'fixture descendant must really escape the original PGID');
    assert.equal(await terminateProcessGroupTree(root.pid!, 7_000, identity.startMarker), true);
    assert.equal(await waitForProcessExit(root.pid!, 0), true);
    assert.equal(await waitForProcessExit(escaped, 0), true);
  } finally {
    for (const pid of [escaped, root.pid]) if (pid) try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
  }
});

test('an isolated execution group can be cleaned after its CLI root was reaped', { skip: process.platform === 'win32', timeout: 15_000 }, async () => {
  const descendantProgram = 'process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000);';
  const root = spawn(process.execPath, ['-e', `
    const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendantProgram)}], {stdio:['ignore','pipe','ignore']});
    child.stdout.once('data', () => console.log(child.pid));
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1000);
  `], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const closed = new Promise<void>((resolve) => root.once('close', () => resolve()));
  let descendantPid = 0;
  try {
    descendantPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture did not start')), 3_000);
      root.stdout.once('data', (chunk) => { clearTimeout(timer); resolve(Number(chunk.toString().trim())); });
      root.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    const identity = await inspectProcessIdentity(root.pid!);
    assert.ok(identity);
    root.kill('SIGTERM');
    await closed;
    assert.throws(() => process.kill(root.pid!, 0), { code: 'ESRCH' });
    assert.ok((await inspectProcessGroup(root.pid!))?.some((member) => member.pid === descendantPid));
    assert.equal(await terminateProcessGroup(root.pid!, 7_000, identity.startMarker), true);
    assert.deepEqual(await inspectProcessGroup(root.pid!), []);
    assert.throws(() => process.kill(descendantPid, 0), { code: 'ESRCH' });
  } finally {
    for (const pid of [root.pid, descendantPid]) {
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ } }
    }
  }
});

test('lack of permission to inspect a process is not proof of its exit', async () => {
  assert.equal(await waitForProcessExit(4321, 0, () => true), false);
  assert.equal(await waitForProcessExit(4321, 0, () => false), true);
});

test('termination escalates a surviving descendant after the root has exited', { skip: process.platform === 'win32', timeout: 15_000 }, async () => {
  const descendantProgram = 'process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000);';
  const root = spawn(process.execPath, ['-e', `
    const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendantProgram)}], {stdio:['ignore','pipe','ignore']});
    child.stdout.once('data', () => console.log(child.pid));
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'ignore'] });
  let descendantPid = 0;
  try {
    descendantPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture did not start')), 3_000);
      root.once('error', (error) => { clearTimeout(timer); reject(error); });
      root.stdout.once('data', (chunk) => { clearTimeout(timer); resolve(Number(chunk.toString().trim())); });
    });
    assert.ok(descendantPid > 0);
    assert.equal(await terminateProcessTree(root.pid!, 7_000), true);
    assert.equal(await waitForProcessExit(root.pid!, 0), true);
    assert.equal(await waitForProcessExit(descendantPid, 0), true);
  } finally {
    for (const pid of [descendantPid, root.pid]) {
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ } }
    }
  }
});

test('uses the Windows process start time as the stable process identity', () => {
  const lookup = processIdentityCommand(4321, 'win32');

  assert.equal(lookup.command, 'powershell.exe');
  assert.match(lookup.args.at(-1) || '', /Get-Process -Id 4321/);
  assert.match(lookup.args.at(-1) || '', /StartTime\.ToUniversalTime\(\)\.ToString\('o'\)/);
  assert.doesNotMatch(lookup.args.at(-1) || '', /Get-CimInstance/);
});

test('keeps Windows identity lookup asynchronous, single-flight, and concurrency bounded', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/infrastructure/process-tree.ts'), 'utf8');
  assert.doesNotMatch(source, /execFileSync|spawnSync|execSync/);
  assert.match(source, /WINDOWS_IDENTITY_CONCURRENCY = 2/);
  assert.match(source, /processIdentityInFlight = new Map/);
  assert.match(source, /withWindowsIdentitySlot/);
});

test('distinguishes reused Windows PIDs by their process start time', () => {
  const identity = { pid: 4321, startMarker: '2026-08-21T10:11:12.1234567Z' };

  assert.equal(processIdentityMatches(identity, identity.startMarker), true);
  assert.equal(processIdentityMatches(identity, '2026-08-20T03:24:41.0000000Z'), false);
  assert.equal(processIdentityMatches(identity, 'windows-pid:4321'), false);
});

test('uses the v0.1.4-compatible Windows whole-tree cleanup command', () => {
  assert.deepEqual(windowsTaskkillCommand(4321), {
    command: 'taskkill.exe',
    args: ['/PID', '4321', '/T', '/F'],
  });
});

test('retries process identity inspection while a newly spawned process is alive', async () => {
  let attempts = 0;
  const identity = await waitForProcessIdentity(4321, {
    timeoutMs: 100,
    pollIntervalMs: 1,
    isAlive: () => true,
    inspect: (pid) => {
      attempts += 1;
      return attempts === 3 ? { pid, startMarker: 'fixture-start' } : null;
    },
  });

  assert.deepEqual(identity, { pid: 4321, startMarker: 'fixture-start' });
  assert.equal(attempts, 3);
});

test('stops waiting when the spawned process has already exited', async () => {
  let attempts = 0;
  const identity = await waitForProcessIdentity(4321, {
    timeoutMs: 100,
    pollIntervalMs: 1,
    isAlive: () => false,
    inspect: () => {
      attempts += 1;
      return null;
    },
  });

  assert.equal(identity, null);
  assert.equal(attempts, 1);
});

test('reads a stable identity for the current process', async () => {
  const first = await inspectProcessIdentity(process.pid);
  const second = await inspectProcessIdentity(process.pid);

  assert.ok(first);
  assert.deepEqual(second, first);
});
