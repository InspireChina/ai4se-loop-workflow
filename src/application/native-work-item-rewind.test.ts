import assert from 'node:assert/strict';
import test from 'node:test';
import { databaseConnection } from '../infrastructure/database';
import { createTask, getTask, rewindTask, saveDeliverySpec } from '../test/legacy-task-fixtures';
import { adoptNativeWorkflowInDb, rewindWorkItemsInDb } from './work-item-transitions';
import { deliverySpecFixture } from '../test/delivery-spec-fixture';
import { inspectTaskDispatchEnvelope } from '../test/dispatch-inspection-fixtures';
import { openInterventionInDb } from './interventions';

async function fixture(itemType = 'feature') {
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Native graph rewind', itemType });
  db.prepare(`UPDATE tasks SET agile_status = 'in dev', current_subagent = 'test-agent',
    total_stories = 1, analysis_index = 1, spec_resolved_index = 1, dev_index = 1, test_index = 0 WHERE task_id = ?`).run(taskId);
  db.prepare("INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, 1, 'Frozen unit', 'unit-1')").run(taskId);
  await saveDeliverySpec({ taskId, storyIndex: 1, status: 'resolved', spec: deliverySpecFixture() });
  const items = adoptNativeWorkflowInDb(db, taskId);
  await getTask(taskId);
  return { db, taskId, items };
}

test('native task rewind uses exact work identity, rejects missing nodes and replays normalized reasons', async () => {
  const { db, taskId } = await fixture();
  const specifications = db.prepare('SELECT * FROM story_specs WHERE task_id = ?').all(taskId);
  db.prepare(`UPDATE tasks SET total_stories = 99, analysis_index = 99, spec_resolved_index = 99,
    dev_index = 99, test_index = 99, current_subagent = 'backlog-agent', agile_status = 'backlog' WHERE task_id = ?`).run(taskId);
  await rewindTask({ taskId, actor: 'human', to: 'dev', story: 1, eventKey: 'native-unit-rewind' });
  assert.equal((await inspectTaskDispatchEnvelope(taskId))[0]?.agent, 'dev-agent');
  assert.deepEqual(db.prepare('SELECT * FROM story_specs WHERE task_id = ?').all(taskId), specifications);
  const graph = db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY item_id').all(taskId);
  await rewindTask({ taskId, actor: 'human', to: 'dev', story: 1, eventKey: 'native-unit-rewind' });
  assert.deepEqual(db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY item_id').all(taskId), graph);
  await assert.rejects(rewindTask({ taskId, actor: 'human', to: 'dev', story: 2 }), /原生工作项/);
  assert.deepEqual(db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY item_id').all(taskId), graph);
});

test('native plan invalidation archives specifications and cascading evidence before replacing its expanded units', async () => {
  const { db, taskId } = await fixture();
  const other = await fixture();
  const spec = db.prepare('SELECT * FROM story_specs WHERE task_id = ?').get(taskId) as { spec_id: string };
  const otherSpec = db.prepare('SELECT spec_id FROM story_specs WHERE task_id = ?').get(other.taskId) as { spec_id: string };
  db.prepare(`INSERT INTO delivery_unit_context_links(task_id, story_index, source_key, source_kind, content, source_ref)
    VALUES(?, 1, 'original-evidence', 'acceptance', 'Original observable contract', 'SOURCE:original-contract')`).run(taskId);
  // Exercise a production-style unscoped descendant and an implicit PK FK.
  db.exec(`CREATE TABLE archive_probe_child(id TEXT PRIMARY KEY, spec_id TEXT REFERENCES story_specs(spec_id) ON DELETE CASCADE, note TEXT);
    CREATE TABLE archive_probe_grandchild(id TEXT PRIMARY KEY, child_id TEXT REFERENCES archive_probe_child ON DELETE CASCADE, note TEXT);`);
  try {
    db.prepare("INSERT INTO archive_probe_child VALUES('own-child', ?, 'Original context')").run(spec.spec_id);
    db.prepare("INSERT INTO archive_probe_child VALUES('other-child', ?, 'Unrelated context')").run(otherSpec.spec_id);
    db.exec("INSERT INTO archive_probe_grandchild VALUES('own-grandchild', 'own-child', 'Original descendant')");
    const stories = db.prepare('SELECT * FROM stories WHERE task_id = ?').all(taskId);
    const specifications = db.prepare('SELECT * FROM story_specs WHERE task_id = ?').all(taskId);
    const evidence = db.prepare('SELECT * FROM delivery_unit_context_links WHERE task_id = ?').all(taskId);
    await rewindTask({ taskId, actor: 'human', to: 'plan', reason: 'Rebuild contradictory unit ownership', eventKey: 'archive-plan-rewind' });
    const event = db.prepare(`SELECT payload_json FROM workflow_item_events WHERE event_key = 'archive-plan-rewind:plan-invalidated'
      AND item_id IN (SELECT item_id FROM workflow_items WHERE task_id = ?)`).get(taskId) as { payload_json: string };
    const archive = JSON.parse(event.payload_json).archivedEntities;
    assert.deepEqual(archive.stories, stories);
    assert.deepEqual(archive.story_specs, specifications);
    assert.deepEqual(archive.delivery_unit_context_links, evidence);
    assert.deepEqual(archive.archive_probe_child, [{ id: 'own-child', spec_id: spec.spec_id, note: 'Original context' }]);
    assert.deepEqual(archive.archive_probe_grandchild, [{ id: 'own-grandchild', child_id: 'own-child', note: 'Original descendant' }]);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM stories WHERE task_id = ?').get(taskId) as { count: number }).count, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM story_specs WHERE task_id = ?').get(taskId) as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM archive_probe_child WHERE id = 'other-child'").get() as { count: number }).count, 1);
    assert.equal((await inspectTaskDispatchEnvelope(taskId))[0]?.agent, 'story-splitter-agent');
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM workflow_items WHERE task_id = ?
      AND work_key GLOB 'delivery:analysis:*' AND status NOT IN ('cancelled', 'superseded')`).get(taskId) as { count: number }).count, 0);
    const graph = db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY item_id').all(taskId);
    await rewindTask({ taskId, actor: 'human', to: 'plan', reason: 'Rebuild contradictory unit ownership', eventKey: 'archive-plan-rewind' });
    assert.deepEqual(db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY item_id').all(taskId), graph);
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM workflow_item_events WHERE event_key = 'archive-plan-rewind:plan-invalidated'
      AND item_id IN (SELECT item_id FROM workflow_items WHERE task_id = ?)`).get(taskId) as { count: number }).count, 1);
  } finally {
    db.exec('DROP TABLE archive_probe_grandchild; DROP TABLE archive_probe_child');
  }
});

