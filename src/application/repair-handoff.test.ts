import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { databaseConnection } from '../infrastructure/database';
import { AdminManagementStore } from '../infrastructure/admin-management-store';
import { createTaskInDb, createTaskSchema } from './tasks';
import { createProject } from './projects';
import { beginTestExecutionAttempt } from '../test/execution-fixtures';
import { inspectTaskDispatchEnvelope } from '../test/dispatch-inspection-fixtures';
import { openInterventionInDb } from './interventions';
import { acknowledgeRepairObservationInDb } from './repair-observation-outbox';
import { acquireResourceClaimInDb } from './resource-claims';
import { prepareExecutionProcessInDb, finishExecutionProcessInDb } from './execution-processes';
import { createAdminManagedActions } from './admin-managed-actions';
import { acquireRepairTakeover } from './repair-takeover';
import { executeIndependentRepairVerification } from './independent-repair-verification';
import { handoffAdminRepair } from './admin-handoff';
import { handoffVerifiedRepair, observeRepairHandoffProgressInDb } from './repair-handoff';
import { runAgentCommand, issueAgentCommandToken, readAgentCommandSubmission } from './agent-command-drafts';
import { applyAgentResult } from './agent-results';
import { completeExecution } from './executions';
import { createAdminController } from './admin-controller';
import { createAdminHandoffs } from './admin-handoff';
import { buildAdminPrompt } from './admin-prompt';
import { assertIndependentVerificationWorkspaceInDb } from './independent-verification-workspace';
import { observeRepairBusinessReadinessInDb, holdStalledRepairBusinessInDb } from './repair-business-watch';
import { pendingRepairObservationsInDb } from './repair-observation-outbox';

async function fixture(clock: () => number = Date.now, takeoverRevision = 1, multipleRevisions = false, replaceItem = false) {
  const db = await databaseConnection();
  const workspace = join(process.env.LOOP_WORKSPACE_ROOT_OVERRIDE!, randomUUID());
  mkdirSync(workspace, { recursive: true });
  const versionFile = join(workspace, 'version.txt');
  writeFileSync(versionFile, 'fixed-v2');
  const projectId = await createProject({ name: 'Verified repair handoff', workspaceRoot: workspace });
  const taskId = `REQ-${randomUUID()}`;
  createTaskInDb(db, createTaskSchema.parse({ title: 'Original direct requirement', description: 'Produce the original result', itemType: 'direct', projectId }), taskId);
  const delegation = (await inspectTaskDispatchEnvelope(taskId))[0];
  const original = await beginTestExecutionAttempt({ runId: `RUN-${randomUUID()}`, delegation, prompt: 'Original work' });
  const executionId = original.attempt.execution_id;
  acquireResourceClaimInDb(db, { resourceKey: 'code:workspace', taskId, lane: 'control', executionId });
  const allocationId = prepareExecutionProcessInDb(db, executionId, process.pid, 7);
  db.prepare("UPDATE execution_attempts SET status = 'retryable_failed',last_error = 'Original implementation missing',dispatch_retry_consumed = 1 WHERE execution_id = ?").run(executionId);
  const fault = openInterventionInDb(db, { taskId, itemId: original.attempt.work_item_id!, sourceExecutionId: executionId,
    requestedBy: 'direct-agent', authority: 'arbitration', dedupeKey: `fault:${randomUUID()}`, summary: 'Original implementation missing',
    context: { failureSignature: 'original-missing', acceptance: 'Original result must be produced' } });
  const store = new AdminManagementStore(join(process.env.LOOP_DATA_ROOT!, randomUUID(), 'management.db'), clock);
  const raw = db.prepare('SELECT observation_json FROM repair_observation_outbox WHERE intervention_id = ?').get(fault.intervention_id) as { observation_json: string };
  const repairCase = store.observe(JSON.parse(raw.observation_json));
  acknowledgeRepairObservationInDb(db, `intervention:${fault.intervention_id}`, repairCase.caseId);
  let currentItemId = original.attempt.work_item_id!;
  if (replaceItem) {
    currentItemId = randomUUID();
    db.prepare(`INSERT INTO workflow_items(item_id,task_id,work_key,revision,kind,title,story_index,agent,pipeline,lane,status,origin,context_json)
      SELECT ?,task_id,work_key,revision+1,kind,title,story_index,agent,pipeline,lane,'superseded',origin,context_json
      FROM workflow_items WHERE item_id=?`).run(currentItemId, original.attempt.work_item_id);
    db.prepare("UPDATE workflow_items SET status='superseded',superseded_by_item_id=? WHERE item_id=?")
      .run(currentItemId, original.attempt.work_item_id);
    db.prepare("UPDATE workflow_items SET status='waiting' WHERE item_id=?").run(currentItemId);
    db.prepare('UPDATE interventions SET item_id=? WHERE intervention_id=?').run(currentItemId, fault.intervention_id);
  }
  if (takeoverRevision !== 1) db.prepare('UPDATE workflow_items SET revision=?,dispatch_epoch=dispatch_epoch+1 WHERE item_id=?')
    .run(takeoverRevision, original.attempt.work_item_id);
  const originalObservationIds = [`intervention:${fault.intervention_id}`];
  if (multipleRevisions) {
    const nextFault = openInterventionInDb(db, { taskId, itemId: original.attempt.work_item_id!, sourceExecutionId: executionId,
      requestedBy: 'direct-agent', authority: 'arbitration', dedupeKey: `next-revision:${randomUUID()}`, summary: 'Same original behavior still missing in the new revision',
      context: { failureSignature: 'original-missing', acceptance: 'Original result must be produced' } });
    const nextRaw = db.prepare('SELECT observation_json FROM repair_observation_outbox WHERE intervention_id=?').get(nextFault.intervention_id) as { observation_json: string };
    assert.equal(store.observe(JSON.parse(nextRaw.observation_json)).caseId, repairCase.caseId);
    acknowledgeRepairObservationInDb(db, `intervention:${nextFault.intervention_id}`, repairCase.caseId);
    originalObservationIds.push(`intervention:${nextFault.intervention_id}`);
  }
  store.setIntent('running', randomUUID());
  const authority = store.acquireSupervisor('handoff-host')!;
  const repair = store.claimNext(authority)!;
  const credential = store.issueCommandCredential(repair);
  store.commandStatus(credential);
  store.commandRequestAction(credential, 'workspace', { kind: 'workspace-takeover', itemId: original.attempt.work_item_id!, itemRevision: takeoverRevision, reason: 'Actually repair original feature' });
  const manage = createAdminManagedActions({ store, takeover: (target, assertCurrent, previousOwnerStopped) => acquireRepairTakeover({
    db, target, assertCurrent, previousOwnerStopped, stopExecutions: async () => { finishExecutionProcessInDb(db, allocationId, true); return []; },
  }) });
  await manage(authority);
  store.commandRecordEvidence(credential, 'actual-change', 'change', { versionFile });
  store.commandSubmit(credential, { outcome: 'verification-requested', summary: 'repaired original behavior', repairVersion: 'fixed-v2',
    originalObservationIds, repairEvidenceKeys: ['actual-change'],
    verification: { reproductionCommand: 'host to confirm', versionCheckCommand: 'host to confirm',
      acceptanceChecks: [{ targetRef: 'original-result', command: 'host to confirm', expected: 'original result' }] } });
  store.finishAttempt(repair, { outcome: 'verification-requested', exitConfirmed: true, reason: 'repaired original behavior' });
  const verification = store.claimVerification(authority)!;
  const verificationInput = store.independentVerificationInput(verification);
  const plan = { sourceRepairAttemptId: repair.attempt.attemptId, expectedVersion: 'fixed-v2',
    originalObservationIds, versionCommand: 'read-actual-version',
    reproduction: { targetRef: 'original-failure', command: 'original-reproduction' },
    acceptanceChecks: [{ targetRef: 'original-result', command: 'original-acceptance' }] };
  store.recordVerificationPlan(verification, plan);
  const receipt = await executeIndependentRepairVerification(plan, { signal: new AbortController().signal,
    run: async command => ({ exitCode: 0, stdout: command === plan.versionCommand ? readFileSync(versionFile, 'utf8') : '', stderr: '', exitConfirmed: true }),
    persist: async (key, evidence) => { store.recordEvidence(verification, key, key === 'verification-plan' ? 'verification-plan' : 'verification-check', evidence); } });
  store.recordVerificationReceipt(verification, receipt);
  store.finishVerification(verification, true);
  const handoff = (readVersion = async () => readFileSync(versionFile, 'utf8')) => handoffAdminRepair({ store, authority, caseId: repairCase.caseId,
    handoff: (target, assertCurrent) => handoffVerifiedRepair({ db, target, assertCurrent, readVersion }) });
  return { db, store, authority, repairCase, taskId, projectId, workspace, versionFile, fault, executionId, handoff, verificationInput,
    itemId: currentItemId, originalItemId: original.attempt.work_item_id!, allocationId };
}

