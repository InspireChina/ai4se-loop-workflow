#!/usr/bin/env tsx
import '../load-env.js';
import { appendLoopRunLog, getRunStatus, recordRuntimeEventWithFallback, startRunHeartbeat } from '../../src/application/tasks';
import { enqueueSoftwareMaintenance } from '../../src/application/software-maintenance';
import { recordRuntimeException } from '../../src/application/runtime-events';
import { startAgentRun } from '../../src/infrastructure/agent-runner';
import { startMaintenanceRunner } from '../../src/infrastructure/maintenance-runner';

const runId = process.argv[2];
if (!runId) throw new Error('missing run id');

const retryMs = Number(process.env.LOOP_EMPTY_DISPATCH_RETRY_MS || 5 * 60 * 1000);
const retryDelayLabel = retryMs >= 60000 ? `${Math.max(1, Math.round(retryMs / 60000))} 分钟` : `${Math.max(1, Math.round(retryMs / 1000))} 秒`;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isRunActive() {
  const run = await getRunStatus();
  return Boolean(run?.active && run.runId === runId);
}

async function main() {
  await appendLoopRunLog(runId, `[运行] 当前 0 个 agent，${retryDelayLabel}后自动重试`);

  while (await isRunActive()) {
    await sleep(retryMs);
    if (!(await isRunActive())) return;

    await appendLoopRunLog(runId, '[运行] 定时唤醒统一调度 Runner');
    await appendLoopRunLog(runId, '[运行] 唤醒统一调度 Runner，优先恢复已有结果，再计算新派发');
    await startAgentRun(runId);
    return;
  }
}

async function run() {
  let failure: unknown;
  let stopHeartbeat: (() => void) | undefined;
  try {
    stopHeartbeat = await startRunHeartbeat(runId, 'dispatch-waiter');
    await main();
  } catch (error) {
    failure = error;
    await appendLoopRunLog(runId, `[错误] 空队列重试 runner 退出：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    stopHeartbeat?.();
    if (!failure) return;
    try {
      const eventId = await recordRuntimeEventWithFallback(
        runId,
        'dispatch-waiter 结构化异常事件写入失败，不影响原始失败',
        () => recordRuntimeException({ runId, component: 'dispatch-waiter', stage: 'finally', error: failure, fatal: true }),
      );
      const jobId = await enqueueSoftwareMaintenance({
        triggerKind: 'runner_error', runId, eventFromId: eventId, severity: 'FATAL',
        summary: failure instanceof Error ? failure.message : String(failure),
      });
      if (jobId) await startMaintenanceRunner();
    } catch { /* maintenance must never replace the original runner outcome */ }
  }
}

void run();
