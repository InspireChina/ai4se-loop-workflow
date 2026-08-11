ALTER TABLE tasks ADD COLUMN code_slot_released INTEGER NOT NULL DEFAULT 0;

UPDATE tasks
SET code_slot_released = 1
WHERE run_state = 'waiting_for_runtime_input'
  AND current_subagent IN ('dev-agent', 'test-agent');
