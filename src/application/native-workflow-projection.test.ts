import assert from 'node:assert/strict';
import test from 'node:test';
import { databaseConnection } from '../infrastructure/database';
import { createTask, getTask, listTasks } from '../test/legacy-task-fixtures';
import { adoptNativeWorkflowInDb, rewindWorkItemsInDb } from './work-item-transitions';
import { projectNativeWorkflowDisplayInDb } from './native-workflow-projection';
import { openInterventionInDb, resolveIntervention } from './interventions';
import { beginTestExecutionAttempt } from '../test/execution-fixtures';
import { inspectTaskDispatchEnvelope } from '../test/dispatch-inspection-fixtures';
import { randomUUID } from 'node:crypto';

test('the first running Dev is displayed as in development without inventing a completed Dev cursor', async () => {
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'First native Dev progress' });
  db.prepare(`UPDATE tasks SET agile_status = 'ready for dev', current_subagent = 'dev-agent',
    analysis_index = 1, spec_resolved_index = 1, total_stories = 1, dev_index = 0, test_index = 0 WHERE task_id = ?`).run(taskId);
  adoptNativeWorkflowInDb(db, taskId);
  assert.equal((await getTask(taskId))!.task.agile_status, 'ready for dev');
  const work = (await inspectTaskDispatchEnvelope(taskId)).find(item => item.agent === 'dev-agent')!;
  assert.ok(work);
  await beginTestExecutionAttempt({ runId: `RUN-${randomUUID()}`, delegation: work, prompt: 'Native first Dev source fixture' });
  const graph = db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY item_id').all(taskId);
  const task = (await getTask(taskId))!.task;
  assert.equal(task.agile_status, 'in dev');
  assert.equal(task.current_subagent, 'dev-agent');
  assert.equal(task.dev_index, 0);
  assert.equal(task.test_index, 0);
  assert.deepEqual(db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY item_id').all(taskId), graph);
});

test('native display restores task/Lane metadata from the graph without transitioning any work', async () => {
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'One-way workflow projection' });
  db.prepare(`UPDATE tasks SET agile_status = 'in dev', current_subagent = 'test-agent',
    analysis_index = 2, spec_resolved_index = 2, dev_index = 1, test_index = 0, total_stories = 2 WHERE task_id = ?`).run(taskId);
  db.prepare("UPDATE task_lanes SET status = 'completed' WHERE task_id = ? AND lane = 'analysis'").run(taskId);
  adoptNativeWorkflowInDb(db, taskId);
  const graph = db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY item_id').all(taskId);
  const events = db.prepare('SELECT * FROM workflow_item_events WHERE item_id IN (SELECT item_id FROM workflow_items WHERE task_id = ?)').all(taskId);
  db.prepare(`UPDATE tasks SET total_stories = 99, analysis_index = 0, spec_resolved_index = 0, dev_index = 0, test_index = 0,
    current_subagent = 'backlog-agent', agile_status = 'backlog' WHERE task_id = ?`).run(taskId);
  db.prepare("UPDATE task_lanes SET status = 'completed' WHERE task_id = ?").run(taskId);
  const detail = await getTask(taskId);
  assert.equal(detail?.task.current_subagent, 'test-agent', 'detail reads refresh the task before constructing the page');
  assert.equal(detail?.lanes.find((lane) => lane.lane === 'delivery')?.status, 'runnable');
  assert.deepEqual(db.prepare(`SELECT total_stories, analysis_index, dev_index, test_index, current_subagent, agile_status
    FROM tasks WHERE task_id = ?`).get(taskId), {
    total_stories: 2, analysis_index: 2, dev_index: 1, test_index: 0, current_subagent: 'test-agent', agile_status: 'in dev',
  });
  assert.equal((db.prepare("SELECT status FROM task_lanes WHERE task_id = ? AND lane = 'delivery'")
    .get(taskId) as { status: string }).status, 'runnable');
  assert.deepEqual(db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY item_id').all(taskId), graph);
  assert.deepEqual(db.prepare('SELECT * FROM workflow_item_events WHERE item_id IN (SELECT item_id FROM workflow_items WHERE task_id = ?)').all(taskId), events);
  db.prepare("UPDATE tasks SET updated_at = '2000-01-01 00:00:00' WHERE task_id = ?").run(taskId);
  db.prepare("UPDATE task_lanes SET updated_at = '2000-01-01 00:00:00' WHERE task_id = ?").run(taskId);
  const listed = (await listTasks({ includeTerminal: true })).find((row) => row.task_id === taskId);
  assert.equal(listed?.current_subagent, 'test-agent');
  assert.equal((db.prepare('SELECT updated_at FROM tasks WHERE task_id = ?').get(taskId) as { updated_at: string }).updated_at, '2000-01-01 00:00:00');
  assert.ok((db.prepare('SELECT updated_at FROM task_lanes WHERE task_id = ?').all(taskId) as { updated_at: string }[])
    .every((lane) => lane.updated_at === '2000-01-01 00:00:00'));
});

