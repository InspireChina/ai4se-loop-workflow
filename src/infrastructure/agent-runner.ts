import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appendLoopRunLog } from '../application/tasks';
import { paths } from './database';
import { readRunPid, runPidPath } from './run-process';

async function startDetachedRunner(runId: string, scriptName: string) {
  const script = join(paths.appRoot, 'scripts/loop', scriptName);
  const child = spawn('npx', ['tsx', script, runId], {
    cwd: paths.appRoot,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      LOOP_APP_ROOT: paths.appRoot,
      LOOP_WORKSPACE_ROOT_OVERRIDE: paths.root,
    },
  });
  child.unref();
  if (!child.pid) throw new Error(`failed to start ${scriptName}`);
  await mkdir(join(paths.runsDir, runId), { recursive: true });
  await writeFile(runPidPath(runId), String(child.pid), 'utf8');
  return child.pid;
}

export async function startAgentRun(runId: string) {
  const pid = await startDetachedRunner(runId, 'agent-runner.ts');
  await appendLoopRunLog(runId, `[运行] 已启动逐个执行 runner pid=${pid}`);
}

export async function startDispatchRetryRun(runId: string) {
  const pid = await startDetachedRunner(runId, 'dispatch-waiter.ts');
  await appendLoopRunLog(runId, `[运行] 已启动空队列重试 runner pid=${pid}`);
}

export async function stopAgentRun(runId: string) {
  const pid = readRunPid(runId) || 0;
  if (!pid || pid === process.pid) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return;
    }
  }
}
