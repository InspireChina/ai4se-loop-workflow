import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { appendLoopRunLog, registerRunProcess } from '../application/tasks';
import { databaseConnection, paths } from './database';
import { inspectProcessCommand, terminateProcessTree, waitForProcessIdentity } from './process-tree';
import {
  cancelRunnerStartGate,
  createRunnerStartGate,
  isProcessAlive,
  readRunPid,
  releaseRunnerStartGate,
  runPidPath,
} from './run-process';
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

async function startManagedRunner(runId: string, scriptName: string, supervisionToken: number) {
  const launch = resolveRunnerCommand(runId, scriptName);
  const gate = await createRunnerStartGate(runId);
  const child = spawn(launch.command, launch.args, {
    cwd: paths.appRoot,
    detached: false,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      ...runtimeNodeEnvironment(),
      LOOP_APP_ROOT: paths.appRoot,
      LOOP_WORKSPACE_ROOT_OVERRIDE: paths.root,
      LOOP_SUPERVISION_TOKEN: String(supervisionToken),
      LOOP_RUNNER_START_GATE_TOKEN: gate.token,
    },
  });
  try {
    await waitForSpawn(child);
  } catch (error) {
    await cancelRunnerStartGate(gate);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`无法启动 ${scriptName}：${detail}`, { cause: error });
  }
  if (!child.pid) throw new Error(`无法启动 ${scriptName}：未获得进程 ID`);
  const identity = await waitForProcessIdentity(child.pid);
  if (!identity) {
    await terminateProcessTree(child.pid, 5_000).catch(() => false);
    await cancelRunnerStartGate(gate);
    const detail = child.exitCode !== null
      ? `进程已退出，exit code=${child.exitCode}`
      : child.signalCode
        ? `进程已退出，signal=${child.signalCode}`
        : '等待进程身份信息就绪超时';
    throw new Error(`无法启动 ${scriptName}：${detail}`);
  }
  try {
    await writeFile(runPidPath(runId), String(child.pid), 'utf8');
    await registerRunProcess(runId, 'agent-runner', child.pid, supervisionToken, identity.startMarker);
    await releaseRunnerStartGate(gate);
  } catch (error) {
    await terminateProcessTree(child.pid, 5_000, identity.startMarker);
    await cancelRunnerStartGate(gate);
    throw error;
  }
  return child.pid;
}

export async function startAgentRun(runId: string, supervisionToken = Number(process.env.LOOP_SUPERVISION_TOKEN || 0)) {
  if (!Number.isInteger(supervisionToken) || supervisionToken <= 0) throw new Error('缺少有效的 supervision token');
  const pid = await startManagedRunner(runId, 'agent-runner.ts', supervisionToken);
  await appendLoopRunLog(runId, `[运行] 已启动 Lane 调度 runner pid=${pid}`);
}

export async function stopAgentRun(runId: string) {
  const db = await databaseConnection();
  const registered = db.prepare(`
    SELECT process_id, process_kind, pid, process_start_marker
    FROM loop_managed_processes
    WHERE run_id = ? AND process_kind IN ('agent-cli', 'agent-runner') AND status = 'running'
    ORDER BY CASE process_kind WHEN 'agent-cli' THEN 0 ELSE 1 END, registered_at DESC
  `).all(runId) as Array<{
    process_id: string;
    process_kind: 'agent-cli' | 'agent-runner';
    pid: number;
    process_start_marker: string;
  }>;
  for (const managedProcess of registered) {
    if (managedProcess.pid === process.pid) {
      throw new Error(`拒绝停止当前宿主进程 pid=${managedProcess.pid}`);
    }
    if (!await terminateProcessTree(managedProcess.pid, 10_000, managedProcess.process_start_marker)) {
      throw new Error(`无法停止 ${managedProcess.process_kind} 进程树 pid=${managedProcess.pid}`);
    }
    db.prepare(`
      UPDATE loop_managed_processes SET status = 'exited', exited_at = CURRENT_TIMESTAMP
      WHERE process_id = ?
    `).run(managedProcess.process_id);
  }

  if (registered.some((process) => process.process_kind === 'agent-runner')) return;
  const pid = readRunPid(runId) || 0;
  if (!pid || pid === process.pid) return;
  if (process.platform === 'win32') {
    if (!await terminateProcessTree(pid, 10_000)) throw new Error(`无法停止旧 Runner 进程树 pid=${pid}`);
    return;
  }
  const command = inspectProcessCommand(pid);
  if (!command && !isProcessAlive(pid)) return;
  const knownLegacyRunner = command.includes('agent-runner') || command.includes('dispatch-waiter');
  if (!knownLegacyRunner || !command.includes(runId)) {
    throw new Error(`无法验证旧 Runner 进程身份 pid=${pid}`);
  }
  if (!await terminateProcessTree(pid, 10_000)) {
    throw new Error(`无法停止旧 Runner 进程树 pid=${pid}`);
  }
}
