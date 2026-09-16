import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { WorkItemStatus } from '../domain/workflow-item';
import { databaseConnection, hash } from '../infrastructure/database';
import { releaseExecutionResourceClaimsInDb } from './resource-claims';
import { syncLegacyDeliveryWorkItemsInDb, type WorkflowItemRow } from './work-items';
import { adoptRecoveryInterventionsInDb } from './work-item-recovery';
import { adoptFeedbackWorkItemsInDb } from './work-item-feedback';
import { builtinWorkflow } from '../domain/builtin-workflow';
import { legacyWorkKeyForExecution } from '../domain/workflow-item';
import { releaseResourceClaimInDb, resourceClaimInDb } from './resource-claims';
import type { ResourceKey } from '../domain/resource';
import { nativeCancellationInDb, nativeWorkflowEndedInDb, nativeTaskHoldInDb } from './work-item-controls';
import { adoptNativeTaskHoldInDb } from './work-item-task-holds';
import { interruptTaskInterventionsInDb } from './interventions';
import { finalDocumentSnapshotInDb } from './work-item-artifacts';

type Db = Database.Database;
type Authority = 'agent' | 'system' | 'arbitration' | 'human';
type Transition = 'start' | 'complete' | 'wait' | 'resume' | 'cancel';
export type WorkItemTransitionInput = {
  itemId: string;
  action: Transition;
  eventKey: string;
  actor: string;
  authority: Authority;
  reason: string;
  executionId?: string;
  resetRetryBudget?: boolean;
  context?: Record<string, unknown>;
};

function itemInDb(db: Db, itemId: string) {
  const item = db.prepare('SELECT * FROM workflow_items WHERE item_id = ?').get(itemId) as WorkflowItemRow | undefined;
  if (!item) throw new Error(`工作项不存在：${itemId}`);
  return item;
}

function blockedInDb(db: Db, itemId: string) {
  return Boolean(db.prepare(`
    SELECT 1 FROM workflow_dependencies dependency
    JOIN workflow_items upstream ON upstream.item_id = dependency.depends_on_item_id
    WHERE dependency.item_id = ? AND upstream.status != 'completed'
    UNION ALL
    SELECT 1 FROM interventions WHERE item_id = ?
      AND status IN ('pending', 'running', 'awaiting_human')
    LIMIT 1
  `).get(itemId, itemId));
}

function assertWritableTask(db: Db, item: WorkflowItemRow, action: Transition, exceptInterventionId?: string) {
  const task = db.prepare('SELECT is_paused FROM tasks WHERE task_id = ?')
    .get(item.task_id) as { is_paused: number } | undefined;
  if (!task) throw new Error('工作项所属需求不存在');
  if (action !== 'cancel' && (task.is_paused || nativeWorkflowEndedInDb(db, item.task_id) || nativeTaskHoldInDb(db, item.task_id, exceptInterventionId))) {
    throw new Error('已暂停或结束，或仍有需求级介入的需求不能推进工作项');
  }
}

