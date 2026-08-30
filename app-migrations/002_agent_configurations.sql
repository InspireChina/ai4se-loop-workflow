CREATE TABLE IF NOT EXISTS agent_configuration_sets (
  configuration_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0 CHECK(is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(agent_id, name)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_configuration_sets_active
  ON agent_configuration_sets(agent_id)
  WHERE is_active = 1;

CREATE TABLE IF NOT EXISTS agent_configuration_documents (
  configuration_id TEXT NOT NULL REFERENCES agent_configuration_sets(configuration_id) ON DELETE CASCADE,
  command_chain_id TEXT NOT NULL,
  yaml_content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(configuration_id, command_chain_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_configuration_documents_chain
  ON agent_configuration_documents(command_chain_id, configuration_id);
