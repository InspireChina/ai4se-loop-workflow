import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { appendLoopRunLog, registerRunProcess } from '../application/tasks';
import { paths } from './database';
import { terminateProcessTree } from './process-tree';
import { readRunPid, runPidPath } from './run-process';
import { isDesktopRuntime, runtimeNodeEnvironment, runtimeNodeExecutable, runtimeScript } from './runtime-entry';

export function resolveRunnerCommand(runId: string, scriptName: string) {
  const name = scriptName.replace(/\.ts$/, '');
  if (isDesktopRuntime()) {
    return { command: runtimeNodeExecutable(), args: [runtimeScript(name), runId] };
  }
  const script = runtimeScript(name);
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
      ...runtimeNodeEnvironment(),
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
  const processKind = scriptName === 'dispatch-waiter.ts' ? 'dispatch-waiter' : 'agent-runner';
  await registerRunProcess(runId, processKind, child.pid);
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
  if (!await terminateProcessTree(pid)) {
    throw new Error(`无法停止 Runner 进程树 pid=${pid}`);
  }
}
