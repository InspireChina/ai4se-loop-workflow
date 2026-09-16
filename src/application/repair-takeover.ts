import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { CODE_WORKSPACE_RESOURCE } from '../domain/resource';
import { stopExecutionProcessesInDb } from '../infrastructure/execution-process-control';
import { nativeWorkflowEndedInDb } from './work-item-controls';
import { resourceScopeInDb } from './resource-claims';
import { repairResourceOwnerInDb, type RepairResourceOwner } from './repair-resources';
import type { RepairClaim } from '../domain/repair-case';
import { resolveRepairWorkItemLineageInDb } from './repair-work-item-lineage';

type Db = Database.Database;
export type RepairTakeoverTarget = {
  caseId: string; generation: number; ownerId: string; supervisionToken: number;
  taskId: string; itemId: string; itemRevision: number; reason: string;
};

export function repairTakeoverAuthorization(claim: RepairClaim, assertClaim: (claim: RepairClaim) => unknown) {
  return (target: RepairTakeoverTarget) => {
    assertClaim(claim);
    if (target.caseId !== claim.repairCase.caseId || target.generation !== claim.attempt.generation
      || target.ownerId !== claim.authority.ownerId || target.supervisionToken !== claim.authority.token) {
      throw new Error('修复接管凭证与目标所有权不一致');
    }
  };
}

function validateTarget(db: Db, target: RepairTakeoverTarget) {
  if (!target.reason.trim() || !Number.isInteger(target.generation) || target.generation < 1
    || !target.ownerId.trim() || !Number.isInteger(target.supervisionToken)) throw new Error('修复接管必须绑定有效所有者、代次与原因');
  const resolved = resolveRepairWorkItemLineageInDb(db, { taskId: target.taskId, itemId: target.itemId, itemRevision: target.itemRevision });
  const item = db.prepare(`SELECT item.item_id,item.revision,item.dispatch_epoch,item.status,task.is_paused,project.workspace_root,project.deleted_at
    FROM workflow_items item JOIN tasks task ON task.task_id = item.task_id JOIN projects project ON project.project_id = task.project_id
    WHERE item.item_id = ? AND item.task_id = ?`).get(resolved.current.itemId, target.taskId) as {
    item_id: string; revision: number; dispatch_epoch: number; status: string; is_paused: number; workspace_root: string; deleted_at: string | null;
  } | undefined;
  if (!item || item.status !== 'waiting' || item.is_paused || item.deleted_at || nativeWorkflowEndedInDb(db, target.taskId)) {
    throw new Error('修复接管来源版本已改变，或需求已暂停/结束');
  }
  const source = db.prepare(`SELECT intervention_id,current_execution_id FROM interventions WHERE repair_case_id = ?
    AND task_id = ? AND item_id = ? AND source_kind = 'agent-fault'
    AND status IN ('pending','running','awaiting_human') LIMIT 1`).get(target.caseId, target.taskId, item.item_id) as {
    intervention_id: string; current_execution_id: string | null;
  } | undefined;
  if (!source) throw new Error('修复接管缺少当前 Case 的可信业务阻塞绑定');
  if (db.prepare(`SELECT 1 FROM interventions WHERE task_id = ? AND (item_id IS NULL OR item_id = ?)
    AND (source_kind = 'human-input' OR resolver_strategy = 'human_only')
    AND status IN ('pending','running','awaiting_human')`).get(target.taskId, item.item_id)) throw new Error('人工输入仍未解决，不能由修复接管绕过');
  return { ...item, ...source, scope: resourceScopeInDb(db, CODE_WORKSPACE_RESOURCE, target.taskId)!,
    lineage: resolved.lineage.map(node => ({ itemId: node.itemId, revision: node.revision })) };
}

function assertOwner(owner: RepairResourceOwner | undefined, target: RepairTakeoverTarget) {
  if (!owner || owner.case_id !== target.caseId || owner.generation !== target.generation
    || owner.owner_id !== target.ownerId || owner.supervision_token !== target.supervisionToken
    || owner.item_id !== target.itemId || owner.item_revision !== target.itemRevision) throw new Error('修复资源所有权已改变；旧代次不能继续写入');
}

