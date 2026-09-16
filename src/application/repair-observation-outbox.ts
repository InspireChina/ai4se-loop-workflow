import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { RepairObservation } from '../domain/repair-case';
import { snapshotRepairOriginalContractInDb } from './repair-original-contract';

type Db = Database.Database;
type Source = {
  intervention_id: string; task_id: string; item_id: string | null; source_execution_id: string | null;
  dedupe_key: string; summary: string; context_json: string; requested_by: string; source_kind: string;
};

/** Business-side durable outbox only. Never opens the independent management
 * database inside a workflow transaction. */
export function enqueueInterventionFaultInDb(db: Db, source: Source, sourceVersion: string) {
  if (source.source_kind !== 'agent-fault') return null;
  const observationId = `intervention:${source.intervention_id}`;
  if (db.prepare('SELECT 1 FROM repair_observation_outbox WHERE observation_id = ?').get(observationId)) return observationId;
  const item = source.item_id ? db.prepare('SELECT item_id,work_key,revision,dispatch_epoch,status,story_index FROM workflow_items WHERE item_id = ? AND task_id = ?')
    .get(source.item_id, source.task_id) as { work_key: string } | undefined : undefined;
  const execution = source.source_execution_id ? db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ? AND task_id = ?')
    .get(source.source_execution_id, source.task_id) : null;
  const context = JSON.parse(source.context_json) as Record<string, unknown>;
  const fingerprint = typeof context.failureSignature === 'string' ? context.failureSignature
    : createHash('sha256').update(JSON.stringify({
      purpose: context.purpose || context.reason || 'agent-fault', failureKind: context.failureKind || null,
      summary: source.summary.replace(/\b(?:REQ-|INT-)?[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<id>')
        .replace(/第\s*\d+\s*次/g, '第<N>次').replace(/\s+/g, ' ').trim(),
    })).digest('hex');
  const observation: RepairObservation = {
    observationId, scope: item ? 'work-item' : 'execution',
    scopeKey: item ? `${source.task_id}:${item.work_key}` : source.source_execution_id || `task:${source.task_id}`,
    fingerprint, sourceVersion, summary: source.summary, origin: 'business',
    evidence: { interventionId: source.intervention_id, taskId: source.task_id, item: item || null,
      execution: execution || null, context, requestedBy: source.requested_by,
      originalContract: snapshotRepairOriginalContractInDb(db, { taskId: source.task_id,
        itemId: source.item_id, executionId: source.source_execution_id }) },
  };
  db.prepare('INSERT INTO repair_observation_outbox(observation_id,intervention_id,task_id,observation_json) VALUES(?,?,?,?)')
    .run(observationId, source.intervention_id, source.task_id, JSON.stringify(observation));
  return observationId;
}

export function pendingRepairObservationsInDb(db: Db, limit = 25) {
  return db.prepare(`SELECT outbox.observation_json FROM repair_observation_outbox outbox
    JOIN tasks task ON task.task_id = outbox.task_id
    JOIN projects project ON project.project_id = task.project_id
    JOIN interventions intervention ON intervention.intervention_id = outbox.intervention_id
    WHERE outbox.delivered_at IS NULL AND task.is_paused = 0 AND project.deleted_at IS NULL
      AND intervention.source_kind = 'agent-fault' AND intervention.status IN ('pending','running','awaiting_human')
    ORDER BY outbox.created_at,outbox.observation_id LIMIT ?`)
    .all(Math.max(1, Math.min(100, limit))) as { observation_json: string }[];
}

/** Observe in management first, then atomically acknowledge and link business.
 * A crash between databases replays the SAME immutable observation ID. */
export function acknowledgeRepairObservationInDb(db: Db, observationId: string, caseId: string) {
  return db.transaction(() => {
    const row = db.prepare('SELECT intervention_id,repair_case_id FROM repair_observation_outbox WHERE observation_id = ?')
      .get(observationId) as { intervention_id: string; repair_case_id: string | null } | undefined;
    if (!row) throw new Error('修复观察不存在');
    if (row.repair_case_id && row.repair_case_id !== caseId) throw new Error('修复观察不能改绑其他 Case');
    const source = db.prepare('SELECT source_kind,repair_case_id FROM interventions WHERE intervention_id = ?')
      .get(row.intervention_id) as { source_kind: string; repair_case_id: string | null } | undefined;
    if (source && (source.source_kind !== 'agent-fault' || source.repair_case_id && source.repair_case_id !== caseId)) {
      throw new Error('不能接管人工输入或改绑现有修复记录');
    }
    db.prepare('UPDATE repair_observation_outbox SET repair_case_id = ?,delivered_at = COALESCE(delivered_at,CURRENT_TIMESTAMP) WHERE observation_id = ?')
      .run(caseId, observationId);
    if (source) db.prepare('UPDATE interventions SET repair_case_id = ?,updated_at = CURRENT_TIMESTAMP WHERE intervention_id = ?')
      .run(caseId, row.intervention_id);
    return Boolean(source);
  }).immediate();
}

/** Trusted migration used when pre-cohort management stores already assigned
 * the same work item to multiple RepairCases. The management side has already
 * selected a canonical Case and stopped every related Admin execution. */
export function rebindRepairCaseCohortInDb(db: Db, canonicalCaseId: string, aliasCaseIds: string[]) {
  return db.transaction(() => {
    const aliases = [...new Set(aliasCaseIds)].filter(caseId => caseId !== canonicalCaseId);
    if (!canonicalCaseId.trim() || !aliases.length || aliases.some(caseId => !caseId.trim())) {
      throw new Error('历史修复 Case 介入迁移目标无效');
    }
    const placeholders = aliases.map(() => '?').join(',');
    const invalid = db.prepare(`SELECT intervention_id FROM interventions WHERE repair_case_id IN (${placeholders})
      AND source_kind<>'agent-fault' LIMIT 1`).get(...aliases);
    if (invalid) throw new Error('历史修复 Case 包含不可迁移的人工介入');
    const interventions = db.prepare(`UPDATE interventions SET repair_case_id=?,updated_at=CURRENT_TIMESTAMP
      WHERE repair_case_id IN (${placeholders})`).run(canonicalCaseId, ...aliases).changes;
    const observations = db.prepare(`UPDATE repair_observation_outbox SET repair_case_id=?
      WHERE repair_case_id IN (${placeholders})`).run(canonicalCaseId, ...aliases).changes;
    return { interventions, observations };
  }).immediate();
}
