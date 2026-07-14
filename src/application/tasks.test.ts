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

test('keeps agent analysis Questions displayable, answerable, and releasable with their approval', async () => {
  const { addQuestion, answerQuestion, getTask, releaseBlock } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const taskId = 'TASK-agent-analysis-question';
  db.prepare(`
    INSERT INTO tasks(task_id, title, item_type, agile_status, current_subagent, total_stories, work_dir)
    VALUES(?, 'Agent analysis Question', 'feature', 'ready for dev', 'analyst-agent', 1, '')
  `).run(taskId);
  db.prepare("INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, 1, 'Analysis story', 'story-001')").run(taskId);

  const questionId = await addQuestion({
    taskId,
    storyIndex: 1,
    actor: 'analyst-agent',
    kind: 'analysis',
    title: 'Confirm API boundary',
    question: 'Should the existing endpoint remain public?',
    why: 'The implementation needs a stable compatibility decision.',
    recommendation: 'Keep it public for this release.',
    blockedReason: 'Waiting for API decision',
    blockTask: true,
  });

  let detail = await getTask(taskId);
  const question = detail?.questions.find((item) => item.question_id === questionId);
  assert.equal(question?.title, 'Confirm API boundary');
  assert.equal(question?.question, 'Should the existing endpoint remain public?');
  assert.equal(question?.kind, 'analysis');
  assert.equal(question?.source_agent, 'analyst-agent');
  assert.equal(question?.story_index, 1);
  assert.equal(question?.why, 'The implementation needs a stable compatibility decision.');
  assert.equal(question?.recommendation, 'Keep it public for this release.');
  assert.equal(question?.status, 'pending');
  assert.equal(detail?.approvals.find((item) => item.kind === 'analysis')?.decision, 'pending');
  await assert.rejects(() => releaseBlock(taskId), /仍有待回答问题/);

  await answerQuestion({ taskId, questionId, answer: 'Keep it public.' });
  detail = await getTask(taskId);
  assert.equal(detail?.questions.find((item) => item.question_id === questionId)?.status, 'answered');
  assert.equal(detail?.questions.find((item) => item.question_id === questionId)?.answer, 'Keep it public.');
  assert.ok(detail?.events.some((event) => event.event_type === 'QuestionAnswered'));

  await releaseBlock(taskId);
  detail = await getTask(taskId);
  assert.equal(detail?.task.agile_status, 'ready for dev');
  assert.equal(detail?.task.current_subagent, 'analyst-agent');
  assert.equal(detail?.task.resume_pending, 1);
  assert.equal(detail?.task.resume_status, null);
  assert.equal(detail?.task.analysis_approved_index, 1);
  assert.equal(detail?.approvals.find((item) => item.kind === 'analysis')?.decision, 'confirmed');
});

test('releases answered review Questions back to the review agent with approved approval', async () => {
  const { addQuestion, answerQuestion, getTask, releaseBlock } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const taskId = 'TASK-agent-review-question';
  db.prepare(`
    INSERT INTO tasks(task_id, title, item_type, agile_status, current_subagent, analysis_index, dev_index, test_index, total_stories, analysis_approved_index, work_dir)
    VALUES(?, 'Agent review Question', 'feature', 'in review', 'review-agent', 1, 1, 1, 1, 1, '')
  `).run(taskId);
  db.prepare("INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, 1, 'Review story', 'story-001')").run(taskId);

  const questionId = await addQuestion({
    taskId,
    actor: 'review-agent',
    kind: 'review',
    title: 'Confirm final delivery',
    question: 'Can this Task be delivered?',
    why: 'Final delivery needs human approval.',
    recommendation: 'Approve the verified implementation.',
    blockTask: true,
  });
  assert.equal((await getTask(taskId))?.approvals.find((item) => item.kind === 'review')?.decision, 'pending');

  await answerQuestion({ taskId, questionId, answer: 'Approved.' });
  await releaseBlock(taskId);
  const detail = await getTask(taskId);
  assert.equal(detail?.task.agile_status, 'in review');
  assert.equal(detail?.task.current_subagent, 'review-agent');
  assert.equal(detail?.task.resume_pending, 1);
  assert.equal(detail?.task.review_approved, 1);
  assert.equal(detail?.approvals.find((item) => item.kind === 'review')?.decision, 'approved');
  assert.ok(detail?.events.some((event) => event.event_type === 'BlockReleased'));
});