/** Trusted management operation: the Agent never writes business state itself.
 * assertCurrent must validate the independent management claim before AND after
 * every asynchronous physical cleanup. */
export async function acquireRepairTakeover(ports: {
  db: Db; target: RepairTakeoverTarget; assertCurrent: (target: RepairTakeoverTarget) => void;
  previousOwnerStopped?: (owner: RepairResourceOwner) => boolean;
  stopExecutions?: (executionIds: string[]) => Promise<Array<{ kind: string; pid: number }>>;
}) {
  const { db, target } = ports;
  ports.assertCurrent(target);
  const pending = db.transaction(() => {
    ports.assertCurrent(target);
    const source = validateTarget(db, target);
    const effectiveTarget = { ...target, itemId: source.item_id, itemRevision: source.revision };
    const existing = repairResourceOwnerInDb(db, CODE_WORKSPACE_RESOURCE, source.scope);
    if (existing) {
      if (existing.case_id === target.caseId && existing.generation < target.generation
        && ports.previousOwnerStopped?.(existing)) {
        db.prepare(`UPDATE repair_resource_claims SET generation = ?,owner_id = ?,supervision_token = ?,task_id = ?,
          item_id = ?,item_revision = ?,phase = 'draining',reason = ?,updated_at = CURRENT_TIMESTAMP
          WHERE resource_key = ? AND resource_scope = ?`)
          .run(target.generation, target.ownerId, target.supervisionToken, target.taskId, effectiveTarget.itemId,
            effectiveTarget.itemRevision, target.reason, CODE_WORKSPACE_RESOURCE, source.scope);
      } else assertOwner(existing, effectiveTarget);
    }
    else db.prepare(`INSERT INTO repair_resource_claims(resource_key,resource_scope,case_id,generation,owner_id,supervision_token,
      task_id,item_id,item_revision,phase,reason) VALUES(?,?,?,?,?,?,?,?,?,'draining',?)`)
      .run(CODE_WORKSPACE_RESOURCE, source.scope, target.caseId, target.generation, target.ownerId,
        target.supervisionToken, target.taskId, effectiveTarget.itemId, effectiveTarget.itemRevision, target.reason);
    const executions = db.prepare(`SELECT DISTINCT execution.execution_id FROM execution_attempts execution
      JOIN tasks task ON task.task_id = execution.task_id
      WHERE execution.status IN ('planned','running','output_received','verifying','applying')
        AND (execution.execution_id = ? OR (? = 'project:' || COALESCE(task.project_id,'legacy') AND (
          execution.agent IN ('dev-agent','test-agent','direct-agent')
          OR EXISTS (SELECT 1 FROM execution_process_barriers barrier WHERE barrier.owner_execution_id = execution.execution_id
            AND barrier.resource_key = ? AND barrier.resource_scope IN (?,'global'))
          OR EXISTS (SELECT 1 FROM resource_claims claim WHERE claim.owner_execution_id = execution.execution_id
            AND claim.resource_key = ? AND claim.resource_scope IN (?,'global')))))`)
      .all(source.current_execution_id, source.scope, CODE_WORKSPACE_RESOURCE, source.scope, CODE_WORKSPACE_RESOURCE, source.scope) as { execution_id: string }[];
    const ids = executions.map(row => row.execution_id);
    for (const executionId of ids) db.prepare(`UPDATE execution_attempts SET status = 'cancelled',last_error = ?,
      failure_kind = NULL,dispatch_retry_consumed = 0,retry_not_before = NULL,finished_at = CURRENT_TIMESTAMP,
      heartbeat_at = CURRENT_TIMESTAMP WHERE execution_id = ?`)
      .run(`Admin 接管资源：${target.reason}`, executionId);
    const eventKey = `repair:${target.caseId}:${target.generation}:takeover`;
    const previous = db.prepare('SELECT payload_json FROM repair_takeover_events WHERE case_id = ?').all(target.caseId) as { payload_json: string }[];
    const previousIds = previous.flatMap(row => (JSON.parse(row.payload_json) as { executionIds: string[] }).executionIds);
    const inserted = db.prepare('INSERT OR IGNORE INTO repair_takeover_events(event_key,case_id,generation,payload_json) VALUES(?,?,?,?)')
      .run(eventKey, target.caseId, target.generation, JSON.stringify({ target: effectiveTarget, requestedTarget: target,
        executionIds: ids, workspaceRoot: source.workspace_root, lineage: source.lineage }));
    if (inserted.changes) db.prepare("INSERT INTO task_events(event_id,task_id,actor,event_type,summary) VALUES(?,?,'admin','RepairTakeoverRequested',?)")
      .run(randomUUID(), target.taskId, target.reason);
    return { scope: source.scope, workspaceRoot: source.workspace_root, itemEpoch: source.dispatch_epoch,
      effectiveTarget, lineage: source.lineage, executionIds: [...new Set([...ids, ...previousIds])] };
  }).immediate();
  // Include processes whose execution was already logically cancelled by a
  // prior takeover attempt; failed cleanup must be retried, not forgotten.
  const physical = db.prepare(`SELECT DISTINCT process.execution_id FROM execution_processes process
    JOIN execution_process_barriers barrier USING(allocation_id)
    JOIN tasks task ON task.task_id = process.task_id
    WHERE process.status <> 'exited' AND barrier.resource_key = ? AND barrier.resource_scope IN (?,'global')
      AND ? = 'project:' || COALESCE(task.project_id,'legacy')`)
    .all(CODE_WORKSPACE_RESOURCE, pending.scope, pending.scope) as { execution_id: string }[];
  const ids = [...new Set([...pending.executionIds, ...physical.map(row => row.execution_id)])];
  // Persist targets discovered through physical barriers before termination.
  // Logical cancellation/claim cleanup must not make these processes vanish
  // from a later generation's cleanup or from verified resource handback.
  db.transaction(() => {
    ports.assertCurrent(target);
    assertOwner(repairResourceOwnerInDb(db, CODE_WORKSPACE_RESOURCE, pending.scope), pending.effectiveTarget);
    const fingerprint = createHash('sha256').update(JSON.stringify([...ids].sort())).digest('hex');
    db.prepare('INSERT OR IGNORE INTO repair_takeover_events(event_key,case_id,generation,payload_json) VALUES(?,?,?,?)')
      .run(`repair:${target.caseId}:${target.generation}:physical:${fingerprint}`, target.caseId, target.generation,
        JSON.stringify({ target, executionIds: ids, workspaceRoot: pending.workspaceRoot, purpose: 'physical-cleanup' }));
  }).immediate();
  const residual = await (ports.stopExecutions || (executionIds => stopExecutionProcessesInDb(db, { executionIds })))(ids);
  ports.assertCurrent(target);
  return db.transaction(() => {
    ports.assertCurrent(target);
    const current = validateTarget(db, target);
    if (current.dispatch_epoch !== pending.itemEpoch) throw new Error('修复接管清理期间派发代次已改变，不能授权旧代次');
    if (current.workspace_root !== pending.workspaceRoot) throw new Error('修复接管期间工作区路径已改变，不能授权旧路径写入');
    assertOwner(repairResourceOwnerInDb(db, CODE_WORKSPACE_RESOURCE, pending.scope), pending.effectiveTarget);
    const unconfirmed = db.prepare(`SELECT 1 FROM execution_process_barriers barrier JOIN execution_processes process USING(allocation_id)
      WHERE barrier.resource_key = ? AND barrier.resource_scope IN (?,'global') AND process.status <> 'exited' LIMIT 1`)
      .get(CODE_WORKSPACE_RESOURCE, pending.scope);
    const unconfirmedSource = ids.length ? db.prepare(`SELECT 1 FROM execution_processes WHERE execution_id IN (${ids.map(() => '?').join(',')}) AND status <> 'exited' LIMIT 1`).get(...ids) : undefined;
    if (residual.length || unconfirmed || unconfirmedSource) return { phase: 'draining' as const, residual, workspaceRoot: null };
    db.prepare('DELETE FROM resource_claims WHERE resource_key = ? AND resource_scope = ?').run(CODE_WORKSPACE_RESOURCE, pending.scope);
    db.prepare("UPDATE repair_resource_claims SET phase = 'owned',updated_at = CURRENT_TIMESTAMP WHERE resource_key = ? AND resource_scope = ?")
      .run(CODE_WORKSPACE_RESOURCE, pending.scope);
    return { phase: 'owned' as const, residual: [], workspaceRoot: pending.workspaceRoot,
      anchor: { taskId: target.taskId, itemId: current.item_id, itemRevision: current.revision,
        itemEpoch: current.dispatch_epoch, workspaceRoot: current.workspace_root,
        ...(current.lineage.length > 1 ? { predecessors: current.lineage.slice(0, -1) } : {}) } };
  }).immediate();
}

