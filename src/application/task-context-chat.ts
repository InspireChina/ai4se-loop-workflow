import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentExecutorId } from '../domain/agent-executor';
import { databaseConnection, hash } from '../infrastructure/database';
import { EXECUTION_FAILURE_MAX_RETRIES } from './executions';

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

export function taskContextChatTurnIsRunning(db: Awaited<ReturnType<typeof databaseConnection>>, taskId: string) {
  return Boolean(db.prepare(`
    SELECT 1 FROM task_context_chat_sessions
    WHERE task_id = ?
      AND state = 'running'
      AND datetime(updated_at) >= datetime('now', '-30 minutes')
    LIMIT 1
  `).get(taskId));
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
    const commandToken = randomUUID();
    const messageId = randomUUID();
    db.prepare(`
      INSERT INTO task_context_chat_messages(message_id, session_id, role, content)
      VALUES(?, ?, 'user', ?)
    `).run(messageId, row.session_id, message);
    db.prepare(`
      UPDATE task_context_chat_sessions
      SET state = 'running', command_token_hash = ?, last_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE session_id = ?
    `).run(hash(commandToken), row.session_id);
    return {
      session: { ...mapSession(row), state: 'running' as const, lastError: null },
      message,
      messageId,
      commandToken,
    };
  }).immediate();
}

const chatChangeRequestSchema = z.object({
  sessionId: z.string().uuid(),
  messageId: z.string().uuid(),
  token: z.string().uuid(),
  requestKey: z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9._-]*$/),
  title: z.string().trim().min(1).max(240),
  request: z.string().trim().min(1).max(8000),
  acceptance: z.string().trim().max(4000).optional().default(''),
});

export async function submitTaskContextChatChangeRequest(input: unknown) {
  const value = chatChangeRequestSchema.parse(input);
  const db = await databaseConnection();
  return db.transaction(() => {
    const session = db.prepare(`
      SELECT session_id, task_id, state, command_token_hash
      FROM task_context_chat_sessions
      WHERE session_id = ?
    `).get(value.sessionId) as {
      session_id: string;
      task_id: string;
      state: 'idle' | 'running';
      command_token_hash: string | null;
    } | undefined;
    if (!session || session.state !== 'running' || !session.command_token_hash || hash(value.token) !== session.command_token_hash) {
      throw new Error('上下文 Chat 变更命令凭证无效或已使用');
    }
    const message = db.prepare(`
      SELECT message_id
      FROM task_context_chat_messages
      WHERE message_id = ? AND session_id = ? AND role = 'user'
    `).get(value.messageId, session.session_id);
    if (!message) throw new Error('变更请求不属于当前上下文 Chat turn');
    const existing = db.prepare(`
      SELECT request_id, comment_id
      FROM task_context_chat_change_requests
      WHERE session_id = ? AND message_id = ? AND request_key = ?
    `).get(session.session_id, value.messageId, value.requestKey) as {
      request_id: string;
      comment_id: string;
    } | undefined;
    if (existing) {
      const existingDocument = db.prepare(`
        SELECT document_id FROM document_comments WHERE comment_id = ?
      `).get(existing.comment_id) as { document_id: string } | undefined;
      if (!existingDocument) throw new Error('上下文 Chat 变更请求记录不完整');
      return {
        taskId: session.task_id,
        documentId: existingDocument.document_id,
        commentId: existing.comment_id,
        requestId: existing.request_id,
        created: false,
      };
    }
    const task = db.prepare(`
      SELECT task_id, agile_status, total_stories
      FROM tasks WHERE task_id = ?
    `).get(session.task_id) as { task_id: string; agile_status: string; total_stories: number } | undefined;
    if (!task) throw new Error('需求不存在');
    if (['done', 'cancelled'].includes(task.agile_status)) throw new Error('终态需求不能追加变更请求，请新建需求');
    if (task.total_stories < 1) throw new Error('当前需求尚未形成交付单元，请先完成需求整理和交付拆分');

    let document = db.prepare(`
      SELECT document_id, revision
      FROM documents
      WHERE task_id = ? AND story_index IS NULL AND kind = 'context-chat-change-requests'
      ORDER BY rowid
      LIMIT 1
    `).get(task.task_id) as { document_id: string; revision: number } | undefined;
    if (!document) {
      document = { document_id: randomUUID(), revision: 1 };
      db.prepare(`
        INSERT INTO documents(
          document_id, task_id, story_index, kind, title, content, format, source_agent
        ) VALUES(?, ?, NULL, 'context-chat-change-requests', '上下文对话变更请求',
          '# 上下文对话变更请求\n\n本页记录从右侧上下文对话提交、等待 Feedback 闭环处理的修改请求。历史交付事实不会被改写。',
          'markdown', 'human')
      `).run(document.document_id, task.task_id);
    }

    const commentId = randomUUID();
    const requestId = randomUUID();
    const content = [
      `## ${value.title}`,
      '',
      value.request,
      ...(value.acceptance ? ['', '验收关注：', value.acceptance] : []),
    ].join('\n');
    db.prepare(`
      INSERT INTO document_comments(
        comment_id, document_id, task_id, document_revision, agent_id,
        anchor_type, content, intent, status, feedback_status, submitted_at
      ) VALUES(?, ?, ?, ?, NULL, 'file', ?, 'change_request', 'open', 'submitted', CURRENT_TIMESTAMP)
    `).run(commentId, document.document_id, task.task_id, document.revision, content);
    db.prepare(`
      INSERT INTO task_events(event_id, task_id, actor, event_type, summary)
      VALUES(?, ?, 'context-chat-agent', 'ContextChatChangeRequested', ?)
    `).run(randomUUID(), task.task_id, `上下文对话提交变更请求：${value.title}`);
    db.prepare(`
      INSERT INTO task_context_chat_change_requests(
        request_id, session_id, message_id, request_key, comment_id
      ) VALUES(?, ?, ?, ?, ?)
    `).run(requestId, session.session_id, value.messageId, value.requestKey, commentId);
    return {
      taskId: task.task_id,
      documentId: document.document_id,
      commentId,
      requestId,
      created: true,
    };
  }).immediate();
}

