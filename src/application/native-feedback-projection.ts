import type Database from 'better-sqlite3';
import type { FeedbackBatch, FeedbackGroup } from './tasks';
import type { WorkflowItemRow } from './work-items';
import { nativeFeedbackInDb, type FeedbackItemContext } from './work-item-feedback';

/** Compatibility read models only: this routine performs no DB writes and
 * never treats the old batch/group status as a workflow fact. */
export function projectNativeFeedbackReadModelsInDb(db: Database.Database, taskId: string,
  batches: FeedbackBatch[], groups: FeedbackGroup[]) {
  if (!nativeFeedbackInDb(db, taskId)) return;
  const nodes = db.prepare(`SELECT * FROM workflow_items WHERE task_id = ? AND origin = 'native' AND kind = 'feedback'
    AND status != 'superseded' ORDER BY revision DESC`).all(taskId) as WorkflowItemRow[];
  const contexts = new Map(nodes.map((node) => [node.item_id, JSON.parse(node.context_json || '{}') as FeedbackItemContext]));
  const latest = (items: WorkflowItemRow[]) => {
    const result = new Map<string, WorkflowItemRow>();
    for (const item of items) if (!result.has(item.work_key)) result.set(item.work_key, item);
    return [...result.values()];
  };
  const current = latest(nodes);
  const lastDate = (items: WorkflowItemRow[], field: 'completed_at' | 'updated_at') =>
    items.map((item) => item[field]).filter((date): date is string => Boolean(date)).sort().at(-1) || null;
  const failures = new Map<string, string>();
  const waitingAnswers = new Set<string>();
  for (const item of current.filter((item) => item.status === 'waiting')) {
    if (db.prepare(`SELECT 1 FROM questions question JOIN interventions intervention ON intervention.intervention_id = question.intervention_id
      WHERE intervention.item_id = ? AND question.status IN ('pending', 'answered') LIMIT 1`).get(item.item_id)) waitingAnswers.add(item.item_id);
    const failure = db.prepare(`SELECT status, last_error FROM execution_attempts WHERE work_item_id = ? AND agent = ? AND pipeline != 'intervention'
      ORDER BY work_item_attempt DESC, rowid DESC LIMIT 1`).get(item.item_id, item.agent) as { status: string; last_error: string } | undefined;
    const arbitration = db.prepare(`SELECT summary FROM interventions WHERE item_id = ?
      AND authority = 'arbitration' AND status IN ('pending', 'running', 'awaiting_human') LIMIT 1`).get(item.item_id) as { summary: string } | undefined;
    if (failure?.status === 'system_blocked') failures.set(item.item_id, failure.last_error);
    else if (!waitingAnswers.has(item.item_id) && arbitration) {
      failures.set(item.item_id, arbitration.summary);
    }
  }
  for (const group of groups) {
    const batchItems = current.filter((item) => contexts.get(item.item_id)?.feedbackBatchId === group.batch_id);
    const items = batchItems.filter((item) => contexts.get(item.item_id)?.feedbackGroupId === group.group_id);
    const triage = batchItems.find((item) => item.pipeline === 'feedback-triage');
    const descriptor = triage && contexts.get(triage.item_id)?.groups?.find((entry) => entry.groupId === group.group_id);
    const verifies = items.filter((item) => item.pipeline === 'feedback-verify');
    const reopened = verifies.some((item) => item.status === 'completed' && db.prepare(`SELECT 1 FROM execution_receipts receipt
      JOIN execution_attempts execution ON execution.execution_id = receipt.execution_id
      WHERE execution.work_item_id = ? AND receipt.kind = 'feedback_verification'
        AND json_extract(receipt.payload_json, '$.verdict') = 'reopened'`).get(item.item_id));
    const blocked = items.some((item) => failures.has(item.item_id));
    if (triage?.status === 'cancelled' || items.length && items.every((item) => item.status === 'cancelled')) group.status = 'cancelled';
    else if (reopened || descriptor?.legacyTerminalStatus === 'reopened') group.status = 'reopened';
    else if (blocked) group.status = 'system_blocked';
    else if (items.length && items.every((item) => item.status === 'completed')
      || !items.length && triage?.status === 'completed' && descriptor
        && ['reply', 'historical_correction', 'learning_only'].includes(descriptor.workType)) group.status = 'completed';
    else if (items.some((item) => item.pipeline === 'feedback-repro' && item.status !== 'completed')) group.status = 'waiting_for_repro';
    else if (items.some((item) => item.pipeline === 'feedback-split' && item.status !== 'completed')) group.status = 'waiting_for_plan';
    else if (verifies.some((item) => ['ready', 'running', 'waiting'].includes(item.status))) group.status = 'ready_for_verification';
    else group.status = items.length ? 'executing' : 'planned';
    group.completed_at = ['completed', 'reopened', 'cancelled'].includes(group.status)
      ? descriptor?.legacyTerminalStatus ? descriptor.legacyCompletedAt || null
        : lastDate(items.length ? items : triage ? [triage] : [], group.status === 'cancelled' ? 'updated_at' : 'completed_at') : null;
    group.updated_at = lastDate(items.length ? items : triage ? [triage] : [], 'updated_at') || group.created_at;
  }
  for (const batch of batches) {
    const items = current.filter((item) => contexts.get(item.item_id)?.feedbackBatchId === batch.batch_id);
    const triage = items.find((item) => item.pipeline === 'feedback-triage');
    if (triage?.status === 'cancelled') batch.status = 'cancelled';
    else if (items.some((item) => failures.has(item.item_id))) batch.status = 'system_blocked';
    else if (items.some((item) => waitingAnswers.has(item.item_id))) batch.status = 'waiting_for_answers';
    else if (triage && triage.status !== 'completed') batch.status = 'triaging';
    else if (items.length && items.every((item) => ['completed', 'cancelled'].includes(item.status))) batch.status = 'completed';
    else if (items.some((item) => item.pipeline === 'feedback-report' && ['ready', 'running', 'waiting'].includes(item.status))) batch.status = 'reporting';
    else if (items.some((item) => item.pipeline === 'feedback-verify' && ['ready', 'running', 'waiting'].includes(item.status))) batch.status = 'verifying';
    else batch.status = 'executing';
    batch.last_error = items.map((item) => failures.get(item.item_id)).find(Boolean) || null;
    const snapshot = triage && contexts.get(triage.item_id);
    batch.completed_at = ['completed', 'cancelled'].includes(batch.status)
      ? snapshot?.legacyTerminalStatus ? snapshot.legacyCompletedAt || null : lastDate(items, batch.status === 'cancelled' ? 'updated_at' : 'completed_at') : null;
    batch.updated_at = lastDate(items, 'updated_at') || batch.created_at;
  }
}