export type InvalidRepairTakeover = {
  owner: RepairResourceOwner;
  kind: 'superseded' | 'cancelled' | 'ended' | 'deleted' | 'source-invalidated';
  terminal: boolean;
  reason: string;
};

export type RepairTakeoverRevocationReceipt = {
  eventKey: string;
  caseId: string;
  generation: number;
  kind: InvalidRepairTakeover['kind'];
  terminal: boolean;
  reason: string;
  coveredObservationIds: string[];
};

/** Read the current business authority behind every durable repair fence. A
 * pause is intentionally not invalidation; explicit cancellation, completion,
 * deletion, replacement, or loss of the held Agent fault is. */
export function invalidRepairTakeoversInDb(db: Db): InvalidRepairTakeover[] {
  const owners = db.prepare('SELECT * FROM repair_resource_claims ORDER BY acquired_at,resource_key,resource_scope').all() as RepairResourceOwner[];
  const invalid: InvalidRepairTakeover[] = [];
  for (const owner of owners) {
    const row = db.prepare(`SELECT item.status,item.superseded_by_item_id AS successorId,task.is_paused,project.deleted_at
      FROM workflow_items item JOIN tasks task ON task.task_id=item.task_id
      JOIN projects project ON project.project_id=task.project_id
      WHERE item.task_id=? AND item.item_id=?`).get(owner.task_id, owner.item_id) as
      { status: string; successorId: string | null; is_paused: number; deleted_at: string | null } | undefined;
    if (!row) { invalid.push({ owner, kind: 'source-invalidated', terminal: true, reason: '接管工作项已不存在' }); continue; }
    if (row.deleted_at) { invalid.push({ owner, kind: 'deleted', terminal: true, reason: '接管项目已删除' }); continue; }
    if (nativeWorkflowEndedInDb(db, owner.task_id)) { invalid.push({ owner, kind: 'ended', terminal: true, reason: '接管需求已取消或结束' }); continue; }
    if (row.status === 'superseded') {
      try {
        const lineage = resolveRepairWorkItemLineageInDb(db, { taskId: owner.task_id,
          itemId: owner.item_id, itemRevision: owner.item_revision });
        const successorSource = db.prepare(`SELECT 1 FROM interventions WHERE repair_case_id=? AND task_id=? AND item_id=?
          AND source_kind='agent-fault' AND status IN ('pending','running','awaiting_human') LIMIT 1`)
          .get(owner.case_id, owner.task_id, lineage.current.itemId);
        invalid.push({ owner, kind: 'superseded', terminal: !successorSource,
          reason: successorSource ? '接管工作项已回退，当前后继版本仍保留有效故障绑定'
            : '接管工作项已回退，真实后继版本没有待修复故障' });
      } catch (error) {
        invalid.push({ owner, kind: 'source-invalidated', terminal: true,
          reason: error instanceof Error ? error.message : '接管工作项替换链无效' });
      }
      continue;
    }
    if (row.status === 'cancelled' || row.status === 'completed') { invalid.push({ owner,
      kind: row.status === 'cancelled' ? 'cancelled' : 'ended', terminal: true,
      reason: `接管工作项已${row.status === 'cancelled' ? '取消' : '完成'}` }); continue; }
    const source = db.prepare(`SELECT 1 FROM interventions WHERE repair_case_id=? AND task_id=? AND item_id=?
      AND source_kind='agent-fault' AND status IN ('pending','running','awaiting_human') LIMIT 1`)
      .get(owner.case_id, owner.task_id, owner.item_id);
    if (!source && !row.is_paused) invalid.push({ owner, kind: 'source-invalidated', terminal: true, reason: '接管的 Agent 故障来源已失效' });
  }
  return invalid;
}

