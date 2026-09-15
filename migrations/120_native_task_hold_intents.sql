-- Freeze outstanding native legacy blocks once at the upgrade boundary.
-- Ordinary reads must never recreate a hold from a compatibility label.
INSERT OR IGNORE INTO interventions(intervention_id,task_id,item_id,dedupe_key,status,
  resolver_strategy,authority,requested_by,summary,context_json,context_hash)
SELECT 'INT-task-hold-' || task.task_id, task.task_id, NULL, 'native:adopt:task-blocked',
  'awaiting_human', 'human_only', 'standard', COALESCE(task.last_actor,'human'),
  COALESCE(NULLIF(task.blocked_reason,''),NULLIF(task.next_step,''),'历史需求阻塞，等待人工确认解除'),
  json_object('historicalTaskHold',json('true'),'originalTask',json_object(
    'agile_status',task.agile_status,'blocked_reason',task.blocked_reason,
    'next_step',task.next_step,'last_actor',task.last_actor,'workflow_engine',task.workflow_engine),
    'waiting',json(COALESCE((SELECT json_group_array(json_object('item_id',item.item_id,'dispatch_epoch',item.dispatch_epoch))
      FROM workflow_items item WHERE item.task_id = task.task_id AND item.origin = 'native' AND item.status = 'waiting'),'[]'))),
  'migration120:' || task.task_id
FROM tasks task WHERE task.workflow_engine = 'native' AND task.agile_status = 'blocked'
  AND NOT EXISTS (SELECT 1 FROM workflow_item_events event JOIN workflow_items item ON item.item_id = event.item_id
    WHERE item.task_id = task.task_id AND item.origin = 'native'
      AND event.event_key IN ('task:cancelled','native:adopt:task-cancelled') AND event.authority IN ('human','system'))
  AND NOT EXISTS (SELECT 1 FROM workflow_items terminal WHERE terminal.task_id = task.task_id
    AND terminal.origin = 'native' AND terminal.status = 'completed'
    AND (terminal.kind = 'closure' OR terminal.work_key = 'direct:execute')
    AND NOT EXISTS (SELECT 1 FROM workflow_items feedback WHERE feedback.task_id = task.task_id
      AND feedback.origin = 'native' AND feedback.kind = 'feedback'
      AND feedback.status NOT IN ('completed','cancelled','superseded')));

UPDATE execution_attempts SET status = 'cancelled', last_error = '采纳历史需求阻塞，停止活动执行',
  failure_kind = NULL, dispatch_retry_consumed = 0, retry_not_before = NULL,
  finished_at = CURRENT_TIMESTAMP, heartbeat_at = CURRENT_TIMESTAMP
WHERE status IN ('planned','running','output_received','verifying','applying')
  AND task_id IN (SELECT task_id FROM interventions WHERE dedupe_key = 'native:adopt:task-blocked' AND status = 'awaiting_human');

UPDATE intervention_attempts SET status = 'cancelled', reason = '采纳历史需求阻塞，停止系统介入',
  finished_at = CURRENT_TIMESTAMP WHERE status = 'running' AND intervention_id IN (
    SELECT intervention_id FROM interventions WHERE task_id IN (
      SELECT task_id FROM interventions WHERE dedupe_key = 'native:adopt:task-blocked' AND status = 'awaiting_human'));

UPDATE interventions SET status = 'pending', current_execution_id = NULL, active_session_id = NULL,
  command_token_hash = NULL, status_viewed_session_id = NULL,
  attempt_count = (SELECT COUNT(*) FROM intervention_attempts attempt
    WHERE attempt.intervention_id = interventions.intervention_id AND attempt.status IN ('failed','deferred')),
  last_error = '采纳历史需求阻塞，停止系统介入', updated_at = CURRENT_TIMESTAMP
WHERE status = 'running' AND task_id IN (
  SELECT task_id FROM interventions WHERE dedupe_key = 'native:adopt:task-blocked' AND status = 'awaiting_human');

INSERT OR IGNORE INTO task_events(event_id,task_id,actor,event_type,summary)
SELECT 'EVT-task-hold-' || task_id,task_id,'system','InterventionOpened',summary
FROM interventions WHERE dedupe_key = 'native:adopt:task-blocked' AND status = 'awaiting_human';

DELETE FROM resource_claims WHERE owner_task_id IN (
  SELECT task_id FROM interventions WHERE dedupe_key = 'native:adopt:task-blocked' AND status = 'awaiting_human');
