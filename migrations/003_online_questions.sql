CREATE TABLE IF NOT EXISTS questions_new (
  question_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  story_index INTEGER,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  question TEXT NOT NULL,
  why TEXT,
  recommendation TEXT,
  answer TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  relative_path TEXT,
  source_agent TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO questions_new(question_id, task_id, story_index, kind, title, question, why, recommendation, answer, status, relative_path, source_agent, created_at, updated_at)
SELECT question_id, task_id, story_index, kind, title, question, NULL, recommendation, answer, status, relative_path, NULL, created_at, updated_at
FROM questions;

DROP TABLE questions;
ALTER TABLE questions_new RENAME TO questions;
CREATE INDEX IF NOT EXISTS idx_questions_task ON questions(task_id, status);

CREATE TABLE IF NOT EXISTS approvals_new (
  approval_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  story_index INTEGER,
  kind TEXT NOT NULL,
  decision TEXT NOT NULL DEFAULT 'pending',
  relative_path TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(task_id, story_index, kind)
);

INSERT INTO approvals_new(approval_id, task_id, story_index, kind, decision, relative_path, updated_at)
SELECT approval_id, task_id, story_index, kind, decision, relative_path, updated_at
FROM approvals;

DROP TABLE approvals;
ALTER TABLE approvals_new RENAME TO approvals;
