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

function commandOutput(command: string, args: string[], timeoutMs = 5_000, maxOutput = 64 * 1024) {
  return new Promise<string>((resolve) => {
    let stdout = '';
    let settled = false;
    let overflow = false;
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
      stdout += chunk.toString('utf8');
      if (stdout.length > maxOutput) { overflow = true; stdout = stdout.slice(0, maxOutput); }
    });
    child.once('error', () => finish(''));
    child.once('close', (code) => finish(code === 0 && !overflow ? stdout : ''));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish('');
    }, timeoutMs);
    timer.unref();
  });
}

export function parseProcessGroupSnapshot(output: string, groupId: number): ProcessIdentity[] {
  const result: ProcessIdentity[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match || Number(match[2]) !== groupId) continue;
    result.push({ pid: Number(match[1]), startMarker: match[3].replace(/\s+/g, ' ') });
  }
  return result;
}

/** Includes orphaned members even after the original root was reaped. */
export async function inspectProcessGroup(groupId: number): Promise<ProcessIdentity[] | null> {
  if (process.platform === 'win32' || !Number.isInteger(groupId) || groupId <= 0) return null;
  const output = await commandOutput('ps', ['-axo', 'pid=,pgid=,lstart='], 5_000, 2 * 1024 * 1024);
  return output ? parseProcessGroupSnapshot(output, groupId) : null;
}

export async function terminateProcessGroup(groupId: number, timeoutMs = 5_000, expectedStartMarker?: string) {
  if (process.platform === 'win32' || !Number.isInteger(groupId) || groupId <= 0 || groupId === process.pid) return false;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const inspectOwned = async () => {
    const members = await inspectProcessGroup(groupId);
    if (!members || members.some((member) => member.pid === process.pid)) return null;
    const root = members.find((member) => member.pid === groupId);
    if (root && expectedStartMarker && !processIdentityMatches(root, expectedStartMarker)) return null;
    return members;
  };
  const original = await inspectOwned();
  if (!original) return false;
  if (!original.length) return true;
  const signal = async (kind: NodeJS.Signals) => {
    const current = await inspectOwned();
    if (!current) return false;
    if (!current.length) return true;
    try { process.kill(-groupId, kind); return true; } catch { return false; }
  };
  const wait = async (until: number) => {
    while (true) {
      const members = await inspectOwned();
      if (!members) return false;
      if (!members.length) return true;
      if (Date.now() >= until) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  if (!await signal('SIGTERM')) return wait(Date.now());
  if (await wait(Math.min(deadline, Date.now() + 3_000))) return true;
  if (!await signal('SIGKILL')) return false;
  return wait(deadline);
}

/** POSIX process groups do not contain descendants that call setsid/setpgid
 * (Cursor tool shells do this). While the CLI root is still present, capture
 * and terminate its full parent tree as well as its original orphan-safe
 * group. Both proofs are required before the allocation can be released. */
export async function terminateProcessGroupTree(rootPid: number, timeoutMs = 5_000, expectedStartMarker?: string) {
  if (process.platform === 'win32') return false;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const tree = await terminateProcessTree(rootPid, Math.max(0, deadline - Date.now()), expectedStartMarker);
  const group = await terminateProcessGroup(rootPid, Math.max(0, deadline - Date.now()), expectedStartMarker);
  return tree && group;
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

export function waitForProcessExit(pid: number, timeoutMs: number, isAlive = processExists) {
  return new Promise<boolean>((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (!isAlive(pid)) {
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
  const identities = await Promise.all(tree.map((processId) => inspectProcessIdentity(processId)));
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const signalOriginalProcesses = async (signal: NodeJS.Signals) => {
    for (let index = 0; index < tree.length; index += 1) {
      const original = identities[index];
      const current = await inspectProcessIdentity(tree[index]);
      // A recycled PID must not receive a signal intended for the old tree.
      if (!original || !current || !processIdentityMatches(current, original.startMarker)) continue;
      try { process.kill(tree[index], signal); } catch { /* verification below remains authoritative */ }
    }
  };
  const waitForTree = async (durationMs: number) => {
    const until = Math.min(deadline, Date.now() + Math.max(0, durationMs));
    while (true) {
      const remaining = await Promise.all(tree.map(async (processId, index) => {
        if (!processExists(processId)) return false;
        const current = await inspectProcessIdentity(processId);
        // Inspection failure for a live process is uncertainty, not proof of exit.
        return !current || !identities[index] || processIdentityMatches(current, identities[index]!.startMarker);
      }));
      if (remaining.every((alive) => !alive)) return true;
      if (Date.now() >= until) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  await signalOriginalProcesses('SIGTERM');
  if (await waitForTree(Math.min(timeoutMs, 3_000))) return true;
  // The root may have exited while a descendant ignored SIGTERM. Escalate the
  // captured tree, rather than treating root exit as successful cancellation.
  await signalOriginalProcesses('SIGKILL');
  return waitForTree(Math.max(0, deadline - Date.now()));
}
