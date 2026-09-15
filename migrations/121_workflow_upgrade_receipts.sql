-- Successful startup-boundary upgrades are committed with their graph edits.
-- Failures remain in the run diagnostic log; no partial success is recorded.
CREATE TABLE IF NOT EXISTS workflow_upgrade_receipts (
  run_id TEXT PRIMARY KEY REFERENCES loop_runs(run_id),
  supervision_token INTEGER NOT NULL,
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
