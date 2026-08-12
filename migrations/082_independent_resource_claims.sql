CREATE TABLE IF NOT EXISTS resource_claims (
  resource_key TEXT PRIMARY KEY,
  owner_task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  owner_lane TEXT NOT NULL,
  owner_story_index INTEGER,
  owner_execution_id TEXT REFERENCES execution_attempts(execution_id) ON DELETE SET NULL,
  acquired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO resource_claims(
  resource_key, owner_task_id, owner_lane, owner_story_index, owner_execution_id
)
SELECT 'code:workspace', candidate.task_id, 'delivery', candidate.story_index, candidate.execution_id
FROM (
  SELECT execution.task_id, execution.story_index, execution.execution_id, 0 AS priority
  FROM execution_attempts execution
  WHERE execution.agent IN ('dev-agent', 'test-agent')
    AND execution.status IN ('planned', 'running', 'output_received', 'verifying', 'applying')
  UNION ALL
  SELECT task.task_id, task.test_index + 1, NULL, 1 AS priority
  FROM tasks task
  WHERE task.agile_status NOT IN ('done', 'cancelled')
    AND task.code_slot_released = 0
    AND task.test_index < task.dev_index
) candidate
ORDER BY candidate.priority, candidate.task_id
LIMIT 1;
