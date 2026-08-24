import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { appendLoopRunLog, beginRun, endRun, getRunStatus } from './tasks';
import { databaseConnection, paths } from '../infrastructure/database';
import { startAgentRun } from '../infrastructure/agent-runner';
import {
  inspectProcessCommand,
  inspectProcessIdentity,
  processIdentityMatches,
  terminateProcessTree,
  waitForProcessIdentity,
} from '../infrastructure/process-tree';
import { isProcessAlive } from '../infrastructure/run-process';
import { RuntimeEventHub } from '../infrastructure/runtime-event-hub';
import { registerManagedProcessInDb } from '../infrastructure/managed-process-registry';

export type LifecycleSource = {
  adapter: 'ui' | 'electron' | 'cli';
  instanceId: string;
  actor: 'human' | 'host';
};

export type LifecycleAction =
  | { kind: 'start' }
  | { kind: 'stop'; reason: 'user-stop' | 'application-exit' }
  | { kind: 'prepare-update'; attemptId: string; targetVersion: string }
  | { kind: 'resume-after-update' };

export type LifecycleCommand = { requestId: string; source: LifecycleSource; action: LifecycleAction };
export type ReconcileTrigger = {
  source: Pick<LifecycleSource, 'adapter' | 'instanceId'>;
  trigger: 'host-started' | 'periodic-health-check' | 'process-exit-observed' | 'manual-reconcile';
};

export type LifecycleReceipt = {
  requestId?: string;
  outcome: 'started' | 'stopped' | 'ready-for-update' | 'resumed' | 'healthy' | 'backoff' | 'observer' | 'update-in-progress' | 'blocked' | 'failed';
  snapshot: LifecycleSnapshot;
  warning?: string;
  error?: string;
  residualProcesses?: Array<{ kind: string; pid: number }>;
};

export type LifecycleSnapshot = {
  intent: { desired: 'running' | 'stopped'; revision: number };
  mode: { kind: 'normal' } | { kind: 'update-silence'; attemptId: string | null; targetVersion: string | null; readiness: string | null };
  run: {
    phase: 'starting' | 'running' | 'stopping' | 'stopped' | 'crashed';
    runId: string | null;
    healthy: boolean;
    startedAt: string | null;
    heartbeatAt: string | null;
  };
  supervision: { owner: boolean; token: number | null; restartCount: number; retryAt: string | null; leaseExpiresAt: string | null };
  lastError: string | null;
};

type LifecycleStateRow = {
  desired_intent: 'running' | 'stopped';
  intent_revision: number;
  mode: 'normal' | 'update-silence';
  update_attempt_id: string | null;
  update_target_version: string | null;
  update_readiness: string | null;
  actual_phase: LifecycleSnapshot['run']['phase'];
  active_run_id: string | null;
  restart_count: number;
  retry_at: string | null;
  healthy_since: string | null;
  last_error: string | null;
  runner_suspect_since: string | null;
  last_health_json: string | null;
};

type LeaseRow = { owner_id: string; fencing_token: number; expires_at: string };
type ManagedProcessRow = { process_id: string; supervision_token: number; process_kind: string; pid: number; process_start_marker: string };

const LEASE_MS = 30_000;
const HEALTHY_RESET_MS = 10 * 60_000;
export const RUNNER_STALE_GRACE_MS = 60_000;

