-- Keep workflow configuration identities; Prompt text is owned solely by .omp/agents.
UPDATE agent_configuration_sets SET prompt_content = '', prompt_hash = '', prompt_reason = '由当前工作目录 .omp/agents 管理';
DELETE FROM agent_configuration_prompt_candidates;
