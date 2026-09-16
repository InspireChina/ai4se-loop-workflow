import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createAdminController } from '../application/admin-controller';
import { buildAdminPrompt } from '../application/admin-prompt';
import { AdminManagementStore } from './admin-management-store';
import { adminBusinessEnvironmentBoundary, adminCommandLaunch, adminCommandReference, confirmAdminAttemptStopped, createAdminExecutionLauncher } from './admin-execution';
import type { AgentExecutor } from './agent-executor';
import { createLangfuseTelemetry } from './langfuse';

async function stalledActivityFixture(repeatedTools: boolean) {
  const root = join(process.env.LOOP_DATA_ROOT!, randomUUID());
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'probe.txt'), 'unchanged actual diagnostic input');
  const store = new AdminManagementStore(join(root, 'management.db'));
  store.setIntent('running', randomUUID());
  const repair = store.observe({ observationId: randomUUID(), scope: 'runtime', scopeKey: 'activity-fixture', fingerprint: 'no-advancement',
    sourceVersion: 'v1', origin: 'runtime', summary: 'Original acceptance has not recovered', evidence: {} });
  const program = `
    const {readFileSync}=require('node:fs');let count=0;
    console.log('CLI started');
    setInterval(()=>{
      count++;
      if(${JSON.stringify(repeatedTools)}) {
        const id='call-'+count;
        console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id,name:'Read',input:{file_path:'probe.txt'}}]}}));
        readFileSync('probe.txt','utf8');
        console.log(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,is_error:false,content:'A changing log line '+count}]}}));
      } else console.log('Still working: '+count);
    },25);
  `;
  const controller = createAdminController({ store, ownerId: 'activity-host', confirmStopped: confirmAdminAttemptStopped,
    launch: createAdminExecutionLauncher({ store, appRoot: process.cwd(), dataRoot: root, workspaceRoot: workspace,
      executor: { id: 'claude', label: 'Real stalled Node CLI', command: process.execPath, promptMode: 'argument',
        buildArgs: () => ['-e', program], formatCommand: () => 'node actual-stalled-cli', parseStdout: line => line, parseStderr: line => line },
      executionOptions: {}, limits: { maxRuntimeMs: 4000, startupTimeoutMs: 2000, idleTimeoutMs: 3000 },
      activityTimeoutMs: 250, activityPollIntervalMs: 10,
      telemetry: createLangfuseTelemetry({ env: { LANGFUSE_ENABLED: 'false' } }),
    }) });
  try {
    await controller.reconcile();
    await controller.waitForSettlements();
    const attempt = store.attempts(repair.caseId)[0];
    assert.equal(attempt.status, 'failed');
    assert.equal(store.getCase(repair.caseId)?.status, 'queued');
    assert.match(store.getCase(repair.caseId)?.lastError || '', /investigation stalled/, 'activity timer, not 4-second max or idle output timer, stopped the real CLI');
    assert.ok(attempt.pid);
    assert.throws(() => process.kill(attempt.pid!, 0));
    const log = readFileSync(join(root, 'admin', 'logs', `${attempt.attemptId}.log`), 'utf8');
    assert.ok(log.includes(repeatedTools ? 'changing log line' : 'Still working'));
    assert.equal(store.observations(repair.caseId).length, 1, 'no recursive Admin Case');
    // Let the owning Controller launch and settle the continuation. A bare
    // claimNext creates a durable unknown allocation, not proof of no spawn;
    // shutdown must retain supervision for such an allocation.
    assert.equal(await controller.reconcile(), 'launched');
    await controller.waitForSettlements();
    const resumed = store.attempts(repair.caseId)[1];
    assert.deepEqual(store.recoveryDecision(resumed.attemptId)?.failedAttemptIds, [attempt.attemptId]);
    assert.equal(resumed.status, 'failed');
    assert.ok(resumed.pid);
    assert.throws(() => process.kill(resumed.pid!, 0));
  } finally { await controller.shutdown(); store.close(); }
}

test('continuous real CLI output cannot indefinitely renew Admin investigation', { skip: process.platform === 'win32' }, async () => {
  await stalledActivityFixture(false);
});

test('repeated completed real reads and different tool IDs do not hide stalled Admin investigation', { skip: process.platform === 'win32' }, async () => {
  await stalledActivityFixture(true);
});

