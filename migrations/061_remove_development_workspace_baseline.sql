CREATE TEMP TABLE legacy_development_workspace_blocks (
  task_id TEXT NOT NULL,
  story_index INTEGER NOT NULL,
  PRIMARY KEY(task_id, story_index)
);

INSERT INTO legacy_development_workspace_blocks(task_id, story_index)
SELECT DISTINCT lane.task_id, lane.current_story_index
FROM task_lanes lane
JOIN agent_work_drafts draft
  ON draft.task_id = lane.task_id
 AND draft.story_index = lane.current_story_index
 AND draft.draft_type = 'development'
JOIN development_runtime_inputs input
  ON input.draft_id = draft.draft_id
JOIN runtime_input_requests request
  ON request.task_id = draft.task_id
 AND request.story_index = draft.story_index
 AND request.source_agent = 'dev-agent'
 AND request.request_key = input.request_key
WHERE lane.lane = 'delivery'
  AND lane.status = 'system_blocked'
  AND lane.current_agent = 'dev-agent'
  AND request.status IN ('answered', 'resolved')
  AND (
    lower(input.request_key) LIKE '%workspace-fingerprint-drift%'
    OR lower(input.request_key) LIKE '%workspace-baseline%'
    OR lower(input.question) LIKE '%initial_workspace_fingerprint%'
  );

UPDATE task_lanes
SET status = 'runnable',
    current_agent = 'dev-agent',
    blocked_reason = NULL,
    resume_pending = 1,
    ready_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
WHERE lane = 'delivery'
  AND (task_id, current_story_index) IN (
    SELECT task_id, story_index
    FROM legacy_development_workspace_blocks
  );

UPDATE tasks
SET run_state = 'runnable',
    current_subagent = 'dev-agent',
    blocked_reason = NULL,
    resume_pending = 0,
    next_step = '已移除未提交工作区基线门禁，等待开发实现 Agent 继续完成',
    last_actor = 'system',
    updated_at = CURRENT_TIMESTAMP
WHERE task_id IN (
  SELECT task_id FROM legacy_development_workspace_blocks
);

INSERT INTO task_events(event_id, task_id, actor, event_type, summary)
SELECT lower(hex(randomblob(16))), task_id, 'system',
       'DevelopmentWorkspaceBaselineRemoved',
       '移除未提交工作区基线门禁并恢复开发验证通道'
FROM (
  SELECT DISTINCT task_id FROM legacy_development_workspace_blocks
);

ALTER TABLE development_drafts DROP COLUMN initial_workspace_fingerprint;

ALTER TABLE development_drafts DROP COLUMN initial_workspace_tree;

ALTER TABLE development_drafts DROP COLUMN initial_workspace_changes_json;

ALTER TABLE development_checks DROP COLUMN workspace_fingerprint;

DROP TABLE legacy_development_workspace_blocks;
