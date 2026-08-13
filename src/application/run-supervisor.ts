import { appendLoopRunLog, beginRun, endRun, getRunStatus } from './tasks';
import { databaseConnection } from '../infrastructure/database';
import { startAgentRun } from '../infrastructure/agent-runner';
import { stopMaintenanceRunner } from '../infrastructure/maintenance-runner';

export type LoopRunIntent = {
  enabledAt: string;
  restartCount: number;
  lastRestartAt?: string;
  nextRestartAt?: string;
};

export type SupervisorResult = {
  status: 'disabled' | 'healthy' | 'backoff' | 'restarted' | 'failed';
  runId?: string;
  previousRunId?: string;
  restartCount?: number;
  nextRestartAt?: string;
  error?: string;
};

const INTENT_KEY = 'loop_run_intent';
const STABLE_RUN_RESET_MS = 2 * 60 * 1000;
let supervising: Promise<SupervisorResult> | undefined;
let preparingDesktopUpdate: Promise<DesktopUpdatePreparation> | undefined;

export type DesktopUpdatePreparation = {
  stoppedRunId?: string;
  runIntentPreserved: boolean;
};

type SupervisionDecision =
  | { action: 'disabled' }
  | { action: 'healthy' }
  | { action: 'backoff'; nextRestartAt: string }
  | { action: 'restart' };

function timestampMs(value: string | null | undefined) {
  if (!value) return 0;
  return new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`).getTime();
}

export function restartDelayMs(restartCount: number) {
  if (restartCount <= 1) return 10_000;
  return Math.min(5 * 60_000, 10_000 * (3 ** (restartCount - 1)));
}

export function decideLoopSupervision(intent: LoopRunIntent | null, run: Awaited<ReturnType<typeof getRunStatus>>, nowMs: number): SupervisionDecision {
  if (!intent) return { action: 'disabled' };
  if (run?.active) return { action: 'healthy' };
  if (intent.nextRestartAt && timestampMs(intent.nextRestartAt) > nowMs) {
    return { action: 'backoff', nextRestartAt: intent.nextRestartAt };
  }
  return { action: 'restart' };
}

export function readLoopRunIntent(db: Awaited<ReturnType<typeof databaseConnection>>) {
  const row = db.prepare('SELECT value FROM loop_meta WHERE key = ?').get(INTENT_KEY) as { value: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<LoopRunIntent>;
    if (typeof parsed.enabledAt !== 'string') return null;
    return {
      enabledAt: parsed.enabledAt,
      restartCount: Number.isInteger(parsed.restartCount) && Number(parsed.restartCount) >= 0 ? Number(parsed.restartCount) : 0,
      lastRestartAt: typeof parsed.lastRestartAt === 'string' ? parsed.lastRestartAt : undefined,
      nextRestartAt: typeof parsed.nextRestartAt === 'string' ? parsed.nextRestartAt : undefined,
    } satisfies LoopRunIntent;
  } catch {
    return null;
  }
}

function writeLoopRunIntent(db: Awaited<ReturnType<typeof databaseConnection>>, intent: LoopRunIntent) {
  db.prepare(`
    INSERT INTO loop_meta(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(INTENT_KEY, JSON.stringify(intent));
}

async function superviseOnce(now: Date): Promise<SupervisorResult> {
  const db = await databaseConnection();
  const intent = readLoopRunIntent(db);
  const run = await getRunStatus();
  const decision = decideLoopSupervision(intent, run, now.getTime());
  if (!intent || decision.action === 'disabled') return { status: 'disabled' };
  if (decision.action === 'healthy' && run) {
    if (intent.restartCount > 0 && now.getTime() - timestampMs(run.startedAt) >= STABLE_RUN_RESET_MS) {
      writeLoopRunIntent(db, { enabledAt: intent.enabledAt, restartCount: 0 });
    }
    return { status: 'healthy', runId: run.runId, restartCount: intent.restartCount };
  }

  if (decision.action === 'backoff') {
    return { status: 'backoff', previousRunId: run?.runId, restartCount: intent.restartCount, nextRestartAt: decision.nextRestartAt };
  }

  const restartCount = intent.restartCount + 1;
  const lastRestartAt = now.toISOString();
  const nextRestartAt = new Date(now.getTime() + restartDelayMs(restartCount)).toISOString();
  // Persist the claim before launching. A second request will observe backoff
  // instead of creating a duplicate runner while this launch is in flight.
  writeLoopRunIntent(db, { ...intent, restartCount, lastRestartAt, nextRestartAt });

  let runId: string | undefined;
  try {
    runId = await beginRun('desktop-supervisor', { preserveRunIntent: true });
    await appendLoopRunLog(runId, `[恢复] Runner 健康检查失败，桌面 Supervisor 自动恢复运行；previous=${run?.runId || 'none'} attempt=${restartCount}`);
    await startAgentRun(runId);
    return { status: 'restarted', runId, previousRunId: run?.runId, restartCount, nextRestartAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (runId) {
      try {
        await appendLoopRunLog(runId, `[恢复] 桌面 Supervisor 自动恢复失败：${message}`);
        await endRun(runId, true, { stopRunner: false, preserveRunIntent: true, reason: `Supervisor 启动失败：${message}` });
      } catch { /* the next health check retains the original launch failure */ }
    }
    return { status: 'failed', runId, previousRunId: run?.runId, restartCount, nextRestartAt, error: message };
  }
}

export function superviseLoopRun(now = new Date()) {
  if (supervising) return supervising;
  supervising = superviseOnce(now).finally(() => {
    supervising = undefined;
  });
  return supervising;
}

async function prepareDesktopUpdateOnce(): Promise<DesktopUpdatePreparation> {
  // An already-dispatched health check may still be starting a replacement
  // runner. Let it settle before taking the update shutdown snapshot.
  if (supervising) {
    try { await supervising; } catch { /* shutdown below is still authoritative */ }
  }
  const run = await getRunStatus();
  if (run?.runId) {
    await appendLoopRunLog(run.runId, '[更新] 正在安全停止 Runner；安装完成后将自动继续运行');
    await endRun(run.runId, false, {
      preserveRunIntent: true,
      reason: '桌面应用更新',
    });
  }
  await stopMaintenanceRunner();
  const db = await databaseConnection();
  return {
    stoppedRunId: run?.runId,
    runIntentPreserved: Boolean(readLoopRunIntent(db)),
  };
}

export function prepareLoopForDesktopUpdate() {
  if (preparingDesktopUpdate) return preparingDesktopUpdate;
  preparingDesktopUpdate = prepareDesktopUpdateOnce().finally(() => {
    preparingDesktopUpdate = undefined;
  });
  return preparingDesktopUpdate;
}
