import type Database from 'better-sqlite3';
import type { RepairBusinessReadiness, RepairHandoffReceipt } from '../domain/repair-followup';
import { inspectPersistedDispatchInDb } from './dispatch-query-reader';
import { nativeCancellationInDb, nativeWorkflowEndedInDb } from './work-item-controls';
import { openInterventionInDb } from './interventions';
import type { RepairObservation } from '../domain/repair-case';

/** Use the actual read-only dispatcher, including dependencies, resources,
 * physical barriers, capacity and priority. A merely ready display label is
 * not proof that normal dispatch had capacity to start this item. */
export function observeRepairBusinessReadinessInDb(db: Database.Database, receipt: RepairHandoffReceipt): RepairBusinessReadiness {
  const { target } = receipt;
  const item = db.prepare(`SELECT item.revision,item.dispatch_epoch,item.status,item.origin,task.is_paused,project.workspace_root,project.deleted_at
    FROM workflow_items item JOIN tasks task ON task.task_id=item.task_id JOIN projects project ON project.project_id=task.project_id
    WHERE item.item_id=? AND item.task_id=?`).get(target.itemId, target.taskId) as {
    revision: number; dispatch_epoch: number; status: string; origin: string; is_paused: number; workspace_root: string; deleted_at: string | null;
  } | undefined;
  if (!item || item.deleted_at || nativeCancellationInDb(db, target.taskId) || nativeWorkflowEndedInDb(db, target.taskId)) return 'ended';
  if (item.is_paused) return 'paused';
  if (item.origin !== 'native' || item.revision !== target.itemRevision || item.dispatch_epoch !== receipt.dispatchEpoch
    || item.workspace_root !== receipt.workspaceRoot) return 'source-changed';
  if (db.prepare(`SELECT 1 FROM execution_attempts WHERE work_item_id=? AND task_id=?
    AND status IN ('planned','running','output_received','verifying','applying') LIMIT 1`).get(target.itemId, target.taskId)) return 'executing';
  return inspectPersistedDispatchInDb(db).some(work => work.workItemId === target.itemId
    && work.workItemRevision === target.itemRevision && work.workItemEpoch === receipt.dispatchEpoch) ? 'runnable' : 'waiting';
}

/** First hold normal dispatch and freeze a business outbox observation in one
 * transaction. Management then observes, then acknowledges. Crashing between
 * the two stores replays the same immutable outbox, not a second repair. */
export function holdStalledRepairBusinessInDb(db: Database.Database, receipt: RepairHandoffReceipt,
  fingerprint: string, assertCurrent: () => void): RepairObservation | null {
  return db.transaction(() => {
    assertCurrent();
    const key = `repair:${receipt.target.caseId}:${receipt.target.verificationAttemptId}:business-stalled`;
    const prior = db.prepare('SELECT intervention_id FROM interventions WHERE task_id=? AND dedupe_key=?')
      .get(receipt.target.taskId, key) as { intervention_id: string } | undefined;
    if (!prior && observeRepairBusinessReadinessInDb(db, receipt) !== 'runnable') return null;
    const source = prior || openInterventionInDb(db, { taskId: receipt.target.taskId, itemId: receipt.target.itemId,
      dedupeKey: key, requestedBy: 'admin-controller', sourceKind: 'agent-fault', authority: 'arbitration',
      summary: '修复交还后，正常派发持续具备条件但未启动；继续自动调查，不作为修复成功',
      context: { failureSignature: fingerprint, purpose: 'repair-business-dispatch-stalled', handoff: receipt,
        observedEligibleMs: 20 * 60 * 1000 } });
    const raw = db.prepare('SELECT observation_json FROM repair_observation_outbox WHERE intervention_id=?')
      .get(source.intervention_id) as { observation_json: string } | undefined;
    if (!raw) throw new Error('业务停滞阻塞缺少冻结修复观察');
    assertCurrent(); // Stop/fence change rolls back the entire business hold.
    return JSON.parse(raw.observation_json) as RepairObservation;
  }).immediate();
}
