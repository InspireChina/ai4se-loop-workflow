import type Database from 'better-sqlite3';
import { repairVerificationReceiptSchema } from '../domain/repair-verification';

type Db = Database.Database;
export type RecoveryAcceptanceViolation = { code: string; detail: string; ids?: string[] };

function hasTable(db: Db, table: string) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function counts(db: Db, table: string, field: string) {
  if (!hasTable(db, table)) return {};
  const rows = db.prepare(`SELECT ${field} AS value,COUNT(*) AS count FROM ${table} GROUP BY ${field}`).all() as Array<{ value: string; count: number }>;
  return Object.fromEntries(rows.map(row => [row.value, row.count]));
}

function groupBy<T>(rows: T[], key: (row: T) => string) {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const value = key(row);
    grouped.set(value, [...(grouped.get(value) || []), row]);
  }
  return grouped;
}

const adminProcessTables = [
  'admin_business_worker_processes', 'admin_harness_build_processes', 'admin_runtime_host_processes',
  'admin_runtime_ui_processes', 'admin_runtime_cli_processes', 'admin_runtime_update_processes',
] as const;

function activeAdminProcesses(db: Db) {
  return adminProcessTables.flatMap(table => hasTable(db, table)
    ? (db.prepare(`SELECT allocation_id AS id,status,pid FROM ${table} WHERE status <> 'exited'`).all() as { id: string; status: string; pid: number | null }[])
      .map(row => ({ table, ...row }))
    : []);
}

/** Read-only acceptance audit. It checks durable end-state invariants; it does
 * not treat a Case state, Agent summary, or empty process list as repair proof. */
