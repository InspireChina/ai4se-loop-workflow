import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FeedbackBatch, FeedbackGroup } from './tasks';
import type { WorkflowItemRow } from './work-items';
import { promoteReadyWorkItemsInDb, adoptExecutionBindingsForWorkItemInDb,
  reconcileNativeWorkItemExecutionsInDb, type HistoricalWorkItemExecution } from './work-item-transitions';

type Db = Database.Database;
export type FeedbackItemContext = {
  purpose: 'feedback'; feedbackBatchId: string; feedbackGroupId?: string;
  feedbackIds: string[]; feedbackId: string; groupOrder?: number;
  groups?: { groupId: string; workType: FeedbackGroup['work_type']; legacyTerminalStatus?: 'completed' | 'reopened' | 'cancelled'; legacyCompletedAt?: string | null }[];
  legacyTerminalStatus?: 'completed' | 'cancelled'; legacyCompletedAt?: string | null;
};
export function nativeFeedbackInDb(db: Db, taskId: string) {
  return Boolean(db.prepare("SELECT 1 FROM tasks WHERE task_id = ? AND workflow_engine = 'native'").get(taskId));
}
export function feedbackSourceItemInDb(db: Db, input: { taskId: string; executionId?: string;
  pipeline: string; batchId?: string; groupId?: string; commentId?: string }) {
  if (!nativeFeedbackInDb(db, input.taskId)) return null;
  const item = input.executionId && db.prepare(`SELECT item.* FROM execution_attempts execution
    JOIN workflow_items item ON item.item_id = execution.work_item_id
    WHERE execution.execution_id = ? AND execution.task_id = ? AND item.task_id = execution.task_id
      AND item.agent = execution.agent AND item.origin = 'native' AND item.pipeline = ?
      AND item.status = 'running' AND execution.status != 'cancelled'
      AND NOT EXISTS (SELECT 1 FROM workflow_dependencies dependency JOIN workflow_items upstream ON upstream.item_id = dependency.depends_on_item_id
        WHERE dependency.item_id = item.item_id AND upstream.status != 'completed')
      AND NOT EXISTS (SELECT 1 FROM interventions intervention WHERE intervention.item_id = item.item_id
        AND intervention.status IN ('pending', 'running', 'awaiting_human'))`)
    .get(input.executionId, input.taskId, input.pipeline) as WorkflowItemRow | undefined;
  if (!item) throw new Error('反馈结果缺少就绪工作项的有效来源执行');
  const scope = JSON.parse(item.context_json || '{}') as FeedbackItemContext;
  if (scope.purpose !== 'feedback' || input.batchId && scope.feedbackBatchId !== input.batchId
    || input.groupId && scope.feedbackGroupId !== input.groupId || input.commentId && scope.feedbackId !== input.commentId) {
    throw new Error('反馈结果与冻结工作项归属不一致');
  }
  return { item, scope };
}
function current(db: Db, taskId: string, key: string) {
  return db.prepare(`SELECT * FROM workflow_items WHERE task_id = ? AND work_key = ?
    AND status NOT IN ('superseded', 'cancelled') ORDER BY revision DESC LIMIT 1`).get(taskId, key) as WorkflowItemRow | undefined;
}
function comments(db: Db, scope: 'batch' | 'group', id: string) {
  return (db.prepare(`SELECT comment_id FROM feedback_${scope}_comments WHERE ${scope}_id = ? ORDER BY comment_id`)
    .all(id) as { comment_id: string }[]).map((row) => row.comment_id);
}
function insert(db: Db, taskId: string, key: string, title: string, pipeline: string, agent: string,
  context: FeedbackItemContext, status: WorkflowItemRow['status'] = 'pending') {
  const existing = current(db, taskId, key);
  if (existing) return existing.item_id;
  const id = randomUUID();
  const revision = (db.prepare('SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM workflow_items WHERE task_id = ? AND work_key = ?')
    .get(taskId, key) as { revision: number }).revision;
  db.prepare(`INSERT INTO workflow_items(item_id, task_id, work_key, revision, kind, title, agent, pipeline, lane,
    status, origin, context_json, completed_at, completion_authority, completion_reason)
    VALUES(?, ?, ?, ?, 'feedback', ?, ?, ?, 'control', ?, 'native', ?,
      CASE WHEN ? = 'completed' THEN CURRENT_TIMESTAMP END,
      CASE WHEN ? = 'completed' THEN 'system' END, CASE WHEN ? = 'completed' THEN '采纳历史反馈事实' END)`)
    .run(id, taskId, key, revision, title, agent, pipeline, status, JSON.stringify(context), status, status, status);
  db.prepare(`INSERT INTO workflow_item_events(event_id, item_id, event_key, input_hash, event_type,
    from_status, to_status, actor, authority, reason, payload_json)
    VALUES(?, ?, 'feedback:create', ?, 'created', ?, ?, 'system', 'system', '建立冻结反馈工作项', ?)`)
    .run(randomUUID(), id, key, status, status, JSON.stringify(context));
  return id;
}
function edge(db: Db, item: string, upstream: string) {
  db.prepare('INSERT OR IGNORE INTO workflow_dependencies(item_id, depends_on_item_id) VALUES(?, ?)').run(item, upstream);
}
export function createFeedbackBatchWorkInDb(db: Db, taskId: string, batch: FeedbackBatch, historical = false) {
  if (!nativeFeedbackInDb(db, taskId)) return;
  const ids = comments(db, 'batch', batch.batch_id);
  if (!ids.length) return;
  const hasGroups = Boolean(db.prepare('SELECT 1 FROM feedback_groups WHERE batch_id = ? LIMIT 1').get(batch.batch_id));
  const status = batch.status === 'cancelled' ? 'cancelled'
    : historical && (hasGroups || !['triaging', 'waiting_for_answers'].includes(batch.status)) ? 'completed'
      : batch.status === 'waiting_for_answers' ? 'waiting' : 'pending';
  return insert(db, taskId, `feedback:triage:${batch.batch_id}`, `反馈批次 ${batch.batch_number} · 分流`,
    'feedback-triage', 'feedback-agent', { purpose: 'feedback', feedbackBatchId: batch.batch_id,
      feedbackIds: ids, feedbackId: ids[0], ...(historical && ['completed', 'cancelled'].includes(batch.status)
        ? { legacyTerminalStatus: batch.status as 'completed' | 'cancelled', legacyCompletedAt: batch.completed_at } : {}) }, status);
}

