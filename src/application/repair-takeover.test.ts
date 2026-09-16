import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { AdminManagementStore } from '../infrastructure/admin-management-store';
import { databaseConnection } from '../infrastructure/database';
import { terminateProcessGroup, terminateProcessTree, waitForProcessIdentity } from '../infrastructure/process-tree';
import { beginTestExecutionAttempt } from '../test/execution-fixtures';
import { inspectTaskDispatchEnvelope } from '../test/dispatch-inspection-fixtures';
import { createTaskInDb, createTaskSchema } from './tasks';
import { createProject, deleteProject, updateProject } from './projects';
import { openInterventionInDb } from './interventions';
import { acknowledgeRepairObservationInDb, pendingRepairObservationsInDb } from './repair-observation-outbox';
import type { RepairObservation } from '../domain/repair-case';
import { acquireResourceClaimInDb, activeResourceClaimInDb, releaseTaskResourceClaimsInDb, tryAcquireResourceClaimInDb } from './resource-claims';
import { attachExecutionProcessInDb, finishExecutionProcessInDb, prepareExecutionProcessInDb } from './execution-processes';
import { acquireRepairTakeover, invalidRepairTakeoversInDb, repairTakeoverAuthorization,
  pendingRepairTakeoverRevocationsInDb, revokeInvalidRepairTakeoversInDb } from './repair-takeover';
import { repairResourceOwnerInDb } from './repair-resources';
import { runAdminCommand } from './admin-command';
import { createAdminManagedActions } from './admin-managed-actions';
import { adminCommandLaunch, createAdminExecutionLauncher } from '../infrastructure/admin-execution';
import { createLangfuseTelemetry } from '../infrastructure/langfuse';
import type { AgentExecutor } from '../infrastructure/agent-executor';
import { reconcileAdminBusinessTakeovers } from '../infrastructure/admin-business-operations';
import { rewindWorkItemsInDb } from './work-item-transitions';

async function fixture() {
  const db = await databaseConnection();
  const workspace = join(process.env.LOOP_WORKSPACE_ROOT_OVERRIDE!, randomUUID());
  mkdirSync(workspace, { recursive: true });
  const projectId = await createProject({ name: 'Scoped repair fixture', workspaceRoot: workspace });
  const taskId = `REQ-${randomUUID()}`;
  createTaskInDb(db, createTaskSchema.parse({ title: 'Repair takeover fixture', itemType: 'direct', projectId }), taskId);
  const delegation = (await inspectTaskDispatchEnvelope(taskId))[0];
  const { attempt } = await beginTestExecutionAttempt({ runId: `RUN-${randomUUID()}`, delegation, prompt: 'Original acceptance and task' });
  acquireResourceClaimInDb(db, { resourceKey: 'code:workspace', taskId, lane: 'control', executionId: attempt.execution_id });
  const allocationId = prepareExecutionProcessInDb(db, attempt.execution_id, process.pid, 7);
  const source = openInterventionInDb(db, { taskId, itemId: attempt.work_item_id!, sourceExecutionId: attempt.execution_id,
    requestedBy: 'direct-agent', authority: 'arbitration', dedupeKey: `fault:${randomUUID()}`, summary: 'Original implementation missing',
    context: { failureSignature: 'original-failure', acceptance: 'Original feature must work' } });
  const store = new AdminManagementStore(join(process.env.LOOP_DATA_ROOT!, randomUUID(), 'management.db'));
  const raw = db.prepare('SELECT observation_json FROM repair_observation_outbox WHERE intervention_id = ?').get(source.intervention_id) as { observation_json: string };
  const repair = store.observe(JSON.parse(raw.observation_json) as RepairObservation);
  acknowledgeRepairObservationInDb(db, `intervention:${source.intervention_id}`, repair.caseId);
  store.setIntent('running', randomUUID());
  const claim = store.claimNext(store.acquireSupervisor(`host-${randomUUID()}`)!)!;
  const target = { caseId: repair.caseId, generation: claim.attempt.generation, ownerId: claim.authority.ownerId,
    supervisionToken: claim.authority.token, taskId, itemId: attempt.work_item_id!, itemRevision: 1, reason: 'Reproduce and fix the original missing implementation' };
  return { db, workspace: realpathSync(workspace), projectId, taskId, allocationId, executionId: attempt.execution_id, target, store, claim,
    assertCurrent: repairTakeoverAuthorization(claim, current => store.readCommandSubmission(current)) };
}

