ALTER TABLE agent_runtime_settings
ADD COLUMN omp_model TEXT NOT NULL DEFAULT '';

ALTER TABLE agent_runtime_settings
ADD COLUMN omp_thinking TEXT NOT NULL DEFAULT 'default'
CHECK(omp_thinking IN ('default', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'));
