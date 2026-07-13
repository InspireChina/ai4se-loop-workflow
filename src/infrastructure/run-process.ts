import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './database';

function assertRunId(runId: string) {
  if (!/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error('invalid run id');
}

export function runPidPath(runId: string) {
  assertRunId(runId);
  return join(paths.runsDir, runId, 'runner.pid');
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
