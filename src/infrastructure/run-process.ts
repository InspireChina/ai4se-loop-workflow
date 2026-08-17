import { readFileSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { paths } from './database';

function assertRunId(runId: string) {
  if (!/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error('invalid run id');
}

export function runPidPath(runId: string) {
  assertRunId(runId);
  return join(paths.runsDir, runId, 'runner.pid');
}

export function runnerStartGatePath(runId: string) {
  assertRunId(runId);
  return join(paths.runsDir, runId, 'runner.start-gate');
}

export type RunnerStartGate = { runId: string; token: string };

export async function createRunnerStartGate(runId: string): Promise<RunnerStartGate> {
  const token = randomUUID();
  await mkdir(join(paths.runsDir, runId), { recursive: true });
  await writeFile(runnerStartGatePath(runId), `pending:${token}`, 'utf8');
  return { runId, token };
}

export async function releaseRunnerStartGate(gate: RunnerStartGate) {
  const path = runnerStartGatePath(gate.runId);
  const current = await readFile(path, 'utf8');
  if (current.trim() !== `pending:${gate.token}`) throw new Error('Runner 启动闸门状态不匹配');
  await writeFile(path, `ready:${gate.token}`, 'utf8');
}

export async function cancelRunnerStartGate(gate: RunnerStartGate) {
  await unlink(runnerStartGatePath(gate.runId)).catch(() => undefined);
}

export async function waitForRunnerStartGate(runId: string, token: string, timeoutMs = 30_000) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const path = runnerStartGatePath(runId);
  while (true) {
    try {
      if ((await readFile(path, 'utf8')).trim() === `ready:${token}`) {
        await unlink(path).catch(() => undefined);
        return;
      }
    } catch { /* the parent has not released the gate yet */ }
    if (Date.now() >= deadline) throw new Error('Runner 启动闸门等待超时');
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
  }
}

export function readRunPid(runId: string) {
  try {
    const pid = Number(readFileSync(runPidPath(runId), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number | null) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isRunProcessAlive(runId: string) {
  return isProcessAlive(readRunPid(runId));
}
