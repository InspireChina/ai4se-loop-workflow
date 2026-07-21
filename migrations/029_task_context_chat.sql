CREATE TABLE IF NOT EXISTS task_context_chat_sessions (
  session_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id) ON DELETE CASCADE,
  executor TEXT NOT NULL CHECK(executor IN ('cursor', 'codex', 'claude')),
  provider_session_id TEXT,
  state TEXT NOT NULL DEFAULT 'idle' CHECK(state IN ('idle', 'running')),
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS task_context_chat_messages (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES task_context_chat_sessions(session_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_task_context_chat_messages_session
  ON task_context_chat_messages(session_id, created_at);