function timestamp(value: string | null | undefined) {
  if (!value) return 0;
  return new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`).getTime();
}

export function lifecycleRestartDelayMs(restartCount: number) {
  if (restartCount <= 1) return 5_000;
  if (restartCount === 2) return 15_000;
  if (restartCount === 3) return 30_000;
  return 5 * 60_000;
}

function releaseVersion(input: string) {
  const match = input.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] as const : null;
}

export function installedVersionReachedTarget(installedVersion: string, targetVersion: string | null) {
  if (!targetVersion) return false;
  if (installedVersion === targetVersion || `v${installedVersion}` === targetVersion) return true;
  const installed = releaseVersion(installedVersion);
  const target = releaseVersion(targetVersion);
  if (!installed || !target) return false;
  for (let index = 0; index < installed.length; index += 1) {
    if (installed[index] !== target[index]) return installed[index] > target[index];
  }
  return true;
}

type ObservedRun = NonNullable<Awaited<ReturnType<typeof getRunStatus>>>;

export function runnerHealthReason(run: ObservedRun | null) {
  if (!run) return 'active_run 记录不存在';
  return [
    `run=${run.runId}`,
    `pid=${run.pid ?? '-'}`,
    `pid_alive=${run.health.pidAlive}`,
    `heartbeat_at=${run.heartbeatAt || '-'}`,
    `heartbeat_age_ms=${run.health.heartbeatAgeMs ?? '-'}`,
    `heartbeat_fresh=${run.health.heartbeatFresh}`,
    `starting=${run.health.starting}`,
    `generation_active=${run.health.generationActive}`,
    `status=${run.status}`,
  ].join(' ');
}

export function runnerHealthDisposition(
  run: ObservedRun | null,
  suspectSince: string | null,
  now = Date.now(),
) {
  if (run?.active) return { kind: 'healthy' as const, reason: runnerHealthReason(run) };
  const reason = runnerHealthReason(run);
  if (!run || !run.health.pidAlive || !run.health.generationActive) {
    return { kind: 'failed' as const, reason };
  }
  const suspectAt = timestamp(suspectSince);
  if (!suspectAt || now - suspectAt < RUNNER_STALE_GRACE_MS) {
    return { kind: 'suspect' as const, reason, suspectSince: suspectAt || now };
  }
  return { kind: 'failed' as const, reason };
}

function stateRow(db: Awaited<ReturnType<typeof databaseConnection>>) {
  return db.prepare('SELECT * FROM loop_lifecycle_state WHERE singleton = 1').get() as LifecycleStateRow;
}

function leaseRow(db: Awaited<ReturnType<typeof databaseConnection>>) {
  return db.prepare('SELECT owner_id, fencing_token, expires_at FROM loop_supervisor_lease WHERE singleton = 1').get() as LeaseRow | undefined;
}

function supervisorOwnerPid(ownerId: string) {
  const match = ownerId.match(/^(?:electron|web)-(\d+)-/);
  const pid = Number(match?.[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function canReclaimSupervisorLease(previousOwnerId: string, currentOwnerId: string, isAlive = isProcessAlive) {
  const previousPid = supervisorOwnerPid(previousOwnerId);
  if (!previousPid) return false;
  const currentPid = supervisorOwnerPid(currentOwnerId);
  return previousPid === currentPid || !isAlive(previousPid);
}

export type LoopRunLifecycleOptions = {
  ownerId: string;
  adapter: 'electron' | 'cli';
  installedVersion?: string;
  setLoginStartup?: (enabled: boolean) => Promise<boolean> | boolean;
};

export function createLoopRunLifecycle(options: LoopRunLifecycleOptions) {
  let currentToken: number | null = null;
  let renewalTimer: NodeJS.Timeout | undefined;
  let runtimeEventHub: RuntimeEventHub | undefined;
  let operation = Promise.resolve<unknown>(undefined);

  const serialize = <T>(work: () => Promise<T>) => {
    const next = operation.catch(() => undefined).then(work);
    operation = next;
    return next;
  };

  async function acquireLease() {
    const db = await databaseConnection();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + LEASE_MS).toISOString();
    const token = db.transaction(() => {
      const lease = leaseRow(db);
      if (!lease) {
        db.prepare(`INSERT OR IGNORE INTO loop_supervisor_lease(singleton, owner_id, fencing_token, expires_at) VALUES(1, ?, 1, ?)`)
          .run(options.ownerId, expiresAt);
        const created = leaseRow(db);
        return created?.owner_id === options.ownerId ? created.fencing_token : null;
      }
      if (lease.owner_id === options.ownerId) {
        const renewed = db.prepare(`UPDATE loop_supervisor_lease SET expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE singleton = 1 AND owner_id = ? AND fencing_token = ?`)
          .run(expiresAt, options.ownerId, lease.fencing_token);
        return renewed.changes === 1 ? lease.fencing_token : null;
      }
      if (timestamp(lease.expires_at) > now.getTime()
        && !canReclaimSupervisorLease(lease.owner_id, options.ownerId)) return null;
      const nextToken = lease.fencing_token + 1;
      const claimed = db.prepare(`UPDATE loop_supervisor_lease SET owner_id = ?, fencing_token = ?, expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE singleton = 1 AND owner_id = ? AND fencing_token = ? AND expires_at = ?`)
        .run(options.ownerId, nextToken, expiresAt, lease.owner_id, lease.fencing_token, lease.expires_at);
      return claimed.changes === 1 ? nextToken : null;
    })();
    currentToken = token;
    return token;
  }

  async function ensureRuntimeEventHub(token: number) {
    if (runtimeEventHub?.token === token) return;
    if (runtimeEventHub) await runtimeEventHub.close();
    const hub = new RuntimeEventHub(options.ownerId, token);
    await hub.start();
    runtimeEventHub = hub;
  }

  async function closeRuntimeEventHub() {
    const hub = runtimeEventHub;
    runtimeEventHub = undefined;
    await hub?.close();
  }

  async function snapshot(): Promise<LifecycleSnapshot> {
    const db = await databaseConnection();
    const state = stateRow(db);
    const lease = leaseRow(db);
    const run = await getRunStatus(currentToken ?? undefined);
    return {
      intent: { desired: state.desired_intent, revision: state.intent_revision },
      mode: state.mode === 'normal'
        ? { kind: 'normal' }
        : { kind: 'update-silence', attemptId: state.update_attempt_id, targetVersion: state.update_target_version, readiness: state.update_readiness },
      run: {
        phase: state.actual_phase,
        runId: run?.runId || state.active_run_id,
        healthy: Boolean(run?.active),
        startedAt: run?.startedAt || null,
        heartbeatAt: run?.heartbeatAt || null,
      },
      supervision: {
        owner: Boolean(lease && lease.owner_id === options.ownerId && timestamp(lease.expires_at) > Date.now()),
        token: lease?.fencing_token ?? null,
        restartCount: state.restart_count,
        retryAt: state.retry_at,
        leaseExpiresAt: lease?.expires_at ?? null,
      },
      lastError: state.last_error,
    };
  }

  async function stopCurrent(reason: string, preserveIntent: boolean) {
    const db = await databaseConnection();
    const run = await getRunStatus(currentToken ?? undefined);
    db.prepare(`UPDATE loop_lifecycle_state SET actual_phase = 'stopping', updated_at = CURRENT_TIMESTAMP WHERE singleton = 1`).run();
    if (run?.runId) {
      await endRun(run.runId, false, { preserveRunIntent: true, reason });
    }
    db.prepare(`
      UPDATE loop_lifecycle_state
      SET actual_phase = 'stopped', active_run_id = NULL, healthy_since = NULL,
          runner_suspect_since = NULL,
          retry_at = CASE WHEN ? THEN retry_at ELSE NULL END,
          updated_at = CURRENT_TIMESTAMP
      WHERE singleton = 1
    `).run(preserveIntent ? 1 : 0);
  }

  async function activeResidualProcesses(includeUiServer = true) {
    const db = await databaseConnection();
    const rows = db.prepare(`
      SELECT process_id, supervision_token, process_kind, pid, process_start_marker
      FROM loop_managed_processes WHERE status = 'running'
    `).all() as ManagedProcessRow[];
    const residual: Array<{ kind: string; pid: number }> = [];
    for (const row of rows) {
      if (!includeUiServer && row.process_kind === 'ui-server') continue;
      const identity = await inspectProcessIdentity(row.pid);
      if (!identity && isProcessAlive(row.pid)) {
        residual.push({ kind: row.process_kind, pid: row.pid });
        continue;
      }
      if (!identity || !processIdentityMatches(identity, row.process_start_marker)) {
        db.prepare(`UPDATE loop_managed_processes SET status = 'exited', exited_at = CURRENT_TIMESTAMP WHERE pid = ? AND process_start_marker = ?`)
          .run(row.pid, row.process_start_marker);
        continue;
      }
      residual.push({ kind: row.process_kind, pid: row.pid });
    }
    return residual;
  }

  async function cleanupSupersededProcesses(token: number) {
    const db = await databaseConnection();
    const rows = db.prepare(`
      SELECT process_id, supervision_token, process_kind, pid, process_start_marker
      FROM loop_managed_processes
      WHERE status = 'running' AND supervision_token != ?
      ORDER BY CASE process_kind WHEN 'agent-cli' THEN 0 WHEN 'agent-runner' THEN 1 ELSE 2 END
    `).all(token) as ManagedProcessRow[];
    const residual: Array<{ kind: string; pid: number }> = [];
    for (const row of rows) {
      const identity = await inspectProcessIdentity(row.pid);
      if (!identity && isProcessAlive(row.pid)) {
        residual.push({ kind: `${row.process_kind}-unverified`, pid: row.pid });
        continue;
      }
      if (!identity || !processIdentityMatches(identity, row.process_start_marker)) {
        db.prepare(`UPDATE loop_managed_processes SET status = 'exited', exited_at = CURRENT_TIMESTAMP WHERE process_id = ?`)
          .run(row.process_id);
        continue;
      }
      if (row.pid === process.pid || !await terminateProcessTree(row.pid, 10_000, row.process_start_marker)) {
        residual.push({ kind: row.process_kind, pid: row.pid });
        continue;
      }
      db.prepare(`UPDATE loop_managed_processes SET status = 'exited', exited_at = CURRENT_TIMESTAMP WHERE process_id = ?`)
        .run(row.process_id);
    }
    return residual;
  }

  async function cleanupLegacyMaintenanceProcess() {
    const pidPath = join(paths.dataDir, 'software-maintenance', 'runner.pid');
    let pid = 0;
    try {
      pid = Number((await readFile(pidPath, 'utf8')).trim());
    } catch {
      return null;
    }
    if (!Number.isInteger(pid) || pid <= 0) {
      await unlink(pidPath).catch(() => undefined);
      return null;
    }
    if (process.platform === 'win32') {
      if (isProcessAlive(pid) && !await terminateProcessTree(pid, 10_000)) return { kind: 'legacy-maintenance', pid };
      await unlink(pidPath).catch(() => undefined);
      return null;
    }
    const identity = await inspectProcessIdentity(pid);
    if (!identity) {
      if (isProcessAlive(pid)) return { kind: 'legacy-maintenance-unverified', pid };
      await unlink(pidPath).catch(() => undefined);
      return null;
    }
    const command = await inspectProcessCommand(pid);
    if (!command.includes('maintenance-runner')) {
      return { kind: 'legacy-maintenance-unverified', pid };
    }
    if (!await terminateProcessTree(pid, 10_000, identity.startMarker)) {
      return { kind: 'legacy-maintenance', pid };
    }
    await unlink(pidPath).catch(() => undefined);
    return null;
  }

  async function registerHostProcess(processKind: 'ui-server', pid: number) {
    const token = await acquireLease();
    if (token === null) throw new Error('当前宿主没有监督租约');
    const residual = await cleanupSupersededProcesses(token);
    if (residual.length) throw new Error(`无法清理上一监督代次进程：${residual.map((item) => `${item.kind} pid=${item.pid}`).join(', ')}`);
    const identity = await waitForProcessIdentity(pid);
    if (!identity) throw new Error(`无法验证 ${processKind} 进程身份 pid=${pid}`);
    const db = await databaseConnection();
    const processId = registerManagedProcessInDb(db, {
      processId: randomUUID(),
      supervisionToken: token,
      processKind,
      pid,
      processStartMarker: identity.startMarker,
    });
    return { processId, processStartMarker: identity.startMarker };
  }

  async function markHostProcessExited(processId: string) {
    const db = await databaseConnection();
    db.prepare(`
      UPDATE loop_managed_processes
      SET status = 'exited', exited_at = CURRENT_TIMESTAMP
      WHERE process_id = ?
    `).run(processId);
  }

  async function verifyUpdateReadiness(): Promise<LifecycleReceipt> {
    const db = await databaseConnection();
    const state = stateRow(db);
    if (state.mode !== 'update-silence') {
      return { outcome: 'failed', error: '当前不在更新静默', snapshot: await snapshot() };
    }
    const residual = await activeResidualProcesses(true);
    db.prepare(`UPDATE loop_lifecycle_state SET update_readiness = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE singleton = 1`)
      .run(residual.length ? 'blocked' : 'ready', residual.length ? '受管后台进程尚未退出' : null);
    return residual.length
      ? { outcome: 'blocked', residualProcesses: residual, snapshot: await snapshot() }
      : { outcome: 'ready-for-update', snapshot: await snapshot() };
  }

  async function reconcileOwned(): Promise<LifecycleReceipt> {
    const token = await acquireLease();
    if (token === null) {
      await closeRuntimeEventHub();
      return { outcome: 'observer', snapshot: await snapshot() };
    }
    await ensureRuntimeEventHub(token);
    const db = await databaseConnection();
    const supersededResidual = await cleanupSupersededProcesses(token);
    if (supersededResidual.length) {
      const message = `blocked-by-superseded-process: ${supersededResidual.map((item) => `${item.kind} pid=${item.pid}`).join(', ')}`;
      db.prepare(`UPDATE loop_lifecycle_state SET actual_phase = 'crashed', last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE singleton = 1`)
        .run(message);
      return { outcome: 'blocked', error: message, residualProcesses: supersededResidual, snapshot: await snapshot() };
    }
    const legacyResidual = await cleanupLegacyMaintenanceProcess();
    if (legacyResidual) {
      db.prepare(`UPDATE loop_lifecycle_state SET actual_phase = 'crashed', last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE singleton = 1`)
        .run(`blocked-by-legacy-process: ${legacyResidual.kind} pid=${legacyResidual.pid}`);
      return { outcome: 'blocked', residualProcesses: [legacyResidual], snapshot: await snapshot() };
    }
    let state = stateRow(db);
    if (state.mode === 'update-silence') {
      await stopCurrent('应用更新静默', true);
      return { outcome: 'stopped', snapshot: await snapshot() };
    }
    if (state.desired_intent === 'stopped') {
      await stopCurrent('持续运行意图已停止', false);
      return { outcome: 'stopped', snapshot: await snapshot() };
    }

    let run = await getRunStatus(token);
    if (run?.active) {
      const runGeneration = db.prepare('SELECT supervision_token FROM loop_runs WHERE run_id = ?').get(run.runId) as { supervision_token: number | null } | undefined;
      if (runGeneration?.supervision_token !== token) {
        try {
          await endRun(run.runId, true, { preserveRunIntent: true, reason: '清理旧监督代次 Runner' });
          run = null;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          db.prepare(`UPDATE loop_lifecycle_state SET actual_phase = 'crashed', last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE singleton = 1`)
            .run(`blocked-by-legacy-process: ${message}`);
          return { outcome: 'blocked', error: message, snapshot: await snapshot() };
        }
      }
    }
    let health = runnerHealthDisposition(run, state.runner_suspect_since);
    if (health.kind === 'healthy' && run) {
      const healthySince = state.healthy_since || new Date().toISOString();
      const reset = Date.now() - timestamp(healthySince) >= HEALTHY_RESET_MS;
      db.prepare(`
        UPDATE loop_lifecycle_state
        SET actual_phase = 'running', active_run_id = ?, healthy_since = ?,
            runner_suspect_since = NULL, last_health_json = ?,
            restart_count = CASE WHEN ? THEN 0 ELSE restart_count END,
            retry_at = CASE WHEN ? THEN NULL ELSE retry_at END,
            last_error = CASE WHEN ? THEN NULL ELSE last_error END,
            updated_at = CURRENT_TIMESTAMP
        WHERE singleton = 1
      `).run(run.runId, healthySince, JSON.stringify(run.health), reset ? 1 : 0, reset ? 1 : 0, reset ? 1 : 0);
      return { outcome: 'healthy', snapshot: await snapshot() };
    }

    if (health.kind === 'suspect' && run) {
      const firstObservation = !state.runner_suspect_since;
      const suspectSince = new Date(health.suspectSince).toISOString();
      db.prepare(`
        UPDATE loop_lifecycle_state
        SET actual_phase = 'running', runner_suspect_since = COALESCE(runner_suspect_since, ?),
            last_health_json = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE singleton = 1
      `).run(suspectSince, JSON.stringify(run.health), `Runner 健康检查进入宽限：${health.reason}`);
      if (firstObservation) {
        await appendLoopRunLog(run.runId, `[生命周期] Runner 心跳过期但进程仍存活，进入 ${RUNNER_STALE_GRACE_MS / 1000} 秒宽限：${health.reason}`);
      }
      return { outcome: 'backoff', warning: `Runner 心跳暂时过期，正在宽限观察：${health.reason}`, snapshot: await snapshot() };
    }

    if (state.retry_at && timestamp(state.retry_at) > Date.now()) {
      return { outcome: 'backoff', snapshot: await snapshot() };
    }
    const failureReason = `Runner 健康检查失败：${health.reason}`;
    if (run?.runId) await endRun(run.runId, true, { preserveRunIntent: true, reason: failureReason });
    state = stateRow(db);
    const restartCount = state.restart_count + 1;
    const retryAt = new Date(Date.now() + lifecycleRestartDelayMs(restartCount)).toISOString();
    db.prepare(`
      UPDATE loop_lifecycle_state
      SET actual_phase = 'starting', restart_count = ?, retry_at = ?, healthy_since = NULL,
          runner_suspect_since = NULL, last_health_json = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE singleton = 1
    `).run(restartCount, retryAt, run ? JSON.stringify(run.health) : null, failureReason);
    let runId: string | undefined;
    try {
      runId = await beginRun(`${options.adapter}-supervisor`, { preserveRunIntent: true });
      await startAgentRun(runId, token);
      db.prepare(`UPDATE loop_lifecycle_state SET actual_phase = 'running', active_run_id = ?, healthy_since = CURRENT_TIMESTAMP, runner_suspect_since = NULL, updated_at = CURRENT_TIMESTAMP WHERE singleton = 1`)
        .run(runId);
      await appendLoopRunLog(runId, `[生命周期] supervision=${token} 已启动受管 Runner`);
      return { outcome: 'started', snapshot: await snapshot() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (runId) await endRun(runId, true, { stopRunner: false, preserveRunIntent: true, reason: message }).catch(() => undefined);
      db.prepare(`UPDATE loop_lifecycle_state SET actual_phase = 'crashed', active_run_id = NULL, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE singleton = 1`)
        .run(message);
      return { outcome: 'failed', error: message, snapshot: await snapshot() };
    }
  }

  async function executeCommand(input: LifecycleCommand): Promise<LifecycleReceipt> {
    const db = await databaseConnection();
    const existing = db.prepare('SELECT receipt_json FROM loop_lifecycle_commands WHERE request_id = ?').get(input.requestId) as { receipt_json: string } | undefined;
    if (existing) return JSON.parse(existing.receipt_json) as LifecycleReceipt;
    const current = stateRow(db);
    if (current.mode === 'update-silence' && !['resume-after-update', 'prepare-update'].includes(input.action.kind)) {
      const receipt: LifecycleReceipt = { requestId: input.requestId, outcome: 'update-in-progress', snapshot: await snapshot() };
      db.prepare(`INSERT INTO loop_lifecycle_commands(request_id, source_adapter, action_kind, receipt_json) VALUES(?, ?, ?, ?)`)
        .run(input.requestId, input.source.adapter, input.action.kind, JSON.stringify(receipt));
      return receipt;
    }

    let receipt: LifecycleReceipt;
    if (input.action.kind === 'start') {
      db.prepare(`UPDATE loop_lifecycle_state SET desired_intent = 'running', intent_revision = intent_revision + 1, retry_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE singleton = 1`).run();
      let warning: string | undefined;
      if (options.setLoginStartup) {
        try {
          if (!await options.setLoginStartup(true)) warning = '无法注册开机自启；系统重启后可能需要手动打开 LoopWork';
        } catch {
          warning = '无法注册开机自启；系统重启后可能需要手动打开 LoopWork';
        }
      }
      receipt = { ...(await reconcileOwned()), requestId: input.requestId, ...(warning ? { warning } : {}) };
    } else if (input.action.kind === 'stop') {
      db.prepare(`UPDATE loop_lifecycle_state SET desired_intent = 'stopped', intent_revision = intent_revision + 1, retry_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE singleton = 1`).run();
      await stopCurrent(input.action.reason === 'application-exit' ? '退出 LoopWork' : '用户停止', false);
      let warning: string | undefined;
      if (options.setLoginStartup) {
        try {
          if (!await options.setLoginStartup(false)) warning = '无法取消开机自启';
        } catch {
          warning = '无法取消开机自启';
        }
      }
      receipt = { requestId: input.requestId, outcome: 'stopped', snapshot: await snapshot(), ...(warning ? { warning } : {}) };
    } else if (input.action.kind === 'prepare-update') {
      db.prepare(`
        UPDATE loop_lifecycle_state
        SET mode = 'update-silence', update_attempt_id = ?, update_target_version = ?,
            update_readiness = 'stopping', updated_at = CURRENT_TIMESTAMP
        WHERE singleton = 1
      `).run(input.action.attemptId, input.action.targetVersion);
      await stopCurrent('桌面应用更新', true);
      const legacyResidual = await cleanupLegacyMaintenanceProcess();
      const residual = [
        ...(legacyResidual ? [legacyResidual] : []),
        ...await activeResidualProcesses(false),
      ];
      db.prepare(`UPDATE loop_lifecycle_state SET update_readiness = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE singleton = 1`)
        .run(residual.length ? 'blocked' : 'stopping', residual.length ? '受管后台进程尚未退出' : null);
      receipt = residual.length
        ? { requestId: input.requestId, outcome: 'blocked', residualProcesses: residual, snapshot: await snapshot() }
        : { requestId: input.requestId, outcome: 'ready-for-update', snapshot: await snapshot() };
    } else {
      db.prepare(`
        UPDATE loop_lifecycle_state
        SET mode = 'normal', update_attempt_id = NULL, update_target_version = NULL,
            update_readiness = NULL, last_error = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE singleton = 1
      `).run();
      receipt = { ...(await reconcileOwned()), requestId: input.requestId, outcome: 'resumed' };
    }
    db.prepare(`INSERT INTO loop_lifecycle_commands(request_id, source_adapter, action_kind, receipt_json) VALUES(?, ?, ?, ?)`)
      .run(input.requestId, input.source.adapter, input.action.kind, JSON.stringify(receipt));
    return receipt;
  }

  async function recoverUpdateSilenceAfterRestart() {
    if (!options.installedVersion) return;
    const db = await databaseConnection();
    const state = stateRow(db);
    if (state.mode !== 'update-silence') return;
    const reachedTarget = installedVersionReachedTarget(options.installedVersion, state.update_target_version);
    const recoveryError = reachedTarget
      ? null
      : `应用已重新启动，但更新未完成：当前版本 ${options.installedVersion}，目标版本 ${state.update_target_version || '未知'}；已自动恢复运行控制`;
    db.prepare(`
      UPDATE loop_lifecycle_state
      SET mode = 'normal', update_attempt_id = NULL, update_target_version = NULL,
          update_readiness = NULL, last_error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE singleton = 1
    `).run(recoveryError);
  }

  return {
    command: (input: LifecycleCommand) => serialize(() => executeCommand(input)),
    reconcile: (input: ReconcileTrigger) => serialize(async () => {
      void input;
      return reconcileOwned();
    }),
    status: snapshot,
    registerHostProcess: (processKind: 'ui-server', pid: number) => serialize(() => registerHostProcess(processKind, pid)),
    markHostProcessExited: (processId: string) => serialize(() => markHostProcessExited(processId)),
    verifyUpdateReadiness: () => serialize(() => verifyUpdateReadiness()),
    async start() {
      // update-silence is only valid while the old desktop host is shutting
      // down. Reaching a new host process means installation either completed
      // or failed; both outcomes must restore lifecycle controls.
      await recoverUpdateSilenceAfterRestart();
      if (options.setLoginStartup) {
        const db = await databaseConnection();
        try { await options.setLoginStartup(stateRow(db).desired_intent === 'running'); } catch { /* surfaced on the next user command */ }
      }
      await serialize(() => reconcileOwned());
      renewalTimer = setInterval(() => {
        void serialize(() => reconcileOwned()).catch(() => undefined);
      }, 10_000);
      renewalTimer.unref();
    },
    async shutdown(preserveIntent = true) {
      if (renewalTimer) clearInterval(renewalTimer);
      renewalTimer = undefined;
      await serialize(async () => {
        if (preserveIntent) await stopCurrent('监督宿主退出', true);
        await closeRuntimeEventHub();
        const db = await databaseConnection();
        if (currentToken !== null) {
          db.prepare('DELETE FROM loop_supervisor_lease WHERE singleton = 1 AND owner_id = ? AND fencing_token = ?')
            .run(options.ownerId, currentToken);
        }
        currentToken = null;
      });
    },
  };
}

type WebLoopRunLifecycle = ReturnType<typeof createLoopRunLifecycle>;
type LoopWorkGlobal = typeof globalThis & {
  __loopworkWebHost?: Promise<WebLoopRunLifecycle>;
};

const loopWorkGlobal = globalThis as LoopWorkGlobal;

export async function webLoopRunLifecycle() {
  if (!loopWorkGlobal.__loopworkWebHost) {
    loopWorkGlobal.__loopworkWebHost = (async () => {
      const host = createLoopRunLifecycle({ ownerId: `web-${process.pid}-${randomUUID()}`, adapter: 'cli' });
      await host.start();
      return host;
    })();
  }
  try {
    return await loopWorkGlobal.__loopworkWebHost;
  } catch (error) {
    loopWorkGlobal.__loopworkWebHost = undefined;
    throw error;
  }
}
