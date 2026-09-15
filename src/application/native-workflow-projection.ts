import type Database from 'better-sqlite3';
import type { TaskState } from '../domain/task';
import type { WorkflowItemRow } from './work-items';
import { nativeCancellationInDb, nativeTaskHoldInDb, nativeDeliveryReadyInDb } from './work-item-controls';

/** One-way compatibility display projection. Never creates or transitions
 * work, and never consults old cursors or Lane state to infer completion. */
type Display = Pick<TaskState, 'analysis_index' | 'spec_resolved_index' | 'dev_index' | 'test_index'
  | 'total_stories' | 'agile_status' | 'current_subagent' | 'run_state' | 'resume_pending' | 'closure_status'>;

export function nativeWorkflowDisplay(items: WorkflowItemRow[], deliveryReady: boolean): Display {
  const active = items.filter((item) => !['superseded', 'cancelled'].includes(item.status));
  const states = new Map(active.map((item) => [item.work_key, item.status]));
  const units = active.filter((item) => /^delivery:(analysis|dev|test):\d+$/.test(item.work_key));
  const total = Math.max(0, ...units.map((item) => item.story_index || 0));
  const prefix = (stage: string) => {
    let completed = 0;
    while (completed < total && states.get(`delivery:${stage}:${completed + 1}`) === 'completed') completed += 1;
    return completed;
  };
  const analysis = prefix('analysis');
  const dev = Math.min(analysis, prefix('dev'));
  const test = Math.min(dev, prefix('test'));
  const counters = { analysis_index: analysis, spec_resolved_index: analysis,
    dev_index: dev, test_index: test, total_stories: total };
  const closure = active.find((item) => item.kind === 'closure');
  const feedbackOpen = active.some((item) => item.kind === 'feedback' && item.status !== 'completed');
  if (!feedbackOpen && (closure?.status === 'completed' || states.get('direct:execute') === 'completed')) {
    return { ...counters, agile_status: 'done' as const, current_subagent: null,
      run_state: 'idle' as const, resume_pending: 0, closure_status: 'acknowledged' as const };
  }
  if (!feedbackOpen && closure?.status === 'waiting' && deliveryReady) {
    return { ...counters, agile_status: 'ready_to_close' as const, current_subagent: null,
      run_state: 'idle' as const, resume_pending: 0, closure_status: 'awaiting_read' as const };
  }
  const available = active.filter((item) => item.agent && ['ready', 'running', 'waiting'].includes(item.status));
  const laneRank = (lane: string | null) => lane === 'control' ? 0 : lane === 'delivery' ? 1 : 2;
  const stateRank = (state: string) => state === 'running' ? 0 : state === 'ready' ? 1 : 2;
  const current = available.sort((a, b) => laneRank(a.lane) - laneRank(b.lane)
    || stateRank(a.status) - stateRank(b.status) || (a.story_index || 0) - (b.story_index || 0))[0];
  let status: TaskState['agile_status'] = 'backlog';
  if (current?.work_key === 'delivery:repro') status = 'in repro';
  else if (current?.work_key === 'delivery:plan') status = 'in plan';
  else if (current?.work_key === 'delivery:review') status = 'in review';
  else if (current?.story_index) status = current.agent === 'analyst-agent'
    || (current.agent === 'dev-agent' && current.status !== 'running' && dev === 0) ? 'ready for dev' : 'in dev';
  // Sparse privileged completion cannot be expressed by old ordered cursors.
  // Keep the exact current Agent but do not fake upstream completion to make
  // an old "in review" invariant appear satisfied.
  if (status === 'in review' && !(total > 0 && test === total)) status = 'in dev';
  if (feedbackOpen) status = 'in feedback';
  const runnable = available.some((item) => ['ready', 'running'].includes(item.status));
  return { ...counters, agile_status: status, current_subagent: current?.agent || null,
    run_state: runnable || !available.length ? 'runnable' as const : 'waiting_for_runtime_input' as const,
    resume_pending: current?.lane === 'control' ? current.resume_pending : 0,
    closure_status: 'none' as const };
}

