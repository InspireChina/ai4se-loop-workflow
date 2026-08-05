ALTER TABLE execution_attempts ADD COLUMN executor_id TEXT;
ALTER TABLE execution_attempts ADD COLUMN configured_model TEXT;
ALTER TABLE execution_attempts ADD COLUMN reasoning_effort TEXT;
