import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { databaseConnection } from '../infrastructure/database';

export const RECOVERY_STAGES = ['analysis', 'dev', 'test'] as const;
export type RecoveryStage = typeof RECOVERY_STAGES[number];
export type RecoveryKind = 'test_failure';
export type RecoveryStatus = 'pending' | 'claimed' | 'reopened' | 'resolved' | 'superseded';

export type RecoveryResolutionClaim = {
  recoveryId: string;
  summary: string;
  evidence: string[];
};

export type RecoveryItem = {
  recovery_id: string;
  task_id: string;
  story_index: number | null;
  kind: RecoveryKind;
  source_agent: string;
  target_stage: 'analysis' | 'dev';
  status: RecoveryStatus;
  summary: string;
  details_json: string;
  source_execution_id: string | null;
  resolution_json: string | null;
  failure_count: number;
  claimed_at: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};

const createRecoverySchema = z.object({
  taskId: z.string().min(1),
  storyIndex: z.number().int().positive(),
  kind: z.literal('test_failure'),
  sourceAgent: z.string().min(1),
  targetStage: z.enum(['analysis', 'dev']),
  summary: z.string().trim().min(1).max(4000),
  details: z.record(z.unknown()),
  sourceExecutionId: z.string().min(1).optional().nullable(),
});

const stageRank: Record<RecoveryStage, number> = { analysis: 0, dev: 1, test: 2 };

function addRecoveryEvent(db: Awaited<ReturnType<typeof databaseConnection>>, taskId: string, actor: string, eventType: string, summary: string) {
  db.prepare(`
    INSERT INTO task_events(event_id, task_id, actor, event_type, summary)
    VALUES(?, ?, ?, ?, ?)
  `).run(randomUUID(), taskId, actor, eventType, summary);
}

function parsedResolution(item: RecoveryItem) {
  try {
    const value = JSON.parse(item.resolution_json || '{}') as { claims?: unknown[] };
    return { claims: Array.isArray(value.claims) ? value.claims : [] };
  } catch {
    return { claims: [] as unknown[] };
  }
}

