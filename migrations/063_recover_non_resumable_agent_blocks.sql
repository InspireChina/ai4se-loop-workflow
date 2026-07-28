CREATE TEMP TABLE non_resumable_agent_blocks (
  task_id TEXT PRIMARY KEY
);

INSERT INTO non_resumable_agent_blocks(task_id)
SELECT task_id
FROM tasks
WHERE agile_status = 'blocked'
  AND run_state = 'system_blocked'
  AND resume_status IS NOT NULL
  AND current_subagent IN (
    'story-splitter-agent',
    'feedback-agent',
    'review-agent'
  )
  AND blocked_reason LIKE '%/resume 没有配置渐进式命令协议%';

UPDATE tasks
SET agile_status = resume_status,
    run_state = 'runnable',
    resume_status = NULL,
    resume_pending = 0,
    blocked_reason = NULL,
    next_step = '已修复错误的 resume 派发，等待重新派发当前步骤',
    last_actor = 'system',
    updated_at = CURRENT_TIMESTAMP
WHERE task_id IN (
  SELECT task_id FROM non_resumable_agent_blocks
);

INSERT INTO task_events(event_id, task_id, actor, event_type, summary)
SELECT lower(hex(randomblob(16))), task_id, 'system',
       'NonResumableAgentBlockRecovered',
       '修复错误的 resume 派发并重新派发原业务步骤'
FROM non_resumable_agent_blocks;

DROP TABLE non_resumable_agent_blocks;
