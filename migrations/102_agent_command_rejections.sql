CREATE TABLE agent_command_rejections (
  rejection_id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id TEXT NOT NULL REFERENCES execution_attempts(execution_id) ON DELETE CASCADE,
  draft_id TEXT REFERENCES agent_work_drafts(draft_id) ON DELETE SET NULL,
  command_chain_id TEXT,
  definition_version INTEGER,
  command TEXT NOT NULL,
  error_code TEXT NOT NULL,
  error_path TEXT,
  signature TEXT NOT NULL,
  occurrence INTEGER NOT NULL CHECK(occurrence > 0),
  message TEXT NOT NULL,
  issues_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_agent_command_rejections_execution_signature
ON agent_command_rejections(execution_id, signature, occurrence);

CREATE INDEX idx_agent_command_rejections_operational_analysis
ON agent_command_rejections(created_at, command_chain_id, definition_version, error_code);
