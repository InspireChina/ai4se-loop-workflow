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