test('dispatch epoch changing during physical cleanup cannot produce an owned repair anchor', async () => {
  const h = await fixture();
  try {
    await assert.rejects(acquireRepairTakeover({ ...h, stopExecutions: async () => {
      finishExecutionProcessInDb(h.db, h.allocationId, true);
      h.db.prepare('UPDATE workflow_items SET dispatch_epoch=dispatch_epoch+1 WHERE item_id=?').run(h.target.itemId);
      return [];
    } }), /清理期间派发代次已改变/);
    assert.equal((h.db.prepare('SELECT phase FROM repair_resource_claims WHERE case_id=?').get(h.target.caseId) as { phase: string }).phase, 'draining');
    assert.equal((await inspectTaskDispatchEnvelope(h.taskId)).length, 0);
  } finally { h.store.close(); }
});

test('repair write ownership requires physical exit and fences planner, acquisition and spawn even after logical claims are released', async () => {
  const h = await fixture();
  const other = await fixture();
  let stops = 0;
  try {
    attachExecutionProcessInDb(h.db, h.allocationId, 7777, 'original-process');
    attachExecutionProcessInDb(h.db, other.allocationId, 7778, 'independent-process');
    const stopExecutions = async (ids: string[]) => { stops++; assert.deepEqual(ids, [h.executionId]); return []; };
    const first = await acquireRepairTakeover({ ...h, stopExecutions });
    assert.equal(first.phase, 'draining', 'an empty residual list is not proof if the durable process remains active');
    assert.equal(first.workspaceRoot, null);
    assert.equal((h.db.prepare('SELECT status,failure_kind,dispatch_retry_consumed FROM execution_attempts WHERE execution_id = ?').get(h.executionId) as { status: string }).status, 'cancelled');
    const otherBefore = h.db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(other.executionId);
    releaseTaskResourceClaimsInDb(h.db, h.taskId);
    assert.equal(activeResourceClaimInDb(h.db, 'code:workspace', h.taskId)?.owner_lane, 'admin');
    assert.equal(tryAcquireResourceClaimInDb(h.db, { resourceKey: 'code:workspace', taskId: h.taskId, lane: 'control' }), false);
    assert.equal((await inspectTaskDispatchEnvelope(h.taskId)).length, 0);
    assert.equal(activeResourceClaimInDb(h.db, 'code:workspace', other.taskId)?.owner_lane, 'control');
    assert.equal(repairResourceOwnerInDb(h.db, 'code:workspace', `project:${other.projectId}`), undefined);
    assert.deepEqual(h.db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(other.executionId), otherBefore);
    finishExecutionProcessInDb(h.db, h.allocationId, true);
    const owned = await acquireRepairTakeover({ ...h, stopExecutions });
    assert.equal(owned.phase, 'owned');
    assert.equal(owned.workspaceRoot, h.workspace);
    assert.equal(stops, 2, 'replay still checks the original cancelled execution');
    assert.equal((h.db.prepare('SELECT COUNT(*) AS count FROM repair_takeover_events WHERE case_id = ?').get(h.target.caseId) as { count: number }).count, 2,
      'one takeover request and one immutable physical-target receipt; replay duplicates neither');
    assert.equal(repairResourceOwnerInDb(h.db, 'code:workspace', `project:${h.projectId}`)?.phase, 'owned');
    const competitor = `REQ-${randomUUID()}`;
    createTaskInDb(h.db, createTaskSchema.parse({ title: 'Same project unrelated work', itemType: 'direct', projectId: h.projectId }), competitor);
    assert.equal((await inspectTaskDispatchEnvelope(competitor)).length, 0, 'the planner must reject a different ready task even after every old process and logical claim is gone');
    const independentWorkspace = join(process.env.LOOP_WORKSPACE_ROOT_OVERRIDE!, randomUUID());
    mkdirSync(independentWorkspace, { recursive: true });
    const independentProject = await createProject({ name: 'Unrelated ready project', workspaceRoot: independentWorkspace });
    const independentTask = `REQ-${randomUUID()}`;
    createTaskInDb(h.db, createTaskSchema.parse({ title: 'Independent ready work', itemType: 'direct', projectId: independentProject }), independentTask);
    assert.equal((await inspectTaskDispatchEnvelope(independentTask)).length, 1, 'an independent workspace remains dispatchable');
    // A late activation with stale logical ownership must also be stopped at
    // the last pre-spawn boundary, not only by the planner.
    h.db.prepare("UPDATE execution_attempts SET status = 'running' WHERE execution_id = ?").run(h.executionId);
    h.db.prepare("INSERT INTO resource_claims(resource_key,resource_scope,owner_task_id,owner_lane,owner_execution_id) VALUES('code:workspace',?,?,'control',?)")
      .run(`project:${h.projectId}`, h.taskId, h.executionId);
    assert.throws(() => prepareExecutionProcessInDb(h.db, h.executionId, process.pid, 7), /不可启动|尚未确认/);
    h.db.prepare("UPDATE execution_attempts SET status = 'cancelled' WHERE execution_id = ?").run(h.executionId);
    releaseTaskResourceClaimsInDb(h.db, h.taskId);
    const replacementWorkspace = join(process.env.LOOP_WORKSPACE_ROOT_OVERRIDE!, randomUUID());
    mkdirSync(replacementWorkspace, { recursive: true });
    await assert.rejects(updateProject({ projectId: h.projectId, name: 'Held project', workspaceRoot: replacementWorkspace }), /修复接管/);
    await assert.rejects(deleteProject(h.projectId), /修复接管/);
    assert.equal((h.db.prepare('SELECT status FROM workflow_items WHERE item_id = ?').get(h.target.itemId) as { status: string }).status, 'waiting');
    h.store.setIntent('stopped', randomUUID());
    await assert.rejects(acquireRepairTakeover({ ...h, stopExecutions }), /运行意图|监督权/);
  } finally { finishExecutionProcessInDb(h.db, h.allocationId, true); finishExecutionProcessInDb(h.db, other.allocationId, true); h.store.close(); other.store.close(); }
});