export async function createOrReopenRecoveryItem(input: unknown) {
  const value = createRecoverySchema.parse(input);
  const db = await databaseConnection();
  if (value.sourceExecutionId) {
    const duplicate = db.prepare(`
      SELECT * FROM recovery_items
      WHERE source_execution_id = ? AND kind = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(value.sourceExecutionId, value.kind) as RecoveryItem | undefined;
    if (duplicate) return duplicate;
  }
  const existing = db.prepare(`
    SELECT * FROM recovery_items
    WHERE task_id = ? AND story_index = ? AND kind = ?
      AND status IN ('pending', 'claimed', 'reopened')
    ORDER BY created_at DESC LIMIT 1
  `).get(value.taskId, value.storyIndex, value.kind) as RecoveryItem | undefined;
  if (existing) {
    const nextStatus = existing.status === 'claimed' ? 'reopened' : existing.status;
    db.prepare(`
      UPDATE recovery_items
      SET target_stage = ?, status = ?, summary = ?, details_json = ?,
          source_agent = ?, source_execution_id = ?,
          failure_count = failure_count + 1, resolved_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE recovery_id = ?
    `).run(
      value.targetStage,
      nextStatus,
      value.summary,
      JSON.stringify(value.details),
      value.sourceAgent,
      value.sourceExecutionId || null,
      existing.recovery_id,
    );
    addRecoveryEvent(db, value.taskId, value.sourceAgent, 'RecoveryReopened', `${existing.recovery_id}：${value.summary}`);
    return db.prepare('SELECT * FROM recovery_items WHERE recovery_id = ?').get(existing.recovery_id) as RecoveryItem;
  }
  const recoveryId = `REC-${randomUUID().slice(0, 8)}`;
  db.prepare(`
    INSERT INTO recovery_items(
      recovery_id, task_id, story_index, kind, source_agent, target_stage, status,
      summary, details_json, source_execution_id
    ) VALUES(?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `).run(
    recoveryId,
    value.taskId,
    value.storyIndex,
    value.kind,
    value.sourceAgent,
    value.targetStage,
    value.summary,
    JSON.stringify(value.details),
    value.sourceExecutionId || null,
  );
  addRecoveryEvent(db, value.taskId, value.sourceAgent, 'RecoveryCreated', `${recoveryId}：${value.summary}`);
  return db.prepare('SELECT * FROM recovery_items WHERE recovery_id = ?').get(recoveryId) as RecoveryItem;
}

export async function listRecoveryItemsForStage(input: { taskId: string; storyIndex: number | null; stage: RecoveryStage }) {
  if (!input.storyIndex) return [];
  const db = await databaseConnection();
  const items = db.prepare(`
    SELECT * FROM recovery_items
    WHERE task_id = ? AND story_index = ?
      AND status IN ('pending', 'claimed', 'reopened')
    ORDER BY created_at, recovery_id
  `).all(input.taskId, input.storyIndex) as RecoveryItem[];
  return items.filter((item) => stageRank[item.target_stage] <= stageRank[input.stage]);
}

export function recoveryStageForAgent(agent: string): RecoveryStage | null {
  if (agent === 'analyst-agent') return 'analysis';
  if (agent === 'dev-agent') return 'dev';
  if (agent === 'test-agent') return 'test';
  return null;
}

export async function recordRecoveryClaims(input: {
  taskId: string;
  storyIndex: number | null;
  agent: string;
  executionId?: string;
  claims: RecoveryResolutionClaim[];
}) {
  if (!input.claims.length) return;
  const db = await databaseConnection();
  for (const claim of input.claims) {
    const item = db.prepare(`
      SELECT * FROM recovery_items
      WHERE recovery_id = ? AND task_id = ? AND story_index IS ?
        AND status IN ('pending', 'claimed', 'reopened')
    `).get(claim.recoveryId, input.taskId, input.storyIndex) as RecoveryItem | undefined;
    // Claims are useful context, not a Harness gate. Ignore stale or mistyped
    // references and let the next Test execution decide whether the behavior
    // has actually recovered.
    if (!item) continue;
    const resolution = parsedResolution(item);
    const duplicate = resolution.claims.some((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const value = entry as { executionId?: string; agent?: string };
      return Boolean(input.executionId) && value.executionId === input.executionId && value.agent === input.agent;
    });
    if (!duplicate) resolution.claims.push({
      ...claim,
      agent: input.agent,
      executionId: input.executionId || null,
      createdAt: new Date().toISOString(),
    });
    db.prepare(`
      UPDATE recovery_items
      SET status = 'claimed', resolution_json = ?, claimed_at = COALESCE(claimed_at, CURRENT_TIMESTAMP),
          updated_at = CURRENT_TIMESTAMP
      WHERE recovery_id = ?
    `).run(JSON.stringify(resolution), claim.recoveryId);
    if (!duplicate) addRecoveryEvent(db, input.taskId, input.agent, 'RecoveryClaimed', `${claim.recoveryId}：${claim.summary}`);
  }
}

export async function resolveActiveRecoveryItems(input: {
  taskId: string;
  storyIndex: number;
  kind: RecoveryKind;
  verifier: string;
  executionId?: string;
  summary: string;
}) {
  const db = await databaseConnection();
  const items = db.prepare(`
    SELECT * FROM recovery_items
    WHERE task_id = ? AND story_index = ? AND kind = ?
      AND status IN ('pending', 'claimed', 'reopened')
    ORDER BY created_at
  `).all(input.taskId, input.storyIndex, input.kind) as RecoveryItem[];
  for (const item of items) {
    const resolution = parsedResolution(item);
    db.prepare(`
      UPDATE recovery_items
      SET status = 'resolved', resolution_json = ?, resolved_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE recovery_id = ?
    `).run(JSON.stringify({
      ...resolution,
      verification: {
        verifier: input.verifier,
        executionId: input.executionId || null,
        summary: input.summary,
        verifiedAt: new Date().toISOString(),
      },
    }), item.recovery_id);
    addRecoveryEvent(db, input.taskId, input.verifier, 'RecoveryResolved', `${item.recovery_id}：${input.summary}`);
  }
  return items.map((item) => item.recovery_id);
}

export function recoveryItemForPrompt(item: RecoveryItem) {
  let details: Record<string, unknown> = {};
  let resolution: Record<string, unknown> | null = null;
  try { details = JSON.parse(item.details_json) as Record<string, unknown>; } catch { details = { raw: item.details_json }; }
  try { if (item.resolution_json) resolution = JSON.parse(item.resolution_json) as Record<string, unknown>; } catch { resolution = { raw: item.resolution_json }; }
  return {
    recoveryId: item.recovery_id,
    kind: item.kind,
    status: item.status,
    sourceAgent: item.source_agent,
    targetStage: item.target_stage,
    deliveryUnit: item.story_index,
    summary: item.summary,
    details,
    failureCount: item.failure_count,
    sourceExecutionId: item.source_execution_id,
    resolution,
  };
}
