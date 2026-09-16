import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { CODE_WORKSPACE_RESOURCE } from '../domain/resource';
import { nativeCancellationInDb, nativeWorkflowEndedInDb } from './work-item-controls';
import { repairResourceOwnerInDb } from './repair-resources';
import { resourceScopeInDb } from './resource-claims';
import { transitionWorkItemInDb } from './work-item-transitions';
import { projectNativeWorkflowDisplayInDb } from './native-workflow-projection';
import type { RepairHandoffReceipt, RepairHandoffTarget } from '../domain/repair-followup';
import { RepairHandoffVersionChanged } from '../domain/repair-followup';
export type { RepairHandoffReceipt, RepairHandoffTarget } from '../domain/repair-followup';


/** Read actual ordinary result application, not a display label, changed
 * heartbeat, old completed execution, or the repairer's summary. */
export function observeRepairHandoffProgressInDb(db: Database.Database, receipt: RepairHandoffReceipt) {
  const { target } = receipt;
  if (nativeCancellationInDb(db, target.taskId)) return null;
  const placeholders = receipt.previousExecutionIds.map(() => '?').join(',');
  return db.prepare(`SELECT execution.execution_id AS executionId,result.result_id AS resultId,
    event.event_id AS completionEventId,item.item_id AS itemId,item.task_id AS taskId,item.revision AS itemRevision,
    item.dispatch_epoch AS dispatchEpoch
    FROM workflow_items item JOIN tasks task ON task.task_id = item.task_id
    JOIN execution_attempts execution ON execution.work_item_id = item.item_id AND execution.task_id = item.task_id
    JOIN agent_results result ON result.execution_id = execution.execution_id AND result.task_id = item.task_id
    JOIN workflow_item_events event ON event.item_id = item.item_id AND event.execution_id = execution.execution_id
      AND event.event_key = 'result:' || result.result_id AND event.event_type = 'complete' AND event.authority = 'agent'
    WHERE item.item_id = ? AND item.task_id = ? AND item.revision = ? AND item.dispatch_epoch = ?
      AND item.origin = 'native' AND item.status = 'completed' AND item.completion_authority = 'agent' AND task.is_paused = 0
      AND execution.status = 'applied' AND result.application_status = 'applied' AND result.effect_outcome = 'advanced'
      AND json_valid(execution.input_json) AND json_extract(execution.input_json,'$.delegation.workItemEpoch') = ?
      AND NOT EXISTS (SELECT 1 FROM execution_processes process WHERE process.execution_id = execution.execution_id AND process.status <> 'exited')
      AND NOT EXISTS (SELECT 1 FROM interventions hold WHERE hold.task_id = item.task_id AND (hold.item_id IS NULL OR hold.item_id = item.item_id)
        AND hold.status IN ('pending','running','awaiting_human'))
      ${placeholders ? `AND execution.execution_id NOT IN (${placeholders})` : ''}
    ORDER BY result.applied_at,result.result_id LIMIT 1`)
    .get(target.itemId, target.taskId, target.itemRevision, receipt.dispatchEpoch, receipt.dispatchEpoch, ...receipt.previousExecutionIds) as {
      executionId: string; resultId: string; completionEventId: string; itemId: string; taskId: string; itemRevision: number; dispatchEpoch: number;
    } | undefined || null;
}

/** Business capability called only by the independent management host. It
 * resumes ordinary work; it never completes Dev/Test or rewrites old results.
 * assertCurrent validates the durable independent verification, not an Agent
 * summary or a business-side permission flag. */
