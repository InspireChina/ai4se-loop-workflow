import type Database from 'better-sqlite3';
import type { ResourceKey } from '../domain/resource';
import type { ResourceClaim } from './resource-claims';

export type RepairResourceOwner = {
  resource_key: ResourceKey; resource_scope: string; case_id: string; generation: number;
  owner_id: string; supervision_token: number; task_id: string; item_id: string; item_revision: number;
  phase: 'draining' | 'owned' | 'verifying'; reason: string;
};

export function repairResourceOwnerInDb(db: Database.Database, resourceKey: ResourceKey, scope?: string) {
  return db.prepare(`SELECT * FROM repair_resource_claims WHERE resource_key = ?
    ${scope ? "AND resource_scope IN (?, 'global')" : ''} ORDER BY acquired_at LIMIT 1`)
    .get(resourceKey, ...(scope ? [scope] : [])) as RepairResourceOwner | undefined;
}

export function repairResourceClaimInDb(db: Database.Database, resourceKey: ResourceKey, scope?: string): ResourceClaim | undefined {
  return db.prepare(`SELECT resource_key,resource_scope,task_id AS owner_task_id,'admin' AS owner_lane,
    NULL AS owner_story_index,NULL AS owner_execution_id,acquired_at,updated_at
    FROM repair_resource_claims WHERE resource_key = ?
    ${scope ? "AND resource_scope IN (?, 'global')" : ''} ORDER BY acquired_at LIMIT 1`)
    .get(resourceKey, ...(scope ? [scope] : [])) as ResourceClaim | undefined;
}