async function completeOrdinaryWork(h: Awaited<ReturnType<typeof fixture>>) {
  const delegation = (await inspectTaskDispatchEnvelope(h.taskId))[0];
  assert.ok(delegation);
  const runId = `RUN-${randomUUID()}`;
  const started = await beginTestExecutionAttempt({ runId, delegation, prompt: 'Continue original requirement after verified repair' });
  const executionId = started.attempt.execution_id;
  const token = (await issueAgentCommandToken(executionId))!;
  await runAgentCommand({ executionId, token, args: ['direct', 'run'] });
  await runAgentCommand({ executionId, token, args: ['direct', 'submit', '--summary', 'Original requirement completed', '--result', '# Original result\n\nVerified behavior restored.'] });
  const submission = (await readAgentCommandSubmission(executionId))!;
  assert.equal(await applyAgentResult(runId, delegation, submission, { executionId }), 'advanced');
  await completeExecution(executionId);
  return executionId;
}

test('current takeover anchor verifies and hands back a new revision while preserving old execution failure and original acceptance', async () => {
  const h = await fixture(Date.now, 2, true);
  try {
    const original = JSON.stringify(h.store.observations(h.repairCase.caseId));
    const facts = h.verificationInput.originalObservations[0].evidence.item as { revision: number; dispatch_epoch: number };
    assert.equal(facts.revision, 1);
    assert.equal(h.verificationInput.originalObservations.length, 2);
    assert.ok(h.verificationInput.kind !== 'runtime');
    assert.equal((h.verificationInput.originalObservations[1].evidence.item as { revision: number }).revision, 2);
    assert.equal(h.verificationInput.workspaceBinding.itemRevision, 2);
    assert.equal(h.verificationInput.workspaceBinding.itemEpoch, facts.dispatch_epoch + 1);
    const receipt = await h.handoff();
    assert.equal(receipt.target.itemRevision, 2);
    assert.equal(receipt.target.itemEpoch, h.verificationInput.workspaceBinding.itemEpoch);
    assert.equal(receipt.dispatchEpoch, receipt.target.itemEpoch + 1);
    assert.equal(JSON.stringify(h.store.observations(h.repairCase.caseId)), original);
    const executionId = await completeOrdinaryWork(h);
    const progress = observeRepairHandoffProgressInDb(h.db, receipt)!;
    assert.equal(progress.executionId, executionId);
    assert.equal(progress.itemRevision, 2);
    h.store.recordBusinessProgress(h.authority, h.repairCase.caseId, progress);
    assert.equal(h.store.closeObservedCase(h.authority, h.repairCase.caseId, () => observeRepairHandoffProgressInDb(h.db, receipt)), true);
    assert.equal(JSON.stringify(h.store.observations(h.repairCase.caseId)), original);
  } finally { h.store.close(); }
});

test('real rewind binds immutable old observations to the confirmed successor for verification and handoff', async () => {
  const h = await fixture(Date.now, 1, false, true);
  try {
    assert.notEqual(h.originalItemId, h.itemId);
    assert.ok(h.verificationInput.kind !== 'runtime');
    assert.equal(h.verificationInput.workspaceBinding.itemId, h.itemId);
    assert.equal(h.verificationInput.workspaceBinding.itemRevision, 2);
    assert.equal((h.verificationInput.originalObservations[0].evidence.item as { item_id: string }).item_id, h.originalItemId);
    assert.doesNotThrow(() => assertIndependentVerificationWorkspaceInDb(h.db, h.repairCase.caseId, h.verificationInput));
    const receipt = await h.handoff();
    assert.equal(receipt.target.itemId, h.itemId);
    assert.equal(receipt.target.itemRevision, 2);
    assert.deepEqual(h.store.repairWorkspaceAnchor(h.store.attempts(h.repairCase.caseId)[0].attemptId).predecessors,
      [{ itemId: h.originalItemId, revision: 1 }]);
  } finally { h.store.close(); }
});

test('handoff readiness uses real capacity and resource gates and does not mistake pause or active execution for idle dispatch', async () => {
  const h = await fixture();
  try {
    const receipt = await h.handoff();
    h.db.prepare('UPDATE tasks SET is_paused=1 WHERE task_id<>?').run(h.taskId);
    assert.equal(observeRepairBusinessReadinessInDb(h.db, receipt), 'runnable');
    h.db.prepare('UPDATE tasks SET is_paused=1 WHERE task_id=?').run(h.taskId);
    assert.equal(observeRepairBusinessReadinessInDb(h.db, receipt), 'paused');
    h.db.prepare('UPDATE tasks SET is_paused=0 WHERE task_id=?').run(h.taskId);
    assert.equal(observeRepairBusinessReadinessInDb(h.db, { ...receipt, dispatchEpoch: receipt.dispatchEpoch + 1 }), 'source-changed');
    const otherId = `REQ-${randomUUID()}`;
    createTaskInDb(h.db, createTaskSchema.parse({ title: 'Other workspace owner', itemType: 'direct', projectId: h.projectId }), otherId);
    acquireResourceClaimInDb(h.db, { resourceKey: 'code:workspace', taskId: otherId, lane: 'control' });
    assert.equal(observeRepairBusinessReadinessInDb(h.db, receipt), 'waiting');
    h.db.prepare('DELETE FROM resource_claims WHERE owner_task_id=?').run(otherId);
    h.db.prepare('UPDATE tasks SET is_paused=1 WHERE task_id=?').run(otherId);
    const delegation = (await inspectTaskDispatchEnvelope(h.taskId))[0];
    assert.ok(delegation);
    const executing = await beginTestExecutionAttempt({ runId: `RUN-${randomUUID()}`, delegation, prompt: 'Long legitimate command still running' });
    assert.equal(observeRepairBusinessReadinessInDb(h.db, receipt), 'executing');
    h.db.prepare("UPDATE execution_attempts SET status='cancelled' WHERE execution_id=?").run(executing.attempt.execution_id);
  } finally { h.store.close(); }
});