function recordEventInDb(db: Db, item: WorkflowItemRow, input: {
  eventKey: string; inputHash: string; type: string; status: WorkItemStatus;
  actor: string; authority: Authority; reason: string; executionId?: string; payload?: unknown;
}) {
  db.prepare(`
    INSERT INTO workflow_item_events(
      event_id, item_id, event_key, input_hash, event_type, from_status, to_status,
      actor, authority, reason, execution_id, payload_json
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), item.item_id, input.eventKey, input.inputHash, input.type,
    item.status, input.status, input.actor, input.authority, input.reason,
    input.executionId || null, JSON.stringify(input.payload || {}));
  db.prepare(`
    INSERT INTO task_events(event_id, task_id, actor, event_type, summary)
    VALUES(?, ?, ?, 'WorkItemTransitioned', ?)
  `).run(randomUUID(), item.task_id, input.actor,
    `${item.title} · ${item.work_key}@${item.revision} · ${item.status} → ${input.status} · ${input.reason}`);
}

function existingEventInDb(db: Db, itemId: string, eventKey: string, inputHash: string) {
  const event = db.prepare('SELECT input_hash, payload_json FROM workflow_item_events WHERE item_id = ? AND event_key = ?')
    .get(itemId, eventKey) as { input_hash: string; payload_json: string } | undefined;
  if (event && event.input_hash !== inputHash) throw new Error(`工作项事件幂等键冲突：${eventKey}`);
  return event;
}

/** Promote only pending native nodes. Waiting nodes require an explicit resume,
 * even after a human answer, so an unsubmitted answer cannot restart execution. */
export function promoteReadyWorkItemsInDb(db: Db, taskId: string, cause: string) {
  return db.transaction(() => {
    if (nativeWorkflowEndedInDb(db, taskId) || nativeTaskHoldInDb(db, taskId)) return [];
    const candidates = db.prepare(`
      SELECT * FROM workflow_items WHERE task_id = ? AND origin = 'native' AND status = 'pending'
    `).all(taskId) as WorkflowItemRow[];
    const promoted: string[] = [];
    for (const item of candidates) {
      if (blockedInDb(db, item.item_id)) continue;
      const next: WorkItemStatus = item.agent ? 'ready' : 'waiting';
      db.prepare(`
        UPDATE workflow_items SET status = ?, ready_at = CASE WHEN ? = 'ready' THEN CURRENT_TIMESTAMP ELSE NULL END, updated_at = CURRENT_TIMESTAMP
        WHERE item_id = ? AND status = 'pending'
      `).run(next, next, item.item_id);
      recordEventInDb(db, item, { eventKey: `ready:${cause}`, inputHash: hash(cause), type: 'dependencies_satisfied',
        status: next, actor: 'system', authority: 'system', reason: '前置工作项已完成', payload: { cause } });
      promoted.push(item.item_id);
    }
    return promoted;
  })();
}

/** Native state changes and evidence are committed together. The caller must
 * supply a stable command/execution identity; retries replay rather than mutate. */
export function transitionWorkItemInDb(db: Db, input: WorkItemTransitionInput) {
  return db.transaction(() => {
    if (!input.eventKey.trim() || !input.reason.trim() || !input.actor.trim()) throw new Error('工作项转移必须提供事件标识、执行者与原因');
    if (input.resetRetryBudget && input.action !== 'resume') throw new Error('只能在显式恢复时重置重试额度');
    const item = itemInDb(db, input.itemId);
    const inputHash = hash(JSON.stringify(input));
    if (existingEventInDb(db, item.item_id, input.eventKey, inputHash)) return item;
    if (item.origin !== 'native') throw new Error('兼容投影工作项必须先迁移为原生工作项');
    assertWritableTask(db, item, input.action);
    if (input.executionId && !db.prepare(`
      SELECT 1 FROM execution_attempts WHERE execution_id = ? AND work_item_id = ? AND task_id = ?
        AND status != 'cancelled'
    `).get(input.executionId, item.item_id, item.task_id)) throw new Error('工作项转移引用了无效或已取消的执行');
    let next: WorkItemStatus;
    switch (input.action) {
      case 'start':
        if (item.status !== 'ready' || blockedInDb(db, item.item_id)) throw new Error('工作项尚未就绪或仍有未解决的依赖/介入');
        if (!input.executionId) throw new Error('启动工作项必须绑定执行');
        next = 'running';
        break;
      case 'complete':
        if (!['ready', 'running', 'waiting'].includes(item.status)) throw new Error('当前工作项状态不能完成');
        if (input.authority !== 'arbitration' && input.authority !== 'human' && blockedInDb(db, item.item_id)) {
          throw new Error('仍有未完成的依赖或介入，普通 Agent 不能越过门禁');
        }
        next = 'completed';
        break;
      case 'wait':
        if (!['pending', 'ready', 'running'].includes(item.status)) throw new Error('当前工作项不能转入等待');
        next = 'waiting';
        break;
      case 'resume':
        if (!['running', 'waiting'].includes(item.status) || blockedInDb(db, item.item_id)) throw new Error('工作项不能恢复或介入仍未解决');
        if (input.resetRetryBudget && !['human', 'arbitration'].includes(input.authority)) throw new Error('只有人工或仲裁可以重置重试额度');
        next = 'ready';
        break;
      case 'cancel':
        if (['completed', 'superseded', 'cancelled'].includes(item.status)) throw new Error('已结束的工作项不能取消');
        next = 'cancelled';
        break;
    }
    db.prepare(`
      UPDATE workflow_items SET status = ?, ready_at = CASE WHEN ? = 'ready' THEN CURRENT_TIMESTAMP ELSE NULL END,
        started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, CURRENT_TIMESTAMP) ELSE started_at END,
        completed_at = CASE WHEN ? = 'completed' THEN CURRENT_TIMESTAMP ELSE completed_at END,
        completion_authority = CASE WHEN ? = 'completed' THEN ? ELSE completion_authority END,
        completion_reason = CASE WHEN ? = 'completed' THEN ? ELSE completion_reason END,
        resume_pending = CASE WHEN ? = 'ready' THEN 1 WHEN ? = 'running' THEN 0 ELSE resume_pending END,
        dispatch_epoch = dispatch_epoch + ?, updated_at = CURRENT_TIMESTAMP
      WHERE item_id = ?
    `).run(next, next, next, next, next, input.authority, next, input.reason, next, next,
      input.resetRetryBudget ? 1 : 0, item.item_id);
    recordEventInDb(db, item, { eventKey: input.eventKey, inputHash, type: input.action,
      status: next, actor: input.actor, authority: input.authority, reason: input.reason, executionId: input.executionId, payload: input.context });
    if (next === 'completed') promoteReadyWorkItemsInDb(db, item.task_id, input.eventKey);
    return itemInDb(db, item.item_id);
  })();
}

export async function transitionWorkItem(input: WorkItemTransitionInput) {
  const db = await databaseConnection();
  return db.transaction(() => transitionWorkItemInDb(db, input)).immediate();
}

/** Recover released attempts using execution facts, not lane/cursor snapshots.
 * Cancelled attempts never advance dispatch_epoch or consume retry budget.
 * Applied outputs are deliberately not interpreted here: the result handler
 * owns completion, because an applied failed verdict is not completed work. */
export function reconcileNativeWorkItemExecutionsInDb(db: Db, taskId: string) {
  return db.transaction(() => {
    const items = db.prepare(`
      SELECT item.* FROM workflow_items item
      WHERE item.task_id = ? AND item.origin = 'native' AND item.status = 'running'
        AND NOT EXISTS (
          SELECT 1 FROM execution_attempts execution WHERE execution.work_item_id = item.item_id
            AND execution.pipeline != 'intervention'
            AND execution.status IN ('planned', 'running', 'output_received', 'verifying', 'applying')
        )
    `).all(taskId) as WorkflowItemRow[];
    for (const item of items) {
      const execution = db.prepare(`
        SELECT execution_id, status, last_error FROM execution_attempts
        WHERE work_item_id = ? AND pipeline != 'intervention'
        ORDER BY work_item_attempt DESC, created_at DESC, execution_id DESC LIMIT 1
      `).get(item.item_id) as { execution_id: string; status: string; last_error: string | null } | undefined;
      if (!execution || !['cancelled', 'retryable_failed', 'system_blocked'].includes(execution.status)) continue;
      const next: WorkItemStatus = nativeCancellationInDb(db, taskId) ? 'cancelled'
        : execution.status === 'system_blocked' || blockedInDb(db, item.item_id) ? 'waiting' : 'ready';
      const eventKey = `execution-settled:${execution.execution_id}`;
      if (existingEventInDb(db, item.item_id, eventKey, hash(execution.execution_id))) continue;
      db.prepare(`UPDATE workflow_items SET status = ?,
        ready_at = CASE WHEN ? = 'ready' THEN CURRENT_TIMESTAMP ELSE NULL END, updated_at = CURRENT_TIMESTAMP
        WHERE item_id = ? AND status = 'running'`).run(next, next, item.item_id);
      recordEventInDb(db, item, { eventKey, inputHash: hash(execution.execution_id), type: 'attempt_released', status: next,
        actor: 'system', authority: 'system', reason: execution.last_error || '执行已释放，保留工作项重试代次',
        executionId: execution.execution_id, payload: { executionStatus: execution.status, dispatchEpoch: item.dispatch_epoch } });
    }
  })();
}

/** One-time adoption of the exact historical graph. No completion is inferred
 * again after adoption; cursor/lane writes cannot replace native state. */
export function adoptNativeWorkflowInDb(db: Db, taskId: string) {
  return db.transaction(() => {
    if (db.prepare("SELECT 1 FROM tasks WHERE task_id = ? AND workflow_engine = 'native'").get(taskId)) {
      adoptNativeTaskHoldInDb(db, taskId);
      return db.prepare('SELECT * FROM workflow_items WHERE task_id = ?').all(taskId) as WorkflowItemRow[];
    }
    syncLegacyDeliveryWorkItemsInDb(db, taskId);
    const cancellation = db.prepare(`SELECT agile_status, next_step, completed_at, last_actor FROM tasks WHERE task_id = ?`)
      .get(taskId) as { agile_status: string; next_step: string | null; completed_at: string | null; last_actor: string | null };
    const items = db.prepare(`SELECT * FROM workflow_items WHERE task_id = ? AND origin = 'legacy_projection'`)
      .all(taskId) as WorkflowItemRow[];
    const finalDocument = finalDocumentSnapshotInDb(db, taskId);
    for (const item of items) {
      db.prepare("UPDATE workflow_items SET origin = 'native', updated_at = CURRENT_TIMESTAMP WHERE item_id = ?").run(item.item_id);
      recordEventInDb(db, item, { eventKey: 'native:adopt', inputHash: hash(item.item_id), type: 'adopt',
        status: item.status, actor: 'system', authority: 'system', reason: '迁移既有流程状态，保留历史完成与执行绑定',
        payload: item.kind === 'closure' && ['waiting', 'completed'].includes(item.status) ? { finalDocument } : {} });
      if (cancellation.agile_status === 'cancelled') recordEventInDb(db, item, {
        eventKey: 'native:adopt:task-cancelled', inputHash: hash(JSON.stringify(cancellation)), type: 'task_cancellation_adopted',
        status: item.status, actor: 'system', authority: 'system', reason: cancellation.next_step || '采纳历史需求取消意图',
        payload: { cancelledAt: cancellation.completed_at, originalActor: cancellation.last_actor } });
    }
    const review = db.prepare(`SELECT item_id FROM workflow_items WHERE task_id = ? AND work_key = 'delivery:review'
      AND status NOT IN ('superseded', 'cancelled')`).get(taskId) as { item_id: string } | undefined;
    const plan = db.prepare(`SELECT item_id FROM workflow_items WHERE task_id = ? AND work_key = 'delivery:plan'
      AND status NOT IN ('superseded', 'cancelled')`).get(taskId) as { item_id: string } | undefined;
    if (review && plan) db.prepare('INSERT OR IGNORE INTO workflow_dependencies(item_id, depends_on_item_id) VALUES(?, ?)')
      .run(review.item_id, plan.item_id);
    adoptRecoveryInterventionsInDb(db, taskId);
    db.prepare("UPDATE tasks SET workflow_engine = 'native', updated_at = CURRENT_TIMESTAMP WHERE task_id = ?").run(taskId);
    if (cancellation.agile_status === 'cancelled') interruptTaskInterventionsInDb(db, taskId, '采纳历史需求取消意图，停止其剩余系统介入');
    adoptFeedbackWorkItemsInDb(db, taskId);
    adoptPrimaryExecutionBindingsInDb(db, taskId);
    adoptNativeTaskHoldInDb(db, taskId);
    promoteReadyWorkItemsInDb(db, taskId, 'native:adopt');
    return db.prepare('SELECT * FROM workflow_items WHERE task_id = ?').all(taskId) as WorkflowItemRow[];
  })();
}

/** Bind the current historical generation only once. Input/result/reservation
 * snapshots remain immutable; the event captures the identity translation. */
export type HistoricalWorkItemExecution = {
  execution_id: string; agent: string; pipeline: string; story_index: number | null; status: string;
  work_item_id: string | null; work_item_attempt: number | null; dispatch_generation_key: string | null;
  dispatch_reservation_json: string | null;
};
function adoptPrimaryExecutionBindingsInDb(db: Db, taskId: string) {
  const rows = db.prepare(`SELECT execution_id, agent, pipeline, story_index, status,
      work_item_id, work_item_attempt, dispatch_generation_key, dispatch_reservation_json
    FROM execution_attempts WHERE task_id = ? AND pipeline NOT LIKE 'feedback-%'
      AND pipeline != 'intervention' ORDER BY created_at, rowid`).all(taskId) as HistoricalWorkItemExecution[];
  const items = db.prepare(`SELECT * FROM workflow_items WHERE task_id = ? AND origin = 'native'
    AND status != 'superseded' AND (status != 'cancelled' OR ? = 1)`)
    .all(taskId, nativeCancellationInDb(db, taskId) ? 1 : 0) as WorkflowItemRow[];
  for (const item of items) {
    const matching = rows.filter((row) => row.agent === item.agent && row.story_index === item.story_index
      && legacyWorkKeyForExecution({ agent: row.agent, pipeline: row.pipeline, storyIndex: row.story_index }) === item.work_key
      && (!row.work_item_id || row.work_item_id === item.item_id));
    adoptExecutionBindingsForWorkItemInDb(db, item, matching);
  }
  reconcileNativeWorkItemExecutionsInDb(db, taskId);
}

/** Shared adoption policy for primary and Feedback work. Call inside the
 * graph-adoption transaction; terminal history never determines completion. */
export function adoptExecutionBindingsForWorkItemInDb(db: Db, item: WorkflowItemRow,
  matching: HistoricalWorkItemExecution[], options: { bindHistory?: boolean } = {}) {
    const taskId = item.task_id;
    const cancelledWork = item.status === 'cancelled' || Boolean(nativeCancellationInDb(db, taskId));
    if (matching.some((row) => row.agent !== item.agent || row.story_index !== item.story_index
      || item.kind === 'feedback' && row.pipeline !== item.pipeline
      || row.work_item_id && row.work_item_id !== item.item_id)) throw new Error('历史执行与工作项归属不一致');
    for (const planned of matching.filter((row) => row.status === 'planned' || cancelledWork
      && ['running', 'output_received', 'verifying', 'applying'].includes(row.status))) {
      const reason = cancelledWork ? '采纳已取消的历史工作，取消其剩余执行且不消耗错误额度'
        : '切换原生工作图，取消尚未启动的旧派发并重新排队';
      const sequence = planned.work_item_attempt ?? (db.prepare(`SELECT COALESCE(MAX(work_item_attempt), 0) + 1 AS value
        FROM execution_attempts WHERE work_item_id = ?`).get(item.item_id) as { value: number }).value;
      db.prepare(`UPDATE execution_attempts SET status = 'cancelled', failure_kind = NULL,
        dispatch_retry_consumed = 0, retry_not_before = NULL, last_error = ?,
        work_item_id = ?, work_item_attempt = ?, finished_at = CURRENT_TIMESTAMP,
        dispatch_settled_at = CURRENT_TIMESTAMP WHERE execution_id = ? AND status IN ('planned', 'running', 'output_received', 'verifying', 'applying')`)
        .run(reason, item.item_id, sequence, planned.execution_id);
      planned.work_item_id = item.item_id;
      planned.work_item_attempt = sequence;
      releaseExecutionResourceClaimsInDb(db, planned.execution_id);
      if (planned.dispatch_reservation_json) {
        const reservation = JSON.parse(planned.dispatch_reservation_json) as { resourceAcquisitions?: Record<ResourceKey, string> };
        for (const [key, acquisition] of Object.entries(reservation.resourceAcquisitions || {})) {
          if (acquisition === 'acquired' && resourceClaimInDb(db, key as ResourceKey, taskId)?.owner_execution_id === planned.execution_id) {
            releaseResourceClaimInDb(db, key as ResourceKey, taskId);
          }
        }
      }
      recordEventInDb(db, item, { eventKey: `native:cancel-reservation:${planned.execution_id}`, inputHash: hash(planned.execution_id),
        type: 'reservation_cancelled', status: item.status, actor: 'system', authority: 'system',
        reason, executionId: planned.execution_id });
      planned.status = 'cancelled';
    }
    const live = matching.filter((row) => ['running', 'output_received', 'verifying', 'applying'].includes(row.status));
    if (live.length > 1) throw new Error(`工作项 ${item.work_key} 有多个历史活动执行，不能猜测有效来源`);
    if (live.length && item.status === 'completed' && !db.prepare(`SELECT 1 FROM agent_results
      WHERE execution_id = ? AND task_id = ? AND application_status = 'applied' AND effect_outcome = 'advanced'`)
      .get(live[0].execution_id, taskId)) {
      throw new Error(`工作项 ${item.work_key} 已被历史游标标为完成，但活动执行没有成功应用收据；必须先完成旧执行再迁移`);
    }
    const anchor = live[0] || (item.status === 'completed' ? undefined
      : matching.filter((row) => ['retryable_failed', 'system_blocked'].includes(row.status)).at(-1));
    if (!anchor && !options.bindHistory) return;
    const generation = anchor?.dispatch_generation_key;
    const currentRows = anchor ? generation ? matching.filter((row) => row.dispatch_generation_key === generation) : [anchor] : [];
    const bindingRows = options.bindHistory ? matching : currentRows;
    const nextGeneration = hash(JSON.stringify({ itemId: item.item_id, epoch: item.dispatch_epoch }));
    for (const row of bindingRows) {
      const eventKey = `native:bind-execution:${row.execution_id}`;
      if (db.prepare('SELECT 1 FROM workflow_item_events WHERE item_id = ? AND event_key = ?').get(item.item_id, eventKey)) {
        if (row.work_item_attempt == null) throw new Error('历史执行绑定审计与执行序号不一致，不能重新猜测身份');
        continue;
      }
      const sequence = row.work_item_attempt ?? (db.prepare(`SELECT COALESCE(MAX(work_item_attempt), 0) + 1 AS value
        FROM execution_attempts WHERE work_item_id = ?`).get(item.item_id) as { value: number }).value;
      const inCurrentGeneration = currentRows.includes(row);
      db.prepare(`UPDATE execution_attempts SET work_item_id = ?, work_item_attempt = ?, dispatch_generation_key = ?,
        dispatch_retry_consumed = CASE WHEN ? AND status IN ('retryable_failed', 'system_blocked') THEN 1 ELSE dispatch_retry_consumed END
        WHERE execution_id = ?`).run(item.item_id, sequence, inCurrentGeneration ? nextGeneration : row.dispatch_generation_key,
          Number(inCurrentGeneration), row.execution_id);
      recordEventInDb(db, item, { eventKey, inputHash: hash(row.execution_id), type: 'execution_adopted',
        status: item.status, actor: 'system', authority: 'system', reason: '采纳当前历史执行代次，保留原始输入、结果与错误额度',
        executionId: row.execution_id, payload: { previousGeneration: row.dispatch_generation_key,
          generation: inCurrentGeneration ? nextGeneration : row.dispatch_generation_key, sequence, historicalOnly: !inCurrentGeneration } });
    }
    if (anchor && ['pending', 'ready'].includes(item.status)) {
      db.prepare("UPDATE workflow_items SET status = 'running', ready_at = NULL, started_at = COALESCE(started_at, CURRENT_TIMESTAMP) WHERE item_id = ?")
        .run(item.item_id);
      recordEventInDb(db, item, { eventKey: `native:adopt-live:${anchor.execution_id}`, inputHash: hash(anchor.execution_id),
        type: 'execution_attached', status: 'running', actor: 'system', authority: 'system',
        reason: live.length ? '既有执行仍在运行或待应用，保留同一工作项所有权'
          : '采纳历史失败执行，随后按实际错误和依赖释放工作项', executionId: anchor.execution_id });
    }
}

/** Native creation is deliberately separate from historical adoption. */
export function initializeNativeWorkflowInDb(db: Db, input: {
  taskId: string; eventKey: string; actor: string; reason: string;
}) {
  return db.transaction(() => {
    if (!input.eventKey.trim() || !input.reason.trim() || !['human', 'system'].includes(input.actor)) {
      throw new Error('工作图初始化必须提供创建者、事件标识与原因');
    }
    const task = db.prepare('SELECT item_type, workflow_engine FROM tasks WHERE task_id = ?').get(input.taskId) as
      { item_type: string; workflow_engine: string } | undefined;
    if (!task || task.workflow_engine !== 'native') throw new Error('只能初始化原生任务工作图');
    const graph = builtinWorkflow(task.item_type);
    const inputHash = hash(JSON.stringify({ ...input, graph }));
    const prior = db.prepare(`SELECT item.*, event.input_hash FROM workflow_item_events event
      JOIN workflow_items item ON item.item_id = event.item_id WHERE item.task_id = ? AND event.event_key = ?`)
      .all(input.taskId, `created:${input.eventKey}`) as (WorkflowItemRow & { input_hash: string })[];
    if (prior.length) {
      if (prior.length !== graph.items.length || prior.some((item) => item.input_hash !== inputHash)) throw new Error('原生工作图初始化幂等键冲突');
      return prior;
    }
    if (db.prepare('SELECT 1 FROM execution_attempts WHERE task_id = ? LIMIT 1').get(input.taskId)
      || db.prepare('SELECT 1 FROM task_context_chat_sessions WHERE task_id = ? LIMIT 1').get(input.taskId)) {
      throw new Error('有执行历史的任务必须通过回退或迁移处理，不能初始化为新工作');
    }
    if (db.prepare("SELECT 1 FROM workflow_items WHERE task_id = ? AND status NOT IN ('superseded', 'cancelled') LIMIT 1").get(input.taskId)) {
      throw new Error('已有工作图不能重新初始化');
    }
    const ids = new Map<string, string>();
    for (const planned of graph.items) {
      const itemId = randomUUID();
      const revision = (db.prepare('SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM workflow_items WHERE task_id = ? AND work_key = ?')
        .get(input.taskId, planned.workKey) as { revision: number }).revision;
      db.prepare(`INSERT INTO workflow_items(item_id, task_id, work_key, revision, kind, title, agent, pipeline, lane, status, origin)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'native')`)
        .run(itemId, input.taskId, planned.workKey, revision, planned.kind, planned.title, planned.agent, planned.pipeline, planned.lane);
      ids.set(planned.workKey, itemId);
      recordEventInDb(db, itemInDb(db, itemId), { eventKey: `created:${input.eventKey}`, inputHash, type: 'created', status: 'pending',
        actor: input.actor, authority: input.actor === 'human' ? 'human' : 'system', reason: input.reason, payload: { itemType: task.item_type } });
    }
    for (const dependency of graph.dependencies) {
      db.prepare('INSERT INTO workflow_dependencies(item_id, depends_on_item_id, dependency_kind) VALUES(?, ?, ?)')
        .run(ids.get(dependency.workKey), ids.get(dependency.dependsOnWorkKey), dependency.dependencyKind);
    }
    promoteReadyWorkItemsInDb(db, input.taskId, input.eventKey);
    return [...ids.values()].map((id) => itemInDb(db, id));
  })();
}

export function replaceUnstartedNativeWorkflowInDb(db: Db, taskId: string) {
  if (!db.prepare("SELECT 1 FROM tasks WHERE task_id = ? AND workflow_engine = 'native'").get(taskId)) return;
  return db.transaction(() => {
    if (db.prepare('SELECT 1 FROM execution_attempts WHERE task_id = ? LIMIT 1').get(taskId)
      || db.prepare('SELECT 1 FROM task_context_chat_sessions WHERE task_id = ? LIMIT 1').get(taskId)
      || db.prepare("SELECT 1 FROM interventions WHERE task_id = ? AND status IN ('pending', 'running', 'awaiting_human') LIMIT 1").get(taskId)) {
      throw new Error('已开始处理或等待介入的需求不能重新初始化 Pipeline');
    }
    const old = db.prepare("SELECT * FROM workflow_items WHERE task_id = ? AND status NOT IN ('cancelled', 'superseded') ORDER BY item_id")
      .all(taskId) as WorkflowItemRow[];
    if (old.some((item) => !['pending', 'ready'].includes(item.status))) throw new Error('已有执行事实的工作图不能替换');
    const eventKey = `input-pipeline:${hash(JSON.stringify(old.map((item) => item.item_id)))}`;
    for (const item of old) transitionWorkItemInDb(db, { itemId: item.item_id, action: 'cancel', eventKey, actor: 'human', authority: 'human', reason: 'Agent 开始前修改 Pipeline，取消原计划' });
    return initializeNativeWorkflowInDb(db, { taskId, eventKey, actor: 'human', reason: '按修改后的 Pipeline 建立新工作图' });
  })();
}

/** Expand an explicit delivery plan into native nodes. Unit identities come
 * from the persisted plan entities, never from progress cursors. */
export function appendDeliveryWorkItemsInDb(db: Db, input: {
  taskId: string; units: { storyIndex: number; title: string }[]; eventKey: string; actor: string; reason: string;
}) {
  return db.transaction(() => {
    const engine = db.prepare('SELECT workflow_engine FROM tasks WHERE task_id = ?').get(input.taskId) as { workflow_engine: string } | undefined;
    if (engine?.workflow_engine !== 'native') return;
    const plan = db.prepare(`SELECT * FROM workflow_items WHERE task_id = ? AND work_key = 'delivery:plan'
      AND status NOT IN ('superseded', 'cancelled')`).get(input.taskId) as WorkflowItemRow | undefined;
    if (!plan || !input.units.length) throw new Error('原生交付计划缺少规划节点或交付单元');
    const units = [...input.units].sort((a, b) => a.storyIndex - b.storyIndex);
    if (units.some((unit, index) => !Number.isInteger(unit.storyIndex) || unit.storyIndex < 1 || !unit.title.trim()
      || (index > 0 && unit.storyIndex !== units[index - 1].storyIndex + 1))) throw new Error('原生交付单元标识必须唯一且连续');
    const inputHash = hash(JSON.stringify({ ...input, units }));
    if (existingEventInDb(db, plan.item_id, input.eventKey, inputHash)) return;
    assertWritableTask(db, plan, 'resume');
    const activeItem = (key: string) => db.prepare(`SELECT * FROM workflow_items WHERE task_id = ? AND work_key = ?
      AND status NOT IN ('superseded', 'cancelled')`).get(input.taskId, key) as WorkflowItemRow | undefined;
    let review = activeItem('delivery:review');
    if (!review) throw new Error('原生交付图缺少整体验收节点');
    if (review.status !== 'pending') {
      const { replacements } = rewindWorkItemsInDb(db, { taskId: input.taskId, targetItemId: review.item_id,
        eventKey: `${input.eventKey}:review`, actor: input.actor, authority: 'system', reason: input.reason });
      review = itemInDb(db, replacements[review.item_id]);
      // Adding new dependencies must revoke readiness in this same transaction.
      db.prepare("UPDATE workflow_items SET status = 'pending', ready_at = NULL WHERE item_id = ?").run(review.item_id);
    }
    const edge = (itemId: string, upstreamId: string, kind = 'completion') => db.prepare(`
      INSERT OR IGNORE INTO workflow_dependencies(item_id, depends_on_item_id, dependency_kind) VALUES(?, ?, ?)
    `).run(itemId, upstreamId, kind);
    for (const unit of units) {
      const nodes = [
        { key: `delivery:analysis:${unit.storyIndex}`, kind: 'delivery-analysis', agent: 'analyst-agent', pipeline: 'analysis', lane: 'analysis', title: '交付分析' },
        { key: `delivery:dev:${unit.storyIndex}`, kind: 'development', agent: 'dev-agent', pipeline: 'dev', lane: 'delivery', title: '开发' },
        { key: `delivery:test:${unit.storyIndex}`, kind: 'verification', agent: 'test-agent', pipeline: 'test', lane: 'delivery', title: '验证' },
      ];
      if (nodes.some((node) => activeItem(node.key))) throw new Error(`原生交付单元 ${unit.storyIndex} 已存在，拒绝用新计划覆盖`);
      const ids = nodes.map(() => randomUUID());
      nodes.forEach((node, index) => {
        const revision = (db.prepare('SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM workflow_items WHERE task_id = ? AND work_key = ?')
          .get(input.taskId, node.key) as { revision: number }).revision;
        db.prepare(`INSERT INTO workflow_items(item_id, task_id, work_key, revision, kind, title, story_index,
          agent, pipeline, lane, status, origin) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'native')`)
          .run(ids[index], input.taskId, node.key, revision, node.kind, `${node.title} #${unit.storyIndex} · ${unit.title}`,
            unit.storyIndex, node.agent, node.pipeline, node.lane);
      });
      edge(ids[0], plan.item_id);
      if (unit.storyIndex > 1) {
        const previousAnalysis = activeItem(`delivery:analysis:${unit.storyIndex - 1}`);
        const previousTest = activeItem(`delivery:test:${unit.storyIndex - 1}`);
        if (!previousAnalysis || !previousTest) throw new Error('交付计划缺少上一单元的工作项依赖');
        edge(ids[0], previousAnalysis.item_id, 'ordering');
        edge(ids[1], previousTest.item_id, 'ordering');
      }
      edge(ids[1], ids[0]);
      edge(ids[2], ids[1]);
      edge(review.item_id, ids[2]);
    }
    edge(review.item_id, plan.item_id);
    recordEventInDb(db, plan, { eventKey: input.eventKey, inputHash, type: 'plan_expanded', status: plan.status,
      actor: input.actor, authority: 'system', reason: input.reason, payload: { units } });
    promoteReadyWorkItemsInDb(db, input.taskId, input.eventKey);
  })();
}

