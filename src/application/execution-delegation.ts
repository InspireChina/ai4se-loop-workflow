import type Database from 'better-sqlite3';
import { agentCommandProfile } from '../domain/agent-command-profile-catalog';
import type { DelegationEnvelope } from './tasks';
import type { WorkflowItemRow } from './work-items';
import type { ExecutionAttempt } from './executions';
import { hash } from '../domain/content-hash';

/** Read frozen input; translate ONLY the identity explicitly adopted on the
 * source execution. Never reconstruct native work from task/lane cursors. */
export function restoreExecutionDelegationInDb(db: Database.Database, source: Pick<ExecutionAttempt,
  'execution_id' | 'task_id' | 'agent' | 'pipeline' | 'story_index' | 'input_json' | 'work_item_id' | 'dispatch_generation_key'>,
fallback?: DelegationEnvelope): DelegationEnvelope {
  const native = Boolean(db.prepare("SELECT 1 FROM tasks WHERE task_id = ? AND workflow_engine = 'native'").get(source.task_id));
  let stored: DelegationEnvelope | undefined;
  try {
    stored = (JSON.parse(source.input_json) as { delegation?: DelegationEnvelope }).delegation;
  } catch {
    throw new Error(`执行 ${source.execution_id} 的 delegation 快照无法读取`);
  }
  if (stored && (stored.taskId !== source.task_id || stored.agent !== source.agent
    || stored.pipeline !== source.pipeline || stored.storyIndex !== source.story_index)) {
    throw new Error(`执行 ${source.execution_id} 与冻结 delegation 的需求、角色、Pipeline 或单元不一致`);
  }
  if (!native) {
    if (stored) return stored;
    if (fallback) return fallback;
    throw new Error(`执行 ${source.execution_id} 缺少 delegation 快照`);
  }
  if (!stored) throw new Error(`原生执行 ${source.execution_id} 缺少冻结 delegation，不得从旧游标重建`);
  const item = db.prepare("SELECT * FROM workflow_items WHERE item_id = ? AND task_id = ? AND origin = 'native'")
    .get(source.work_item_id, source.task_id) as WorkflowItemRow | undefined;
  if (!item || item.agent !== source.agent || item.story_index !== source.story_index
    || (item.pipeline !== source.pipeline && !(source.pipeline === 'resume' && agentCommandProfile(source.agent, 'resume')))) {
    throw new Error(`原生执行 ${source.execution_id} 缺少一致的工作项来源绑定`);
  }
  if (stored.workItemId && (stored.workItemId !== item.item_id
    || stored.workItemRevision !== item.revision)) {
    throw new Error(`原生执行 ${source.execution_id} 的冻结工作项身份与来源绑定不一致`);
  }
  const current = !['cancelled', 'superseded'].includes(item.status);
  const generation = hash(JSON.stringify({ itemId: item.item_id, epoch: item.dispatch_epoch }));
  if (current && (stored.workItemEpoch !== undefined && stored.workItemEpoch !== item.dispatch_epoch
    || source.dispatch_generation_key && source.dispatch_generation_key !== generation)) {
    throw new Error(`原生执行 ${source.execution_id} 的派发代次已失效`);
  }
  if (current && source.dispatch_generation_key !== generation) {
    throw new Error(`原生执行 ${source.execution_id} 缺少可确认的派发代次`);
  }
  // A superseded/cancelled source is still restored to its ORIGINAL node so the
  // application perimeter can discard it. Never look up the newest revision.
  return { ...stored, workItemId: item.item_id, workItemRevision: item.revision,
    workItemEpoch: stored.workItemEpoch ?? (current ? item.dispatch_epoch : undefined) };
}
