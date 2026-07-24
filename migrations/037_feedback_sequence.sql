ALTER TABLE feedback_batches ADD COLUMN batch_number INTEGER
  CHECK(batch_number IS NULL OR batch_number > 0);

UPDATE feedback_batches AS current_batch
SET batch_number = (
  SELECT COUNT(*)
  FROM feedback_batches AS earlier_batch
  WHERE earlier_batch.task_id = current_batch.task_id
    AND earlier_batch.rowid <= current_batch.rowid
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_batches_task_number
  ON feedback_batches(task_id, batch_number);

ALTER TABLE feedback_groups ADD COLUMN group_order INTEGER
  CHECK(group_order IS NULL OR group_order > 0);

UPDATE feedback_groups AS current_group
SET group_order = (
  SELECT COUNT(*)
  FROM feedback_groups AS earlier_group
  WHERE earlier_group.batch_id = current_group.batch_id
    AND earlier_group.rowid <= current_group.rowid
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_groups_batch_order
  ON feedback_groups(batch_id, group_order);
