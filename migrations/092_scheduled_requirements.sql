CREATE TABLE IF NOT EXISTS scheduled_requirement_plans (
  plan_id TEXT PRIMARY KEY,
  recurrence_kind TEXT NOT NULL CHECK(recurrence_kind IN ('once', 'daily', 'weekdays', 'weekly', 'monthly')),
  timezone TEXT NOT NULL,
  local_time TEXT,
  weekday INTEGER CHECK(weekday IS NULL OR (weekday >= 0 AND weekday <= 6)),
  day_of_month INTEGER CHECK(day_of_month IS NULL OR (day_of_month >= 1 AND day_of_month <= 31)),
  once_at TEXT,
  template_title TEXT NOT NULL,
  template_description TEXT,
  template_pipeline TEXT NOT NULL,
  template_priority TEXT NOT NULL,
  template_metadata_json TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  schedule_revision INTEGER NOT NULL DEFAULT 1,
  next_trigger_at TEXT,
  last_trigger_at TEXT,
  last_task_id TEXT REFERENCES tasks(task_id) ON DELETE SET NULL,
  last_error TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(
    (recurrence_kind = 'once' AND once_at IS NOT NULL)
    OR (recurrence_kind != 'once' AND local_time IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_scheduled_requirement_plans_due
  ON scheduled_requirement_plans(enabled, deleted_at, next_trigger_at);

CREATE TABLE IF NOT EXISTS scheduled_requirement_occurrences (
  plan_id TEXT NOT NULL REFERENCES scheduled_requirement_plans(plan_id) ON DELETE CASCADE,
  scheduled_for TEXT NOT NULL,
  plan_revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('failed', 'created')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  retry_at TEXT,
  task_id TEXT REFERENCES tasks(task_id) ON DELETE SET NULL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(plan_id, scheduled_for)
);

CREATE INDEX IF NOT EXISTS idx_scheduled_requirement_occurrences_retry
  ON scheduled_requirement_occurrences(status, retry_at);
