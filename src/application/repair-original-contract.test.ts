import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { databaseConnection } from '../infrastructure/database';
import { AdminManagementStore } from '../infrastructure/admin-management-store';
import { createTaskInDb, createTaskSchema } from './tasks';
import { openInterventionInDb } from './interventions';
import { enqueueInterventionFaultInDb, pendingRepairObservationsInDb } from './repair-observation-outbox';
import { snapshotRepairOriginalContractInDb } from './repair-original-contract';
import type { RepairObservation } from '../domain/repair-case';

async function fixture() {
  const db = await databaseConnection();
  db.prepare('UPDATE tasks SET is_paused = 1').run();
  const taskId = `REQ-${randomUUID()}`;
  createTaskInDb(db, createTaskSchema.parse({ title: 'Original frozen contract fixture', itemType: 'direct' }), taskId);
  const item = db.prepare('SELECT item_id FROM workflow_items WHERE task_id = ?').get(taskId) as { item_id: string };
  db.prepare('UPDATE workflow_items SET story_index = 1 WHERE item_id = ?').run(item.item_id);
  for (const story of [1, 2]) db.prepare('INSERT INTO stories(task_id,story_index,title,directory) VALUES(?,?,?,?)')
    .run(taskId, story, `Original unit ${story}`, `story-${story}`);
  const executionId = randomUUID();
  const executedSpec = { task_id: taskId, story_index: 1, revision: 1,
    spec: { acceptances: [{ key: 'unit:original', oracle: 'Seven actual columns' }] } };
  db.prepare(`INSERT INTO execution_attempts(execution_id,run_id,task_id,story_index,agent,pipeline,delegation_key,
    attempt,status,input_hash,input_json,work_item_id) VALUES(?,'RUN-original',?,1,'test-agent','test',?,1,'running','hash',?,?)`)
    .run(executionId, taskId, randomUUID(), JSON.stringify({ contextSnapshot: { authoritativeFacts: { currentDeliverySpec: executedSpec } } }), item.item_id);
  for (const revision of [1, 2]) db.prepare(`INSERT INTO story_specs(spec_id,task_id,story_index,revision,status,spec_json)
    VALUES(?,?,1,?,? ,?)`).run(randomUUID(), taskId, revision, revision === 1 ? 'superseded' : 'resolved',
      JSON.stringify({ acceptances: [{ key: 'original', oracle: revision === 1 ? 'Seven actual columns' : 'Changed oracle' }] }));
  const acceptanceId = randomUUID();
  db.prepare(`INSERT INTO acceptances(acceptance_id,task_id,acceptance_key,scope_type,story_index,statement,oracle,source_ref)
    VALUES(?,?,'unit:original','delivery_unit',1,'Actual columns visible','Seven actual columns','original-source')`)
    .run(acceptanceId, taskId);
  db.prepare(`INSERT INTO acceptances(acceptance_id,task_id,acceptance_key,scope_type,story_index,statement,oracle,source_ref)
    VALUES(?,?,'unit:other','delivery_unit',2,'Other unit','Other oracle','other-source')`).run(randomUUID(), taskId);
  const draftId = randomUUID();
  db.prepare(`INSERT INTO agent_work_drafts(draft_id,work_key,draft_version,draft_type,task_id,story_index,agent,last_execution_id)
    VALUES(?,?,1,'verification',?,1,'test-agent',?)`).run(draftId, randomUUID(), taskId, executionId);
  db.prepare(`INSERT INTO command_chain_drafts(draft_id,command_chain_id,definition_version,workflow_phase)
    VALUES(?,'verification',15,'executing')`).run(draftId);
  for (const [index, [block, content]] of [['sources', 'kind: acceptance\noracle: Seven actual columns'],
    ['scenarios', 'title: Original tab\nexpected: Seven actual columns\ncoverageRefs: [acceptance:unit:original]'],
    ['results', 'status: failed\nfailureKind: implementation\nevidence: Tab is still a placeholder']].entries()) {
    db.prepare(`INSERT INTO command_chain_artifact_blocks(draft_id,artifact_id,block_id,item_key,content_format,content,ordinal)
      VALUES(?,'verification',?,'original','yaml',?,?)`).run(draftId, block, content, index);
  }
  db.prepare(`INSERT INTO execution_receipts(receipt_id,execution_id,kind,receipt_key,payload_json)
    VALUES(?,?,'tool_event','000001',?)`).run(randomUUID(), executionId,
      JSON.stringify({ name: 'loop.agent.tool', phase: 'completed', commandHash: 'command-hash', success: false,
        input: { command: 'node original-tab-test.mjs' }, summary: 'Seven actual columns were not rendered' }));
  db.prepare(`INSERT INTO command_chain_checks(draft_id,check_key,command,command_hash,summary,source_execution_id,source_receipt_key,ordinal)
    VALUES(?,'original-test','node original-tab-test.mjs','command-hash','Original test',?,'000001',0)`).run(draftId, executionId);
  return { db, taskId, itemId: item.item_id, executionId, draftId, acceptanceId };
}