test('ordinary global slot exhaustion is waiting, not twenty-minute dispatch failure', async () => {
  const h = await fixture();
  const previous = h.db.prepare("SELECT setting_value FROM project_settings WHERE setting_key='agent_concurrency'").get() as { setting_value: string };
  let otherExecutionId: string | undefined;
  try {
    const receipt = await h.handoff(); h.db.prepare('UPDATE tasks SET is_paused=1 WHERE task_id<>?').run(h.taskId);
    const otherId = `REQ-${randomUUID()}`;
    createTaskInDb(h.db, createTaskSchema.parse({ title: 'Ordinary nonlocking Agent using the only slot', itemType: 'business-analysis', projectId: h.projectId }), otherId);
    const delegation = (await inspectTaskDispatchEnvelope(otherId))[0];
    assert.ok(delegation);
    otherExecutionId = (await beginTestExecutionAttempt({ runId: `RUN-${randomUUID()}`, delegation, prompt: 'Legitimate active invocation' })).attempt.execution_id;
    h.db.prepare("UPDATE project_settings SET setting_value='1' WHERE setting_key='agent_concurrency'").run();
    assert.equal(observeRepairBusinessReadinessInDb(h.db, receipt), 'waiting');
    h.db.prepare("UPDATE execution_attempts SET status='cancelled' WHERE execution_id=?").run(otherExecutionId);
    h.db.prepare('UPDATE tasks SET is_paused=1 WHERE task_id=?').run(otherId);
    assert.equal(observeRepairBusinessReadinessInDb(h.db, receipt), 'runnable');
  } finally {
    if (otherExecutionId) h.db.prepare("UPDATE execution_attempts SET status='cancelled' WHERE execution_id=?").run(otherExecutionId);
    h.db.prepare("UPDATE project_settings SET setting_value=? WHERE setting_key='agent_concurrency'").run(previous.setting_value);
    h.store.close();
  }
});

test('eligible dispatch watch persists through host restart but excludes gaps, pauses and changed user intent', async () => {
  let now = Date.now();
  const h = await fixture(() => now);
  try {
    const receipt = await h.handoff();
    const sample = (readiness: string) => h.store.sampleHandoffReadiness(h.authority, h.repairCase.caseId, receipt.target.verificationAttemptId, readiness);
    const tick = () => { assert.equal(h.store.renewSupervisor(h.authority, 120000), true); now += 60000; };
    assert.equal(sample('runnable'), false);
    for (let index = 0; index < 10; index++) { tick(); assert.equal(sample('runnable'), false); }
    const filename = h.store.filename; h.store.close();
    h.store = new AdminManagementStore(filename, () => now);
    h.authority = h.store.acquireSupervisor('handoff-host')!;
    for (let index = 0; index < 9; index++) { tick(); assert.equal(sample('runnable'), false); }
    tick(); assert.equal(sample('runnable'), true);
    assert.equal(sample('paused'), false);
    tick(); assert.equal(sample('runnable'), false);
    // A full hour without a live host/sample cannot earn sixty minutes.
    assert.equal(h.store.renewSupervisor(h.authority, 7200000), true); now += 3600000;
    assert.equal(sample('runnable'), false);
    for (let index = 0; index < 19; index++) { tick(); assert.equal(sample('runnable'), false); }
    h.store.setIntent('stopped', 'watch-user-stop');
    assert.throws(() => sample('runnable'), /运行意图/);
    h.store.setIntent('running', 'watch-user-resume');
    h.authority = h.store.acquireSupervisor('handoff-host')!;
    assert.equal(sample('runnable'), false, 'stop/resume does not charge user interruption as idle time');
    tick(); assert.equal(sample('waiting'), false);
    tick(); assert.equal(sample('executing'), false);
    assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'observing');
    assert.equal(h.store.followupEvidence(h.repairCase.caseId).length, 1, 'readiness is not proof of success');
  } finally { h.store.close(); }
});

test('twenty minutes of genuinely eligible handback dispatch opens one held outbox and reopens the original automatic Case', async () => {
  let now = Date.now();
  const h = await fixture(() => now);
  try {
    h.db.prepare('UPDATE tasks SET is_paused=1 WHERE task_id<>?').run(h.taskId);
    const originalObservations = JSON.stringify(h.store.observations(h.repairCase.caseId));
    const originalAttempts = JSON.stringify(h.store.attempts(h.repairCase.caseId));
    const manage = createAdminHandoffs({ store: h.store,
      handoff: (target, assertCurrent) => handoffVerifiedRepair({ db: h.db, target, assertCurrent, readVersion: async () => 'fixed-v2' }),
      observeProgress: async receipt => ({ progress: observeRepairHandoffProgressInDb(h.db, receipt), readCurrent: () => null,
        readiness: observeRepairBusinessReadinessInDb(h.db, receipt) }),
      holdStalled: async (receipt, fingerprint, assertCurrent) => {
        const observation = holdStalledRepairBusinessInDb(h.db, receipt, fingerprint, assertCurrent);
        return observation && { observation, acknowledge: async () => acknowledgeRepairObservationInDb(h.db, observation.observationId, receipt.target.caseId) };
      }, onError: error => { throw error; },
    });
    await manage(h.authority);
    for (let index = 0; index < 20; index++) {
      h.store.renewSupervisor(h.authority, 120000); now += 60000; await manage(h.authority);
    }
    assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'queued');
    assert.equal((h.db.prepare('SELECT status FROM workflow_items WHERE item_id=?').get(h.itemId) as { status: string }).status, 'waiting');
    const held = h.db.prepare("SELECT * FROM interventions WHERE task_id=? AND dedupe_key LIKE '%business-stalled'").all(h.taskId) as { intervention_id: string; repair_case_id: string; source_kind: string; status: string; context_json: string }[];
    assert.equal(held.length, 1);
    assert.equal(held[0].repair_case_id, h.repairCase.caseId);
    assert.equal(held[0].source_kind, 'agent-fault');
    assert.equal(held[0].status, 'pending', 'no exhausted-attempt human fallback');
    const source = h.db.prepare('SELECT observation_json FROM repair_observation_outbox WHERE intervention_id=?').get(held[0].intervention_id) as { observation_json: string };
    const observation = JSON.parse(source.observation_json);
    assert.equal(observation.evidence.item.dispatch_epoch, JSON.parse(held[0].context_json).handoff.dispatchEpoch);
    assert.equal(JSON.stringify(h.store.attempts(h.repairCase.caseId)), originalAttempts);
    assert.equal(JSON.stringify(h.store.observations(h.repairCase.caseId).slice(0, 1)), originalObservations);
    await manage(h.authority);
    assert.equal((h.db.prepare("SELECT count(*) AS n FROM interventions WHERE task_id=? AND dedupe_key LIKE '%business-stalled'").get(h.taskId) as { n: number }).n, 1);
    assert.equal(h.store.claimNext(h.authority)?.repairCase.caseId, h.repairCase.caseId);
  } finally { h.store.close(); }
});