test('authenticated workspace commands persist requests, reject false ownership, and cannot submit a code repair before takeover', async () => {
  const h = await fixture();
  const credential = h.store.issueCommandCredential(h.claim);
  const args = ['workspace','takeover','--key','workspace','--item-id',h.target.itemId,'--revision','1','--reason','Fix original implementation'];
  const manage = createAdminManagedActions({ store: h.store,
    takeover: (target, assertCurrent, previousOwnerStopped) => acquireRepairTakeover({ db: h.db, target, assertCurrent, previousOwnerStopped, stopExecutions: async () => [] }) });
  try {
    assert.throws(() => runAdminCommand(h.store, credential, args), /先读取 status/);
    runAdminCommand(h.store, credential, ['status']);
    assert.equal(JSON.parse(runAdminCommand(h.store, credential, args)).status, 'pending');
    assert.equal(JSON.parse(runAdminCommand(h.store, credential, args)).status, 'pending');
    assert.throws(() => runAdminCommand(h.store, credential, [...args.slice(0,-1),'Different request reused key']), /幂等键冲突/);
    assert.throws(() => runAdminCommand(h.store, credential, args.map(value => value === h.target.itemId ? 'foreign-item' : value)), /原始业务/);
    await manage(h.claim.authority);
    const draining = JSON.parse(runAdminCommand(h.store, credential, ['status'])).actions[0];
    assert.equal(draining.status, 'pending');
    assert.equal(draining.result.phase, 'draining');
    assert.equal(draining.result.workspaceRoot, null);
    h.store.recordEvidence(h.claim, 'repair-change', 'change', { actualAction: 'fixture change' });
    const observation = h.store.observations(h.claim.repairCase.caseId)[0] as { observation_id: string };
    const submission = { outcome: 'verification-requested', summary: 'Independently verify original failure', repairVersion: 'fixture-v1',
      originalObservationIds: [observation.observation_id], repairEvidenceKeys: ['repair-change'],
      verification: { reproductionCommand: 'node original.mjs',versionCheckCommand: 'node version.mjs',
        acceptanceChecks: [{ targetRef: 'original',command: 'node original.mjs',expected: 'Original acceptance passes' }] } };
    assert.throws(() => h.store.commandSubmit(credential, submission), /本轮工作区接管/);
    finishExecutionProcessInDb(h.db, h.allocationId, true);
    await manage(h.claim.authority);
    const owned = JSON.parse(runAdminCommand(h.store, credential, args));
    assert.equal(owned.status, 'completed');
    assert.equal(owned.result.workspaceRoot, h.workspace);
    assert.equal(h.store.commandSubmit(credential, submission), true);
    assert.equal(h.store.getCase(h.claim.repairCase.caseId)?.status, 'running');
    assert.throws(() => h.store.recordCommandActionResult(h.claim, 'workspace', 'failed', { error: 'overwrite' }), /不能改写/);
    assert.throws(() => runAdminCommand(h.store, credential, args), /已终止提交/);
    assert.equal(h.store.pendingCommandActions(h.claim.authority).length, 0);
  } finally { finishExecutionProcessInDb(h.db, h.allocationId, true); h.store.close(); }
});

