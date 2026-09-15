import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { openInterventionInDb, type InterventionRow } from './interventions';
import type { RecoveryItem, RecoveryResolutionClaim } from './recovery-items';

type Db = Database.Database;
type RecoveryContext = {
  purpose: 'verification_recovery'; storyIndex: number; targetStage: 'analysis' | 'dev';
  details: Record<string, unknown>; planItemId: string | null; sourceItemId: string | null;
  sourceRevision: number; failureCount: number; legacyRecoveryId?: string;
  legacyStatus?: string; legacyResolution?: unknown; originalSourceExecutionId?: string | null;
  legacyClaimedAt?: string | null; legacyResolvedAt?: string | null;
};

function decoded(value: string | null): Record<string, unknown> {
  try { return JSON.parse(value || '{}') as Record<string, unknown>; }
  catch { return { raw: value }; }
}

export function usesNativeRecoveryInDb(db: Db, taskId: string) {
  return Boolean(db.prepare("SELECT 1 FROM tasks WHERE task_id = ? AND workflow_engine = 'native'").get(taskId));
}

function anchors(db: Db, taskId: string, unit: number, executionId?: string | null) {
  const source = executionId && db.prepare(`SELECT item.item_id, item.revision FROM execution_attempts execution
    JOIN workflow_items item ON item.item_id = execution.work_item_id
    WHERE execution.execution_id = ? AND execution.task_id = ? AND item.task_id = ? AND item.work_key = ?`)
    .get(executionId, taskId, taskId, `delivery:test:${unit}`) as { item_id: string; revision: number } | undefined;
  const test = source || db.prepare(`SELECT item_id, revision FROM workflow_items WHERE task_id = ?
    AND work_key = ? AND status NOT IN ('superseded', 'cancelled')`).get(taskId, `delivery:test:${unit}`) as { item_id: string; revision: number } | undefined;
  const plan = db.prepare(`SELECT item_id FROM workflow_items WHERE task_id = ? AND work_key = 'delivery:plan'
    AND status NOT IN ('superseded', 'cancelled')`).get(taskId) as { item_id: string } | undefined;
  return { sourceItemId: test?.item_id || null, sourceRevision: test?.revision || 1, planItemId: plan?.item_id || null };
}

/** Resolved means the orchestration blockage was routed back to ordinary
 * work. It does NOT claim that the original failed tests now pass. */
function recordDirective(db: Db, input: {
  taskId: string; sourceAgent: string; sourceExecutionId?: string | null; summary: string;
  dedupeKey: string; context: RecoveryContext; createdAt?: string;
}) {
  const row = openInterventionInDb(db, { taskId: input.taskId, dedupeKey: input.dedupeKey,
    requestedBy: input.sourceAgent, sourceExecutionId: input.sourceExecutionId, summary: input.summary,
    context: input.context, emitEvent: false });
  db.prepare(`UPDATE interventions SET status = 'resolved', item_id = ?, resolution = ?, resolved_by = 'workflow',
    resolved_at = COALESCE(resolved_at, CURRENT_TIMESTAMP), created_at = COALESCE(?, created_at), updated_at = CURRENT_TIMESTAMP
    WHERE intervention_id = ? AND status = 'pending'`)
    .run(input.context.sourceItemId, `已交回 ${input.context.targetStage}；原测试失败保留，等待后续工作项事实闭合`,
      input.createdAt || null, row.intervention_id);
  return row.intervention_id;
}

export function adoptRecoveryInterventionsInDb(db: Db, taskId: string) {
  return db.transaction(() => {
    const rows = db.prepare('SELECT * FROM recovery_items WHERE task_id = ? AND intervention_id IS NULL ORDER BY created_at, rowid')
      .all(taskId) as RecoveryItem[];
    for (const row of rows) {
      if (!row.story_index) continue;
      const validSource = row.source_execution_id && db.prepare('SELECT 1 FROM execution_attempts WHERE execution_id = ? AND task_id = ?')
        .get(row.source_execution_id, taskId);
      const interventionId = recordDirective(db, { taskId, sourceAgent: row.source_agent,
        sourceExecutionId: validSource ? row.source_execution_id : null, summary: row.summary,
        dedupeKey: `legacy-recovery:${row.recovery_id}`, createdAt: row.created_at,
        context: { purpose: 'verification_recovery', storyIndex: row.story_index, targetStage: row.target_stage,
          details: decoded(row.details_json), ...anchors(db, taskId, row.story_index, row.source_execution_id),
          failureCount: row.failure_count, legacyRecoveryId: row.recovery_id, legacyStatus: row.status,
          legacyResolution: decoded(row.resolution_json), originalSourceExecutionId: row.source_execution_id,
          legacyClaimedAt: row.claimed_at, legacyResolvedAt: row.resolved_at } });
      db.prepare('UPDATE recovery_items SET intervention_id = ? WHERE recovery_id = ? AND intervention_id IS NULL')
        .run(interventionId, row.recovery_id);
    }
  })();
}

