import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import type { RepairObservation } from '../domain/repair-case';
import { AdminManagementStore } from '../infrastructure/admin-management-store';
import { databaseConnection } from '../infrastructure/database';
import { createTaskInDb, createTaskSchema } from './tasks';
import { claimNextIntervention, openInterventionInDb } from './interventions';
import { acknowledgeRepairObservationInDb, enqueueInterventionFaultInDb, pendingRepairObservationsInDb } from './repair-observation-outbox';
import { createRepairObservationBridge } from './repair-observation-bridge';
import { createAdminController } from './admin-controller';
import Database from 'better-sqlite3';
import { reconcileAdminBusinessTakeovers } from '../infrastructure/admin-business-operations';

async function fixture() {
  const db = await databaseConnection();
  db.prepare('UPDATE tasks SET is_paused = 1').run();
  const taskId = `REQ-${randomUUID()}`;
  createTaskInDb(db, createTaskSchema.parse({ title: 'Repair outbox fixture', itemType: 'direct' }), taskId);
  const item = db.prepare('SELECT item_id,revision,work_key FROM workflow_items WHERE task_id = ?').get(taskId) as {
    item_id: string; revision: number; work_key: string;
  };
  const store = new AdminManagementStore(join(process.env.LOOP_DATA_ROOT!, randomUUID(), 'management.db'));
  return { db, taskId, item, store };
}

test('fault observation and business hold are committed together; crash between stores replays one Case and preserves the original target', async () => {
  const h = await fixture();
  const source = h.db.transaction(() => openInterventionInDb(h.db, { taskId: h.taskId, itemId: h.item.item_id,
    requestedBy: 'dev-agent', authority: 'arbitration', dedupeKey: 'original-fault', summary: 'Original implementation is missing',
    context: { failureSignature: 'same-original-failure', acceptance: 'Original fixture must work' } })).immediate();
  let crash = true;
  const bridge = createRepairObservationBridge({
    pending: async () => pendingRepairObservationsInDb(h.db).map(row => JSON.parse(row.observation_json) as RepairObservation),
    observe: observation => h.store.observe(observation),
    acknowledge: async (id, caseId) => { if (crash) throw new Error('Host crashed after management commit'); return acknowledgeRepairObservationInDb(h.db, id, caseId); },
  });
  try {
    assert.equal(source.source_kind, 'agent-fault');
    assert.equal((h.db.prepare('SELECT status FROM workflow_items WHERE item_id = ?').get(h.item.item_id) as { status: string }).status, 'waiting');
    const observation = JSON.parse(pendingRepairObservationsInDb(h.db)[0].observation_json) as RepairObservation;
    assert.equal(observation.scopeKey, `${h.taskId}:${h.item.work_key}`);
    assert.deepEqual(observation.evidence.context, { failureSignature: 'same-original-failure', acceptance: 'Original fixture must work' });
    await assert.rejects(bridge(), /crashed/);
    assert.equal(pendingRepairObservationsInDb(h.db).length, 1);
    const repair = h.store.observe(observation);
    crash = false;
    assert.equal(await bridge(), 1);
    assert.equal(await bridge(), 0);
    assert.equal(h.store.observations(repair.caseId).length, 1);
    assert.equal((h.db.prepare('SELECT repair_case_id,status FROM interventions WHERE intervention_id = ?').get(source.intervention_id) as { repair_case_id: string }).repair_case_id, repair.caseId);
    assert.equal(h.store.getCase(repair.caseId)?.status, 'queued');
    assert.equal((h.db.prepare('SELECT status FROM workflow_items WHERE item_id = ?').get(h.item.item_id) as { status: string }).status, 'waiting', 'A link alone must not resolve or pass business');
    assert.equal(await claimNextIntervention({ runId: 'RUN-ordinary-must-not-resolve', executorId: 'claude', executionOptions: {} }), null);
    assert.throws(() => acknowledgeRepairObservationInDb(h.db, observation.observationId, 'foreign-case'), /不能改绑/);
  } finally { h.store.close(); }
});

