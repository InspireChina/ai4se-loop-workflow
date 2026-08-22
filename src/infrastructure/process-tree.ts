import { spawn } from 'node:child_process';

export type ProcessIdentity = { pid: number; startMarker: string };
type ProcessIdentityPlatform = NodeJS.Platform;
type WaitForProcessIdentityOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  inspect?: (pid: number) => ProcessIdentity | null | Promise<ProcessIdentity | null>;
  isAlive?: (pid: number) => boolean;
};

const WINDOWS_IDENTITY_CONCURRENCY = 2;
let activeWindowsIdentityQueries = 0;
const windowsIdentityWaiters: Array<() => void> = [];
const processIdentityInFlight = new Map<number, Promise<ProcessIdentity | null>>();

async function withWindowsIdentitySlot<T>(work: () => Promise<T>) {
  if (activeWindowsIdentityQueries >= WINDOWS_IDENTITY_CONCURRENCY) {
    await new Promise<void>((resolve) => windowsIdentityWaiters.push(resolve));
  }
  activeWindowsIdentityQueries += 1;
  try {
    return await work();
  } finally {
    activeWindowsIdentityQueries -= 1;
    windowsIdentityWaiters.shift()?.();
  }
}

function commandOutput(command: string, args: string[], timeoutMs = 5_000) {
  return new Promise<string>((resolve) => {
    let stdout = '';
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      resolve('');
      return;
    }
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value.trim());
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 64 * 1024) stdout += chunk.toString('utf8');
    });
    child.once('error', () => finish(''));
    child.once('close', (code) => finish(code === 0 ? stdout : ''));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish('');
    }, timeoutMs);
    timer.unref();
  });
}

export function processIdentityCommand(pid: number, platform: ProcessIdentityPlatform = process.platform) {
  return platform === 'win32'
    ? {
      command: 'powershell.exe',
      args: [
        '-NoProfile', '-NonInteractive', '-Command',
        // Get-Process exposes a newly spawned process sooner than the eventually consistent CIM view.
        `$target = Get-Process -Id ${pid} -ErrorAction Stop; $target.StartTime.ToUniversalTime().ToString('o')`,
      ],
    }
    : { command: 'ps', args: ['-o', 'lstart=', '-p', String(pid)] };
}

async function inspectProcessIdentityUnshared(pid: number): Promise<ProcessIdentity | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const lookup = processIdentityCommand(pid);
  const output = await commandOutput(lookup.command, lookup.args);
  const startMarker = process.platform === 'win32' ? output : output.replace(/\s+/g, ' ');
  return startMarker ? { pid, startMarker } : null;
}

export function inspectProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(null);
  if (process.platform !== 'win32') return inspectProcessIdentityUnshared(pid);
  const pending = processIdentityInFlight.get(pid);
  if (pending) return pending;
  const inspection = withWindowsIdentitySlot(() => inspectProcessIdentityUnshared(pid))
    .finally(() => processIdentityInFlight.delete(pid));
  processIdentityInFlight.set(pid, inspection);
  return inspection;
}

export function processIdentityMatches(
  identity: ProcessIdentity,
  expectedStartMarker: string,
) {
  return identity.startMarker === expectedStartMarker;
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
    const identity = await inspect(pid);
    if (identity) return identity;
    if (!isAlive(pid) || Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(1, deadline - Date.now()))));
  }
}

export async function inspectProcessCommand(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return '';
  return process.platform === 'win32'
    ? await commandOutput('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\").CommandLine`,
    ])
    : await commandOutput('ps', ['-o', 'command=', '-p', String(pid)]);
}

async function processTreePids(rootPid: number) {
  const output = await commandOutput('ps', ['-axo', 'pid=,ppid=']);
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
    if (expectedStartMarker) {
      const identity = await inspectProcessIdentity(pid);
      if (!identity) return !processExists(pid);
      if (!processIdentityMatches(identity, expectedStartMarker)) return true;
    }
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
  const identity = await inspectProcessIdentity(pid);
  if (!identity) {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }
  if (expectedStartMarker && !processIdentityMatches(identity, expectedStartMarker)) return true;
  const tree = await processTreePids(pid);
  if (!tree) return false;
  for (const processId of tree) {
    try { process.kill(processId, 'SIGTERM'); } catch { /* process already stopped */ }
  }
  if (await waitForProcessExit(pid, Math.min(timeoutMs, 3_000))) {
    const identities = await Promise.all(tree.map((processId) => inspectProcessIdentity(processId)));
    return identities.every((candidate) => candidate === null);
  }
  for (const processId of tree) {
    try { process.kill(processId, 'SIGKILL'); } catch { /* process already stopped */ }
  }
  const exited = await waitForProcessExit(pid, Math.max(0, timeoutMs - 3_000));
  if (!exited) return false;
  const identities = await Promise.all(tree.map((processId) => inspectProcessIdentity(processId)));
  return identities.every((candidate) => candidate === null);
}