/** Create once from frozen group entities. Later scheduling consults these
 * nodes and edges, never the mutable batch/group status fields. */
export function createFeedbackGroupWorkInDb(db: Db, taskId: string, group: FeedbackGroup, historical = false) {
  if (!nativeFeedbackInDb(db, taskId)) return;
  const triage = current(db, taskId, `feedback:triage:${group.batch_id}`);
  if (!triage) throw new Error('反馈工作组缺少冻结批次工作项');
  const ids = comments(db, 'group', group.group_id);
  if (!ids.length) throw new Error('反馈工作组缺少冻结评论');
  const context: FeedbackItemContext = { purpose: 'feedback', feedbackBatchId: group.batch_id,
    feedbackGroupId: group.group_id, feedbackIds: ids, feedbackId: ids[0], groupOrder: group.group_order };
  if (group.status === 'cancelled' || ['reply', 'historical_correction', 'learning_only'].includes(group.work_type)) return;
  const done = historical && ['completed', 'reopened'].includes(group.status);
  let predecessor = triage.item_id;
  if (group.work_type === 'bug') {
    const past = historical && !['waiting_for_repro', 'planned'].includes(group.status);
    const waiting = historical && Boolean(db.prepare("SELECT 1 FROM feedback_batches WHERE batch_id = ? AND status = 'waiting_for_answers'").get(group.batch_id));
    const repro = insert(db, taskId, `feedback:repro:${group.group_id}`, `${group.title || group.reason} · 复现`,
      'feedback-repro', 'repro-agent', context, done || past ? 'completed' : waiting ? 'waiting' : 'pending');
    edge(db, repro, predecessor); predecessor = repro;
  }
  const report = group.work_type === 'report_correction';
  const past = historical && !['waiting_for_plan', 'waiting_for_repro', 'planned', 'executing'].includes(group.status);
  const planned = historical && (group.status === 'executing' && !report || past || done);
  const work = insert(db, taskId, `feedback:${report ? 'report' : 'split'}:${group.group_id}`,
    `${group.title || group.reason} · ${report ? '报告修订' : '追加规划'}`,
    report ? 'feedback-report' : 'feedback-split', report ? 'review-agent' : 'story-splitter-agent', context,
    planned ? 'completed' : 'pending');
  edge(db, work, predecessor);
  const units = db.prepare('SELECT story_index FROM feedback_group_delivery_units WHERE task_id = ? AND group_id = ?')
    .all(taskId, group.group_id) as { story_index: number }[];
  let previous: string | undefined;
  for (const commentId of ids) {
    const resolved = historical && Boolean(db.prepare("SELECT 1 FROM document_comments WHERE comment_id = ? AND status = 'resolved'").get(commentId));
    const verify = insert(db, taskId, `feedback:verify:${group.group_id}:${commentId}`, `${group.title || group.reason} · 独立验证`,
      'feedback-verify', 'feedback-agent', { ...context, feedbackId: commentId }, done || resolved ? 'completed' : 'pending');
    edge(db, verify, work);
    if (previous) edge(db, verify, previous);
    previous = verify;
    for (const unit of units) {
      const test = current(db, taskId, `delivery:test:${unit.story_index}`);
      if (!test) throw new Error('反馈追加单元缺少 Test 工作项');
      edge(db, verify, test.item_id);
    }
  }
}