test('human input and unclassified assistance never become repairable faults; rolled-back workflow creates no outbox record', async () => {
  const h = await fixture();
  try {
    const human = openInterventionInDb(h.db, { taskId: h.taskId, requestedBy: 'human', resolverStrategy: 'human_only',
      authority: 'arbitration', dedupeKey: 'human-decision', summary: 'Original operator decision required' });
    const assistance = openInterventionInDb(h.db, { taskId: h.taskId, requestedBy: 'test-agent',
      dedupeKey: 'assistance', summary: 'Unclassified verification assistance' });
    assert.equal(human.source_kind, 'human-input');
    assert.equal(human.status, 'awaiting_human');
    assert.equal(assistance.source_kind, 'assistance-request');
    assert.equal(enqueueInterventionFaultInDb(h.db, human, 'v1'), null);
    assert.equal(enqueueInterventionFaultInDb(h.db, assistance, 'v1'), null);
    assert.throws(() => h.db.transaction(() => {
      openInterventionInDb(h.db, { taskId: h.taskId, requestedBy: 'dev-agent', authority: 'arbitration',
        dedupeKey: 'rolled-back-fault', summary: 'Must roll back with workflow' });
      throw new Error('rollback');
    }).immediate(), /rollback/);
    assert.equal(pendingRepairObservationsInDb(h.db).length, 0);
    assert.equal(h.db.prepare("SELECT 1 FROM interventions WHERE dedupe_key = 'rolled-back-fault'").get(), undefined);
    assert.throws(() => openInterventionInDb(h.db, { taskId: h.taskId, requestedBy: 'human', resolverStrategy: 'human_only',
      sourceKind: 'agent-fault', dedupeKey: 'wrong-source', summary: 'Must preserve human input' }), /人工输入不能/);
  } finally { h.store.close(); }
});

test('same failure on replacement work-item revisions joins the original investigation without resetting history', async () => {
  const h = await fixture();
  try {
    const first = openInterventionInDb(h.db, { taskId: h.taskId, itemId: h.item.item_id, requestedBy: 'test-agent',
      authority: 'arbitration', dedupeKey: 'failure-revision-1', summary: 'Original repeated failure', context: { failureSignature: 'failure' } });
    h.db.prepare("UPDATE workflow_items SET status = 'superseded' WHERE item_id = ?").run(h.item.item_id);
    const replacement = randomUUID();
    h.db.prepare(`INSERT INTO workflow_items(item_id,task_id,title,kind,agent,pipeline,lane,work_key,origin,revision,status)
      SELECT ?,task_id,title,kind,agent,pipeline,lane,work_key,origin,revision+1,'ready' FROM workflow_items WHERE item_id = ?`)
      .run(replacement, h.item.item_id);
    const second = openInterventionInDb(h.db, { taskId: h.taskId, itemId: replacement, requestedBy: 'test-agent',
      authority: 'arbitration', dedupeKey: 'failure-revision-2', summary: 'Original repeated failure', context: { failureSignature: 'failure' } });
    const observations = pendingRepairObservationsInDb(h.db).map(row => JSON.parse(row.observation_json) as RepairObservation);
    assert.equal(observations.length, 2);
    const cases = observations.map(observation => h.store.observe(observation));
    assert.equal(cases[0].caseId, cases[1].caseId);
    assert.equal(h.store.observations(cases[0].caseId).length, 2);
    assert.notEqual(first.intervention_id, second.intervention_id);
  } finally { h.store.close(); }
});

