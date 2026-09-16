import { randomUUID } from 'node:crypto';
import { databaseConnection, paths } from '../infrastructure/database';
import { registerManagedProcessInDb } from '../infrastructure/managed-process-registry';
import { isProcessAlive, readRunPid } from '../infrastructure/run-process';
import { toUtcIsoString } from './event-time';
import { appendLoopRunLog } from './loop-run-log';

export type RunStatus = {
  runId: string;
  owner: string;
  startedAt: string;
  heartbeatAt: string | null;
  processKind: string | null;
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'crashed';
  pid: number | null;
  active: boolean;
  health: {
    starting: boolean;
    pidAlive: boolean;
    heartbeatFresh: boolean;
    heartbeatAgeMs: number | null;
    generationActive: boolean;
  };
} | null;

type BeginRunOptions = { preserveRunIntent?: boolean };

async function reconcileDispatchLanes() {
  const { progressDispatcher } = await import('./progress-dispatch');
  return progressDispatcher.reconcileStaleLanes();
}

function interruptedExecutionRecoveryLog(recovered: Awaited<ReturnType<typeof import('./executions')['reconcileInterruptedExecutions']>>) {
  return `${recovered.deferredCount} 个执行因正常停止而延期且不计失败，`
    + `${recovered.retryableCount} 个无结果执行转为可重试，`
    + `${recovered.blockedCount} 个无结果执行因重试耗尽而阻塞，`
    + `${recovered.cancelledReservationCount} 个未启动派发已取消，`
    + `${recovered.recoverableCount + recovered.pendingResultCount} 个已有结果执行等待恢复`;
}

