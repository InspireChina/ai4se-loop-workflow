import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('updates an existing task-level document instead of inserting a duplicate NULL-story row', async () => {
  const appRoot = mkdtempSync(join(tmpdir(), 'loopwork-app-'));
  const workspaceRoot = join(appRoot, 'workspace');
  mkdirSync(workspaceRoot);
  cpSync(join(process.cwd(), 'migrations'), join(appRoot, 'migrations'), { recursive: true });
  cpSync(join(process.cwd(), 'app-migrations'), join(appRoot, 'app-migrations'), { recursive: true });
  process.env.LOOP_APP_ROOT = appRoot;
  process.env.LOOP_WORKSPACE_ROOT_OVERRIDE = workspaceRoot;

  const { databaseConnection } = await import('../infrastructure/database');
  const { listDocuments, upsertDocument } = await import('./tasks');
  const db = await databaseConnection();
  db.prepare(`
    INSERT INTO tasks(task_id, title, item_type, agile_status, work_dir)
    VALUES('TASK-doc-null', 'Document upsert', 'task', 'backlog', '')
  `).run();

  const firstId = await upsertDocument({
    taskId: 'TASK-doc-null',
    kind: 'final_review',
    title: 'First review',
    content: 'first',
    actor: 'review-agent',
  });
  const secondId = await upsertDocument({
    taskId: 'TASK-doc-null',
    kind: 'final_review',
    title: 'Second review',
    content: 'second',
    actor: 'review-agent',
  });

  const documents = await listDocuments('TASK-doc-null');
  assert.equal(secondId, firstId);
  assert.equal(documents.length, 1);
  assert.equal(documents[0].title, 'Second review');
  assert.equal(documents[0].content, 'second');
  assert.equal(documents[0].story_index, null);

});

test('creates title-only and described Tasks without blocking delegation and serializes description into agent context', async () => {
  const { createTask, getTaskContext, getTask, pipelineAllEnvelopes, pipelineForTask, toJsonlEnvelope } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const titleOnlyTaskId = await createTask({ title: 'Title only Task' });
  const blankDescriptionTaskId = await createTask({ title: 'Blank description Task', description: '   ' });
  const describedTaskId = await createTask({ title: 'Described Task', description: 'Keep this value for the next story.' });

  const titleOnlyTask = await getTask(titleOnlyTaskId);
  const blankDescriptionTask = await getTask(blankDescriptionTaskId);
  const describedTask = await getTask(describedTaskId);
  assert.equal(titleOnlyTask?.task.description, null);
  assert.equal(blankDescriptionTask?.task.description, null);
  assert.equal(describedTask?.task.description, 'Keep this value for the next story.');

  const titleOnlyContext = await getTaskContext(titleOnlyTaskId);
  const describedContext = await getTaskContext(describedTaskId);
  assert.equal(titleOnlyContext.task.description, null);
  assert.equal(describedContext.task.description, 'Keep this value for the next story.');

  // Each creation path can produce the normal backlog delegation; a missing
  // description must never be interpreted as a pipeline blocker.
  assert.equal((await pipelineForTask(titleOnlyTaskId))[0]?.agent, 'backlog-agent');
  assert.equal((await pipelineForTask(describedTaskId))[0]?.agent, 'backlog-agent');

  // A backlog delegation consumes the browser resource, so isolate each path
  // when inspecting its serialized Agent input.
  db.prepare("UPDATE tasks SET agile_status = 'done' WHERE task_id NOT IN (?, ?, ?)").run(titleOnlyTaskId, blankDescriptionTaskId, describedTaskId);
  db.prepare("UPDATE tasks SET agile_status = 'done' WHERE task_id = ?").run(blankDescriptionTaskId);
  db.prepare("UPDATE tasks SET agile_status = 'done' WHERE task_id = ?").run(describedTaskId);
  const titleOnlyEnvelope = (await pipelineAllEnvelopes()).find((item) => item.taskId === titleOnlyTaskId);
  assert.ok(titleOnlyEnvelope);

  const titleOnlyAgentInput = JSON.parse(toJsonlEnvelope(titleOnlyEnvelope));
  assert.equal(titleOnlyAgentInput.task_description, null);

  db.prepare("UPDATE tasks SET agile_status = 'done' WHERE task_id = ?").run(titleOnlyTaskId);
  db.prepare("UPDATE tasks SET agile_status = 'backlog' WHERE task_id = ?").run(describedTaskId);
  const describedEnvelope = (await pipelineAllEnvelopes()).find((item) => item.taskId === describedTaskId);
  assert.ok(describedEnvelope);
  const describedAgentInput = JSON.parse(toJsonlEnvelope(describedEnvelope));
  assert.equal(describedAgentInput.task_description, 'Keep this value for the next story.');
  assert.equal(describedAgentInput.description, '收集上下文并完成分类');
});

