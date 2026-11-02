-- Rebuild with child snapshots: migrations run inside a transaction with FK checks enabled.
CREATE TEMP TABLE dji_chat_sessions AS SELECT * FROM task_context_chat_sessions;
CREATE TEMP TABLE dji_chat_messages AS SELECT * FROM task_context_chat_messages;
CREATE TEMP TABLE dji_chat_requests AS SELECT * FROM task_context_chat_change_requests;
DROP TABLE task_context_chat_change_requests;
DROP TABLE task_context_chat_messages;
DROP TABLE task_context_chat_sessions;
CREATE TABLE IF NOT EXISTS task_context_chat_sessions (
  session_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id) ON DELETE CASCADE,
  executor TEXT NOT NULL CHECK(executor IN ('cursor', 'codex', 'claude', 'omp')),
  provider_session_id TEXT,
  state TEXT NOT NULL DEFAULT 'idle' CHECK(state IN ('idle', 'running')),
  last_error TEXT,
  command_token_hash TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);


INSERT INTO task_context_chat_sessions(session_id, task_id, executor, provider_session_id, state, last_error, command_token_hash, created_at, updated_at)
SELECT session_id, task_id, executor, provider_session_id, state, last_error, command_token_hash, created_at, updated_at FROM dji_chat_sessions;
CREATE TABLE IF NOT EXISTS task_context_chat_messages (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES task_context_chat_sessions(session_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_task_context_chat_messages_session
  ON task_context_chat_messages(session_id, created_at);

INSERT INTO task_context_chat_messages SELECT * FROM dji_chat_messages;
CREATE TABLE task_context_chat_change_requests (
  request_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES task_context_chat_sessions(session_id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES task_context_chat_messages(message_id) ON DELETE CASCADE,
  request_key TEXT NOT NULL,
  comment_id TEXT NOT NULL UNIQUE REFERENCES document_comments(comment_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(session_id, message_id, request_key)
);

CREATE INDEX idx_task_context_chat_change_requests_turn
  ON task_context_chat_change_requests(session_id, message_id, created_at);

INSERT INTO task_context_chat_change_requests SELECT * FROM dji_chat_requests;
DROP TABLE dji_chat_requests;
DROP TABLE dji_chat_messages;
DROP TABLE dji_chat_sessions;
