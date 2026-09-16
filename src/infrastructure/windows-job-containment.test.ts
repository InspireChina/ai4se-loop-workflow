import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  waitForWindowsJobAdmission,
  attachWindowsJobContainment,
  confirmWindowsJobContainmentExit,
  isProcessInWindowsJob,
  processPredatesWindowsBoot,
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
  assert.match(script, /LastBootUpTime|bootMarker/);
  assert.match(script, /WaitForSingleObject\(\$process, 4294967295\)/);
  assert.doesNotMatch(script, /WaitForSingleObject\(\$process, 0xffffffff\)/i);
});

test('the packaged Windows runtime can execute its guardian and complete a real Job lifecycle',
  {skip:process.platform!=='win32',timeout:30_000},async()=>{
    const root=await mkdtemp(join(tmpdir(),'loop-windows-real-job-'));
    const allocationId=`real-job-${process.pid}-${Date.now()}`;
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{
      windowsHide:true,stdio:'ignore',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},
    });
    const closed=once(child,'close');
    try{
      await Promise.race([
        once(child,'spawn'),
        once(child,'error').then(([error])=>Promise.reject(error)),
      ]);
      assert.ok(child.pid);
      assert.equal(await attachWindowsJobContainment({dataRoot:root,allocationId,pid:child.pid,timeoutMs:15_000}),true);
      assert.equal(await isProcessInWindowsJob({dataRoot:root,allocationId,pid:child.pid,timeoutMs:5_000}),true);
      assert.equal(child.kill(),true);
      await closed;
      assert.equal(await confirmWindowsJobContainmentExit({dataRoot:root,
        process:{allocationId,pid:child.pid,marker:null},timeoutMs:15_000}),true);
      const outcome=JSON.parse(await readFile(windowsJobPaths(root,allocationId).outcome,'utf8').then(value=>value.replace(/^\uFEFF/,'')));
      assert.equal(outcome.assigned,true);
      assert.equal(outcome.activeProcesses,0);
    }finally{
      if(child.exitCode===null&&child.signalCode===null){child.kill();await Promise.race([closed,new Promise(resolve=>setTimeout(resolve,5_000))]);}
    }
  });

test('a reboot is positive exit proof for a prior Windows Job even without its final guardian outcome',async()=>{
  const root=await mkdtemp(join(tmpdir(),'loop-windows-reboot-'));
  const allocationId='prior-boot-job',pid=4321,paths=windowsJobPaths(root,allocationId);
  await mkdir(paths.directory,{recursive:true});
  await writeFile(paths.ready,JSON.stringify({schema:'loop-windows-job/v1',allocationId,pid,jobName:paths.jobName,
    assigned:true,bootMarker:'2026-09-15T01:00:00.0000000Z'}));
  assert.equal(processPredatesWindowsBoot('2026-09-15T02:00:00.1234567Z','2026-09-16T03:00:00.0000000Z'),true);
  assert.equal(await confirmWindowsJobContainmentExit({dataRoot:root,process:{allocationId,pid,
      marker:'2026-09-15T02:00:00.1234567Z'},platform:'win32',inspectBootMarker:async()=> '2026-09-16T03:00:00.0000000Z'}),true);
});

test('a prior-boot admission recovers an allocation that crashed before SQLite PID binding',async()=>{
  const root=await mkdtemp(join(tmpdir(),'loop-windows-unbound-reboot-'));
  const allocationId='unbound-prior-boot-job',pid=9876,paths=windowsJobPaths(root,allocationId);
  await mkdir(paths.directory,{recursive:true});
  await writeFile(paths.ready,JSON.stringify({schema:'loop-windows-job/v1',allocationId,pid,jobName:paths.jobName,
    assigned:true,bootMarker:'2026-09-15T01:00:00.0000000Z'}));
  assert.equal(await confirmWindowsJobContainmentExit({dataRoot:root,process:{allocationId,pid:null,marker:null},
    platform:'win32',inspectBootMarker:async()=> '2026-09-16T03:00:00.0000000Z'}),true);
});

test('a missing legacy named Job recovers a pre-boot admission without PID or boot marker',async()=>{
  const root=await mkdtemp(join(tmpdir(),'loop-windows-legacy-unbound-'));
  const allocationId='legacy-unbound-job',pid=9875,paths=windowsJobPaths(root,allocationId);
  await mkdir(paths.directory,{recursive:true});
  await writeFile(paths.ready,JSON.stringify({schema:'loop-windows-job/v1',allocationId,pid,jobName:paths.jobName,assigned:true}));
  assert.equal(await confirmWindowsJobContainmentExit({dataRoot:root,process:{allocationId,pid:null,marker:null},
    platform:'win32',inspectBootMarker:async()=> '2026-09-16T03:00:00.0000000Z',inspectJobState:async()=>({exists:false,activeProcesses:0})}),true);
});

test('nearby same-boot estimates do not release an unbound Windows allocation',async()=>{
  const root=await mkdtemp(join(tmpdir(),'loop-windows-same-boot-'));
  const allocationId='same-boot-unbound-job',pid=9877,paths=windowsJobPaths(root,allocationId);
  await mkdir(paths.directory,{recursive:true});
  await writeFile(paths.ready,JSON.stringify({schema:'loop-windows-job/v1',allocationId,pid,jobName:paths.jobName,
    assigned:true,bootMarker:'2026-09-16T03:00:00.0000000Z'}));
  assert.equal(await confirmWindowsJobContainmentExit({dataRoot:root,process:{allocationId,pid:null,marker:null},timeoutMs:1,
    platform:'win32',inspectBootMarker:async()=> '2026-09-16T03:00:00.0100000Z',
    inspectJobState:async()=>({exists:true,activeProcesses:1})}),false);
});

test('same-boot PID replacement is not enough to waive a Windows descendant barrier',()=>{
  assert.equal(processPredatesWindowsBoot('2026-09-16T04:00:00.0000000Z','2026-09-16T03:00:00.0000000Z'),false);
  assert.equal(processPredatesWindowsBoot('malformed','2026-09-16T03:00:00.0000000Z'),false);
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
