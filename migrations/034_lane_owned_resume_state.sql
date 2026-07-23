UPDATE tasks
SET resume_pending = 0
WHERE resume_pending = 1
  AND current_subagent IN ('analyst-agent', 'dev-agent', 'test-agent');