export async function handoffVerifiedRepair(ports: {
  db: Database.Database; target: RepairHandoffTarget; assertCurrent: () => void;
  readVersion: (workspaceRoot: string) => Promise<string>;
}): Promise<RepairHandoffReceipt> {
  const { db, target } = ports;
  const key = `repair:${target.caseId}:${target.verificationAttemptId}:handoff`;
  ports.assertCurrent();
  const previous = db.prepare('SELECT payload_json FROM repair_takeover_events WHERE event_key = ?').get(key) as { payload_json: string } | undefined;
  if (previous) {
    const receipt = JSON.parse(previous.payload_json) as RepairHandoffReceipt;
    if (JSON.stringify(receipt.target) !== JSON.stringify(target)) throw new Error('修复交还幂等键与来源不一致');
    return receipt; // A committed handoff may already have ordinary work advancing.
  }
  const validate = () => {
    ports.assertCurrent();
    const item = db.prepare(`SELECT item.revision,item.status,item.origin,item.dispatch_epoch,task.is_paused,
      project.workspace_root,project.deleted_at FROM workflow_items item
      JOIN tasks task ON task.task_id = item.task_id JOIN projects project ON project.project_id = task.project_id
      WHERE item.item_id = ? AND item.task_id = ?`).get(target.itemId, target.taskId) as
      { revision: number; status: string; origin: string; dispatch_epoch: number; is_paused: number; workspace_root: string; deleted_at: string | null } | undefined;
    if (!item || item.origin !== 'native' || item.status !== 'waiting' || item.revision !== target.itemRevision || item.dispatch_epoch !== target.itemEpoch
      || item.is_paused || item.deleted_at || nativeWorkflowEndedInDb(db, target.taskId)
      || !target.reason.trim() || !target.expectedVersion.trim()) throw new Error('修复交还来源已改变，或需求已暂停/结束');
    const scope = resourceScopeInDb(db, CODE_WORKSPACE_RESOURCE, target.taskId)!;
    const owner = repairResourceOwnerInDb(db, CODE_WORKSPACE_RESOURCE, scope);
    if (!owner || owner.resource_scope !== scope || owner.case_id !== target.caseId || owner.generation !== target.repairGeneration
      || owner.owner_id !== target.repairOwnerId || owner.supervision_token !== target.repairSupervisionToken
      || owner.item_id !== target.itemId || owner.item_revision !== target.itemRevision || !['owned', 'verifying'].includes(owner.phase)) {
      throw new Error('修复交还资源所有权与已验证修复来源不一致');
    }
    const faults = db.prepare(`SELECT intervention_id FROM interventions WHERE repair_case_id = ? AND task_id = ? AND item_id = ?
      AND source_kind = 'agent-fault' AND status IN ('pending','running','awaiting_human')`).all(target.caseId, target.taskId, target.itemId) as { intervention_id: string }[];
    if (!faults.length) throw new Error('修复交还缺少当前 Case 的可信业务阻塞');
    if (db.prepare(`SELECT 1 FROM interventions WHERE task_id = ? AND (item_id IS NULL OR item_id = ?)
      AND status IN ('pending','running','awaiting_human') AND NOT (COALESCE(repair_case_id,'') = ? AND COALESCE(item_id,'') = ? AND COALESCE(source_kind,'') = 'agent-fault')`)
      .get(target.taskId, target.itemId, target.caseId, target.itemId)) throw new Error('其他介入或人工输入仍未解决，不能绕过交还');
    if (db.prepare(`SELECT 1 FROM workflow_dependencies dependency JOIN workflow_items upstream ON upstream.item_id = dependency.depends_on_item_id
      WHERE dependency.item_id = ? AND upstream.status <> 'completed' LIMIT 1`).get(target.itemId)) throw new Error('修复交还不能越过未完成依赖');
    if (db.prepare(`SELECT 1 FROM execution_process_barriers barrier JOIN execution_processes process USING(allocation_id)
      WHERE barrier.resource_key = ? AND barrier.resource_scope IN (?,'global') AND process.status <> 'exited' LIMIT 1`)
      .get(CODE_WORKSPACE_RESOURCE, scope)) throw new Error('旧代码写入进程尚未确认退出，不能交还');
    if (db.prepare('SELECT 1 FROM resource_claims WHERE resource_key = ? AND resource_scope IN (?,\'global\') LIMIT 1')
      .get(CODE_WORKSPACE_RESOURCE, scope)) throw new Error('普通代码资源仍被占用，不能交还');
    const prior = db.prepare('SELECT payload_json FROM repair_takeover_events WHERE case_id = ?').all(target.caseId) as { payload_json: string }[];
    const stoppedIds = [...new Set(prior.flatMap(row => (JSON.parse(row.payload_json) as { executionIds: string[] }).executionIds))];
    if (stoppedIds.length && db.prepare(`SELECT 1 FROM execution_processes WHERE execution_id IN (${stoppedIds.map(() => '?').join(',')})
      AND status <> 'exited' LIMIT 1`).get(...stoppedIds)) throw new Error('接管清理的原进程仍未退出，不能交还');
    return { item, scope, faults };
  };
  const initial = validate();
  const version = await ports.readVersion(initial.item.workspace_root);
  ports.assertCurrent();
  if (version !== target.expectedVersion) throw new RepairHandoffVersionChanged(target.expectedVersion, version, initial.item.workspace_root);
  return db.transaction(() => {
    const replay = db.prepare('SELECT payload_json FROM repair_takeover_events WHERE event_key = ?').get(key) as { payload_json: string } | undefined;
    if (replay) {
      const receipt = JSON.parse(replay.payload_json) as RepairHandoffReceipt;
      if (JSON.stringify(receipt.target) !== JSON.stringify(target)) throw new Error('修复交还幂等键冲突');
      return receipt;
    }
    const current = validate();
    if (current.item.workspace_root !== initial.item.workspace_root) throw new Error('交还期间工作区路径已改变');
    const previousExecutionIds = (db.prepare('SELECT execution_id FROM execution_attempts WHERE work_item_id = ?').all(target.itemId) as { execution_id: string }[]).map(row => row.execution_id);
    const ids = current.faults.map(row => row.intervention_id);
    db.prepare(`UPDATE interventions SET status = 'resolved',resolution = ?,resolved_by = 'admin',resolved_at = CURRENT_TIMESTAMP,
      current_execution_id = NULL,active_session_id = NULL,command_token_hash = NULL,status_viewed_session_id = NULL,updated_at = CURRENT_TIMESTAMP
      WHERE intervention_id IN (${ids.map(() => '?').join(',')})`).run(target.reason, ...ids);
    transitionWorkItemInDb(db, { itemId: target.itemId, action: 'resume', eventKey: key, actor: 'admin', authority: 'system',
      reason: target.reason, context: { caseId: target.caseId, verificationAttemptId: target.verificationAttemptId, repairVersion: version } });
    // A verified repaired version starts a new dispatch cycle. Historical
    // execution budgets and failure facts remain untouched, not reset on restart.
    const dispatchEpoch = current.item.dispatch_epoch + 1;
    db.prepare('UPDATE workflow_items SET dispatch_epoch = ? WHERE item_id = ?').run(dispatchEpoch, target.itemId);
    const removed = db.prepare('DELETE FROM repair_resource_claims WHERE resource_key = ? AND resource_scope = ? AND case_id = ? AND generation = ?')
      .run(CODE_WORKSPACE_RESOURCE, current.scope, target.caseId, target.repairGeneration);
    if (removed.changes !== 1) throw new Error('修复资源交还失败');
    const receipt: RepairHandoffReceipt = { target, workspaceRoot: current.item.workspace_root, dispatchEpoch, previousExecutionIds,
      resolvedInterventionIds: ids, executionIds: [] };
    db.prepare('INSERT INTO repair_takeover_events(event_key,case_id,generation,payload_json) VALUES(?,?,?,?)')
      .run(key, target.caseId, target.repairGeneration, JSON.stringify(receipt));
    db.prepare("INSERT INTO task_events(event_id,task_id,actor,event_type,summary) VALUES(?,?,'admin','RepairHandedBack',?)")
      .run(randomUUID(), target.taskId, target.reason);
    projectNativeWorkflowDisplayInDb(db, target.taskId);
    ports.assertCurrent(); // Roll back the entire handoff if intent/fence changed.
    return receipt;
  }).immediate();
}