export function attachFeedbackUnitsInDb(db: Db, taskId: string, groupId: string, units: number[]) {
  if (!nativeFeedbackInDb(db, taskId)) return;
  const split = current(db, taskId, `feedback:split:${groupId}`);
  if (!split) throw new Error('反馈追加规划缺少来源工作项');
  for (const unit of units) {
    const analysis = current(db, taskId, `delivery:analysis:${unit}`);
    const test = current(db, taskId, `delivery:test:${unit}`);
    if (!analysis || !test) throw new Error('反馈追加单元缺少原生工作项');
    edge(db, analysis.item_id, split.item_id);
    const verifies = db.prepare(`SELECT item_id FROM workflow_items WHERE task_id = ? AND origin = 'native'
      AND pipeline = 'feedback-verify' AND json_extract(context_json, '$.feedbackGroupId') = ?
      AND status NOT IN ('superseded', 'cancelled')`).all(taskId, groupId) as { item_id: string }[];
    for (const verify of verifies) edge(db, verify.item_id, test.item_id);
    // appendDelivery may promote Analysis before this newly introduced edge.
    db.prepare("UPDATE workflow_items SET status = 'pending', ready_at = NULL WHERE item_id = ? AND status = 'ready'").run(analysis.item_id);
  }
  // Appending units may replace a previously completed Review. The new node
  // must wait for feedback verification, not just its newly appended Test.
  const context = JSON.parse(split.context_json || '{}') as FeedbackItemContext;
  attachFeedbackBatchBarriersInDb(db, taskId, context.feedbackBatchId);
}

/** A report correction is based on the completed forward work in its batch,
 * not whichever group happens to sort first in the control channel. */
export function attachFeedbackBatchBarriersInDb(db: Db, taskId: string, batchId: string) {
  if (!nativeFeedbackInDb(db, taskId)) return;
  const items = db.prepare(`SELECT * FROM workflow_items WHERE task_id = ? AND kind = 'feedback'
    AND json_extract(context_json, '$.feedbackBatchId') = ? AND status NOT IN ('superseded', 'cancelled')`)
    .all(taskId, batchId) as WorkflowItemRow[];
  const reports = items.filter((item) => item.pipeline === 'feedback-report');
  const reportGroups = new Set(reports.map((item) => (JSON.parse(item.context_json || '{}') as FeedbackItemContext).feedbackGroupId));
  const forwardVerifications = items.filter((item) => item.pipeline === 'feedback-verify'
    && !reportGroups.has((JSON.parse(item.context_json || '{}') as FeedbackItemContext).feedbackGroupId));
  for (const report of reports) for (const verification of forwardVerifications) edge(db, report.item_id, verification.item_id);
  const review = current(db, taskId, 'delivery:review');
  if (review && ['pending', 'ready'].includes(review.status)) {
    for (const verification of items.filter((item) => item.pipeline === 'feedback-verify')) edge(db, review.item_id, verification.item_id);
    if (items.some((item) => item.pipeline === 'feedback-verify' && item.status !== 'completed')) {
      db.prepare("UPDATE workflow_items SET status = 'pending', ready_at = NULL WHERE item_id = ? AND status = 'ready'").run(review.item_id);
    }
  }
}