/** Unified abnormal handback. Management must first revoke the owning Admin
 * execution and prove its physical exit. This capability then drains business
 * writers, rechecks the invalid source, releases the fence, and persists an
 * immutable outcome. It never marks work complete or fabricates verification. */
export async function revokeInvalidRepairTakeoversInDb(ports: {
  db: Db;
  ownerStopped: (owner: RepairResourceOwner) => boolean;
  stopExecutions?: (executionIds: string[]) => Promise<Array<{ kind: string; pid: number }>>;
}) {
  const results: Array<InvalidRepairTakeover & { status: 'owner-running' | 'draining' | 'revoked'; eventKey?: string }> = [];
  for (const invalid of invalidRepairTakeoversInDb(ports.db)) {
    const { owner } = invalid;
    if (!ports.ownerStopped(owner)) { results.push({ ...invalid, status: 'owner-running' }); continue; }
    const pending = ports.db.transaction(() => {
      const current = repairResourceOwnerInDb(ports.db, owner.resource_key, owner.resource_scope);
      if (!current || JSON.stringify(current) !== JSON.stringify(owner)) return null;
      const stillInvalid = invalidRepairTakeoversInDb(ports.db).find(row => row.owner.resource_key === owner.resource_key
        && row.owner.resource_scope === owner.resource_scope && row.owner.case_id === owner.case_id && row.owner.generation === owner.generation);
      if (!stillInvalid) return null;
      ports.db.prepare("UPDATE repair_resource_claims SET phase='draining',reason=?,updated_at=CURRENT_TIMESTAMP WHERE resource_key=? AND resource_scope=?")
        .run(stillInvalid.reason, owner.resource_key, owner.resource_scope);
      const physical = ports.db.prepare(`SELECT DISTINCT process.execution_id FROM execution_processes process
        JOIN execution_process_barriers barrier USING(allocation_id)
        WHERE process.status<>'exited' AND barrier.resource_key=? AND barrier.resource_scope IN (?,'global')`)
        .all(owner.resource_key, owner.resource_scope) as { execution_id: string }[];
      const history = ports.db.prepare('SELECT payload_json FROM repair_takeover_events WHERE case_id=?').all(owner.case_id) as { payload_json: string }[];
      const historical = history.flatMap(row => {
        const payload = JSON.parse(row.payload_json) as { executionIds?: unknown };
        return Array.isArray(payload.executionIds) ? payload.executionIds.filter((id): id is string => typeof id === 'string') : [];
      });
      const executionIds = [...new Set([...physical.map(row => row.execution_id), ...historical])];
      for (const executionId of executionIds) ports.db.prepare(`UPDATE execution_attempts SET status='cancelled',last_error=?,
        failure_kind=NULL,dispatch_retry_consumed=0,retry_not_before=NULL,finished_at=CURRENT_TIMESTAMP,heartbeat_at=CURRENT_TIMESTAMP
        WHERE execution_id=? AND status IN ('planned','running','output_received','verifying','applying')`).run(stillInvalid.reason, executionId);
      return { invalid: stillInvalid, executionIds };
    }).immediate();
    if (!pending) continue;
    const residual = await (ports.stopExecutions || (executionIds => stopExecutionProcessesInDb(ports.db, { executionIds })))(pending.executionIds);
    const outcome = ports.db.transaction(() => {
      const current = repairResourceOwnerInDb(ports.db, owner.resource_key, owner.resource_scope);
      const stillInvalid = invalidRepairTakeoversInDb(ports.db).find(row => row.owner.resource_key === owner.resource_key
        && row.owner.resource_scope === owner.resource_scope && row.owner.case_id === owner.case_id && row.owner.generation === owner.generation);
      if (!current || !stillInvalid) return null;
      const unconfirmed = ports.db.prepare(`SELECT 1 FROM execution_process_barriers barrier JOIN execution_processes process USING(allocation_id)
        WHERE barrier.resource_key=? AND barrier.resource_scope IN (?,'global') AND process.status<>'exited' LIMIT 1`)
        .get(owner.resource_key, owner.resource_scope);
      if (residual.length || unconfirmed) return { ...stillInvalid, status: 'draining' as const };
      const eventKey = `repair:${owner.case_id}:${owner.generation}:revoked`;
      const coveredObservationIds = (ports.db.prepare(`SELECT outbox.observation_id AS observationId
        FROM repair_observation_outbox outbox JOIN interventions intervention USING(intervention_id)
        WHERE intervention.repair_case_id=? AND intervention.source_kind='agent-fault'
        ORDER BY outbox.observation_id`).all(owner.case_id) as Array<{ observationId: string }>).map(row => row.observationId);
      const removed = ports.db.prepare(`DELETE FROM repair_resource_claims WHERE resource_key=? AND resource_scope=? AND case_id=?
        AND generation=? AND owner_id=? AND supervision_token=?`).run(owner.resource_key, owner.resource_scope, owner.case_id,
        owner.generation, owner.owner_id, owner.supervision_token);
      if (removed.changes !== 1) throw new Error('修复接管撤销时所有权已改变');
      ports.db.prepare('INSERT OR IGNORE INTO repair_takeover_events(event_key,case_id,generation,payload_json) VALUES(?,?,?,?)')
        .run(eventKey, owner.case_id, owner.generation, JSON.stringify({ purpose: 'source-invalidated-revocation',
          owner, kind: stillInvalid.kind, terminal: stillInvalid.terminal, reason: stillInvalid.reason,
          coveredObservationIds, executionIds: pending.executionIds, residual: [] }));
      ports.db.prepare("INSERT INTO task_events(event_id,task_id,actor,event_type,summary) VALUES(?,?,'admin','RepairTakeoverRevoked',?)")
        .run(randomUUID(), owner.task_id, stillInvalid.reason);
      return { ...stillInvalid, status: 'revoked' as const, eventKey };
    }).immediate();
    if (outcome) results.push(outcome);
  }
  return results;
}