test('Admin uses stable authenticated commands even when the selected business command is corrupt, and only requests verification', async () => {
  const root = join(process.env.LOOP_DATA_ROOT!, randomUUID());
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const damagedAppRoot = join(root, 'damaged-business-runtime');
  mkdirSync(join(damagedAppRoot, 'desktop-runners'), { recursive: true });
  writeFileSync(join(damagedAppRoot, 'desktop-runners', 'loop-admin.cjs'), 'throw new Error("Selected business command is corrupt");');
  const store = new AdminManagementStore(join(root, 'management.db'));
  store.setIntent('running', randomUUID());
  const observationId = randomUUID();
  const repair = store.observe({ observationId, scope: 'runtime', scopeKey: 'fixture', fingerprint: 'missing-file',
    origin: 'runtime', sourceVersion: 'v0', summary: 'Original fixture file is missing', evidence: { expected: 'repaired' } });
  const command = adminCommandLaunch(process.cwd());
  const program = `
    const {spawnSync}=require('node:child_process');
    const {writeFileSync}=require('node:fs'); const {join}=require('node:path');
    const launch=${JSON.stringify(command)};
    if(process.env.LOOP_APP_ROOT!==${JSON.stringify(damagedAppRoot)})throw Error('Fault target was replaced with the tool runtime');
    function run(args) {const r=spawnSync(launch.command,[...launch.args,...args],{env:process.env,encoding:'utf8',timeout:10000});
      if(r.status!==0) throw Error(r.stderr || String(r.error)); return r.stdout;}
    console.log('Admin fixture started');
    setTimeout(()=> {try {
      const status=JSON.parse(run(['status']));
      const fake=spawnSync(launch.command,[...launch.args,'status'],{env:{...process.env,LOOP_ADMIN_COMMAND_TOKEN:'0'.repeat(64)},encoding:'utf8'});
      if(fake.status!==1) throw Error('Forged token accepted');
      writeFileSync(join(process.cwd(),'repair.txt'),'repaired');
      const payload=join(process.env.LOOP_AGENT_TMP_DIR,'action.json');
      writeFileSync(payload,JSON.stringify({file:'repair.txt',actual:'repaired'}));
      run(['evidence','record','--key','file-repair','--kind','change','--payload-file',payload]);
      const result=join(process.env.LOOP_AGENT_TMP_DIR,'result.json');
      writeFileSync(result,JSON.stringify({outcome:'verification-requested',summary:'Fixture repaired; independently verify',repairVersion:'fixture-v1',
        originalObservationIds:[status.observations[0].observation_id],repairEvidenceKeys:['file-repair'],
        verification:{reproductionCommand:'node original-check.mjs',versionCheckCommand:'node version-check.mjs',
          acceptanceChecks:[{targetRef:'original-fixture',command:'node original-check.mjs',expected:'repaired'}]}}));
      run(['submit','--result-file',result]);
      console.log(JSON.stringify({type:'result',result:'submitted'}));
    } catch(e) {console.error(e.stack);process.exitCode=1;} },400);
  `;
  const executor: AgentExecutor = { id: 'claude', label: 'Actual Node management fixture', command: process.execPath,
    promptMode: 'argument', buildArgs: prompt => {
      assert.ok(prompt.includes(adminCommandReference(command)));
      assert.equal(prompt.includes(join(damagedAppRoot, 'desktop-runners', 'loop-admin.cjs')), false);
      return ['-e', program];
    }, formatCommand: () => 'node management-fixture',
    parseStdout: line => line, parseStderr: line => line };
  const controller = createAdminController({ store, ownerId: 'integration-host', confirmStopped: confirmAdminAttemptStopped,
    launch: createAdminExecutionLauncher({ store, appRoot: damagedAppRoot, toolRoot: process.cwd(), dataRoot: root, workspaceRoot: workspace,
      executor, executionOptions: {}, limits: { maxRuntimeMs: 30000, startupTimeoutMs: 10000, idleTimeoutMs: 20000 },
      telemetry: createLangfuseTelemetry({ env: { LANGFUSE_ENABLED: 'false' } }) }) });
  try {
    assert.equal(await controller.reconcile(), 'launched');
    await controller.waitForSettlements();
    const attempt = store.attempts(repair.caseId)[0];
    assert.equal(store.getCase(repair.caseId)?.status, 'verifying', store.getCase(repair.caseId)?.lastError || 'Missing verification request');
    assert.equal(attempt.status, 'completed');
    assert.ok(attempt.pid);
    assert.throws(() => process.kill(attempt.pid!, 0));
    assert.equal(readFileSync(join(workspace, 'repair.txt'), 'utf8'), 'repaired');
    assert.equal((store.observations(repair.caseId)[0] as { observation_id: string }).observation_id, observationId);
    assert.equal(store.evidence(repair.caseId).some(row => (row as { receipt_key: string }).receipt_key === 'file-repair'), true);
    await controller.reconcile();
    assert.equal(store.attempts(repair.caseId).length, 1);
    assert.equal(store.getCase(repair.caseId)?.status, 'verifying', 'Repair summary cannot close the case or declare business success');
  } finally { await controller.shutdown(); store.close(); }
});