test('plan invalidation failure rolls back graph revisions, Intervention disposal and archived evidence', async () => {
  const { db, taskId, items } = await fixture();
  openInterventionInDb(db, { taskId, itemId: items.find((item) => item.work_key === 'delivery:test:1')!.item_id,
    dedupeKey: 'rollback-plan-intervention', summary: 'Unresolved original conflict', requestedBy: 'test-agent', authority: 'arbitration' });
  await getTask(taskId);
  const graph = db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY item_id').all(taskId);
  const interventions = db.prepare('SELECT * FROM interventions WHERE task_id = ?').all(taskId);
  const specifications = db.prepare('SELECT * FROM story_specs WHERE task_id = ?').all(taskId);
  db.exec(`CREATE TRIGGER reject_plan_archive_delete BEFORE DELETE ON stories WHEN OLD.task_id = '${taskId}'
    BEGIN SELECT RAISE(ABORT, 'plan invalidation rejected'); END`);
  try {
    await assert.rejects(rewindTask({ taskId, actor: 'human', to: 'plan', eventKey: 'rollback-plan-rewind' }),
      (error) => /plan invalidation rejected/.test(String((error as { message: string }).message)));
    assert.deepEqual(db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY item_id').all(taskId), graph);
    assert.deepEqual(db.prepare('SELECT * FROM interventions WHERE task_id = ?').all(taskId), interventions);
    assert.deepEqual(db.prepare('SELECT * FROM story_specs WHERE task_id = ?').all(taskId), specifications);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM workflow_item_events WHERE event_key = 'rollback-plan-rewind:plan-invalidated'").get() as { count: number }).count, 0);
  } finally { db.exec('DROP TRIGGER reject_plan_archive_delete'); }
});

test('rewinding an upstream End-to-End business step invalidates the delivery plan through the same graph transaction', async () => {
  const { db, taskId, items } = await fixture('end-to-end');
  const design = items.find((item) => item.work_key === 'ba:design')!;
  const plan = items.find((item) => item.work_key === 'delivery:plan')!;
  assert.ok(design && plan);
  const input = { taskId, targetItemId: design.item_id, eventKey: 'upstream-business-plan-rewind', actor: 'system-assistance-agent',
    authority: 'arbitration' as const, reason: 'Reconcile the business boundary before planning delivery' };
  const { replacements } = rewindWorkItemsInDb(db, input);
  assert.ok(replacements[plan.item_id]);
  assert.equal((await inspectTaskDispatchEnvelope(taskId))[0]?.agent, 'business-design-agent');
  assert.equal((db.prepare('SELECT status FROM workflow_items WHERE item_id = ?').get(replacements[plan.item_id]) as { status: string }).status, 'pending');
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM stories WHERE task_id = ?').get(taskId) as { count: number }).count, 0);
  const archive = db.prepare(`SELECT payload_json FROM workflow_item_events WHERE item_id = ?
    AND event_key = 'upstream-business-plan-rewind:plan-invalidated'`).get(plan.item_id) as { payload_json: string };
  assert.equal(JSON.parse(archive.payload_json).archivedEntities.story_specs.length, 1);
  const graph = db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY item_id').all(taskId);
  assert.deepEqual(rewindWorkItemsInDb(db, input).replacements, replacements);
  assert.deepEqual(db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY item_id').all(taskId), graph);
});
