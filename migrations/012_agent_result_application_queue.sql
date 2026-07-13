ALTER TABLE agent_results ADD COLUMN application_status TEXT NOT NULL DEFAULT 'applied'
  CHECK(application_status IN ('pending', 'applied', 'failed'));
ALTER TABLE agent_results ADD COLUMN application_error TEXT;
ALTER TABLE agent_results ADD COLUMN applied_at TEXT;
ALTER TABLE agent_results ADD COLUMN code_commit TEXT;

CREATE INDEX IF NOT EXISTS idx_agent_results_application_queue
  ON agent_results(application_status, created_at);

UPDATE agent_results
SET application_status = 'pending',
    application_error = '等待代码槽释放'
WHERE result_id IN (
  SELECT candidate.result_id
  FROM questions question
  JOIN agent_results candidate
    ON candidate.task_id = question.task_id
   AND candidate.story_index IS question.story_index
  WHERE question.status IN ('pending', 'answered')
    AND question.question LIKE '应用 Agent 结果失败：代码槽已被%'
    AND candidate.agent = 'dev-agent'
    AND candidate.outcome = 'completed'
);
