CREATE TABLE IF NOT EXISTS runtime_event_revisions (
  topic TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO runtime_event_revisions(topic, revision)
VALUES('dispatch.invalidated', 0);

INSERT OR IGNORE INTO runtime_event_revisions(topic, revision)
VALUES('schedule.invalidated', 0);

INSERT OR IGNORE INTO runtime_event_revisions(topic, revision)
VALUES('execution.cancel-requested', 0);

INSERT OR IGNORE INTO runtime_event_revisions(topic, revision)
VALUES('lifecycle.runner-stop-requested', 0);
