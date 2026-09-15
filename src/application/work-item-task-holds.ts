import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { hash } from '../infrastructure/database';
import { openInterventionInDb, interruptTaskInterventionsInDb } from './interventions';
import { nativeHistoricalTaskHoldInDb, nativeWorkflowEndedInDb } from './work-item-controls';
import { reconcileNativeWorkItemExecutionsInDb, transitionWorkItemInDb, promoteReadyWorkItemsInDb } from './work-item-transitions';
import { releaseTaskResourceClaimsInDb } from './resource-claims';

type Db = Database.Database;
type Waiting = { item_id: string; dispatch_epoch: number };

/** Invoke only at the explicit adoption boundary. Ordinary display reads must
 * never infer a new control intent from stale legacy labels. */
export function adoptNativeTaskHoldInDb(db: Db, taskId: string) {
  return db.transaction(() => adoptTaskHoldInDb(db, taskId))();
}
function adoptTaskHoldInDb(db: Db, taskId: string) {
  const task = db.prepare(`SELECT agile_status, blocked_reason, next_step, last_actor, workflow_engine
    FROM tasks WHERE task_id = ?`).get(taskId) as { agile_status: string; blocked_reason: string | null;
      next_step: string | null; last_actor: string | null; workflow_engine: string } | undefined;
  if (!task || task.workflow_engine !== 'native' || task.agile_status !== 'blocked' || nativeWorkflowEndedInDb(db, taskId)) return;
  if (db.prepare("SELECT 1 FROM interventions WHERE task_id = ? AND dedupe_key = 'native:adopt:task-blocked'").get(taskId)) return;
  const waiting = db.prepare(`SELECT item_id, dispatch_epoch FROM workflow_items WHERE task_id = ?
    AND origin = 'native' AND status = 'waiting' ORDER BY item_id`).all(taskId) as Waiting[];
  openInterventionInDb(db, { taskId, dedupeKey: 'native:adopt:task-blocked',
    summary: task.blocked_reason || task.next_step || '历史需求阻塞，等待人工确认解除',
    requestedBy: task.last_actor || 'human', resolverStrategy: 'human_only',
    context: { historicalTaskHold: true, originalTask: task, waiting } });
  // A hold is control cancellation, never a new CLI failure. Preserve closed
  // execution evidence and terminate only live work belonging to this task.
  db.prepare(`UPDATE execution_attempts SET status = 'cancelled', last_error = '采纳历史需求阻塞，停止活动执行',
    failure_kind = NULL, dispatch_retry_consumed = 0, retry_not_before = NULL,
    finished_at = CURRENT_TIMESTAMP, heartbeat_at = CURRENT_TIMESTAMP
    WHERE task_id = ? AND pipeline != 'intervention'
      AND status IN ('planned','running','output_received','verifying','applying')`).run(taskId);
  interruptTaskInterventionsInDb(db, taskId, '采纳历史需求阻塞，停止系统介入');
  reconcileNativeWorkItemExecutionsInDb(db, taskId);
  releaseTaskResourceClaimsInDb(db, taskId);
}

export function releaseNativeTaskHoldInDb(db: Db, taskId: string) {
  const hold = nativeHistoricalTaskHoldInDb(db, taskId);
  if (!hold) return false;
  return db.transaction(() => {
    const task = db.prepare('SELECT is_paused FROM tasks WHERE task_id = ?').get(taskId) as { is_paused: number };
    if (task.is_paused || nativeWorkflowEndedInDb(db, taskId)) throw new Error('已暂停或结束的需求不能解除阻塞');
    const context = JSON.parse(hold.context_json) as { waiting?: Waiting[] };
    db.prepare(`UPDATE interventions SET status = 'resolved', resolution = '人工确认解除历史需求阻塞',
      resolved_by = 'human', resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE intervention_id = ?`).run(hold.intervention_id);
    for (const frozen of context.waiting || []) {
      const item = db.prepare(`SELECT item_id FROM workflow_items WHERE item_id = ? AND task_id = ?
        AND origin = 'native' AND status = 'waiting' AND dispatch_epoch = ?`).get(frozen.item_id, taskId, frozen.dispatch_epoch);
      if (!item) continue;
      // The explicit hold release cannot submit outstanding/answered inputs,
      // resolve arbitration or reset a separately exhausted CLI retry budget.
      if (db.prepare(`SELECT 1 FROM interventions WHERE item_id = ? AND status IN ('pending','running','awaiting_human')
        UNION ALL SELECT 1 FROM questions request JOIN interventions intervention
          ON intervention.intervention_id = request.intervention_id WHERE intervention.item_id = ?
          AND request.status IN ('pending','conditional','answered')
        UNION ALL SELECT 1 FROM runtime_input_requests request JOIN interventions intervention
          ON intervention.intervention_id = request.intervention_id WHERE intervention.item_id = ?
          AND request.status IN ('pending','answered')
        UNION ALL SELECT 1 FROM execution_attempts WHERE work_item_id = ? AND status = 'system_blocked'
          AND dispatch_generation_key = ? AND execution_id = (SELECT latest.execution_id
            FROM execution_attempts latest WHERE latest.work_item_id = execution_attempts.work_item_id
              AND latest.pipeline != 'intervention' ORDER BY latest.work_item_attempt DESC, latest.rowid DESC LIMIT 1)
        UNION ALL SELECT 1 FROM workflow_dependencies dependency JOIN workflow_items upstream
          ON upstream.item_id = dependency.depends_on_item_id WHERE dependency.item_id = ? AND upstream.status != 'completed'
        LIMIT 1`).get(frozen.item_id, frozen.item_id, frozen.item_id, frozen.item_id,
          hash(JSON.stringify({ itemId: frozen.item_id, epoch: frozen.dispatch_epoch })), frozen.item_id)) continue;
      transitionWorkItemInDb(db, { itemId: frozen.item_id, action: 'resume',
        eventKey: `human-task-hold:${hold.intervention_id}`, actor: 'human', authority: 'human',
        reason: '人工确认解除历史需求阻塞，不重置错误重试额度' });
    }
    db.prepare(`INSERT INTO task_events(event_id,task_id,actor,event_type,summary)
      VALUES(?,?,'human','InterventionResolved',?)`).run(randomUUID(), taskId,
        `已解除需求级阻塞 ${hold.intervention_id}：${hold.summary}`);
    db.prepare("UPDATE tasks SET next_step = '需求级阻塞已解除，按当前工作项继续', last_actor = 'human', updated_at = CURRENT_TIMESTAMP WHERE task_id = ?").run(taskId);
    promoteReadyWorkItemsInDb(db, taskId, `task-hold:${hash(hold.intervention_id)}`);
    return true;
  })();
}
