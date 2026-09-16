import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { RESOURCE_DEFINITIONS, resourcesForAgent, type ResourceKey } from '../domain/resource';
import type { ResourceClaim } from './resource-claims';
import { repairResourceClaimInDb } from './repair-resources';

type Db = Database.Database;

export type ExecutionProcess = {
  allocation_id: string;
  execution_id: string;
  task_id: string;
  run_id: string;
  owner_pid: number;
  supervision_token: number;
  pid: number | null;
  process_start_marker: string | null;
  process_group_id: number | null;
  status: 'launching' | 'running' | 'terminating' | 'exited';
  last_error: string | null;
};

export class ExecutionProcessBarrierError extends Error {
  constructor(public readonly executionId: string, public readonly resourceKey?: ResourceKey) {
    super(resourceKey ? `资源 ${resourceKey} 的旧执行 ${executionId} 尚未确认进程树退出` : `执行 ${executionId} 不可启动或已有进程未退出`);
    this.name = 'ExecutionProcessBarrierError';
  }
}

/** Read-only: cancellation, pause, expiry and retry counts are NOT exit proof. */
export function executionProcessBarrierInDb(db: Db, resourceKey: ResourceKey, scope?: string): ResourceClaim | undefined {
  return db.prepare(`SELECT barrier.resource_key, barrier.resource_scope,
    barrier.owner_task_id, barrier.owner_lane, barrier.owner_story_index,
    barrier.owner_execution_id, barrier.acquired_at, barrier.updated_at
    FROM execution_process_barriers barrier JOIN execution_processes process USING(allocation_id)
    WHERE barrier.resource_key = ? AND process.status <> 'exited'
      ${scope ? "AND barrier.resource_scope IN (?, 'global')" : ''}
    ORDER BY barrier.acquired_at LIMIT 1`).get(resourceKey, ...(scope ? [scope] : [])) as ResourceClaim | undefined;
}

/** Must precede spawn. Reservation and physical barrier are atomic. */
export function prepareExecutionProcessInDb(db: Db, executionId: string, ownerPid: number, supervisionToken: number,
  expectedSource?: { runId: string; taskId: string }) {
  return db.transaction(() => {
    const source = db.prepare(`SELECT source.execution_id,source.task_id,source.run_id,source.agent,source.lane,source.story_index,
      source.status,task.is_paused FROM execution_attempts source JOIN tasks task USING(task_id)
      WHERE source.execution_id = ?`).get(executionId) as {
      execution_id: string; task_id: string; run_id: string; agent: string; lane: string | null;
      story_index: number | null; status: string; is_paused: number;
    } | undefined;
    if (!source || source.status !== 'running' || source.is_paused
      || (expectedSource && (source.run_id !== expectedSource.runId || source.task_id !== expectedSource.taskId))
      || db.prepare("SELECT 1 FROM execution_processes WHERE execution_id = ? AND status <> 'exited'").get(executionId)) {
      throw new ExecutionProcessBarrierError(executionId);
    }
    const claims: ResourceClaim[] = [];
    for (const resourceKey of resourcesForAgent(source.agent)) {
      if (!RESOURCE_DEFINITIONS[resourceKey].requiresClaim) continue;
      const claim = db.prepare(`SELECT * FROM resource_claims WHERE resource_key = ? AND owner_task_id = ?
        AND (owner_execution_id = ? OR ? = 'task') LIMIT 1`)
        .get(resourceKey, source.task_id, executionId, RESOURCE_DEFINITIONS[resourceKey].ownerScope) as ResourceClaim | undefined;
      if (!claim) throw new ExecutionProcessBarrierError(executionId, resourceKey);
      if (repairResourceClaimInDb(db, resourceKey, claim.resource_scope)) throw new ExecutionProcessBarrierError(executionId, resourceKey);
      const previous = executionProcessBarrierInDb(db, resourceKey, claim.resource_scope);
      if (previous) throw new ExecutionProcessBarrierError(previous.owner_execution_id!, resourceKey);
      claims.push(claim);
    }
    const allocationId = randomUUID();
    db.prepare(`INSERT INTO execution_processes(allocation_id,execution_id,run_id,task_id,owner_pid,supervision_token)
      VALUES(?,?,?,?,?,?)`).run(allocationId, executionId, source.run_id, source.task_id, ownerPid, supervisionToken);
    for (const claim of claims) db.prepare(`INSERT INTO execution_process_barriers(allocation_id,resource_key,resource_scope,
      owner_task_id,owner_lane,owner_story_index,owner_execution_id) VALUES(?,?,?,?,?,?,?)`)
      .run(allocationId, claim.resource_key, claim.resource_scope, source.task_id, source.lane || 'control', source.story_index, executionId);
    return allocationId;
  }).immediate();
}

/** Called synchronously after spawn, before awaiting its asynchronous events. */
export function attachExecutionProcessInDb(db: Db, allocationId: string, pid: number, marker?: string, groupId?: number) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('invalid Agent process pid');
  if (groupId !== undefined && groupId !== pid) throw new Error('isolated execution group must match its root pid');
  const row = db.prepare(`UPDATE execution_processes SET pid = ?,
    process_start_marker = COALESCE(?,process_start_marker),process_group_id = COALESCE(?,process_group_id),
    status = 'running',updated_at = CURRENT_TIMESTAMP
    WHERE allocation_id = ? AND status IN ('launching','running') AND (pid IS NULL OR pid = ?)`)
    .run(pid, marker || null, groupId || null, allocationId, pid);
  if (!row.changes) throw new Error(`Execution process allocation no longer owns pid=${pid}`);
}

export function requestExecutionProcessTerminationInDb(db: Db, allocationId: string, reason: string) {
  return db.prepare(`UPDATE execution_processes SET status = 'terminating',last_error = ?,updated_at = CURRENT_TIMESTAMP
    WHERE allocation_id = ? AND status <> 'exited'`).run(reason, allocationId).changes;
}

/** Only the process adapter may supply confirmation; idempotent and source-bound. */
export function finishExecutionProcessInDb(db: Db, allocationId: string, confirmed: boolean, reason?: string) {
  return db.transaction(() => {
    if (!confirmed) {
      requestExecutionProcessTerminationInDb(db, allocationId, reason || '无法确认整个进程树退出');
      return false;
    }
    const changed = db.prepare(`UPDATE execution_processes SET status = 'exited',exited_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP WHERE allocation_id = ? AND status <> 'exited'`).run(allocationId).changes;
    if (!changed) return false;
    db.prepare('DELETE FROM execution_process_barriers WHERE allocation_id = ?').run(allocationId);
    return true;
  }).immediate();
}

export function activeExecutionProcessesInDb(db: Db, runId: string) {
  return db.prepare("SELECT * FROM execution_processes WHERE run_id = ? AND status <> 'exited' ORDER BY created_at")
    .all(runId) as ExecutionProcess[];
}
