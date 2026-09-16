import type Database from 'better-sqlite3';
import { nativeFinalDocumentInDb } from './work-item-artifacts';

type Db = Database.Database;

/** Every active task-wide Intervention holds the native graph, regardless of
 * who requested it or which resolver owns it. */
export function nativeTaskHoldInDb(db: Db, taskId: string, exceptInterventionId?: string) {
  return db.prepare(`SELECT intervention_id, summary, context_json, resolver_strategy, status FROM interventions
    WHERE task_id = ? AND item_id IS NULL
      AND intervention_id != COALESCE(?, '')
      AND EXISTS (SELECT 1 FROM tasks task WHERE task.task_id = interventions.task_id AND task.workflow_engine = 'native')
      AND status IN ('pending', 'running', 'awaiting_human')
    ORDER BY created_at, intervention_id LIMIT 1`).get(taskId, exceptInterventionId || null) as
    { intervention_id: string; summary: string; context_json: string; resolver_strategy: string; status: string } | undefined;
}

/** The legacy release button may resolve ONLY the explicitly adopted hold. */
export function nativeHistoricalTaskHoldInDb(db: Db, taskId: string) {
  return db.prepare(`SELECT intervention_id, summary, context_json FROM interventions
    WHERE task_id = ? AND dedupe_key = 'native:adopt:task-blocked' AND item_id IS NULL
      AND resolver_strategy = 'human_only' AND authority = 'standard'
      AND status IN ('pending', 'running', 'awaiting_human') LIMIT 1`).get(taskId) as
    { intervention_id: string; summary: string; context_json: string } | undefined;
}

/** Explicit task cancellation is recorded on the Work Item ledger. A legacy
 * cancelled display label, or cancellation of a superseded input plan, is not
 * sufficient to cancel the current native workflow. */
export function nativeCancellationInDb(db: Db, taskId: string) {
  const event = db.prepare(`SELECT event.reason, event.created_at, event.payload_json
    FROM workflow_item_events event JOIN workflow_items item ON item.item_id = event.item_id
    WHERE item.task_id = ? AND item.origin = 'native'
      AND event.event_key IN ('task:cancelled', 'native:adopt:task-cancelled')
      AND event.authority IN ('human', 'system')
    ORDER BY event.created_at, event.event_id LIMIT 1`).get(taskId) as
    { reason: string; created_at: string; payload_json: string } | undefined;
  if (!event) return null;
  const payload = JSON.parse(event.payload_json) as { cancelledAt?: string | null };
  return { reason: event.reason, cancelledAt: Object.hasOwn(payload, 'cancelledAt')
    ? payload.cancelledAt || null : event.created_at };
}

/** Terminal completion is a current graph fact, not tasks.agile_status. Open
 * feedback introduces fresh obligations even if an older Closure is complete. */
export function nativeCompletionInDb(db: Db, taskId: string) {
  return Boolean(db.prepare(`SELECT 1 FROM workflow_items terminal
    WHERE terminal.task_id = ? AND terminal.origin = 'native' AND terminal.status = 'completed'
      AND (terminal.kind = 'closure' OR terminal.work_key = 'direct:execute')
      AND NOT EXISTS (SELECT 1 FROM workflow_items obligation WHERE obligation.task_id = terminal.task_id
        AND obligation.origin = 'native' AND obligation.item_id != terminal.item_id
        AND obligation.status NOT IN ('completed', 'superseded', 'cancelled')) LIMIT 1`).get(taskId));
}

export function nativeWorkflowEndedInDb(db: Db, taskId: string) {
  return Boolean(nativeCancellationInDb(db, taskId)) || nativeCompletionInDb(db, taskId);
}

