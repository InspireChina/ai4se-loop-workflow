ALTER TABLE tasks ADD COLUMN spec_resolved_index INTEGER NOT NULL DEFAULT 0;

UPDATE tasks
SET spec_resolved_index = analysis_index;
