import { inspectAllDispatch, inspectTaskDispatch } from '../test/dispatch-inspection-fixtures';
import assert from 'node:assert/strict';
import test from 'node:test';

test('keeps one executor-bound context chat per task and persists its transcript', async () => {
  const { createTask } = await import('./tasks');
  const { beginTaskContextChatTurn, completeTaskContextChatTurn, getTaskContextChat } = await import('./task-context-chat');
  const taskId = await createTask({ title: 'Context chat isolation' });

  const first = await beginTaskContextChatTurn(taskId, 'What is the current state?', 'cursor');
  assert.equal(first.session.executor, 'cursor');
  assert.match(first.commandToken, /^[0-9a-f-]{36}$/);
  await assert.rejects(() => beginTaskContextChatTurn(taskId, 'Can this overlap?', 'claude'), /正在回答/);

  const answer = await completeTaskContextChatTurn({
    sessionId: first.session.sessionId,
    content: 'The task is in backlog.',
    providerSessionId: 'cursor-session-1',
  });
  assert.equal(answer.role, 'assistant');

  const second = await beginTaskContextChatTurn(taskId, 'What changed?', 'claude');
  assert.equal(second.session.sessionId, first.session.sessionId);
  assert.equal(second.session.executor, 'cursor');
  assert.equal(second.session.providerSessionId, 'cursor-session-1');

  const chat = await getTaskContextChat(taskId);
  assert.equal(chat.session?.executor, 'cursor');
  assert.deepEqual(chat.messages.map((message) => [message.role, message.content]), [
    ['user', 'What is the current state?'],
    ['assistant', 'The task is in backlog.'],
    ['user', 'What changed?'],
  ]);

  await completeTaskContextChatTurn({
    sessionId: second.session.sessionId,
    content: 'Nothing yet.',
    providerSessionId: 'cursor-session-1',
  });
});

test('submits unlimited keyed change requests from one Chat turn into the existing Feedback loop', async () => {
  const { createTask } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const {
    beginTaskContextChatTurn,
    completeTaskContextChatTurn,
    submitTaskContextChatChangeRequest,
  } = await import('./task-context-chat');
  const taskId = await createTask({ title: 'Context chat forward feedback' });
  const db = await databaseConnection();
  db.prepare(`
    INSERT INTO stories(task_id, story_index, title, directory)
    VALUES(?, 1, 'Existing delivery unit', 'story-001')
  `).run(taskId);
  db.prepare(`
    UPDATE tasks SET total_stories = 1, agile_status = 'in dev' WHERE task_id = ?
  `).run(taskId);
  const claimed = await beginTaskContextChatTurn(taskId, 'Change this button label', 'codex');
  const submitted = await submitTaskContextChatChangeRequest({
    sessionId: claimed.session.sessionId,
    messageId: claimed.messageId,
    token: claimed.commandToken,
    requestKey: 'primary-action-label',
    title: 'Clarify the primary action label',
    request: 'Update the primary action wording without rewriting the completed delivery unit.',
    acceptance: 'The new label is visible from the real task detail page.',
  });
  assert.equal(submitted.taskId, taskId);
  assert.equal(submitted.created, true);
  assert.ok(db.prepare(`
    SELECT 1 FROM document_comments
    WHERE comment_id = ? AND intent = 'change_request' AND feedback_status = 'submitted'
  `).get(submitted.commentId));
  assert.ok(db.prepare(`
    SELECT 1 FROM documents
    WHERE document_id = ? AND kind = 'context-chat-change-requests'
  `).get(submitted.documentId));
  assert.equal((await inspectTaskDispatch(taskId)).some((item) => item.agent === 'feedback-agent'), false);
  const repeated = await submitTaskContextChatChangeRequest({
    sessionId: claimed.session.sessionId,
    messageId: claimed.messageId,
    token: claimed.commandToken,
    requestKey: 'primary-action-label',
    title: 'Duplicate retry',
    request: 'A retry with the same stable key must not create a duplicate.',
  });
  assert.equal(repeated.created, false);
  assert.equal(repeated.commentId, submitted.commentId);
  const secondRequest = await submitTaskContextChatChangeRequest({
    sessionId: claimed.session.sessionId,
    messageId: claimed.messageId,
    token: claimed.commandToken,
    requestKey: 'secondary-empty-state',
    title: 'Improve the empty state',
    request: 'Treat this as a separate independently deliverable change.',
  });
  assert.equal(secondRequest.created, true);
  assert.notEqual(secondRequest.commentId, submitted.commentId);
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS count
      FROM task_context_chat_change_requests
      WHERE session_id = ? AND message_id = ?
    `).get(claimed.session.sessionId, claimed.messageId) as { count: number }).count,
    2,
  );
  const completed = await completeTaskContextChatTurn({
    sessionId: claimed.session.sessionId,
    content: 'The change request entered the Feedback loop.',
    providerSessionId: 'codex-session-1',
    userMessageId: claimed.messageId,
  });
  assert.equal(completed.changeRequestSubmitted, true);
  assert.equal(completed.changeRequestCount, 2);
  const feedbackPipeline = await inspectTaskDispatch(taskId);
  assert.equal(feedbackPipeline[0]?.agent, 'feedback-agent');
  assert.equal(feedbackPipeline[0]?.pipeline, 'feedback-triage');
  assert.equal(feedbackPipeline[0]?.feedbackIds?.length, 2);
  db.prepare("UPDATE tasks SET agile_status = 'cancelled' WHERE task_id = ?").run(taskId);
});

test('does not pause the current task Delivery lane while context Chat is running', async () => {
  const { createTask } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const { beginTaskContextChatTurn, completeTaskContextChatTurn } = await import('./task-context-chat');
  const taskId = await createTask({ title: 'Context chat workspace coordination' });
  const db = await databaseConnection();
  db.prepare(`
    UPDATE tasks
    SET agile_status = 'ready for dev', total_stories = 1, analysis_index = 1,
        spec_resolved_index = 1, dev_index = 0, test_index = 0
    WHERE task_id = ?
  `).run(taskId);
  db.prepare(`
    INSERT INTO stories(task_id, story_index, title, directory)
    VALUES(?, 1, 'Ready unit', 'story-001')
  `).run(taskId);
  db.prepare(`
    INSERT INTO story_specs(
      spec_id, task_id, story_index, revision, status, spec_json, resolved_at
    ) VALUES('SPEC-chat-ready', ?, 1, 1, 'resolved', '{}', CURRENT_TIMESTAMP)
  `).run(taskId);
  const chat = await beginTaskContextChatTurn(taskId, 'Explain the current delivery state', 'codex');

  const pipeline = await inspectTaskDispatch(taskId);
  assert.deepEqual(pipeline.map((item) => [item.agent, item.storyIndex]), [['dev-agent', 1]]);

  await completeTaskContextChatTurn({
    sessionId: chat.session.sessionId,
    content: 'Workspace coordination verified.',
    providerSessionId: 'codex-session-2',
  });
});

test('rejects empty or oversized context chat input', async () => {
  const { createTask } = await import('./tasks');
  const { beginTaskContextChatTurn } = await import('./task-context-chat');
  const taskId = await createTask({ title: 'Context chat validation' });
  await assert.rejects(() => beginTaskContextChatTurn(taskId, '   ', 'codex'));
  await assert.rejects(() => beginTaskContextChatTurn(taskId, 'x'.repeat(20_001), 'codex'));
});
