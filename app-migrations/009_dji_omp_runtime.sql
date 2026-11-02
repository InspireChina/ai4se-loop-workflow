-- DJI uses OMP for all new work. Preserve configuration identity and OMP overrides;
-- historical executions keep their original executor IDs for diagnostics.
UPDATE global_runtime_configurations
SET executor_id = 'omp', updated_at = CURRENT_TIMESTAMP
WHERE executor_id <> 'omp';