export async function beginRun(owner = 'ui', options: BeginRunOptions = {}) {
  const { ensureAgentRuntimeWorkspace } = await import('./agent-profiles');
  await ensureAgentRuntimeWorkspace();
  const db = await databaseConnection();
  const current = getRunStatusFromDb(db);
  if (current?.active) {
    throw new Error(`已有本地 loop 正在运行 pid=${current.pid ?? 'starting'}`);
  }
  if (current?.runId) {
    const { stopAgentRun } = await import('../infrastructure/agent-runner');
    const { reconcileInterruptedExecutions } = await import('./executions');
    await stopAgentRun(current.runId);
    const recovered = await reconcileInterruptedExecutions(current.runId, 'Runner 异常退出，执行尚未返回结构化结果');
    db.prepare(`
      UPDATE loop_runs
      SET status = 'crashed', finished_at = CURRENT_TIMESTAMP,
          failure_reason = COALESCE(failure_reason, '启动新一轮时检测到 Runner 已退出')
      WHERE run_id = ? AND status IN ('starting', 'running', 'stopping')
    `).run(current.runId);
    db.prepare("DELETE FROM loop_meta WHERE key = 'active_run'").run();
    await reconcileDispatchLanes();
    await appendLoopRunLog(current.runId, `[恢复] 检测到旧 Runner 已退出：${interruptedExecutionRecoveryLog(recovered)}`);
  } else {
    const { reconcileInterruptedExecutions } = await import('./executions');
    const recovered = await reconcileInterruptedExecutions(null, '未找到所属 Runner，执行尚未返回结构化结果');
    if (recovered.failedCount) await reconcileDispatchLanes();
  }
  const runId = randomUUID();
  const startedAt = new Date();
  db.transaction(() => {
    if (!options.preserveRunIntent) {
      db.prepare(`
        INSERT INTO loop_meta(key, value) VALUES('loop_run_intent', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
      `).run(JSON.stringify({ enabledAt: toUtcIsoString(startedAt), restartCount: 0 }));
    }
    db.prepare(`
      INSERT INTO loop_runs(run_id, owner, status, started_at)
      VALUES(?, ?, 'starting', ?)
    `).run(runId, owner, toUtcIsoString(startedAt));
    db.prepare(`
      INSERT INTO loop_meta(key, value) VALUES('active_run', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run(JSON.stringify({ runId, owner, startedAt: toUtcIsoString(startedAt) }));
  })();
  await appendLoopRunLog(runId, `[运行] 开始运行 run=${runId}`);
  await appendLoopRunLog(runId, `[运行] 工作区=${paths.root}`);
  await appendLoopRunLog(runId, `[运行] 数据目录=${paths.dataDir}`);
  return runId;
}

export async function endRun(runId: string, force = false, options: { stopRunner?: boolean; reason?: string; preserveRunIntent?: boolean } = {}) {
  const db = await databaseConnection();
  const current = getRunStatusFromDb(db);
  if (current?.runId && current.runId !== runId) {
    if (force) return;
    throw new Error('运行 ID 不匹配');
  }
  // Clear the durable intent before stopping the process so the desktop
  // supervisor cannot race a deliberate user stop and start a replacement.
  if (!options.preserveRunIntent) db.prepare("DELETE FROM loop_meta WHERE key = 'loop_run_intent'").run();
  const reason = options.reason || (force ? '异常终止' : '用户停止');
  const { reconcileInterruptedExecutions, reconcileInterruptedExecutionsInDb } = await import('./executions');
  // Fence a deliberate stop before killing CLI processes. Their exit callbacks
  // can otherwise record a runtime failure before post-stop reconciliation.
  const deferredBeforeStop = current?.runId && !force
    ? db.transaction(() => {
      const deferred = reconcileInterruptedExecutionsInDb(db, current.runId!,
        `Loop 已停止（${reason}），执行尚未返回结构化结果`, { countAsFailure: false });
      // The reservation fence and cancellation become visible together. A
      // concurrent Runner cannot reserve replacement work between them.
      db.prepare("UPDATE loop_runs SET status = 'stopping', stop_requested_at = CURRENT_TIMESTAMP WHERE run_id = ?").run(current.runId);
      return deferred;
    }).immediate()
    : null;
  if (current?.runId && options.stopRunner !== false) {
    if (!deferredBeforeStop) db.prepare("UPDATE loop_runs SET status = 'stopping', stop_requested_at = CURRENT_TIMESTAMP WHERE run_id = ?").run(current.runId);
    const { stopAgentRun } = await import('../infrastructure/agent-runner');
    await stopAgentRun(current.runId);
  }
  if (current?.runId) {
    const recovered = deferredBeforeStop || await reconcileInterruptedExecutions(
      current.runId,
      `Loop 已停止（${reason}），执行尚未返回结构化结果`,
      { countAsFailure: force },
    );
    await reconcileDispatchLanes();
    await appendLoopRunLog(current.runId, `[运行] Loop 已停止：${reason}`);
    await appendLoopRunLog(current.runId, `[恢复] ${interruptedExecutionRecoveryLog(recovered)}，将在下次运行继续`);
    db.prepare(`
      UPDATE loop_runs
      SET status = ?, finished_at = CURRENT_TIMESTAMP, failure_reason = ?
      WHERE run_id = ?
    `).run(force ? 'crashed' : 'stopped', force ? reason : null, current.runId);
  }
  db.prepare("DELETE FROM loop_meta WHERE key = 'active_run'").run();
}

type LoopRunRow = {
  run_id: string;
  owner: string;
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'crashed';
  process_kind: string | null;
  runner_pid: number | null;
  started_at: string;
  heartbeat_at: string | null;
  supervision_token: number | null;
};

const RUN_HEARTBEAT_TIMEOUT_MS = 45_000;

function databaseTimestampMs(value: string | null | undefined) {
  if (!value) return 0;
  return new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`).getTime();
}

export function getRunStatusFromDb(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  expectedSupervisionToken = Number(process.env.LOOP_SUPERVISION_TOKEN || 0),
) {
  const row = db.prepare("SELECT value FROM loop_meta WHERE key = 'active_run'").get() as { value: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as { runId: string; owner: string; startedAt: string };
    const persisted = db.prepare('SELECT * FROM loop_runs WHERE run_id = ?').get(parsed.runId) as LoopRunRow | undefined;
    const pid = persisted?.runner_pid || readRunPid(parsed.runId);
    const startedAt = persisted?.started_at || parsed.startedAt;
    const heartbeatAt = persisted?.heartbeat_at || null;
    const starting = !heartbeatAt && Date.now() - databaseTimestampMs(startedAt) < 15_000;
    const heartbeatAgeMs = heartbeatAt ? Math.max(0, Date.now() - databaseTimestampMs(heartbeatAt)) : null;
    const heartbeatFresh = heartbeatAgeMs !== null && heartbeatAgeMs <= RUN_HEARTBEAT_TIMEOUT_MS;
    const pidAlive = isProcessAlive(pid);
    let generationActive = true;
    const runnerToken = expectedSupervisionToken;
    if (runnerToken > 0) {
      const lifecycle = db.prepare(`SELECT desired_intent, mode FROM loop_lifecycle_state WHERE singleton = 1`).get() as { desired_intent: string; mode: string } | undefined;
      const lease = db.prepare(`SELECT fencing_token, expires_at FROM loop_supervisor_lease WHERE singleton = 1`).get() as { fencing_token: number; expires_at: string } | undefined;
      generationActive = lifecycle?.desired_intent === 'running'
        && lifecycle.mode === 'normal'
        && persisted?.supervision_token === runnerToken
        && lease?.fencing_token === runnerToken
        && databaseTimestampMs(lease.expires_at) + 15_000 > Date.now();
    }
    const active = generationActive && persisted?.status !== 'stopped' && persisted?.status !== 'crashed'
      && (starting || (pidAlive && heartbeatFresh));
    return {
      runId: parsed.runId,
      owner: persisted?.owner || parsed.owner,
      startedAt,
      heartbeatAt,
      processKind: persisted?.process_kind || null,
      status: persisted?.status || 'starting',
      pid,
      active,
      health: { starting, pidAlive, heartbeatFresh, heartbeatAgeMs, generationActive },
    } satisfies NonNullable<RunStatus>;
  } catch {
    return null;
  }
}

export async function getRunStatus(expectedSupervisionToken?: number): Promise<RunStatus> {
  const db = await databaseConnection();
  return getRunStatusFromDb(db, expectedSupervisionToken);
}

export async function registerRunProcess(runId: string, processKind: 'agent-runner', pid: number, supervisionToken: number, processStartMarker: string) {
  const db = await databaseConnection();
  db.transaction(() => {
    const lease = db.prepare(`SELECT fencing_token, expires_at FROM loop_supervisor_lease WHERE singleton = 1`).get() as { fencing_token: number; expires_at: string } | undefined;
    const lifecycle = db.prepare(`SELECT desired_intent, mode FROM loop_lifecycle_state WHERE singleton = 1`).get() as { desired_intent: string; mode: string } | undefined;
    if (!lease || lease.fencing_token !== supervisionToken || databaseTimestampMs(lease.expires_at) <= Date.now()
      || lifecycle?.desired_intent !== 'running' || lifecycle.mode !== 'normal') {
      throw new Error('Runner 登记被拒绝：监督代次已经失效');
    }
    const updated = db.prepare(`
      UPDATE loop_runs
      SET status = 'running', process_kind = ?, runner_pid = ?, supervision_token = ?, heartbeat_at = CURRENT_TIMESTAMP
      WHERE run_id = ? AND status IN ('starting', 'running')
    `).run(processKind, pid, supervisionToken, runId);
    if (updated.changes !== 1) throw new Error('Runner 登记被拒绝：运行状态已经变化');
    registerManagedProcessInDb(db, {
      processId: randomUUID(),
      supervisionToken,
      processKind: 'agent-runner',
      pid,
      processStartMarker,
      runId,
    });
  }).immediate();
}

export async function heartbeatRun(runId: string, processKind: 'agent-runner') {
  const db = await databaseConnection();
  const supervisionToken = Number(process.env.LOOP_SUPERVISION_TOKEN || 0);
  db.prepare(`
    UPDATE loop_runs
    SET status = 'running', process_kind = ?, heartbeat_at = CURRENT_TIMESTAMP
    WHERE run_id = ? AND supervision_token = ? AND status IN ('starting', 'running')
  `).run(processKind, runId, supervisionToken);
}

export async function startRunHeartbeat(runId: string, processKind: 'agent-runner') {
  await heartbeatRun(runId, processKind);
  const timer = setInterval(() => {
    void heartbeatRun(runId, processKind).catch(() => { /* main runner owns error reporting */ });
  }, 10_000);
  timer.unref();
  return () => clearInterval(timer);
}

export async function ensureLoopRuntimeFiles() {
  await databaseConnection();
}
