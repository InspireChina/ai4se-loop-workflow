import type Database from 'better-sqlite3';
import {
  RESOURCE_DEFINITIONS,
  resourcesRequiringClaims,
  type ResourceKey,
} from '../domain/resource';

export { BROWSER_EXCLUSIVE_RESOURCE, CODE_WORKSPACE_RESOURCE } from '../domain/resource';

export type ResourceClaim = {
  resource_key: ResourceKey;
  resource_scope: string;
  owner_task_id: string;
  owner_lane: string;
  owner_story_index: number | null;
  owner_execution_id: string | null;
  acquired_at: string;
  updated_at: string;
};

type Db = Database.Database;

export class ResourceBusyError extends Error {
  constructor(
    public readonly resourceKey: ResourceKey,
    public readonly ownerTaskId: string,
    public readonly ownerExecutionId: string | null = null,
  ) {
    super(`资源 ${resourceKey} 已被 ${ownerTaskId} 占用`);
    this.name = 'ResourceBusyError';
  }
}

export function resourceScopeInDb(db: Db, resourceKey: ResourceKey, taskId?: string) {
  if (resourceKey !== 'code:workspace') return 'global';
  if (!taskId) return undefined;
  const task = db.prepare('SELECT project_id FROM tasks WHERE task_id = ?').get(taskId) as { project_id: string | null } | undefined;
  return `project:${task?.project_id || 'legacy'}`;
}

export function resourceIdentityInDb(db: Db, resourceKey: ResourceKey, taskId: string) {
  return `${resourceKey}@${resourceScopeInDb(db, resourceKey, taskId)}`;
}

export function resourceClaimInDb(db: Db, resourceKey: ResourceKey, taskId?: string) {
  const scope = resourceScopeInDb(db, resourceKey, taskId);
  return (scope
    ? db.prepare(`
        SELECT * FROM resource_claims
        WHERE resource_key = ? AND resource_scope IN (?, 'global')
        ORDER BY resource_scope = ? DESC LIMIT 1
      `).get(resourceKey, scope, scope)
    : db.prepare('SELECT * FROM resource_claims WHERE resource_key = ? ORDER BY acquired_at, resource_scope LIMIT 1').get(resourceKey)) as ResourceClaim | undefined;
}

export function activeResourceClaimInDb(db: Db, resourceKey: ResourceKey, taskId?: string) {
  const claim = resourceClaimInDb(db, resourceKey, taskId);
  if (!claim) return undefined;
  const owner = db.prepare('SELECT agile_status, is_paused FROM tasks WHERE task_id = ?')
    .get(claim.owner_task_id) as { agile_status: string; is_paused: number } | undefined;
  if (!owner || owner.is_paused || ['done', 'cancelled'].includes(owner.agile_status)) {
    releaseResourceClaimInDb(db, resourceKey, claim.owner_task_id);
    return undefined;
  }
  if (RESOURCE_DEFINITIONS[resourceKey].ownerScope === 'execution') {
    const execution = claim.owner_execution_id
      ? db.prepare('SELECT status FROM execution_attempts WHERE execution_id = ?').get(claim.owner_execution_id) as { status: string } | undefined
      : undefined;
    if (!execution || !['planned', 'running', 'output_received', 'verifying', 'applying'].includes(execution.status)) {
      releaseResourceClaimInDb(db, resourceKey, claim.owner_task_id);
      return undefined;
    }
  }
  return claim;
}

export function tryAcquireResourceClaimInDb(db: Db, input: {
  resourceKey: ResourceKey;
  taskId: string;
  lane: string;
  storyIndex?: number | null;
  executionId?: string | null;
}) {
  const definition: { ownerScope: 'task' | 'execution'; requiresClaim: boolean } = RESOURCE_DEFINITIONS[input.resourceKey];
  if (!definition.requiresClaim) return true;
  if (definition.ownerScope === 'execution' && !input.executionId) {
    throw new Error(`资源 ${input.resourceKey} 必须绑定 execution`);
  }
  const resourceScope = resourceScopeInDb(db, input.resourceKey, input.taskId)!;
  activeResourceClaimInDb(db, input.resourceKey, input.taskId);
  const sameOwner = definition.ownerScope === 'task'
    ? 'resource_claims.owner_task_id = excluded.owner_task_id'
    : 'resource_claims.owner_execution_id = excluded.owner_execution_id AND excluded.owner_execution_id IS NOT NULL';
  const result = db.prepare(`
    INSERT INTO resource_claims(
      resource_key, resource_scope, owner_task_id, owner_lane, owner_story_index, owner_execution_id
    ) VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(resource_key, resource_scope) DO UPDATE SET
      owner_lane = excluded.owner_lane,
      owner_story_index = excluded.owner_story_index,
      owner_execution_id = excluded.owner_execution_id,
      updated_at = CURRENT_TIMESTAMP
    WHERE ${sameOwner}
  `).run(
    input.resourceKey,
    resourceScope,
    input.taskId,
    input.lane,
    input.storyIndex ?? null,
    input.executionId ?? null,
  );
  return result.changes > 0;
}

