import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { appendLoopRunLog } from '../application/tasks';
import { paths } from './database';
import { readRunPid, runPidPath } from './run-process';

export function resolveRunnerCommand(runId: string, scriptName: string) {
  const script = join(paths.appRoot, 'scripts/loop', scriptName);
  const requireFromApp = createRequire(join(paths.appRoot, 'package.json'));
  const tsxCli = requireFromApp.resolve('tsx/cli');
  return { command: process.execPath, args: [tsxCli, script, runId] };
}

function waitForSpawn(child: ReturnType<typeof spawn>) {
  return new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
}

async function startDetachedRunner(runId: string, scriptName: string) {
  const launch = resolveRunnerCommand(runId, scriptName);
  const child = spawn(launch.command, launch.args, {
    cwd: paths.appRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      LOOP_APP_ROOT: paths.appRoot,
      LOOP_WORKSPACE_ROOT_OVERRIDE: paths.root,
    },
  });
  try {
    await waitForSpawn(child);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`无法启动 ${scriptName}：${detail}`, { cause: error });
  }
  child.unref();
  if (!child.pid) throw new Error(`无法启动 ${scriptName}：未获得进程 ID`);
  await mkdir(join(paths.runsDir, runId), { recursive: true });
  await writeFile(runPidPath(runId), String(child.pid), 'utf8');
  return child.pid;
}

export async function startAgentRun(runId: string) {
  const pid = await startDetachedRunner(runId, 'agent-runner.ts');
  await appendLoopRunLog(runId, `[运行] 已启动 Lane 调度 runner pid=${pid}`);
}

export async function startDispatchRetryRun(runId: string) {
  const pid = await startDetachedRunner(runId, 'dispatch-waiter.ts');
  await appendLoopRunLog(runId, `[运行] 已启动空队列重试 runner pid=${pid}`);
}

export async function stopAgentRun(runId: string) {
  const pid = readRunPid(runId) || 0;
  if (!pid || pid === process.pid) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('close', () => resolve());
      killer.once('error', () => {
        try { process.kill(pid, 'SIGTERM'); } catch { /* process already stopped */ }
        resolve();
      });
    });
    return;
  }
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
