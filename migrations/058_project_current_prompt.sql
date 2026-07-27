ALTER TABLE agent_prompts
ADD COLUMN template_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE agent_prompts
ADD COLUMN source TEXT NOT NULL DEFAULT 'system';

UPDATE agent_prompts
SET content = content
  || CASE WHEN EXISTS (
    SELECT 1 FROM agent_prompt_overlays overlay
    WHERE overlay.agent_id = agent_prompts.agent_id
       AND trim(overlay.content) <> ''
  ) THEN (
    SELECT
      char(10) || char(10)
      || '# 项目 Agent Prompt 配置' || char(10) || char(10)
      || overlay.content
    FROM agent_prompt_overlays overlay
    WHERE overlay.agent_id = agent_prompts.agent_id
  ) ELSE '' END,
    version = version + CASE WHEN EXISTS (
      SELECT 1 FROM agent_prompt_overlays overlay
      WHERE overlay.agent_id = agent_prompts.agent_id
    ) THEN 1 ELSE 0 END,
    source = COALESCE((
      SELECT overlay.source
      FROM agent_prompt_overlays overlay
      WHERE overlay.agent_id = agent_prompts.agent_id
    ), 'system'),
    reason = COALESCE((
      SELECT overlay.reason
      FROM agent_prompt_overlays overlay
      WHERE overlay.agent_id = agent_prompts.agent_id
    ), reason),
    content_hash = '',
    updated_at = CURRENT_TIMESTAMP;

DROP TABLE IF EXISTS agent_prompt_candidates;
DROP TABLE IF EXISTS agent_prompt_overlays;

CREATE TABLE agent_prompt_candidates (
  candidate_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL UNIQUE REFERENCES agent_profiles(agent_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision >= 2),
  base_prompt_revision INTEGER NOT NULL CHECK(base_prompt_revision >= 1),
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source = 'evolution'),
  reason TEXT,
  evidence_json TEXT,
  remaining_runs INTEGER NOT NULL DEFAULT 3 CHECK(remaining_runs >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE execution_attempts
ADD COLUMN prompt_template_version INTEGER;

UPDATE agent_profiles
SET current_prompt_version = COALESCE((
      SELECT prompt.version
      FROM agent_prompts prompt
      WHERE prompt.agent_id = agent_profiles.agent_id
    ), current_prompt_version),
    candidate_prompt_version = NULL,
    canary_remaining = 0,
    updated_at = CURRENT_TIMESTAMP;

ALTER TABLE agent_profiles
DROP COLUMN current_prompt_overlay_revision;

ALTER TABLE execution_attempts
DROP COLUMN prompt_overlay_revision;
