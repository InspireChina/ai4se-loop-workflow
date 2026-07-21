import assert from 'node:assert/strict';
import test from 'node:test';

test('keeps one executor-bound context chat per task and persists its transcript', async () => {
  const { createTask } = await import('./tasks');
  const { beginTaskContextChatTurn, completeTaskContextChatTurn, getTaskContextChat } = await import('./task-context-chat');
  const taskId = await createTask({ title: 'Context chat isolation' });

  const first = await beginTaskContextChatTurn(taskId, 'What is the current state?', 'cursor');
  assert.equal(first.session.executor, 'cursor');
  await assert.rejects(() => beginTaskContextChatTurn(taskId, 'Can this overlap?', 'claude'), /正在回答/);

  const answer = await completeTaskContextChatTurn(first.session.sessionId, 'The task is in backlog.', 'cursor-session-1');
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
});

test('rejects empty or oversized context chat input', async () => {
  const { createTask } = await import('./tasks');
  const { beginTaskContextChatTurn } = await import('./task-context-chat');
  const taskId = await createTask({ title: 'Context chat validation' });
  await assert.rejects(() => beginTaskContextChatTurn(taskId, '   ', 'codex'));
  await assert.rejects(() => beginTaskContextChatTurn(taskId, 'x'.repeat(20_001), 'codex'));
});