export function captureFeedbackGroupDescriptorsInDb(db: Db, taskId: string, batchId: string, historical = false) {
  if (!nativeFeedbackInDb(db, taskId)) return;
  const triage = db.prepare('SELECT * FROM workflow_items WHERE task_id = ? AND work_key = ? ORDER BY revision DESC LIMIT 1')
    .get(taskId, `feedback:triage:${batchId}`) as WorkflowItemRow | undefined;
  if (!triage) return;
  const context = JSON.parse(triage.context_json || '{}') as FeedbackItemContext;
  if (context.groups) return;
  const groups = db.prepare('SELECT group_id, work_type, status, completed_at FROM feedback_groups WHERE batch_id = ? ORDER BY group_order')
    .all(batchId) as Pick<FeedbackGroup, 'group_id' | 'work_type' | 'status' | 'completed_at'>[];
  if (!groups.length) return;
  context.groups = groups.map((group) => ({ groupId: group.group_id, workType: group.work_type,
    ...(historical && ['completed', 'reopened', 'cancelled'].includes(group.status)
      ? { legacyTerminalStatus: group.status as 'completed' | 'reopened' | 'cancelled', legacyCompletedAt: group.completed_at } : {}) }));
  db.prepare('UPDATE workflow_items SET context_json = ? WHERE item_id = ?').run(JSON.stringify(context), triage.item_id);
}

