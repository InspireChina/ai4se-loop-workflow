INSERT OR IGNORE INTO resource_claims(
  resource_key, owner_task_id, owner_lane, owner_story_index, owner_execution_id
)
SELECT
  'browser:exclusive', execution.task_id,
  COALESCE(execution.lane, CASE
    WHEN execution.agent = 'analyst-agent' THEN 'analysis'
    WHEN execution.agent IN ('dev-agent', 'test-agent') THEN 'delivery'
    ELSE 'control'
  END),
  execution.story_index, execution.execution_id
FROM execution_attempts execution
WHERE execution.agent IN ('backlog-agent', 'repro-agent', 'dev-agent', 'test-agent')
  AND execution.status IN ('planned', 'running', 'output_received', 'verifying', 'applying')
ORDER BY execution.created_at, execution.execution_id
LIMIT 1;