test('Admin command samples use the host shell temporary-directory syntax', () => {
  const store = new AdminManagementStore(join(process.env.LOOP_DATA_ROOT!, randomUUID(), 'management.db'));
  try {
    store.setIntent('running', randomUUID());
    store.observe({ observationId: randomUUID(), scope: 'runtime', scopeKey: 'fixture', fingerprint: 'sample', origin: 'runtime',
      sourceVersion: 'v1', summary: 'Sample fault', evidence: {} });
    const claim = store.claimNext(store.acquireSupervisor('host')!)!;
    assert.match(buildAdminPrompt(store, claim, '& node loop-admin.cjs', 'win32'), /\$env:LOOP_AGENT_TMP_DIR\/submission.json/);
    assert.match(buildAdminPrompt(store, claim, 'node loop-admin.cjs', 'darwin'), /\$LOOP_AGENT_TMP_DIR\/submission.json/);
  } finally { store.close(); }
});

test('first Admin process attachment failure still physically terminates its actual isolated CLI', {skip:process.platform==='win32'}, async()=>{
  const root=join(process.env.LOOP_DATA_ROOT!,randomUUID()),workspace=join(root,'workspace');mkdirSync(workspace,{recursive:true});
  const store=new AdminManagementStore(join(root,'management.db'));store.setIntent('running','start');
  store.observe({observationId:randomUUID(),scope:'runtime',scopeKey:'attachment-failure',fingerprint:'controlled',origin:'runtime',sourceVersion:'v1',summary:'Original unresolved fault',evidence:{}});
  const claim=store.claimNext(store.acquireSupervisor('host')!)!;let pid=0,groupId=0;
  const launch=createAdminExecutionLauncher({store,appRoot:process.cwd(),dataRoot:root,workspaceRoot:workspace,
    executor:{id:'claude',label:'Controlled live CLI',command:process.execPath,promptMode:'argument',buildArgs:()=>['-e','setInterval(()=>{},1000)'],formatCommand:()=> 'node attachment fixture',parseStdout:line=>line,parseStderr:line=>line},
    executionOptions:{},limits:{maxRuntimeMs:5000,startupTimeoutMs:2000,idleTimeoutMs:3000},telemetry:createLangfuseTelemetry({env:{LANGFUSE_ENABLED:'false'}})});
  try{
    const result=await(await launch(claim,(childPid,_marker,childGroup)=>{pid=childPid;groupId=childGroup!;throw new Error('Controlled first durable attachment failure');},new AbortController().signal)).completion;
    assert.equal(result.exitConfirmed,true);assert.match(result.reason,/Controlled first durable attachment failure/);assert.ok(pid&&groupId);
    assert.throws(()=>process.kill(pid,0),/ESRCH/);assert.throws(()=>process.kill(-groupId,0),/ESRCH/);
  }finally{store.close();}
});

test('Admin launches cannot inherit ordinary execution authority and Windows command samples are executable PowerShell', () => {
  assert.deepEqual(adminBusinessEnvironmentBoundary({ LOOP_EXECUTION_ID: 'old-execution', LOOP_INTERNAL_COMMAND_TOKEN: 'old-secret',
    LOOP_INTERVENTION_ID: 'old-intervention', LOOP_VERIFICATION_ASSISTANCE_COMMAND_TOKEN: 'old-assistance', LOOP_DATA_ROOT: '/data', PATH: '/bin' }),
  { LOOP_EXECUTION_ID: undefined, LOOP_INTERNAL_COMMAND_TOKEN: undefined, LOOP_INTERVENTION_ID: undefined, LOOP_VERIFICATION_ASSISTANCE_COMMAND_TOKEN: undefined });
  assert.equal(adminCommandReference({ command: 'C:\\Program Files\\node.exe', args: ["C:\\O'Brien\\loop-admin.cjs"] }, 'win32'),
    "& 'C:\\Program Files\\node.exe' 'C:\\O''Brien\\loop-admin.cjs'");
  assert.equal(adminCommandReference({ command: '/node', args: ['/app $data/loop-admin.cjs'] }, 'darwin'),
    "'/node' '/app $data/loop-admin.cjs'");
});