export function projectNativeWorkflowDisplayInDb(db: Database.Database, taskId: string) {
  const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as
    (TaskState & { workflow_engine: string; completed_at: string | null }) | undefined;
  // Completion is a Work Item fact. A stale compatibility "done" label must
  // not freeze the display after new feedback/revisions introduce obligations.
  // Historical block intent is captured at adoption/upgrade, never inferred
  // from a compatibility label during ordinary display reads.
  if (!task || task.workflow_engine !== 'native') return;
  const cancellation = nativeCancellationInDb(db, taskId);
  const hold = nativeTaskHoldInDb(db, taskId);
  const items = db.prepare("SELECT * FROM workflow_items WHERE task_id = ? AND origin = 'native'")
    .all(taskId) as WorkflowItemRow[];
  const projection = nativeWorkflowDisplay(items, nativeDeliveryReadyInDb(db, taskId));
  if (hold) Object.assign(projection, {
    ...(hold.resolver_strategy === 'human_only' || hold.status === 'awaiting_human' ? { agile_status: 'blocked' } : {}),
    run_state: hold.resolver_strategy === 'system_then_human' && hold.status !== 'awaiting_human'
      ? 'waiting_for_runtime_input' : 'system_blocked', resume_pending: 0,
  });
  if (cancellation) Object.assign(projection, { agile_status: 'cancelled', current_subagent: null,
    run_state: 'idle', resume_pending: 0, closure_status: 'none' });
  const completed = projection.agile_status === 'done'
    ? items.find((item) => (item.kind === 'closure' || item.work_key === 'direct:execute') && item.status === 'completed') : undefined;
  const acknowledgedAt = completed?.completed_at || null;
  const endedAt = cancellation ? cancellation.cancelledAt : acknowledgedAt;
  const waiting = items.filter((item) => item.status === 'waiting');
  const input = waiting.length && db.prepare(`SELECT 1 FROM questions question JOIN interventions intervention
    ON intervention.intervention_id = question.intervention_id JOIN workflow_items item ON item.item_id = intervention.item_id
    WHERE intervention.task_id = ? AND item.task_id = intervention.task_id AND item.status = 'waiting'
      AND question.status IN ('pending', 'conditional', 'answered')`).get(taskId);
  // Saving the last answer resolves its Intervention, not the explicit batch
  // submission. Keep that input-backed wait visible until the Work Item resumes.
  const runtimeInput = waiting.length && db.prepare(`SELECT 1 FROM runtime_input_requests request
    JOIN interventions intervention ON intervention.intervention_id = request.intervention_id
    JOIN workflow_items item ON item.item_id = intervention.item_id
    WHERE intervention.task_id = ? AND item.task_id = intervention.task_id AND item.status = 'waiting'
      AND request.status IN ('pending', 'answered')`).get(taskId);
  if (input && projection.run_state === 'waiting_for_runtime_input') projection.run_state = 'waiting_for_answers';
  if (projection.run_state === 'waiting_for_runtime_input' && waiting.length && !runtimeInput
    && !db.prepare(`SELECT 1 FROM interventions intervention JOIN workflow_items item ON item.item_id = intervention.item_id
      WHERE item.task_id = ? AND item.status = 'waiting'
        AND intervention.status IN ('pending', 'running', 'awaiting_human')`).get(taskId)) {
    projection.run_state = 'system_blocked';
  }
  if (hold && !cancellation) projection.run_state = 'system_blocked';
  const blockedReason = hold && !cancellation ? hold.summary : ['waiting_for_answers', 'waiting_for_runtime_input', 'system_blocked'].includes(projection.run_state)
    ? (db.prepare(`SELECT intervention.summary FROM interventions intervention JOIN workflow_items item ON item.item_id = intervention.item_id
        WHERE item.task_id = ? AND item.status = 'waiting' AND intervention.status IN ('pending', 'running', 'awaiting_human')
        ORDER BY intervention.created_at LIMIT 1`).get(taskId) as { summary: string } | undefined)?.summary
      || (db.prepare(`SELECT execution.last_error FROM execution_attempts execution JOIN workflow_items item ON item.item_id = execution.work_item_id
        WHERE item.task_id = ? AND item.status = 'waiting' AND execution.status = 'system_blocked'
        ORDER BY execution.created_at DESC LIMIT 1`).get(taskId) as { last_error: string | null } | undefined)?.last_error
      || '工作项等待恢复'
    : null;
  const changed = Object.entries(projection).some(([key, value]) => task[key as keyof TaskState] !== value)
    || task.blocked_reason !== blockedReason || task.closure_acknowledged_at !== acknowledgedAt || task.completed_at !== endedAt;
  if (changed) db.prepare(`UPDATE tasks SET analysis_index = ?, spec_resolved_index = ?, dev_index = ?, test_index = ?,
    total_stories = ?, agile_status = ?, current_subagent = ?, run_state = ?, resume_pending = ?,
    closure_status = ?, blocked_reason = ?, closure_acknowledged_at = ?, completed_at = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ?`)
    .run(projection.analysis_index, projection.spec_resolved_index, projection.dev_index, projection.test_index,
      projection.total_stories, projection.agile_status, projection.current_subagent, projection.run_state,
      projection.resume_pending, projection.closure_status, blockedReason, acknowledgedAt, endedAt, taskId);
  for (const lane of ['analysis', 'delivery']) {
    const laneItems = items.filter((item) => item.lane === lane && !['superseded', 'cancelled'].includes(item.status));
    const current = laneItems.filter((item) => ['running', 'ready', 'waiting'].includes(item.status))
      .sort((a, b) => (a.story_index || 0) - (b.story_index || 0))[0];
    let status = current?.status === 'running' ? 'running' : current?.status === 'ready' ? 'runnable'
      : laneItems.length && laneItems.every((item) => item.status === 'completed') ? 'completed' : 'pending';
    if (cancellation) status = 'completed';
    let reason: string | null = null;
    if (current?.status === 'waiting') {
      const intervention = db.prepare(`SELECT intervention_id, summary FROM interventions WHERE item_id = ?
        AND status IN ('pending', 'running', 'awaiting_human') ORDER BY created_at LIMIT 1`)
        .get(current.item_id) as { intervention_id: string; summary: string } | undefined;
      const question = db.prepare(`SELECT 1 FROM questions request JOIN interventions intervention
        ON intervention.intervention_id = request.intervention_id WHERE intervention.item_id = ?
        AND request.status IN ('pending', 'conditional', 'answered')`).get(current.item_id);
      const runtime = db.prepare(`SELECT 1 FROM runtime_input_requests request JOIN interventions intervention
        ON intervention.intervention_id = request.intervention_id WHERE intervention.item_id = ?
        AND request.status IN ('pending', 'answered')`).get(current.item_id);
      status = question ? 'waiting_for_answers' : intervention || runtime ? 'waiting_for_runtime_input' : 'system_blocked';
      reason = intervention?.summary || (db.prepare(`SELECT last_error FROM execution_attempts WHERE work_item_id = ?
        AND status = 'system_blocked' ORDER BY work_item_attempt DESC LIMIT 1`)
        .get(current.item_id) as { last_error: string | null } | undefined)?.last_error || '工作项等待恢复';
    }
    db.prepare(`INSERT INTO task_lanes(task_id, lane, status, current_agent, current_story_index,
        blocked_reason, resume_pending, ready_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id, lane) DO UPDATE SET status = excluded.status, current_agent = excluded.current_agent,
        current_story_index = excluded.current_story_index, blocked_reason = excluded.blocked_reason,
        resume_pending = excluded.resume_pending, ready_at = excluded.ready_at, updated_at = CURRENT_TIMESTAMP
      WHERE task_lanes.status IS NOT excluded.status OR task_lanes.current_agent IS NOT excluded.current_agent
        OR task_lanes.current_story_index IS NOT excluded.current_story_index OR task_lanes.blocked_reason IS NOT excluded.blocked_reason
        OR task_lanes.resume_pending IS NOT excluded.resume_pending OR task_lanes.ready_at IS NOT excluded.ready_at`)
      .run(taskId, lane, status, current?.agent || null, current?.story_index || null,
        reason, current?.resume_pending || 0, current?.ready_at || null);
  }
}
