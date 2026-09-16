import type Database from 'better-sqlite3';
import { inspectDispatchReadonlyInDb } from './dispatch-query-reader';
import { nativeCancellationInDb } from './work-item-controls';
import { runtimeBusinessBaselineSchema, runtimeBusinessDispatchSnapshotSchema,
  type RuntimeBusinessBaseline, type RuntimeBusinessProgressCandidate } from '../domain/runtime-business-progress';

/** Actual persisted dispatcher eligibility, not ready display or silence.
 * Caller separately proves current source/handback/CLI exits and invalidates
 * changed original revisions before sampling. Reads never bootstrap a DB. */
export function readRuntimeBusinessDispatchInDb(db: Database.Database, input: {
  baseline: RuntimeBusinessBaseline; progress: RuntimeBusinessProgressCandidate[]; assertCurrent: () => void;
}) {
  if (!db.readonly) throw new Error('运行恢复派发观察必须使用 readonly 连接');
  const baseline = runtimeBusinessBaselineSchema.parse(input.baseline);
  return db.transaction(() => {
    input.assertCurrent();
    const queue = inspectDispatchReadonlyInDb(db, input.assertCurrent);
    const taskQuery = db.prepare(`SELECT task.workflow_engine,task.is_paused,project.deleted_at
      FROM tasks task JOIN projects project ON project.project_id=task.project_id WHERE task.task_id=?`);
    const active = db.prepare(`SELECT work_item_id FROM execution_attempts WHERE task_id=?
      AND status IN ('planned','running','output_received','verifying','applying')`);
    const observations: Array<{taskId:string;readiness:'runnable'|'executing'|'waiting'|'paused'|'ended';
      runnableItems:Array<{itemId:string;revision:number;dispatchEpoch:number}>}> = [];
    for (const task of baseline.tasks) {
      if (input.progress.some(row => row.taskId === task.taskId)) continue;
      const source = taskQuery.get(task.taskId) as { workflow_engine:string;is_paused:number;deleted_at:string|null } | undefined;
      let readiness: 'runnable'|'executing'|'waiting'|'paused'|'ended' = 'waiting';
      let runnableItems: Array<{itemId:string;revision:number;dispatchEpoch:number}> = [];
      if (!source || source.deleted_at || source.workflow_engine !== 'native' || nativeCancellationInDb(db, task.taskId)) readiness = 'ended';
      else if (source.is_paused) readiness = 'paused';
      else if ((active.all(task.taskId) as {work_item_id:string|null}[]).some(row => task.items.some(item => item.itemId === row.work_item_id))) readiness = 'executing';
      else {
        runnableItems = queue.filter(line => line.taskId === task.taskId && task.items.some(item =>
          item.itemId === line.workItemId && item.revision === line.workItemRevision && item.dispatchEpoch <= line.workItemEpoch!))
          .map(line => ({itemId:line.workItemId!,revision:line.workItemRevision!,dispatchEpoch:line.workItemEpoch!}))
          .sort((a,b) => a.itemId.localeCompare(b.itemId));
        if (runnableItems.length) readiness = 'runnable';
      }
      observations.push({taskId:task.taskId,readiness,runnableItems});
    }
    input.assertCurrent();
    return runtimeBusinessDispatchSnapshotSchema.parse({progress:input.progress,observations});
  })();
}
