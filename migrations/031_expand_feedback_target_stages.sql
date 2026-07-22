ALTER TABLE document_comments RENAME COLUMN target_stage TO target_stage_legacy;

ALTER TABLE document_comments ADD COLUMN target_stage TEXT
  CHECK(target_stage IN ('context', 'repro', 'plan', 'analysis', 'dev', 'test', 'review'));

UPDATE document_comments
SET target_stage = target_stage_legacy;

ALTER TABLE document_comments DROP COLUMN target_stage_legacy;
