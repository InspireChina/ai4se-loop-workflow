import Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve, join } from 'node:path';
import { z } from 'zod';
import type {RuntimeCliProcess} from '../domain/runtime-cli';
import {adminBusinessRequestSchema,parallelAdminWorker,type AdminBusinessWorkerRecord,type AdminBusinessRequest} from '../domain/admin-business-worker';
import type { AdminAuthority, RepairAttempt, RepairCase, RepairClaim, RepairObservation } from '../domain/repair-case';
import { adminActionSchema, adminSubmissionSchema, type AdminActionRecord, type AdminCommandCredential, type AdminSubmission } from '../domain/admin-command';
import { adminRuntimeConfigurationSchema, type AdminRuntimeSnapshot } from '../domain/admin-runtime-configuration';
import { repairVerificationCheckSchema, repairVerificationPlanSchema, repairVerificationReceiptSchema, repairVerificationSteps, type RepairVerificationPlan, type RepairVerificationReceipt } from '../domain/repair-verification';
import { repairBusinessProgressSchema, repairBusinessReadinessSchema, repairHandoffReceiptSchema, repairWorkspaceAnchorSchema, type RepairHandoffReceipt } from '../domain/repair-followup';
import { decideRepairRecovery, repairRecoveryDecisionSchema } from '../domain/repair-recovery-policy';
import { repairDispatchStallDue, sampleRepairDispatchWatch } from '../domain/repair-dispatch-watch';
import { adminHistoryChunk, boundedAdminHistory, type AdminHistoryCollection } from '../domain/admin-history';
import { authorizePreparedVerification, independentPreparationHash, type IndependentVerificationInput } from '../domain/independent-verification-preparation';
import { OriginalCoverageMissing } from '../domain/original-coverage';
import {originalRuntimeArtifact} from '../domain/runtime-original-artifact';
import {runtimeRepairBaselineSchema,runtimeRepairHandoffSchema,type RuntimeRepairHandoff} from '../domain/runtime-repair-followup';
import {runtimeBusinessBaselineSchema,runtimeBusinessProgressCandidateSchema,runtimeBusinessCohortChangeSchema,runtimeBusinessCohortInvalidated,runtimeBusinessDispatchSnapshotSchema,runtimeOriginalOperationReceiptSchema,type RuntimeBusinessBaseline,type RuntimeBusinessProgressCandidate,type RuntimeOriginalOperationReceipt} from '../domain/runtime-business-progress';
import { runtimeRollbackTarget, runtimeUpdateIdSchema, publisherUpdateSchema, type PublisherUpdate, runtimeArtifactSchema, runtimeUpdateRequestSchema, runtimeUpdatePhaseSchema, runtimeUpdateTerminal, runtimeUpdateTransitions,
  type RuntimeUpdateRecord, type RuntimeUpdateRequest, type RuntimeUpdateAuthority, type RuntimeUpdatePhase, type RuntimeArtifact, type RuntimeUpdateProcess,
  type RuntimeHostAuthority, type RuntimeInstallation, type RuntimeHostProcess, type RuntimeUiProcess } from '../domain/runtime-update';

const observationSchema = z.object({
  observationId: z.string().trim().min(1).max(500),
  scope: z.enum(['execution', 'work-item', 'run', 'runtime']),
  scopeKey: z.string().trim().min(1).max(1000),
  fingerprint: z.string().trim().min(1).max(1000),
  sourceVersion: z.string().trim().min(1).max(500),
  summary: z.string().trim().min(1).max(16000),
  evidence: z.record(z.string(), z.unknown()),
  origin: z.enum(['business', 'runtime', 'admin']),
  repairCaseId: z.string().trim().min(1).optional(),
}).strict();
const repairTakeoverRevocationSchema = z.object({
  caseId: z.string().trim().min(1), generation: z.number().int().positive(),
  kind: z.enum(['superseded', 'cancelled', 'ended', 'deleted', 'source-invalidated']),
  terminal: z.boolean(), reason: z.string().trim().min(1), eventKey: z.string().trim().min(1),
  coveredObservationIds: z.array(z.string().trim().min(1)).max(100000).default([]),
}).strict();

// Runtime invalidation/stall facts continue the same investigation; they do
// not replace an original failure or become a new acceptance target.
// Everything else non-Admin must be retained in repair verification.
// Independent focused diagnosis is not authority to hand back.
const requiredOriginalWhere = `case_id = ? AND origin <> 'admin'
  AND NOT (origin = 'runtime' AND COALESCE(json_extract(evidence_json,'$.kind'),'')
    IN ('repair-version-changed','repair-verification-coverage-missing','repair-runtime-cohort-changed','repair-runtime-dispatch-stalled'))`;
const workspaceAnchorContains = (anchor: z.infer<typeof repairWorkspaceAnchorSchema>, itemId: string, revision?: number) =>
  [{ itemId: anchor.itemId, revision: anchor.itemRevision }, ...(anchor.predecessors || [])]
    .some(item => item.itemId === itemId);
const workerTable=(operation:AdminBusinessRequest['operation'])=>operation==='harness-build'?'admin_harness_build_processes':'admin_business_worker_processes';
const allWorkerTables=`(SELECT rowid AS ledger_order,* FROM admin_business_worker_processes
  UNION ALL SELECT rowid AS ledger_order,* FROM admin_harness_build_processes)`;
function coveragePreview(rows: { observation_id: string }[]) {
  const ids: string[] = [];
  for (const row of rows) {
    if (JSON.stringify([...ids, row.observation_id]).length > 4000) break;
    ids.push(row.observation_id);
  }
  return ids;
}

export type ReusableHarnessCandidate = {
  attemptId:string;buildKey:string;candidate:RuntimeArtifact;sourceId:string;
  sourceArtifact:RuntimeArtifact;receipts:Array<{stage:string;exitCode:number}>;
  toolchain:{node:string;npm:string;version:string;platform:string;arch:string};logFile:string;
};
const harnessBuildStages=['dependencies','tests','typescript','next-build','desktop-build'] as const;

type Control = {
  desired_intent: 'running' | 'stopped'; intent_revision: number;
  management_mode: 'normal' | 'update-silence';
  owner_id: string | null; fencing_token: number; expires_at: number;
};