test('a new Admin generation inherits the repair fence only after the previous physical execution is confirmed stopped', async () => {
  const h = await fixture();
  try {
    await acquireRepairTakeover({ ...h, stopExecutions: async () => [] });
    h.store.finishAttempt(h.claim, { outcome: 'failed',reason: 'Admin exited mid-drain',exitConfirmed: false });
    assert.equal(h.store.claimNext(h.claim.authority), null);
    h.store.finishAttempt(h.claim, { outcome: 'failed',reason: 'Actual Admin exit confirmed',exitConfirmed: true });
    const next = h.store.claimNext(h.claim.authority)!;
    assert.equal(next.attempt.generation, 2);
    const credential = h.store.issueCommandCredential(next);
    runAdminCommand(h.store, credential, ['status']);
    runAdminCommand(h.store, credential, ['workspace','takeover','--key','resume-ownership','--item-id',h.target.itemId,'--revision','1','--reason','Continue previous investigation']);
    const manage = createAdminManagedActions({ store: h.store, takeover: (target, assertCurrent, previousOwnerStopped) =>
      acquireRepairTakeover({ db: h.db,target,assertCurrent,previousOwnerStopped,stopExecutions: async ids => {
        assert.deepEqual(ids, [h.executionId]);
        return [];
      } }) });
    await manage(next.authority);
    assert.equal(repairResourceOwnerInDb(h.db, 'code:workspace', `project:${h.projectId}`)?.generation, 2);
    assert.equal(repairResourceOwnerInDb(h.db, 'code:workspace', `project:${h.projectId}`)?.phase, 'draining');
    finishExecutionProcessInDb(h.db, h.allocationId, true);
    await manage(next.authority);
    assert.equal(JSON.parse(runAdminCommand(h.store, credential, ['status'])).actions[0].status, 'completed');
  } finally { finishExecutionProcessInDb(h.db, h.allocationId, true); h.store.close(); }
});