export function createNativeRecoveryDirectiveInDb(db: Db, input: {
  taskId: string; storyIndex: number; sourceAgent: string; sourceExecutionId?: string | null;
  targetStage: 'analysis' | 'dev'; summary: string; details: Record<string, unknown>;
}) {
  return db.transaction(() => {
    if (input.sourceAgent !== 'test-agent' || !input.sourceExecutionId || !db.prepare(`SELECT 1 FROM execution_attempts execution
      JOIN workflow_items item ON item.item_id = execution.work_item_id
      WHERE execution.execution_id = ? AND execution.task_id = ? AND execution.story_index = ?
        AND execution.agent = 'test-agent' AND item.origin = 'native' AND item.task_id = execution.task_id
        AND item.agent = execution.agent AND item.story_index = execution.story_index AND item.work_key = ?`)
      .get(input.sourceExecutionId, input.taskId, input.storyIndex, `delivery:test:${input.storyIndex}`)) throw new Error('原生恢复必须关联当前需求的 Test 执行与工作项');
    const existing = db.prepare('SELECT intervention_id, summary, context_json FROM interventions WHERE task_id = ? AND dedupe_key = ?')
      .get(input.taskId, `verification-recovery:${input.sourceExecutionId}`) as { intervention_id: string; summary: string; context_json: string } | undefined;
    if (existing) {
      const previous = JSON.parse(existing.context_json) as RecoveryContext;
      if (existing.summary !== input.summary || previous.targetStage !== input.targetStage
        || JSON.stringify(previous.details) !== JSON.stringify(input.details)) throw new Error('恢复处置幂等键冲突，不能改写历史失败');
      return nativeRecoveryItemsInDb(db, input.taskId).find((item) => item.recovery_id === existing.intervention_id)!;
    }
    if (!db.prepare(`SELECT 1 FROM execution_attempts execution JOIN workflow_items item ON item.item_id = execution.work_item_id
      WHERE execution.execution_id = ? AND execution.status != 'cancelled'
        AND item.status NOT IN ('superseded', 'cancelled')`).get(input.sourceExecutionId)) {
      throw new Error('已取消的 Test 执行或已失效的工作项不能创建新的恢复处置');
    }
    const id = recordDirective(db, { ...input, dedupeKey: `verification-recovery:${input.sourceExecutionId}`,
      context: { purpose: 'verification_recovery', storyIndex: input.storyIndex, targetStage: input.targetStage,
        details: input.details, ...anchors(db, input.taskId, input.storyIndex, input.sourceExecutionId), failureCount: 1 } });
    return nativeRecoveryItemsInDb(db, input.taskId).find((item) => item.recovery_id === id)!;
  })();
}

/** RecoveryItem is now a compatibility read model. Its status comes from
 * Work Item history, never from a mutable recovery_items status flag. */
export function nativeRecoveryItemsInDb(db: Db, taskId: string): RecoveryItem[] {
  const rows = db.prepare(`SELECT * FROM interventions WHERE task_id = ? AND json_valid(context_json)
    AND json_extract(context_json, '$.purpose') = 'verification_recovery' ORDER BY created_at, rowid`).all(taskId) as InterventionRow[];
  const plan = db.prepare(`SELECT item_id FROM workflow_items WHERE task_id = ? AND work_key = 'delivery:plan'
    AND status NOT IN ('superseded', 'cancelled')`).get(taskId) as { item_id: string } | undefined;
  const models = rows.map((row): RecoveryItem => {
    const context = JSON.parse(row.context_json) as RecoveryContext;
    const current = db.prepare(`SELECT status FROM workflow_items WHERE task_id = ? AND work_key = ?
      AND origin = 'native' AND status NOT IN ('superseded', 'cancelled')`).get(taskId, `delivery:test:${context.storyIndex}`) as { status: string } | undefined;
    const completion = db.prepare(`SELECT completed_at, completion_authority, completion_reason FROM workflow_items
      WHERE task_id = ? AND work_key = ? AND origin = 'native' AND revision >= ? AND completed_at IS NOT NULL
      ORDER BY revision LIMIT 1`).get(taskId, `delivery:test:${context.storyIndex}`, context.sourceRevision) as {
        completed_at: string; completion_authority: string; completion_reason: string;
      } | undefined;
    const claims = db.prepare(`SELECT payload_json, created_at FROM execution_receipts WHERE kind = 'recovery_claim'
      AND receipt_key = ? ORDER BY created_at, rowid`).all(row.intervention_id) as { payload_json: string; created_at: string }[];
    const legacy = context.legacyResolution as { claims?: unknown[] } | undefined;
    const allClaims = [...(Array.isArray(legacy?.claims) ? legacy.claims : []), ...claims.map((claim) => decoded(claim.payload_json))];
    const obsolete = !current || Boolean(context.planItemId && context.planItemId !== plan?.item_id) || context.legacyStatus === 'superseded';
    const resolved = Boolean(completion) || context.legacyStatus === 'resolved';
    return { recovery_id: context.legacyRecoveryId || row.intervention_id, task_id: taskId,
      story_index: context.storyIndex, kind: 'test_failure', source_agent: row.requested_by,
      target_stage: context.targetStage, status: obsolete ? 'superseded' : resolved ? 'resolved' : allClaims.length ? 'claimed' : 'pending',
      summary: row.summary, details_json: JSON.stringify(context.details),
      source_execution_id: row.source_execution_id || context.originalSourceExecutionId || null,
      resolution_json: JSON.stringify({ ...context.legacyResolution as object,
        claims: allClaims, ...(completion ? { verification: completion } : {}) }),
      failure_count: context.failureCount, claimed_at: context.legacyClaimedAt || claims[0]?.created_at || null,
      resolved_at: resolved ? completion?.completed_at || context.legacyResolvedAt || row.resolved_at : null,
      created_at: row.created_at, updated_at: completion?.completed_at || claims.at(-1)?.created_at || row.updated_at };
  });
  // Only the latest still-unverified directive is hot context for each unit;
  // all earlier immutable directives remain accessible as history.
  const latest = new Map<number | null, RecoveryItem>();
  for (const item of models) if (['pending', 'claimed'].includes(item.status)) {
    const prior = latest.get(item.story_index);
    if (prior) { item.failure_count += prior.failure_count; prior.status = 'superseded'; }
    latest.set(item.story_index, item);
  }
  return models;
}