test('fault creation freezes the actually executed spec revision, original YAML scenario and receipt; rewind cannot replace them', async () => {
  const h = await fixture();
  const source = openInterventionInDb(h.db, { taskId: h.taskId, itemId: h.itemId, sourceExecutionId: h.executionId,
    requestedBy: 'test-agent', authority: 'arbitration', dedupeKey: 'immutable-original', summary: 'Original tab test failed' });
  const raw = pendingRepairObservationsInDb(h.db)[0].observation_json;
  const observation = JSON.parse(raw) as RepairObservation;
  const contract = observation.evidence.originalContract as ReturnType<typeof snapshotRepairOriginalContractInDb>;
  assert.equal(contract.provenance.executionScopeConfirmed, true);
  assert.equal(contract.deliverySpec.source, 'execution-reference');
  assert.equal(contract.deliverySpec.record?.revision, 1, 'Do not read newer resolved revision 2 as the executed contract');
  assert.equal(contract.acceptances.length, 1, 'Do not include another unit acceptance');
  assert.match(String(contract.deliverySpec.record?.spec_json), /Seven actual columns/);
  assert.match(String(contract.verification.blocks.find(row => row.block_id === 'results')?.content), /placeholder/);
  assert.equal(contract.verification.checkedCommands[0].receiptScopeConfirmed, true);
  assert.equal(contract.sourceReceipts.length, 1);
  assert.match(contract.authority, /not-a-runnable/);
  h.db.prepare("UPDATE story_specs SET spec_json = '{}' WHERE task_id = ?").run(h.taskId);
  h.db.prepare("UPDATE acceptances SET oracle = 'Changed target',revision = 2 WHERE acceptance_id = ?").run(h.acceptanceId);
  h.db.prepare("UPDATE command_chain_artifact_blocks SET content = 'status: passed' WHERE draft_id = ?").run(h.draftId);
  h.db.prepare("UPDATE execution_receipts SET payload_json = '{}' WHERE execution_id = ?").run(h.executionId);
  enqueueInterventionFaultInDb(h.db, source, 'changed-version');
  assert.equal(pendingRepairObservationsInDb(h.db)[0].observation_json, raw, 'Idempotent delivery must not recompute original facts');
  const filename = join(process.env.LOOP_DATA_ROOT!, randomUUID(), 'management.db');
  const first = new AdminManagementStore(filename);
  const repair = first.observe(observation);
  first.close();
  const restarted = new AdminManagementStore(filename);
  try {
    assert.match(JSON.stringify(restarted.observations(repair.caseId)), /Seven actual columns/);
    assert.equal(restarted.getCase(repair.caseId)?.status, 'queued', 'Frozen failed receipts never mean repair passed');
  } finally { restarted.close(); }
});

