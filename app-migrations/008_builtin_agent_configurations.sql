ALTER TABLE agent_configuration_sets
ADD COLUMN builtin_key TEXT
  CHECK(builtin_key IN ('default', 'openspec') OR builtin_key IS NULL);

ALTER TABLE agent_configuration_sets
ADD COLUMN context_adapter TEXT
  CHECK(context_adapter IN ('openspec') OR context_adapter IS NULL);

CREATE UNIQUE INDEX idx_agent_configuration_sets_builtin
  ON agent_configuration_sets(agent_id, builtin_key)
  WHERE builtin_key IS NOT NULL;

UPDATE agent_configuration_sets
SET builtin_key = 'default', context_adapter = NULL
WHERE name = '默认配置' AND builtin_key IS NULL;
