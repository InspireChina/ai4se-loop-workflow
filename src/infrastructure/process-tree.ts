import { execFileSync, spawn } from 'node:child_process';

export type ProcessIdentity = { pid: number; startMarker: string };
type WaitForProcessIdentityOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  inspect?: (pid: number) => ProcessIdentity | null;
  isAlive?: (pid: number) => boolean;
};

function commandOutput(command: string, args: string[]) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 5_000 }).trim();
  } catch {
    return '';
  }
}

export function inspectProcessIdentity(pid: number): ProcessIdentity | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'win32') return processExists(pid) ? { pid, startMarker: `windows-pid:${pid}` } : null;
  const startMarker = commandOutput('ps', ['-o', 'lstart=', '-p', String(pid)]).replace(/\s+/g, ' ');
  return startMarker ? { pid, startMarker } : null;
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function waitForProcessIdentity(pid: number, options: WaitForProcessIdentityOptions = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const timeoutMs = Math.max(0, options.timeoutMs ?? 5_000);
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 100);
  const inspect = options.inspect ?? inspectProcessIdentity;
  const isAlive = options.isAlive ?? processExists;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const identity = inspect(pid);
    if (identity) return identity;
    if (!isAlive(pid) || Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(1, deadline - Date.now()))));
  }
}

export function inspectProcessCommand(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return '';
  return process.platform === 'win32'
    ? commandOutput('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\").CommandLine`,
    ])
    : commandOutput('ps', ['-o', 'command=', '-p', String(pid)]);
}

function processTreePids(rootPid: number) {
  const output = commandOutput('ps', ['-axo', 'pid=,ppid=']);
  if (!output) return null;
  const children = new Map<number, number[]>();
  for (const line of output.split(/\r?\n/)) {
    const [pidValue, parentValue] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(pidValue) || !Number.isInteger(parentValue)) continue;
    const current = children.get(parentValue) || [];
    current.push(pidValue);
    children.set(parentValue, current);
  }
  const ordered: number[] = [];
  const visit = (pid: number) => {
    for (const child of children.get(pid) || []) visit(child);
    ordered.push(pid);
  };
  visit(rootPid);
  return [...new Set(ordered)];
}

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

export function windowsTaskkillCommand(pid: number) {
  return { command: 'taskkill.exe', args: ['/PID', String(pid), '/T', '/F'] };
}

export async function terminateProcessTree(pid: number, timeoutMs = 5_000, expectedStartMarker?: string) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return true;
  if (process.platform === 'win32') {
    const launch = windowsTaskkillCommand(pid);
    await new Promise<void>((resolve) => {
      const killer = spawn(launch.command, launch.args, {
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
  const identity = inspectProcessIdentity(pid);
  if (!identity) {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }
  if (expectedStartMarker && identity.startMarker !== expectedStartMarker) return true;
  const tree = processTreePids(pid);
  if (!tree) return false;
  for (const processId of tree) {
    try { process.kill(processId, 'SIGTERM'); } catch { /* process already stopped */ }
  }
  if (await waitForProcessExit(pid, Math.min(timeoutMs, 3_000))) {
    return tree.every((processId) => inspectProcessIdentity(processId) === null);
  }
  for (const processId of tree) {
    try { process.kill(processId, 'SIGKILL'); } catch { /* process already stopped */ }
  }
  const exited = await waitForProcessExit(pid, Math.max(0, timeoutMs - 3_000));
  return exited && tree.every((processId) => inspectProcessIdentity(processId) === null);
}
