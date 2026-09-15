ALTER TABLE execution_attempts
  ADD COLUMN work_item_id TEXT REFERENCES workflow_items(item_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_execution_attempts_work_item
  ON execution_attempts(work_item_id, created_at);

UPDATE execution_attempts
SET work_item_id = (
  SELECT item.item_id
  FROM workflow_items item
  WHERE item.task_id = execution_attempts.task_id
    AND item.status NOT IN ('superseded', 'cancelled')
    AND item.work_key = CASE
      WHEN execution_attempts.agent = 'direct-agent'
        AND execution_attempts.pipeline = 'direct'
        THEN 'direct:execute'
      WHEN execution_attempts.agent = 'idea-context-agent'
        THEN 'ba:intent'
      WHEN execution_attempts.agent = 'business-design-agent'
        THEN 'ba:design'
      WHEN execution_attempts.agent = 'requirement-spec-agent'
        THEN 'ba:spec'
      WHEN execution_attempts.agent = 'spec-review-agent'
        THEN 'ba:review'
      WHEN execution_attempts.agent = 'backlog-agent'
        THEN 'delivery:context'
      WHEN execution_attempts.agent = 'repro-agent'
        THEN 'delivery:repro'
      WHEN execution_attempts.agent = 'story-splitter-agent'
        AND execution_attempts.pipeline IN ('split', 'resume')
        THEN 'delivery:plan'
      WHEN execution_attempts.agent = 'analyst-agent'
        AND execution_attempts.story_index IS NOT NULL
        THEN 'delivery:analysis:' || execution_attempts.story_index
      WHEN execution_attempts.agent = 'dev-agent'
        AND execution_attempts.story_index IS NOT NULL
        THEN 'delivery:dev:' || execution_attempts.story_index
      WHEN execution_attempts.agent = 'test-agent'
        AND execution_attempts.story_index IS NOT NULL
        THEN 'delivery:test:' || execution_attempts.story_index
      WHEN execution_attempts.agent = 'review-agent'
        AND execution_attempts.pipeline = 'review'
        THEN 'delivery:review'
      ELSE NULL
    END
  ORDER BY item.revision DESC
  LIMIT 1
)
WHERE work_item_id IS NULL;