export function recordNativeRecoveryClaimsInDb(db: Db, input: {
  taskId: string; storyIndex: number | null; agent: string; executionId?: string; claims: RecoveryResolutionClaim[];
}) {
  if (!input.executionId || !db.prepare(`SELECT 1 FROM execution_attempts execution JOIN workflow_items item
    ON item.item_id = execution.work_item_id WHERE execution.execution_id = ? AND execution.task_id = ?
      AND execution.story_index IS ? AND execution.agent = ? AND item.origin = 'native'
      AND execution.status != 'cancelled'
      AND item.task_id = execution.task_id AND item.agent = execution.agent AND item.story_index IS execution.story_index
      AND item.status NOT IN ('superseded', 'cancelled')`)
    .get(input.executionId, input.taskId, input.storyIndex, input.agent)) return;
  const items = nativeRecoveryItemsInDb(db, input.taskId);
  for (const claim of input.claims) {
    const item = items.find((item) => item.recovery_id === claim.recoveryId && item.story_index === input.storyIndex
      && ['pending', 'claimed'].includes(item.status));
    if (!item) continue;
    const row = db.prepare(`SELECT intervention_id FROM interventions WHERE task_id = ?
      AND (intervention_id = ? OR json_extract(context_json, '$.legacyRecoveryId') = ?)`)
      .get(input.taskId, claim.recoveryId, claim.recoveryId) as { intervention_id: string };
    db.prepare(`INSERT INTO execution_receipts(receipt_id, execution_id, kind, receipt_key, payload_json)
      VALUES(?, ?, 'recovery_claim', ?, ?) ON CONFLICT(execution_id, kind, receipt_key) DO NOTHING`)
      .run(randomUUID(), input.executionId, row.intervention_id, JSON.stringify({ ...claim, agent: input.agent, executionId: input.executionId }));
  }
}

export function recordNativeRecoveryVerificationInDb(db: Db, input: {
  taskId: string; storyIndex: number; executionId?: string; summary: string;
}) {
  const items = nativeRecoveryItemsInDb(db, input.taskId).filter((item) => item.story_index === input.storyIndex
    && ['pending', 'claimed'].includes(item.status));
  if (input.executionId && db.prepare(`SELECT 1 FROM execution_attempts execution JOIN workflow_items item ON item.item_id = execution.work_item_id
    WHERE execution.execution_id = ? AND execution.task_id = ? AND execution.story_index = ?
      AND execution.agent = 'test-agent' AND item.origin = 'native' AND item.agent = execution.agent
      AND execution.status != 'cancelled'
      AND item.task_id = execution.task_id AND item.story_index = execution.story_index AND item.work_key = ?
      AND item.status NOT IN ('superseded', 'cancelled')`)
    .get(input.executionId, input.taskId, input.storyIndex, `delivery:test:${input.storyIndex}`)) {
    db.prepare(`INSERT INTO execution_receipts(receipt_id, execution_id, kind, receipt_key, payload_json)
      VALUES(?, ?, 'recovery_verification', 'result', ?) ON CONFLICT(execution_id, kind, receipt_key) DO NOTHING`)
      .run(randomUUID(), input.executionId, JSON.stringify({ recoveryIds: items.map((item) => item.recovery_id), summary: input.summary }));
  }
  // This receipt is evidence, not a completion transition. The result handler
  // must still complete the actual Test Work Item before recovery is closed.
  return items.map((item) => item.recovery_id);
}
