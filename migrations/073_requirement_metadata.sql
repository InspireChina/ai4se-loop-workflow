CREATE TABLE requirement_metadata (
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  metadata_key TEXT NOT NULL,
  metadata_value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(task_id, metadata_key)
);

CREATE INDEX idx_requirement_metadata_key
  ON requirement_metadata(metadata_key);

INSERT OR IGNORE INTO requirement_metadata(task_id, metadata_key, metadata_value)
SELECT task_id, 'source.reference_url', link
FROM tasks
WHERE link IS NOT NULL AND trim(link) != '';

INSERT OR IGNORE INTO requirement_metadata(task_id, metadata_key, metadata_value)
SELECT task_id, 'tracking.requirement_card_id', external_id
FROM tasks
WHERE external_id IS NOT NULL AND trim(external_id) != '';