export function auditRecoveryAcceptance(admin: Db, business?: Db, options: { expectStopped?: boolean; now?: number; requiredCaseIds?: string[] } = {}) {
  const violations: RecoveryAcceptanceViolation[] = [];
  const cases = admin.prepare(`SELECT case_id AS caseId,scope,status,current_attempt_id AS currentAttemptId,generation
    FROM repair_cases ORDER BY created_at,case_id`).all() as Array<{
      caseId: string; scope: string; status: string; currentAttemptId: string | null; generation: number;
    }>;
  const attempts = admin.prepare(`SELECT attempt_id AS attemptId,case_id AS caseId,role,status,pid,start_marker AS startMarker,
    process_group_id AS processGroupId,generation FROM repair_attempts ORDER BY started_at,generation`).all() as Array<{
      attemptId: string; caseId: string; role: string; status: string; pid: number | null; startMarker: string | null;
      processGroupId: number | null; generation: number;
    }>;
  const requiredCaseIds = [...new Set(options.requiredCaseIds || [])];
  const missingCases = requiredCaseIds.filter(caseId => !cases.some(repairCase => repairCase.caseId === caseId));
  if (missingCases.length) violations.push({ code: 'required-repair-case-missing', detail: 'Acceptance scenario did not create every required RepairCase', ids: missingCases });
  const activeAttempts = attempts.filter(row => row.status === 'launching' || row.status === 'running');
  for (const [caseId, rows] of groupBy(activeAttempts, row => row.caseId)) {
    if (rows.length > 1) violations.push({ code: 'duplicate-active-admin', detail: `Case ${caseId} has ${rows.length} active Admin attempts`, ids: rows.map(row => row.attemptId) });
  }
  for (const repairCase of cases) {
    const active = activeAttempts.filter(row => row.caseId === repairCase.caseId);
    if (repairCase.currentAttemptId && !active.some(row => row.attemptId === repairCase.currentAttemptId)) {
      violations.push({ code: 'current-attempt-not-active', detail: `Case ${repairCase.caseId} points to a non-active attempt`, ids: [repairCase.currentAttemptId] });
    }
    if (!repairCase.currentAttemptId && active.length) {
      violations.push({ code: 'unowned-active-admin', detail: `Case ${repairCase.caseId} has an active attempt without current ownership`, ids: active.map(row => row.attemptId) });
    }
    if (repairCase.status !== 'closed') continue;
    const verificationRows = admin.prepare(`SELECT verification.attempt_id AS attemptId,verification.receipt_json AS receiptJson
      FROM repair_verifications verification JOIN repair_attempts attempt USING(attempt_id)
      JOIN repair_verification_purposes purpose USING(attempt_id)
      WHERE attempt.case_id=? AND attempt.role='verification' AND attempt.status='completed'
        AND purpose.purpose='repair-verification' AND verification.receipt_json IS NOT NULL`).all(repairCase.caseId) as { attemptId: string; receiptJson: string }[];
    const passed = verificationRows.filter(row => {
      try { const receipt = repairVerificationReceiptSchema.parse(JSON.parse(row.receiptJson)); return receipt.passed && receipt.exitConfirmed; }
      catch { return false; }
    });
    if (!passed.length) {
      violations.push({ code: 'closed-without-independent-verification', detail: `Closed Case ${repairCase.caseId} has no complete passed independent receipt` });
      continue;
    }
    const hasProgress = repairCase.scope === 'runtime'
      ? ['repair_runtime_business_closures', 'repair_runtime_original_operations'].some(table => hasTable(admin, table)
        && Boolean(admin.prepare(`SELECT 1 FROM ${table} WHERE case_id=? LIMIT 1`).get(repairCase.caseId)))
      : passed.some(row => {
        const kinds = admin.prepare('SELECT kind FROM repair_followups WHERE case_id=? AND verification_attempt_id=?').all(repairCase.caseId, row.attemptId) as { kind: string }[];
        return kinds.some(kind => kind.kind === 'handoff') && kinds.some(kind => kind.kind === 'business-progress');
      });
    if (!hasProgress) violations.push({ code: 'closed-without-business-progress', detail: `Closed Case ${repairCase.caseId} has no verified handoff/business progress closure` });
  }

  const adminProcesses = activeAdminProcesses(admin);
  let businessSummary: Record<string, unknown> | null = null;
  let activeBusinessProcesses: Array<{ table: string; id: string; status: string; pid: number | null }> = [];
  if (business) {
    const agentHuman = hasTable(business, 'interventions') ? business.prepare(`SELECT intervention_id AS id FROM interventions
      WHERE source_kind='agent-fault' AND status='awaiting_human' ORDER BY intervention_id`).all() as { id: string }[] : [];
    if (agentHuman.length) violations.push({ code: 'agent-fault-awaiting-human', detail: `${agentHuman.length} Agent faults were handed to humans`, ids: agentHuman.map(row => row.id) });
    if (hasTable(business, 'execution_processes')) {
      const rows = business.prepare("SELECT allocation_id AS id,execution_id AS source,status,pid FROM execution_processes WHERE status <> 'exited'").all() as Array<{ id: string; source: string; status: string; pid: number | null }>;
      activeBusinessProcesses.push(...rows.map(row => ({ table: 'execution_processes', id: row.id, status: row.status, pid: row.pid })));
      for (const [source, duplicates] of groupBy(rows, row => row.source)) if (duplicates.length > 1) {
        violations.push({ code: 'duplicate-active-execution', detail: `Execution ${source} has ${duplicates.length} active physical allocations`, ids: duplicates.map(row => row.id) });
      }
    }
    if (hasTable(business, 'loop_managed_processes')) {
      const managed = business.prepare("SELECT process_id AS id,status,pid FROM loop_managed_processes WHERE status='running'").all() as Array<{ id: string; status: string; pid: number | null }>;
      activeBusinessProcesses.push(...managed.map(row => ({ table: 'loop_managed_processes', ...row })));
    }
    businessSummary = {
      tasksByStatus: counts(business, 'tasks', 'agile_status'),
      executionsByStatus: counts(business, 'execution_attempts', 'status'),
      interventionsByStatus: counts(business, 'interventions', 'status'),
      activeProcesses: activeBusinessProcesses,
    };
  }
  if (options.expectStopped && (activeAttempts.length || adminProcesses.length || activeBusinessProcesses.length)) {
    violations.push({ code: 'residual-process-barrier-after-stop', detail: 'Stopped acceptance snapshot still has active Admin/business process allocations',
      ids: [...activeAttempts.map(row => row.attemptId), ...adminProcesses.map(row => row.id), ...activeBusinessProcesses.map(row => row.id)] });
  }
  return {
    schema: 'loop-recovery-acceptance-audit/v1', generatedAt: options.now ?? Date.now(), expectStopped: Boolean(options.expectStopped), requiredCaseIds,
    admin: { casesByStatus: counts(admin, 'repair_cases', 'status'), attemptsByStatus: counts(admin, 'repair_attempts', 'status'), cases, activeAttempts, activeProcesses: adminProcesses },
    business: businessSummary, violations, passed: violations.length === 0,
  };
}
