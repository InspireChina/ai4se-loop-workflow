import { spawn } from 'node:child_process';

export function waitForProcessExit(pid: number, timeoutMs: number) {
  return new Promise<boolean>((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      try {
        process.kill(pid, 0);
      } catch {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}

export async function terminateProcessTree(pid: number, timeoutMs = 5_000) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return true;
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
    return waitForProcessExit(pid, timeoutMs);
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return true;
    }
  }
  if (await waitForProcessExit(pid, Math.min(timeoutMs, 3_000))) return true;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* process already stopped */ }
  }
  return waitForProcessExit(pid, Math.max(0, timeoutMs - 3_000));
}