test('persisted dispatch watch discards accrued time after a monitoring gap or clock rollback', async () => {
  let now = Date.now();
  const h = await fixture(() => now);
  try {
    const receipt = await h.handoff();
    const sample = () => h.store.sampleHandoffReadiness(h.authority, h.repairCase.caseId, receipt.target.verificationAttemptId, 'runnable');
    const tick = () => { assert.equal(h.store.renewSupervisor(h.authority, 7200000), true); now += 60000; };
    assert.equal(sample(), false);
    for (let index = 0; index < 19; index++) { tick(); assert.equal(sample(), false); }
    const filename = h.store.filename; h.store.close();
    now += 120001;
    h.store = new AdminManagementStore(filename, () => now);
    h.authority = h.store.acquireSupervisor('handoff-host')!;
    assert.equal(sample(), false);
    tick(); assert.equal(sample(), false, 'nineteen old minutes cannot combine with a post-outage minute');
    for (let index = 0; index < 19; index++) { tick(); assert.equal(sample(), index === 18); }
    const original = JSON.parse((h.store.observations(h.repairCase.caseId) as { observation_json: string }[])[0].observation_json);
    const expiredObservation = { ...original, observationId: randomUUID(), repairCaseId: h.repairCase.caseId };
    const lastSampleAt = now;
    h.store.renewSupervisor(h.authority, 7200000); now += 120001;
    assert.throws(() => h.store.recordHandoffStallObservation(h.authority, h.repairCase.caseId,
      receipt.target.verificationAttemptId, expiredObservation), /新鲜持续可派发/);
    now = lastSampleAt;
    now -= 1;
    assert.throws(() => h.store.assertHandoffStallCurrent(h.authority, h.repairCase.caseId, receipt.target.verificationAttemptId), /新鲜持续可派发/);
    assert.equal(sample(), false);
    tick(); assert.equal(sample(), false, 'clock rollback starts a new observed interval');
    assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'observing');
    assert.equal(h.store.observations(h.repairCase.caseId).length, 1);
  } finally { h.store.close(); }
});

test('late stall capability must recheck fresh monitoring authority before holding business dispatch', async () => {
  let now = Date.now();
  const h = await fixture(() => now);
  try {
    const errors: unknown[] = [];
    let holdCalls = 0;
    h.db.prepare('UPDATE tasks SET is_paused=1 WHERE task_id<>?').run(h.taskId);
    const manage = createAdminHandoffs({ store: h.store,
      handoff: (target, assertCurrent) => handoffVerifiedRepair({ db: h.db, target, assertCurrent, readVersion: async () => 'fixed-v2' }),
      observeProgress: async receipt => ({ progress: null, readCurrent: () => null,
        readiness: observeRepairBusinessReadinessInDb(h.db, receipt) }),
      holdStalled: async (receipt, fingerprint, assertCurrent) => {
        holdCalls++;
        assertCurrent();
        h.store.renewSupervisor(h.authority, 7200000); now += 120001;
        const observation = holdStalledRepairBusinessInDb(h.db, receipt, fingerprint, assertCurrent);
        return observation && { observation, acknowledge: async () => acknowledgeRepairObservationInDb(h.db, observation.observationId, receipt.target.caseId) };
      }, onError: error => { errors.push(error); },
    });
    await manage(h.authority);
    for (let index = 0; index < 20; index++) {
      h.store.renewSupervisor(h.authority, 120000); now += 60000; await manage(h.authority);
    }
    assert.equal(holdCalls, 1);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]), /新鲜持续可派发/);
    assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'observing');
    assert.equal(h.store.observations(h.repairCase.caseId).length, 1);
    assert.equal((h.db.prepare("SELECT count(*) AS n FROM interventions WHERE task_id=? AND dedupe_key LIKE '%business-stalled'").get(h.taskId) as { n: number }).n, 0);
    await manage(h.authority);
    assert.equal(holdCalls, 1, 'a stale interval must be resampled, not immediately retried as a stall');
  } finally { h.store.close(); }
});

test('business wait commits with an immutable outbox before management observation, and replays after interruption', async () => {
  const h = await fixture();
  try {
    const receipt = await h.handoff(); h.db.prepare('UPDATE tasks SET is_paused=1 WHERE task_id<>?').run(h.taskId);
    const assertCurrent = () => { h.store.verifiedContext(h.authority, h.repairCase.caseId); };
    const observation = holdStalledRepairBusinessInDb(h.db, receipt, h.repairCase.fingerprint, assertCurrent)!;
    assert.ok(observation);
    assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'observing', 'simulate crash before management observe');
    assert.ok(pendingRepairObservationsInDb(h.db).some(row => JSON.parse(row.observation_json).observationId === observation.observationId));
    assert.deepEqual(holdStalledRepairBusinessInDb(h.db, receipt, h.repairCase.fingerprint, assertCurrent), observation);
    assert.equal(h.store.observe(observation).caseId, h.repairCase.caseId);
    acknowledgeRepairObservationInDb(h.db, observation.observationId, h.repairCase.caseId);
    assert.equal(h.store.observe(observation).caseId, h.repairCase.caseId);
    assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'queued');
  } finally { h.store.close(); }
});

test('management stall observation cannot bypass the persistent watch or reuse old original facts', async () => {
  let now = Date.now();
  const h = await fixture(() => now);
  try {
    const receipt = await h.handoff();
    const rows = h.store.observations(h.repairCase.caseId) as { observation_json: string }[];
    const original = JSON.parse(rows[0].observation_json);
    const record = () => h.store.recordHandoffStallObservation(h.authority, h.repairCase.caseId, receipt.target.verificationAttemptId, original);
    assert.throws(record, /持续可派发观察/);
    h.store.sampleHandoffReadiness(h.authority, h.repairCase.caseId, receipt.target.verificationAttemptId, 'runnable');
    for (let index = 0; index < 20; index++) {
      h.store.renewSupervisor(h.authority, 120000); now += 60000;
      h.store.sampleHandoffReadiness(h.authority, h.repairCase.caseId, receipt.target.verificationAttemptId, 'runnable');
    }
    assert.throws(record, /旧故障/);
    assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'observing');
    assert.equal(h.store.observations(h.repairCase.caseId).length, 1);
  } finally { h.store.close(); }
});

