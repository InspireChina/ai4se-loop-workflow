import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { assertSupportedAgentExecutor, SUPPORTED_AGENT_EXECUTORS } from '../domain/agent-executor';
import { runSystemAssistancePrompt } from '../infrastructure/system-assistance-executor';
import { runTaskContextChatTurn } from '../infrastructure/task-context-chat-executor';
import { AGENT_EXECUTOR_OPTIONS, getAgentExecutorSettings, getFlowAgentDefaultRuntimeSettings, setAgentExecutorSettings, setFlowAgentDefaultRuntimeSettings } from './project-settings';

test('DJI accepts OMP and rejects other runtimes before launching processes', async () => {
  assert.deepEqual(SUPPORTED_AGENT_EXECUTORS, ['omp']);
  assert.deepEqual(AGENT_EXECUTOR_OPTIONS.map((item) => item.id), ['omp']);
  assert.doesNotThrow(() => assertSupportedAgentExecutor('omp'));
  for (const id of ['cursor', 'codex', 'claude'] as const) {
    assert.throws(() => assertSupportedAgentExecutor(id), /仅支持 OMP/);
    await assert.rejects(() => runSystemAssistancePrompt({ executorId: id, executionOptions: {}, prompt: 'prompt' }), /仅支持 OMP/);
    await assert.rejects(() => runTaskContextChatTurn({ executor: id } as Parameters<typeof runTaskContextChatTurn>[0]), /仅支持 OMP/);
    await assert.rejects(() => setAgentExecutorSettings({ executorId: id }));
    await assert.rejects(() => setFlowAgentDefaultRuntimeSettings({ executorId: id }));
  }
  assert.equal((await getAgentExecutorSettings()).executorId, 'omp');
  assert.equal((await getFlowAgentDefaultRuntimeSettings()).executorId, 'omp');
});

test('DJI migration converts every configuration scope without changing identity or OMP parameters', () => {
  const db = new Database(':memory:');
  try {
    db.exec(readFileSync('app-migrations/007_global_runtime_configurations.sql', 'utf8'));
    const insert = db.prepare(`INSERT INTO global_runtime_configurations(configuration_id, scope, agent_id, name, is_active, executor_id, codex_model, codex_reasoning_effort, codex_web_search, omp_model, omp_thinking) VALUES (?, ?, ?, ?, 1, ?, 'legacy-model', 'default', 0, 'provider/model', 'high')`);
    insert.run('s', 'system', null, 'system config', 'cursor');
    insert.run('f', 'flow', null, 'flow config', 'codex');
    insert.run('a', 'agent', 'dev-agent', 'agent config', 'claude');
    insert.run('o', 'agent', 'test-agent', 'OMP config', 'omp');
    db.exec(readFileSync('app-migrations/009_dji_omp_runtime.sql', 'utf8'));
    const rows = db.prepare('SELECT configuration_id, executor_id, is_active, omp_model, omp_thinking FROM global_runtime_configurations ORDER BY configuration_id').all();
    assert.deepEqual(rows, ['a', 'f', 'o', 's'].map((id) => ({ configuration_id: id, executor_id: 'omp', is_active: 1, omp_model: 'provider/model', omp_thinking: 'high' })));
  } finally { db.close(); }
});


test('old task chats switch to OMP without reusing another provider session or losing messages', async () => {
  const { createTask } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const { beginTaskContextChatTurn, completeTaskContextChatTurn, getTaskContextChat } = await import('./task-context-chat');
  const taskId = await createTask({ title: 'DJI legacy chat migration' });
  const first = await beginTaskContextChatTurn(taskId, 'Existing question', 'omp');
  await completeTaskContextChatTurn({ sessionId: first.session.sessionId, content: 'Existing answer', providerSessionId: 'old-provider-id' });
  const db = await databaseConnection();
  db.prepare("UPDATE task_context_chat_sessions SET executor = 'codex' WHERE session_id = ?").run(first.session.sessionId);
  const next = await beginTaskContextChatTurn(taskId, 'Continue', 'omp');
  assert.equal(next.session.executor, 'omp');
  assert.equal(next.session.providerSessionId, null);
  assert.equal(next.session.sessionId, first.session.sessionId);
  assert.deepEqual((await getTaskContextChat(taskId)).messages.map((message) => message.content), ['Existing question', 'Existing answer', 'Continue']);
});

test('OMP chat schema migration preserves populated transcripts and feedback links with foreign keys enabled', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    db.exec("CREATE TABLE tasks(task_id TEXT PRIMARY KEY); INSERT INTO tasks VALUES('task'); CREATE TABLE document_comments(comment_id TEXT PRIMARY KEY); INSERT INTO document_comments VALUES('comment');");
    db.exec(readFileSync('migrations/029_task_context_chat.sql', 'utf8'));
    db.exec(readFileSync('migrations/056_context_chat_forward_feedback.sql', 'utf8'));
    db.exec(readFileSync('migrations/057_context_chat_change_requests.sql', 'utf8'));
    db.exec("INSERT INTO task_context_chat_sessions(session_id, task_id, executor) VALUES('session', 'task', 'codex'); INSERT INTO task_context_chat_messages(message_id, session_id, role, content) VALUES('message', 'session', 'user', 'keep me'); INSERT INTO task_context_chat_change_requests(request_id, session_id, message_id, request_key, comment_id) VALUES('request', 'session', 'message', 'key', 'comment');");
    db.transaction(() => db.exec(readFileSync('migrations/113_dji_omp_context_chat.sql', 'utf8')))();
    assert.equal(db.prepare('SELECT content FROM task_context_chat_messages').pluck().get(), 'keep me');
    assert.equal(db.prepare('SELECT comment_id FROM task_context_chat_change_requests').pluck().get(), 'comment');
    db.prepare("UPDATE task_context_chat_sessions SET executor = 'omp'").run();
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally { db.close(); }
});
