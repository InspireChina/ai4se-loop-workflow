import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createTask } from '../test/legacy-task-fixtures';
import { databaseConnection } from '../infrastructure/database';
import { adoptNativeWorkflowInDb } from './work-item-transitions';
import { collectDevCodeEvidence } from './dev-code-evidence';
import { activeResourceClaimInDb, acquireResourceClaimInDb } from './resource-claims';

const baseCommit = 'a'.repeat(40);
const commit = 'b'.repeat(40);
const changed = { kind: 'changed' as const, baseCommit, commit, changedFiles: ['src/中文 file.java'] };
async function fixture() {
  const db = await databaseConnection();
  db.prepare("DELETE FROM resource_claims WHERE resource_key = 'code:workspace'").run();
  const taskId = await createTask({ title: 'Owned Git evidence' });
  const item = adoptNativeWorkflowInDb(db, taskId).find(item => item.work_key === 'delivery:context')!;
  db.prepare(`UPDATE workflow_items SET agent = 'dev-agent', pipeline = 'dev', status = 'running',
    story_index = 1 WHERE item_id = ?`).run(item.item_id);
  const executionId = randomUUID();
  db.prepare(`INSERT INTO execution_attempts(execution_id,run_id,task_id,agent,pipeline,story_index,
    delegation_key,attempt,status,input_hash,input_json,base_commit,work_item_id,work_item_attempt)
    VALUES(?,'RUN-code-evidence',?,'dev-agent','dev',1,?,1,'output_received','input',?,?,?,1)`)
    .run(executionId, taskId, executionId, JSON.stringify({ delegation: { workItemEpoch: 1 } }), baseCommit, item.item_id);
  db.prepare(`INSERT INTO execution_receipts(receipt_id,execution_id,kind,receipt_key,payload_json)
    VALUES(?,?,'code_baseline','execution-start',?)`).run(randomUUID(), executionId,
      JSON.stringify({ head: baseCommit, clean: true, readable: true }));
  acquireResourceClaimInDb(db, { resourceKey: 'code:workspace', taskId, lane: 'delivery', storyIndex: 1, executionId });
  return { db, taskId, itemId: item.item_id, executionId };
}

test('owned native source can capture actual changes without any model changedFiles declaration', async () => {
  const { db, taskId, executionId } = await fixture();
  // Stale display metadata must not release the source's real code ownership.
  db.prepare("UPDATE tasks SET agile_status = 'done' WHERE task_id = ?").run(taskId);
  assert.equal(activeResourceClaimInDb(db, 'code:workspace', taskId)?.owner_execution_id, executionId);
  assert.deepEqual(await collectDevCodeEvidence(executionId, async (workspace, base) => {
    assert.equal(base, baseCommit); assert.ok(workspace); return changed;
  }), changed);
  assert.equal((db.prepare('SELECT code_commit FROM execution_attempts WHERE execution_id = ?').get(executionId) as { code_commit: null }).code_commit, null);
});

for (const invalidation of ['cancelled', 'paused', 'epoch', 'ownership', 'missing-baseline', 'dirty-baseline'] as const) test(`invalid ${invalidation} source never inspects or fabricates a commit`, async () => {
  const { db, taskId, executionId, itemId } = await fixture();
  if (invalidation === 'cancelled') db.prepare("UPDATE execution_attempts SET status = 'cancelled' WHERE execution_id = ?").run(executionId);
  if (invalidation === 'paused') db.prepare('UPDATE tasks SET is_paused = 1 WHERE task_id = ?').run(taskId);
  if (invalidation === 'epoch') db.prepare('UPDATE workflow_items SET dispatch_epoch = 2 WHERE item_id = ?').run(itemId);
  if (invalidation === 'ownership') db.prepare('UPDATE resource_claims SET owner_execution_id = NULL WHERE owner_task_id = ?').run(taskId);
  if (invalidation === 'missing-baseline') db.prepare("DELETE FROM execution_receipts WHERE execution_id = ? AND kind = 'code_baseline'").run(executionId);
  if (invalidation === 'dirty-baseline') db.prepare("UPDATE execution_receipts SET payload_json = ? WHERE execution_id = ? AND kind = 'code_baseline'")
    .run(JSON.stringify({ head: baseCommit, clean: false, readable: true }), executionId);
  assert.equal((await collectDevCodeEvidence(executionId, async () => { assert.fail('invalid source inspected Git'); })).kind, 'unavailable');
});

test('source ownership is rechecked after async Git inspection', async () => {
  const { db, executionId } = await fixture();
  assert.equal((await collectDevCodeEvidence(executionId, async () => {
    db.prepare("UPDATE execution_attempts SET status = 'cancelled' WHERE execution_id = ?").run(executionId);
    return changed;
  })).kind, 'unavailable');
});

test('unchanged and unavailable Git evidence remain distinct and do not become code commits', async () => {
  const { executionId } = await fixture();
  const unchanged = { kind: 'unchanged' as const, baseCommit, commit: baseCommit };
  assert.deepEqual(await collectDevCodeEvidence(executionId, async () => unchanged), unchanged);
  const unavailable = { kind: 'unavailable' as const, reason: 'Git timed out' };
  assert.deepEqual(await collectDevCodeEvidence(executionId, async () => unavailable), unavailable);
});
