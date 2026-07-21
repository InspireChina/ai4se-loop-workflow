CREATE TABLE IF NOT EXISTS task_lanes (
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  lane TEXT NOT NULL CHECK(lane IN ('analysis', 'delivery')),
  status TEXT NOT NULL CHECK(status IN (
    'pending', 'runnable', 'running', 'waiting_for_answers',
    'waiting_for_runtime_input', 'system_blocked', 'completed'
  )),
  current_agent TEXT,
  current_story_index INTEGER,
  blocked_reason TEXT,
  resume_pending INTEGER NOT NULL DEFAULT 0,
  ready_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(task_id, lane)
);

INSERT OR IGNORE INTO task_lanes(
  task_id, lane, status, current_agent, current_story_index,
  blocked_reason, resume_pending, ready_at, updated_at
)
SELECT
  task_id,
  'analysis',
  CASE
    WHEN agile_status IN ('done', 'cancelled', 'in review', 'ready_to_close') THEN 'completed'
    WHEN total_stories = 0 THEN 'pending'
    WHEN run_state = 'waiting_for_answers' AND current_subagent = 'analyst-agent' THEN 'waiting_for_answers'
    WHEN run_state = 'waiting_for_runtime_input' AND current_subagent = 'analyst-agent' THEN 'waiting_for_runtime_input'
    WHEN agile_status = 'blocked' AND current_subagent = 'analyst-agent' THEN 'system_blocked'
    WHEN analysis_index < total_stories THEN 'runnable'
    ELSE 'completed'
  END,
  CASE WHEN current_subagent = 'analyst-agent' THEN current_subagent END,
  CASE WHEN current_subagent = 'analyst-agent' THEN MIN(total_stories, analysis_index + 1) END,
  CASE WHEN current_subagent = 'analyst-agent' THEN blocked_reason END,
  CASE WHEN current_subagent = 'analyst-agent' THEN resume_pending ELSE 0 END,
  CASE
    WHEN run_state NOT IN ('waiting_for_answers', 'waiting_for_runtime_input')
      AND NOT (agile_status = 'blocked' AND current_subagent = 'analyst-agent')
      AND analysis_index < total_stories
    THEN updated_at
  END,
  updated_at
FROM tasks;

INSERT OR IGNORE INTO task_lanes(
  task_id, lane, status, current_agent, current_story_index,
  blocked_reason, resume_pending, ready_at, updated_at
)
SELECT
  task_id,
  'delivery',
  CASE
    WHEN agile_status IN ('done', 'cancelled', 'in review', 'ready_to_close') THEN 'completed'
    WHEN total_stories = 0 THEN 'pending'
    WHEN run_state = 'waiting_for_runtime_input' AND current_subagent IN ('dev-agent', 'test-agent') THEN 'waiting_for_runtime_input'
    WHEN agile_status = 'blocked' AND current_subagent IN ('dev-agent', 'test-agent') THEN 'system_blocked'
    WHEN test_index < dev_index OR dev_index < analysis_index THEN 'runnable'
    WHEN analysis_index = total_stories AND test_index = total_stories THEN 'completed'
    ELSE 'pending'
  END,
  CASE WHEN current_subagent IN ('dev-agent', 'test-agent') THEN current_subagent END,
  CASE
    WHEN current_subagent = 'test-agent' THEN MIN(total_stories, test_index + 1)
    WHEN current_subagent = 'dev-agent' THEN MIN(total_stories, dev_index + 1)
  END,
  CASE WHEN current_subagent IN ('dev-agent', 'test-agent') THEN blocked_reason END,
  CASE WHEN current_subagent IN ('dev-agent', 'test-agent') THEN resume_pending ELSE 0 END,
  CASE
    WHEN run_state != 'waiting_for_runtime_input'
      AND NOT (agile_status = 'blocked' AND current_subagent IN ('dev-agent', 'test-agent'))
      AND (test_index < dev_index OR dev_index < analysis_index)
    THEN updated_at
  END,
  updated_at
FROM tasks;

CREATE INDEX IF NOT EXISTS idx_task_lanes_schedule
  ON task_lanes(lane, status, ready_at, updated_at);

ALTER TABLE execution_attempts ADD COLUMN lane TEXT;

UPDATE execution_attempts
SET lane = CASE
  WHEN agent = 'analyst-agent' THEN 'analysis'
  WHEN agent IN ('dev-agent', 'test-agent') THEN 'delivery'
  ELSE 'control'
END
WHERE lane IS NULL;

CREATE INDEX IF NOT EXISTS idx_execution_attempts_lane_active
  ON execution_attempts(task_id, lane, status, created_at);