test('business stall hold revalidates late pause and rolls back atomically if user stop arrives during the hold', async () => {
  const h = await fixture();
  try {
    const receipt = await h.handoff(); h.db.prepare('UPDATE tasks SET is_paused=1 WHERE task_id<>?').run(h.taskId);
    h.db.prepare('UPDATE tasks SET is_paused=1 WHERE task_id=?').run(h.taskId);
    assert.equal(holdStalledRepairBusinessInDb(h.db, receipt, h.repairCase.fingerprint, () => h.store.verifiedContext(h.authority, h.repairCase.caseId)), null);
    h.db.prepare('UPDATE tasks SET is_paused=0 WHERE task_id=?').run(h.taskId);
    let checks = 0;
    assert.throws(() => holdStalledRepairBusinessInDb(h.db, receipt, h.repairCase.fingerprint, () => {
      if (++checks === 2) h.store.setIntent('stopped', 'late-watch-stop');
      h.store.verifiedContext(h.authority, h.repairCase.caseId);
    }), /运行意图/);
    assert.equal((h.db.prepare("SELECT count(*) AS n FROM interventions WHERE task_id=? AND dedupe_key LIKE '%business-stalled'").get(h.taskId) as { n: number }).n, 0);
    assert.equal((h.db.prepare('SELECT status FROM workflow_items WHERE item_id=?').get(h.itemId) as { status: string }).status, 'ready');
  } finally { h.store.close(); }
});

test('independent verification reads actual business ownership, pause, revision, epoch and path without completing or resuming work', async () => {
  const h = await fixture();
  try {
    const source = h.store.attempts(h.repairCase.caseId)[0];
    const actualWorkspace = (h.db.prepare('SELECT workspace_root FROM projects WHERE project_id = ?').get(h.projectId) as { workspace_root: string }).workspace_root;
    const epoch = (h.db.prepare('SELECT dispatch_epoch FROM workflow_items WHERE item_id = ?').get(h.itemId) as { dispatch_epoch: number }).dispatch_epoch;
    const input = { sourceRepairAttemptId: source.attemptId, workspaceRoot: actualWorkspace, expectedVersion: 'fixed-v2', originalObservations: [],
      workspaceBinding: { taskId: h.taskId, itemId: h.itemId, itemRevision: 1, itemEpoch: epoch,
        generation: source.generation, ownerId: source.ownerId, supervisionToken: source.supervisionToken } };
    const check = () => assertIndependentVerificationWorkspaceInDb(h.db, h.repairCase.caseId, input);
    assert.doesNotThrow(check);
    h.db.prepare('UPDATE tasks SET is_paused = 1 WHERE task_id = ?').run(h.taskId);
    assert.throws(check, /暂停/);
    h.db.prepare('UPDATE tasks SET is_paused = 0 WHERE task_id = ?').run(h.taskId);
    h.db.prepare('UPDATE workflow_items SET dispatch_epoch = dispatch_epoch + 1 WHERE item_id = ?').run(h.itemId);
    assert.throws(check, /版本/);
    h.db.prepare('UPDATE workflow_items SET dispatch_epoch = ? WHERE item_id = ?').run(epoch, h.itemId);
    h.db.prepare('UPDATE workflow_items SET revision = 2 WHERE item_id = ?').run(h.itemId);
    assert.throws(check, /版本/);
    h.db.prepare('UPDATE workflow_items SET revision = 1 WHERE item_id = ?').run(h.itemId);
    assert.throws(() => assertIndependentVerificationWorkspaceInDb(h.db, h.repairCase.caseId, { ...input, workspaceRoot: `${h.workspace}/wrong-path` }), /路径/);
    h.db.prepare('UPDATE repair_resource_claims SET generation = generation + 1 WHERE case_id = ?').run(h.repairCase.caseId);
    assert.throws(check, /所有权/);
    assert.equal((h.db.prepare('SELECT status FROM workflow_items WHERE item_id = ?').get(h.itemId) as { status: string }).status, 'waiting');
    assert.equal(h.store.followupEvidence(h.repairCase.caseId).length, 0);
    assert.equal(h.store.observations(h.repairCase.caseId).length, 1);
  } finally { h.store.close(); }
});

