CREATE TABLE repair_takeover_event_deliveries (
  event_key TEXT PRIMARY KEY REFERENCES repair_takeover_events(event_key) ON DELETE CASCADE,
  delivered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