export function acquireResourceClaimInDb(db: Db, input: {
  resourceKey: ResourceKey;
  taskId: string;
  lane: string;
  storyIndex?: number | null;
  executionId?: string | null;
}) {
  if (!RESOURCE_DEFINITIONS[input.resourceKey].requiresClaim) return undefined;
  if (tryAcquireResourceClaimInDb(db, input)) return resourceClaimInDb(db, input.resourceKey, input.taskId)!;
  const owner = resourceClaimInDb(db, input.resourceKey, input.taskId);
  throw new ResourceBusyError(input.resourceKey, owner?.owner_task_id || 'unknown', owner?.owner_execution_id || null);
}

export function acquireResourceClaimsInDb(db: Db, input: {
  resourceKeys: ResourceKey[];
  taskId: string;
  lane: string;
  storyIndex?: number | null;
  executionId?: string | null;
}) {
  const resourceKeys = [...new Set(resourcesRequiringClaims(input.resourceKeys))].sort();
  return db.transaction(() => resourceKeys.map((resourceKey) => {
    const claim = acquireResourceClaimInDb(db, {
      resourceKey,
      taskId: input.taskId,
      lane: input.lane,
      storyIndex: input.storyIndex,
      executionId: input.executionId,
    });
    if (!claim) throw new Error(`资源 ${resourceKey} 未建立 Claim`);
    return claim;
  }))();
}

export function releaseResourceClaimInDb(db: Db, resourceKey: ResourceKey, ownerTaskId?: string) {
  const result = ownerTaskId
    ? db.prepare('DELETE FROM resource_claims WHERE resource_key = ? AND owner_task_id = ?').run(resourceKey, ownerTaskId)
    : db.prepare('DELETE FROM resource_claims WHERE resource_key = ?').run(resourceKey);
  return result.changes > 0;
}

export function releaseTaskResourceClaimsInDb(db: Db, taskId: string) {
  return db.prepare('DELETE FROM resource_claims WHERE owner_task_id = ?').run(taskId).changes;
}

const executionResourceKeys = Object.entries(RESOURCE_DEFINITIONS)
  .filter(([, definition]) => definition.ownerScope === 'execution')
  .map(([resourceKey]) => resourceKey as ResourceKey);

export function releaseExecutionResourceClaimsInDb(db: Db, executionId: string) {
  let released = 0;
  for (const resourceKey of executionResourceKeys) {
    released += db.prepare(`
      DELETE FROM resource_claims
      WHERE resource_key = ? AND owner_execution_id = ?
    `).run(resourceKey, executionId).changes;
  }
  return released;
}

export function releaseLaneExecutionResourceClaimsInDb(db: Db, taskId: string, lane: string) {
  let released = 0;
  for (const resourceKey of executionResourceKeys) {
    released += db.prepare(`
      DELETE FROM resource_claims
      WHERE resource_key = ? AND owner_task_id = ? AND owner_lane = ?
    `).run(resourceKey, taskId, lane).changes;
  }
  return released;
}

export function releaseRunExecutionResourceClaimsInDb(db: Db, runId: string | null) {
  let released = 0;
  for (const resourceKey of executionResourceKeys) {
    const result = runId
      ? db.prepare(`
          DELETE FROM resource_claims
          WHERE resource_key = ? AND owner_execution_id IN (
            SELECT execution_id FROM execution_attempts WHERE run_id = ?
          )
        `).run(resourceKey, runId)
      : db.prepare('DELETE FROM resource_claims WHERE resource_key = ?').run(resourceKey);
    released += result.changes;
  }
  return released;
}
