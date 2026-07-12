import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { appendLoopRunLog, loopRunLogPath } from '../application/tasks';
import { paths } from './database';

export function cursorRunnerPidPath(leaseId: string) {
  return join(dirname(loopRunLogPath(leaseId)), 'cursor-agent.pid');
}

export async function startCursorAgentRun(leaseId: string) {
  const script = join(paths.appRoot, 'scripts/loop/cursor-runner.ts');
  const child = spawn('npx', ['tsx', script, leaseId], {
    cwd: paths.appRoot,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      LOOP_APP_ROOT: paths.appRoot,
      LOOP_WORKSPACE_ROOT: paths.root,
    },
  });
  child.unref();
  await mkdir(dirname(cursorRunnerPidPath(leaseId)), { recursive: true });
  await writeFile(cursorRunnerPidPath(leaseId), String(child.pid), 'utf8');
  await appendLoopRunLog(leaseId, `[Cursor] 已启动后台 runner pid=${child.pid}`);
}

export async function stopCursorAgentRun(leaseId: string) {
  let pid = 0;
  try {
    const { readFile } = await import('node:fs/promises');
    pid = Number((await readFile(cursorRunnerPidPath(leaseId), 'utf8')).trim());
  } catch {
    return;
  }
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
