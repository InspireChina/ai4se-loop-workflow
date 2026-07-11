-- Cursor loop SQLite schema.
-- Source of truth: .project/_loop/loop.db
-- Pipeline model: three integer indices + total_stories drive routing.

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  external_id TEXT,
  title TEXT NOT NULL,
  link TEXT,
  item_type TEXT NOT NULL DEFAULT 'other',
  priority TEXT,
  external_status TEXT,
  agile_status TEXT NOT NULL DEFAULT 'backlog' CHECK (
    agile_status IN (
      'backlog',
      'in plan',
      'in repro',
      'ready for dev',
      'in dev',
      'in review',
      'done',
      'cancelled',
      'blocked'
    )
  ),
  current_subagent TEXT,
  analysis_index INTEGER NOT NULL DEFAULT 0,
  dev_index INTEGER NOT NULL DEFAULT 0,
  test_index INTEGER NOT NULL DEFAULT 0,
  total_stories INTEGER NOT NULL DEFAULT 0,
  next_step TEXT,
  work_dir TEXT,
  blocked_reason TEXT,
  resume_status TEXT,
  resume_pending INTEGER NOT NULL DEFAULT 0 CHECK (resume_pending IN (0, 1)),
  analysis_approved_index INTEGER NOT NULL DEFAULT 0,
  review_approved INTEGER NOT NULL DEFAULT 0 CHECK (review_approved IN (0, 1)),
  approval_file TEXT,
  last_actor TEXT,
  owner TEXT,
  evidence TEXT,
  risk TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  CHECK (
    test_index >= 0
    AND test_index <= dev_index
    AND dev_index <= analysis_index
    AND analysis_index <= total_stories
    AND analysis_approved_index >= analysis_index
    AND analysis_approved_index <= analysis_index + 1
    AND analysis_approved_index <= total_stories
  ),
  CHECK (agile_status != 'ready for dev' OR total_stories > 0),
  CHECK (
    agile_status != 'in review'
    OR (
      total_stories > 0
      AND test_index = total_stories
      AND dev_index = total_stories
      AND analysis_index = total_stories
    )
  ),
  CHECK (
    agile_status != 'blocked'
    OR (
      current_subagent IS NOT NULL
      AND trim(current_subagent) != ''
      AND blocked_reason IS NOT NULL
      AND trim(blocked_reason) != ''
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_priority ON tasks(agile_status, priority, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_link_unique ON tasks(link) WHERE link IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_external ON tasks(external_id) WHERE external_id IS NOT NULL;
DROP INDEX IF EXISTS idx_tasks_single_active_dev_or_test;
DROP INDEX IF EXISTS idx_tasks_single_active_code_slot;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_single_active_code_slot
ON tasks((1))
WHERE agile_status IN ('in dev', 'in review')
   OR (agile_status = 'blocked' AND resume_status IN ('in dev', 'in review'))
   OR (agile_status = 'blocked' AND current_subagent = 'review-agent');

INSERT INTO meta(key, value) VALUES ('schema_version', '23')
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now');