test('verified handoff resumes normal work atomically, preserves failures and budgets, and ordinary commands complete it', async () => {
  const h = await fixture();
  try {
    assert.equal((await inspectTaskDispatchEnvelope(h.taskId)).length, 0);
    const receipt = await h.handoff();
    assert.equal(receipt.dispatchEpoch, 2);
    assert.equal((h.db.prepare('SELECT status FROM workflow_items WHERE item_id = ?').get(h.itemId) as { status: string }).status, 'ready');
    assert.equal(h.db.prepare('SELECT 1 FROM repair_resource_claims WHERE case_id = ?').get(h.repairCase.caseId), undefined);
    assert.equal((h.db.prepare('SELECT status FROM interventions WHERE intervention_id = ?').get(h.fault.intervention_id) as { status: string }).status, 'resolved');
    const original = h.db.prepare('SELECT status,last_error,dispatch_retry_consumed FROM execution_attempts WHERE execution_id = ?').get(h.executionId) as { status: string; last_error: string; dispatch_retry_consumed: number };
    assert.equal(original.status, 'retryable_failed');
    assert.equal(original.last_error, 'Original implementation missing');
    assert.equal(original.dispatch_retry_consumed, 1);
    assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'observing', 'handoff does not close or complete business');
    assert.equal(observeRepairHandoffProgressInDb(h.db, receipt), null, 'ready/resumed is not evidence of business completion');
    assert.deepEqual(await h.handoff(async () => { throw new Error('replay does not rerun checks after ordinary code advances'); }), receipt);
    assert.equal((h.db.prepare("SELECT count(*) AS n FROM task_events WHERE task_id = ? AND event_type = 'RepairHandedBack'").get(h.taskId) as { n: number }).n, 1);
    const next = (await inspectTaskDispatchEnvelope(h.taskId))[0];
    assert.ok(next);
    const runId = `RUN-${randomUUID()}`;
    const started = await beginTestExecutionAttempt({ runId, delegation: next, prompt: 'Resume ordinary original work' });
    const token = (await issueAgentCommandToken(started.attempt.execution_id))!;
    await runAgentCommand({ executionId: started.attempt.execution_id, token, args: ['direct', 'run'] });
    await runAgentCommand({ executionId: started.attempt.execution_id, token, args: ['direct', 'submit', '--summary', 'Original requirement completed', '--result', '# Original result\n\nVerified behavior restored.'] });
    const submitted = (await readAgentCommandSubmission(started.attempt.execution_id))!;
    assert.equal(await applyAgentResult(runId, next, submitted, { executionId: started.attempt.execution_id }), 'advanced');
    await completeExecution(started.attempt.execution_id);
    assert.equal((h.db.prepare('SELECT status,completion_authority FROM workflow_items WHERE item_id = ?').get(h.itemId) as { status: string }).status, 'completed');
    const progress = observeRepairHandoffProgressInDb(h.db, receipt)!;
    assert.ok(progress);
    assert.equal(progress.executionId, started.attempt.execution_id);
    assert.equal(progress.dispatchEpoch, receipt.dispatchEpoch);
    assert.notEqual(progress.executionId, h.executionId);
    assert.equal(observeRepairHandoffProgressInDb(h.db, { ...receipt, dispatchEpoch: receipt.dispatchEpoch + 1 }), null, 'another dispatch cycle cannot prove this repair progressed');
    assert.equal(observeRepairHandoffProgressInDb(h.db, { ...receipt, previousExecutionIds: [...receipt.previousExecutionIds, progress.executionId] }), null,
      'a previously completed execution is not new post-handoff progress');
    const lateAllocation = `ALLOC-${randomUUID()}`;
    h.db.prepare("INSERT INTO execution_processes(allocation_id,execution_id,run_id,task_id,owner_pid,supervision_token,status) VALUES(?,?,?,?,?,7,'running')")
      .run(lateAllocation, progress.executionId, runId, h.taskId, process.pid);
    assert.equal(observeRepairHandoffProgressInDb(h.db, receipt), null, 'applied results with an unconfirmed live process cannot prove settled advancement');
    finishExecutionProcessInDb(h.db, lateAllocation, true);
    assert.ok(observeRepairHandoffProgressInDb(h.db, receipt));
    assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'observing', 'still needs independently observed normal advancement before closure');
    assert.equal(h.store.recordBusinessProgress(h.authority, h.repairCase.caseId, progress), true);
    assert.equal(h.store.recordBusinessProgress(h.authority, h.repairCase.caseId, progress), false);
    assert.throws(() => h.store.recordBusinessProgress(h.authority, h.repairCase.caseId, { ...progress, resultId: 'rewrite-proof' }), /不能改写/);
    assert.equal(h.store.closeObservedCase(h.authority, h.repairCase.caseId, () => null), false, 'saved evidence alone cannot close without a current business read');
    h.store.releaseSupervisor(h.authority);
    const restored = new AdminManagementStore(h.store.filename);
    try {
      const restoredAuthority = restored.acquireSupervisor('restored-followup-host')!;
      assert.deepEqual(restored.handoffReceipt(receipt.target.verificationAttemptId), receipt);
      assert.equal(restored.followupEvidence(h.repairCase.caseId).length, 2, 'handoff and progress survive independent management restart');
      assert.equal(restored.closeObservedCase(restoredAuthority, h.repairCase.caseId, () => observeRepairHandoffProgressInDb(h.db, receipt)), true);
      assert.equal(restored.getCase(h.repairCase.caseId)?.status, 'closed');
      assert.equal(restored.closeObservedCase(restoredAuthority, h.repairCase.caseId, () => { throw new Error('already closed replay'); }), true);
      assert.equal(restored.getCase(h.repairCase.caseId)?.originalSummary, 'Original implementation missing');
      assert.equal((h.db.prepare('SELECT last_error FROM execution_attempts WHERE execution_id = ?').get(h.executionId) as { last_error: string }).last_error, 'Original implementation missing');
      assert.throws(() => h.store.closeObservedCase(h.authority, h.repairCase.caseId, () => progress), /监督权/);
    } finally { restored.close(); }
  } finally { h.store.close(); }
});

test('changed version or stop during handoff leaves resource fences and unresolved original fault intact', async () => {
  const h = await fixture();
  try {
    await assert.rejects(h.handoff(async () => 'old-v1'), /实际版本/);
    assert.ok(h.db.prepare('SELECT 1 FROM repair_resource_claims WHERE case_id = ?').get(h.repairCase.caseId));
    await assert.rejects(h.handoff(async () => { h.store.setIntent('stopped', randomUUID()); return 'fixed-v2'; }), /运行意图/);
    assert.equal((h.db.prepare('SELECT status FROM interventions WHERE intervention_id = ?').get(h.fault.intervention_id) as { status: string }).status, 'pending');
    assert.equal((h.db.prepare('SELECT status FROM workflow_items WHERE item_id = ?').get(h.itemId) as { status: string }).status, 'waiting');
  } finally { h.store.close(); }
});

test('genuine human inputs cannot be bypassed by verified handoff', async () => {
  const h = await fixture();
  try {
    const human = openInterventionInDb(h.db, { taskId: h.taskId, itemId: h.itemId, requestedBy: 'human', humanOnly: true,
      dedupeKey: `human:${randomUUID()}`, summary: 'User must choose original scope', context: {} });
    await assert.rejects(h.handoff(), /其他介入或人工输入/);
    assert.equal((h.db.prepare('SELECT status FROM interventions WHERE intervention_id = ?').get(human.intervention_id) as { status: string }).status, human.status);
    assert.ok(h.db.prepare('SELECT 1 FROM repair_resource_claims WHERE case_id = ?').get(h.repairCase.caseId));
  } finally { h.store.close(); }
});

test('unresolved upstream dependencies prevent handoff without resolving the original fault', async () => {
  const h = await fixture();
  try {
    const upstream = `WORK-${randomUUID()}`;
    h.db.prepare("INSERT INTO workflow_items(item_id,task_id,work_key,kind,title,status,origin) VALUES(?,?,'handoff:upstream','intent','Unresolved original prerequisite','waiting','native')").run(upstream, h.taskId);
    h.db.prepare('INSERT INTO workflow_dependencies(item_id,depends_on_item_id) VALUES(?,?)').run(h.itemId, upstream);
    await assert.rejects(h.handoff(), /未完成依赖/);
    assert.equal((h.db.prepare('SELECT status FROM interventions WHERE intervention_id = ?').get(h.fault.intervention_id) as { status: string }).status, 'pending');
  } finally { h.store.close(); }
});

test('previous physical cleanup targets remain fenced even if their ordinary resource barrier disappeared', async () => {
  const h = await fixture();
  try {
    h.db.prepare("UPDATE execution_processes SET status = 'terminating',exited_at = NULL WHERE allocation_id = ?").run(h.allocationId);
    assert.equal(h.db.prepare('SELECT 1 FROM execution_process_barriers WHERE allocation_id = ?').get(h.allocationId), undefined);
    await assert.rejects(h.handoff(), /原进程仍未退出/);
    assert.ok(h.db.prepare('SELECT 1 FROM repair_resource_claims WHERE case_id = ?').get(h.repairCase.caseId));
  } finally { finishExecutionProcessInDb(h.db, h.allocationId, true); h.store.close(); }
});

