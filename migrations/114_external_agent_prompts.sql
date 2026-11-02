-- Remove obsolete internal Prompt copies, without changing workflow or memory state.
DELETE FROM project_agent_overlay_candidates;
DELETE FROM agent_prompt_candidates;
UPDATE agent_prompts SET content = '', content_hash = '';
UPDATE project_agent_overlays SET content = '', content_hash = '', reason = '由当前工作目录 .omp/agents 管理';
