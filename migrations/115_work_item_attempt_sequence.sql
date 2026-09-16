ALTER TABLE execution_attempts
  ADD COLUMN work_item_attempt INTEGER;

UPDATE execution_attempts AS current
SET work_item_attempt = (
  SELECT COUNT(*)
  FROM execution_attempts prior
  WHERE prior.work_item_id = current.work_item_id
    AND (
      prior.created_at < current.created_at
      OR (prior.created_at = current.created_at AND prior.execution_id <= current.execution_id)
    )
)
WHERE current.work_item_id IS NOT NULL
  AND current.work_item_attempt IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_attempts_work_item_attempt
  ON execution_attempts(work_item_id, work_item_attempt)
  WHERE work_item_id IS NOT NULL AND work_item_attempt IS NOT NULL;