export function adoptFeedbackWorkItemsInDb(db: Db, taskId: string) {
  if (!nativeFeedbackInDb(db, taskId)) return;
  return db.transaction(() => {
    const batches = db.prepare('SELECT * FROM feedback_batches WHERE task_id = ? ORDER BY batch_number').all(taskId) as FeedbackBatch[];
    for (const batch of batches) {
      // Presence of the batch node is the durable adoption boundary. Never
      // infer completion again from the old states, including after restart.
      if (db.prepare('SELECT 1 FROM workflow_items WHERE task_id = ? AND work_key = ?').get(taskId, `feedback:triage:${batch.batch_id}`)) {
        captureFeedbackGroupDescriptorsInDb(db, taskId, batch.batch_id);
        // Reconcile graph-only barriers after a cold upgrade or Review rewind;
        // never adopt terminal state again from mutable batch/group fields.
        attachFeedbackBatchBarriersInDb(db, taskId, batch.batch_id);
        continue;
      }
      createFeedbackBatchWorkInDb(db, taskId, batch, true);
      captureFeedbackGroupDescriptorsInDb(db, taskId, batch.batch_id, true);
      for (const group of batch.status === 'cancelled' ? [] : db.prepare('SELECT * FROM feedback_groups WHERE batch_id = ? ORDER BY group_order').all(batch.batch_id) as FeedbackGroup[]) {
        createFeedbackGroupWorkInDb(db, taskId, group, true);
      }
      attachFeedbackBatchBarriersInDb(db, taskId, batch.batch_id);
      const executions = db.prepare(`SELECT execution_id, agent, pipeline, story_index, status, input_json,
          work_item_id, work_item_attempt, dispatch_generation_key, dispatch_reservation_json FROM execution_attempts
        WHERE task_id = ? AND work_item_id IS NULL AND pipeline LIKE 'feedback-%' ORDER BY rowid`)
        .all(taskId) as (HistoricalWorkItemExecution & { input_json: string })[];
      const bindings = new Map<string, { item: WorkflowItemRow; rows: HistoricalWorkItemExecution[] }>();
      for (const execution of executions) {
        let scope: { feedbackBatchId?: string; feedbackGroupId?: string; feedbackId?: string };
        try { scope = JSON.parse(execution.input_json).delegation || {}; } catch {
          if (['planned', 'running', 'output_received', 'verifying', 'applying'].includes(execution.status)) {
            throw new Error('历史 Feedback 活动执行输入无法解析，不能猜测工作项归属');
          }
          continue;
        }
        if (scope.feedbackBatchId !== batch.batch_id) continue;
        const kind = execution.pipeline.slice('feedback-'.length);
        const key = kind === 'triage' ? `feedback:triage:${batch.batch_id}`
          : kind === 'verify' ? `feedback:verify:${scope.feedbackGroupId}:${scope.feedbackId}` : `feedback:${kind}:${scope.feedbackGroupId}`;
        let item = db.prepare('SELECT * FROM workflow_items WHERE task_id = ? AND work_key = ? ORDER BY revision DESC LIMIT 1')
          .get(taskId, key) as WorkflowItemRow | undefined;
        if (!item && batch.status === 'cancelled') {
          const group = scope.feedbackGroupId && db.prepare(`SELECT group_id FROM feedback_groups group_row
            JOIN feedback_batches batch ON batch.batch_id = group_row.batch_id
            WHERE batch.task_id = ? AND group_row.batch_id = ? AND group_id = ?`)
            .get(taskId, batch.batch_id, scope.feedbackGroupId);
          const ids = group ? comments(db, 'group', scope.feedbackGroupId!) : [];
          const expectedAgent = { repro: 'repro-agent', split: 'story-splitter-agent', report: 'review-agent', verify: 'feedback-agent' }[kind];
          if (group && ids.length && expectedAgent === execution.agent && (kind !== 'verify' || ids.includes(scope.feedbackId || ''))) {
            insert(db, taskId, key, '已取消历史反馈执行', execution.pipeline, expectedAgent,
              { purpose: 'feedback', feedbackBatchId: batch.batch_id, feedbackGroupId: scope.feedbackGroupId,
                feedbackIds: ids, feedbackId: scope.feedbackId || ids[0] }, 'cancelled');
            item = db.prepare('SELECT * FROM workflow_items WHERE task_id = ? AND work_key = ? ORDER BY revision DESC LIMIT 1')
              .get(taskId, key) as WorkflowItemRow;
          }
        }
        if (!item) {
          if (['planned', 'running', 'output_received', 'verifying', 'applying'].includes(execution.status)) {
            throw new Error('历史 Feedback 活动执行缺少冻结工作项，不能迁移');
          }
          continue;
        }
        const binding = bindings.get(item.item_id) || { item, rows: [] };
        binding.rows.push(execution);
        bindings.set(item.item_id, binding);
      }
      for (const binding of bindings.values()) adoptExecutionBindingsForWorkItemInDb(db, binding.item, binding.rows, { bindHistory: true });
      // Historical human inputs have no Feedback work key in the old model.
      // Rebind their Intervention to the captured waiting role, without
      // resolving it or fabricating an answer.
      const inputs = db.prepare(`SELECT intervention.intervention_id, question.source_agent FROM questions question
        JOIN interventions intervention ON intervention.intervention_id = question.intervention_id
        WHERE question.task_id = ? AND intervention.item_id IS NULL AND intervention.status = 'awaiting_human'
          AND question.status = 'pending'`).all(taskId) as { intervention_id: string; source_agent: string }[];
      for (const input of inputs) {
        const waiting = db.prepare(`SELECT item_id FROM workflow_items WHERE task_id = ? AND kind = 'feedback'
          AND status = 'waiting' AND agent = ? AND json_extract(context_json, '$.feedbackBatchId') = ? LIMIT 1`)
          .get(taskId, input.source_agent, batch.batch_id) as { item_id: string } | undefined;
        if (waiting) db.prepare('UPDATE interventions SET item_id = ? WHERE intervention_id = ? AND item_id IS NULL')
          .run(waiting.item_id, input.intervention_id);
      }
    }
    // Older native adoption filled IDs without an attempt sequence. Repair
    // only already-bound history; never attach a new unbound execution to an
    // existing graph based on mutable batch status or a guessed latest role.
    const incompleteBindings = db.prepare(`SELECT item.* FROM workflow_items item
      WHERE item.task_id = ? AND item.origin = 'native' AND item.kind = 'feedback'
        AND EXISTS (SELECT 1 FROM execution_attempts execution WHERE execution.work_item_id = item.item_id
          AND execution.task_id = item.task_id AND execution.work_item_attempt IS NULL)`)
      .all(taskId) as WorkflowItemRow[];
    for (const item of incompleteBindings) {
      const rows = db.prepare(`SELECT execution_id, agent, pipeline, story_index, status, work_item_id,
        work_item_attempt, dispatch_generation_key, dispatch_reservation_json FROM execution_attempts
        WHERE work_item_id = ? AND task_id = ? ORDER BY created_at, rowid`)
        .all(item.item_id, taskId) as HistoricalWorkItemExecution[];
      adoptExecutionBindingsForWorkItemInDb(db, item, rows, { bindHistory: true });
    }
    reconcileNativeWorkItemExecutionsInDb(db, taskId);
    promoteReadyWorkItemsInDb(db, taskId, 'feedback:adopt');
  })();
}
