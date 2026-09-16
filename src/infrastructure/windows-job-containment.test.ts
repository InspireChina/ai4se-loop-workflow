import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  waitForWindowsJobAdmission,
  windowsJobGuardianScript,
  windowsJobPaths,
  withWindowsJobAdmission,
} from './windows-job-containment';

test('Windows descendants are gated on a per-allocation Job Object admission receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'loop-windows-job-'));
  const allocationId = 'allocation:one';
  const paths = windowsJobPaths(root, allocationId);
  const env = withWindowsJobAdmission({ NODE_ENV: 'test', SAFE: 'yes' }, root, allocationId, 'win32');
  assert.equal(env.LOOP_WINDOWS_JOB_ALLOCATION, allocationId);
  assert.equal(env.LOOP_WINDOWS_JOB_READY, paths.ready);
  const waiting = waitForWindowsJobAdmission(env, 4321, 2_000);
  await mkdir(paths.directory, { recursive: true });
  const temporary = `${paths.ready}.tmp`;
  await writeFile(temporary, JSON.stringify({ schema: 'loop-windows-job/v1', allocationId, pid: 4321,
    jobName: paths.jobName, assigned: true }));
  await rename(temporary, paths.ready);
  await waiting;
});

test('the Windows guardian assigns before admission and proves the Job is empty after termination', () => {
  const script = windowsJobGuardianScript({ dataRoot: 'C:\\LoopWork Data', allocationId: 'allocation-2', pid: 99 });
  assert.match(script, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|0x00002000/);
  assert.match(script, /AssignProcessToJobObject/);
  assert.match(script, /Write-Receipt \$readyPath/);
  assert.ok(script.indexOf('AssignProcessToJobObject') < script.indexOf('Write-Receipt $readyPath'));
  assert.match(script, /TerminateJobObject/);
  assert.match(script, /ActiveProcesses/);
  assert.match(script, /Write-Receipt \$outcomePath/);
});

test('non-Windows launches are unchanged and do not acquire a synthetic receipt', () => {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', SAFE: 'yes' };
  assert.equal(withWindowsJobAdmission(env, '/tmp/data', 'allocation', 'darwin'), env);
});

test('every production process boundary gates Windows descendants and uses durable Job exit proof', async () => {
  const roots=['native-runtime-host.ts','native-runtime-update.ts','native-runtime-ui.ts','native-admin-business-worker.ts',
    'runtime-database-compatibility.ts','native-admin-verification.ts','agent-invocation.ts'];
  for(const name of roots){
    const source=await readFile(join(process.cwd(),'src','infrastructure',name),'utf8');
    assert.match(source,/withWindowsJobAdmission|LOOP_WINDOWS_JOB_READY/);
    assert.match(source,/attachWindowsJobContainment/);
    assert.match(source,/confirmWindowsJobContainmentExit/);
  }
  for(const name of ['host-service-entry.ts','ui-server-entry.ts','admin-business-worker-entry.ts',
    'database-reader-entry.ts','verification-worker-entry.ts','windows-contained-command-entry.ts']){
    const source=await readFile(join(process.cwd(),'scripts','loop',name),'utf8');
    assert.match(source,/waitForWindowsJobAdmission/);
  }
  const build=await readFile(join(process.cwd(),'scripts','build-desktop-runtime.mjs'),'utf8');
  assert.match(build,/'windows-contained-command'/);
});
