ALTER TABLE agent_configuration_sets
ADD COLUMN prompt_source TEXT NOT NULL DEFAULT 'system'
  CHECK(prompt_source IN ('system', 'human', 'evolution'));

ALTER TABLE agent_configuration_sets
ADD COLUMN prompt_reason TEXT;

ALTER TABLE agent_configuration_sets
ADD COLUMN prompt_template_version INTEGER NOT NULL DEFAULT 1
  CHECK(prompt_template_version >= 1);