test('different failure fingerprints on one work item join one repair ownership Case and preserve both targets', async () => {
  const h = await fixture();
  try {
    const first = openInterventionInDb(h.db, { taskId: h.taskId, itemId: h.item.item_id, requestedBy: 'dev-agent',
      authority: 'arbitration', dedupeKey: 'missing-implementation', summary: 'Implementation is missing',
      context: { failureSignature: 'missing-implementation', acceptance: 'Feature exists' } });
    const second = openInterventionInDb(h.db, { taskId: h.taskId, itemId: h.item.item_id, requestedBy: 'test-agent',
      authority: 'arbitration', dedupeKey: 'wrong-service', summary: 'Test uses an obsolete service',
      context: { failureSignature: 'wrong-service', acceptance: 'Current service is authoritative' } });
    const observations = pendingRepairObservationsInDb(h.db).map(row => JSON.parse(row.observation_json) as RepairObservation);
    assert.equal(observations.length, 2);
    assert.notEqual(observations[0].fingerprint, observations[1].fingerprint);
    const cases = observations.map(observation => h.store.observe(observation));
    assert.equal(cases[0].caseId, cases[1].caseId);
    acknowledgeRepairObservationInDb(h.db, `intervention:${first.intervention_id}`, cases[0].caseId);
    acknowledgeRepairObservationInDb(h.db, `intervention:${second.intervention_id}`, cases[1].caseId);
    assert.equal(h.store.observations(cases[0].caseId).length, 2);
    assert.equal((h.db.prepare('SELECT COUNT(DISTINCT repair_case_id) AS count FROM interventions WHERE intervention_id IN (?,?)')
      .get(first.intervention_id, second.intervention_id) as { count: number }).count, 1);
  } finally { h.store.close(); }
});

test('an upgraded store consolidates legacy same-work-item Cases after stopping their executions and migrates every binding', async () => {
  const h = await fixture();
  const first = openInterventionInDb(h.db, { taskId: h.taskId, itemId: h.item.item_id, requestedBy: 'dev-agent',
    authority: 'arbitration', dedupeKey: 'legacy-first', summary: 'Legacy first fault', context: { failureSignature: 'legacy-a' } });
  const second = openInterventionInDb(h.db, { taskId: h.taskId, itemId: h.item.item_id, requestedBy: 'test-agent',
    authority: 'arbitration', dedupeKey: 'legacy-second', summary: 'Legacy second fault', context: { failureSignature: 'legacy-b' } });
  const observations = pendingRepairObservationsInDb(h.db).map(row => JSON.parse(row.observation_json) as RepairObservation);
  const canonical = h.store.observe(observations[0]);
  h.store.observe(observations[1]);
  acknowledgeRepairObservationInDb(h.db, observations[0].observationId, canonical.caseId);
  acknowledgeRepairObservationInDb(h.db, observations[1].observationId, canonical.caseId);
  const aliasCaseId = `REPAIR-${randomUUID()}`;
  const legacyAttemptId = `ATTEMPT-${randomUUID()}`;
  const raw = new Database(h.store.filename);
  try {
    raw.pragma('foreign_keys = ON');
    raw.transaction(() => {
      raw.prepare(`INSERT INTO repair_cases(case_id,dedupe_key,scope,scope_key,fingerprint,original_version,original_summary,
        status,generation,current_attempt_id,created_at,updated_at)
        SELECT ?,?,scope,scope_key,?,original_version,?, 'queued',1,NULL,created_at+1,updated_at+1
        FROM repair_cases WHERE case_id=?`).run(aliasCaseId, randomUUID(), 'legacy-b', 'Legacy second fault', canonical.caseId);
      raw.prepare('UPDATE repair_observations SET case_id=? WHERE observation_id=?').run(aliasCaseId, observations[1].observationId);
      raw.prepare(`INSERT INTO repair_attempts(attempt_id,case_id,owner_id,supervision_token,generation,intent_revision,status,
        started_at,finished_at,last_error,role) VALUES(?,?,?,1,1,1,'failed',1,2,'legacy failure','investigation')`)
        .run(legacyAttemptId, aliasCaseId, 'legacy-host');
      raw.prepare(`INSERT INTO repair_evidence(case_id,attempt_id,receipt_key,kind,payload_json,created_at)
        VALUES(?,?,?,'finding',?,3)`).run(aliasCaseId, legacyAttemptId, 'legacy-evidence', JSON.stringify({ preserved: true }));
      raw.prepare('INSERT INTO repair_schedule_queue(case_id) VALUES(?)').run(aliasCaseId);
    }).immediate();
  } finally { raw.close(); }
  h.db.prepare('UPDATE interventions SET repair_case_id=? WHERE intervention_id=?').run(aliasCaseId, second.intervention_id);
  h.db.prepare('UPDATE repair_observation_outbox SET repair_case_id=? WHERE observation_id=?')
    .run(aliasCaseId, observations[1].observationId);
  h.store.setIntent('running', randomUUID());
  const authority = h.store.acquireSupervisor('legacy-cohort-host')!;
  const active = h.store.claimNext(authority)!;
  try {
    const firstPass = await reconcileAdminBusinessTakeovers({ db: h.db, store: h.store, authority });
    assert.deepEqual(firstPass.attemptIds, [active.attempt.attemptId]);
    assert.equal(h.store.observations(canonical.caseId).length, 1, 'no binding moves before every live generation exits');
    h.store.retireStoppedAttempt(authority, active.attempt.attemptId, true, 'Consolidate legacy Case cohort');
    const secondPass = await reconcileAdminBusinessTakeovers({ db: h.db, store: h.store, authority });
    assert.deepEqual(secondPass.attemptIds, []);
    assert.equal(h.store.observations(canonical.caseId).length, 2);
    assert.equal(h.store.getCase(aliasCaseId)?.status, 'closed');
    assert.match(h.store.getCase(aliasCaseId)?.lastError || '', new RegExp(canonical.caseId));
    assert.equal((h.store.evidence(canonical.caseId) as Array<{ attempt_id: string }>).some(row => row.attempt_id === legacyAttemptId), true);
    assert.equal((h.db.prepare('SELECT COUNT(DISTINCT repair_case_id) AS count FROM interventions WHERE intervention_id IN (?,?)')
      .get(first.intervention_id, second.intervention_id) as { count: number }).count, 1);
    assert.equal((h.db.prepare('SELECT repair_case_id AS caseId FROM interventions WHERE intervention_id=?')
      .get(second.intervention_id) as { caseId: string }).caseId, canonical.caseId);
  } finally { h.store.close(); }
});