export type RewindWorkItemsInput = {
  taskId: string; targetItemId: string; eventKey: string; actor: string; authority: Authority; reason: string;
  preserveInterventionId?: string;
};

/** Preserve entities removed by the old current-plan projection's cascading
 * foreign keys, including descendants without a task_id column. This snapshot
 * is audit evidence, never a second scheduler or a live recovery model. */
function deliveryPlanArchiveInDb(db: Db, taskId: string) {
  const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[]).map((row) => row.name);
  const schema = new Map(tables.map((table) => [table, {
    keys: db.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all() as
      { id: number; seq: number; table: string; from: string; to: string | null }[],
    columns: db.prepare(`PRAGMA table_info(${quote(table)})`).all() as { name: string; pk: number }[],
  }]));
  const archived: Record<string, unknown[]> = {};
  const filterFor = (table: string, path = new Set<string>()): string | null => {
    if (table === 'stories') return 'entity.task_id = @archiveTaskId';
    if (path.has(table) || !schema.has(table)) return null;
    const nextPath = new Set([...path, table]);
    const definition = schema.get(table)!;
    const groups = new Map<number, typeof definition.keys>();
    for (const key of definition.keys) groups.set(key.id, [...(groups.get(key.id) || []), key]);
    const conditions: string[] = [];
    for (const keys of groups.values()) {
      const parentFilter = filterFor(keys[0].table, nextPath);
      if (!parentFilter) continue;
      const primaryKey = schema.get(keys[0].table)!.columns.filter((column) => column.pk).sort((a, b) => a.pk - b.pk);
      const relations = keys.sort((a, b) => a.seq - b.seq).map((key) => {
        const parentColumn = key.to || primaryKey[key.seq]?.name;
        if (!parentColumn) throw new Error(`无法归档交付计划的外键：${table}`);
        return `parent.${quote(parentColumn)} = entity.${quote(key.from)}`;
      }).join(' AND ');
      conditions.push(`EXISTS (SELECT 1 FROM (SELECT entity.* FROM ${quote(keys[0].table)} entity WHERE ${parentFilter}) parent WHERE ${relations})`);
    }
    if (!conditions.length) return null;
    // Select the actual FK closure, not a guessed task_id ownership shortcut:
    // every row affected by a cascade must retain its original evidence.
    return `(${conditions.join(' OR ')})`;
  };
  for (const table of tables) {
    const filter = filterFor(table);
    if (!filter) continue;
    const rows = db.prepare(`SELECT entity.* FROM ${quote(table)} entity WHERE ${filter}`).all({ archiveTaskId: taskId });
    if (rows.length) archived[table] = rows;
  }
  return archived;
}