export async function completeTaskContextChatTurn(input: {
  sessionId: string;
  content: string;
  providerSessionId: string;
  userMessageId?: string;
}) {
  const answer = input.content.trim();
  if (!answer) throw new Error('上下文 Agent 没有返回回答');
  const db = await databaseConnection();
  return db.transaction(() => {
    const sessionBeforeCompletion = db.prepare(`
      SELECT command_token_hash FROM task_context_chat_sessions WHERE session_id = ?
    `).get(input.sessionId) as { command_token_hash: string | null } | undefined;
    if (!sessionBeforeCompletion) throw new Error('上下文 Chat 会话不存在');
    const changeRequestCount = input.userMessageId
      ? (db.prepare(`
          SELECT COUNT(*) AS count
          FROM task_context_chat_change_requests
          WHERE session_id = ? AND message_id = ?
        `).get(input.sessionId, input.userMessageId) as { count: number }).count
      : 0;
    const messageId = randomUUID();
    db.prepare(`
      INSERT INTO task_context_chat_messages(message_id, session_id, role, content)
      VALUES(?, ?, 'assistant', ?)
    `).run(messageId, input.sessionId, answer);
    db.prepare(`
      UPDATE task_context_chat_sessions
      SET provider_session_id = ?, state = 'idle', command_token_hash = NULL,
          last_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE session_id = ?
    `).run(input.providerSessionId, input.sessionId);
    const row = db.prepare('SELECT created_at FROM task_context_chat_messages WHERE message_id = ?').get(messageId) as { created_at: string };
    return {
      messageId,
      role: 'assistant' as const,
      content: answer,
      createdAt: row.created_at,
      changeRequestSubmitted: changeRequestCount > 0,
      changeRequestCount,
    };
  })();
}

export async function recordTaskContextChatFailureAttempt(input: {
  sessionId: string;
  error: unknown;
  failureAttempt: number;
  maxRetries?: number;
}) {
  const maxRetries = input.maxRetries ?? EXECUTION_FAILURE_MAX_RETRIES;
  const willRetry = input.failureAttempt <= maxRetries;
  const reason = input.error instanceof Error ? input.error.message : String(input.error);
  const db = await databaseConnection();
  db.transaction(() => {
    const session = db.prepare(`
      SELECT task_id, executor FROM task_context_chat_sessions WHERE session_id = ?
    `).get(input.sessionId) as { task_id: string; executor: AgentExecutorId } | undefined;
    if (!session) return;
    db.prepare(`
      UPDATE task_context_chat_sessions
      SET state = ?, command_token_hash = CASE WHEN ? THEN command_token_hash ELSE NULL END,
          last_error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE session_id = ?
    `).run(willRetry ? 'running' : 'idle', willRetry ? 1 : 0, reason.slice(0, 4000), input.sessionId);
    const outcome = willRetry
      ? `第 ${input.failureAttempt} 次失败，自动重试 ${input.failureAttempt}/${maxRetries}`
      : `第 ${input.failureAttempt} 次失败，${maxRetries} 次自动重试已耗尽`;
    db.prepare(`
      INSERT INTO task_events(event_id, task_id, actor, event_type, summary)
      VALUES(?, ?, 'system', ?, ?)
    `).run(
      randomUUID(),
      session.task_id,
      willRetry ? 'AgentExecutionRetryScheduled' : 'AgentExecutionRetriesExhausted',
      `context-chat · context-chat-agent(${session.executor}) · ${outcome} · context-chat-execution · session=${input.sessionId}：${reason}`,
    );
  }).immediate();
  return { willRetry, failureAttempt: input.failureAttempt, maxRetries, reason };
}