test('Controller discovers outbox faults independently of Runner and tolerates discovery storage failure on the next attempt', async () => {
  const h = await fixture();
  openInterventionInDb(h.db, { taskId: h.taskId, itemId: h.item.item_id, requestedBy: 'dev-agent', authority: 'arbitration',
    dedupeKey: 'independent-discovery', summary: 'Original Runner-independent fault' });
  h.store.setIntent('running', randomUUID());
  const bridge = createRepairObservationBridge({
    pending: async () => pendingRepairObservationsInDb(h.db).map(row => JSON.parse(row.observation_json) as RepairObservation),
    observe: observation => h.store.observe(observation),
    acknowledge: async (id, caseId) => acknowledgeRepairObservationInDb(h.db, id, caseId),
  });
  let discoveryFails = false;
  let launches = 0;
  const errors: string[] = [];
  const controller = createAdminController({ store: h.store, ownerId: 'independent-host', confirmStopped: async () => true,
    discover: async () => { if (discoveryFails) throw new Error('business storage no longer readable'); return bridge(); },
    onError: error => errors.push(String(error)),
    launch: async claim => {
      launches++;
      h.store.recordEvidence(claim, 'investigation', 'hypothesis', { investigate: 'Original failure preserved', generation: launches });
      return { completion: Promise.resolve({ outcome: 'failed', reason: 'Continue actual investigation', exitConfirmed: true }), stop: async () => true };
    } });
  try {
    assert.equal(await controller.reconcile(), 'launched');
    await controller.waitForSettlements();
    discoveryFails = true;
    assert.equal(await controller.reconcile(), 'launched');
    await controller.waitForSettlements();
    assert.equal(launches, 2);
    assert.equal(h.store.attempts().length, 2);
    assert.equal(h.store.attempts()[0].caseId, h.store.attempts()[1].caseId);
    assert.equal(errors.some(error => error.includes('no longer readable')), true);
    assert.equal(h.store.observations(h.store.attempts()[0].caseId).length, 1);
  } finally { await controller.shutdown(); h.store.close(); }
});
