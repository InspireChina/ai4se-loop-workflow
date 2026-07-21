import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentExecutorId } from '../domain/agent-executor';
import { databaseConnection } from '../infrastructure/database';

const messageSchema = z.string().trim().min(1, '请输入问题').max(20_000, '单条消息不能超过 20000 个字符');

export type TaskContextChatSession = {
  sessionId: string;
  taskId: string;
  executor: AgentExecutorId;
  providerSessionId: string | null;
  state: 'idle' | 'running';
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TaskContextChatMessage = {
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
};

type SessionRow = {
  session_id: string;
  task_id: string;
  executor: AgentExecutorId;
  provider_session_id: string | null;
  state: 'idle' | 'running';
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

function mapSession(row: SessionRow): TaskContextChatSession {
  return {
    sessionId: row.session_id,
    taskId: row.task_id,
    executor: row.executor,
    providerSessionId: row.provider_session_id,
    state: row.state,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getTaskContextChat(taskId: string) {
  const db = await databaseConnection();
  const session = db.prepare('SELECT * FROM task_context_chat_sessions WHERE task_id = ?').get(taskId) as SessionRow | undefined;
  if (!session) return { session: null, messages: [] as TaskContextChatMessage[] };
  const messages = db.prepare(`
    SELECT message_id, role, content, created_at
    FROM task_context_chat_messages
    WHERE session_id = ?
    ORDER BY created_at, rowid
  `).all(session.session_id) as { message_id: string; role: 'user' | 'assistant'; content: string; created_at: string }[];
  return {
    session: mapSession(session),
    messages: messages.map((message) => ({
      messageId: message.message_id,
      role: message.role,
      content: message.content,
      createdAt: message.created_at,
    })),
  };
}

export async function beginTaskContextChatTurn(taskId: string, content: unknown, requestedExecutor: AgentExecutorId) {
  const message = messageSchema.parse(content);
  const db = await databaseConnection();
  return db.transaction(() => {
    const task = db.prepare('SELECT task_id FROM tasks WHERE task_id = ?').get(taskId);
    if (!task) throw new Error(`需求不存在：${taskId}`);
    let row = db.prepare('SELECT * FROM task_context_chat_sessions WHERE task_id = ?').get(taskId) as SessionRow | undefined;
    if (!row) {
      const sessionId = randomUUID();
      db.prepare(`
        INSERT INTO task_context_chat_sessions(session_id, task_id, executor)
        VALUES(?, ?, ?)
      `).run(sessionId, taskId, requestedExecutor);
      row = db.prepare('SELECT * FROM task_context_chat_sessions WHERE session_id = ?').get(sessionId) as SessionRow;
    }
    if (row.state === 'running') {
      const stale = db.prepare("SELECT datetime(?) < datetime('now', '-30 minutes') AS stale").get(row.updated_at) as { stale: number };
      if (!stale.stale) throw new Error('上下文 Agent 正在回答上一条消息，请稍后再试');
    }
    const messageId = randomUUID();
    db.prepare(`
      INSERT INTO task_context_chat_messages(message_id, session_id, role, content)
      VALUES(?, ?, 'user', ?)
    `).run(messageId, row.session_id, message);
    db.prepare(`
      UPDATE task_context_chat_sessions
      SET state = 'running', last_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE session_id = ?
    `).run(row.session_id);
    return { session: { ...mapSession(row), state: 'running' as const, lastError: null }, message, messageId };
  })();
}

export async function completeTaskContextChatTurn(sessionId: string, content: string, providerSessionId: string) {
  const answer = content.trim();
  if (!answer) throw new Error('上下文 Agent 没有返回回答');
  const db = await databaseConnection();
  return db.transaction(() => {
    const messageId = randomUUID();
    db.prepare(`
      INSERT INTO task_context_chat_messages(message_id, session_id, role, content)
      VALUES(?, ?, 'assistant', ?)
    `).run(messageId, sessionId, answer);
    db.prepare(`
      UPDATE task_context_chat_sessions
      SET provider_session_id = ?, state = 'idle', last_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE session_id = ?
    `).run(providerSessionId, sessionId);
    const row = db.prepare('SELECT created_at FROM task_context_chat_messages WHERE message_id = ?').get(messageId) as { created_at: string };
    return { messageId, role: 'assistant' as const, content: answer, createdAt: row.created_at };
  })();
}

export async function failTaskContextChatTurn(sessionId: string, error: unknown) {
  const reason = error instanceof Error ? error.message : String(error);
  const db = await databaseConnection();
  db.prepare(`
    UPDATE task_context_chat_sessions
    SET state = 'idle', last_error = ?, updated_at = CURRENT_TIMESTAMP
    WHERE session_id = ?
  `).run(reason.slice(0, 4000), sessionId);
}
