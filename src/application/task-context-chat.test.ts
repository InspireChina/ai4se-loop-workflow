import assert from 'node:assert/strict';
import test from 'node:test';

test('keeps one executor-bound context chat per task and persists its transcript', async () => {
  const { createTask } = await import('./tasks');
  const { beginTaskContextChatTurn, completeTaskContextChatTurn, getTaskContextChat } = await import('./task-context-chat');
  const taskId = await createTask({ title: 'Context chat isolation' });

  const first = await beginTaskContextChatTurn(taskId, 'What is the current state?', 'cursor');
  assert.equal(first.session.executor, 'cursor');
  assert.equal(first.writeAllowed, true);
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

test('switches to the read-only prompt while Dev or Test is running', async () => {
  const { createTask } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const { beginTaskContextChatTurn, completeTaskContextChatTurn } = await import('./task-context-chat');
  const devTaskId = await createTask({ title: 'Active Dev' });
  const taskId = await createTask({ title: 'Context chat dynamic mode' });
  const db = await databaseConnection();
  db.prepare(`
    INSERT INTO execution_attempts(
      execution_id, run_id, task_id, agent, pipeline, delegation_key,
      attempt, status, input_hash, input_json
    ) VALUES('EXEC-chat-dev', 'RUN-chat-dev', ?, 'dev-agent', 'dev', 'chat-dev-key', 1, 'running', 'hash', '{}')
  `).run(devTaskId);
  const claimed = await beginTaskContextChatTurn(taskId, 'Change this button label', 'codex');
  assert.equal(claimed.writeAllowed, false);
  await completeTaskContextChatTurn({
    sessionId: claimed.session.sessionId,
    content: 'Dev is active, so this turn is read-only.',
    providerSessionId: 'codex-session-1',
  });
  db.prepare("UPDATE execution_attempts SET status = 'applied' WHERE execution_id = 'EXEC-chat-dev'").run();
});

test('holds new Delivery work during a writable Chat turn while Analysis can continue', async () => {
  const { createTask, pipelineForTask } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const { beginTaskContextChatTurn, completeTaskContextChatTurn } = await import('./task-context-chat');
  const taskId = await createTask({ title: 'Context chat workspace coordination' });
  const db = await databaseConnection();
  db.prepare(`
    UPDATE tasks
    SET agile_status = 'ready for dev', total_stories = 2, analysis_index = 1,
        spec_resolved_index = 1, dev_index = 0, test_index = 0
    WHERE task_id = ?
  `).run(taskId);
  const chat = await beginTaskContextChatTurn(taskId, 'Tighten the empty-state wording', 'codex');
  assert.equal(chat.writeAllowed, true);

  const pipeline = await pipelineForTask(taskId);
  assert.deepEqual(pipeline.map((item) => [item.agent, item.storyIndex]), [['analyst-agent', 2]]);

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
