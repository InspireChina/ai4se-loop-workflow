ALTER TABLE workflow_items ADD COLUMN dispatch_epoch INTEGER NOT NULL DEFAULT 1 CHECK(dispatch_epoch > 0);
ALTER TABLE workflow_items ADD COLUMN resume_pending INTEGER NOT NULL DEFAULT 0 CHECK(resume_pending IN (0, 1));
ALTER TABLE tasks ADD COLUMN workflow_engine TEXT NOT NULL DEFAULT 'legacy'
  CHECK(workflow_engine IN ('legacy', 'native'));

CREATE TABLE IF NOT EXISTS workflow_item_events (
  event_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES workflow_items(item_id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  event_type TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  actor TEXT NOT NULL,
  authority TEXT NOT NULL CHECK(authority IN ('agent', 'system', 'arbitration', 'human')),
  reason TEXT NOT NULL,
  execution_id TEXT REFERENCES execution_attempts(execution_id) ON DELETE SET NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(item_id, event_key)
);
CREATE INDEX IF NOT EXISTS idx_workflow_item_events_item ON workflow_item_events(item_id, created_at);
