CREATE TEMP TABLE legacy_feedback_plan_results (
  result_id TEXT PRIMARY KEY,
  execution_id TEXT,
  task_id TEXT NOT NULL
);

INSERT INTO legacy_feedback_plan_results(result_id, execution_id, task_id)
SELECT result.result_id, result.execution_id, result.task_id
FROM agent_results result
JOIN tasks task ON task.task_id = result.task_id
WHERE result.agent = 'story-splitter-agent'
  AND result.pipeline = 'feedback-split'
  AND result.application_status = 'failed'
  AND result.application_error = '反馈新增范围当前不能追加交付单元'
  AND task.agile_status NOT IN ('done', 'cancelled');

UPDATE agent_results
SET application_status = 'pending',
    application_error = NULL,
    applied_at = NULL,
    effect_outcome = NULL
WHERE result_id IN (
  SELECT result_id FROM legacy_feedback_plan_results
);

UPDATE execution_attempts
SET status = 'output_received',
    last_error = NULL,
    finished_at = NULL,
    heartbeat_at = CURRENT_TIMESTAMP
WHERE execution_id IN (
  SELECT execution_id
  FROM legacy_feedback_plan_results
  WHERE execution_id IS NOT NULL
);

UPDATE tasks
SET agile_status = 'in feedback',
    current_subagent = 'story-splitter-agent',
    run_state = 'runnable',
    blocked_reason = NULL,
    resume_status = NULL,
    resume_pending = 0,
    next_step = '检测到旧版反馈交付规划误拒绝，正在重新应用已提交结果',
    last_actor = 'system',
    updated_at = CURRENT_TIMESTAMP
WHERE task_id IN (
  SELECT task_id FROM legacy_feedback_plan_results
);

INSERT INTO task_events(event_id, task_id, actor, event_type, summary)
SELECT lower(hex(randomblob(16))), task_id, 'system',
       'LegacyFeedbackPlanResultRequeued',
       '恢复旧版本误拒绝的反馈交付规划结果，等待新版本重新应用'
FROM (
  SELECT DISTINCT task_id FROM legacy_feedback_plan_results
);

DROP TABLE legacy_feedback_plan_results;