test('lists only completed Tasks in completion order while preserving terminal Task details', async () => {
  const { getTask, listCompletedTasks, listTasks } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();

  db.prepare(`
    INSERT INTO tasks(task_id, title, item_type, agile_status, work_dir, completed_at, updated_at)
    VALUES (?, ?, 'task', ?, '', ?, ?)
  `).run('TASK-completed-new', 'Recently completed', 'done', '2026-07-14 10:00:00', '2026-07-14 10:00:00');
  db.prepare(`
    INSERT INTO tasks(task_id, title, item_type, agile_status, work_dir, completed_at, updated_at)
    VALUES (?, ?, 'task', ?, '', ?, ?)
  `).run('TASK-completed-legacy', 'Legacy completed', 'done', null, '2026-07-14 09:00:00');
  db.prepare(`
    INSERT INTO tasks(task_id, title, item_type, agile_status, work_dir, updated_at)
    VALUES (?, ?, 'task', ?, '', ?)
  `).run('TASK-cancelled', 'Cancelled', 'cancelled', '2026-07-14 11:00:00');
  db.prepare(`
    INSERT INTO tasks(task_id, title, item_type, agile_status, work_dir, updated_at)
    VALUES (?, ?, 'task', ?, '', ?)
  `).run('TASK-active', 'Active', 'backlog', '2026-07-14 12:00:00');
  db.prepare("INSERT INTO stories(task_id, story_index, title, directory) VALUES('TASK-completed-new', 1, 'Completed story', 'story-001')").run();
  db.prepare("INSERT INTO documents(document_id, task_id, kind, title, content) VALUES('DOC-completed', 'TASK-completed-new', 'analysis', 'Completed analysis', 'History remains available')").run();
  db.prepare("INSERT INTO task_events(event_id, task_id, actor, event_type, summary) VALUES('EVENT-completed', 'TASK-completed-new', 'dev-agent', 'completed', 'Task completed')").run();

  const completed = await listCompletedTasks();
  const completedIds = completed.map((task) => task.task_id);
  assert.deepEqual(
    completedIds.filter((taskId) => taskId === 'TASK-completed-new' || taskId === 'TASK-completed-legacy'),
    ['TASK-completed-new', 'TASK-completed-legacy'],
  );
  assert.ok(completed.every((task) => task.agile_status === 'done'));
  assert.ok(!completedIds.includes('TASK-cancelled'));
  assert.ok(!completedIds.includes('TASK-active'));

  const activeIds = (await listTasks()).map((task) => task.task_id);
  assert.ok(!activeIds.includes('TASK-completed-new'));
  assert.ok(!activeIds.includes('TASK-cancelled'));
  assert.ok(activeIds.includes('TASK-active'));

  const detail = await getTask('TASK-completed-new');
  assert.equal(detail?.task.task_id, 'TASK-completed-new');
  assert.equal(detail?.stories[0]?.title, 'Completed story');
  assert.equal(detail?.documents[0]?.content, 'History remains available');
  assert.equal(detail?.events[0]?.summary, 'Task completed');
});