test('stop arriving during business handoff rolls back intervention resolution, resume and resource release together', async () => {
  const h = await fixture();
  const trigger = `handoff_stop_${randomUUID().replaceAll('-', '')}`;
  h.db.function(trigger, () => { h.store.setIntent('stopped', randomUUID()); return 1; });
  h.db.exec(`CREATE TRIGGER ${trigger} AFTER UPDATE OF status ON interventions WHEN NEW.intervention_id = '${h.fault.intervention_id}'
    AND NEW.status = 'resolved' BEGIN SELECT ${trigger}(); END`);
  try {
    await assert.rejects(h.handoff(), /运行意图/);
    assert.equal((h.db.prepare('SELECT status FROM interventions WHERE intervention_id = ?').get(h.fault.intervention_id) as { status: string }).status, 'pending');
    assert.equal((h.db.prepare('SELECT status,dispatch_epoch FROM workflow_items WHERE item_id = ?').get(h.itemId) as { status: string }).status, 'waiting');
    assert.ok(h.db.prepare('SELECT 1 FROM repair_resource_claims WHERE case_id = ?').get(h.repairCase.caseId));
    assert.equal(h.db.prepare("SELECT 1 FROM task_events WHERE task_id = ? AND event_type = 'RepairHandedBack'").get(h.taskId), undefined);
    assert.equal(h.store.control().desired_intent, 'stopped');
  } finally { h.db.exec(`DROP TRIGGER ${trigger}`); h.store.close(); }
});

test('independent Controller followup invokes trusted handback without ordinary Agent dispatch or direct completion', async () => {
  const h = await fixture();
  let launches = 0;
  const controller = createAdminController({ store: h.store, ownerId: 'handoff-host', confirmStopped: async () => true,
    launch: async () => { launches++; throw new Error('verified handback must not rerun an Agent'); },
    manageFollowups: createAdminHandoffs({ store: h.store, handoff: (target, assertCurrent) => handoffVerifiedRepair({ db: h.db,
      target, assertCurrent, readVersion: async () => readFileSync(h.versionFile, 'utf8') }) }),
  });
  try {
    assert.equal(await controller.reconcile(), 'idle');
    assert.equal(launches, 0);
    assert.equal((h.db.prepare('SELECT status FROM workflow_items WHERE item_id = ?').get(h.itemId) as { status: string }).status, 'ready');
    assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'observing');
    assert.equal(await controller.reconcile(), 'idle', 'repeat followup only replays existing handback');
    assert.equal((h.db.prepare("SELECT count(*) AS n FROM task_events WHERE task_id = ? AND event_type = 'RepairHandedBack'").get(h.taskId) as { n: number }).n, 1);
  } finally { await controller.shutdown(); h.store.close(); }
});

test('management closure requires a source-bound handoff and fresh ordinary completion, not fabricated cached progress', async () => {
  const h = await fixture();
  try {
    const receipt = await h.handoff();
    const proposed = { executionId: 'new-but-unproved-execution', resultId: 'unproved-result', completionEventId: 'unproved-event',
      itemId: h.itemId, taskId: h.taskId, itemRevision: 1, dispatchEpoch: receipt.dispatchEpoch };
    assert.throws(() => h.store.recordHandoffReceipt(h.authority, h.repairCase.caseId, { ...receipt, target: { ...receipt.target, itemId: 'foreign-item' } }), /可信业务来源/);
    assert.throws(() => h.store.recordHandoffReceipt(h.authority, h.repairCase.caseId, { ...receipt, target: { ...receipt.target, repairOwnerId: 'wrong-owner' } }), /所有权/);
    assert.throws(() => h.store.recordBusinessProgress(h.authority, h.repairCase.caseId, { ...proposed, dispatchEpoch: receipt.dispatchEpoch + 1 }), /新业务执行/);
    assert.throws(() => h.store.recordBusinessProgress(h.authority, h.repairCase.caseId, { ...proposed, executionId: h.executionId }), /新业务执行/);
    h.store.recordBusinessProgress(h.authority, h.repairCase.caseId, proposed);
    assert.equal(h.store.closeObservedCase(h.authority, h.repairCase.caseId, () => observeRepairHandoffProgressInDb(h.db, receipt)), false);
    assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'observing');
    h.store.setIntent('stopped', randomUUID());
    assert.throws(() => h.store.closeObservedCase(h.authority, h.repairCase.caseId, () => proposed), /运行意图/);
    assert.equal(h.store.followupEvidence(h.repairCase.caseId).length, 2);
  } finally { h.store.close(); }
});

test('changing the original dispatch cycle prevents handoff before any resource release or ordinary resume', async () => {
  const h = await fixture();
  try {
    h.db.prepare('UPDATE workflow_items SET dispatch_epoch = dispatch_epoch + 1 WHERE item_id = ?').run(h.itemId);
    await assert.rejects(h.handoff(), /来源已改变/);
    assert.ok(h.db.prepare('SELECT 1 FROM repair_resource_claims WHERE case_id = ?').get(h.repairCase.caseId));
    assert.equal(h.store.followupEvidence(h.repairCase.caseId).length, 0);
  } finally { h.store.close(); }
});

test('Controller closes verified repair only after fresh ordinary command-gated advancement', async () => {
  const h = await fixture();
  let launches = 0;
  const errors: unknown[] = [];
  const controller = createAdminController({ store: h.store, ownerId: 'handoff-host', confirmStopped: async () => true,
    launch: async () => { launches++; throw new Error('must not invoke repair for settled verification'); },
    manageFollowups: createAdminHandoffs({ store: h.store,
      handoff: (target, assertCurrent) => handoffVerifiedRepair({ db: h.db, target, assertCurrent,
        readVersion: async () => readFileSync(h.versionFile, 'utf8') }),
      observeProgress: async receipt => ({ progress: observeRepairHandoffProgressInDb(h.db, receipt),
        readCurrent: () => observeRepairHandoffProgressInDb(h.db, receipt) }),
      onError: error => errors.push(error),
    }),
  });
  try {
    await controller.reconcile();
    assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'observing');
    assert.equal(h.store.followupEvidence(h.repairCase.caseId).length, 1);
    const executionId = await completeOrdinaryWork(h);
    await controller.reconcile();
    assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'closed');
    const records = h.store.followupEvidence(h.repairCase.caseId) as { kind: string; payload_json: string }[];
    assert.equal(JSON.parse(records.find(row => row.kind === 'business-progress')!.payload_json).executionId, executionId);
    await controller.reconcile();
    assert.equal(h.store.followupEvidence(h.repairCase.caseId).length, 2);
    assert.equal(launches, 0);
    assert.deepEqual(errors, []);
  } finally { await controller.shutdown(); h.store.close(); }
});