test('native display follows a BA revision and its Intervention without consulting old stage metadata', async () => {
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'BA arbitration display', itemType: 'business-analysis' });
  db.prepare("UPDATE tasks SET current_subagent = 'spec-review-agent' WHERE task_id = ?").run(taskId);
  const items = adoptNativeWorkflowInDb(db, taskId);
  const design = items.find((item) => item.work_key === 'ba:design')!;
  rewindWorkItemsInDb(db, { taskId, targetItemId: design.item_id, eventKey: 'reconsider-design',
    actor: 'system', authority: 'arbitration', reason: 'Review identified a contradictory business outcome' });
  projectNativeWorkflowDisplayInDb(db, taskId);
  assert.equal((db.prepare('SELECT current_subagent FROM tasks WHERE task_id = ?').get(taskId) as { current_subagent: string }).current_subagent, 'business-design-agent');
  const current = db.prepare("SELECT item_id FROM workflow_items WHERE task_id = ? AND work_key = 'ba:design' AND status = 'ready'")
    .get(taskId) as { item_id: string };
  const intervention = openInterventionInDb(db, { taskId, itemId: current.item_id, dedupeKey: 'design-check',
    summary: 'Need one business outcome clarified', requestedBy: 'system', resolverStrategy: 'system_then_human' });
  projectNativeWorkflowDisplayInDb(db, taskId);
  assert.equal((db.prepare('SELECT run_state FROM tasks WHERE task_id = ?').get(taskId) as { run_state: string }).run_state, 'waiting_for_runtime_input');
  await resolveIntervention({ interventionId: intervention.intervention_id, resolution: 'The observable outcome is now established', resolvedBy: 'system' });
  assert.equal((db.prepare('SELECT run_state FROM tasks WHERE task_id = ?').get(taskId) as { run_state: string }).run_state, 'runnable');
});

test('legacy metadata is not rewritten by the native display adapter', async () => {
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Legacy display stays intact' });
  const before = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
  projectNativeWorkflowDisplayInDb(db, taskId);
  assert.deepEqual(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId), before);
});

test('stale done metadata cannot hide unfinished native work or create completion facts', async () => {
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Stale completion projection' });
  adoptNativeWorkflowInDb(db, taskId);
  const graph = db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY item_id').all(taskId);
  db.prepare(`UPDATE tasks SET agile_status = 'done', current_subagent = NULL,
    closure_status = 'acknowledged', completed_at = '2001-01-01 00:00:00',
    closure_acknowledged_at = '2001-01-01 00:00:00', run_state = 'idle' WHERE task_id = ?`).run(taskId);
  projectNativeWorkflowDisplayInDb(db, taskId);
  const task = db.prepare(`SELECT agile_status, current_subagent, completed_at, closure_acknowledged_at,
    closure_status, run_state FROM tasks WHERE task_id = ?`).get(taskId);
  assert.deepEqual(task, { agile_status: 'backlog', current_subagent: 'backlog-agent', completed_at: null,
    closure_acknowledged_at: null, closure_status: 'none', run_state: 'runnable' });
  assert.deepEqual(db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY item_id').all(taskId), graph);
});

test('completed native work retains its actual completion date rather than stale display dates', async () => {
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Completion date projection', itemType: 'direct' });
  adoptNativeWorkflowInDb(db, taskId);
  // Fixture is a historical Work Item completion, not an Agent execution claim.
  db.prepare(`UPDATE workflow_items SET status = 'completed', completed_at = '2002-02-02 02:02:02'
    WHERE task_id = ? AND work_key = 'direct:execute'`).run(taskId);
  db.prepare(`UPDATE tasks SET agile_status = 'done', completed_at = '2001-01-01 00:00:00',
    closure_acknowledged_at = '2001-01-01 00:00:00' WHERE task_id = ?`).run(taskId);
  const graph = db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY item_id').all(taskId);
  projectNativeWorkflowDisplayInDb(db, taskId);
  assert.deepEqual(db.prepare(`SELECT agile_status, completed_at, closure_acknowledged_at
    FROM tasks WHERE task_id = ?`).get(taskId), { agile_status: 'done', completed_at: '2002-02-02 02:02:02',
    closure_acknowledged_at: '2002-02-02 02:02:02' });
  assert.deepEqual(db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY item_id').all(taskId), graph);
});