test('a missing executed spec revision never falls back to a newer contract', async () => {
  const h = await fixture();
  h.db.prepare('DELETE FROM story_specs WHERE task_id = ? AND revision = 1').run(h.taskId);
  const frozen = snapshotRepairOriginalContractInDb(h.db, { taskId: h.taskId, itemId: h.itemId, executionId: h.executionId });
  assert.equal(frozen.deliverySpec.record, null);
  assert.equal(frozen.deliverySpec.referenceResolved, false);
  assert.equal(frozen.deliverySpec.executionReference?.revision, 1);
  assert.match(JSON.stringify(frozen.deliverySpec.authoritativeExecutionSpec), /Seven actual columns/);
});

test('original requirement input is preserved separately from a later edited requirement row', async () => {
  const h = await fixture();
  const row = h.db.prepare('SELECT input_json FROM execution_attempts WHERE execution_id = ?').get(h.executionId) as { input_json: string };
  const input = JSON.parse(row.input_json);
  input.contextSnapshot.authoritativeFacts.requirement = { title: 'Original title', description: 'Original observable user goal' };
  h.db.prepare('UPDATE execution_attempts SET input_json = ? WHERE execution_id = ?').run(JSON.stringify(input), h.executionId);
  h.db.prepare('UPDATE tasks SET description = ? WHERE task_id = ?').run('Later changed user goal', h.taskId);
  const frozen = snapshotRepairOriginalContractInDb(h.db, { taskId: h.taskId, itemId: h.itemId, executionId: h.executionId });
  assert.equal(frozen.requirement.source, 'execution-input');
  assert.equal(frozen.requirement.authoritativeExecutionRequirement?.description, 'Original observable user goal');
  assert.equal((frozen.requirement.record as { description: string }).description, 'Later changed user goal');
});

test('even a same-revision database edit cannot replace the immutable acceptance input actually sent to the failed execution', async () => {
  const h = await fixture();
  h.db.prepare("UPDATE story_specs SET spec_json = '{\"acceptances\": []}' WHERE task_id = ? AND revision = 1").run(h.taskId);
  const frozen = snapshotRepairOriginalContractInDb(h.db, { taskId: h.taskId, itemId: h.itemId, executionId: h.executionId });
  assert.equal(frozen.deliverySpec.referenceResolved, true, 'Resolving an ID is not proof the live row was unchanged');
  assert.match(JSON.stringify(frozen.deliverySpec.authoritativeExecutionSpec), /Seven actual columns/);
  assert.equal(frozen.deliverySpec.record?.spec_json, '{"acceptances": []}', 'Retain contradictory live evidence without authorizing it');
});

test('cross-unit receipt keys and cross-item execution references do not become scoped verification authority', async () => {
  const h = await fixture();
  h.db.prepare('UPDATE execution_attempts SET story_index = 2 WHERE execution_id = ?').run(h.executionId);
  const frozen = snapshotRepairOriginalContractInDb(h.db, { taskId: h.taskId, itemId: h.itemId, executionId: h.executionId });
  assert.equal(frozen.verification.checkedCommands[0].receiptScopeConfirmed, false);
  assert.deepEqual(frozen.verification.checkedCommands[0].receipts, []);
  h.db.prepare('UPDATE execution_attempts SET work_item_id = NULL WHERE execution_id = ?').run(h.executionId);
  const mismatch = snapshotRepairOriginalContractInDb(h.db, { taskId: h.taskId, itemId: h.itemId, executionId: h.executionId });
  assert.equal(mismatch.provenance.executionScopeConfirmed, false);
  assert.equal(mismatch.deliverySpec.source, 'fault-time-current');
  assert.deepEqual(mismatch.sourceReceipts, []);
});

test('an outbox rollback also discards the original contract snapshot', async () => {
  const h = await fixture();
  assert.throws(() => h.db.transaction(() => {
    openInterventionInDb(h.db, { taskId: h.taskId, itemId: h.itemId, sourceExecutionId: h.executionId,
      requestedBy: 'test-agent', authority: 'arbitration', dedupeKey: 'rolled-back-original', summary: 'Original failure' });
    throw new Error('rollback');
  }).immediate(), /rollback/);
  assert.equal(pendingRepairObservationsInDb(h.db).length, 0);
});