test('an already cancelled Admin launch never spawns and still supplies positive physical settlement proof', async () => {
  const root = join(process.env.LOOP_DATA_ROOT!, randomUUID());
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const store = new AdminManagementStore(join(root, 'management.db'));
  store.setIntent('running', randomUUID());
  store.observe({ observationId: randomUUID(), scope: 'runtime', scopeKey: 'cancelled', fingerprint: 'fixture', origin: 'runtime',
    sourceVersion: 'v1', summary: 'Pending repair', evidence: {} });
  const claim = store.claimNext(store.acquireSupervisor('host')!)!;
  const cancellation = new AbortController();
  cancellation.abort();
  let bound = false;
  const launch = createAdminExecutionLauncher({ store, appRoot: process.cwd(), dataRoot: root, workspaceRoot: workspace,
    executor: { id: 'claude', label: 'Must not launch', command: process.execPath, promptMode: 'argument',
      buildArgs: () => ['-e', 'require("node:fs").writeFileSync("unexpected.txt","spawned")'], formatCommand: () => 'fixture',
      parseStdout: () => null, parseStderr: () => null }, executionOptions: {},
    limits: { maxRuntimeMs: 2000, startupTimeoutMs: 500, idleTimeoutMs: 1000 },
    telemetry: createLangfuseTelemetry({ env: { LANGFUSE_ENABLED: 'false' } }) });
  try {
    const handle = await launch(claim, () => { bound = true; }, cancellation.signal);
    const result = await handle.completion;
    assert.equal(result.outcome, 'failed');
    assert.equal(result.exitConfirmed, true);
    assert.equal(bound, false);
    assert.equal(store.attempts(claim.repairCase.caseId)[0].pid, null);
    store.finishAttempt(claim, result);
    assert.equal(store.getCase(claim.repairCase.caseId)?.currentAttemptId, null);
  } finally { store.close(); }
});

test('known pre-spawn preparation failure releases the Admin allocation instead of leaving an unknown-process fence', async () => {
  const root = join(process.env.LOOP_DATA_ROOT!, randomUUID());
  mkdirSync(root, { recursive: true });
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const impossibleDataRoot = join(root, 'regular-file');
  writeFileSync(impossibleDataRoot, 'not a directory');
  const store = new AdminManagementStore(join(root, 'management.db'));
  store.setIntent('running', randomUUID());
  store.observe({ observationId: randomUUID(),scope: 'runtime',scopeKey: 'setup',fingerprint: 'setup',origin: 'runtime',
    sourceVersion: 'v1',summary: 'Runtime repair required',evidence: {} });
  const claim = store.claimNext(store.acquireSupervisor('host')!)!;
  let bound = false;
  const launch = createAdminExecutionLauncher({ store,appRoot: process.cwd(),dataRoot: impossibleDataRoot,workspaceRoot: workspace,
    executor: { id: 'claude',label: 'Must not launch',command: process.execPath,promptMode: 'argument',
      buildArgs: () => ['-e','setInterval(()=>{},1000)'],formatCommand: () => 'fixture',parseStdout: () => null,parseStderr: () => null },
    executionOptions: {},limits: { maxRuntimeMs: 2000,startupTimeoutMs: 500,idleTimeoutMs: 1000 },
    telemetry: createLangfuseTelemetry({ env: { LANGFUSE_ENABLED: 'false' } }) });
  try {
    const handle = await launch(claim, () => { bound = true; },new AbortController().signal);
    const result = await handle.completion;
    assert.equal(result.exitConfirmed,true);
    assert.equal(result.outcome,'failed');
    assert.match(result.reason,/ENOTDIR/);
    assert.equal(bound,false);
    store.finishAttempt(claim,result);
    assert.equal(store.getCase(claim.repairCase.caseId)?.currentAttemptId,null);
    assert.equal(store.claimNext(claim.authority)?.attempt.generation,2);
  } finally { store.close(); }
});