test('real Admin command subprocess requests takeover before modifying business files and submitting independent verification', async () => {
  const h = await fixture();
  const old = spawn(process.execPath, ['-e','setInterval(()=>{},1000)'], { cwd: h.workspace,stdio: 'ignore',detached: process.platform !== 'win32' });
  const oldClosed = new Promise<void>((resolve,reject) => { old.once('close', () => resolve());old.once('error',reject); });
  const identity = await waitForProcessIdentity(old.pid!);
  assert.ok(identity);
  attachExecutionProcessInDb(h.db,h.allocationId,old.pid!,identity.startMarker,process.platform === 'win32' ? undefined : old.pid);
  const launch = adminCommandLaunch(process.cwd());
  const program = `
    const {spawnSync}=require('node:child_process'),{writeFileSync}=require('node:fs'),{join}=require('node:path');
    const launch=${JSON.stringify(launch)};
    function run(args){const r=spawnSync(launch.command,[...launch.args,...args],{env:process.env,encoding:'utf8',timeout:10000});if(r.status!==0)throw Error(r.stderr||String(r.error));return r.stdout;}
    console.log('Admin investigation started');
    setTimeout(()=>{try {
      const status=JSON.parse(run(['status']));const original=status.observations.find(o=>o.origin==='business');const source=JSON.parse(original.evidence_json);
      run(['workspace','takeover','--key','ownership','--item-id',source.item.item_id,'--revision',String(source.item.revision),'--reason','Fix original implementation']);
      let count=0;
      function poll(){try {
        const action=JSON.parse(run(['status'])).actions.find(a=>a.key==='ownership');
        if(action.status==='failed') throw Error(JSON.stringify(action.result));
        if(action.status!=='completed'||action.result.phase!=='owned'){if(++count>100)throw Error('ownership timeout');return setTimeout(poll,50);}
        writeFileSync(join(action.result.workspaceRoot,'repaired.txt'),'repaired');
        const evidence=join(process.env.LOOP_AGENT_TMP_DIR,'change.json');writeFileSync(evidence,JSON.stringify({file:'repaired.txt',actual:'repaired'}));
        run(['evidence','record','--key','code-change','--kind','change','--payload-file',evidence]);
        const result=join(process.env.LOOP_AGENT_TMP_DIR,'result.json');writeFileSync(result,JSON.stringify({outcome:'verification-requested',summary:'Independently check actual repair',repairVersion:'fixture-v1',originalObservationIds:[original.observation_id],repairEvidenceKeys:['code-change'],verification:{reproductionCommand:'node original.mjs',versionCheckCommand:'node version.mjs',acceptanceChecks:[{targetRef:'original-acceptance',command:'node original.mjs',expected:'Original implementation works'}]}}));
        run(['submit','--result-file',result]);console.log(JSON.stringify({type:'result',result:'Submitted actual repair'}));
      }catch(e){console.error(e.stack);process.exitCode=1;}} poll();
    }catch(e){console.error(e.stack);process.exitCode=1;}},400);
  `;
  const diagnosticWorkspace = join(process.env.LOOP_WORKSPACE_ROOT_OVERRIDE!, randomUUID());
  mkdirSync(diagnosticWorkspace,{recursive:true});
  const executor: AgentExecutor = { id: 'claude',label: 'Node Admin command fixture',command: process.execPath,promptMode: 'argument',
    buildArgs: () => ['-e',program],formatCommand: () => 'node management command fixture',parseStdout: line => line,parseStderr: line => line };
  const invoke = createAdminExecutionLauncher({ store: h.store,appRoot: process.cwd(),dataRoot: process.env.LOOP_DATA_ROOT!,workspaceRoot: diagnosticWorkspace,
    executor,executionOptions: {},limits: { maxRuntimeMs: 30000,startupTimeoutMs: 10000,idleTimeoutMs: 20000 },
    telemetry: createLangfuseTelemetry({ env: { LANGFUSE_ENABLED: 'false' } }) });
  const manage = createAdminManagedActions({ store: h.store,takeover: (target,assertCurrent,previousOwnerStopped) =>
    acquireRepairTakeover({ db: h.db,target,assertCurrent,previousOwnerStopped }) });
  let handle: Awaited<ReturnType<typeof invoke>> | undefined;
  try {
    handle = await invoke(h.claim, (pid,marker,group) => h.store.attachProcess(h.claim,pid,marker,group),new AbortController().signal);
    const deadline = Date.now()+15000;
    while (!h.store.pendingCommandActions(h.claim.authority).length && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(h.store.pendingCommandActions(h.claim.authority).length,1);
    await manage(h.claim.authority);
    const result = await handle.completion;
    assert.equal(result.outcome,'verification-requested',result.reason);
    assert.equal(result.exitConfirmed,true);
    assert.equal(readFileSync(join(h.workspace,'repaired.txt'),'utf8'),'repaired');
    await oldClosed;
    assert.throws(()=>process.kill(old.pid!,0));
    h.store.finishAttempt(h.claim,result);
    assert.equal(h.store.getCase(h.claim.repairCase.caseId)?.status,'verifying');
    assert.equal(repairResourceOwnerInDb(h.db,'code:workspace',`project:${h.projectId}`)?.phase,'owned','Independent verifier and handoff are still required before releasing the repair fence');
  } finally {
    await handle?.stop();
    if(process.platform!=='win32') await terminateProcessGroup(old.pid!,1000,identity.startMarker);
    else await terminateProcessTree(old.pid!,1000,identity.startMarker);
    h.store.close();
  }
});

test('pause or ownership loss during slow physical cleanup cannot grant repair write access', async () => {
  const h = await fixture();
  try {
    await assert.rejects(acquireRepairTakeover({ ...h, stopExecutions: async () => {
      finishExecutionProcessInDb(h.db, h.allocationId, true);
      h.db.prepare('UPDATE tasks SET is_paused = 1 WHERE task_id = ?').run(h.taskId);
      return [];
    } }), /暂停/);
    assert.equal(repairResourceOwnerInDb(h.db, 'code:workspace', `project:${h.projectId}`)?.phase, 'draining');
    assert.equal(tryAcquireResourceClaimInDb(h.db, { resourceKey: 'code:workspace', taskId: h.taskId, lane: 'control' }), false);
  } finally { finishExecutionProcessInDb(h.db, h.allocationId, true); h.store.close(); }
});

test('repair takeover rejects stale revisions, another Case or generation, and genuine operator holds', async () => {
  const h = await fixture();
  const stopExecutions = async () => { finishExecutionProcessInDb(h.db, h.allocationId, true); return []; };
  try {
    await assert.rejects(acquireRepairTakeover({ ...h, target: { ...h.target, itemRevision: 2 }, stopExecutions }), /来源版本/);
    await assert.rejects(acquireRepairTakeover({ ...h, target: { ...h.target, caseId: 'foreign-case' }, stopExecutions }), /凭证/);
    await acquireRepairTakeover({ ...h, stopExecutions });
    await assert.rejects(acquireRepairTakeover({ ...h, target: { ...h.target, generation: 2 }, stopExecutions }), /凭证/);
    openInterventionInDb(h.db, { taskId: h.taskId, requestedBy: 'human', resolverStrategy: 'human_only', dedupeKey: 'operator-input', summary: 'Need original operator decision' });
    await assert.rejects(acquireRepairTakeover({ ...h, stopExecutions }), /人工输入/);
  } finally { finishExecutionProcessInDb(h.db, h.allocationId, true); h.store.close(); }
});

test('cancelled source revokes the stopped Admin fence, persists a terminal outcome and unblocks the project', async () => {
  const h = await fixture();
  try {
    finishExecutionProcessInDb(h.db, h.allocationId, true);
    assert.equal((await acquireRepairTakeover({ ...h, stopExecutions: async () => [] })).phase, 'owned');
    h.db.prepare("UPDATE workflow_items SET status='cancelled' WHERE item_id=?").run(h.target.itemId);
    assert.equal(invalidRepairTakeoversInDb(h.db)[0].kind, 'cancelled');
    let outcomes = await revokeInvalidRepairTakeoversInDb({ db: h.db, ownerStopped: () => false, stopExecutions: async () => [] });
    assert.equal(outcomes[0].status, 'owner-running');
    assert.ok(repairResourceOwnerInDb(h.db, 'code:workspace', `project:${h.projectId}`));
    h.store.finishAttempt(h.claim, { outcome: 'failed', reason: 'Source cancelled', exitConfirmed: true });
    outcomes = await revokeInvalidRepairTakeoversInDb({ db: h.db, ownerStopped: owner => h.store.attempts(owner.case_id).some(attempt =>
      attempt.generation === owner.generation && !['launching', 'running'].includes(attempt.status)), stopExecutions: async () => [] });
    const revoked = outcomes[0];
    assert.equal(revoked.status, 'revoked');
    assert.equal(repairResourceOwnerInDb(h.db, 'code:workspace', `project:${h.projectId}`), undefined);
    h.store.recordRepairTakeoverRevocation(h.claim.authority, { caseId: revoked.owner.case_id, generation: revoked.owner.generation,
      kind: revoked.kind, terminal: revoked.terminal, reason: revoked.reason, eventKey: revoked.eventKey!,
      coveredObservationIds: (h.store.observations(h.target.caseId) as Array<{ observation_id: string }>).map(row => row.observation_id) });
    assert.equal(h.store.getCase(h.target.caseId)?.status, 'closed');
    const competitor = `REQ-${randomUUID()}`;
    createTaskInDb(h.db, createTaskSchema.parse({ title: 'New work after cancelled repair', itemType: 'direct', projectId: h.projectId }), competitor);
    assert.equal((await inspectTaskDispatchEnvelope(competitor)).length, 1);
  } finally { h.store.close(); }
});

test('rewind revokes the stopped old fence and the next generation takes over the persisted successor', async () => {
  const h = await fixture();
  try {
    finishExecutionProcessInDb(h.db, h.allocationId, true);
    assert.equal((await acquireRepairTakeover({ ...h, stopExecutions: async () => [] })).phase, 'owned');
    const successor = randomUUID();
    h.db.prepare(`INSERT INTO workflow_items(item_id,task_id,work_key,revision,kind,title,story_index,agent,pipeline,lane,status,origin,context_json)
      SELECT ?,task_id,work_key,revision+1,kind,title,story_index,agent,pipeline,lane,'superseded',origin,context_json
      FROM workflow_items WHERE item_id=?`).run(successor, h.target.itemId);
    h.db.prepare("UPDATE workflow_items SET status='superseded',superseded_by_item_id=? WHERE item_id=?").run(successor, h.target.itemId);
    h.db.prepare("UPDATE workflow_items SET status='waiting' WHERE item_id=?").run(successor);
    h.db.prepare('UPDATE interventions SET item_id=? WHERE repair_case_id=?').run(successor, h.target.caseId);
    h.store.finishAttempt(h.claim, { outcome: 'failed', reason: 'Rewind changed source authority', exitConfirmed: true });
    const outcomes = await revokeInvalidRepairTakeoversInDb({ db: h.db, ownerStopped: () => true, stopExecutions: async () => [] });
    const revoked = outcomes[0];
    assert.equal(revoked.status, 'revoked'); assert.equal(revoked.terminal, false);
    h.store.recordRepairTakeoverRevocation(h.claim.authority, { caseId: revoked.owner.case_id, generation: revoked.owner.generation,
      kind: revoked.kind, terminal: revoked.terminal, reason: revoked.reason, eventKey: revoked.eventKey!,
      coveredObservationIds: (h.store.observations(h.target.caseId) as Array<{ observation_id: string }>).map(row => row.observation_id) });
    assert.equal(h.store.getCase(h.target.caseId)?.status, 'queued');
    const next = h.store.claimNext(h.claim.authority)!;
    const target = { ...h.target, generation: next.attempt.generation, ownerId: next.authority.ownerId,
      supervisionToken: next.authority.token };
    const reacquired = await acquireRepairTakeover({ db: h.db, target,
      assertCurrent: repairTakeoverAuthorization(next, current => h.store.readCommandSubmission(current)),
      previousOwnerStopped: () => true, stopExecutions: async () => [] });
    assert.equal(reacquired.phase, 'owned');
    assert.equal(reacquired.anchor.itemId, successor);
    assert.deepEqual(reacquired.anchor.predecessors, [{ itemId: h.target.itemId, revision: 1 }]);
  } finally { h.store.close(); }
});

test('source cancellation during a later Case generation stops that current execution before releasing the workspace', async () => {
  const h = await fixture();
  try {
    finishExecutionProcessInDb(h.db, h.allocationId, true);
    assert.equal((await acquireRepairTakeover({ ...h, stopExecutions: async () => [] })).phase, 'owned');
    h.store.finishAttempt(h.claim, { outcome: 'failed', reason: 'Prepare a later verification generation', exitConfirmed: true });
    const later = h.store.claimNext(h.claim.authority)!;
    assert.ok(later.attempt.generation > h.claim.attempt.generation);
    h.db.prepare("UPDATE workflow_items SET status='cancelled' WHERE item_id=?").run(h.target.itemId);

    const first = await reconcileAdminBusinessTakeovers({ db: h.db, store: h.store, authority: h.claim.authority });
    assert.deepEqual(first.attemptIds, [later.attempt.attemptId]);
    assert.ok(repairResourceOwnerInDb(h.db, 'code:workspace', `project:${h.projectId}`),
      'the business fence stays held while the current Case generation is live');
    assert.equal(pendingRepairTakeoverRevocationsInDb(h.db).filter(row => row.caseId === h.target.caseId).length, 0);

    assert.equal(h.store.retireStoppedAttempt(h.claim.authority, later.attempt.attemptId, true,
      'Source cancellation stops the current verification generation'), true);
    const second = await reconcileAdminBusinessTakeovers({ db: h.db, store: h.store, authority: h.claim.authority });
    assert.equal(second.revoked, 1);
    assert.equal(repairResourceOwnerInDb(h.db, 'code:workspace', `project:${h.projectId}`), undefined);
    assert.equal(h.store.getCase(h.target.caseId)?.status, 'closed');
  } finally { h.store.close(); }
});

test('a business revocation receipt replays after fence release until management durably acknowledges it', async () => {
  const h = await fixture();
  try {
    finishExecutionProcessInDb(h.db, h.allocationId, true);
    assert.equal((await acquireRepairTakeover({ ...h, stopExecutions: async () => [] })).phase, 'owned');
    h.store.finishAttempt(h.claim, { outcome: 'failed', reason: 'Owner stopped before cancellation', exitConfirmed: true });
    h.db.prepare("UPDATE workflow_items SET status='cancelled' WHERE item_id=?").run(h.target.itemId);
    const released = await revokeInvalidRepairTakeoversInDb({ db: h.db, ownerStopped: () => true, stopExecutions: async () => [] });
    assert.equal(released[0].status, 'revoked');
    assert.equal(repairResourceOwnerInDb(h.db, 'code:workspace', `project:${h.projectId}`), undefined);
    assert.equal(pendingRepairTakeoverRevocationsInDb(h.db).filter(row => row.caseId === h.target.caseId).length, 1,
      'simulated crash leaves the immutable business receipt pending');
    assert.notEqual(h.store.getCase(h.target.caseId)?.status, 'closed');

    const replay = await reconcileAdminBusinessTakeovers({ db: h.db, store: h.store, authority: h.claim.authority });
    assert.equal(replay.revoked, 1);
    assert.equal(pendingRepairTakeoverRevocationsInDb(h.db).filter(row => row.caseId === h.target.caseId).length, 0);
    assert.equal(h.store.getCase(h.target.caseId)?.status, 'closed');
    const idempotent = await reconcileAdminBusinessTakeovers({ db: h.db, store: h.store, authority: h.claim.authority });
    assert.equal(idempotent.revoked, 0);
  } finally { h.store.close(); }
});

test('an old terminal revocation acknowledges without closing or stopping a successor fault outside its coverage', async () => {
  const h = await fixture();
  try {
    finishExecutionProcessInDb(h.db, h.allocationId, true);
    assert.equal((await acquireRepairTakeover({ ...h, stopExecutions: async () => [] })).phase, 'owned');
    h.store.finishAttempt(h.claim, { outcome: 'failed', reason: 'Old repair generation stopped', exitConfirmed: true });
    const { replacements } = rewindWorkItemsInDb(h.db, { taskId: h.taskId, targetItemId: h.target.itemId,
      eventKey: `old-revocation:${randomUUID()}`, actor: 'human', authority: 'human', reason: 'Replace the old version' });
    const successor = replacements[h.target.itemId];
    const released = await revokeInvalidRepairTakeoversInDb({ db: h.db, ownerStopped: () => true, stopExecutions: async () => [] });
    assert.equal(released[0].status, 'revoked');
    const receipt = pendingRepairTakeoverRevocationsInDb(h.db).find(row => row.caseId === h.target.caseId)!;

    const newFault = openInterventionInDb(h.db, { taskId: h.taskId, itemId: successor, requestedBy: 'test-agent',
      authority: 'arbitration', dedupeKey: `successor-fault:${randomUUID()}`, summary: 'New successor implementation fault',
      context: { failureSignature: 'successor-new-fault' } });
    const observation = pendingRepairObservationsInDb(h.db).map(row => JSON.parse(row.observation_json) as RepairObservation)
      .find(row => row.observationId === `intervention:${newFault.intervention_id}`)!;
    assert.equal(h.store.observe(observation).caseId, h.target.caseId);
    acknowledgeRepairObservationInDb(h.db, observation.observationId, h.target.caseId);
    assert.equal(h.store.getCase(h.target.caseId)?.status, 'queued');

    const replay = await reconcileAdminBusinessTakeovers({ db: h.db, store: h.store, authority: h.claim.authority });
    assert.equal(replay.revoked, 1);
    assert.equal(h.store.getCase(h.target.caseId)?.status, 'queued');
    assert.equal((h.db.prepare('SELECT status FROM interventions WHERE intervention_id=?').get(newFault.intervention_id) as { status: string }).status,
      'pending');
    const next = h.store.claimNext(h.claim.authority)!;
    assert.equal(next.repairCase.caseId, h.target.caseId);
    assert.equal(h.store.recordRepairTakeoverRevocation(h.claim.authority, receipt), false,
      'a duplicate management delivery only confirms the immutable receipt');
    assert.equal(h.store.getCase(h.target.caseId)?.currentAttemptId, next.attempt.attemptId);
    assert.equal(h.store.getCase(h.target.caseId)?.status, 'running');
  } finally { h.store.close(); }
});

test('real rewind without a successor fault closes obsolete repair responsibility instead of requeueing forever', async () => {
  const h = await fixture();
  try {
    finishExecutionProcessInDb(h.db, h.allocationId, true);
    assert.equal((await acquireRepairTakeover({ ...h, stopExecutions: async () => [] })).phase, 'owned');
    h.store.finishAttempt(h.claim, { outcome: 'failed', reason: 'Real rewind replaces the source', exitConfirmed: true });
    const { replacements } = rewindWorkItemsInDb(h.db, { taskId: h.taskId, targetItemId: h.target.itemId,
      eventKey: `repair-rewind:${randomUUID()}`, actor: 'human', authority: 'human', reason: 'Requirement changed' });
    const successor = replacements[h.target.itemId];
    assert.ok(successor);
    assert.equal((h.db.prepare('SELECT status FROM interventions WHERE repair_case_id=?').get(h.target.caseId) as { status: string }).status,
      'superseded');
    const invalid = invalidRepairTakeoversInDb(h.db)[0];
    assert.equal(invalid.kind, 'superseded');
    assert.equal(invalid.terminal, true);
    assert.match(invalid.reason, /没有待修复故障/);
    const result = await reconcileAdminBusinessTakeovers({ db: h.db, store: h.store, authority: h.claim.authority });
    assert.equal(result.revoked, 1);
    assert.equal(h.store.getCase(h.target.caseId)?.status, 'closed');
    assert.equal(h.store.claimNext(h.claim.authority), null);
  } finally { h.store.close(); }
});

test('real writer process is stopped before the repair receives its workspace, without business Runner cleanup', async () => {
  const h = await fixture();
  const child = spawn(process.execPath, ['-e', 'require("node:fs").writeFileSync("writer.txt","started");setInterval(()=>require("node:fs").writeFileSync("writer.txt",String(Date.now())),30)'],
    { cwd: h.workspace, stdio: 'ignore', detached: process.platform !== 'win32' });
  const closed = new Promise<void>((resolve, reject) => { child.once('close', () => resolve()); child.once('error', reject); });
  const identity = await waitForProcessIdentity(child.pid!);
  assert.ok(identity);
  attachExecutionProcessInDb(h.db, h.allocationId, child.pid!, identity.startMarker, process.platform === 'win32' ? undefined : child.pid);
  try {
    const result = await acquireRepairTakeover(h);
    assert.equal(result.phase, 'owned');
    assert.equal(result.workspaceRoot, h.workspace);
    await closed;
    assert.throws(() => process.kill(child.pid!, 0));
    assert.equal((h.db.prepare('SELECT status FROM execution_processes WHERE allocation_id = ?').get(h.allocationId) as { status: string }).status, 'exited');
  } finally {
    if (process.platform !== 'win32') await terminateProcessGroup(child.pid!, 1000, identity.startMarker);
    else await terminateProcessTree(child.pid!, 1000, identity.startMarker);
    h.store.close();
  }
});