/** Replace the target and its dependent closure, never erase an old result.
 * Upstream/unrelated nodes stay untouched; all surviving edges point at the new
 * revision so old completion cannot accidentally unlock new work. */
export function rewindWorkItemsInDb(db: Db, input: RewindWorkItemsInput) {
  return db.transaction(() => {
    if (!input.reason.trim() || !input.eventKey.trim()) throw new Error('工作项回退必须提供原因与事件标识');
    const target = itemInDb(db, input.targetItemId);
    if (target.task_id !== input.taskId || target.origin !== 'native') throw new Error('回退目标必须是当前需求的原生工作项');
    const inputHash = hash(JSON.stringify(input));
    const existing = existingEventInDb(db, target.item_id, input.eventKey, inputHash);
    if (existing) return JSON.parse(existing.payload_json) as { replacements: Record<string, string> };
    if (['superseded', 'cancelled'].includes(target.status)) throw new Error('回退目标已失效');
    const ownArbitration = input.authority === 'arbitration' && input.preserveInterventionId
      && db.prepare(`SELECT 1 FROM interventions WHERE intervention_id = ? AND task_id = ?
        AND authority = 'arbitration' AND status IN ('pending','running','awaiting_human')`)
        .get(input.preserveInterventionId, input.taskId);
    assertWritableTask(db, target, 'resume', ownArbitration ? input.preserveInterventionId : undefined);
    const items = db.prepare(`
      WITH RECURSIVE affected(item_id) AS (
        SELECT ? UNION
        SELECT dependency.item_id FROM workflow_dependencies dependency
        JOIN affected ON affected.item_id = dependency.depends_on_item_id
        JOIN workflow_items child ON child.item_id = dependency.item_id
        WHERE child.status NOT IN ('superseded', 'cancelled')
      ) SELECT item.* FROM workflow_items item JOIN affected ON affected.item_id = item.item_id
    `).all(target.item_id) as WorkflowItemRow[];
    if (items.some((item) => item.origin !== 'native')) throw new Error('回退闭包中仍有未迁移的工作项');
    const plan = items.find((item) => item.work_key === 'delivery:plan');
    const planArchive = plan ? deliveryPlanArchiveInDb(db, input.taskId) : undefined;
    const replacements: Record<string, string> = {};
    for (const item of items) {
      const nextId = randomUUID();
      replacements[item.item_id] = nextId;
      const activeExecutions = db.prepare(`
        SELECT execution_id FROM execution_attempts WHERE work_item_id = ?
          AND pipeline NOT IN ('intervention', 'verification-assistance')
          AND status IN ('planned', 'running', 'output_received', 'verifying', 'applying')
      `).all(item.item_id) as { execution_id: string }[];
      for (const execution of activeExecutions) {
        db.prepare(`UPDATE execution_attempts SET status = 'cancelled', last_error = ?,
          finished_at = CURRENT_TIMESTAMP, dispatch_retry_consumed = 0 WHERE execution_id = ?`)
          .run(`工作项回退：${input.reason}`, execution.execution_id);
        releaseExecutionResourceClaimsInDb(db, execution.execution_id);
      }
      // Code leases may outlive the CLI for the Dev/Test handoff. Invalidate
      // only affected node owners, including their finished sources; unrelated
      // nodes in this requirement must retain their own leases.
      db.prepare(`DELETE FROM resource_claims WHERE owner_execution_id IN (
        SELECT execution_id FROM execution_attempts WHERE work_item_id = ? AND task_id = ?
      )`).run(item.item_id, input.taskId);
      db.prepare("UPDATE workflow_items SET status = 'superseded', updated_at = CURRENT_TIMESTAMP WHERE item_id = ?").run(item.item_id);
      const revision = (db.prepare('SELECT MAX(revision) + 1 AS revision FROM workflow_items WHERE task_id = ? AND work_key = ?')
        .get(input.taskId, item.work_key) as { revision: number }).revision;
      db.prepare(`
        INSERT INTO workflow_items(item_id, task_id, work_key, revision, kind, title, story_index,
          agent, pipeline, lane, status, origin, context_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'native', ?)
      `).run(nextId, input.taskId, item.work_key, revision, item.kind, item.title, item.story_index, item.agent, item.pipeline, item.lane, item.context_json || '{}');
      db.prepare('UPDATE workflow_items SET superseded_by_item_id = ? WHERE item_id = ?').run(nextId, item.item_id);
      const interventions = db.prepare(`SELECT intervention_id, current_execution_id FROM interventions WHERE item_id = ?
        AND status IN ('pending', 'running', 'awaiting_human')`).all(item.item_id) as {
          intervention_id: string; current_execution_id: string | null;
        }[];
      for (const intervention of interventions) {
        if (intervention.intervention_id === input.preserveInterventionId) {
          db.prepare('UPDATE interventions SET item_id = ?, updated_at = CURRENT_TIMESTAMP WHERE intervention_id = ?')
            .run(nextId, intervention.intervention_id);
          continue;
        }
        db.prepare(`UPDATE interventions SET status = 'superseded', active_session_id = NULL, command_token_hash = NULL,
          updated_at = CURRENT_TIMESTAMP WHERE intervention_id = ?`).run(intervention.intervention_id);
        db.prepare(`UPDATE intervention_attempts SET status = 'cancelled', reason = ?, finished_at = CURRENT_TIMESTAMP
          WHERE intervention_id = ? AND status = 'running'`).run(input.reason, intervention.intervention_id);
        if (intervention.current_execution_id) {
          db.prepare(`UPDATE execution_attempts SET status = 'cancelled', dispatch_retry_consumed = 0,
            last_error = ?, finished_at = CURRENT_TIMESTAMP WHERE execution_id = ? AND status NOT IN ('applied', 'cancelled')`)
            .run(input.reason, intervention.current_execution_id);
          releaseExecutionResourceClaimsInDb(db, intervention.current_execution_id);
        }
        db.prepare("UPDATE questions SET status = 'superseded', updated_at = CURRENT_TIMESTAMP WHERE intervention_id = ? AND status IN ('pending', 'conditional')")
          .run(intervention.intervention_id);
        db.prepare("UPDATE runtime_input_requests SET status = 'superseded', updated_at = CURRENT_TIMESTAMP WHERE intervention_id = ? AND status = 'pending'")
          .run(intervention.intervention_id);
      }
    }
    for (const item of items) {
      const edges = db.prepare('SELECT depends_on_item_id, dependency_kind FROM workflow_dependencies WHERE item_id = ?')
        .all(item.item_id) as { depends_on_item_id: string; dependency_kind: string }[];
      for (const edge of edges) {
        db.prepare('INSERT INTO workflow_dependencies(item_id, depends_on_item_id, dependency_kind) VALUES(?, ?, ?)')
          .run(replacements[item.item_id], replacements[edge.depends_on_item_id] || edge.depends_on_item_id, edge.dependency_kind);
      }
      recordEventInDb(db, item, { eventKey: input.eventKey, inputHash, type: 'rewind', status: 'superseded',
        actor: input.actor, authority: input.authority, reason: input.reason, payload: { replacements } });
    }
    if (plan) {
      // Units belong to a frozen plan, not to an independently reusable graph
      // revision. Invalidating that plan must drop its expanded units in the
      // same transaction as the rewind, before any readiness can be promoted.
      for (const item of items.filter((item) => /^delivery:(analysis|dev|test):\d+$/.test(item.work_key))) {
        const nextId = replacements[item.item_id];
        transitionWorkItemInDb(db, { itemId: nextId, action: 'cancel', eventKey: `${input.eventKey}:plan-unit-dropped`,
          actor: input.actor, authority: input.authority, reason: '冻结交付计划已失效，等待新计划重新创建单元' });
        db.prepare(`DELETE FROM workflow_dependencies WHERE depends_on_item_id = ?
          AND item_id IN (SELECT item_id FROM workflow_items WHERE task_id = ? AND status NOT IN ('superseded', 'cancelled'))`)
          .run(nextId, input.taskId);
      }
      recordEventInDb(db, plan, { eventKey: `${input.eventKey}:plan-invalidated`, inputHash,
        type: 'delivery_plan_invalidated', status: 'superseded', actor: input.actor, authority: input.authority,
        reason: input.reason, payload: { replacements, archivedEntities: planArchive } });
      db.prepare('DELETE FROM stories WHERE task_id = ?').run(input.taskId);
    }
    promoteReadyWorkItemsInDb(db, input.taskId, input.eventKey);
    return { replacements };
  })();
}
