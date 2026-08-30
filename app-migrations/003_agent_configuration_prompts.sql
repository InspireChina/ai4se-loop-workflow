ALTER TABLE agent_configuration_sets
ADD COLUMN prompt_content TEXT NOT NULL DEFAULT '';

ALTER TABLE agent_configuration_sets
ADD COLUMN prompt_hash TEXT NOT NULL DEFAULT '';

ALTER TABLE agent_configuration_sets
ADD COLUMN prompt_revision INTEGER NOT NULL DEFAULT 1 CHECK(prompt_revision >= 1);
