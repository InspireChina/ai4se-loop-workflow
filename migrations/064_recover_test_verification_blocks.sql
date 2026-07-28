CREATE TEMP TABLE recoverable_test_verification_blocks (
  task_id TEXT NOT NULL,
  story_index INTEGER,
  PRIMARY KEY(task_id)
);

INSERT INTO recoverable_test_verification_blocks(task_id, story_index)
SELECT task_id, current_story_index
FROM task_lanes
WHERE lane = 'delivery'
  AND status = 'system_blocked'
  AND current_agent = 'test-agent'
  AND (
    blocked_reason LIKE '验证环境异常：%'
    OR blocked_reason LIKE '验证结论无法确定：%'
  );

UPDATE agent_work_drafts
SET status = 'waiting_for_answers',
    updated_at = CURRENT_TIMESTAMP
WHERE agent = 'test-agent'
  AND status = 'submitted'
  AND EXISTS (
    SELECT 1
    FROM recoverable_test_verification_blocks recoverable
    WHERE recoverable.task_id = agent_work_drafts.task_id
      AND recoverable.story_index IS agent_work_drafts.story_index
  )
  AND draft_version = (
    SELECT MAX(latest.draft_version)
    FROM agent_work_drafts latest
    WHERE latest.work_key = agent_work_drafts.work_key
  );

UPDATE task_lanes
SET status = 'runnable',
    blocked_reason = NULL,
    resume_pending = 1,
    ready_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
WHERE task_id IN (
  SELECT task_id FROM recoverable_test_verification_blocks
)
  AND lane = 'delivery';

UPDATE tasks
SET run_state = 'runnable',
    current_subagent = 'test-agent',
    blocked_reason = NULL,
    next_step = '旧版验证受阻已转为验证协助，等待 Test Agent 恢复原测试计划',
    last_actor = 'system',
    updated_at = CURRENT_TIMESTAMP
WHERE task_id IN (
  SELECT task_id FROM recoverable_test_verification_blocks
);

INSERT INTO task_events(event_id, task_id, actor, event_type, summary)
SELECT lower(hex(randomblob(16))), task_id, 'system',
       'TestVerificationBlockRecovered',
       '将旧版验证环境阻塞恢复为 Test Agent 验证协助流程'
FROM recoverable_test_verification_blocks;

DROP TABLE recoverable_test_verification_blocks;
