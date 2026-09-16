import type Database from 'better-sqlite3';
import { finishExecutionProcessInDb, requestExecutionProcessTerminationInDb, type ExecutionProcess } from '../application/execution-processes';
import { inspectProcessIdentity, processIdentityMatches, terminateProcessGroup, terminateProcessTree } from './process-tree';

type ProcessControl = {
  inspect: typeof inspectProcessIdentity;
  terminate: typeof terminateProcessTree;
  terminateGroup?: typeof terminateProcessGroup;
};

/** Host-owned cleanup, independent of the business Runner and execution status. */
export async function stopExecutionProcessesInDb(db: Database.Database, scope: {
  runId?: string;
  supersededToken?: number;
  taskId?: string;
  executionIds?: string[];
}, control: ProcessControl = { inspect: inspectProcessIdentity, terminate: terminateProcessTree, terminateGroup: terminateProcessGroup }) {
  const conditions = ["status <> 'exited'"];
  const values: Array<string | number> = [];
  if (scope.runId) { conditions.push('run_id = ?'); values.push(scope.runId); }
  if (scope.taskId) { conditions.push('task_id = ?'); values.push(scope.taskId); }
  if (scope.executionIds) {
    if (!scope.executionIds.length) return [];
    conditions.push(`execution_id IN (${scope.executionIds.map(() => '?').join(',')})`);
    values.push(...scope.executionIds);
  }
  if (scope.supersededToken !== undefined) { conditions.push('supervision_token <> ?'); values.push(scope.supersededToken); }
  if (conditions.length === 1) throw new Error('Execution cleanup requires an explicit scope');
  const processes = db.prepare(`SELECT * FROM execution_processes WHERE ${conditions.join(' AND ')} ORDER BY created_at`)
    .all(...values) as ExecutionProcess[];
  const residual: Array<{ kind: string; pid: number }> = [];
  for (const process of processes) {
    if (process.process_group_id && process.process_start_marker && control.terminateGroup) {
      requestExecutionProcessTerminationInDb(db, process.allocation_id, '宿主终止独立执行进程组');
      const confirmed = await control.terminateGroup(process.process_group_id, 10_000, process.process_start_marker).catch(() => false);
      finishExecutionProcessInDb(db, process.allocation_id, confirmed);
      if (!confirmed) residual.push({ kind: 'agent-cli-group-unverified', pid: process.pid || process.process_group_id });
      else db.prepare(`UPDATE loop_managed_processes SET status = 'exited',exited_at = CURRENT_TIMESTAMP
        WHERE run_id = ? AND pid = ? AND process_start_marker = ? AND process_kind = 'agent-cli'`)
        .run(process.run_id, process.pid, process.process_start_marker);
      continue;
    }
    // A crash between launch reservation and identity attachment is uncertain;
    // neither timeout nor host death is proof that no child was launched.
    if (!process.pid || !process.process_start_marker || process.pid === globalThis.process.pid) {
      requestExecutionProcessTerminationInDb(db, process.allocation_id, '进程身份未确认，不能解除资源屏障');
      residual.push({ kind: 'agent-cli-unverified', pid: process.pid || 0 });
      continue;
    }
    const current = await control.inspect(process.pid).catch(() => null);
    if (!current || !processIdentityMatches(current, process.process_start_marker)) {
      // Root disappearance alone cannot prove that its old descendants exited.
      // The owning adapter's close/whole-tree confirmation may race this scan.
      const latest = db.prepare('SELECT status FROM execution_processes WHERE allocation_id = ?')
        .get(process.allocation_id) as { status: string } | undefined;
      if (latest?.status === 'exited') continue;
      requestExecutionProcessTerminationInDb(db, process.allocation_id, '根进程已退出或 PID 已复用，子进程树退出仍待确认');
      residual.push({ kind: 'agent-cli-tree-unverified', pid: process.pid });
      continue;
    }
    requestExecutionProcessTerminationInDb(db, process.allocation_id, '宿主终止受管执行');
    const confirmed = await control.terminate(process.pid, 10_000, process.process_start_marker).catch(() => false);
    finishExecutionProcessInDb(db, process.allocation_id, confirmed);
    if (!confirmed) {
      residual.push({ kind: 'agent-cli', pid: process.pid });
      continue;
    }
    db.prepare(`UPDATE loop_managed_processes SET status = 'exited',exited_at = CURRENT_TIMESTAMP
      WHERE run_id = ? AND pid = ? AND process_start_marker = ? AND process_kind = 'agent-cli'`)
      .run(process.run_id, process.pid, process.process_start_marker);
  }
  return residual;
}
