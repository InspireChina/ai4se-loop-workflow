import type Database from 'better-sqlite3';
import type { IndependentVerificationInput } from '../domain/independent-verification-preparation';
import { nativeWorkflowEndedInDb } from './work-item-controls';
import { resourceScopeInDb } from './resource-claims';
import { repairResourceOwnerInDb } from './repair-resources';
import { CODE_WORKSPACE_RESOURCE } from '../domain/resource';
import { resolveRepairWorkItemLineageInDb } from './repair-work-item-lineage';

/** Read-only business capability. No test/repair invocation may treat a cached
 * management action as proof the workspace is still owned or unpaused. */
export function assertIndependentVerificationWorkspaceInDb(db: Database.Database, caseId: string, input: IndependentVerificationInput) {
  if (input.kind === 'runtime') throw new Error('runtime 独立验收不能借用业务工作区或数据库门禁');
  const binding = input.workspaceBinding;
  const item = db.prepare(`SELECT item.revision,item.dispatch_epoch,item.status,task.is_paused,project.workspace_root,project.deleted_at
    FROM workflow_items item JOIN tasks task ON task.task_id = item.task_id JOIN projects project ON project.project_id = task.project_id
    WHERE item.item_id = ? AND item.task_id = ?`).get(binding.itemId, binding.taskId) as
    { revision: number; dispatch_epoch: number; status: string; is_paused: number; workspace_root: string; deleted_at: string | null } | undefined;
  if (!item || item.revision !== binding.itemRevision || item.dispatch_epoch !== binding.itemEpoch || item.status !== 'waiting' || item.is_paused || item.deleted_at
    || item.workspace_root !== input.workspaceRoot || nativeWorkflowEndedInDb(db, binding.taskId)) throw new Error('独立验收工作项已暂停/结束、版本或实际路径已变化');
  for (const observation of input.originalObservations.filter(row => row.origin === 'business')) {
    const source = observation.evidence.item as { item_id?: string; revision?: number } | null;
    if (observation.evidence.taskId !== binding.taskId || !source?.item_id) throw new Error('独立验收原始业务来源缺失');
    if (source.item_id === binding.itemId) continue;
    const lineage = resolveRepairWorkItemLineageInDb(db, { taskId: binding.taskId, itemId: source.item_id, itemRevision: source.revision });
    if (lineage.current.itemId !== binding.itemId || lineage.current.revision !== binding.itemRevision) {
      throw new Error('独立验收原始工作项未经确认的替换链绑定当前版本');
    }
  }
  const scope = resourceScopeInDb(db, CODE_WORKSPACE_RESOURCE, binding.taskId)!;
  const owner = repairResourceOwnerInDb(db, CODE_WORKSPACE_RESOURCE, scope);
  if (!owner || owner.resource_scope !== scope || owner.case_id !== caseId || owner.generation !== binding.generation || owner.owner_id !== binding.ownerId
    || owner.supervision_token !== binding.supervisionToken || owner.item_id !== binding.itemId || owner.item_revision !== binding.itemRevision
    || !['owned', 'verifying'].includes(owner.phase)) throw new Error('独立验收实际工作区所有权已失效');
  if (db.prepare(`SELECT 1 FROM execution_process_barriers barrier JOIN execution_processes process USING(allocation_id)
    WHERE barrier.resource_key = ? AND barrier.resource_scope IN (?,'global') AND process.status <> 'exited' LIMIT 1`)
    .get(CODE_WORKSPACE_RESOURCE, scope)) throw new Error('独立验收存在尚未退出的冲突代码进程');
  if (db.prepare('SELECT 1 FROM resource_claims WHERE resource_key = ? AND resource_scope IN (?,\'global\') LIMIT 1')
    .get(CODE_WORKSPACE_RESOURCE, scope)) throw new Error('独立验收存在冲突的普通代码资源所有权');
  if (!db.prepare(`SELECT 1 FROM interventions WHERE repair_case_id = ? AND task_id = ? AND item_id = ? AND source_kind = 'agent-fault'
    AND status IN ('pending','running','awaiting_human') LIMIT 1`).get(caseId, binding.taskId, binding.itemId)) {
    throw new Error('独立验收原业务故障绑定已失效');
  }
  if (db.prepare(`SELECT 1 FROM interventions WHERE task_id = ? AND (item_id IS NULL OR item_id = ?)
    AND status IN ('pending','running','awaiting_human')
    AND NOT (COALESCE(repair_case_id,'') = ? AND COALESCE(item_id,'') = ? AND COALESCE(source_kind,'') = 'agent-fault') LIMIT 1`)
    .get(binding.taskId, binding.itemId, caseId, binding.itemId)) throw new Error('独立验收不能绕过其他介入或人工输入');
}
