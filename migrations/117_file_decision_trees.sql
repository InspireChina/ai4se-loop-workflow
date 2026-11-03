-- Decision content lives in immutable JSON files. These rows only index the
-- current tree reference; node identities/statuses remain usable by Workflow SQL.
CREATE TABLE decision_tree_files (
  kind TEXT NOT NULL CHECK(kind IN ('questions', 'command_chain_decisions')),
  scope_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  file_ref TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(kind, scope_id)
);
CREATE INDEX idx_decision_tree_files_task ON decision_tree_files(task_id, kind);

-- The storage trigger increments this counter when replacing content with file
-- references. This distinguishes internal reference writes from domain mutations.
ALTER TABLE questions ADD COLUMN decision_file_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE command_chain_decisions ADD COLUMN decision_file_generation INTEGER NOT NULL DEFAULT 0;