test('handoff replay repairs an interrupted cross-database acknowledgement without a second dispatch cycle', async () => {
  const h = await fixture();
  const trigger = `block_followup_${randomUUID().replaceAll('-', '')}`;
  const management = new Database(h.store.filename);
  management.exec(`CREATE TRIGGER ${trigger} BEFORE INSERT ON repair_followups BEGIN SELECT RAISE(ABORT,'management acknowledgement unavailable'); END`);
  try {
    await assert.rejects(h.handoff(), /management acknowledgement unavailable/);
    assert.equal(h.store.followupEvidence(h.repairCase.caseId).length, 0);
    assert.equal((h.db.prepare('SELECT dispatch_epoch FROM workflow_items WHERE item_id = ?').get(h.itemId) as { dispatch_epoch: number }).dispatch_epoch, 2);
    management.exec(`DROP TRIGGER ${trigger}`);
    const receipt = await h.handoff(async () => { throw new Error('committed business receipt must be replayed'); });
    assert.equal(receipt.dispatchEpoch, 2);
    assert.equal(h.store.followupEvidence(h.repairCase.caseId).length, 1);
    assert.equal((h.db.prepare("SELECT count(*) AS n FROM task_events WHERE task_id = ? AND event_type = 'RepairHandedBack'").get(h.taskId) as { n: number }).n, 1);
  } finally { management.exec(`DROP TRIGGER IF EXISTS ${trigger}`); management.close(); h.store.close(); }
});

test('recurring fault invalidates saved advancement and preserves prior followups for the next Admin', async () => {
  const h = await fixture();
  try {
    const receipt = await h.handoff();
    await completeOrdinaryWork(h);
    const progress = observeRepairHandoffProgressInDb(h.db, receipt)!;
    assert.ok(progress);
    h.store.recordBusinessProgress(h.authority, h.repairCase.caseId, progress);
    const original = h.db.prepare('SELECT observation_json FROM repair_observation_outbox WHERE intervention_id = ?').get(h.fault.intervention_id) as { observation_json: string };
    const observation = JSON.parse(original.observation_json);
    h.store.observe({ ...observation, observationId: `recurrence:${randomUUID()}`, summary: 'Original failure recurred after handoff', evidence: { ...observation.evidence, recurrence: true } });
    assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'queued');
    assert.throws(() => h.store.closeObservedCase(h.authority, h.repairCase.caseId, () => progress), /独立验证/);
    assert.equal(h.store.followupEvidence(h.repairCase.caseId).length, 2);
    const next = h.store.claimNext(h.authority)!;
    const credential = h.store.issueCommandCredential(next);
    assert.equal(h.store.commandStatus(credential).followups.length, 2);
    const prompt = buildAdminPrompt(h.store, next, 'loop-admin');
    assert.match(prompt, /Previous verified handoffs and business progress/);
    assert.ok(prompt.includes(progress.executionId));
    assert.match(prompt, /不能把历史通过当成本轮通过/);
  } finally { h.store.close(); }
});

test('pending business fault blocks completion observation before its management outbox is consumed', async () => {
  const h = await fixture();
  try {
    const receipt = await h.handoff();
    const executionId = await completeOrdinaryWork(h);
    const progress = observeRepairHandoffProgressInDb(h.db, receipt)!;
    assert.ok(progress);
    h.store.recordBusinessProgress(h.authority, h.repairCase.caseId, progress);
    // Seed a late persisted blocker, as can be observed during historical
    // recovery. Public creation correctly refuses an already-ended direct task;
    // the read-only observer must still reject inconsistent persisted facts.
    const lateFaultId = `INT-${randomUUID()}`;
    h.db.prepare(`INSERT INTO interventions(intervention_id,task_id,item_id,dedupe_key,status,resolver_strategy,
      authority,requested_by,source_execution_id,summary,context_json,context_hash,max_system_attempts,source_kind)
      SELECT ?,task_id,item_id,?,'pending',resolver_strategy,authority,requested_by,?,
        'Late independent acceptance failure',context_json,context_hash,max_system_attempts,source_kind
      FROM interventions WHERE intervention_id = ?`).run(lateFaultId, `late-fault:${randomUUID()}`, executionId, h.fault.intervention_id);
    assert.equal((h.db.prepare('SELECT repair_case_id FROM interventions WHERE intervention_id = ?').get(lateFaultId) as { repair_case_id: string | null }).repair_case_id, null);
    assert.equal(observeRepairHandoffProgressInDb(h.db, receipt), null);
    assert.equal(h.store.closeObservedCase(h.authority, h.repairCase.caseId, () => observeRepairHandoffProgressInDb(h.db, receipt)), false);
    assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'observing');
  } finally { h.store.close(); }
});

test('stop during final fresh observation prevents Case closure without deleting saved proof', async () => {
  const h = await fixture();
  try {
    const receipt = await h.handoff();
    await completeOrdinaryWork(h);
    const progress = observeRepairHandoffProgressInDb(h.db, receipt)!;
    h.store.recordBusinessProgress(h.authority, h.repairCase.caseId, progress);
    assert.throws(() => h.store.closeObservedCase(h.authority, h.repairCase.caseId, () => {
      h.store.setIntent('stopped', randomUUID());
      return progress;
    }), /运行意图/);
    assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'observing');
    assert.equal(h.store.followupEvidence(h.repairCase.caseId).length, 2);
  } finally { h.store.close(); }
});

test('a measured version change after verification reopens the original Case instead of silently waiting in observing', async () => {
  const h = await fixture();
  const verification = h.store.attempts(h.repairCase.caseId).find(row => row.role === 'verification')!;
  const original = h.store.observations(h.repairCase.caseId)[0];
  const savedReceipt = h.store.verificationReceipt(verification.attemptId);
  writeFileSync(h.versionFile, 'changed-after-verification');
  const manage = createAdminHandoffs({ store: h.store,
    handoff: (target, assertCurrent) => handoffVerifiedRepair({ db: h.db, target, assertCurrent,
      readVersion: async () => readFileSync(h.versionFile, 'utf8') }),
    onError: () => { throw new Error('Even failure logging must not block repair recovery'); } });
  try {
    await manage(h.authority);
    assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'queued');
    assert.equal(h.store.observations(h.repairCase.caseId).length, 2);
    assert.deepEqual(h.store.observations(h.repairCase.caseId)[0], original);
    assert.deepEqual(h.store.verificationReceipt(verification.attemptId), savedReceipt, 'Old proof remains immutable, not current success');
    assert.equal(h.store.followupEvidence(h.repairCase.caseId).length, 0);
    assert.equal((h.db.prepare('SELECT status FROM workflow_items WHERE task_id = ?').get(h.taskId) as { status: string }).status, 'waiting');
    assert.equal((h.db.prepare('SELECT status FROM interventions WHERE intervention_id = ?').get(h.fault.intervention_id) as { status: string }).status, 'pending');
    await manage(h.authority);
    assert.equal(h.store.observations(h.repairCase.caseId).length, 2, 'The same blocked handoff does not manufacture recurring facts');
    const next = h.store.claimNext(h.authority)!;
    assert.equal(next.repairCase.caseId, h.repairCase.caseId);
    assert.equal(next.attempt.generation, 3);
    assert.equal(h.store.attempts(h.repairCase.caseId).length, 3);
  } finally { h.store.close(); }
});
