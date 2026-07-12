#!/usr/bin/env tsx
import '../load-env.js';
import { appendLoopRunLog, createLoopDispatch, getRunStatus } from '../../src/application/tasks';
import { startCursorAgentRun } from '../../src/infrastructure/cursor-agent';

const leaseId = process.argv[2];
if (!leaseId) throw new Error('missing lease id');

const retryMs = Number(process.env.LOOP_EMPTY_DISPATCH_RETRY_MS || 5 * 60 * 1000);
const retryDelayLabel = retryMs >= 60000 ? `${Math.max(1, Math.round(retryMs / 60000))} 分钟` : `${Math.max(1, Math.round(retryMs / 1000))} 秒`;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isLeaseActive() {
  const run = await getRunStatus();
  return Boolean(run?.active && run.leaseId === leaseId);
}

async function main() {
  await appendLoopRunLog(leaseId, `[运行] 当前 0 个 agent，${retryDelayLabel}后自动重试`);
  let attempt = 1;

  while (await isLeaseActive()) {
    await sleep(retryMs);
    if (!(await isLeaseActive())) return;

    await appendLoopRunLog(leaseId, `[运行] 第 ${attempt} 次重试派发`);
    const dispatch = await createLoopDispatch(leaseId, { includeRunHeader: false });
    if (dispatch.delegations.length > 0) {
      await appendLoopRunLog(leaseId, `[运行] 重试发现 ${dispatch.delegations.length} 个 agent，启动 Cursor Agent`);
      await startCursorAgentRun(leaseId);
      return;
    }
    await appendLoopRunLog(leaseId, `[运行] 当前 0 个 agent，${retryDelayLabel}后自动重试`);
    attempt += 1;
  }
}

main().catch(async (error) => {
  await appendLoopRunLog(leaseId, `[错误] 空队列重试 runner 退出：${error instanceof Error ? error.message : String(error)}`);
});