/** Delivery readiness intentionally precedes human Closure acknowledgement. */
export function nativeDeliveryReadyInDb(db: Db, taskId: string) {
  if (nativeCancellationInDb(db, taskId)) return false;
  if (nativeCompletionInDb(db, taskId)) return true;
  if (!nativeFinalDocumentInDb(db, taskId)) return false;
  return Boolean(db.prepare(`SELECT 1 FROM workflow_items terminal
    WHERE terminal.task_id = ? AND terminal.origin = 'native' AND terminal.kind = 'closure'
      AND terminal.status = 'waiting'
      AND EXISTS (SELECT 1 FROM tasks task JOIN documents document ON document.document_id = task.review_document_id
        WHERE task.task_id = terminal.task_id AND document.task_id = task.task_id AND task.review_revision > 0)
      AND NOT EXISTS (SELECT 1 FROM workflow_dependencies dependency JOIN workflow_items upstream
        ON upstream.item_id = dependency.depends_on_item_id WHERE dependency.item_id = terminal.item_id
          AND upstream.status != 'completed')
      AND NOT EXISTS (SELECT 1 FROM workflow_items obligation WHERE obligation.task_id = terminal.task_id
        AND obligation.origin = 'native' AND obligation.item_id != terminal.item_id
        AND obligation.status NOT IN ('completed', 'superseded', 'cancelled'))
      AND NOT EXISTS (SELECT 1 FROM workflow_items feedback WHERE feedback.task_id = terminal.task_id
        AND feedback.origin = 'native' AND feedback.kind = 'feedback'
        AND feedback.status NOT IN ('completed','cancelled','superseded'))
      AND NOT EXISTS (SELECT 1 FROM interventions intervention WHERE intervention.task_id = terminal.task_id
        AND intervention.status IN ('pending', 'running', 'awaiting_human')
        AND (intervention.item_id IS NULL OR EXISTS (SELECT 1 FROM workflow_items blocked
          WHERE blocked.item_id = intervention.item_id AND blocked.task_id = terminal.task_id
            AND blocked.status NOT IN ('cancelled', 'superseded')))) LIMIT 1`).get(taskId));
}

/** Compatibility boundary for callers shared by both engines. Only legacy
 * tasks may interpret the old terminal label as a scheduling/control fact. */
export function workflowEndedInDb(db: Db, taskId: string) {
  const task = db.prepare('SELECT workflow_engine, agile_status FROM tasks WHERE task_id = ?').get(taskId) as
    { workflow_engine: string; agile_status: string } | undefined;
  return task?.workflow_engine === 'native' ? nativeWorkflowEndedInDb(db, taskId)
    : Boolean(task && ['done', 'cancelled'].includes(task.agile_status));
}

export function workflowBlockedInDb(db: Db, taskId: string) {
  const task = db.prepare('SELECT workflow_engine, agile_status FROM tasks WHERE task_id = ?').get(taskId) as
    { workflow_engine: string; agile_status: string } | undefined;
  return task?.workflow_engine === 'native' ? Boolean(nativeTaskHoldInDb(db, taskId)) : task?.agile_status === 'blocked';
}

/** Pending application is work on the exact source node, not a new dispatch.
 * A current dependency/Intervention holds it; obsolete nodes remain readable
 * so their late results can be discarded by the application perimeter. */
export function workflowResultHeldInDb(db: Db, taskId: string, executionId?: string | null) {
  if (workflowBlockedInDb(db, taskId)) return true;
  if (!executionId) return false;
  return Boolean(db.prepare(`SELECT 1 FROM execution_attempts source
    JOIN tasks task ON task.task_id = source.task_id
    JOIN workflow_items item ON item.item_id = source.work_item_id AND item.task_id = source.task_id
    WHERE source.execution_id = ? AND source.task_id = ? AND source.pipeline != 'intervention'
      AND task.workflow_engine = 'native' AND item.origin = 'native'
      AND source.status != 'cancelled' AND item.status NOT IN ('cancelled', 'superseded')
      AND (EXISTS (SELECT 1 FROM interventions intervention WHERE intervention.item_id = item.item_id
        AND intervention.status IN ('pending', 'running', 'awaiting_human'))
      OR EXISTS (SELECT 1 FROM workflow_dependencies dependency JOIN workflow_items upstream
        ON upstream.item_id = dependency.depends_on_item_id
        WHERE dependency.item_id = item.item_id AND upstream.status != 'completed'))`)
    .get(executionId, taskId));
}
