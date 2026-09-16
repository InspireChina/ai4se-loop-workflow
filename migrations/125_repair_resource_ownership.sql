-- These fences do not expire with logical business claims or an Admin lease.
-- Physical cleanup plus explicit management handoff is required to release.
CREATE TABLE repair_resource_claims (
  resource_key TEXT NOT NULL,
  resource_scope TEXT NOT NULL,
  case_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation > 0),
  owner_id TEXT NOT NULL,
  supervision_token INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_revision INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('draining','owned','verifying')),
  reason TEXT NOT NULL,
  acquired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(resource_key,resource_scope)
);
CREATE TABLE repair_takeover_events (
  event_key TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
