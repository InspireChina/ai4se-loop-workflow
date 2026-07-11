CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  item_type TEXT NOT NULL,
  priority TEXT,
  agile_status TEXT NOT NULL,
  current_subagent TEXT,
  analysis_index INTEGER NOT NULL DEFAULT 0,
  dev_index INTEGER NOT NULL DEFAULT 0,
  test_index INTEGER NOT NULL DEFAULT 0,
  total_stories INTEGER NOT NULL DEFAULT 0,
  next_step TEXT,
  work_dir TEXT NOT NULL,
  blocked_reason TEXT,
  analysis_approved_index INTEGER NOT NULL DEFAULT 0,
  review_approved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (test_index >= 0 AND test_index <= dev_index AND dev_index <= analysis_index AND analysis_index <= total_stories)
);

CREATE TABLE IF NOT EXISTS stories (
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  story_index INTEGER NOT NULL,
  title TEXT NOT NULL,
  directory TEXT NOT NULL,
  PRIMARY KEY(task_id, story_index)
);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  story_index INTEGER,
  kind TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  content_hash TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(task_id, relative_path)
);

CREATE TABLE IF NOT EXISTS questions (
  question_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  story_index INTEGER,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  question TEXT NOT NULL,
  recommendation TEXT,
  answer TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  relative_path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  story_index INTEGER,
  kind TEXT NOT NULL,
  decision TEXT NOT NULL DEFAULT 'pending',
  relative_path TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(task_id, story_index, kind)
);

CREATE TABLE IF NOT EXISTS task_events (
  event_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  event_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(agile_status, priority, updated_at);
CREATE INDEX IF NOT EXISTS idx_questions_task ON questions(task_id, status);