/** Business-side revocation outbox. Deleting the resource fence and writing
 * this receipt are one transaction; management acknowledgment is replayed
 * until a separate durable delivery row exists. */
export function pendingRepairTakeoverRevocationsInDb(db: Db): RepairTakeoverRevocationReceipt[] {
  const rows = db.prepare(`SELECT event.event_key AS eventKey,event.case_id AS caseId,event.generation,event.payload_json AS payloadJson
    FROM repair_takeover_events event
    LEFT JOIN repair_takeover_event_deliveries delivery ON delivery.event_key=event.event_key
    WHERE delivery.event_key IS NULL
      AND json_extract(event.payload_json,'$.purpose')='source-invalidated-revocation'
    ORDER BY event.created_at,event.event_key`).all() as Array<{
      eventKey: string; caseId: string; generation: number; payloadJson: string;
    }>;
  return rows.map(row => {
    const payload = JSON.parse(row.payloadJson) as {
      kind?: unknown; terminal?: unknown; reason?: unknown; coveredObservationIds?: unknown;
    };
    if (!['superseded', 'cancelled', 'ended', 'deleted', 'source-invalidated'].includes(String(payload.kind))
      || typeof payload.terminal !== 'boolean' || typeof payload.reason !== 'string' || !payload.reason.trim()
      || payload.coveredObservationIds !== undefined && (!Array.isArray(payload.coveredObservationIds)
        || payload.coveredObservationIds.some(id => typeof id !== 'string' || !id.trim()))) {
      throw new Error(`修复接管撤销事件 ${row.eventKey} 内容无效`);
    }
    return { eventKey: row.eventKey, caseId: row.caseId, generation: row.generation,
      kind: payload.kind as InvalidRepairTakeover['kind'], terminal: payload.terminal, reason: payload.reason,
      // Legacy receipts without an explicit boundary fail safe: they cannot
      // close any already observed business fault.
      coveredObservationIds: payload.coveredObservationIds as string[] | undefined || [] };
  });
}

export function acknowledgeRepairTakeoverRevocationInDb(db: Db, eventKey: string) {
  return db.transaction(() => {
    const event = db.prepare(`SELECT 1 FROM repair_takeover_events
      WHERE event_key=? AND json_extract(payload_json,'$.purpose')='source-invalidated-revocation'`).get(eventKey);
    if (!event) throw new Error('修复接管撤销事件不存在');
    return db.prepare('INSERT OR IGNORE INTO repair_takeover_event_deliveries(event_key) VALUES(?)').run(eventKey).changes === 1;
  }).immediate();
}