/** Separate management database: no business database initialization, migration or FK. */
export class AdminManagementStore {
  private readonly db: Database.Database;
  constructor(readonly filename: string, private readonly now: () => number = Date.now) {
    const canonicalFile = existsSync(filename) ? realpathSync(filename) : resolve(filename);
    if (!isAbsolute(filename) || ['loop-ui.db', 'loopwork.db'].includes(basename(canonicalFile))) {
      throw new Error('Admin 管理库必须是独立的绝对路径，不能使用业务或应用数据库');
    }
    const businessPath = process.env.LOOP_GLOBAL_DB_PATH;
    if (businessPath && canonicalFile === (existsSync(businessPath) ? realpathSync(businessPath) : resolve(businessPath))) throw new Error('Admin 管理库不能复用业务数据库');
    mkdirSync(dirname(filename), { recursive: true });
    this.db = new Database(filename);
    try {
      const businessTables = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('tasks','loop_runs','app_settings','project_settings')").all();
      if (businessTables.length) throw new Error('Admin 管理库不能复用已有业务或应用数据库');
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
      if (tables.length && !tables.some(table => table.name === 'admin_control')) throw new Error('Admin 管理库不能接管其他用途的已有数据库');
      const version = this.db.pragma('user_version', { simple: true }) as number;
      if (version > 1) throw new Error(`Admin 管理库版本 ${version} 高于当前支持版本；拒绝降级写入`);
      this.db.pragma('busy_timeout = 1000');
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = FULL');
      this.db.pragma('foreign_keys = ON');
      this.db.transaction(() => this.db.exec(`
      CREATE TABLE IF NOT EXISTS admin_control (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        desired_intent TEXT NOT NULL DEFAULT 'stopped' CHECK(desired_intent IN ('running','stopped')),
        management_mode TEXT NOT NULL DEFAULT 'normal' CHECK(management_mode IN ('normal','update-silence')),
        intent_revision INTEGER NOT NULL DEFAULT 0,
        owner_id TEXT, fencing_token INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO admin_control(singleton) VALUES(1);
      CREATE TABLE IF NOT EXISTS admin_runtime_installation (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),artifact_json TEXT NOT NULL,revision INTEGER NOT NULL,update_id TEXT
      );
      CREATE TABLE IF NOT EXISTS admin_publisher_updates (
        request_id TEXT PRIMARY KEY,record_json TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_publisher_update ON admin_publisher_updates((1))
        WHERE json_extract(record_json,'$.status') IN ('preparing','ready');
      CREATE TABLE IF NOT EXISTS admin_runtime_host_lease (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),owner_id TEXT,token INTEGER NOT NULL DEFAULT 0,expires_at INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO admin_runtime_host_lease(singleton) VALUES(1);
      CREATE TABLE IF NOT EXISTS admin_runtime_root_artifacts (
        owner_id TEXT NOT NULL,token INTEGER NOT NULL,artifact_json TEXT NOT NULL,
        PRIMARY KEY(owner_id,token)
      );
      CREATE TABLE IF NOT EXISTS admin_business_worker_processes (
        allocation_id TEXT PRIMARY KEY,root_authority_json TEXT NOT NULL,management_authority_json TEXT NOT NULL,
        intent_revision INTEGER NOT NULL,artifact_json TEXT NOT NULL,operation TEXT NOT NULL,parent_pid INTEGER NOT NULL,
        pid INTEGER,marker TEXT,group_id INTEGER,status TEXT NOT NULL CHECK(status IN ('launching','bound','exited'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_live_admin_business_worker ON admin_business_worker_processes((1)) WHERE status<>'exited';
      CREATE TABLE IF NOT EXISTS admin_harness_build_processes (
        allocation_id TEXT PRIMARY KEY,root_authority_json TEXT NOT NULL,management_authority_json TEXT NOT NULL,
        intent_revision INTEGER NOT NULL,artifact_json TEXT NOT NULL,operation TEXT NOT NULL CHECK(operation='harness-build'),parent_pid INTEGER NOT NULL,
        pid INTEGER,marker TEXT,group_id INTEGER,status TEXT NOT NULL CHECK(status IN ('launching','bound','exited'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_live_admin_harness_build ON admin_harness_build_processes((1)) WHERE status<>'exited';
      CREATE TABLE IF NOT EXISTS admin_runtime_host_processes (
        allocation_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,token INTEGER NOT NULL,artifact_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('reserved','bound','ready','exited')),
        pid INTEGER,marker TEXT,group_id INTEGER,parent_pid INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS admin_runtime_one_host ON admin_runtime_host_processes((1)) WHERE status<>'exited';
      CREATE TABLE IF NOT EXISTS admin_runtime_ui_processes (
        allocation_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,token INTEGER NOT NULL,artifact_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('reserved','bound','ready','exited')),
        pid INTEGER,marker TEXT,group_id INTEGER,parent_pid INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS admin_runtime_one_ui ON admin_runtime_ui_processes((1)) WHERE status<>'exited';
      CREATE TABLE IF NOT EXISTS admin_runtime_cli_hosts (
        host_allocation_id TEXT PRIMARY KEY REFERENCES admin_runtime_host_processes(allocation_id),
        certified INTEGER NOT NULL DEFAULT 0 CHECK(certified IN (0,1)),
        draining INTEGER NOT NULL DEFAULT 0 CHECK(draining IN (0,1))
      );
      CREATE TABLE IF NOT EXISTS admin_runtime_cli_processes (
        allocation_id TEXT PRIMARY KEY,host_allocation_id TEXT NOT NULL REFERENCES admin_runtime_cli_hosts(host_allocation_id),
        execution_id TEXT NOT NULL,owner_pid INTEGER NOT NULL,pid INTEGER,marker TEXT,group_id INTEGER,
        status TEXT NOT NULL CHECK(status IN ('launching','running','terminating','exited'))
      );
      CREATE INDEX IF NOT EXISTS admin_runtime_cli_host ON admin_runtime_cli_processes(host_allocation_id,status);
      CREATE TABLE IF NOT EXISTS admin_runtime_updates (
        update_id TEXT PRIMARY KEY, request_json TEXT NOT NULL, phase TEXT NOT NULL,
        selected_json TEXT NOT NULL, intent_revision INTEGER NOT NULL,
        owner_id TEXT, token INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL DEFAULT 0,
        failure TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS admin_runtime_one_update ON admin_runtime_updates((1))
        WHERE phase NOT IN ('succeeded','rolled-back','aborted');
      CREATE TABLE IF NOT EXISTS admin_runtime_rollback_targets (
        update_id TEXT PRIMARY KEY REFERENCES admin_runtime_updates(update_id),
        source_update_id TEXT NOT NULL REFERENCES admin_runtime_updates(update_id),
        artifact_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admin_runtime_update_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT, update_id TEXT NOT NULL REFERENCES admin_runtime_updates(update_id),
        phase TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS admin_runtime_update_events_history ON admin_runtime_update_events(update_id,event_id);
      CREATE TABLE IF NOT EXISTS admin_runtime_update_processes (
        allocation_id TEXT PRIMARY KEY, update_id TEXT NOT NULL REFERENCES admin_runtime_updates(update_id),
        owner_id TEXT NOT NULL, token INTEGER NOT NULL, artifact_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('reserved','bound','ready','activated','exited')),
        pid INTEGER, marker TEXT, group_id INTEGER, parent_pid INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS admin_intent_commands (
        request_id TEXT PRIMARY KEY, action TEXT NOT NULL, revision INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admin_runtime_configuration (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL,
        configuration_json TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admin_runtime_alternatives (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL,
        configurations_json TEXT NOT NULL,updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repair_cases (
        case_id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE,
        scope TEXT NOT NULL, scope_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
        original_version TEXT NOT NULL, original_summary TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','verifying','observing','external-wait','closed')),
        generation INTEGER NOT NULL DEFAULT 0, current_attempt_id TEXT,
        next_probe_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repair_observations (
        observation_id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES repair_cases(case_id),
        origin TEXT NOT NULL, source_version TEXT NOT NULL, summary TEXT NOT NULL,
        evidence_json TEXT NOT NULL, observation_hash TEXT NOT NULL, observation_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repair_attempts (
        attempt_id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES repair_cases(case_id),
        owner_id TEXT NOT NULL, supervision_token INTEGER NOT NULL,
        generation INTEGER NOT NULL, intent_revision INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('launching','running','completed','failed','interrupted')),
        pid INTEGER, start_marker TEXT, process_group_id INTEGER,
        started_at INTEGER NOT NULL, finished_at INTEGER, last_error TEXT,
        UNIQUE(case_id,generation)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_physical_admin_per_case ON repair_attempts(case_id)
        WHERE status IN ('launching','running');
      CREATE TABLE IF NOT EXISTS repair_schedule_queue (
        ticket INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id TEXT NOT NULL UNIQUE REFERENCES repair_cases(case_id)
      );
      CREATE TABLE IF NOT EXISTS repair_evidence (
        case_id TEXT NOT NULL REFERENCES repair_cases(case_id), attempt_id TEXT NOT NULL REFERENCES repair_attempts(attempt_id),
        receipt_key TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(attempt_id,receipt_key)
      );
      CREATE TABLE IF NOT EXISTS repair_recovery_decisions (
        attempt_id TEXT PRIMARY KEY REFERENCES repair_attempts(attempt_id),
        decision_json TEXT NOT NULL,created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repair_activity_checkpoints (
        case_id TEXT NOT NULL REFERENCES repair_cases(case_id),
        fingerprint TEXT NOT NULL,attempt_id TEXT NOT NULL REFERENCES repair_attempts(attempt_id),
        operation_json TEXT NOT NULL,created_at INTEGER NOT NULL,
        PRIMARY KEY(case_id,fingerprint)
      );
      CREATE TABLE IF NOT EXISTS repair_source_invalidations (
        case_id TEXT NOT NULL REFERENCES repair_cases(case_id), generation INTEGER NOT NULL,
        payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(case_id,generation)
      );
      CREATE TABLE IF NOT EXISTS repair_case_aliases (
        alias_case_id TEXT PRIMARY KEY REFERENCES repair_cases(case_id),
        canonical_case_id TEXT NOT NULL REFERENCES repair_cases(case_id), merged_at INTEGER NOT NULL,
        CHECK(alias_case_id <> canonical_case_id)
      );
      CREATE TABLE IF NOT EXISTS repair_interruption_facts (
        attempt_id TEXT PRIMARY KEY REFERENCES repair_attempts(attempt_id),
        cause TEXT NOT NULL CHECK(cause IN ('user-stop','update','host-loss')),created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admin_command_sessions (
        session_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE REFERENCES repair_attempts(attempt_id),
        token_hash TEXT NOT NULL, status_viewed INTEGER NOT NULL DEFAULT 0,
        submission_json TEXT, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admin_command_actions (
        attempt_id TEXT NOT NULL REFERENCES repair_attempts(attempt_id),
        receipt_key TEXT NOT NULL, action_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','failed')),
        result_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(attempt_id,receipt_key)
      );
      CREATE TABLE IF NOT EXISTS repair_verifications (
        attempt_id TEXT PRIMARY KEY REFERENCES repair_attempts(attempt_id),
        source_repair_attempt_id TEXT NOT NULL REFERENCES repair_attempts(attempt_id),
        plan_json TEXT NOT NULL, receipt_json TEXT, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repair_verification_purposes (
        attempt_id TEXT PRIMARY KEY REFERENCES repair_attempts(attempt_id),
        purpose TEXT NOT NULL CHECK(purpose IN ('diagnosis','repair-verification'))
      );
      CREATE TABLE IF NOT EXISTS repair_verification_preparations (
        attempt_id TEXT PRIMARY KEY REFERENCES repair_attempts(attempt_id),
        source_repair_attempt_id TEXT NOT NULL REFERENCES repair_attempts(attempt_id),
        input_hash TEXT NOT NULL,workspace_root TEXT NOT NULL,plan_json TEXT NOT NULL,created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repair_verification_artifacts (
        attempt_id TEXT PRIMARY KEY REFERENCES repair_verification_preparations(attempt_id),
        manifest_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repair_diagnosis_facts (
        case_id TEXT NOT NULL REFERENCES repair_cases(case_id),fingerprint TEXT NOT NULL,
        attempt_id TEXT NOT NULL REFERENCES repair_attempts(attempt_id),created_at INTEGER NOT NULL,
        PRIMARY KEY(case_id,fingerprint)
      );
      CREATE TABLE IF NOT EXISTS repair_diagnosis_rounds (
        attempt_id TEXT PRIMARY KEY REFERENCES repair_attempts(attempt_id),
        novel INTEGER NOT NULL CHECK(novel IN (0,1))
      );
      CREATE TABLE IF NOT EXISTS repair_followups (
        case_id TEXT NOT NULL REFERENCES repair_cases(case_id),
        verification_attempt_id TEXT NOT NULL REFERENCES repair_attempts(attempt_id),
        kind TEXT NOT NULL CHECK(kind IN ('handoff','business-progress')),
        payload_json TEXT NOT NULL,created_at INTEGER NOT NULL,
        PRIMARY KEY(verification_attempt_id,kind)
      );
      CREATE TABLE IF NOT EXISTS repair_business_watches (
        verification_attempt_id TEXT PRIMARY KEY REFERENCES repair_attempts(attempt_id),
        intent_revision INTEGER NOT NULL,readiness TEXT NOT NULL,
        eligible_elapsed_ms INTEGER NOT NULL,last_sample_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repair_runtime_update_baselines (
        verification_attempt_id TEXT PRIMARY KEY REFERENCES repair_attempts(attempt_id),
        case_id TEXT NOT NULL REFERENCES repair_cases(case_id),update_id TEXT NOT NULL UNIQUE REFERENCES admin_runtime_updates(update_id),
        baseline_json TEXT NOT NULL,created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repair_runtime_handoffs (
        verification_attempt_id TEXT PRIMARY KEY REFERENCES repair_attempts(attempt_id),
        case_id TEXT NOT NULL REFERENCES repair_cases(case_id),payload_json TEXT NOT NULL,created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repair_runtime_handoff_generations (
        verification_attempt_id TEXT NOT NULL REFERENCES repair_attempts(attempt_id),
        host_allocation_id TEXT NOT NULL REFERENCES admin_runtime_host_processes(allocation_id),
        case_id TEXT NOT NULL REFERENCES repair_cases(case_id),payload_json TEXT NOT NULL,created_at INTEGER NOT NULL,
        PRIMARY KEY(verification_attempt_id,host_allocation_id)
      );
      CREATE TABLE IF NOT EXISTS repair_runtime_business_baselines (
        verification_attempt_id TEXT PRIMARY KEY REFERENCES repair_attempts(attempt_id),
        case_id TEXT NOT NULL REFERENCES repair_cases(case_id),update_id TEXT NOT NULL UNIQUE REFERENCES admin_runtime_updates(update_id),
        payload_json TEXT NOT NULL,created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repair_runtime_business_progress (
        verification_attempt_id TEXT NOT NULL REFERENCES repair_attempts(attempt_id),
        case_id TEXT NOT NULL REFERENCES repair_cases(case_id),task_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,result_id TEXT NOT NULL,completion_event_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,created_at INTEGER NOT NULL,
        PRIMARY KEY(verification_attempt_id,task_id,execution_id,result_id,completion_event_id)
      );
      CREATE TABLE IF NOT EXISTS repair_runtime_business_closures (
        verification_attempt_id TEXT PRIMARY KEY REFERENCES repair_attempts(attempt_id),
        case_id TEXT NOT NULL REFERENCES repair_cases(case_id),payload_json TEXT NOT NULL,closed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repair_runtime_original_operations (
        verification_attempt_id TEXT PRIMARY KEY REFERENCES repair_attempts(attempt_id),
        case_id TEXT NOT NULL REFERENCES repair_cases(case_id),payload_json TEXT NOT NULL,closed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repair_runtime_dispatch_watches (
        verification_attempt_id TEXT NOT NULL REFERENCES repair_attempts(attempt_id),
        case_id TEXT NOT NULL REFERENCES repair_cases(case_id),task_id TEXT NOT NULL,
        source_key TEXT NOT NULL,intent_revision INTEGER NOT NULL,readiness TEXT NOT NULL,
        eligible_elapsed_ms INTEGER NOT NULL,last_sample_at INTEGER NOT NULL,
        PRIMARY KEY(verification_attempt_id,task_id)
      );
      CREATE INDEX IF NOT EXISTS repair_observations_case_history ON repair_observations(case_id,created_at);
      CREATE INDEX IF NOT EXISTS repair_evidence_case_history ON repair_evidence(case_id,created_at);
      CREATE INDEX IF NOT EXISTS repair_attempts_case_history ON repair_attempts(case_id,started_at,generation);
      CREATE INDEX IF NOT EXISTS repair_followups_case_history ON repair_followups(case_id,created_at);
      PRAGMA user_version = 1;
    `)).immediate();
      // This independent schema has not shipped yet. Upgrade existing local
      // development management stores without opening business migrations.
      const controlColumns = this.db.prepare('PRAGMA table_info(admin_control)').all() as { name: string }[];
      const updateProcessColumns=this.db.prepare('PRAGMA table_info(admin_runtime_update_processes)').all() as {name:string}[];
      if(!updateProcessColumns.some(column=>column.name==='parent_pid'))this.db.exec('ALTER TABLE admin_runtime_update_processes ADD COLUMN parent_pid INTEGER NOT NULL DEFAULT 0');
      const hostColumns=this.db.prepare('PRAGMA table_info(admin_runtime_host_processes)').all() as {name:string}[];
      if(!hostColumns.some(column=>column.name==='business_supervision_token'))this.db.exec('ALTER TABLE admin_runtime_host_processes ADD COLUMN business_supervision_token INTEGER');
      if (!controlColumns.some(column => column.name === 'management_mode')) {
        this.db.exec("ALTER TABLE admin_control ADD COLUMN management_mode TEXT NOT NULL DEFAULT 'normal' CHECK(management_mode IN ('normal','update-silence'))");
      }
      const attemptColumns = this.db.prepare('PRAGMA table_info(repair_attempts)').all() as { name: string }[];
      if (!attemptColumns.some(column => column.name === 'role')) {
        this.db.exec("ALTER TABLE repair_attempts ADD COLUMN role TEXT NOT NULL DEFAULT 'investigation' CHECK(role IN ('investigation','verification'))");
      }
      this.db.transaction(()=>this.db.exec(`
        INSERT INTO repair_schedule_queue(case_id)
        SELECT repair_cases.case_id FROM repair_cases
        WHERE NOT EXISTS(SELECT 1 FROM repair_schedule_queue queue WHERE queue.case_id=repair_cases.case_id)
        ORDER BY COALESCE((SELECT MAX(started_at) FROM repair_attempts attempt WHERE attempt.case_id=repair_cases.case_id),created_at),created_at,case_id
      `)).immediate();
      this.db.transaction(()=>{
        if(this.runtimeInstallation())return;
        const pending=this.activeRuntimeUpdate();
        if(pending){this.initializeRuntimeInstallation(pending.request.before);return;}
        const latest=this.db.prepare("SELECT selected_json,update_id FROM admin_runtime_updates WHERE phase IN ('succeeded','rolled-back','aborted') ORDER BY updated_at DESC,rowid DESC LIMIT 1")
          .get() as {selected_json:string;update_id:string}|undefined;
        if(latest) {
          const artifact=runtimeArtifactSchema.parse(JSON.parse(latest.selected_json));
          this.db.prepare('INSERT INTO admin_runtime_installation(singleton,artifact_json,revision,update_id) VALUES(1,?,1,?)').run(JSON.stringify(artifact),latest.update_id);
        }
      }).immediate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close() { this.db.close(); }
  control(): Control { return this.db.prepare('SELECT * FROM admin_control WHERE singleton = 1').get() as Control; }

  runtimeConfiguration(): AdminRuntimeSnapshot | null {
    const row = this.db.prepare('SELECT * FROM admin_runtime_configuration WHERE singleton = 1').get() as
      { revision: number; configuration_json: string; updated_at: number } | undefined;
    return row ? { revision: row.revision, configuration: adminRuntimeConfigurationSchema.parse(JSON.parse(row.configuration_json)), updatedAt: row.updated_at } : null;
  }

  runtimeAlternatives() {
    const row = this.db.prepare('SELECT revision,configurations_json FROM admin_runtime_alternatives WHERE singleton = 1').get() as
      { revision: number; configurations_json: string } | undefined;
    return row ? { revision: row.revision, configurations: z.array(adminRuntimeConfigurationSchema).max(100).parse(JSON.parse(row.configurations_json)) } : null;
  }

  cacheRuntimeAlternatives(authority: AdminAuthority, input: unknown, expectedRevision: number) {
    const configurations = z.array(adminRuntimeConfigurationSchema).max(100).parse(input);
    if (new Set(configurations.map(configuration => configuration.configurationId)).size !== configurations.length) throw new Error('管理 Runtime 候选配置 ID 不能重复');
    return this.db.transaction(() => {
      this.assertAuthority(authority, true);
      const current = this.runtimeAlternatives();
      if ((current?.revision || 0) !== expectedRevision) throw new Error('管理 Runtime 候选已变化，拒绝迟到配置覆盖');
      if (current && JSON.stringify(current.configurations) === JSON.stringify(configurations)) return current;
      this.db.prepare(`INSERT INTO admin_runtime_alternatives(singleton,revision,configurations_json,updated_at) VALUES(1,?,?,?)
        ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,configurations_json=excluded.configurations_json,updated_at=excluded.updated_at`)
        .run(expectedRevision + 1, JSON.stringify(configurations), this.now());
      return this.runtimeAlternatives()!;
    }).immediate();
  }

  recoveryDecision(attemptId: string) {
    const row = this.db.prepare('SELECT decision_json FROM repair_recovery_decisions WHERE attempt_id = ?')
      .get(attemptId) as { decision_json: string } | undefined;
    return row ? repairRecoveryDecisionSchema.parse(JSON.parse(row.decision_json)) : null;
  }

  knownActivityCheckpoint(claim: RepairClaim, operation: string) {
    this.assertClaim(claim);
    const fingerprint = createHash('sha256').update(operation).digest('hex');
    return Boolean(this.db.prepare('SELECT 1 FROM repair_activity_checkpoints WHERE case_id = ? AND fingerprint = ?')
      .get(claim.repairCase.caseId, fingerprint));
  }

  recordActivityCheckpoint(claim: RepairClaim, operation: string) {
    if (operation.length > 64_000) throw new Error('管理活动检查点过大');
    return this.db.transaction(() => {
      this.assertClaim(claim);
      const fingerprint = createHash('sha256').update(operation).digest('hex');
      return this.db.prepare('INSERT OR IGNORE INTO repair_activity_checkpoints(case_id,fingerprint,attempt_id,operation_json,created_at) VALUES(?,?,?,?,?)')
        .run(claim.repairCase.caseId, fingerprint, claim.attempt.attemptId, operation, this.now()).changes === 1;
    }).immediate();
  }

  cacheRuntimeConfiguration(authority: AdminAuthority, input: unknown, expectedRevision: number) {
    const configuration = adminRuntimeConfigurationSchema.parse(input);
    return this.db.transaction(() => {
      this.assertAuthority(authority, true);
      const current = this.runtimeConfiguration();
      if ((current?.revision || 0) !== expectedRevision) throw new Error('管理 Runtime 配置已变化，拒绝迟到配置覆盖');
      if (current && JSON.stringify(current.configuration) === JSON.stringify(configuration)) return current;
      this.db.prepare(`INSERT INTO admin_runtime_configuration(singleton,revision,configuration_json,updated_at) VALUES(1,?,?,?)
        ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,configuration_json=excluded.configuration_json,updated_at=excluded.updated_at`)
        .run(expectedRevision + 1, JSON.stringify(configuration), this.now());
      return this.runtimeConfiguration()!;
    }).immediate();
  }

  intentCommand(requestId:string) {
    return this.db.prepare('SELECT action,revision FROM admin_intent_commands WHERE request_id=?').get(requestId) as {action:string;revision:number}|undefined;
  }

  setIntent(intent: 'running' | 'stopped', requestId: string) {
    if (!requestId.trim()) throw new Error('管理意图必须有幂等请求标识');
    return this.db.transaction(() => {
      const prior = this.db.prepare('SELECT action, revision FROM admin_intent_commands WHERE request_id = ?').get(requestId) as { action: string; revision: number } | undefined;
      if (prior) {
        if (prior.action !== intent) throw new Error('同一请求不能修改管理意图');
        return prior.revision;
      }
      const revision = this.control().intent_revision + 1;
      this.db.prepare('UPDATE admin_control SET desired_intent = ?, intent_revision = ? WHERE singleton = 1').run(intent, revision);
      this.db.prepare('INSERT INTO admin_intent_commands(request_id,action,revision) VALUES(?,?,?)').run(requestId, intent, revision);
      return revision;
    }).immediate();
  }

  initializeIntentFromBusiness(intent: 'running' | 'stopped') {
    return this.db.transaction(() => {
      // One-time migration only. A concurrent user stop wins even if the
      // business read began before the stop or the business DB was stale.
      if (this.control().intent_revision !== 0) return false;
      this.setIntent(intent, 'initial-business-intent');
      return true;
    }).immediate();
  }

  setUpdateSilence(suspended: boolean, requestId: string) {
    if (!requestId.trim()) throw new Error('管理更新静默必须有幂等请求标识');
    return this.db.transaction(() => {
      if (!suspended && this.activeRuntimeUpdate()) throw new Error('外部运行版本更新未完成，普通宿主不能解除静默');
      if (!suspended && this.activePublisherUpdate()) throw new Error('发行更新尚未确认或取消，不能直接解除静默');
      const action = suspended ? 'update-silence' : 'resume-after-update';
      const prior = this.db.prepare('SELECT action,revision FROM admin_intent_commands WHERE request_id = ?').get(requestId) as
        { action: string; revision: number } | undefined;
      if (prior) {
        if (prior.action !== action) throw new Error('同一请求不能修改管理更新意图');
        return prior.revision;
      }
      const control = this.control();
      const mode = suspended ? 'update-silence' : 'normal';
      const revision = control.intent_revision + (control.management_mode === mode ? 0 : 1);
      this.db.prepare('UPDATE admin_control SET management_mode=?,intent_revision=? WHERE singleton=1').run(mode, revision);
      this.db.prepare('INSERT INTO admin_intent_commands(request_id,action,revision) VALUES(?,?,?)').run(requestId, action, revision);
      return revision;
    }).immediate();
  }

  publisherUpdate(requestId:string):PublisherUpdate|null {
    const row=this.db.prepare('SELECT record_json FROM admin_publisher_updates WHERE request_id=?').get(requestId) as {record_json:string}|undefined;
    return row?publisherUpdateSchema.parse(JSON.parse(row.record_json)):null;
  }

  activePublisherUpdate():PublisherUpdate|null {
    const row=this.db.prepare("SELECT request_id FROM admin_publisher_updates WHERE json_extract(record_json,'$.status') IN ('preparing','ready') LIMIT 1").get() as {request_id:string}|undefined;
    return row?this.publisherUpdate(row.request_id):null;
  }

  preparePublisherUpdate(authority:RuntimeHostAuthority,requestId:string,attemptId:string,targetVersion:string) {
    return this.db.transaction(()=>{
      this.assertRuntimeHost(authority);
      const prior=this.publisherUpdate(requestId);
      if(prior){if(prior.attemptId!==attemptId||prior.targetVersion!==targetVersion)throw new Error('发行更新请求不能变更目标');return prior.intentRevision;}
      if(this.activePublisherUpdate()||this.activeRuntimeUpdate())throw new Error('另一个更新仍在进行');
      const before=this.runtimeInstallation()?.artifact;if(!before)throw new Error('发行更新缺少已验证的当前安装选择');
      if(before.version===targetVersion)throw new Error('发行更新目标不能等于当前业务版本');
      const intentRevision=this.setUpdateSilence(true,requestId);
      const record=publisherUpdateSchema.parse({requestId,attemptId,targetVersion,before,intentRevision,status:'preparing'});
      this.db.prepare('INSERT INTO admin_publisher_updates(request_id,record_json) VALUES(?,?)').run(requestId,JSON.stringify(record));
      return intentRevision;
    }).immediate();
  }

  markPublisherUpdateReady(authority:RuntimeHostAuthority,requestId:string,revision:number) {
    return this.db.transaction(()=>{
      this.assertRuntimeHost(authority);const record=this.publisherUpdate(requestId);if(!record)return;
      if(record.status!=='preparing'&&record.status!=='ready')throw new Error('发行更新已结束');
      const control=this.control();
      if(control.intent_revision!==revision||record.intentRevision!==revision||control.management_mode!=='update-silence'
        ||JSON.stringify(this.runtimeInstallation()?.artifact)!==JSON.stringify(record.before)||this.activeRuntimeUpdate())throw new Error('发行更新准备已失效');
      // The native caller must first certify physical exit; durable unknown
      // allocations remain a barrier even if a process-close callback fired.
      if(this.runtimeHostProcesses().some(row=>row.status!=='exited'||this.runtimeCliProcesses(row.allocationId).some(cli=>cli.status!=='exited'))
        ||this.runtimeUiProcesses().some(row=>row.status!=='exited')||this.liveRuntimeUpdateProcesses().length
        ||this.adminBusinessWorkers(true).length||this.attempts().some(row=>['launching','running'].includes(row.status)))throw new Error('发行更新仍有未退出进程屏障');
      this.db.prepare('UPDATE admin_publisher_updates SET record_json=? WHERE request_id=?').run(JSON.stringify({...record,status:'ready'}),requestId);
    }).immediate();
  }

  cancelPublisherUpdate(authority:RuntimeHostAuthority) {
    return this.db.transaction(()=>{
      this.assertRuntimeHost(authority);const record=this.activePublisherUpdate();if(!record)return;
      if(this.activeRuntimeUpdate())throw new Error('已启动版本切换，不能通过普通恢复取消');
      this.db.prepare('UPDATE admin_publisher_updates SET record_json=? WHERE request_id=?').run(JSON.stringify({...record,status:'aborted'}),record.requestId);
    }).immediate();
  }

  beginPublisherInstallation(authority:RuntimeHostAuthority,bootstrap:RuntimeArtifact) {
    const candidate=runtimeArtifactSchema.parse(bootstrap);
    return this.db.transaction(()=>{
      this.assertRuntimeHost(authority);const record=this.activePublisherUpdate();if(!record||this.activeRuntimeUpdate())return null;
      const control=this.control();
      if(control.intent_revision!==record.intentRevision){
        // A user stop wins across installer/root restarts; never restore the
        // previous running intent in order to finish an obsolete update.
        this.cancelPublisherUpdate(authority);this.setUpdateSilence(false,`publisher:${record.requestId}:obsolete`);return null;
      }
      if(record.status!=='ready'||control.management_mode!=='update-silence'||candidate.version!==record.targetVersion)return null;
      if(JSON.stringify(this.runtimeHostArtifact(authority))!==JSON.stringify(candidate))throw new Error('发行更新候选必须是本 root 已校验绑定的实际安装');
      if(JSON.stringify(this.runtimeInstallation()?.artifact)!==JSON.stringify(record.before))throw new Error('发行更新当前安装选择发生变化');
      const update=this.beginRuntimeUpdate({updateId:`publisher-${createHash('sha256').update(record.attemptId).digest('hex')}`,
        caseId:`publisher:${createHash('sha256').update(record.requestId).digest('hex')}`,before:record.before,candidate});
      this.db.prepare('UPDATE admin_publisher_updates SET record_json=? WHERE request_id=?').run(JSON.stringify({...record,status:'transitioned'}),record.requestId);
      return update;
    }).immediate();
  }

  /** A manually launched installer has no persisted prepare-update receipt.
   * Treat its verified, root-bound bootstrap as a normal guarded RuntimeUpdate
   * instead of silently continuing to run the previously selected artifact.
   * The update controller still owns process draining, live-data compatibility,
   * held startup, health observation and rollback. */
  beginInstalledBootstrapTransition(authority:RuntimeHostAuthority,bootstrap:RuntimeArtifact) {
    const candidate=runtimeArtifactSchema.parse(bootstrap);
    return this.db.transaction(()=>{
      this.assertRuntimeHost(authority);
      if(this.activePublisherUpdate()||this.activeRuntimeUpdate())return null;
      const installation=this.runtimeInstallation();
      if(!installation||JSON.stringify(installation.artifact)===JSON.stringify(candidate))return null;
      if(JSON.stringify(this.runtimeHostArtifact(authority))!==JSON.stringify(candidate))throw new Error('直接安装候选必须是本 root 已校验绑定的实际安装');
      const transitionHash=createHash('sha256').update(JSON.stringify([
        installation.artifact.artifactId,candidate.artifactId,
      ])).digest('hex');
      const updateId=`installer-${transitionHash}`;
      // A terminal rejection is durable compatibility evidence. Reinstalling
      // identical bytes must not create a startup retry loop; a new release
      // has a new artifact identity and therefore a new transaction.
      if(this.runtimeUpdate(updateId))return null;
      const update=this.beginRuntimeUpdate({
        updateId,
        caseId:`installer:${transitionHash}`,
        before:installation.artifact,
        candidate,
      });
      this.db.prepare('INSERT INTO admin_runtime_update_events(update_id,phase,detail,created_at) VALUES(?,?,?,?)')
        .run(update.request.updateId,update.phase,'Verified packaged bootstrap differs from persisted installation; guarded transition started',this.now());
      return update;
    }).immediate();
  }

  runtimeUpdate(updateId: string): RuntimeUpdateRecord | null {
    const row = this.db.prepare('SELECT * FROM admin_runtime_updates WHERE update_id=?').get(updateId) as
      { request_json: string; phase: string; selected_json: string; intent_revision: number; owner_id: string | null;
        token: number; expires_at: number; failure: string | null; created_at: number; updated_at: number } | undefined;
    if (!row) return null;
    const rollback = this.db.prepare('SELECT source_update_id,artifact_json FROM admin_runtime_rollback_targets WHERE update_id=?').get(updateId) as
      { source_update_id: string; artifact_json: string } | undefined;
    return { request: runtimeUpdateRequestSchema.parse(JSON.parse(row.request_json)), phase: runtimeUpdatePhaseSchema.parse(row.phase),
      ...(rollback ? { rollback: { artifact: runtimeArtifactSchema.parse(JSON.parse(rollback.artifact_json)), sourceUpdateId: rollback.source_update_id } } : {}),
      selected: runtimeArtifactSchema.parse(JSON.parse(row.selected_json)), intentRevision: row.intent_revision,
      ownerId: row.owner_id, token: row.token, expiresAt: row.expires_at, failure: row.failure, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  activeRuntimeUpdate(): RuntimeUpdateRecord | null {
    const row = this.db.prepare("SELECT update_id FROM admin_runtime_updates WHERE phase NOT IN ('succeeded','rolled-back','aborted') LIMIT 1").get() as { update_id: string } | undefined;
    return row ? this.runtimeUpdate(row.update_id) : null;
  }

  /** Native-only candidates backed by a completed held-start transaction.
   * Historical health does not waive fresh byte/live-data/startup validation. */
  runtimeRollbackCandidates(updateId: string) {
    const current = this.runtimeUpdate(updateId);
    if (!current) throw new Error('更新不存在');
    const rows = this.db.prepare(`SELECT update_id FROM admin_runtime_updates
      WHERE phase IN ('succeeded','rolled-back') AND update_id<>? ORDER BY updated_at DESC,rowid DESC`).all(updateId) as {update_id:string}[];
    return rows.flatMap(row => {
      const source = this.runtimeUpdate(row.update_id)!;
      const artifact = source.selected;
      if (artifact.root === current.request.before.root || artifact.root === current.request.candidate.root) return [];
      const process = this.runtimeUpdateProcesses(row.update_id).find(record =>
        JSON.stringify(record.artifact) === JSON.stringify(artifact) && record.pid && record.marker && ['activated','exited'].includes(record.status));
      return process ? [{ artifact, sourceUpdateId: row.update_id }] : [];
    });
  }

  bindRuntimeRollbackTarget(authority: RuntimeUpdateAuthority, sourceUpdateId: string, reason: string) {
    return this.db.transaction(() => {
      const current = this.assertRuntimeUpdate(authority);
      if (!['stopping','rolling-back'].includes(current.phase)) throw new Error('启动后不能替换回滚目标');
      if (current.rollback) {
        if (current.rollback.sourceUpdateId !== sourceUpdateId) throw new Error('回滚目标已固定');
        return current;
      }
      const candidate = this.runtimeRollbackCandidates(authority.updateId).find(row => row.sourceUpdateId === sourceUpdateId);
      if (!candidate) throw new Error('回滚目标没有历史持有式启动证据');
      this.db.prepare('INSERT INTO admin_runtime_rollback_targets(update_id,source_update_id,artifact_json,created_at) VALUES(?,?,?,?)')
        .run(authority.updateId,sourceUpdateId,JSON.stringify(candidate.artifact),this.now());
      this.db.prepare('INSERT INTO admin_runtime_update_events(update_id,phase,detail,created_at) VALUES(?,?,?,?)')
        .run(authority.updateId,current.phase,`Original installation unavailable; retained rollback startup receipt ${sourceUpdateId}: ${reason.slice(0,15000)}`,this.now());
      return this.runtimeUpdate(authority.updateId)!;
    }).immediate();
  }

  beginRuntimeUpdate(raw: RuntimeUpdateRequest) {
    runtimeUpdateIdSchema.parse(raw.updateId);
    const request = runtimeUpdateRequestSchema.parse(raw);
    return this.db.transaction(() => {
      const prior = this.runtimeUpdate(request.updateId);
      if (prior) {
        if (JSON.stringify(prior.request) !== JSON.stringify(request)) throw new Error('更新请求标识不能复用到不同产物');
        return prior;
      }
      if (this.activeRuntimeUpdate()) throw new Error('另一个运行版本更新仍在进行');
      const installation=this.runtimeInstallation();
      if(installation&&JSON.stringify(installation.artifact)!==JSON.stringify(request.before))throw new Error('更新的已知版本不匹配当前持久化安装选择');
      this.initializeRuntimeInstallation(request.before);
      const revision = this.setUpdateSilence(true, `external-update:${request.updateId}:silence`);
      this.db.prepare(`INSERT INTO admin_runtime_updates(update_id,request_json,phase,selected_json,intent_revision,created_at,updated_at)
        VALUES(?,?,'stopping',?,?,?,?)`).run(request.updateId, JSON.stringify(request), JSON.stringify(request.before), revision, this.now(), this.now());
      this.db.prepare("INSERT INTO admin_runtime_update_events(update_id,phase,detail,created_at) VALUES(?,'stopping','External update requested',?)").run(request.updateId,this.now());
      return this.runtimeUpdate(request.updateId)!;
    }).immediate();
  }

  acquireRuntimeUpdate(updateId: string, ownerId: string, leaseMs = 30000): RuntimeUpdateAuthority | null {
    if (!ownerId.trim() || !Number.isFinite(leaseMs) || leaseMs < 1000) throw new Error('无效外部更新租约');
    return this.db.transaction(() => {
      const current = this.runtimeUpdate(updateId); const now = this.now();
      if (!current || runtimeUpdateTerminal(current.phase) || current.ownerId !== ownerId && current.expiresAt > now) return null;
      const token = current.ownerId === ownerId && current.expiresAt > now ? current.token : current.token + 1;
      this.db.prepare('UPDATE admin_runtime_updates SET owner_id=?,token=?,expires_at=? WHERE update_id=?').run(ownerId,token,now+leaseMs,updateId);
      return { updateId, ownerId, token };
    }).immediate();
  }

  /** Native caller must drain physical writers and validate before against
   * current live data first. Keep the rejected legacy transaction immutable;
   * replace it atomically, so there is never an ordinary admission window. */
  reissueLegacyRuntimeUpdate(authority: RuntimeUpdateAuthority) {
    return this.db.transaction(() => {
      const current = this.assertRuntimeUpdate(authority);
      if (runtimeUpdateIdSchema.safeParse(current.request.updateId).success) throw new Error('合法更新请求不能作为旧协议重发');
      if (this.runtimeHostProcesses().some(row => row.status !== 'exited' || this.runtimeCliProcesses(row.allocationId).some(cli => cli.status !== 'exited'))
        || this.runtimeUiProcesses().some(row => row.status !== 'exited') || this.liveRuntimeUpdateProcesses().length
        || this.adminBusinessWorkers(true).length || this.attempts().some(row => ['launching','running'].includes(row.status))) {
        throw new Error('旧协议更新仍有未退出进程屏障');
      }
      const updateId = `recovery-${createHash('sha256').update(JSON.stringify(current.request)).digest('hex')}`;
      const reason = `Legacy host-incompatible update ID; retained and reissued as ${updateId}`;
      this.advanceRuntimeUpdate(authority, current.phase, 'aborted', { selected: current.request.before });
      this.db.prepare('INSERT INTO admin_runtime_update_events(update_id,phase,detail,created_at) VALUES(?,?,?,?)')
        .run(authority.updateId, 'aborted', reason, this.now());
      const replacement = this.beginRuntimeUpdate({ ...current.request, updateId });
      this.db.prepare('INSERT INTO admin_runtime_update_events(update_id,phase,detail,created_at) VALUES(?,?,?,?)')
        .run(updateId, replacement.phase, `Reissued retained transaction ${current.request.updateId}`, this.now());
      return replacement;
    }).immediate();
  }

  recordRuntimeUpdateResample(authority: RuntimeUpdateAuthority, reason: string) {
    return this.db.transaction(() => {
      const current = this.assertRuntimeUpdate(authority);
      this.db.prepare('INSERT INTO admin_runtime_update_events(update_id,phase,detail,created_at) VALUES(?,?,?,?)')
        .run(authority.updateId, current.phase, `Compatibility snapshot invalidated; resample required: ${reason.slice(0,15000)}`, this.now());
      return current;
    }).immediate();
  }

  renewRuntimeUpdate(authority: RuntimeUpdateAuthority, leaseMs = 30000) {
    if (!Number.isFinite(leaseMs) || leaseMs < 1000) throw new Error('无效外部更新租约');
    return this.db.prepare(`UPDATE admin_runtime_updates SET expires_at=? WHERE update_id=? AND owner_id=? AND token=? AND expires_at>?
      AND phase NOT IN ('succeeded','rolled-back','aborted')`).run(this.now()+leaseMs,authority.updateId,authority.ownerId,authority.token,this.now()).changes === 1;
  }

  assertRuntimeUpdate(authority: RuntimeUpdateAuthority, requireIntent = true) {
    const current = this.runtimeUpdate(authority.updateId);
    if (!current || current.ownerId !== authority.ownerId || current.token !== authority.token || current.expiresAt <= this.now() || runtimeUpdateTerminal(current.phase)) throw new Error('外部更新所有权已经失效');
    if (requireIntent && this.control().intent_revision !== current.intentRevision) throw new Error('用户运行意图已经变化，停止版本更新推进');
    return current;
  }

  advanceRuntimeUpdate(authority: RuntimeUpdateAuthority, expected: RuntimeUpdatePhase, phase: RuntimeUpdatePhase,
    options: { selected?: RuntimeArtifact; failure?: string; permitChangedIntent?: boolean } = {}) {
    runtimeUpdatePhaseSchema.parse(phase);
    const selected = options.selected && runtimeArtifactSchema.parse(options.selected);
    return this.db.transaction(() => {
      const current = this.assertRuntimeUpdate(authority, !options.permitChangedIntent);
      if (current.phase !== expected) throw new Error('运行版本更新阶段已变化，拒绝迟到推进');
      if (!runtimeUpdateTransitions[expected].includes(phase) || options.permitChangedIntent && phase !== 'aborted') throw new Error('无效运行版本更新阶段迁移');
      if (selected && ![current.request.before,current.request.candidate,runtimeRollbackTarget(current)].some(artifact => JSON.stringify(selected) === JSON.stringify(artifact))) throw new Error('不能切换到更新请求以外的产物');
      const nextSelected = selected || current.selected;
      const expectedArtifact = ['candidate-observing','succeeded'].includes(phase) ? current.request.candidate
        : phase === 'aborted' ? current.request.before
        : ['known-good-starting','known-good-activating','known-good-observing','rolled-back'].includes(phase) ? runtimeRollbackTarget(current) : null;
      if (expectedArtifact && JSON.stringify(nextSelected) !== JSON.stringify(expectedArtifact)) throw new Error('更新阶段与选择的实际产物不一致');
      this.db.prepare('UPDATE admin_runtime_updates SET phase=?,selected_json=?,failure=?,updated_at=? WHERE update_id=?')
        .run(phase,JSON.stringify(selected || current.selected),options.failure?.slice(0,16000) || current.failure,this.now(),authority.updateId);
      this.db.prepare('INSERT INTO admin_runtime_update_events(update_id,phase,detail,created_at) VALUES(?,?,?,?)')
        .run(authority.updateId,phase,options.failure?.slice(0,16000) || null,this.now());
      if (runtimeUpdateTerminal(phase)) {
        // Persist selection in the SAME transaction as guard release. No
        // ordinary restart or late replay can restore an old bootstrap root.
        const changed=this.db.prepare('UPDATE admin_runtime_installation SET artifact_json=?,revision=revision+1,update_id=? WHERE singleton=1 AND artifact_json=?')
          .run(JSON.stringify(nextSelected),authority.updateId,JSON.stringify(current.request.before)).changes;
        if(changed!==1)throw new Error('安装选择已经变化，拒绝更新事务提交');
        // Only the fenced external transaction may release this guard. Do
        // not overwrite desired_intent or restore a stale pre-update start.
        this.setUpdateSilence(false, `external-update:${authority.updateId}:${phase}:resume`);
        this.db.prepare('UPDATE admin_runtime_updates SET owner_id=NULL,expires_at=0 WHERE update_id=?').run(authority.updateId);
      }
      return this.runtimeUpdate(authority.updateId)!;
    }).immediate();
  }

  runtimeUpdateEvents(updateId: string, limit = 100, afterEventId = 0) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(afterEventId) || afterEventId < 0) throw new Error('无效更新历史分页');
    return this.db.prepare('SELECT event_id,phase,detail,created_at FROM admin_runtime_update_events WHERE update_id=? AND event_id>? ORDER BY event_id LIMIT ?')
      .all(updateId,afterEventId,limit) as { event_id: number; phase: RuntimeUpdatePhase; detail: string | null; created_at: number }[];
  }

  runtimeInstallation():RuntimeInstallation|null {
    const row=this.db.prepare('SELECT artifact_json,revision,update_id FROM admin_runtime_installation WHERE singleton=1').get() as
      {artifact_json:string;revision:number;update_id:string|null}|undefined;
    return row?{artifact:runtimeArtifactSchema.parse(JSON.parse(row.artifact_json)),revision:row.revision,updateId:row.update_id}:null;
  }

  initializeRuntimeInstallation(artifact:RuntimeArtifact) {
    const parsed=runtimeArtifactSchema.parse(artifact);
    return this.db.transaction(()=>{
      const current=this.runtimeInstallation();
      if(current) {
        if(JSON.stringify(current.artifact)!==JSON.stringify(parsed))throw new Error('普通宿主不能覆盖已有安装选择');
        return current;
      }
      const pending=this.activeRuntimeUpdate();
      if(pending&&JSON.stringify(pending.request.before)!==JSON.stringify(parsed))throw new Error('初始化选择与活动更新的已知版本不符');
      this.db.prepare('INSERT INTO admin_runtime_installation(singleton,artifact_json,revision) VALUES(1,?,1)').run(JSON.stringify(parsed));
      return this.runtimeInstallation()!;
    }).immediate();
  }

  acquireRuntimeHost(ownerId:string,leaseMs=30000):RuntimeHostAuthority|null {
    if(!ownerId.trim()||!Number.isFinite(leaseMs)||leaseMs<1000)throw new Error('无效外部宿主租约');
    return this.db.transaction(()=>{
      const row=this.db.prepare('SELECT owner_id,token,expires_at FROM admin_runtime_host_lease WHERE singleton=1').get() as {owner_id:string|null;token:number;expires_at:number};
      const now=this.now();if(row.owner_id!==ownerId&&row.expires_at>now)return null;
      const token=row.owner_id===ownerId&&row.expires_at>now?row.token:row.token+1;
      this.db.prepare('UPDATE admin_runtime_host_lease SET owner_id=?,token=?,expires_at=? WHERE singleton=1').run(ownerId,token,now+leaseMs);
      return {ownerId,token};
    }).immediate();
  }

  isRuntimeHostCurrent(authority:RuntimeHostAuthority) {
    const row=this.db.prepare('SELECT owner_id,token,expires_at FROM admin_runtime_host_lease WHERE singleton=1').get() as {owner_id:string|null;token:number;expires_at:number};
    return !!row&&row.owner_id===authority.ownerId&&row.token===authority.token&&row.expires_at>this.now();
  }

  assertRuntimeHost(authority:RuntimeHostAuthority) {
    if(!this.isRuntimeHostCurrent(authority))throw new Error('外部宿主所有权已经失效');
  }

  runtimeHostAuthority(ownerId:string):RuntimeHostAuthority {
    const row=this.db.prepare('SELECT owner_id,token FROM admin_runtime_host_lease WHERE singleton=1').get() as {owner_id:string;token:number};
    if(row.owner_id!==ownerId)throw new Error('当前进程不是外部 root 所有者');
    const authority={ownerId,token:row.token};this.assertRuntimeHost(authority);return authority;
  }

  adminBusinessWorkers(liveOnly=false):AdminBusinessWorkerRecord[] {
    const rows=this.db.prepare(`SELECT allocation_id AS allocationId,root_authority_json,management_authority_json,
      intent_revision AS intentRevision,artifact_json,operation,parent_pid AS parentPid,pid,marker,group_id AS groupId,status
      FROM ${allWorkerTables} ${liveOnly?"WHERE status<>'exited'":''} ORDER BY ledger_order,allocation_id`).all() as Array<AdminBusinessWorkerRecord&{
        root_authority_json:string;management_authority_json:string;artifact_json:string}>;
    return rows.map(({root_authority_json,management_authority_json,artifact_json,...row})=>({...row,
      rootAuthority:JSON.parse(root_authority_json),managementAuthority:JSON.parse(management_authority_json),artifact:runtimeArtifactSchema.parse(JSON.parse(artifact_json))}));
  }

  adminBusinessWorker(allocationId:string):AdminBusinessWorkerRecord|null {
    const row=this.db.prepare(`SELECT allocation_id AS allocationId,root_authority_json,management_authority_json,
      intent_revision AS intentRevision,artifact_json,operation,parent_pid AS parentPid,pid,marker,group_id AS groupId,status
      FROM ${allWorkerTables} WHERE allocation_id=?`).get(allocationId) as (AdminBusinessWorkerRecord&{
        root_authority_json:string;management_authority_json:string;artifact_json:string})|undefined;
    if(!row)return null;
    const {root_authority_json,management_authority_json,artifact_json,...record}=row;
    return {...record,rootAuthority:JSON.parse(root_authority_json),managementAuthority:JSON.parse(management_authority_json),artifact:runtimeArtifactSchema.parse(JSON.parse(artifact_json))};
  }

  assertAdminBusinessWorker(record:AdminBusinessWorkerRecord) {
    this.assertRuntimeHost(record.rootAuthority);const audit=record.operation==='host-audit';
    const baseline=record.operation==='runtime-business-baseline';const control=this.assertAuthority(record.managementAuthority,!audit&&!baseline);
    if(record.status==='exited'||record.managementAuthority.ownerId!==`${record.rootAuthority.ownerId}:management`
      ||control.intent_revision!==record.intentRevision||!audit&&!baseline&&this.activeRuntimeUpdate()
      ||baseline&&(control.desired_intent!=='running'||control.management_mode!=='update-silence'||this.activeRuntimeUpdate()?.phase!=='stopping'))
      throw new Error('独立业务能力 worker 的运行意图或所有权已改变');
    const rootBound=audit||baseline||record.operation==='harness-actions'||record.operation==='harness-build'||record.operation==='assert-runtime'||record.operation==='runtime-business-progress';
    const expected=rootBound?this.runtimeHostArtifact(record.rootAuthority):this.runtimeInstallation()?.artifact;
    if(rootBound&&!expected||expected&&JSON.stringify(expected)!==JSON.stringify(record.artifact))throw new Error('独立业务能力 worker 的实际安装已改变');
  }

  /** Immutable code identity of the stable root, separate from its selected
   * business installation. Read-only root diagnostics survive code rollback. */
  bindRuntimeHostArtifact(authority:RuntimeHostAuthority,artifact:RuntimeArtifact) {
    const parsed=runtimeArtifactSchema.parse(artifact);
    if(resolve(parsed.root)!==resolve(join(dirname(this.filename),'runtime-artifacts',parsed.artifactId)))throw new Error('root 能力必须绑定内容寻址的独立安装');
    return this.db.transaction(()=>{
      this.assertRuntimeHost(authority);
      const prior=this.runtimeHostArtifact(authority);
      if(prior&&JSON.stringify(prior)!==JSON.stringify(parsed))throw new Error('同一 root 代次不能替换能力代码');
      this.db.prepare('INSERT OR IGNORE INTO admin_runtime_root_artifacts(owner_id,token,artifact_json) VALUES(?,?,?)')
        .run(authority.ownerId,authority.token,JSON.stringify(parsed));
    }).immediate();
  }

  runtimeHostArtifact(authority:RuntimeHostAuthority):RuntimeArtifact|null {
    this.assertRuntimeHost(authority);
    const row=this.db.prepare('SELECT artifact_json FROM admin_runtime_root_artifacts WHERE owner_id=? AND token=?')
      .get(authority.ownerId,authority.token) as {artifact_json:string}|undefined;
    return row?runtimeArtifactSchema.parse(JSON.parse(row.artifact_json)):null;
  }

  /** Bounded prior root bindings, never a scan of arbitrary cache directories.
   * Callers must revalidate installed bytes and content-addressed placement. */
  runtimeBootstrapCandidates(onError?:(error:unknown)=>void):RuntimeArtifact[] {
    const rows=this.db.prepare('SELECT artifact_json FROM admin_runtime_root_artifacts GROUP BY artifact_json ORDER BY MAX(rowid) DESC LIMIT 8').all() as {artifact_json:string}[];
    return rows.flatMap(row=>{
      try{return [runtimeArtifactSchema.parse(JSON.parse(row.artifact_json))];}
      catch(error){try{onError?.(error);}catch{/* diagnostic sink cannot hide the next candidate */}return [];}
    });
  }

  reserveAdminBusinessWorker(rootAuthority:RuntimeHostAuthority,managementAuthority:AdminAuthority,
    artifact:RuntimeArtifact,request:AdminBusinessRequest):AdminBusinessWorkerRecord {
    adminBusinessRequestSchema.parse(request);
    return this.db.transaction(()=>{
      const record:AdminBusinessWorkerRecord={allocationId:randomUUID(),rootAuthority,managementAuthority,
        intentRevision:this.control().intent_revision,artifact:runtimeArtifactSchema.parse(artifact),operation:request.operation,
        parentPid:process.pid,pid:null,marker:null,groupId:null,status:'launching'};
      this.assertAdminBusinessWorker(record);
      for(const old of this.adminBusinessWorkers(true)){
        if(!parallelAdminWorker(old,request.operation,rootAuthority,managementAuthority,record.intentRevision))throw new Error('旧独立业务能力 worker 退出未确认');
        this.assertAdminBusinessWorker(old);
      }
      this.db.prepare(`INSERT INTO ${workerTable(record.operation)}(allocation_id,root_authority_json,management_authority_json,
        intent_revision,artifact_json,operation,parent_pid,status) VALUES(?,?,?,?,?,?,?,'launching')`)
        .run(record.allocationId,JSON.stringify(rootAuthority),JSON.stringify(managementAuthority),record.intentRevision,
          JSON.stringify(record.artifact),record.operation,record.parentPid);
      return record;
    }).immediate();
  }

  bindAdminBusinessWorker(record:AdminBusinessWorkerRecord,pid:number,marker?:string,groupId?:number) {
    if(!Number.isSafeInteger(pid)||pid<1||marker!==undefined&&!marker.trim()||groupId!==undefined&&(!Number.isSafeInteger(groupId)||groupId<1))throw new Error('业务能力 worker 实际身份无效');
    return this.db.transaction(()=>{
      const current=this.adminBusinessWorker(record.allocationId);
      if(!current||current.status==='exited'||current.pid!==null&&current.pid!==pid||current.marker!==null&&marker!==undefined&&current.marker!==marker
        ||current.groupId!==null&&groupId!==undefined&&current.groupId!==groupId)throw new Error('迟到 worker 身份不能覆盖原分配');
      // Captured identity must survive fencing so the actual child can still
      // be cleaned. Attaching identity is not permission to execute a request.
      this.db.prepare(`UPDATE ${workerTable(record.operation)} SET pid=?,marker=COALESCE(marker,?),group_id=COALESCE(group_id,?),
        status=CASE WHEN COALESCE(marker,?) IS NULL THEN 'launching' ELSE 'bound' END WHERE allocation_id=?`)
        .run(pid,marker??null,groupId??null,marker??null,record.allocationId);
    }).immediate();
  }

  confirmAdminBusinessWorkerExit(record:AdminBusinessWorkerRecord) {
    const changed=this.db.prepare(`UPDATE ${workerTable(record.operation)} SET status='exited' WHERE allocation_id=?
      AND root_authority_json=? AND management_authority_json=? AND pid IS ? AND marker IS ? AND group_id IS ?`)
      .run(record.allocationId,JSON.stringify(record.rootAuthority),JSON.stringify(record.managementAuthority),record.pid,record.marker,record.groupId).changes;
    if(changed!==1)throw new Error('业务能力 worker 实际退出证据与分配不匹配');
  }

  renewRuntimeHost(authority:RuntimeHostAuthority,leaseMs=30000) {
    if(!Number.isFinite(leaseMs)||leaseMs<1000)throw new Error('无效外部宿主租约');
    return this.db.prepare('UPDATE admin_runtime_host_lease SET expires_at=? WHERE singleton=1 AND owner_id=? AND token=? AND expires_at>?')
      .run(this.now()+leaseMs,authority.ownerId,authority.token,this.now()).changes===1;
  }

  releaseRuntimeHost(authority:RuntimeHostAuthority) {
    return this.db.prepare('UPDATE admin_runtime_host_lease SET owner_id=NULL,expires_at=0 WHERE singleton=1 AND owner_id=? AND token=?')
      .run(authority.ownerId,authority.token).changes===1;
  }

  runtimeHostProcesses():RuntimeHostProcess[] {
    const rows=this.db.prepare('SELECT * FROM admin_runtime_host_processes ORDER BY rowid').all() as
      {allocation_id:string;owner_id:string;token:number;artifact_json:string;status:RuntimeHostProcess['status'];pid:number|null;marker:string|null;group_id:number|null;parent_pid:number;business_supervision_token:number|null}[];
    return rows.map(row=>({allocationId:row.allocation_id,authority:{ownerId:row.owner_id,token:row.token},
      artifact:runtimeArtifactSchema.parse(JSON.parse(row.artifact_json)),status:row.status,pid:row.pid,marker:row.marker,groupId:row.group_id,parentPid:row.parent_pid,businessSupervisionToken:row.business_supervision_token}));
  }

  runtimeUiProcesses():RuntimeUiProcess[] {
    const rows=this.db.prepare('SELECT * FROM admin_runtime_ui_processes ORDER BY rowid').all() as
      {allocation_id:string;owner_id:string;token:number;artifact_json:string;status:RuntimeUiProcess['status'];pid:number|null;marker:string|null;group_id:number|null;parent_pid:number}[];
    return rows.map(row=>({allocationId:row.allocation_id,authority:{ownerId:row.owner_id,token:row.token},artifact:runtimeArtifactSchema.parse(JSON.parse(row.artifact_json)),
      status:row.status,pid:row.pid,marker:row.marker,groupId:row.group_id,parentPid:row.parent_pid}));
  }

  reserveRuntimeUiProcess(authority:RuntimeHostAuthority,artifact:RuntimeArtifact):RuntimeUiProcess {
    const parsed=runtimeArtifactSchema.parse(artifact);
    return this.db.transaction(()=>{
      this.assertRuntimeHost(authority);
      if(this.control().management_mode!=='normal'||this.activeRuntimeUpdate()
        ||JSON.stringify(this.runtimeInstallation()?.artifact)!==JSON.stringify(parsed))throw new Error('界面服务安装选择或更新门禁不匹配');
      if(this.runtimeUiProcesses().some(row=>row.status!=='exited'))throw new Error('旧界面服务实际退出未确认');
      const allocationId=randomUUID();
      this.db.prepare("INSERT INTO admin_runtime_ui_processes(allocation_id,owner_id,token,artifact_json,status,parent_pid) VALUES(?,?,?,?,'reserved',?)")
        .run(allocationId,authority.ownerId,authority.token,JSON.stringify(parsed),process.pid);
      return this.runtimeUiProcesses().find(row=>row.allocationId===allocationId)!;
    }).immediate();
  }

  bindRuntimeUiProcess(record:RuntimeUiProcess,pid:number,marker?:string,groupId?:number) {
    if(!Number.isSafeInteger(pid)||pid<=0||marker!==undefined&&!marker.trim()||groupId!==undefined&&groupId!==pid)throw new Error('无效界面服务进程身份');
    const changed=this.db.prepare(`UPDATE admin_runtime_ui_processes SET pid=?,marker=COALESCE(marker,?),group_id=COALESCE(group_id,?),
      status=CASE WHEN status='reserved' THEN 'bound' ELSE status END WHERE allocation_id=? AND owner_id=? AND token=? AND parent_pid=? AND artifact_json=?
      AND status<>'exited' AND (pid IS NULL OR pid=?) AND (marker IS NULL OR ? IS NULL OR marker=?) AND (group_id IS NULL OR ? IS NULL OR group_id=?)`)
      .run(pid,marker??null,groupId??null,record.allocationId,record.authority.ownerId,record.authority.token,record.parentPid,JSON.stringify(record.artifact),
        pid,marker??null,marker??null,groupId??null,groupId??null).changes;
    if(changed!==1)throw new Error('界面服务身份变化，拒绝迟到登记');
  }

  readyRuntimeUiProcess(record:RuntimeUiProcess) {
    return this.db.transaction(()=>{
      this.assertRuntimeHost(record.authority);
      if(this.control().management_mode!=='normal'||this.activeRuntimeUpdate()
        ||JSON.stringify(this.runtimeInstallation()?.artifact)!==JSON.stringify(record.artifact))throw new Error('界面服务启动期间安装选择或更新门禁变化');
      const changed=this.db.prepare(`UPDATE admin_runtime_ui_processes SET status='ready' WHERE allocation_id=? AND owner_id=? AND token=?
        AND pid IS ? AND marker IS ? AND group_id IS ? AND parent_pid=? AND artifact_json=? AND status='bound' AND pid IS NOT NULL AND marker IS NOT NULL`)
        .run(record.allocationId,record.authority.ownerId,record.authority.token,record.pid,record.marker,record.groupId,record.parentPid,JSON.stringify(record.artifact)).changes;
      if(changed!==1)throw new Error('界面服务就绪缺少当前实际进程身份');
    }).immediate();
  }

  confirmRuntimeUiProcessExit(record:RuntimeUiProcess) {
    const changed=this.db.prepare(`UPDATE admin_runtime_ui_processes SET status='exited' WHERE allocation_id=? AND owner_id=? AND token=?
      AND pid IS ? AND marker IS ? AND group_id IS ? AND parent_pid=? AND artifact_json=?`)
      .run(record.allocationId,record.authority.ownerId,record.authority.token,record.pid,record.marker,record.groupId,record.parentPid,JSON.stringify(record.artifact)).changes;
    if(changed!==1)throw new Error('界面服务退出证据不匹配原分配身份');
  }

  /** The actual host certifies this protocol before business imports. A drain
   * is irreversible for this allocation, including late child initialization. */
  certifyRuntimeCliHost(record:RuntimeHostProcess) {
    return this.db.transaction(()=>{
      this.assertRuntimeHost(record.authority);
      const host=this.runtimeHostProcesses().find(row=>row.allocationId===record.allocationId);
      if(!host||host.pid!==process.pid||!host.marker||host.status==='exited'
        ||JSON.stringify(host.artifact)!==JSON.stringify(this.runtimeInstallation()?.artifact)||this.activeRuntimeUpdate())throw new Error('CLI 登记协议必须由当前实际普通宿主初始化');
      const prior=this.db.prepare('SELECT draining FROM admin_runtime_cli_hosts WHERE host_allocation_id=?').get(host.allocationId) as {draining:number}|undefined;
      if(prior?.draining)throw new Error('宿主 CLI 正在排空，不能重新开放');
      this.db.prepare('INSERT INTO admin_runtime_cli_hosts(host_allocation_id,certified) VALUES(?,1) ON CONFLICT(host_allocation_id) DO UPDATE SET certified=1').run(host.allocationId);
    }).immediate();
  }

  beginRuntimeCliDrain(hostAllocationId:string) {
    this.db.prepare(`INSERT INTO admin_runtime_cli_hosts(host_allocation_id,draining) VALUES(?,1)
      ON CONFLICT(host_allocation_id) DO UPDATE SET draining=1`).run(hostAllocationId);
    return (this.db.prepare('SELECT certified FROM admin_runtime_cli_hosts WHERE host_allocation_id=?').get(hostAllocationId) as {certified:number}).certified===1;
  }

  reserveRuntimeCli(hostAllocationId:string,allocationId:string,executionId:string,ownerPid:number) {
    if(!allocationId.trim()||!executionId.trim()||ownerPid!==process.pid)throw new Error('CLI 分配必须绑定当前实际调用进程');
    return this.db.transaction(()=>{
      const host=this.runtimeHostProcesses().find(row=>row.allocationId===hostAllocationId);
      const contract=this.db.prepare('SELECT certified,draining FROM admin_runtime_cli_hosts WHERE host_allocation_id=?').get(hostAllocationId) as {certified:number;draining:number}|undefined;
      if(!host||host.status!=='ready'||!contract?.certified||contract.draining)throw new Error('外部宿主 CLI 分配入口未就绪或正在排空');
      this.assertRuntimeHost(host.authority);
      if(this.control().desired_intent!=='running'||this.control().management_mode!=='normal'||this.activeRuntimeUpdate()
        ||JSON.stringify(host.artifact)!==JSON.stringify(this.runtimeInstallation()?.artifact))throw new Error('外部宿主 CLI 意图、代次或安装选择失效');
      this.db.prepare("INSERT INTO admin_runtime_cli_processes(allocation_id,host_allocation_id,execution_id,owner_pid,status) VALUES(?,?,?,?,'launching')")
        .run(allocationId,hostAllocationId,executionId,ownerPid);
    }).immediate();
  }

  runtimeCliProcesses(hostAllocationId:string):RuntimeCliProcess[] {
    return this.db.prepare(`SELECT allocation_id AS allocationId,host_allocation_id AS hostAllocationId,execution_id AS executionId,
      owner_pid AS ownerPid,pid,marker,group_id AS groupId,status FROM admin_runtime_cli_processes WHERE host_allocation_id=? ORDER BY rowid`)
      .all(hostAllocationId) as RuntimeCliProcess[];
  }

  attachRuntimeCli(allocationId:string,pid:number,marker?:string,groupId?:number) {
    if(!Number.isSafeInteger(pid)||pid<=0||marker!==undefined&&!marker.trim()||groupId!==undefined&&groupId!==pid)throw new Error('无效独立 CLI 进程身份');
    const changed=this.db.prepare(`UPDATE admin_runtime_cli_processes SET pid=?,marker=COALESCE(marker,?),group_id=COALESCE(group_id,?),
      status=CASE WHEN status='launching' AND COALESCE(marker,?) IS NOT NULL THEN 'running' ELSE status END
      WHERE allocation_id=? AND status<>'exited' AND (pid IS NULL OR pid=?)
      AND (marker IS NULL OR ? IS NULL OR marker=?) AND (group_id IS NULL OR ? IS NULL OR group_id=?)`)
      .run(pid,marker||null,groupId||null,marker||null,allocationId,pid,marker||null,marker||null,groupId||null,groupId||null).changes;
    if(changed!==1)throw new Error('独立 CLI 身份变化，拒绝迟到登记');
  }

  finishRuntimeCli(allocationId:string,confirmed:boolean) {
    this.db.prepare("UPDATE admin_runtime_cli_processes SET status=? WHERE allocation_id=? AND status<>'exited'")
      .run(confirmed?'exited':'terminating',allocationId);
  }

  reserveRuntimeHostProcess(authority:RuntimeHostAuthority,artifact:RuntimeArtifact) {
    const parsed=runtimeArtifactSchema.parse(artifact);
    return this.db.transaction(()=>{
      this.assertRuntimeHost(authority);
      if(this.activeRuntimeUpdate()||JSON.stringify(this.runtimeInstallation()?.artifact)!==JSON.stringify(parsed))throw new Error('普通宿主分配与安装选择或更新门禁不匹配');
      const live=this.runtimeHostProcesses().find(row=>row.status!=='exited');
      if(live) {
        if(live.authority.ownerId===authority.ownerId&&live.authority.token===authority.token&&JSON.stringify(live.artifact)===JSON.stringify(parsed))return live;
        throw new Error('旧普通宿主实际退出未确认');
      }
      const allocationId=randomUUID();
      this.db.prepare("INSERT INTO admin_runtime_host_processes(allocation_id,owner_id,token,artifact_json,status,parent_pid) VALUES(?,?,?,?,'reserved',?)")
        .run(allocationId,authority.ownerId,authority.token,JSON.stringify(parsed),process.pid);
      return this.runtimeHostProcesses().find(row=>row.allocationId===allocationId)!;
    }).immediate();
  }

  bindRuntimeHostProcess(record:RuntimeHostProcess,pid:number,marker?:string,groupId?:number) {
    if(!Number.isSafeInteger(pid)||pid<=0||marker!==undefined&&!marker.trim()||groupId!==undefined&&(!Number.isSafeInteger(groupId)||groupId<=0))throw new Error('无效普通宿主进程身份');
    const changed=this.db.prepare(`UPDATE admin_runtime_host_processes SET pid=?,marker=COALESCE(marker,?),group_id=COALESCE(group_id,?),status=CASE WHEN status='reserved' THEN 'bound' ELSE status END
      WHERE allocation_id=? AND owner_id=? AND token=? AND status<>'exited' AND (pid IS NULL OR pid=?)
      AND (marker IS NULL OR ? IS NULL OR marker=?) AND (group_id IS NULL OR ? IS NULL OR group_id=?)`)
      .run(pid,marker||null,groupId||null,record.allocationId,record.authority.ownerId,record.authority.token,pid,marker||null,marker||null,groupId||null,groupId||null).changes;
    if(changed!==1)throw new Error('普通宿主身份变化，拒绝迟到登记');
  }

  bindRuntimeBusinessSupervision(record:RuntimeHostProcess,token:number) {
    if(!Number.isSafeInteger(token)||token<1)throw new Error('普通宿主业务监督代次无效');
    const changed=this.db.prepare(`UPDATE admin_runtime_host_processes SET business_supervision_token=?
      WHERE allocation_id=? AND owner_id=? AND token=? AND pid IS NOT NULL AND status<>'exited'
      AND (business_supervision_token IS NULL OR business_supervision_token=?)`)
      .run(token,record.allocationId,record.authority.ownerId,record.authority.token,token).changes;
    if(changed!==1)throw new Error('普通宿主业务监督代次不能覆盖原分配');
  }

  readyRuntimeHostProcess(authority:RuntimeHostAuthority,allocationId:string,businessSupervisionToken?:number) {
    return this.db.transaction(()=>{
      this.assertRuntimeHost(authority);
      const row=this.runtimeHostProcesses().find(row=>row.allocationId===allocationId);
      if(this.activeRuntimeUpdate()||!row||JSON.stringify(row.artifact)!==JSON.stringify(this.runtimeInstallation()?.artifact))throw new Error('普通宿主启动期间选择或更新门禁变化');
      if(businessSupervisionToken!==undefined)this.bindRuntimeBusinessSupervision(row,businessSupervisionToken);
      const changed=this.db.prepare("UPDATE admin_runtime_host_processes SET status='ready' WHERE allocation_id=? AND owner_id=? AND token=? AND status='bound' AND pid IS NOT NULL AND marker IS NOT NULL")
        .run(allocationId,authority.ownerId,authority.token).changes;
      if(changed!==1)throw new Error('普通宿主启动收据缺少当前进程身份');
    }).immediate();
  }

  confirmRuntimeHostProcessExit(record:RuntimeHostProcess) {
    const changed=this.db.prepare("UPDATE admin_runtime_host_processes SET status='exited' WHERE allocation_id=? AND owner_id=? AND token=? AND pid IS ? AND marker IS ?")
      .run(record.allocationId,record.authority.ownerId,record.authority.token,record.pid,record.marker).changes;
    if(changed!==1)throw new Error('普通宿主退出证据不匹配原分配身份');
  }

  runtimeUpdateProcesses(updateId: string): RuntimeUpdateProcess[] {
    const rows = this.db.prepare('SELECT * FROM admin_runtime_update_processes WHERE update_id=? ORDER BY rowid').all(updateId) as
      {allocation_id:string;update_id:string;owner_id:string;token:number;artifact_json:string;status:RuntimeUpdateProcess['status'];pid:number|null;marker:string|null;group_id:number|null;parent_pid:number}[];
    return rows.map(row=>({allocationId:row.allocation_id,authority:{updateId:row.update_id,ownerId:row.owner_id,token:row.token},
      artifact:runtimeArtifactSchema.parse(JSON.parse(row.artifact_json)),status:row.status,pid:row.pid,marker:row.marker,groupId:row.group_id,parentPid:row.parent_pid}));
  }

  runtimeUpdateProcessAllocation(allocationId:string):RuntimeUpdateProcess|null {
    const row=this.db.prepare('SELECT * FROM admin_runtime_update_processes WHERE allocation_id=?').get(allocationId) as
      {allocation_id:string;update_id:string;owner_id:string;token:number;artifact_json:string;status:RuntimeUpdateProcess['status'];pid:number|null;marker:string|null;group_id:number|null;parent_pid:number}|undefined;
    return row?{allocationId:row.allocation_id,authority:{updateId:row.update_id,ownerId:row.owner_id,token:row.token},
      artifact:runtimeArtifactSchema.parse(JSON.parse(row.artifact_json)),status:row.status,pid:row.pid,marker:row.marker,groupId:row.group_id,parentPid:row.parent_pid}:null;
  }

  liveRuntimeUpdateProcesses():RuntimeUpdateProcess[] {
    const updates=this.db.prepare("SELECT DISTINCT update_id FROM admin_runtime_update_processes WHERE status<>'exited'").all() as {update_id:string}[];
    return updates.flatMap(row=>this.runtimeUpdateProcesses(row.update_id).filter(record=>record.status!=='exited'));
  }

  reserveRuntimeUpdateProcess(authority: RuntimeUpdateAuthority, artifact: RuntimeArtifact) {
    runtimeArtifactSchema.parse(artifact);
    return this.db.transaction(()=>{
      const update = this.assertRuntimeUpdate(authority);
      const expected = update.phase === 'candidate-starting' ? update.request.candidate : update.phase === 'known-good-starting' ? runtimeRollbackTarget(update) : null;
      if (!expected || JSON.stringify(expected)!==JSON.stringify(artifact)) throw new Error('只有当前待启动产物可以分配持有式进程');
      const live = this.runtimeUpdateProcesses(authority.updateId).filter(process=>process.status!=='exited');
      const own = live.find(process=>process.authority.ownerId===authority.ownerId&&process.authority.token===authority.token&&process.artifact.artifactId===artifact.artifactId);
      if (own && live.length===1) return own;
      if (live.length) throw new Error('旧版本进程实际退出未确认，禁止重复启动');
      const allocationId=randomUUID();
      this.db.prepare("INSERT INTO admin_runtime_update_processes(allocation_id,update_id,owner_id,token,artifact_json,status,parent_pid) VALUES(?,?,?,?,?,'reserved',?)")
        .run(allocationId,authority.updateId,authority.ownerId,authority.token,JSON.stringify(artifact),process.pid);
      return this.runtimeUpdateProcesses(authority.updateId).find(process=>process.allocationId===allocationId)!;
    }).immediate();
  }

  bindRuntimeUpdateProcess(process: RuntimeUpdateProcess, pid: number, marker?: string, groupId?: number) {
    if (!Number.isSafeInteger(pid)||pid<=0||marker!==undefined&&!marker.trim()||groupId!==undefined&&(!Number.isSafeInteger(groupId)||groupId<=0)) throw new Error('无效持有式进程身份');
    // Late binding is allowed only to its original immutable allocation, even
    // after fencing. The reservation itself prevents successor reuse while
    // the captured child is being stopped; losing ownership cannot lose PID.
    const changed=this.db.prepare(`UPDATE admin_runtime_update_processes SET status='bound',pid=?,marker=COALESCE(?,marker),group_id=COALESCE(?,group_id)
      WHERE allocation_id=? AND update_id=? AND owner_id=? AND token=? AND status IN ('reserved','bound') AND (pid IS NULL OR pid=?)
        AND (? IS NULL OR marker IS NULL OR marker=?) AND (? IS NULL OR group_id IS NULL OR group_id=?)`)
      .run(pid,marker||null,groupId||null,process.allocationId,process.authority.updateId,process.authority.ownerId,process.authority.token,pid,
        marker||null,marker||null,groupId||null,groupId||null).changes;
    if(changed!==1)throw new Error('持有式进程身份已经变化，拒绝迟到登记');
  }

  advanceRuntimeUpdateProcess(authority: RuntimeUpdateAuthority, allocationId: string, expected: 'bound'|'ready', status: 'ready'|'activated') {
    return this.db.transaction(()=>{
      const update=this.assertRuntimeUpdate(authority);
      const phaseAllowed=status==='ready'&&expected==='bound'&&['candidate-starting','known-good-starting'].includes(update.phase)
        ||status==='activated'&&expected==='ready'&&['candidate-activating','known-good-activating'].includes(update.phase);
      if(!phaseAllowed)throw new Error('持有式进程阶段不能绕过启动或激活门禁');
      const changed=this.db.prepare(`UPDATE admin_runtime_update_processes SET status=? WHERE allocation_id=? AND update_id=? AND owner_id=? AND token=?
        AND status=? AND pid IS NOT NULL AND marker IS NOT NULL`).run(status,allocationId,authority.updateId,authority.ownerId,authority.token,expected).changes;
      if(changed!==1)throw new Error('持有式进程阶段或身份已经变化');
    }).immediate();
  }

  confirmRuntimeUpdateProcessExit(process: RuntimeUpdateProcess) {
    // Caller supplies physical exit proof; this method is not a kill helper.
    const changed=this.db.prepare(`UPDATE admin_runtime_update_processes SET status='exited' WHERE allocation_id=? AND update_id=? AND owner_id=? AND token=?
      AND (pid IS ? OR pid=?) AND (marker IS ? OR marker=?)`).run(process.allocationId,process.authority.updateId,process.authority.ownerId,process.authority.token,
        process.pid,process.pid,process.marker,process.marker).changes;
    if(changed!==1)throw new Error('进程实际退出证据不匹配原分配身份');
  }

  acquireSupervisor(ownerId: string, leaseMs = 30_000): AdminAuthority | null {
    if (!ownerId.trim() || !Number.isFinite(leaseMs) || leaseMs < 1000) throw new Error('无效管理监督租约');
    return this.db.transaction(() => {
      const control = this.control();
      const now = this.now();
      if (control.owner_id !== ownerId && control.expires_at > now) return null;
      const token = control.owner_id === ownerId && control.expires_at > now ? control.fencing_token : control.fencing_token + 1;
      this.db.prepare('UPDATE admin_control SET owner_id = ?, fencing_token = ?, expires_at = ? WHERE singleton = 1').run(ownerId, token, now + leaseMs);
      return { ownerId, token };
    }).immediate();
  }

  renewSupervisor(authority: AdminAuthority, leaseMs = 30_000) {
    if (!Number.isFinite(leaseMs) || leaseMs < 1000) throw new Error('无效管理监督租约');
    return this.db.prepare('UPDATE admin_control SET expires_at = ? WHERE singleton = 1 AND owner_id = ? AND fencing_token = ? AND expires_at > ?')
      .run(this.now() + leaseMs, authority.ownerId, authority.token, this.now()).changes === 1;
  }

  releaseSupervisor(authority: AdminAuthority) {
    // Physical attempts remain fenced even after host ownership is released.
    this.db.prepare('UPDATE admin_control SET owner_id = NULL, expires_at = 0 WHERE singleton = 1 AND owner_id = ? AND fencing_token = ?')
      .run(authority.ownerId, authority.token);
  }

  private assertAuthority(authority: AdminAuthority, running = false) {
    const control = this.control();
    if (control.owner_id !== authority.ownerId || control.fencing_token !== authority.token || control.expires_at <= this.now()
      || (running && (control.desired_intent !== 'running' || control.management_mode !== 'normal'))) throw new Error('Admin 监督权或运行意图已失效');
    return control;
  }

  isAuthorityCurrent(authority: AdminAuthority, running = true) {
    try { this.assertAuthority(authority, running); return true; } catch { return false; }
  }

  observe(input: RepairObservation) {
    const value = observationSchema.parse(input);
    const evidenceJson = JSON.stringify(value.evidence);
    const observationHash = createHash('sha256').update(JSON.stringify(value)).digest('hex');
    // A work-item is one repair ownership cohort. Different failure signatures
    // remain immutable observations/acceptance targets inside that Case.
    const key = createHash('sha256').update(JSON.stringify(value.scope === 'work-item'
      ? [value.scope, value.scopeKey] : [value.scope, value.scopeKey, value.fingerprint])).digest('hex');
    return this.db.transaction(() => {
      const prior = this.db.prepare('SELECT case_id AS caseId,observation_hash AS observationHash FROM repair_observations WHERE observation_id = ?').get(value.observationId) as { caseId: string; observationHash: string } | undefined;
      if (prior) {
        if (prior.observationHash !== observationHash) {
          throw new Error('故障观察标识已绑定其他故障');
        }
        const canonicalCaseId = this.canonicalRepairCaseId(prior.caseId);
        if (canonicalCaseId !== prior.caseId) this.db.prepare('UPDATE repair_observations SET case_id=? WHERE observation_id=?')
          .run(canonicalCaseId, value.observationId);
        const existing = this.getCase(canonicalCaseId)!;
        return existing;
      }
      let repairCase = this.db.prepare('SELECT case_id AS caseId FROM repair_cases WHERE dedupe_key = ?').get(key) as { caseId: string } | undefined;
      if (repairCase) repairCase = { caseId: this.canonicalRepairCaseId(repairCase.caseId) };
      if (!repairCase && value.scope === 'work-item') repairCase = this.db.prepare(`SELECT repair.case_id AS caseId FROM repair_cases repair
        LEFT JOIN repair_case_aliases alias ON alias.alias_case_id=repair.case_id
        WHERE repair.scope='work-item' AND repair.scope_key=? AND alias.alias_case_id IS NULL
        ORDER BY CASE WHEN repair.status='closed' THEN 1 ELSE 0 END,repair.created_at,repair.case_id LIMIT 1`)
        .get(value.scopeKey) as { caseId: string } | undefined;
      if (value.origin === 'admin') {
        if (!value.repairCaseId || !this.getCase(value.repairCaseId)) throw new Error('Admin 自身故障必须关联原修复记录，禁止递归创建 Admin');
        repairCase = { caseId: this.canonicalRepairCaseId(value.repairCaseId) };
      } else if (value.repairCaseId) {
        const explicitCaseId = this.canonicalRepairCaseId(value.repairCaseId);
        const explicit = this.getCase(explicitCaseId);
        if (!explicit || explicit.scope !== value.scope || explicit.scopeKey !== value.scopeKey) {
          throw new Error('观察不能重绑其他修复记录');
        }
        repairCase = { caseId: explicitCaseId };
      }
      if (!repairCase) {
        repairCase = { caseId: `REPAIR-${randomUUID()}` };
        this.db.prepare(`INSERT INTO repair_cases(case_id,dedupe_key,scope,scope_key,fingerprint,original_version,original_summary,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(repairCase.caseId, key, value.scope, value.scopeKey, value.fingerprint, value.sourceVersion, value.summary, this.now(), this.now());
        this.db.prepare('INSERT INTO repair_schedule_queue(case_id) VALUES(?)').run(repairCase.caseId);
      } else {
        this.db.prepare("UPDATE repair_cases SET status = CASE WHEN status IN ('closed','verifying','observing') AND ? <> 'admin' THEN 'queued' ELSE status END, updated_at = ? WHERE case_id = ?")
          .run(value.origin, this.now(), repairCase.caseId);
        this.db.prepare('INSERT OR IGNORE INTO repair_schedule_queue(case_id) VALUES(?)').run(repairCase.caseId);
      }
      this.db.prepare('INSERT INTO repair_observations(observation_id,case_id,origin,source_version,summary,evidence_json,observation_hash,observation_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(value.observationId, repairCase.caseId, value.origin, value.sourceVersion, value.summary, evidenceJson, observationHash, JSON.stringify(value), this.now());
      return this.getCase(repairCase.caseId)!;
    }).immediate();
  }

  /** Stop/fence can race a caller's pre-check. Guard the external startup
   * observation in the same management transaction as its persistence. */
  observeExternalRuntimeFailure(authority:RuntimeHostAuthority,intentRevision:number,selectionRevision:number|null,input:RepairObservation) {
    if(input.scope!=='runtime'||input.origin!=='runtime')throw new Error('外部宿主故障观察来源无效');
    return this.db.transaction(()=>{
      if(!this.isRuntimeHostCurrent(authority))return null;
      const control=this.control();const installation=this.runtimeInstallation();
      if(control.desired_intent!=='running'||control.management_mode!=='normal'||control.intent_revision!==intentRevision||this.activeRuntimeUpdate()
        ||(selectionRevision===null?installation!==null:installation?.revision!==selectionRevision))return null;
      return this.observe(input);
    }).immediate();
  }

  getCase(caseId: string): RepairCase | null {
    return this.db.prepare(`SELECT case_id AS caseId,scope,scope_key AS scopeKey,fingerprint,original_version AS originalVersion,
      original_summary AS originalSummary,status,generation,current_attempt_id AS currentAttemptId,next_probe_at AS nextProbeAt,last_error AS lastError
      FROM repair_cases WHERE case_id = ?`).get(caseId) as RepairCase | undefined || null;
  }

  private canonicalRepairCaseId(caseId: string) {
    const seen = new Set<string>();
    let current = caseId;
    while (true) {
      if (seen.has(current)) throw new Error('修复 Case 别名链存在循环');
      seen.add(current);
      const alias = this.db.prepare('SELECT canonical_case_id AS canonicalCaseId FROM repair_case_aliases WHERE alias_case_id=?')
        .get(current) as { canonicalCaseId: string } | undefined;
      if (!alias) return current;
      current = alias.canonicalCaseId;
    }
  }

  attempts(caseId?: string): RepairAttempt[] {
    return this.db.prepare(`SELECT attempt_id AS attemptId,case_id AS caseId,owner_id AS ownerId,supervision_token AS supervisionToken,
      role,generation,intent_revision AS intentRevision,status,pid,start_marker AS startMarker,process_group_id AS processGroupId,last_error AS lastError
      FROM repair_attempts ${caseId ? 'WHERE case_id = ?' : ''} ORDER BY started_at,generation`).all(...(caseId ? [caseId] : [])) as RepairAttempt[];
  }

  observations(caseId: string) {
    return this.db.prepare('SELECT observation_id,origin,source_version,summary,evidence_json,observation_json FROM repair_observations WHERE case_id = ? ORDER BY created_at,rowid').all(caseId);
  }

  /** Existing stores may contain one Case per fingerprint for the same work
   * item. Return deterministic cohorts and stop every live generation before
   * cross-database bindings are rewritten. A current business resource owner
   * is preferred as canonical so ownership is never silently transferred. */
  workItemCaseCohorts(authority: AdminAuthority, preferredCaseIds: string[] = []) {
    this.assertAuthority(authority, true);
    const preferred = new Set(preferredCaseIds);
    const rows = this.db.prepare(`SELECT repair.case_id AS caseId,repair.scope_key AS scopeKey,repair.status,
      repair.created_at AS createdAt,repair.current_attempt_id AS currentAttemptId
      FROM repair_cases repair
      LEFT JOIN repair_case_aliases alias ON alias.alias_case_id=repair.case_id
      WHERE repair.scope='work-item' AND alias.alias_case_id IS NULL
      ORDER BY repair.scope_key,CASE WHEN repair.status='closed' THEN 1 ELSE 0 END,repair.created_at,repair.case_id`).all() as
      Array<{ caseId: string; scopeKey: string; status: string; createdAt: number; currentAttemptId: string | null }>;
    const groups = new Map<string, typeof rows>();
    for (const row of rows) groups.set(row.scopeKey, [...(groups.get(row.scopeKey) || []), row]);
    return [...groups.values()].filter(group => group.length > 1).map(group => {
      const canonical = group.find(row => preferred.has(row.caseId)) || group[0];
      const caseIds = group.map(row => row.caseId);
      const placeholders = caseIds.map(() => '?').join(',');
      const activeAttemptIds = (this.db.prepare(`SELECT attempt_id AS attemptId FROM repair_attempts
        WHERE case_id IN (${placeholders}) AND status IN ('launching','running') ORDER BY started_at,attempt_id`)
        .all(...caseIds) as Array<{ attemptId: string }>).map(row => row.attemptId);
      return { scopeKey: canonical.scopeKey, canonicalCaseId: canonical.caseId,
        aliasCaseIds: caseIds.filter(caseId => caseId !== canonical.caseId), activeAttemptIds };
    });
  }

  /** Final management-side half of legacy Case consolidation. Business
   * intervention/outbox bindings must already point at canonicalCaseId. Old
   * attempts remain immutable; their evidence is re-indexed under the
   * canonical Case while aliases remain as closed audit records. */
  mergeWorkItemCaseCohort(authority: AdminAuthority, input: {
    scopeKey: string; canonicalCaseId: string; aliasCaseIds: string[];
  }) {
    return this.db.transaction(() => {
      this.assertAuthority(authority, true);
      const ids = [input.canonicalCaseId, ...input.aliasCaseIds];
      if (!input.aliasCaseIds.length || new Set(ids).size !== ids.length) throw new Error('历史修复 Case 归并目标无效');
      const placeholders = ids.map(() => '?').join(',');
      const cases = this.db.prepare(`SELECT case_id AS caseId,scope,scope_key AS scopeKey FROM repair_cases
        WHERE case_id IN (${placeholders})`).all(...ids) as Array<{ caseId: string; scope: string; scopeKey: string }>;
      if (cases.length !== ids.length || cases.some(row => row.scope !== 'work-item' || row.scopeKey !== input.scopeKey)) {
        throw new Error('历史修复 Case 不能跨工作项归并');
      }
      if (this.db.prepare(`SELECT 1 FROM repair_attempts WHERE case_id IN (${placeholders})
        AND status IN ('launching','running') LIMIT 1`).get(...ids)) throw new Error('历史修复 Case 仍有执行未退出');
      if (this.db.prepare('SELECT 1 FROM repair_case_aliases WHERE alias_case_id=?').get(input.canonicalCaseId)) {
        throw new Error('历史修复 Case 的归并负责人已是其他 Case 的别名');
      }
      for (const aliasCaseId of input.aliasCaseIds) {
        const existing = this.db.prepare('SELECT canonical_case_id AS canonicalCaseId FROM repair_case_aliases WHERE alias_case_id=?')
          .get(aliasCaseId) as { canonicalCaseId: string } | undefined;
        if (existing && existing.canonicalCaseId !== input.canonicalCaseId) throw new Error('历史修复 Case 已归并至其他负责人');
        if (!existing) this.db.prepare('INSERT INTO repair_case_aliases(alias_case_id,canonical_case_id,merged_at) VALUES(?,?,?)')
          .run(aliasCaseId, input.canonicalCaseId, this.now());
        this.db.prepare('UPDATE repair_case_aliases SET canonical_case_id=? WHERE canonical_case_id=? AND alias_case_id<>?')
          .run(input.canonicalCaseId, aliasCaseId, input.canonicalCaseId);
        this.db.prepare('UPDATE repair_observations SET case_id=? WHERE case_id=?').run(input.canonicalCaseId, aliasCaseId);
        this.db.prepare('UPDATE repair_evidence SET case_id=? WHERE case_id=?').run(input.canonicalCaseId, aliasCaseId);
        this.db.prepare(`INSERT OR IGNORE INTO repair_activity_checkpoints(case_id,fingerprint,attempt_id,operation_json,created_at)
          SELECT ?,fingerprint,attempt_id,operation_json,created_at FROM repair_activity_checkpoints WHERE case_id=?`)
          .run(input.canonicalCaseId, aliasCaseId);
        this.db.prepare('DELETE FROM repair_activity_checkpoints WHERE case_id=?').run(aliasCaseId);
        this.db.prepare(`INSERT OR IGNORE INTO repair_diagnosis_facts(case_id,fingerprint,attempt_id,created_at)
          SELECT ?,fingerprint,attempt_id,created_at FROM repair_diagnosis_facts WHERE case_id=?`)
          .run(input.canonicalCaseId, aliasCaseId);
        this.db.prepare('DELETE FROM repair_diagnosis_facts WHERE case_id=?').run(aliasCaseId);
        this.db.prepare('DELETE FROM repair_schedule_queue WHERE case_id=?').run(aliasCaseId);
        this.db.prepare(`UPDATE repair_cases SET status='closed',current_attempt_id=NULL,next_probe_at=NULL,
          last_error=?,updated_at=? WHERE case_id=?`).run(`已归并至 ${input.canonicalCaseId}`, this.now(), aliasCaseId);
      }
      this.db.prepare(`UPDATE repair_cases SET status='queued',current_attempt_id=NULL,next_probe_at=NULL,
        last_error=?,updated_at=? WHERE case_id=?`).run('历史同工作项故障已归并，重新覆盖全部原始证据', this.now(), input.canonicalCaseId);
      this.db.prepare('INSERT OR IGNORE INTO repair_schedule_queue(case_id) VALUES(?)').run(input.canonicalCaseId);
      return this.getCase(input.canonicalCaseId)!;
    }).immediate();
  }

  /** Persist the business capability's abnormal handback only after the owning
   * Admin attempt is terminal and the business fence was physically released. */
  repairTakeoverRevocationNeedsCaseStop(input: unknown) {
    const revocation = repairTakeoverRevocationSchema.parse(input);
    const json = JSON.stringify(revocation);
    const prior = this.db.prepare('SELECT payload_json FROM repair_source_invalidations WHERE case_id=? AND generation=?')
      .get(revocation.caseId, revocation.generation) as { payload_json: string } | undefined;
    if (prior) {
      if (JSON.stringify(repairTakeoverRevocationSchema.parse(JSON.parse(prior.payload_json))) !== json) {
        throw new Error('不能改写已保存的接管撤销结果');
      }
      return false;
    }
    const covered = new Set(revocation.coveredObservationIds);
    const observations = this.db.prepare("SELECT observation_id AS observationId FROM repair_observations WHERE case_id=? AND origin='business'")
      .all(revocation.caseId) as Array<{ observationId: string }>;
    return observations.every(row => covered.has(row.observationId));
  }

  recordRepairTakeoverRevocation(authority: AdminAuthority, input: unknown) {
    const revocation = repairTakeoverRevocationSchema.parse(input);
    return this.db.transaction(() => {
      this.assertAuthority(authority, true);
      const repairCase = this.getCase(revocation.caseId);
      const attempt = this.attempts(revocation.caseId).find(row => row.generation === revocation.generation);
      const json = JSON.stringify(revocation);
      const prior = this.db.prepare('SELECT payload_json FROM repair_source_invalidations WHERE case_id=? AND generation=?')
        .get(revocation.caseId, revocation.generation) as { payload_json: string } | undefined;
      if (prior && JSON.stringify(repairTakeoverRevocationSchema.parse(JSON.parse(prior.payload_json))) !== json) {
        throw new Error('不能改写已保存的接管撤销结果');
      }
      if (prior) return false;
      if (!repairCase || !attempt || ['launching', 'running'].includes(attempt.status)) {
        throw new Error('接管撤销缺少原 Admin 代次的实际退出证明');
      }
      const covered = new Set(revocation.coveredObservationIds);
      const uncovered = (this.db.prepare("SELECT observation_id AS observationId FROM repair_observations WHERE case_id=? AND origin='business'")
        .all(revocation.caseId) as Array<{ observationId: string }>).filter(row => !covered.has(row.observationId));
      if (!uncovered.length && repairCase.currentAttemptId !== null) throw new Error('接管撤销缺少当前 Case 执行退出证明');
      this.db.prepare('INSERT INTO repair_source_invalidations(case_id,generation,payload_json,created_at) VALUES(?,?,?,?)')
        .run(revocation.caseId, revocation.generation, json, this.now());
      if (uncovered.length) {
        if (repairCase.status === 'closed') this.db.prepare("UPDATE repair_cases SET status='queued',next_probe_at=NULL,last_error=?,updated_at=? WHERE case_id=?")
          .run('旧接管撤销已确认；保留其后新增故障的调度责任', this.now(), revocation.caseId);
        this.db.prepare('INSERT OR IGNORE INTO repair_schedule_queue(case_id) VALUES(?)').run(revocation.caseId);
        return true;
      }
      this.db.prepare('UPDATE repair_cases SET status=?,current_attempt_id=NULL,next_probe_at=NULL,last_error=?,updated_at=? WHERE case_id=?')
        .run(revocation.terminal ? 'closed' : 'queued', revocation.reason, this.now(), revocation.caseId);
      if (!revocation.terminal) this.db.prepare('INSERT OR IGNORE INTO repair_schedule_queue(case_id) VALUES(?)').run(revocation.caseId);
      return true;
    }).immediate();
  }

  private caseAttempt(caseId: string, attemptId: string): RepairAttempt | undefined {
    return this.db.prepare(`SELECT attempt_id AS attemptId,case_id AS caseId,owner_id AS ownerId,supervision_token AS supervisionToken,
      role,generation,intent_revision AS intentRevision,status,pid,start_marker AS startMarker,process_group_id AS processGroupId,last_error AS lastError
      FROM repair_attempts WHERE case_id = ? AND attempt_id = ?`).get(caseId, attemptId) as RepairAttempt | undefined;
  }

  currentIndependentVerificationClaim(authority:AdminAuthority,caseId:string):RepairClaim {
    const repairCase=this.getCase(caseId);
    const attempt=repairCase?.currentAttemptId?this.caseAttempt(caseId,repairCase.currentAttemptId):undefined;
    if(!repairCase||!attempt||attempt.role!=='verification')throw new Error('独立验收能力缺少当前验证分配');
    const claim={authority,repairCase,attempt};this.assertIndependentVerificationClaim(claim);return claim;
  }

  private rotateRepairSchedule(caseId: string) {
    // Queue order is independent of wall-clock precision, new observations,
    // failures and host restarts. Only an actual fenced allocation moves it.
    this.db.prepare('DELETE FROM repair_schedule_queue WHERE case_id=?').run(caseId);
    this.db.prepare('INSERT INTO repair_schedule_queue(case_id) VALUES(?)').run(caseId);
  }

  /** One fair queue for investigation, due probes and independent verification.
   * The claim and rotation are atomic; a stop/fence cannot consume a turn. */
  claimScheduled(authority: AdminAuthority, verification: boolean): RepairClaim | null {
    return this.db.transaction(() => {
      this.assertAuthority(authority, true);
      const row = this.db.prepare(`SELECT repair.status FROM repair_cases repair JOIN repair_schedule_queue queue USING(case_id)
        WHERE current_attempt_id IS NULL AND (
          ((status='queued' OR (status='external-wait' AND next_probe_at<=?)) AND (next_probe_at IS NULL OR next_probe_at<=?))
          OR (? AND status='verifying')) ORDER BY queue.ticket LIMIT 1`)
        .get(this.now(),this.now(),verification?1:0) as {status:string}|undefined;
      if(!row)return null;
      return row.status==='verifying'?this.claimVerification(authority):this.claimNext(authority);
    }).immediate();
  }

  claimNext(authority: AdminAuthority): RepairClaim | null {
    return this.db.transaction(() => {
      const control = this.assertAuthority(authority, true);
      const row = this.db.prepare(`SELECT case_id AS caseId FROM repair_cases JOIN repair_schedule_queue queue USING(case_id) WHERE current_attempt_id IS NULL
        AND (status = 'queued' OR (status = 'external-wait' AND next_probe_at <= ?))
        AND (next_probe_at IS NULL OR next_probe_at <= ?) ORDER BY queue.ticket LIMIT 1`).get(this.now(), this.now()) as { caseId: string } | undefined;
      if (!row) return null;
      const repairCase = this.getCase(row.caseId)!;
      const attemptId = `ADMIN-${randomUUID()}`;
      const generation = repairCase.generation + 1;
      this.db.prepare(`INSERT INTO repair_attempts(attempt_id,case_id,owner_id,supervision_token,generation,intent_revision,status,started_at)
        VALUES(?,?,?,?,?,?,'launching',?)`).run(attemptId, repairCase.caseId, authority.ownerId, authority.token, generation, control.intent_revision, this.now());
      this.rotateRepairSchedule(repairCase.caseId);
      this.db.prepare("UPDATE repair_cases SET current_attempt_id = ?,generation = ?,status = 'running',next_probe_at = NULL,updated_at = ? WHERE case_id = ?")
        .run(attemptId, generation, this.now(), repairCase.caseId);
      const attempts = this.attempts(repairCase.caseId);
      const claim = { authority, repairCase: this.getCase(repairCase.caseId)!, attempt: attempts.find(attempt => attempt.attemptId === attemptId)! };
      const failedIds = attempts.filter(attempt => attempt.status === 'failed'
        || (attempt.status === 'interrupted' && (this.db.prepare('SELECT cause FROM repair_interruption_facts WHERE attempt_id = ?')
          .get(attempt.attemptId) as { cause: string } | undefined)?.cause === 'host-loss')
        || (attempt.role === 'verification' && attempt.status === 'completed'
          && (this.verificationPurpose(attempt.attemptId) === 'diagnosis'
            ? (this.db.prepare('SELECT novel FROM repair_diagnosis_rounds WHERE attempt_id = ?').get(attempt.attemptId) as { novel: number } | undefined)?.novel === 0
            : this.verificationReceipt(attempt.attemptId)?.passed === false)))
        .map(attempt => attempt.attemptId);
      const transitionFailures=this.db.prepare(`SELECT DISTINCT json_extract(evidence_json,'$.recoveryFailureId') AS id
        FROM repair_observations WHERE case_id=? AND origin='runtime'
          AND json_type(evidence_json,'$.recoveryFailureId')='text' ORDER BY rowid`).all(repairCase.caseId) as {id:string}[];
      this.db.prepare('INSERT INTO repair_recovery_decisions(attempt_id,decision_json,created_at) VALUES(?,?,?)')
        .run(attemptId, JSON.stringify(decideRepairRecovery([...failedIds,...transitionFailures.map(row=>row.id)])), this.now());
      return claim;
    }).immediate();
  }

  /** Host-only allocation. The repair Agent cannot grant itself verification
   * authority through its submitted command arguments. Physical fences and
   * generation allocation are shared with investigation attempts. */
  claimVerification(authority: AdminAuthority): RepairClaim | null {
    return this.db.transaction(() => {
      const control = this.assertAuthority(authority, true);
      const row = this.db.prepare(`SELECT case_id AS caseId FROM repair_cases JOIN repair_schedule_queue queue USING(case_id)
        WHERE status = 'verifying' AND current_attempt_id IS NULL
        ORDER BY queue.ticket LIMIT 1`).get() as { caseId: string } | undefined;
      if (!row) return null;
      const repairCase = this.getCase(row.caseId)!;
      const attemptId = `VERIFY-${randomUUID()}`;
      const generation = repairCase.generation + 1;
      this.db.prepare(`INSERT INTO repair_attempts(attempt_id,case_id,owner_id,supervision_token,generation,intent_revision,role,status,started_at)
        VALUES(?,?,?,?,?,?,'verification','launching',?)`)
        .run(attemptId, repairCase.caseId, authority.ownerId, authority.token, generation, control.intent_revision, this.now());
      this.rotateRepairSchedule(repairCase.caseId);
      this.db.prepare('UPDATE repair_cases SET current_attempt_id = ?,generation = ?,updated_at = ? WHERE case_id = ?')
        .run(attemptId, generation, this.now(), repairCase.caseId);
      return { authority, repairCase: this.getCase(row.caseId)!, attempt: this.attempts(row.caseId).find(row => row.attemptId === attemptId)! };
    }).immediate();
  }

  private assertClaim(claim: RepairClaim) {
    const control = this.assertAuthority(claim.authority, true);
    const repairCase = this.getCase(claim.repairCase.caseId);
    const attempt = this.caseAttempt(claim.repairCase.caseId, claim.attempt.attemptId);
    if (!attempt || attempt.ownerId !== claim.authority.ownerId || attempt.supervisionToken !== claim.authority.token
      || attempt.intentRevision !== control.intent_revision || repairCase?.currentAttemptId !== attempt.attemptId
      || !['launching', 'running'].includes(attempt.status)) throw new Error('Admin 接管代次或执行来源已失效');
    return attempt;
  }

  attachProcess(claim: RepairClaim, pid: number, marker?: string, groupId?: number) {
    if (!Number.isInteger(pid) || pid <= 0 || marker !== undefined && !marker.trim() || (groupId !== undefined && groupId !== pid)) throw new Error('无效 Admin 进程身份');
    this.db.transaction(() => {
      const attempt = this.assertClaim(claim);
      if (attempt.pid !== null && attempt.pid !== pid) throw new Error('不能修改已绑定的 Admin PID');
      if (attempt.startMarker && marker && attempt.startMarker !== marker) throw new Error('不能修改已绑定的 Admin 进程代次');
      // A PID is a launch attachment, not established process identity. Keep
      // launching until the actual start marker is persisted; callers must
      // not interpret a markerless attachment as a ready running invocation.
      this.db.prepare("UPDATE repair_attempts SET pid = ?,start_marker = COALESCE(start_marker,?),process_group_id = COALESCE(process_group_id,?),status = CASE WHEN COALESCE(start_marker,?) IS NOT NULL THEN 'running' ELSE 'launching' END WHERE attempt_id = ?")
        .run(pid, marker || null, groupId || null, marker || null, attempt.attemptId);
    }).immediate();
  }

  recordEvidence(claim: RepairClaim, receiptKey: string, kind: string, payload: Record<string, unknown>) {
    if (!receiptKey.trim() || !kind.trim()) throw new Error('修复证据必须有幂等标识和类型');
    const json = JSON.stringify(payload);
    return this.db.transaction(() => {
      this.assertClaim(claim);
      const prior = this.db.prepare('SELECT kind,payload_json FROM repair_evidence WHERE attempt_id = ? AND receipt_key = ?')
        .get(claim.attempt.attemptId, receiptKey) as { kind: string; payload_json: string } | undefined;
      if (prior) {
        if (prior.kind !== kind || prior.payload_json !== json) throw new Error('不能改写已经记录的修复证据');
        return false;
      }
      this.db.prepare('INSERT INTO repair_evidence(case_id,attempt_id,receipt_key,kind,payload_json,created_at) VALUES(?,?,?,?,?,?)')
        .run(claim.repairCase.caseId, claim.attempt.attemptId, receiptKey, kind, json, this.now());
      return true;
    }).immediate();
  }

  evidence(caseId: string) {
    return this.db.prepare('SELECT attempt_id,receipt_key,kind,payload_json FROM repair_evidence WHERE case_id = ? ORDER BY created_at,rowid').all(caseId);
  }

  issueCommandCredential(claim: RepairClaim): AdminCommandCredential {
    const token = randomBytes(32).toString('hex');
    const sessionId = randomUUID();
    return this.db.transaction(() => {
      if (this.assertClaim(claim).role !== 'investigation') throw new Error('独立验证执行不能签发修复命令凭证');
      if (this.db.prepare('SELECT 1 FROM admin_command_sessions WHERE attempt_id = ?').get(claim.attempt.attemptId)) {
        throw new Error('当前 Admin 执行已签发命令凭证，不能重复签发');
      }
      this.db.prepare('INSERT INTO admin_command_sessions(session_id,attempt_id,token_hash,created_at) VALUES(?,?,?,?)')
        .run(sessionId, claim.attempt.attemptId, createHash('sha256').update(token).digest('hex'), this.now());
      return { caseId: claim.repairCase.caseId, attemptId: claim.attempt.attemptId, sessionId, token };
    }).immediate();
  }

  private authenticatedClaim(credential: AdminCommandCredential, requireStatus = false) {
    if (!/^[0-9a-f]{64}$/.test(credential.token)) throw new Error('Admin 命令凭证无效');
    const session = this.db.prepare('SELECT attempt_id,token_hash,status_viewed,submission_json FROM admin_command_sessions WHERE session_id = ?')
      .get(credential.sessionId) as { attempt_id: string; token_hash: string; status_viewed: number; submission_json: string | null } | undefined;
    const actualHash = createHash('sha256').update(credential.token).digest('hex');
    if (!session || session.attempt_id !== credential.attemptId || session.token_hash.length !== actualHash.length
      || !timingSafeEqual(Buffer.from(session.token_hash), Buffer.from(actualHash))) throw new Error('Admin 命令凭证无效');
    const attempt = this.caseAttempt(credential.caseId, credential.attemptId);
    const repairCase = this.getCase(credential.caseId);
    if (!attempt || !repairCase) throw new Error('Admin 命令凭证无效');
    const claim: RepairClaim = { authority: { ownerId: attempt.ownerId, token: attempt.supervisionToken }, attempt, repairCase };
    this.assertClaim(claim);
    if (requireStatus && !session.status_viewed) throw new Error('Admin 必须先读取 status 再记录或提交');
    return { claim, session };
  }

  commandStatus(credential: AdminCommandCredential) {
    return this.db.transaction(() => {
      const { claim, session } = this.authenticatedClaim(credential);
      this.db.prepare('UPDATE admin_command_sessions SET status_viewed = 1 WHERE session_id = ?').run(credential.sessionId);
      const history = this.boundedCaseHistory(claim.repairCase.caseId);
      return { repairCase: claim.repairCase, attempt: claim.attempt,
        requiredOriginalCoverage: this.requiredOriginalCoverage(claim.repairCase.caseId),
        observations: history.observations.rows, evidence: history.evidence.rows,
        attempts: history.attempts.rows,
        followups: history.followups.rows,
        recoveryDecision: this.recoveryDecision(claim.attempt.attemptId),
        diagnoses: history.diagnoses.rows,
        history: Object.fromEntries(Object.entries(history).map(([key, value]) => [key,
          { total: value.total, shown: value.shown, nextIndex: value.nextIndex }])),
        actions: this.commandActions(claim.attempt.attemptId),
        submission: session.submission_json ? adminSubmissionSchema.parse(JSON.parse(session.submission_json)) : null };
    }).immediate();
  }

  private caseHistoryQuery(collection: AdminHistoryCollection) {
    switch (collection) {
      case 'observations': return { columns: 'observation_id,origin,source_version,summary,evidence_json,observation_json',
        from: 'repair_observations WHERE case_id = ?', order: 'created_at,rowid' };
      case 'evidence': return { columns: 'attempt_id,receipt_key,kind,payload_json',
        from: 'repair_evidence WHERE case_id = ?', order: 'created_at,rowid' };
      case 'attempts': return { columns: `attempt_id AS attemptId,case_id AS caseId,owner_id AS ownerId,supervision_token AS supervisionToken,
        role,generation,intent_revision AS intentRevision,status,pid,start_marker AS startMarker,process_group_id AS processGroupId,last_error AS lastError`,
        from: 'repair_attempts WHERE case_id = ?', order: 'started_at,generation' };
      case 'followups': return { columns: 'verification_attempt_id,kind,payload_json',
        from: 'repair_followups WHERE case_id = ?', order: 'created_at,rowid' };
      case 'diagnoses': return { columns: 'purpose.attempt_id AS attemptId,round.novel',
        from: `repair_verification_purposes purpose JOIN repair_attempts attempt USING(attempt_id)
          LEFT JOIN repair_diagnosis_rounds round USING(attempt_id) WHERE attempt.case_id = ? AND purpose.purpose = 'diagnosis'`,
        order: 'attempt.generation' };
    }
  }

  private caseHistoryReader(caseId: string, collection: AdminHistoryCollection) {
    // SQL is selected from fixed host-owned definitions, never Agent input.
    // Count metadata without transferring payloads; fetch only the requested
    // row. Authentication and excerpts must not materialize the full Case.
    const query = this.caseHistoryQuery(collection);
    const total = (this.db.prepare(`SELECT count(*) AS total FROM ${query.from}`).get(caseId) as { total: number }).total;
    const select = this.db.prepare(`SELECT ${query.columns} FROM ${query.from} ORDER BY ${query.order} LIMIT 1 OFFSET ?`);
    const read = (index: number): unknown => {
      const row = select.get(caseId, index);
      return collection === 'diagnoses' && row ? this.diagnosisHistoryRow(row as { attemptId: string; novel: number | null }) : row;
    };
    function* rows() { for (let index = 0; index < total; index++) yield read(index); }
    return { total, read, rows };
  }

  boundedCaseHistory(caseId: string) {
    return this.db.transaction(() => {
      const excerpt = (collection: AdminHistoryCollection, budget: number) => {
        const reader = this.caseHistoryReader(caseId, collection);
        return boundedAdminHistory(reader.rows(), collection, budget, reader.total);
      };
      return { observations: excerpt('observations', 16000), evidence: excerpt('evidence', 8000),
        attempts: excerpt('attempts', 6000), followups: excerpt('followups', 4000), diagnoses: excerpt('diagnoses', 4000) };
    })();
  }

  commandReadHistory(credential: AdminCommandCredential, collection: AdminHistoryCollection,
    index: number, start: number, length: number, expectedHash?: string) {
    return this.db.transaction(() => {
      const { claim } = this.authenticatedClaim(credential, true);
      if (!Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(start) || start < 0
        || !Number.isSafeInteger(length) || length < 1 || length > 8000) throw new Error('历史读取 index/start 必须非负，length 必须为 1–8000');
      const reader = this.caseHistoryReader(claim.repairCase.caseId, collection);
      if (index >= reader.total) throw new Error('历史记录 index 不存在');
      return { ...adminHistoryChunk(reader.read(index), collection, index, start, length, expectedHash), total: reader.total };
    })();
  }

  commandRecordEvidence(credential: AdminCommandCredential, key: string, kind: string, payload: Record<string, unknown>) {
    return this.db.transaction(() => {
      const { claim, session } = this.authenticatedClaim(credential, true);
      if (session.submission_json) throw new Error('Admin 已终止提交，不能继续改写本轮证据');
      return this.recordEvidence(claim, key, kind, payload);
    }).immediate();
  }

  commandRequestAction(credential: AdminCommandCredential, key: string, input: unknown) {
    if (!/^[a-zA-Z0-9._:-]{1,80}$/.test(key)) throw new Error('管理动作必须提供 1–80 字符的稳定 --key');
    const action = adminActionSchema.parse(input);
    const json = JSON.stringify(action);
    return this.db.transaction(() => {
      const { claim, session } = this.authenticatedClaim(credential, true);
      if (session.submission_json) throw new Error('Admin 已终止提交，不能再申请管理动作');
      if(action.kind==='harness-build'){
        const workspace=this.commandActions(claim.attempt.attemptId).find(row=>row.key===action.workspaceKey);
        if(workspace?.action.kind!=='harness-workspace'||workspace.status!=='completed'||workspace.result?.phase!=='prepared')throw new Error('Harness 构建必须引用本轮已完成的源码准备动作');
      }
      const source = this.observations(claim.repairCase.caseId).some(raw => {
        const observation = raw as { observation_id:string;origin: string; evidence_json: string };
        const evidence = JSON.parse(observation.evidence_json) as {artifact?:unknown; item?: { item_id?: string; revision?: number } };
        if(action.kind==='workspace-takeover')return observation.origin==='business'&&evidence.item?.item_id===action.itemId;
        if(action.kind==='harness-build')return true; // Source checked against the completed scoped action above.
        if(observation.origin!=='runtime'||observation.observation_id!==action.observationId)return false;
        try{originalRuntimeArtifact(evidence);return true;}catch{return false;}
      });
      if (!source) throw new Error(action.kind==='workspace-takeover'?'工作区接管必须引用当前 Case 的原始业务 item / revision':'Harness 源码准备必须引用当前 Case 的原始 runtime artifact 故障');
      const prior = this.db.prepare('SELECT action_json FROM admin_command_actions WHERE attempt_id = ? AND receipt_key = ?')
        .get(claim.attempt.attemptId, key) as { action_json: string } | undefined;
      if (prior && prior.action_json !== json) throw new Error('管理动作幂等键冲突，不能改写原请求');
      if (!prior) this.db.prepare('INSERT INTO admin_command_actions(attempt_id,receipt_key,action_json,created_at,updated_at) VALUES(?,?,?,?,?)')
        .run(claim.attempt.attemptId, key, json, this.now(), this.now());
      return this.commandActions(claim.attempt.attemptId).find(record => record.key === key)!;
    }).immediate();
  }

  private commandActions(attemptId: string): AdminActionRecord[] {
    const rows = this.db.prepare('SELECT receipt_key,action_json,status,result_json FROM admin_command_actions WHERE attempt_id = ? ORDER BY created_at,receipt_key')
      .all(attemptId) as { receipt_key: string; action_json: string; status: AdminActionRecord['status']; result_json: string | null }[];
    return rows.map(row => ({ key: row.receipt_key, action: adminActionSchema.parse(JSON.parse(row.action_json)),
      status: row.status, result: row.result_json ? JSON.parse(row.result_json) as Record<string, unknown> : null }));
  }

  pendingCommandActions(authority: AdminAuthority) {
    const control = this.assertAuthority(authority, true);
    const attempts = this.attempts().filter(attempt => ['launching','running'].includes(attempt.status)
      && attempt.ownerId === authority.ownerId && attempt.supervisionToken === authority.token && attempt.intentRevision === control.intent_revision);
    return attempts.flatMap(attempt => {
      const repairCase = this.getCase(attempt.caseId)!;
      const claim: RepairClaim = { authority, repairCase, attempt };
      this.assertClaim(claim);
      return this.commandActions(attempt.attemptId).filter(action => action.status === 'pending').map(action => ({ claim, ...action }));
    });
  }

  harnessWorkspaceSource(claim:RepairClaim,key:string){
    this.assertClaim(claim);
    const row=this.commandActions(claim.attempt.attemptId).find(action=>action.key===key);
    if(row?.action.kind!=='harness-workspace'||row.status!=='completed'||row.result?.phase!=='prepared')throw new Error('Harness 构建缺少本轮准确源码准备');
    const artifact=runtimeArtifactSchema.parse(row.result.sourceArtifact);
    const observationId=row.action.observationId;
    const original=this.observations(claim.repairCase.caseId).find(raw=>(raw as {observation_id:string}).observation_id===observationId) as {evidence_json:string;origin:string}|undefined;
    if(original?.origin!=='runtime'||JSON.stringify(originalRuntimeArtifact(JSON.parse(original.evidence_json)))!==JSON.stringify(artifact))throw new Error('Harness 构建原始源码来源已失效');
    const authorization=row.result.authorization as {caseId?:string;attemptId?:string;generation?:number;ownerId?:string;supervisionToken?:number;intentRevision?:number}|undefined;
    if(authorization?.caseId!==claim.repairCase.caseId||authorization.attemptId!==claim.attempt.attemptId||authorization.generation!==claim.attempt.generation
      ||authorization.ownerId!==claim.authority.ownerId||authorization.supervisionToken!==claim.authority.token||authorization.intentRevision!==claim.attempt.intentRevision
      ||typeof row.result.workspaceRoot!=='string')throw new Error('Harness 构建源码准备代次不一致');
    return {workspaceRoot:row.result.workspaceRoot,sourceArtifact:artifact};
  }

  /** Bounded host-written physical build records. Reuse is an optimization of
   * identical source compilation only; callers must revalidate immutable
   * bytes, create a current-attempt frozen source and still run independent
   * original-contract verification. Controlled/admission fixtures and reuse
   * chains are deliberately ineligible. */
  reusableHarnessCandidates(sourceId:string,excludeAttemptId:string,onError?:(error:unknown)=>void):ReusableHarnessCandidate[] {
    if(!/^[a-f0-9]{64}$/.test(sourceId))throw new Error('Harness 复用源码身份无效');
    const rows=this.db.prepare(`SELECT action.attempt_id AS attemptId,action.receipt_key AS buildKey,
      action.action_json AS actionJson,action.result_json AS resultJson,
      attempt.case_id AS caseId,attempt.owner_id AS ownerId,attempt.supervision_token AS supervisionToken,
      attempt.generation,attempt.intent_revision AS intentRevision
      FROM admin_command_actions action JOIN repair_attempts attempt ON attempt.attempt_id=action.attempt_id
      JOIN repair_cases repair ON repair.case_id=attempt.case_id
      WHERE action.attempt_id<>? AND action.status='completed' AND attempt.status='completed'
        AND attempt.role='investigation' AND repair.scope='runtime'
        AND json_valid(action.action_json) AND json_valid(action.result_json)
        AND json_extract(action.action_json,'$.kind')='harness-build'
        AND json_extract(action.result_json,'$.phase')='candidate-built'
        AND json_extract(action.result_json,'$.sourceId')=?
      ORDER BY action.updated_at DESC,action.rowid DESC LIMIT 32`).all(excludeAttemptId,sourceId) as Array<{
        attemptId:string;buildKey:string;actionJson:string;resultJson:string;caseId:string;ownerId:string;
        supervisionToken:number;generation:number;intentRevision:number;
      }>;
    return rows.flatMap(row=>{
      try{
        const action=adminActionSchema.parse(JSON.parse(row.actionJson));
        const result=JSON.parse(row.resultJson) as Record<string,unknown>;
        if(action.kind!=='harness-build'||result.reusedFrom!==undefined)throw new Error('Harness 复用来源必须是原始物理构建');
        const candidate=runtimeArtifactSchema.parse(result.candidate),sourceArtifact=runtimeArtifactSchema.parse(result.sourceArtifact);
        const receipts=result.receipts as Array<Record<string,unknown>>|undefined;
        const toolchain=result.toolchain as Record<string,unknown>|undefined;
        if(candidate.sourceId!==sourceId||result.sourceId!==sourceId||JSON.stringify(result.sourceArtifact)!==JSON.stringify(sourceArtifact)
          ||result.independentVerificationRequired!==true||result.liveWorkspacePermission!==false
          ||typeof result.workspaceRoot!=='string'||!result.workspaceRoot||typeof result.frozenWorkspaceRoot!=='string'||!result.frozenWorkspaceRoot
          ||typeof result.logFile!=='string'||!result.logFile||!Array.isArray(receipts)
          ||JSON.stringify(receipts.map(receipt=>receipt.stage))!==JSON.stringify(harnessBuildStages)
          ||receipts.some(receipt=>Object.keys(receipt).sort().join(',')!=='exitCode,stage'||receipt.exitCode!==0)
          ||!toolchain||Object.keys(toolchain).sort().join(',')!=='arch,node,npm,platform,version'
          ||['node','npm','version','platform','arch'].some(key=>typeof toolchain[key]!=='string'||!(toolchain[key] as string).trim())) {
          throw new Error('Harness 复用来源缺少真实完整构建收据');
        }
        const sourceRow=this.db.prepare(`SELECT action_json AS actionJson,status,result_json AS resultJson
          FROM admin_command_actions WHERE attempt_id=? AND receipt_key=?`).get(row.attemptId,action.workspaceKey) as
          {actionJson:string;status:AdminActionRecord['status'];resultJson:string|null}|undefined;
        if(!sourceRow||sourceRow.status!=='completed'||!sourceRow.resultJson)throw new Error('Harness 复用来源缺少原始源码动作');
        const sourceAction=adminActionSchema.parse(JSON.parse(sourceRow.actionJson)),sourceResult=JSON.parse(sourceRow.resultJson) as Record<string,unknown>;
        const authorization=sourceResult.authorization as Record<string,unknown>|undefined;
        if(sourceAction.kind!=='harness-workspace'||sourceResult.phase!=='prepared'
          ||JSON.stringify(sourceResult.sourceArtifact)!==JSON.stringify(sourceArtifact)
          ||authorization?.caseId!==row.caseId||authorization.attemptId!==row.attemptId||authorization.generation!==row.generation
          ||authorization.ownerId!==row.ownerId||authorization.supervisionToken!==row.supervisionToken||authorization.intentRevision!==row.intentRevision) {
          throw new Error('Harness 复用来源的源码授权不一致');
        }
        const original=this.db.prepare("SELECT evidence_json FROM repair_observations WHERE case_id=? AND observation_id=? AND origin='runtime'")
          .get(row.caseId,sourceAction.observationId) as {evidence_json:string}|undefined;
        if(!original||JSON.stringify(originalRuntimeArtifact(JSON.parse(original.evidence_json)))!==JSON.stringify(sourceArtifact)) {
          throw new Error('Harness 复用来源与原始 runtime 事实不一致');
        }
        return [{attemptId:row.attemptId,buildKey:row.buildKey,candidate,sourceId,sourceArtifact,
          receipts:receipts as Array<{stage:string;exitCode:number}>,toolchain:toolchain as ReusableHarnessCandidate['toolchain'],logFile:result.logFile as string}];
      }catch(error){try{onError?.(error);}catch{/* diagnostics cannot hide another valid candidate */}return [];}
    });
  }

  recordCommandActionResult(claim: RepairClaim, key: string, status: AdminActionRecord['status'], result: Record<string, unknown>) {
    return this.db.transaction(() => {
      this.assertClaim(claim);
      const existing = this.commandActions(claim.attempt.attemptId).find(record => record.key === key);
      if (!existing) throw new Error('管理动作不存在');
      if (existing.status !== 'pending') {
        if (existing.status !== status || JSON.stringify(existing.result) !== JSON.stringify(result)) throw new Error('不能改写已完成的管理动作');
        return false;
      }
      this.db.prepare('UPDATE admin_command_actions SET status = ?,result_json = ?,updated_at = ? WHERE attempt_id = ? AND receipt_key = ?')
        .run(status, JSON.stringify(result), this.now(), claim.attempt.attemptId, key);
      this.recordEvidence(claim, `managed:${key}:${createHash('sha256').update(JSON.stringify({ status,result })).digest('hex')}`,
        'finding', { requestKey: key, status, result });
      return true;
    }).immediate();
  }

  /** External waiting is a host-checked conclusion, not an Agent escape hatch.
   * A current finding must point at the latest complete independent diagnosis;
   * that diagnosis must have proved the source version while a real
   * reproduction / acceptance check remained unavailable. */
  private assertExternalWaitRequest(claim: RepairClaim,
    submission: Extract<AdminSubmission, { outcome: 'external-wait-requested' }>) {
    const evidence = this.db.prepare(`SELECT 1 FROM repair_evidence
      WHERE case_id=? AND attempt_id=? AND receipt_key=? AND kind='finding'`)
      .get(claim.repairCase.caseId, claim.attempt.attemptId, submission.evidenceKey);
    if (!evidence) throw new Error('外部等待必须引用本轮真实记录的 finding 证据');
    const latest = this.db.prepare(`SELECT attempt.attempt_id AS attemptId FROM repair_attempts attempt
      JOIN repair_verification_purposes purpose USING(attempt_id)
      WHERE attempt.case_id=? AND attempt.role='verification' AND attempt.status='completed'
        AND purpose.purpose='diagnosis' ORDER BY attempt.generation DESC LIMIT 1`)
      .get(claim.repairCase.caseId) as { attemptId: string } | undefined;
    if (!latest || latest.attemptId !== submission.diagnosisAttemptId) {
      throw new Error('外部等待必须引用当前 Case 最近完成的独立诊断');
    }
    const receipt = this.verificationReceipt(submission.diagnosisAttemptId);
    if (!receipt || !receipt.exitConfirmed || receipt.checks.length !== repairVerificationSteps(receipt.plan).length
      || receipt.checks.some(check => !check.result.exitConfirmed || check.result.exitCode === null)) {
      throw new Error('外部等待缺少完整、已确认退出的独立诊断收据');
    }
    const versionChecks = receipt.checks.filter(check => check.kind === 'version-before' || check.kind === 'version-after');
    if (versionChecks.length !== 2 || versionChecks.some(check => check.result.exitCode !== 0
      || check.result.stdout.trim() !== receipt.plan.expectedVersion)
      || receipt.plan.expectedVersion !== submission.baselineVersion) {
      throw new Error('外部等待的实际版本未被独立诊断确认');
    }
    const checkedIds = [...receipt.plan.originalObservationIds].sort();
    if (JSON.stringify(checkedIds) !== JSON.stringify([...submission.originalObservationIds].sort())) {
      throw new Error('外部等待引用的原始故障与独立诊断不一致');
    }
    if (!receipt.checks.some(check => (check.kind === 'reproduction' || check.kind === 'acceptance')
      && check.result.exitCode !== 0)) {
      throw new Error('独立诊断没有证明外部依赖仍不可用，不能进入外部等待');
    }
  }

  commandSubmit(credential: AdminCommandCredential, input: unknown) {
    const submission = adminSubmissionSchema.parse(input);
    const json = JSON.stringify(submission);
    return this.db.transaction(() => {
      const { claim, session } = this.authenticatedClaim(credential, true);
      if (session.submission_json) {
        if (session.submission_json !== json) throw new Error('不能改写已经提交的 Admin 结果');
        return false;
      }
      if (submission.outcome === 'verification-requested' || submission.outcome === 'diagnosis-requested') {
        const harnessRepair = this.commandActions(claim.attempt.attemptId).some(action=>['harness-workspace','harness-build'].includes(action.action.kind));
        const runtimeAnchor = claim.repairCase.scope === 'runtime' && harnessRepair && submission.outcome === 'verification-requested'
          ? this.harnessCandidateAnchor(claim.attempt.attemptId, submission.repairVersion) : null;
        if (runtimeAnchor && submission.outcome === 'verification-requested' && !submission.repairEvidenceKeys.includes(runtimeAnchor.buildKey)) throw new Error('runtime 验证请求必须引用本轮已完成的真实候选构建动作');
        if (claim.repairCase.scope === 'work-item' && !this.commandActions(claim.attempt.attemptId).some(action =>
          action.action.kind === 'workspace-takeover' && action.status === 'completed' && action.result?.phase === 'owned')) {
          throw new Error('业务代码修复必须先获得本轮工作区接管，才能请求独立验证');
        }
        for (const id of submission.originalObservationIds) {
          const source = this.db.prepare("SELECT 1 FROM repair_observations WHERE observation_id = ? AND case_id = ? AND origin <> 'admin'")
            .get(id, claim.repairCase.caseId);
          if (!source) throw new Error(`验证请求引用的原始故障不存在或不属于当前 Case：${id}`);
        }
        if (submission.outcome === 'verification-requested') this.assertOriginalCoverage(claim.repairCase.caseId, submission.originalObservationIds);
        for (const key of submission.outcome === 'verification-requested' ? submission.repairEvidenceKeys : []) {
          if (runtimeAnchor && key === runtimeAnchor.buildKey) continue;
          const evidence = this.db.prepare("SELECT 1 FROM repair_evidence WHERE attempt_id = ? AND receipt_key = ? AND kind IN ('action','change')")
            .get(claim.attempt.attemptId, key);
          if (!evidence) throw new Error(`验证请求必须引用本轮真实记录的修复动作或变更证据：${key}`);
        }
      }
      if (submission.outcome === 'external-wait-requested') this.assertExternalWaitRequest(claim, submission);
      this.db.prepare('UPDATE admin_command_sessions SET submission_json = ? WHERE session_id = ?').run(json, credential.sessionId);
      return true;
    }).immediate();
  }

  readCommandSubmission(claim: RepairClaim): AdminSubmission | null {
    this.assertClaim(claim);
    const row = this.db.prepare('SELECT submission_json FROM admin_command_sessions WHERE attempt_id = ?')
      .get(claim.attempt.attemptId) as { submission_json: string | null } | undefined;
    return row?.submission_json ? adminSubmissionSchema.parse(JSON.parse(row.submission_json)) : null;
  }

  /** This API is only called by the management host, never by loop-admin. */
  /** Cheap fencing for streamed reads. Never reparse all frozen facts for
   * every file chunk; source authorization still occurs at plan gates. */
  assertIndependentVerificationClaim(claim: RepairClaim) {
    const attempt = this.assertClaim(claim);
    if (attempt.role !== 'verification' || this.getCase(attempt.caseId)?.status !== 'verifying') {
      throw new Error('当前代次不拥有独立验收权限');
    }
  }

  private requiredOriginalCoverage(caseId: string) {
    const count = (this.db.prepare(`SELECT COUNT(*) AS count FROM repair_observations WHERE ${requiredOriginalWhere}`)
      .get(caseId) as { count: number }).count;
    const observationIds = coveragePreview(this.db.prepare(`SELECT observation_id FROM repair_observations WHERE ${requiredOriginalWhere}
      ORDER BY created_at,observation_id LIMIT 16`).all(caseId) as { observation_id: string }[]);
    return { count, observationIds, hasMore: count > observationIds.length,
      readHint: 'Read complete observations via status.history and history read; cover every non-Admin original. repair-version-changed, repair-verification-coverage-missing and repair-runtime-cohort-changed are derived authority invalidations, not original acceptances. Focused diagnosis may cover a subset.' };
  }

  private assertOriginalCoverage(caseId: string, ids: string[]) {
    const missingWhere = `${requiredOriginalWhere} AND observation_id NOT IN (${ids.map(() => '?').join(',')})`;
    const count = (this.db.prepare(`SELECT COUNT(*) AS count FROM repair_observations WHERE ${missingWhere}`)
      .get(caseId, ...ids) as { count: number }).count;
    if (count) {
      const missing = coveragePreview(this.db.prepare(`SELECT observation_id FROM repair_observations WHERE ${missingWhere}
        ORDER BY created_at,observation_id LIMIT 16`).all(caseId, ...ids) as { observation_id: string }[]);
      throw new OriginalCoverageMissing(count, missing);
    }
  }

  repairWorkspaceAnchor(repairAttemptId: string) {
    const owned = this.commandActions(repairAttemptId).filter(action => action.status === 'completed'
      && action.action.kind === 'workspace-takeover' && action.result?.phase === 'owned');
    if (!owned.length) throw new Error('交还 / 独立验收缺少实际已完成的工作区接管');
    const anchors = owned.map(action => {
      if(action.action.kind!=='workspace-takeover')throw new Error('业务验收不能使用 Harness 源码目录代替工作区接管');
      const anchor = repairWorkspaceAnchorSchema.parse(action.result?.anchor);
      if (!workspaceAnchorContains(anchor, action.action.itemId, action.action.itemRevision)
        || anchor.workspaceRoot !== action.result?.workspaceRoot) throw new Error('接管锚点与实际完成动作不一致');
      return anchor;
    });
    if (new Set(anchors.map(anchor => JSON.stringify(anchor))).size !== 1) throw new Error('验收不能合并不同工作区或接管代次');
    return anchors[0];
  }

  /** Read the host's completed candidate/source records, not Agent proposals.
   * Native readers must additionally prove private paths, bytes and source. */
  harnessCandidateAnchor(repairAttemptId: string, artifactId: string) {
    const row = this.db.prepare('SELECT case_id FROM repair_attempts WHERE attempt_id=?').get(repairAttemptId) as {case_id:string}|undefined;
    const repair = row && this.caseAttempt(row.case_id,repairAttemptId);
    if (!repair || this.getCase(repair.caseId)?.scope !== 'runtime') throw new Error('runtime 验证缺少当前修复来源');
    const actions = this.commandActions(repairAttemptId);
    const candidates = actions.filter(action => action.action.kind === 'harness-build' && action.status === 'completed'
      && action.result?.phase === 'candidate-built' && (action.result.candidate as {artifactId?:string}|undefined)?.artifactId === artifactId);
    if (candidates.length !== 1) throw new Error('runtime 验证必须绑定唯一已完成的真实候选产物身份');
    const build = candidates[0];if(build.action.kind !== 'harness-build')throw new Error('runtime 构建动作类型错误');
    const buildAction = build.action;
    const source = actions.find(action => action.key === buildAction.workspaceKey);
    if (source?.action.kind !== 'harness-workspace' || source.status !== 'completed' || source.result?.phase !== 'prepared') throw new Error('runtime 候选缺少本轮准确源码来源');
    const candidate = runtimeArtifactSchema.parse(build.result?.candidate);
    const sourceArtifact = runtimeArtifactSchema.parse(source.result.sourceArtifact);
    const authorization = source.result.authorization as {caseId?:string;attemptId?:string;generation?:number;ownerId?:string;supervisionToken?:number;intentRevision?:number}|undefined;
    const original = this.db.prepare("SELECT evidence_json FROM repair_observations WHERE case_id=? AND observation_id=? AND origin='runtime'")
      .get(repair.caseId,source.action.observationId) as {evidence_json:string}|undefined;
    const receipts = build.result?.receipts as {stage?:string;exitCode?:number}[]|undefined;
    if (!original || JSON.stringify(originalRuntimeArtifact(JSON.parse(original.evidence_json))) !== JSON.stringify(sourceArtifact)
      || JSON.stringify(build.result?.sourceArtifact) !== JSON.stringify(sourceArtifact)
      || build.result?.sourceId !== candidate.sourceId || typeof build.result.frozenWorkspaceRoot !== 'string'
      || typeof build.result.workspaceRoot !== 'string' || build.result.workspaceRoot !== source.result.workspaceRoot
      || authorization?.caseId !== repair.caseId || authorization.attemptId !== repairAttemptId || authorization.generation !== repair.generation
      || authorization.ownerId !== repair.ownerId || authorization.supervisionToken !== repair.supervisionToken || authorization.intentRevision !== repair.intentRevision
      || !Array.isArray(receipts) || JSON.stringify(receipts.map(receipt=>receipt.stage)) !== JSON.stringify(['dependencies','tests','typescript','next-build','desktop-build'])
      || receipts.some(receipt=>receipt.exitCode !== 0)) throw new Error('runtime 候选的准确源码、代次或真实构建收据不一致');
    if(build.result?.reusedFrom!==undefined){
      const reused=build.result.reusedFrom as Record<string,unknown>;
      if(!reused||Object.keys(reused).sort().join(',')!=='attemptId,buildKey,candidateArtifactId,sourceId'
        ||reused.candidateArtifactId!==candidate.artifactId||reused.sourceId!==candidate.sourceId
        ||typeof reused.attemptId!=='string'||typeof reused.buildKey!=='string')throw new Error('runtime 候选复用来源无效');
      const origin=this.reusableHarnessCandidates(candidate.sourceId,repairAttemptId).find(value=>value.attemptId===reused.attemptId
        &&value.buildKey===reused.buildKey&&value.candidate.artifactId===reused.candidateArtifactId);
      if(!origin||JSON.stringify(origin.candidate)!==JSON.stringify(candidate)
        ||JSON.stringify(origin.receipts)!==JSON.stringify(receipts)||JSON.stringify(origin.toolchain)!==JSON.stringify(build.result.toolchain)) {
        throw new Error('runtime 候选复用的原始物理构建收据已失效');
      }
    }
    return { workspaceRoot: build.result.frozenWorkspaceRoot, candidate, sourceArtifact, buildKey: build.key,
      workspaceKey: buildAction.workspaceKey, sourceObservationId: source.action.observationId,
      generation: repair.generation, ownerId: repair.ownerId, supervisionToken: repair.supervisionToken, intentRevision: repair.intentRevision };
  }

  independentVerificationInput(claim: RepairClaim): IndependentVerificationInput {
    const attempt = this.assertClaim(claim);
    if (attempt.role !== 'verification' || this.getCase(attempt.caseId)?.status !== 'verifying') {
      throw new Error('独立验收上下文仅供当前验证执行读取');
    }
    const source = this.db.prepare(`SELECT attempt_id FROM repair_attempts WHERE case_id = ? AND role = 'investigation'
      AND generation < ? ORDER BY generation DESC LIMIT 1`).get(attempt.caseId, attempt.generation) as { attempt_id: string } | undefined;
    const repair = source && this.caseAttempt(attempt.caseId, source.attempt_id);
    const submissionRow = repair && this.db.prepare('SELECT submission_json FROM admin_command_sessions WHERE attempt_id = ?')
      .get(repair.attemptId) as { submission_json: string | null } | undefined;
    const submission = submissionRow?.submission_json ? adminSubmissionSchema.parse(JSON.parse(submissionRow.submission_json)) : null;
    if (!repair || repair.status !== 'completed' || !submission || submission.outcome === 'deferred') {
      throw new Error('独立验收缺少已完成的修复 / 诊断来源');
    }
    if (submission.outcome === 'verification-requested') this.assertOriginalCoverage(attempt.caseId, submission.originalObservationIds);
    const originalObservations = submission.originalObservationIds.map(id => {
      const row = this.db.prepare("SELECT observation_json FROM repair_observations WHERE case_id = ? AND observation_id = ? AND origin <> 'admin'")
        .get(attempt.caseId, id) as { observation_json: string } | undefined;
      if (!row) throw new Error('独立验收原始故障来源已失效');
      return observationSchema.parse(JSON.parse(row.observation_json)) as RepairObservation;
    });
    if (claim.repairCase.scope === 'runtime' && submission.outcome === 'verification-requested') {
      const {workspaceRoot,...runtimeBinding} = this.harnessCandidateAnchor(repair.attemptId,submission.repairVersion);
      return {kind:'runtime',sourceRepairAttemptId:repair.attemptId,workspaceRoot,runtimeBinding,
        expectedVersion:runtimeBinding.candidate.artifactId,originalObservations};
    }
    const anchor = this.repairWorkspaceAnchor(repair.attemptId);
    const business = originalObservations.filter(observation => observation.origin === 'business');
    if (!business.length || business.some(observation => {
      const item = observation.evidence.item as { item_id?: string; revision?: number } | null;
      return observation.evidence.taskId !== anchor.taskId || !item?.item_id
        || !workspaceAnchorContains(anchor, item.item_id, item.revision);
    })) {
      throw new Error('独立验收工作区与原始需求 / 工作项来源不一致');
    }
    return { sourceRepairAttemptId: repair.attemptId, workspaceRoot: anchor.workspaceRoot,
      workspaceBinding: { taskId: anchor.taskId, itemId: anchor.itemId, itemRevision: anchor.itemRevision,
        itemEpoch: anchor.itemEpoch,
        generation: repair.generation, ownerId: repair.ownerId, supervisionToken: repair.supervisionToken },
      expectedVersion: submission.outcome === 'verification-requested' ? submission.repairVersion : submission.baselineVersion,
      originalObservations };
  }

  /** Preparing checks is an independent physical execution, but not a pass.
   * Record before process settlement so host loss can resume without another
   * model call. Native verification re-authorizes and executes this same plan. */
  recordVerificationPreparation(claim: RepairClaim, input: IndependentVerificationInput, proposed: RepairVerificationPlan,
    artifacts: import('../domain/verification-artifacts').VerificationArtifactManifest) {
    return this.db.transaction(() => {
      const current = this.independentVerificationInput(claim);
      if (independentPreparationHash(current) !== independentPreparationHash(input)) throw new Error('独立验收准备来源发生变化');
      authorizePreparedVerification(current, { reproduction: proposed.reproduction, acceptanceChecks: proposed.acceptanceChecks }, proposed.versionCommand);
      const plan = this.recordVerificationPlan(claim, proposed);
      const prior = this.db.prepare('SELECT input_hash,workspace_root,plan_json FROM repair_verification_preparations WHERE attempt_id = ?')
        .get(claim.attempt.attemptId) as { input_hash: string; workspace_root: string; plan_json: string } | undefined;
      const hash = independentPreparationHash(input);
      const json = JSON.stringify(plan);
      if (prior && (prior.input_hash !== hash || prior.workspace_root !== input.workspaceRoot || prior.plan_json !== json)) {
        throw new Error('不能改写已保存的独立验收准备');
      }
      if (!prior) this.db.prepare(`INSERT INTO repair_verification_preparations
        (attempt_id,source_repair_attempt_id,input_hash,workspace_root,plan_json,created_at) VALUES(?,?,?,?,?,?)`)
        .run(claim.attempt.attemptId, input.sourceRepairAttemptId, hash, input.workspaceRoot, json, this.now());
      const artifactJson = JSON.stringify(artifacts);
      const priorArtifacts = this.db.prepare('SELECT manifest_json FROM repair_verification_artifacts WHERE attempt_id = ?')
        .get(claim.attempt.attemptId) as { manifest_json: string } | undefined;
      if (priorArtifacts && priorArtifacts.manifest_json !== artifactJson) throw new Error('不能改写已冻结的独立验收输入清单');
      if (!priorArtifacts) this.db.prepare('INSERT INTO repair_verification_artifacts(attempt_id,manifest_json) VALUES(?,?)')
        .run(claim.attempt.attemptId, artifactJson);
      return plan;
    }).immediate();
  }

  preparedVerificationPlan(claim: RepairClaim) {
    const input = this.independentVerificationInput(claim);
    const row = this.db.prepare(`SELECT preparation.plan_json,preparation.workspace_root,artifacts.manifest_json FROM repair_verification_preparations preparation
      JOIN repair_attempts attempt USING(attempt_id)
      LEFT JOIN repair_verification_artifacts artifacts USING(attempt_id) WHERE attempt.case_id = ? AND attempt.status = 'completed'
      AND preparation.source_repair_attempt_id = ? AND preparation.input_hash = ?
      ORDER BY attempt.generation DESC LIMIT 1`).get(claim.repairCase.caseId, input.sourceRepairAttemptId,
        independentPreparationHash(input)) as { plan_json: string; workspace_root: string; manifest_json: string | null } | undefined;
    if (row && !row.manifest_json) throw new Error('历史独立验收计划缺少冻结输入清单，需要重新调查准备');
    return row ? { plan: repairVerificationPlanSchema.parse(JSON.parse(row.plan_json)), workspaceRoot: row.workspace_root,
      ...(input.kind==='runtime'?{runtimeArtifact:input.runtimeBinding.candidate}:{}),
      artifacts: JSON.parse(row.manifest_json!) as import('../domain/verification-artifacts').VerificationArtifactManifest } : null;
  }

  finishVerificationPreparation(claim: RepairClaim, exitConfirmed: boolean) {
    return this.db.transaction(() => {
      const attempt = this.assertClaim(claim);
      return this.applyVerificationPreparation(attempt, exitConfirmed);
    }).immediate();
  }

  recordVerificationSourceLoss(claim: RepairClaim, reason: string) {
    return this.db.transaction(() => {
      const attempt = this.assertClaim(claim);
      if (attempt.role !== 'verification') throw new Error('验收来源失效只能由当前独立验证记录');
      this.recordEvidence(claim, 'independent-source-lost', 'finding', { reason });
      this.db.prepare("UPDATE repair_cases SET status = 'queued',last_error = ?,updated_at = ? WHERE case_id = ?")
        .run(reason, this.now(), attempt.caseId);
      // Keep the physical attempt until actual exit; do not alter saved plans
      // or receipts, and do not invent a new original acceptance target.
    }).immediate();
  }

  private applyVerificationPreparation(attempt: RepairAttempt, exitConfirmed: boolean) {
    if (!exitConfirmed || attempt.role !== 'verification' || this.getCase(attempt.caseId)?.status !== 'verifying'
      || !this.db.prepare('SELECT 1 FROM repair_verification_preparations WHERE attempt_id = ?').get(attempt.attemptId)
      || this.verificationReceipt(attempt.attemptId)) return false;
    const row = this.db.prepare('SELECT plan_json FROM repair_verifications WHERE attempt_id=?').get(attempt.attemptId) as { plan_json: string } | undefined;
    if (row && this.verificationPurpose(attempt.attemptId) === 'repair-verification'
      && this.rejectIncompleteSavedCoverage(attempt, repairVerificationPlanSchema.parse(JSON.parse(row.plan_json)).originalObservationIds)) return true;
    this.db.prepare("UPDATE repair_attempts SET status = 'completed',finished_at = ?,last_error = ? WHERE attempt_id = ?")
      .run(this.now(), '独立验收计划已保存；尚未执行验收，不能交还或关闭', attempt.attemptId);
    this.db.prepare('UPDATE repair_cases SET current_attempt_id = NULL,updated_at = ? WHERE case_id = ?').run(this.now(), attempt.caseId);
    return true;
  }

  recordVerificationPlan(claim: RepairClaim, input: unknown): RepairVerificationPlan {
    const plan = repairVerificationPlanSchema.parse(input);
    return this.db.transaction(() => {
      const attempt = this.assertClaim(claim);
      if (attempt.role !== 'verification') throw new Error('修复执行不能授权自己的验证计划');
      if (this.getCase(attempt.caseId)?.status !== 'verifying') throw new Error('新的故障证据已使原验证计划失效');
      const source = this.attempts(attempt.caseId).filter(row => row.role === 'investigation' && row.generation < attempt.generation).at(-1);
      if (!source || source.status !== 'completed' || source.attemptId !== plan.sourceRepairAttemptId) throw new Error('验证计划未绑定最近已完成的独立修复执行');
      const session = this.db.prepare('SELECT submission_json FROM admin_command_sessions WHERE attempt_id = ?')
        .get(source.attemptId) as { submission_json: string | null } | undefined;
      const submission = session?.submission_json ? adminSubmissionSchema.parse(JSON.parse(session.submission_json)) : null;
      const requestedVersion = submission?.outcome === 'verification-requested' ? submission.repairVersion
        : submission?.outcome === 'diagnosis-requested' ? submission.baselineVersion : null;
      if (!submission || requestedVersion !== plan.expectedVersion
        || !('originalObservationIds' in submission)
        || JSON.stringify([...submission.originalObservationIds].sort()) !== JSON.stringify([...plan.originalObservationIds].sort())) {
        throw new Error('验证计划的版本或原始失败来源与修复提交不一致');
      }
      if (submission.outcome === 'verification-requested') this.assertOriginalCoverage(attempt.caseId, plan.originalObservationIds);
      const json = JSON.stringify(plan);
      const prior = this.db.prepare('SELECT plan_json FROM repair_verifications WHERE attempt_id = ?').get(attempt.attemptId) as { plan_json: string } | undefined;
      if (prior && prior.plan_json !== json) throw new Error('不能改写已授权的独立验证计划');
      if (!prior) this.db.prepare('INSERT INTO repair_verifications(attempt_id,source_repair_attempt_id,plan_json,created_at) VALUES(?,?,?,?)')
        .run(attempt.attemptId, source.attemptId, json, this.now());
      const purpose = submission.outcome === 'diagnosis-requested' ? 'diagnosis' : 'repair-verification';
      const priorPurpose = this.db.prepare('SELECT purpose FROM repair_verification_purposes WHERE attempt_id = ?').get(attempt.attemptId) as { purpose: string } | undefined;
      if (priorPurpose && priorPurpose.purpose !== purpose) throw new Error('不能把诊断计划改成修复验证');
      if (!priorPurpose) this.db.prepare('INSERT INTO repair_verification_purposes(attempt_id,purpose) VALUES(?,?)').run(attempt.attemptId, purpose);
      return plan;
    }).immediate();
  }

  verificationReceipt(attemptId: string): RepairVerificationReceipt | null {
    const row = this.db.prepare('SELECT receipt_json FROM repair_verifications WHERE attempt_id = ?').get(attemptId) as { receipt_json: string | null } | undefined;
    return row?.receipt_json ? repairVerificationReceiptSchema.parse(JSON.parse(row.receipt_json)) : null;
  }

  verificationPurpose(attemptId: string): 'diagnosis' | 'repair-verification' {
    const row = this.db.prepare('SELECT purpose FROM repair_verification_purposes WHERE attempt_id = ?').get(attemptId) as
      { purpose: 'diagnosis' | 'repair-verification' } | undefined;
    if (row) return row.purpose;
    const source = this.db.prepare(`SELECT session.submission_json FROM repair_verifications verification
      JOIN admin_command_sessions session ON session.attempt_id = verification.source_repair_attempt_id
      WHERE verification.attempt_id = ?`).get(attemptId) as { submission_json: string | null } | undefined;
    const submitted = source?.submission_json ? adminSubmissionSchema.parse(JSON.parse(source.submission_json)) : null;
    // Old verification records keep their purpose, but missing metadata must
    // never upgrade a persisted diagnostic request to repair authority.
    return submitted?.outcome === 'diagnosis-requested' ? 'diagnosis' : 'repair-verification';
  }

  diagnosisHistory(caseId: string) {
    const rows = this.db.prepare(`SELECT purpose.attempt_id AS attemptId,round.novel FROM repair_verification_purposes purpose
      JOIN repair_attempts attempt USING(attempt_id) LEFT JOIN repair_diagnosis_rounds round USING(attempt_id)
      WHERE attempt.case_id = ? AND purpose.purpose = 'diagnosis' ORDER BY attempt.generation`).all(caseId) as
      { attemptId: string; novel: number | null }[];
    return rows.map(row => this.diagnosisHistoryRow(row));
  }

  private diagnosisHistoryRow(row: { attemptId: string; novel: number | null }) {
    const receipt = this.verificationReceipt(row.attemptId);
    return { ...row, version: receipt?.plan.expectedVersion ?? null,
      checks: receipt?.checks.map((check, index) => ({ kind: check.kind, targetRef: check.targetRef,
        exitCode: check.result.exitCode, exitConfirmed: check.result.exitConfirmed, evidenceKey: `verification-check-${index}` })) || [] };
  }

  verifiedContext(authority: AdminAuthority, caseId: string) {
    this.assertAuthority(authority, true);
    return this.verifiedContextFacts(caseId);
  }

  private verifiedContextFacts(caseId:string) {
    const repairCase = this.getCase(caseId);
    const attempts = this.attempts(caseId);
    const verification = attempts.find(row => row.generation === repairCase?.generation);
    const receipt = verification ? this.verificationReceipt(verification.attemptId) : null;
    const repair = receipt ? attempts.find(row => row.attemptId === receipt.plan.sourceRepairAttemptId) : undefined;
    if (!repairCase || repairCase.status !== 'observing' || repairCase.currentAttemptId !== null
      || !verification || verification.role !== 'verification' || verification.status !== 'completed'
      || this.verificationPurpose(verification.attemptId) !== 'repair-verification'
      || !receipt?.passed || !repair || repair.role !== 'investigation' || repair.status !== 'completed'
      || attempts.some(row => ['launching', 'running'].includes(row.status))) {
      throw new Error('修复交还必须有当前代次独立验证和全部管理进程退出证明');
    }
    this.assertOriginalCoverage(caseId, receipt.plan.originalObservationIds);
    return { repairCase, verification, receipt, repair };
  }

  observingCases(authority: AdminAuthority) {
    this.assertAuthority(authority, true);
    const rows = this.db.prepare("SELECT case_id FROM repair_cases WHERE status = 'observing' AND current_attempt_id IS NULL ORDER BY updated_at,case_id").all() as { case_id: string }[];
    return rows.map(row => this.getCase(row.case_id)!);
  }

  /** Host-only transition input. A repair proposal, build or focused diagnosis
   * is not authority to replace the selected runtime. */
  verifiedRuntimeUpdateInput(authority: AdminAuthority, caseId: string) {
    const context = this.verifiedContext(authority, caseId);
    return this.verifiedRuntimeUpdateFacts(context);
  }

  private verifiedRuntimeUpdateFacts(context:ReturnType<AdminManagementStore['verifiedContext']>) {
    const caseId=context.repairCase.caseId;
    if (context.repairCase.scope !== 'runtime') throw new Error('运行版本切换仅限已独立验证的 runtime 修复');
    const { workspaceRoot, ...runtimeBinding } = this.harnessCandidateAnchor(context.repair.attemptId, context.receipt.plan.expectedVersion);
    const originalObservations = context.receipt.plan.originalObservationIds.map(id => {
      const row = this.db.prepare("SELECT observation_json FROM repair_observations WHERE case_id=? AND observation_id=? AND origin<>'admin'")
        .get(caseId,id) as {observation_json:string}|undefined;
      if (!row) throw new Error('运行版本切换的原始故障记录缺失');
      return observationSchema.parse(JSON.parse(row.observation_json)) as RepairObservation;
    });
    const input: IndependentVerificationInput = {kind:'runtime',sourceRepairAttemptId:context.repair.attemptId,
      workspaceRoot,runtimeBinding,expectedVersion:runtimeBinding.candidate.artifactId,originalObservations};
    authorizePreparedVerification(input,{reproduction:context.receipt.plan.reproduction,
      acceptanceChecks:context.receipt.plan.acceptanceChecks},context.receipt.plan.versionCommand);
    return {input,verificationAttemptId:context.verification.attemptId,
      updateId:`repair-${createHash('sha256').update(context.verification.attemptId).digest('hex')}`};
  }

  /** Atomic admission after native private-source/actual-byte checks. This
   * persists an external switch request, never completion or business progress. */
  beginVerifiedRuntimeUpdate(authority: AdminAuthority, caseId: string, verificationAttemptId: string) {
    return this.db.transaction(() => {
      const target = this.verifiedRuntimeUpdateInput(authority,caseId);
      if (target.verificationAttemptId !== verificationAttemptId) throw new Error('运行版本切换的独立验证代次已改变');
      const prior = this.runtimeUpdate(target.updateId);
      if (prior) return prior; // A rolled-back/aborted request is evidence, not permission to retry the same switch.
      if (target.input.kind !== 'runtime') throw new Error('运行版本切换来源类型错误');
      if (this.attempts().some(row=>['launching','running'].includes(row.status)) || this.adminBusinessWorkers(true).length)
        throw new Error('管理执行或能力进程尚未实际退出，禁止运行版本切换');
      const before = this.runtimeInstallation()?.artifact;
      if (!before || JSON.stringify(before) !== JSON.stringify(target.input.runtimeBinding.sourceArtifact))
        throw new Error('已验证修复的原安装与当前运行版本选择不一致');
      const baseline=runtimeRepairBaselineSchema.parse({
        previousHostAllocationIds:this.runtimeHostProcesses().filter(row=>row.status!=='exited').map(row=>row.allocationId),
        previousUpdateAllocationIds:this.liveRuntimeUpdateProcesses().map(row=>row.allocationId),
        previousCliAllocationIds:this.runtimeHostProcesses().filter(row=>row.status!=='exited')
          .flatMap(host=>this.runtimeCliProcesses(host.allocationId).filter(row=>row.status!=='exited').map(row=>row.allocationId)),
        hostSequence:(this.db.prepare('SELECT COALESCE(MAX(rowid),0) AS value FROM admin_runtime_host_processes').get() as {value:number}).value,
      });
      const update=this.beginRuntimeUpdate({updateId:target.updateId,caseId,before,candidate:target.input.runtimeBinding.candidate});
      this.db.prepare('INSERT INTO repair_runtime_update_baselines(verification_attempt_id,case_id,update_id,baseline_json,created_at) VALUES(?,?,?,?,?)')
        .run(verificationAttemptId,caseId,target.updateId,JSON.stringify(baseline),this.now());
      return update;
    }).immediate();
  }

  runtimeRepairHandoff(verificationAttemptId:string):RuntimeRepairHandoff|null {
    const latest=this.db.prepare('SELECT payload_json FROM repair_runtime_handoff_generations WHERE verification_attempt_id=? ORDER BY rowid DESC LIMIT 1')
      .get(verificationAttemptId) as {payload_json:string}|undefined;
    const row=latest??this.db.prepare('SELECT payload_json FROM repair_runtime_handoffs WHERE verification_attempt_id=?')
      .get(verificationAttemptId) as {payload_json:string}|undefined;
    return row?runtimeRepairHandoffSchema.parse(JSON.parse(row.payload_json)):null;
  }

  runtimeRepairUpdateNeedsBusinessBaseline(updateId:string) {
    return Boolean(this.db.prepare('SELECT 1 FROM repair_runtime_update_baselines WHERE update_id=?').get(updateId));
  }

  runtimeBusinessBaseline(verificationAttemptId:string):RuntimeBusinessBaseline|null {
    const row=this.db.prepare('SELECT payload_json FROM repair_runtime_business_baselines WHERE verification_attempt_id=?')
      .get(verificationAttemptId) as {payload_json:string}|undefined;
    return row?runtimeBusinessBaselineSchema.parse(JSON.parse(row.payload_json)):null;
  }

  /** Stable Root-only snapshot admission. Normal management authority remains
   * strict; only this read capability may operate during the stopping phase. */
  runtimeBusinessBaselineTarget(root:RuntimeHostAuthority,management:AdminAuthority,updateId:string) {
    this.assertRuntimeHost(root);const control=this.assertAuthority(management,false);
    if(management.ownerId!==`${root.ownerId}:management`||control.desired_intent!=='running'||control.management_mode!=='update-silence')
      throw new Error('原业务基线必须由更新静默中的当前 Root 读取');
    const update=this.activeRuntimeUpdate();
    if(!update||update.request.updateId!==updateId||update.phase!=='stopping'||update.intentRevision!==control.intent_revision)
      throw new Error('原业务基线的实际更新阶段或运行意图已改变');
    this.assertRuntimeUpdate({updateId,ownerId:root.ownerId,token:update.token});
    const row=this.db.prepare('SELECT case_id,verification_attempt_id,baseline_json FROM repair_runtime_update_baselines WHERE update_id=?')
      .get(updateId) as {case_id:string;verification_attempt_id:string;baseline_json:string}|undefined;
    if(!row)return null; // Publisher updates do not invent a repair Case.
    const context=this.verifiedContextFacts(row.case_id),target=this.verifiedRuntimeUpdateFacts(context);
    if(target.updateId!==updateId||target.verificationAttemptId!==row.verification_attempt_id
      ||JSON.stringify(target.input.runtimeBinding.candidate)!==JSON.stringify(update.request.candidate)
      ||JSON.stringify(this.runtimeInstallation()?.artifact)!==JSON.stringify(update.request.before))
      throw new Error('原业务基线与独立验证、候选或原安装来源不一致');
    if(this.runtimeHostProcesses().some(host=>host.status!=='exited')||this.liveRuntimeUpdateProcesses().length
      ||this.attempts().some(attempt=>['launching','running'].includes(attempt.status)))
      throw new Error('旧普通/更新/管理进程尚未退出，不能冻结原业务基线');
    const physical=runtimeRepairBaselineSchema.parse(JSON.parse(row.baseline_json));
    const hosts=physical.previousHostAllocationIds.map(id=>{
      const host=this.runtimeHostProcesses().find(host=>host.allocationId===id);
      if(!host||host.status!=='exited')throw new Error('原业务基线的旧宿主退出记录缺失');return host;
    });
    const updates=physical.previousUpdateAllocationIds.map(id=>{
      const held=this.runtimeUpdateProcessAllocation(id);
      if(!held||held.status!=='exited')throw new Error('原业务基线的旧更新退出记录缺失');return held;
    });
    const allClis=hosts.flatMap(host=>this.runtimeCliProcesses(host.allocationId));
    if(allClis.some(cli=>cli.status!=='exited')||physical.previousCliAllocationIds.some(id=>!allClis.some(cli=>cli.allocationId===id)))
      throw new Error('原业务基线的旧 CLI 尚未退出或记录缺失');
    const clis=physical.previousCliAllocationIds.map(id=>allClis.find(cli=>cli.allocationId===id)!);
    const times=target.input.originalObservations.map(original=>{
      const saved=this.db.prepare('SELECT created_at FROM repair_observations WHERE case_id=? AND observation_id=?')
        .get(row.case_id,original.observationId) as {created_at:number}|undefined;
      if(!saved||!Number.isSafeInteger(saved.created_at)||saved.created_at<0)throw new Error('原故障缺少可信的持久化时间范围');
      return saved.created_at;
    });
    if(!times.length)throw new Error('原业务基线不能缺少原始故障时间');
    const originalBoundaryMs=times.reduce((latest,time)=>Math.max(latest,time),0);
    const originalStartBoundaryMs=times.reduce((earliest,time)=>Math.min(earliest,time),originalBoundaryMs);
    return {binding:{caseId:row.case_id,verificationAttemptId:row.verification_attempt_id,updateId,
      candidateArtifact:update.request.candidate,originalBoundaryMs,originalStartBoundaryMs},input:target.input,predecessors:[...hosts,...updates],clis};
  }

  recordRuntimeBusinessBaseline(root:RuntimeHostAuthority,management:AdminAuthority,updateId:string,input:unknown) {
    const baseline=runtimeBusinessBaselineSchema.parse(input);
    return this.db.transaction(()=>{
      const target=this.runtimeBusinessBaselineTarget(root,management,updateId);
      if(!target||baseline.caseId!==target.binding.caseId||baseline.verificationAttemptId!==target.binding.verificationAttemptId
        ||baseline.updateId!==updateId||baseline.originalBoundaryMs!==target.binding.originalBoundaryMs
        ||baseline.originalStartBoundaryMs!==target.binding.originalStartBoundaryMs
        ||JSON.stringify(baseline.candidateArtifact)!==JSON.stringify(target.binding.candidateArtifact))
        throw new Error('原业务基线不能改写独立验证和版本来源');
      const prior=this.runtimeBusinessBaseline(baseline.verificationAttemptId);
      if(prior){if(JSON.stringify(prior)!==JSON.stringify(baseline))throw new Error('原业务基线已冻结，不允许重拍覆盖');return prior;}
      this.db.prepare('INSERT INTO repair_runtime_business_baselines(verification_attempt_id,case_id,update_id,payload_json,created_at) VALUES(?,?,?,?,?)')
        .run(baseline.verificationAttemptId,baseline.caseId,updateId,JSON.stringify(baseline),this.now());
      return baseline;
    }).immediate();
  }

  assertRuntimeBusinessBaselineReady(update:RuntimeUpdateRecord) {
    const row=this.db.prepare('SELECT case_id,verification_attempt_id FROM repair_runtime_update_baselines WHERE update_id=?')
      .get(update.request.updateId) as {case_id:string;verification_attempt_id:string}|undefined;
    if(!row)return;
    const baseline=this.runtimeBusinessBaseline(row.verification_attempt_id);
    if(!baseline||baseline.updateId!==update.request.updateId||baseline.caseId!==row.case_id
      ||JSON.stringify(baseline.candidateArtifact)!==JSON.stringify(update.request.candidate))
      throw new Error('已验证的运行修复尚未冻结原业务基线，禁止候选启动');
  }

  runtimeRepairHandoffHistory(verificationAttemptId:string):RuntimeRepairHandoff[] {
    const first=this.db.prepare('SELECT payload_json FROM repair_runtime_handoffs WHERE verification_attempt_id=?')
      .get(verificationAttemptId) as {payload_json:string}|undefined;
    const rows=this.db.prepare('SELECT payload_json FROM repair_runtime_handoff_generations WHERE verification_attempt_id=? ORDER BY rowid')
      .all(verificationAttemptId) as {payload_json:string}[];
    const history=[...(first?[first]:[]),...rows].map(row=>runtimeRepairHandoffSchema.parse(JSON.parse(row.payload_json)));
    const seen=new Set<string>();
    return history.filter(receipt=>{if(seen.has(receipt.hostAllocationId))return false;seen.add(receipt.hostAllocationId);return true;});
  }

  runtimeRepairHandoffTarget(authority:AdminAuthority,caseId:string) {
    const target=this.verifiedRuntimeUpdateInput(authority,caseId),update=this.runtimeUpdate(target.updateId);
    if(!update||update.phase!=='succeeded')return null;
    const installation=this.runtimeInstallation();
    if(!installation||installation.updateId!==target.updateId||JSON.stringify(installation.artifact)!==JSON.stringify(update.request.candidate))
      throw new Error('运行修复交还的实际安装选择已改变');
    const row=this.db.prepare('SELECT baseline_json FROM repair_runtime_update_baselines WHERE verification_attempt_id=? AND case_id=? AND update_id=?')
      .get(target.verificationAttemptId,caseId,target.updateId) as {baseline_json:string}|undefined;
    if(!row)throw new Error('运行修复交还缺少切换前不可变宿主基线');
    const baseline=runtimeRepairBaselineSchema.parse(JSON.parse(row.baseline_json));
    const hosts=this.runtimeHostProcesses(),host=hosts.find(row=>row.status==='ready');
    if(!host)return null;
    this.assertRuntimeHost(host.authority);
    const sequence=(this.db.prepare('SELECT rowid AS value FROM admin_runtime_host_processes WHERE allocation_id=?').get(host.allocationId) as {value:number}).value;
    const contract=this.db.prepare('SELECT certified,draining FROM admin_runtime_cli_hosts WHERE host_allocation_id=?')
      .get(host.allocationId) as {certified:number;draining:number}|undefined;
    if(sequence<=baseline.hostSequence||!host.pid||!host.marker||!host.groupId||!host.businessSupervisionToken
      ||!contract?.certified||contract.draining||JSON.stringify(host.artifact)!==JSON.stringify(installation.artifact))
      throw new Error('运行修复交还缺少新普通宿主、实际身份或 CLI 登记协议');
    if(this.liveRuntimeUpdateProcesses().length)throw new Error('持有式更新进程尚未实际退出，禁止交还');
    const previousHosts=baseline.previousHostAllocationIds.map(id=>{
      const record=hosts.find(row=>row.allocationId===id);
      if(!record||record.status!=='exited'||this.runtimeCliProcesses(id).some(cli=>cli.status!=='exited'))
        throw new Error('原普通宿主或 CLI 尚未实际退出，禁止交还');
      return record;
    });
    const previousUpdates=[...new Set([...baseline.previousUpdateAllocationIds,...this.runtimeUpdateProcesses(target.updateId).map(row=>row.allocationId)])].map(id=>{
      const record=this.runtimeUpdateProcessAllocation(id);
      if(!record||record.status!=='exited')throw new Error('原更新分配尚未实际退出，禁止交还');
      return record;
    });
    const previousClis=baseline.previousCliAllocationIds.map(id=>{
      const record=previousHosts.flatMap(host=>this.runtimeCliProcesses(host.allocationId)).find(row=>row.allocationId===id);
      if(!record||record.status!=='exited')throw new Error('原 CLI 分配尚未实际退出，禁止交还');
      return record;
    });
    const receipt=runtimeRepairHandoffSchema.parse({caseId,verificationAttemptId:target.verificationAttemptId,updateId:target.updateId,
      artifact:installation.artifact,installationRevision:installation.revision,hostAllocationId:host.allocationId,hostSequence:sequence,
      rootOwnerId:host.authority.ownerId,rootToken:host.authority.token,pid:host.pid,marker:host.marker,groupId:host.groupId,
      parentPid:host.parentPid,businessSupervisionToken:host.businessSupervisionToken});
    return {receipt,host,predecessors:[...previousHosts,...previousUpdates],previousClis,input:target.input};
  }

  recordRuntimeRepairHandoff(authority:AdminAuthority,caseId:string,input:RuntimeRepairHandoff) {
    const receipt=runtimeRepairHandoffSchema.parse(input);
    return this.db.transaction(()=>{
      const target=this.runtimeRepairHandoffTarget(authority,caseId);
      if(!target||JSON.stringify(target.receipt)!==JSON.stringify(receipt))throw new Error('运行修复交还物理来源或代次已改变');
      const saved=this.db.prepare('SELECT payload_json FROM repair_runtime_handoff_generations WHERE verification_attempt_id=? AND host_allocation_id=?')
        .get(receipt.verificationAttemptId,receipt.hostAllocationId) as {payload_json:string}|undefined;
      const initial=this.runtimeRepairHandoff(receipt.verificationAttemptId);
      const prior=saved?runtimeRepairHandoffSchema.parse(JSON.parse(saved.payload_json)):
        initial?.hostAllocationId===receipt.hostAllocationId?initial:null;
      if(prior){if(JSON.stringify(prior)!==JSON.stringify(receipt))throw new Error('不能改写运行修复交还收据');return prior;}
      if(!this.runtimeRepairHandoff(receipt.verificationAttemptId))this.db.prepare('INSERT INTO repair_runtime_handoffs(verification_attempt_id,case_id,payload_json,created_at) VALUES(?,?,?,?)')
          .run(receipt.verificationAttemptId,caseId,JSON.stringify(receipt),this.now());
      this.db.prepare('INSERT INTO repair_runtime_handoff_generations(verification_attempt_id,host_allocation_id,case_id,payload_json,created_at) VALUES(?,?,?,?,?)')
        .run(receipt.verificationAttemptId,receipt.hostAllocationId,caseId,JSON.stringify(receipt),this.now());
      return receipt;
    }).immediate();
  }

  runtimeBusinessProgressHistory(verificationAttemptId:string):RuntimeBusinessProgressCandidate[] {
    return (this.db.prepare('SELECT payload_json FROM repair_runtime_business_progress WHERE verification_attempt_id=? ORDER BY rowid')
      .all(verificationAttemptId) as {payload_json:string}[]).map(row=>runtimeBusinessProgressCandidateSchema.parse(JSON.parse(row.payload_json)));
  }

  runtimeBusinessProgressClosure(verificationAttemptId:string):RuntimeBusinessProgressCandidate[]|null {
    const row=this.db.prepare('SELECT payload_json FROM repair_runtime_business_closures WHERE verification_attempt_id=?')
      .get(verificationAttemptId) as {payload_json:string}|undefined;
    return row?z.array(runtimeBusinessProgressCandidateSchema).min(1).parse(JSON.parse(row.payload_json)):null;
  }

  runtimeOriginalOperationReceipt(verificationAttemptId:string):RuntimeOriginalOperationReceipt|null {
    const row=this.db.prepare('SELECT payload_json FROM repair_runtime_original_operations WHERE verification_attempt_id=?')
      .get(verificationAttemptId) as {payload_json:string}|undefined;
    return row?runtimeOriginalOperationReceiptSchema.parse(JSON.parse(row.payload_json)):null;
  }

  /** Metadata authorizes the independent native observer, never proves exit.
   * Every saved host generation remains attributable after ordinary restarts. */
  runtimeBusinessProgressTarget(authority:AdminAuthority,caseId:string) {
    const target=this.runtimeRepairHandoffTarget(authority,caseId);
    if(!target)return null;
    const {receipt}=target,baseline=this.runtimeBusinessBaseline(receipt.verificationAttemptId);
    const handoffs=this.runtimeRepairHandoffHistory(receipt.verificationAttemptId);
    if(!baseline||baseline.caseId!==caseId||baseline.updateId!==receipt.updateId
      ||JSON.stringify(baseline.candidateArtifact)!==JSON.stringify(receipt.artifact))throw new Error('业务恢复缺少不可变原需求基线');
    if(JSON.stringify(this.runtimeRepairHandoff(receipt.verificationAttemptId))!==JSON.stringify(receipt))return null;
    const hosts=this.runtimeHostProcesses();
    for(const handoff of handoffs){
      const host=hosts.find(row=>row.allocationId===handoff.hostAllocationId);
      const sequence=this.db.prepare('SELECT rowid AS value FROM admin_runtime_host_processes WHERE allocation_id=?')
        .get(handoff.hostAllocationId) as {value:number}|undefined;
      if(handoff.caseId!==caseId||handoff.verificationAttemptId!==baseline.verificationAttemptId||handoff.updateId!==baseline.updateId
        ||JSON.stringify(handoff.artifact)!==JSON.stringify(baseline.candidateArtifact)||!host||sequence?.value!==handoff.hostSequence
        ||host.pid!==handoff.pid||host.marker!==handoff.marker||host.groupId!==handoff.groupId||host.parentPid!==handoff.parentPid
        ||host.businessSupervisionToken!==handoff.businessSupervisionToken||host.authority.ownerId!==handoff.rootOwnerId
        ||host.authority.token!==handoff.rootToken||JSON.stringify(host.artifact)!==JSON.stringify(handoff.artifact))
        throw new Error('业务恢复的历史物理交还来源已改变');
    }
    return {...target,baseline,handoffs,clis:handoffs.flatMap(row=>this.runtimeCliProcesses(row.hostAllocationId))};
  }

  private assertRuntimeBusinessProgressCandidate(target:NonNullable<ReturnType<AdminManagementStore['runtimeBusinessProgressTarget']>>,
    candidate:RuntimeBusinessProgressCandidate) {
    const task=target.baseline.tasks.find(row=>row.taskId===candidate.taskId);
    const item=task?.items.find(row=>row.itemId===candidate.itemId);
    if(!item||item.revision!==candidate.itemRevision||item.dispatchEpoch>candidate.dispatchEpoch
      ||item.previousExecutionIds.includes(candidate.executionId)
      ||!target.handoffs.some(row=>JSON.stringify(row)===JSON.stringify(candidate.handoff))
      ||!target.clis.some(row=>JSON.stringify(row)===JSON.stringify(candidate.cli)))
      throw new Error('业务恢复证据不是原需求在已交还版本上的新实际执行');
  }

  recordRuntimeBusinessProgress(authority:AdminAuthority,caseId:string,input:unknown) {
    const candidate=runtimeBusinessProgressCandidateSchema.parse(input);
    return this.db.transaction(()=>{
      const target=this.runtimeBusinessProgressTarget(authority,caseId);
      if(!target)throw new Error('业务恢复尚未物理交还');
      this.assertRuntimeBusinessProgressCandidate(target,candidate);
      const key=[target.baseline.verificationAttemptId,candidate.taskId,candidate.executionId,candidate.resultId,candidate.completionEventId];
      const prior=this.db.prepare(`SELECT payload_json FROM repair_runtime_business_progress WHERE
        verification_attempt_id=? AND task_id=? AND execution_id=? AND result_id=? AND completion_event_id=?`).get(...key) as {payload_json:string}|undefined;
      const json=JSON.stringify(candidate);
      if(prior){if(prior.payload_json!==json)throw new Error('不能改写已保存的业务恢复证据');return false;}
      this.db.prepare(`INSERT INTO repair_runtime_business_progress
        (verification_attempt_id,task_id,execution_id,result_id,completion_event_id,case_id,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?)`)
        .run(...key,caseId,json,this.now());return true;
    }).immediate();
  }

  runtimeBusinessDispatchWatches(verificationAttemptId:string) {
    return this.db.prepare('SELECT task_id,source_key,intent_revision,readiness,eligible_elapsed_ms,last_sample_at FROM repair_runtime_dispatch_watches WHERE verification_attempt_id=? ORDER BY task_id')
      .all(verificationAttemptId) as Array<{task_id:string;source_key:string;intent_revision:number;readiness:string;eligible_elapsed_ms:number;last_sample_at:number}>;
  }

  /** Native observer supplies one complete, fresh original-cohort snapshot.
   * History is durable, but only continuously eligible time counts. An Agent
   * has no command for this sampling or for completing an original step. */
  sampleRuntimeBusinessDispatch(authority:AdminAuthority,caseId:string,input:unknown,readCurrent:()=>unknown) {
    const snapshot=runtimeBusinessDispatchSnapshotSchema.parse(input);
    return this.db.transaction(()=>{
      const target=this.runtimeBusinessProgressTarget(authority,caseId);
      if(!target||target.baseline.businessStore!=='present'||!target.baseline.tasks.length)
        throw new Error('运行派发观察缺少已验证实际交还和原需求基线');
      const taskIds=[...snapshot.progress.map(row=>row.taskId),...snapshot.observations.map(row=>row.taskId)];
      if(new Set(taskIds).size!==taskIds.length||taskIds.length!==target.baseline.tasks.length
        ||target.baseline.tasks.some(task=>!taskIds.includes(task.taskId)))throw new Error('运行派发观察必须完整覆盖全部原需求');
      const history=this.runtimeBusinessProgressHistory(target.baseline.verificationAttemptId);
      for(const progress of snapshot.progress){
        this.assertRuntimeBusinessProgressCandidate(target,progress);
        if(!history.some(row=>JSON.stringify(row)===JSON.stringify(progress)))throw new Error('派发观察不能用未经保存的候选抹掉原需求');
      }
      for(const observation of snapshot.observations){
        const original=target.baseline.tasks.find(task=>task.taskId===observation.taskId)!;
        if(observation.runnableItems.some(current=>!original.items.some(item=>item.itemId===current.itemId
          &&item.revision===current.revision&&item.dispatchEpoch<=current.dispatchEpoch)))
          throw new Error('派发观察不能替换原工作项或复用旧 cycle');
      }
      const fresh=runtimeBusinessDispatchSnapshotSchema.safeParse(readCurrent());
      if(!fresh.success||JSON.stringify(fresh.data)!==JSON.stringify(snapshot))return false;
      const current=this.runtimeBusinessProgressTarget(authority,caseId);
      if(!current||JSON.stringify(current.baseline)!==JSON.stringify(target.baseline)
        ||JSON.stringify(current.receipt)!==JSON.stringify(target.receipt))return false;
      const revision=this.control().intent_revision,now=this.now();
      const priorRows=this.runtimeBusinessDispatchWatches(target.baseline.verificationAttemptId);
      const due:Array<{taskId:string;items:unknown;sourceKey:string;watch:ReturnType<typeof sampleRepairDispatchWatch>}>=[];
      const rows=[...snapshot.observations,...snapshot.progress.map(row=>({taskId:row.taskId,readiness:'ended' as const,runnableItems:[]}))];
      for(const observation of rows){
        const sourceKey=createHash('sha256').update(JSON.stringify({receipt:target.receipt,items:observation.runnableItems})).digest('hex');
        const prior=priorRows.find(row=>row.task_id===observation.taskId&&row.source_key===sourceKey);
        const watch=sampleRepairDispatchWatch(prior&&{intentRevision:prior.intent_revision,
          readiness:repairBusinessReadinessSchema.parse(prior.readiness),eligibleElapsedMs:prior.eligible_elapsed_ms,
          lastSampleAt:prior.last_sample_at},observation.readiness,now,revision);
        this.db.prepare(`INSERT INTO repair_runtime_dispatch_watches VALUES(?,?,?,?,?,?,?,?)
          ON CONFLICT(verification_attempt_id,task_id) DO UPDATE SET source_key=excluded.source_key,
          intent_revision=excluded.intent_revision,readiness=excluded.readiness,eligible_elapsed_ms=excluded.eligible_elapsed_ms,last_sample_at=excluded.last_sample_at`)
          .run(target.baseline.verificationAttemptId,caseId,observation.taskId,sourceKey,revision,watch.readiness,watch.eligibleElapsedMs,now);
        if(repairDispatchStallDue(watch,now,revision))due.push({taskId:observation.taskId,items:observation.runnableItems,sourceKey,watch});
      }
      this.assertAuthority(authority,true);
      if(!due.length||due.some(row=>!repairDispatchStallDue(row.watch,this.now(),this.control().intent_revision)))return false;
      const repairCase=this.getCase(caseId)!,artifact=target.baseline.candidateArtifact;
      this.observe({observationId:`runtime-dispatch-stalled:${target.baseline.verificationAttemptId}`,origin:'runtime',
        scope:'runtime',scopeKey:repairCase.scopeKey,fingerprint:repairCase.fingerprint,repairCaseId:caseId,
        sourceVersion:`source:${artifact.sourceId}/artifact:${artifact.artifactId}/version:${artifact.version}`,
        summary:'已验证版本交还后，原业务持续具备真实派发条件超过20分钟却未推进，继续同一Case自动调查',
        evidence:{kind:'repair-runtime-dispatch-stalled',artifact,baseline:target.baseline,handoff:target.receipt,
          verificationAttemptId:target.baseline.verificationAttemptId,updateId:target.receipt.updateId,observations:due,
          recoveryFailureId:`runtime-dispatch:${target.baseline.verificationAttemptId}`,originalFailure:false,authorityInvalidation:true,
          previousProgress:history}});
      this.assertAuthority(authority,true);return true;
    }).immediate();
  }

  /** Only the fenced native observer supplies a fresh read. No Admin command
   * can complete Dev/Test, invent a Task or close from heartbeat/ready flags. */
  closeRuntimeObservedCase(authority:AdminAuthority,caseId:string,readCurrentProgress:()=>unknown) {
    return this.db.transaction(()=>{
      this.assertAuthority(authority,true);
      const repairCase=this.getCase(caseId);
      if(repairCase?.status==='closed'){
        const verification=this.attempts(caseId).find(row=>row.generation===repairCase.generation&&row.role==='verification'&&row.status==='completed');
        if(!verification||this.verificationPurpose(verification.attemptId)!=='repair-verification'
          ||!this.verificationReceipt(verification.attemptId)?.passed||repairCase.currentAttemptId!==null
          ||this.attempts(caseId).some(row=>['launching','running'].includes(row.status)))return false;
        const baseline=this.runtimeBusinessBaseline(verification.attemptId),closure=this.runtimeBusinessProgressClosure(verification.attemptId);
        const history=this.runtimeBusinessProgressHistory(verification.attemptId);
        return Boolean(baseline&&closure&&baseline.tasks.length&&closure.length===baseline.tasks.length
          &&new Set(closure.map(row=>row.taskId)).size===closure.length
          &&baseline.tasks.every(task=>closure.some(row=>row.taskId===task.taskId))
          &&closure.every(row=>history.some(saved=>JSON.stringify(saved)===JSON.stringify(row))));
      }
      const target=this.runtimeBusinessProgressTarget(authority,caseId);
      if(!target||!target.baseline.tasks.length||target.baseline.businessStore!=='present')return false;
      const parsed=z.array(runtimeBusinessProgressCandidateSchema).safeParse(readCurrentProgress());
      if(!parsed.success||parsed.data.length!==target.baseline.tasks.length
        ||new Set(parsed.data.map(row=>row.taskId)).size!==parsed.data.length
        ||target.baseline.tasks.some(task=>!parsed.data.some(row=>row.taskId===task.taskId)))return false;
      const current=this.runtimeBusinessProgressTarget(authority,caseId);
      if(!current||JSON.stringify(current.baseline)!==JSON.stringify(target.baseline)
        ||JSON.stringify(current.receipt)!==JSON.stringify(target.receipt))return false;
      const history=this.runtimeBusinessProgressHistory(target.baseline.verificationAttemptId);
      for(const candidate of parsed.data){
        this.assertRuntimeBusinessProgressCandidate(current,candidate);
        if(!history.some(row=>JSON.stringify(row)===JSON.stringify(candidate)))return false;
      }
      this.db.prepare('INSERT INTO repair_runtime_business_closures(verification_attempt_id,case_id,payload_json,closed_at) VALUES(?,?,?,?)')
        .run(target.baseline.verificationAttemptId,caseId,JSON.stringify(parsed.data),this.now());
      this.db.prepare("UPDATE repair_cases SET status='closed',last_error=NULL,next_probe_at=NULL,updated_at=? WHERE case_id=?")
        .run(this.now(),caseId);return true;
    }).immediate();
  }

  /** No frozen Work Item is not success. Root must supply a fresh actual
   * ordinary-host database/lifecycle receipt bound to every original target. */
  closeRuntimeOriginalOperationCase(authority:AdminAuthority,caseId:string,input:unknown,readCurrent:()=>unknown) {
    const receipt=runtimeOriginalOperationReceiptSchema.parse(input);
    return this.db.transaction(()=>{
      this.assertAuthority(authority,true);
      const repairCase=this.getCase(caseId);
      if(repairCase?.status==='closed'){
        const saved=this.runtimeOriginalOperationReceipt(receipt.verificationAttemptId);
        const fresh=runtimeOriginalOperationReceiptSchema.safeParse(readCurrent());
        return Boolean(saved&&JSON.stringify(saved)===JSON.stringify(receipt)
          &&fresh.success&&JSON.stringify(fresh.data)===JSON.stringify(receipt));
      }
      const target=this.runtimeBusinessProgressTarget(authority,caseId);
      if(!target||target.baseline.tasks.length||target.baseline.verificationAttemptId!==receipt.verificationAttemptId
        ||target.baseline.updateId!==receipt.updateId||target.baseline.businessStore!==receipt.businessStoreBefore
        ||JSON.stringify(target.baseline.candidateArtifact)!==JSON.stringify(receipt.artifact)
        ||JSON.stringify(target.receipt)!==JSON.stringify(receipt.handoff))return false;
      const originalIds=target.input.originalObservations.map(row=>row.observationId).sort();
      if(JSON.stringify(originalIds)!==JSON.stringify(receipt.originalObservationIds))return false;
      const fresh=runtimeOriginalOperationReceiptSchema.safeParse(readCurrent());
      if(!fresh.success||JSON.stringify(fresh.data)!==JSON.stringify(receipt))return false;
      const current=this.runtimeBusinessProgressTarget(authority,caseId);
      if(!current||JSON.stringify(current.baseline)!==JSON.stringify(target.baseline)
        ||JSON.stringify(current.receipt)!==JSON.stringify(target.receipt))return false;
      const prior=this.runtimeOriginalOperationReceipt(receipt.verificationAttemptId),json=JSON.stringify(receipt);
      if(prior&&JSON.stringify(prior)!==json)throw new Error('不能改写已保存的原运行操作收据');
      if(!prior)this.db.prepare(`INSERT INTO repair_runtime_original_operations
        (verification_attempt_id,case_id,payload_json,closed_at) VALUES(?,?,?,?)`)
        .run(receipt.verificationAttemptId,caseId,json,this.now());
      this.db.prepare("UPDATE repair_cases SET status='closed',last_error=NULL,next_probe_at=NULL,updated_at=? WHERE case_id=?")
        .run(this.now(),caseId);return true;
    }).immediate();
  }

  /** Fresh trusted read invalidates old authority and requests investigation.
   * It is not a new original acceptance, nor an Agent completion command. */
  recordRuntimeBusinessCohortChange(authority:AdminAuthority,caseId:string,input:unknown,readCurrent:()=>unknown) {
    const changes=z.array(runtimeBusinessCohortChangeSchema).min(1).parse(input);
    return this.db.transaction(()=>{
      const target=this.runtimeBusinessProgressTarget(authority,caseId);
      if(!target)throw new Error('工作项代次变更缺少实际交还来源');
      const keys=new Set<string>();
      for(const change of changes){
        const original=target.baseline.tasks.find(task=>task.taskId===change.taskId)?.items.find(item=>item.itemId===change.originalItemId);
        const key=`${change.taskId}:${change.originalItemId}`;
        if(!original||original.revision!==change.originalRevision||keys.has(key)||!runtimeBusinessCohortInvalidated(original,change.current))
          throw new Error('工作项代次变更不是已冻结原需求的实际变更');
        keys.add(key);
      }
      const fresh=z.array(runtimeBusinessCohortChangeSchema).safeParse(readCurrent());
      if(!fresh.success||JSON.stringify(fresh.data)!==JSON.stringify(changes))return false;
      const current=this.runtimeBusinessProgressTarget(authority,caseId);
      if(!current||JSON.stringify(current.receipt)!==JSON.stringify(target.receipt)
        ||JSON.stringify(current.baseline)!==JSON.stringify(target.baseline))return false;
      const repairCase=this.getCase(caseId)!,artifact=target.baseline.candidateArtifact;
      const fingerprint=createHash('sha256').update(JSON.stringify(changes)).digest('hex');
      this.observe({observationId:`runtime-cohort-changed:${target.baseline.verificationAttemptId}:${fingerprint}`,
        scope:'runtime',scopeKey:repairCase.scopeKey,fingerprint:repairCase.fingerprint,repairCaseId:caseId,origin:'runtime',
        sourceVersion:`source:${artifact.sourceId}/artifact:${artifact.artifactId}/version:${artifact.version}`,
        summary:'原业务工作项在恢复基线冻结后变更：重新调查、独立验证并冻结当前真实回退链，不复用旧完成门禁',
        evidence:{kind:'repair-runtime-cohort-changed',artifact,changes,baseline:target.baseline,
          updateId:target.receipt.updateId,verificationAttemptId:target.baseline.verificationAttemptId,
          recoveryFailureId:`runtime-cohort:${target.baseline.verificationAttemptId}:${fingerprint}`,
          requiresIndependentReverification:true,originalFailure:false,authorityInvalidation:true,
          previousProgress:this.runtimeBusinessProgressHistory(target.baseline.verificationAttemptId)}});
      return true;
    }).immediate();
  }

  recordRuntimeBusinessProgressFailure(authority:AdminAuthority,caseId:string,verificationAttemptId:string,error:string) {
    return this.db.transaction(()=>{
      const target=this.verifiedRuntimeUpdateInput(authority,caseId),update=this.runtimeUpdate(target.updateId);
      const installation=this.runtimeInstallation();
      if(target.verificationAttemptId!==verificationAttemptId||update?.phase!=='succeeded'||installation?.updateId!==target.updateId
        ||JSON.stringify(installation.artifact)!==JSON.stringify(update.request.candidate))throw new Error('业务恢复失败的验证来源已变化');
      const repairCase=this.getCase(caseId)!,artifact=update.request.candidate,detail=error.slice(0,15000);
      return this.observe({observationId:`runtime-business-progress-failed:${verificationAttemptId}:${createHash('sha256').update(detail).digest('hex')}`,
        scope:'runtime',scopeKey:repairCase.scopeKey,fingerprint:repairCase.fingerprint,repairCaseId:caseId,origin:'runtime',
        sourceVersion:`source:${artifact.sourceId}/artifact:${artifact.artifactId}/version:${artifact.version}`,
        summary:`修复版本业务恢复验证失败，继续自动调查：${detail}`,
        evidence:{kind:'runtime-business-progress-failed',artifact,updateId:target.updateId,verificationAttemptId,
          recoveryFailureId:`runtime-progress:${verificationAttemptId}`,error:detail,
          handoffs:this.runtimeRepairHandoffHistory(verificationAttemptId),progress:this.runtimeBusinessProgressHistory(verificationAttemptId)}});
    }).immediate();
  }

  recordRuntimeHandoffFailure(authority:AdminAuthority,caseId:string,verificationAttemptId:string,error:string) {
    return this.db.transaction(()=>{
      const target=this.verifiedRuntimeUpdateInput(authority,caseId),update=this.runtimeUpdate(target.updateId);
      const installation=this.runtimeInstallation();
      if(target.verificationAttemptId!==verificationAttemptId||update?.phase!=='succeeded'||!installation
        ||installation.updateId!==update.request.updateId||JSON.stringify(installation.artifact)!==JSON.stringify(update.request.candidate))
        throw new Error('运行交还失败的实际切换来源已变化');
      const repairCase=this.getCase(caseId)!,detail=error.slice(0,15000);
      return this.observe({observationId:`runtime-handoff-failed:${verificationAttemptId}:${createHash('sha256').update(detail).digest('hex')}`,
        scope:'runtime',scopeKey:repairCase.scopeKey,fingerprint:repairCase.fingerprint,repairCaseId:caseId,origin:'runtime',
        sourceVersion:`source:${installation.artifact.sourceId}/artifact:${installation.artifact.artifactId}/version:${installation.artifact.version}`,
        summary:`候选切换后物理交还失败，继续自动调查：${detail}`,
        evidence:{kind:'runtime-repair-handoff-failed',artifact:installation.artifact,updateId:update.request.updateId,
          verificationAttemptId,recoveryFailureId:`runtime-handoff:${verificationAttemptId}`,
          error:detail,previousHandoff:this.runtimeRepairHandoff(verificationAttemptId)}});
    }).immediate();
  }

  recordUnappliedRuntimeRepairUpdate(authority: AdminAuthority, caseId: string, verificationAttemptId: string) {
    return this.db.transaction(() => {
      const target=this.verifiedRuntimeUpdateInput(authority,caseId);
      if(target.verificationAttemptId!==verificationAttemptId)throw new Error('失败切换的独立验证代次已改变');
      const update=this.runtimeUpdate(target.updateId);
      if(!update||!['rolled-back','aborted'].includes(update.phase))throw new Error('运行版本切换尚无终止失败事实');
      const repairCase=this.getCase(caseId)!;
      if(update.phase==='aborted') {
        // Changed user intent cancels a transaction; it is not a new original
        // failure to reproduce and must not consume repair error budgets.
        this.observe({observationId:`runtime-update-cancelled:${update.request.updateId}`,scope:'runtime',scopeKey:repairCase.scopeKey,
          fingerprint:repairCase.fingerprint,repairCaseId:caseId,origin:'admin',sourceVersion:update.selected.artifactId,
          summary:'运行版本切换已中止；保留原始故障，恢复后继续未完成调查，不计错误次数',
          evidence:{kind:'runtime-repair-update-cancelled',updateId:update.request.updateId,verificationAttemptId,
            phase:update.phase,failure:update.failure,countsAsFailure:false}});
        this.db.prepare("UPDATE repair_cases SET status='queued',updated_at=? WHERE case_id=? AND status='observing' AND current_attempt_id IS NULL")
          .run(this.now(),caseId);
        return this.getCase(caseId)!;
      }
      return this.observe({observationId:`runtime-update-failed:${update.request.updateId}`,scope:'runtime',scopeKey:repairCase.scopeKey,
        fingerprint:repairCase.fingerprint,repairCaseId:caseId,origin:'runtime',
        sourceVersion:`source:${update.selected.sourceId}/artifact:${update.selected.artifactId}/version:${update.selected.version}`,
        summary:`已验证候选未完成外部切换，继续调查：${update.failure||update.phase}`,
        evidence:{kind:'runtime-repair-update-failed',artifact:update.selected,updateId:update.request.updateId,
          verificationAttemptId,recoveryFailureId:`runtime-update:${update.request.updateId}`,
          phase:update.phase,failure:update.failure,before:update.request.before,candidate:update.request.candidate}});
    }).immediate();
  }

  recordIncompleteObservedCoverage(authority: AdminAuthority, caseId: string) {
    return this.db.transaction(() => {
      this.assertAuthority(authority, true);
      const repairCase = this.getCase(caseId);
      if (!repairCase || repairCase.status !== 'observing' || repairCase.currentAttemptId !== null) return false;
      const attempt = this.attempts(caseId).find(row => row.generation === repairCase.generation);
      const receipt = attempt && this.verificationReceipt(attempt.attemptId);
      if (!attempt || attempt.role !== 'verification' || attempt.status !== 'completed' || !receipt?.passed
        || this.verificationPurpose(attempt.attemptId) !== 'repair-verification') return false;
      try { this.assertOriginalCoverage(caseId, receipt.plan.originalObservationIds); return false; }
      catch (error) {
        if (!(error instanceof OriginalCoverageMissing)) throw error;
        this.observe({ observationId: `coverage-missing:${attempt.attemptId}`, scope: repairCase.scope, scopeKey: repairCase.scopeKey,
          fingerprint: repairCase.fingerprint, sourceVersion: receipt.plan.expectedVersion, origin: 'runtime', repairCaseId: caseId,
          summary: error.message, evidence: { kind: 'repair-verification-coverage-missing', verificationAttemptId: attempt.attemptId,
            missingCount: error.missingCount, missingObservationIds: error.missingObservationIds } });
        this.assertAuthority(authority, true);
        return true;
      }
    }).immediate();
  }

  recordVerifiedVersionChange(authority: AdminAuthority, caseId: string, fact: {
    verificationAttemptId: string; expectedVersion: string; actualVersion: string; workspaceRoot: string;
  }) {
    return this.db.transaction(() => {
      const context = this.verifiedContext(authority, caseId);
      if (context.verification.attemptId !== fact.verificationAttemptId || context.receipt.plan.expectedVersion !== fact.expectedVersion
        || !fact.actualVersion.trim() || fact.actualVersion === fact.expectedVersion || !fact.workspaceRoot.trim()) {
        throw new Error('版本变化事实与当前独立验证来源不一致');
      }
      const fingerprint = createHash('sha256').update(JSON.stringify(fact)).digest('hex');
      const observation = this.observe({ observationId: `verification-version:${fingerprint}`, scope: context.repairCase.scope,
        scopeKey: context.repairCase.scopeKey, fingerprint: context.repairCase.fingerprint, sourceVersion: fact.actualVersion,
        origin: 'runtime', repairCaseId: caseId, summary: '独立验证后实际工作区版本发生变化，重新调查和验证；未交还业务',
        evidence: { kind: 'repair-version-changed', ...fact } });
      this.assertAuthority(authority, true);
      return observation;
    }).immediate();
  }

  followupEvidence(caseId: string) {
    return this.db.prepare('SELECT verification_attempt_id,kind,payload_json FROM repair_followups WHERE case_id = ? ORDER BY created_at,rowid').all(caseId);
  }

  assertManagementAuthority(authority: AdminAuthority) { this.assertAuthority(authority, true); }

  assertHandoffStallCurrent(authority: AdminAuthority, caseId: string, verificationAttemptId: string) {
    const context = this.verifiedContext(authority, caseId);
    const watch = this.db.prepare('SELECT eligible_elapsed_ms,readiness,intent_revision,last_sample_at FROM repair_business_watches WHERE verification_attempt_id=?')
      .get(verificationAttemptId) as { eligible_elapsed_ms: number; readiness: string; intent_revision: number; last_sample_at: number } | undefined;
    const due = watch && repairDispatchStallDue({ intentRevision: watch.intent_revision,
      readiness: repairBusinessReadinessSchema.parse(watch.readiness), eligibleElapsedMs: watch.eligible_elapsed_ms,
      lastSampleAt: watch.last_sample_at }, this.now(), this.control().intent_revision);
    if (context.verification.attemptId !== verificationAttemptId || !this.handoffReceipt(verificationAttemptId) || !due) {
      throw new Error('业务停滞事实缺少当前交还和新鲜持续可派发观察');
    }
    return context;
  }

  recordHandoffStallObservation(authority: AdminAuthority, caseId: string, verificationAttemptId: string, input: unknown) {
    const observation = observationSchema.parse(input);
    return this.db.transaction(() => {
      const context = this.assertHandoffStallCurrent(authority, caseId, verificationAttemptId);
      if (observation.origin !== 'business'
        || observation.scope !== context.repairCase.scope || observation.scopeKey !== context.repairCase.scopeKey
        || observation.fingerprint !== context.repairCase.fingerprint) throw new Error('业务停滞事实缺少当前交还、持续可派发观察或原故障来源');
      if (this.db.prepare('SELECT 1 FROM repair_observations WHERE observation_id=?').get(observation.observationId)) {
        throw new Error('不能把已保存的旧故障重新声明为新的业务停滞事实');
      }
      const reopened = this.observe(observation);
      if (reopened.caseId !== caseId) throw new Error('业务停滞观察不能新建或重绑其他 Case');
      this.assertAuthority(authority, true); // A concurrent stop/fence rolls back the management observation.
      return reopened;
    }).immediate();
  }

  /** Count only observed eligible dispatch time, not a user's pause, resource
   * wait, long running command, host outage or changed run intent. Persisted
   * across management restart. Readiness is a trusted business observation,
   * never an Agent claim or authority to close the Case. */
  sampleHandoffReadiness(authority: AdminAuthority, caseId: string, verificationAttemptId: string, input: unknown) {
    const readiness = repairBusinessReadinessSchema.parse(input);
    return this.db.transaction(() => {
      const context = this.verifiedContext(authority, caseId);
      if (context.verification.attemptId !== verificationAttemptId || !this.handoffReceipt(verificationAttemptId)) {
        throw new Error('业务停滞观察未绑定当前已验证交还');
      }
      const prior = this.db.prepare('SELECT * FROM repair_business_watches WHERE verification_attempt_id = ?')
        .get(verificationAttemptId) as { intent_revision: number; readiness: string; eligible_elapsed_ms: number; last_sample_at: number } | undefined;
      const revision = this.control().intent_revision;
      const now = this.now();
      const watch = sampleRepairDispatchWatch(prior && { intentRevision: prior.intent_revision,
        readiness: repairBusinessReadinessSchema.parse(prior.readiness), eligibleElapsedMs: prior.eligible_elapsed_ms,
        lastSampleAt: prior.last_sample_at }, readiness, now, revision);
      this.db.prepare(`INSERT INTO repair_business_watches VALUES(?,?,?,?,?) ON CONFLICT(verification_attempt_id)
        DO UPDATE SET intent_revision=excluded.intent_revision,readiness=excluded.readiness,
          eligible_elapsed_ms=excluded.eligible_elapsed_ms,last_sample_at=excluded.last_sample_at`)
        .run(verificationAttemptId, revision, readiness, watch.eligibleElapsedMs, now);
      return repairDispatchStallDue(watch, now, revision);
    }).immediate();
  }

  handoffReceipt(verificationAttemptId: string): RepairHandoffReceipt | null {
    const row = this.db.prepare("SELECT payload_json FROM repair_followups WHERE verification_attempt_id = ? AND kind = 'handoff'")
      .get(verificationAttemptId) as { payload_json: string } | undefined;
    return row ? repairHandoffReceiptSchema.parse(JSON.parse(row.payload_json)) : null;
  }

  private insertFollowup(caseId: string, attemptId: string, kind: string, payload: unknown) {
    const json = JSON.stringify(payload);
    const prior = this.db.prepare('SELECT payload_json FROM repair_followups WHERE verification_attempt_id = ? AND kind = ?')
      .get(attemptId, kind) as { payload_json: string } | undefined;
    if (prior && prior.payload_json !== json) throw new Error('不能改写已保存的修复交还或业务推进证据');
    if (prior) return false;
    this.db.prepare('INSERT INTO repair_followups(case_id,verification_attempt_id,kind,payload_json,created_at) VALUES(?,?,?,?,?)')
      .run(caseId, attemptId, kind, json, this.now());
    return true;
  }

  recordHandoffReceipt(authority: AdminAuthority, caseId: string, input: unknown) {
    const handoff = repairHandoffReceiptSchema.parse(input);
    return this.db.transaction(() => {
      const context = this.verifiedContext(authority, caseId);
      const target = handoff.target;
      if (target.caseId !== caseId || target.verificationAttemptId !== context.verification.attemptId
        || target.repairGeneration !== context.repair.generation || target.repairOwnerId !== context.repair.ownerId
        || target.repairSupervisionToken !== context.repair.supervisionToken || target.expectedVersion !== context.receipt.plan.expectedVersion) {
        throw new Error('交还证据与当前独立验证及修复所有权不一致');
      }
      const sources = this.observations(caseId).filter(raw => {
        const row = raw as { observation_id: string; origin: string };
        return row.origin === 'business' && context.receipt.plan.originalObservationIds.includes(row.observation_id);
      }).map(raw => JSON.parse((raw as { evidence_json: string }).evidence_json) as
        { taskId?: string; item?: { item_id?: string; revision?: number; dispatch_epoch?: number } });
      const anchor = this.repairWorkspaceAnchor(context.repair.attemptId);
      if (!sources.length || sources.some(source => source.taskId !== target.taskId || !source.item?.item_id
        || !workspaceAnchorContains(anchor, source.item.item_id, source.item.revision))
        || anchor.taskId !== target.taskId || anchor.itemId !== target.itemId || anchor.itemRevision !== target.itemRevision
        || anchor.itemEpoch !== target.itemEpoch || anchor.workspaceRoot !== handoff.workspaceRoot) {
        throw new Error('交还证据未绑定原始可信业务来源');
      }
      return this.insertFollowup(caseId, context.verification.attemptId, 'handoff', handoff);
    }).immediate();
  }

  /** Only a trusted host observation adapter calls this API. No loop-admin
   * command can fabricate a workflow completion or close its own Case. */
  recordBusinessProgress(authority: AdminAuthority, caseId: string, input: unknown) {
    const progress = repairBusinessProgressSchema.parse(input);
    return this.db.transaction(() => {
      const context = this.verifiedContext(authority, caseId);
      const handoff = this.handoffReceipt(context.verification.attemptId);
      if (!handoff || progress.taskId !== handoff.target.taskId || progress.itemId !== handoff.target.itemId
        || progress.itemRevision !== handoff.target.itemRevision || progress.dispatchEpoch !== handoff.dispatchEpoch
        || handoff.previousExecutionIds.includes(progress.executionId)) throw new Error('推进证据不是本次交还后的新业务执行');
      return this.insertFollowup(caseId, context.verification.attemptId, 'business-progress', progress);
    }).immediate();
  }

  closeObservedCase(authority: AdminAuthority, caseId: string, readCurrentProgress: () => unknown) {
    return this.db.transaction(() => {
      this.assertAuthority(authority, true);
      const closed = this.getCase(caseId);
      if (closed?.status === 'closed') {
        const verification = this.attempts(caseId).find(row => row.generation === closed.generation && row.role === 'verification' && row.status === 'completed');
        return Boolean(verification && this.verificationPurpose(verification.attemptId) === 'repair-verification' && this.verificationReceipt(verification.attemptId)?.passed
          && closed.currentAttemptId === null
          && !this.attempts(caseId).some(row => ['launching', 'running'].includes(row.status))
          && this.handoffReceipt(verification.attemptId)
          && this.db.prepare("SELECT 1 FROM repair_followups WHERE verification_attempt_id = ? AND kind = 'business-progress'").get(verification.attemptId));
      }
      const context = this.verifiedContext(authority, caseId);
      const handoff = this.handoffReceipt(context.verification.attemptId);
      const row = this.db.prepare("SELECT payload_json FROM repair_followups WHERE verification_attempt_id = ? AND kind = 'business-progress'")
        .get(context.verification.attemptId) as { payload_json: string } | undefined;
      if (!handoff || !row) return false;
      const current = repairBusinessProgressSchema.safeParse(readCurrentProgress());
      if (!current.success || JSON.stringify(current.data) !== row.payload_json) return false;
      this.verifiedContext(authority, caseId); // Fresh intent and fault-generation check after the business read.
      this.db.prepare("UPDATE repair_cases SET status = 'closed',last_error = NULL,next_probe_at = NULL,updated_at = ? WHERE case_id = ?").run(this.now(), caseId);
      return true;
    }).immediate();
  }

  recordVerificationReceipt(claim: RepairClaim, input: unknown) {
    const receipt = repairVerificationReceiptSchema.parse(input);
    return this.db.transaction(() => {
      const attempt = this.assertClaim(claim);
      if (attempt.role !== 'verification') throw new Error('修复执行不能提交独立验证收据');
      if (this.getCase(attempt.caseId)?.status !== 'verifying') throw new Error('新的故障证据已使原验证收据失效');
      if (this.verificationPurpose(attempt.attemptId) === 'repair-verification') this.assertOriginalCoverage(attempt.caseId, receipt.plan.originalObservationIds);
      const row = this.db.prepare('SELECT plan_json,receipt_json FROM repair_verifications WHERE attempt_id = ?').get(attempt.attemptId) as
        { plan_json: string; receipt_json: string | null } | undefined;
      if (!row || row.plan_json !== JSON.stringify(receipt.plan)) throw new Error('验证收据与宿主授权计划不一致');
      for (const [index, check] of receipt.checks.entries()) {
        const evidence = this.db.prepare('SELECT kind,payload_json FROM repair_evidence WHERE attempt_id = ? AND receipt_key = ?')
          .get(attempt.attemptId, `verification-check-${index}`) as { kind: string; payload_json: string } | undefined;
        const persisted = evidence ? repairVerificationCheckSchema.safeParse(JSON.parse(evidence.payload_json)) : null;
        if (!evidence || evidence.kind !== 'verification-check' || !persisted?.success || JSON.stringify(persisted.data) !== JSON.stringify(check)) {
          throw new Error('验证收据缺少对应的不可改写执行证据');
        }
      }
      const json = JSON.stringify(receipt);
      if (row.receipt_json && row.receipt_json !== json) throw new Error('不能改写已保存的独立验证收据');
      if (row.receipt_json) return false;
      this.db.prepare('UPDATE repair_verifications SET receipt_json = ? WHERE attempt_id = ?').run(json, attempt.attemptId);
      return true;
    }).immediate();
  }

  finishVerification(claim: RepairClaim, exitConfirmed: boolean) {
    return this.db.transaction(() => {
      const attempt = this.assertClaim(claim);
      if (attempt.role !== 'verification') throw new Error('修复者不能完成独立验证');
      return this.applyVerificationReceipt(attempt, exitConfirmed);
    }).immediate();
  }

  private applyVerificationReceipt(attempt: RepairAttempt, exitConfirmed: boolean) {
    const receipt = this.verificationReceipt(attempt.attemptId);
    if (!receipt || !exitConfirmed || this.getCase(attempt.caseId)?.status !== 'verifying') return false;
    if (this.verificationPurpose(attempt.attemptId) === 'repair-verification'
      && this.rejectIncompleteSavedCoverage(attempt, receipt.plan.originalObservationIds)) return true;
    if (this.verificationPurpose(attempt.attemptId) === 'diagnosis') {
      const complete = receipt.exitConfirmed && receipt.checks.length === repairVerificationSteps(receipt.plan).length
        && receipt.checks.every(check => check.result.exitConfirmed && check.result.exitCode !== null
          && (!(check.kind === 'version-before' || check.kind === 'version-after')
            || (check.result.exitCode === 0 && check.result.stdout.trim() === receipt.plan.expectedVersion)));
      if (complete) {
        const fingerprint = createHash('sha256').update(JSON.stringify([
          receipt.checks.map(check => [check.kind, check.targetRef, check.result.exitCode])
            .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))])).digest('hex');
        const novel = this.db.prepare('INSERT OR IGNORE INTO repair_diagnosis_facts(case_id,fingerprint,attempt_id,created_at) VALUES(?,?,?,?)')
          .run(attempt.caseId, fingerprint, attempt.attemptId, this.now()).changes;
        this.db.prepare('INSERT INTO repair_diagnosis_rounds(attempt_id,novel) VALUES(?,?)').run(attempt.attemptId, novel);
      }
      const reason = complete ? '独立诊断记录已保存；未宣告修复，交回 Admin 继续调查' : '独立诊断缺少完整版本、检查或物理退出证据';
      this.db.prepare('UPDATE repair_attempts SET status = ?,finished_at = ?,last_error = ? WHERE attempt_id = ?')
        .run(complete ? 'completed' : 'failed', this.now(), reason, attempt.attemptId);
      this.db.prepare("UPDATE repair_cases SET current_attempt_id = NULL,status = 'queued',last_error = ?,updated_at = ? WHERE case_id = ?")
        .run(reason, this.now(), attempt.caseId);
      return true;
    }
    this.db.prepare('UPDATE repair_attempts SET status = ?,finished_at = ?,last_error = ? WHERE attempt_id = ?')
      .run(receipt.passed ? 'completed' : 'failed', this.now(), receipt.reason, attempt.attemptId);
    this.db.prepare('UPDATE repair_cases SET current_attempt_id = NULL,status = ?,last_error = ?,updated_at = ? WHERE case_id = ?')
      .run(receipt.passed ? 'observing' : 'queued', receipt.reason, this.now(), attempt.caseId);
    return true;
  }

  private rejectIncompleteSavedCoverage(attempt: RepairAttempt, ids: string[]) {
    try { this.assertOriginalCoverage(attempt.caseId, ids); return false; }
    catch (error) {
      if (!(error instanceof OriginalCoverageMissing)) throw error;
      this.db.prepare("UPDATE repair_attempts SET status='failed',finished_at=?,last_error=? WHERE attempt_id=?")
        .run(this.now(), error.message, attempt.attemptId);
      this.db.prepare("UPDATE repair_cases SET status='queued',current_attempt_id=NULL,last_error=?,updated_at=? WHERE case_id=?")
        .run(error.message, this.now(), attempt.caseId);
      return true; // Logical authority rejected only AFTER real physical exit.
    }
  }

  recoverStoppedSubmission(authority: AdminAuthority, attemptId: string, exitConfirmed: boolean) {
    return this.db.transaction(() => {
      const control = this.assertAuthority(authority, true);
      const attempt = this.attempts().find(row => row.attemptId === attemptId);
      if (!exitConfirmed || !attempt || !['launching', 'running'].includes(attempt.status)
        || attempt.intentRevision !== control.intent_revision || this.getCase(attempt.caseId)?.currentAttemptId !== attemptId) return false;
      if (attempt.role === 'verification') return this.applyVerificationReceipt(attempt, exitConfirmed)
        || this.applyVerificationPreparation(attempt, exitConfirmed);
      const row = this.db.prepare('SELECT submission_json FROM admin_command_sessions WHERE attempt_id = ?').get(attemptId) as { submission_json: string | null } | undefined;
      if (!row?.submission_json) return false;
      const submission = adminSubmissionSchema.parse(JSON.parse(row.submission_json));
      if (submission.outcome === 'verification-requested'
        && this.rejectIncompleteSavedCoverage(attempt, submission.originalObservationIds)) return true;
      const externalWait = submission.outcome === 'external-wait-requested';
      this.db.prepare('UPDATE repair_attempts SET status = ?,finished_at = ?,last_error = ? WHERE attempt_id = ?')
        .run(submission.outcome !== 'deferred' ? 'completed' : 'failed', this.now(), submission.summary, attemptId);
      this.db.prepare('UPDATE repair_cases SET current_attempt_id = NULL,status = ?,last_error = ?,next_probe_at=?,updated_at = ? WHERE case_id = ?')
        .run(externalWait ? 'external-wait' : submission.outcome !== 'deferred' ? 'verifying' : 'queued', submission.summary,
          externalWait ? this.now() + submission.retryAfterMs : null, this.now(), attempt.caseId);
      return true;
    }).immediate();
  }

  finishAttempt(claim: RepairClaim, result: { outcome: 'failed' | 'verification-requested' | 'diagnosis-requested' | 'external-wait-requested' | 'verification-prepared' | 'verified'; exitConfirmed: boolean; reason: string; retryAt?: number }) {
    return this.db.transaction(() => {
      const attempt = this.assertClaim(claim);
      if (result.outcome === 'verification-prepared') {
        if (attempt.role !== 'verification') throw new Error('修复执行不能使用独立验收准备结果');
        return this.applyVerificationPreparation(attempt, result.exitConfirmed);
      }
      if (result.outcome === 'verified') throw new Error('验证通过只能由持久化收据门禁完成，不能通过修复终止结果直接推进');
      if (attempt.role === 'verification' && result.outcome !== 'failed') throw new Error('独立验证不能使用修复者提交代替验证结果');
      if (!result.exitConfirmed) {
        this.db.prepare('UPDATE repair_attempts SET last_error = ? WHERE attempt_id = ?').run(result.reason, claim.attempt.attemptId);
        this.db.prepare('UPDATE repair_cases SET last_error = ?,updated_at = ? WHERE case_id = ?').run(result.reason, this.now(), claim.repairCase.caseId);
        return false;
      }
      if (result.outcome === 'verification-requested') {
        const saved = this.db.prepare('SELECT submission_json FROM admin_command_sessions WHERE attempt_id=?')
          .get(attempt.attemptId) as { submission_json: string | null } | undefined;
        const submission = saved?.submission_json ? adminSubmissionSchema.parse(JSON.parse(saved.submission_json)) : null;
        if (submission?.outcome === 'verification-requested'
          && this.rejectIncompleteSavedCoverage(attempt, submission.originalObservationIds)) return true;
      }
      const saved = this.db.prepare('SELECT submission_json FROM admin_command_sessions WHERE attempt_id=?')
        .get(attempt.attemptId) as { submission_json: string | null } | undefined;
      const submission = saved?.submission_json ? adminSubmissionSchema.parse(JSON.parse(saved.submission_json)) : null;
      const externalWait = result.outcome === 'external-wait-requested' && submission?.outcome === 'external-wait-requested'
        ? submission : null;
      if (result.outcome === 'external-wait-requested' && !externalWait) {
        throw new Error('外部等待缺少通过门禁的终止提交');
      }
      this.db.prepare('UPDATE repair_attempts SET status = ?,finished_at = ?,last_error = ? WHERE attempt_id = ?')
        .run(result.outcome === 'failed' ? 'failed' : 'completed', this.now(), result.reason, claim.attempt.attemptId);
      this.db.prepare('UPDATE repair_cases SET current_attempt_id = NULL,status = ?,last_error = ?,next_probe_at = ?,updated_at = ? WHERE case_id = ?')
        .run(externalWait ? 'external-wait' : result.outcome === 'failed' ? 'queued' : 'verifying', result.reason,
          externalWait ? this.now() + externalWait.retryAfterMs : result.retryAt ?? null, this.now(), claim.repairCase.caseId);
      return true;
    }).immediate();
  }

  retireStoppedAttempt(authority: AdminAuthority, attemptId: string, exitConfirmed: boolean, reason: string) {
    return this.db.transaction(() => {
      const control = this.assertAuthority(authority);
      const attempt = this.attempts().find(row => row.attemptId === attemptId);
      if (!attempt || !['launching', 'running'].includes(attempt.status) || !exitConfirmed) return false;
      if (this.getCase(attempt.caseId)?.currentAttemptId !== attemptId) throw new Error('停止证明与当前修复执行不匹配');
      const cause = control.desired_intent === 'stopped' ? 'user-stop' : control.management_mode === 'update-silence' ? 'update' : 'host-loss';
      this.db.prepare('INSERT INTO repair_interruption_facts(attempt_id,cause,created_at) VALUES(?,?,?)').run(attemptId, cause, this.now());
      this.db.prepare("UPDATE repair_attempts SET status = 'interrupted',finished_at = ?,last_error = CASE WHEN last_error IS NULL THEN ? ELSE last_error || char(10) || ? END WHERE attempt_id = ?")
        .run(this.now(), reason, reason, attemptId);
      this.db.prepare('UPDATE repair_cases SET current_attempt_id = NULL,status = ?,last_error = ?,updated_at = ? WHERE case_id = ?')
        .run(attempt.role === 'verification' && this.getCase(attempt.caseId)?.status === 'verifying' ? 'verifying' : 'queued', reason, this.now(), attempt.caseId);
      return true;
    }).immediate();
  }
}
