import { spawn } from 'node:child_process';
import { IdleSleepAcquisitionFailure, type IdleSleepInhibitor } from '../application/runtime-idle-sleep';

const ready = 'LOOPWORK_IDLE_SLEEP_READY';

/** All potentially slow platform initialization runs outside the event loop.
 * No display/away-mode assertion and no persistent power-setting mutation.
 * Pipes (Linux/Windows) or -w (macOS) release the assertion on host death. */
export function idleSleepHelper(platform: NodeJS.Platform, node = process.execPath, pid = process.pid) {
  if (platform === 'darwin') return { command: '/usr/bin/caffeinate', args: ['-i', '-w', String(pid)], needsReady: false };
  if (platform === 'linux') return { command: 'systemd-inhibit', args: [
    '--what=idle', '--mode=block', '--who=LoopWork', '--why=LoopWork business or automatic repair is running',
    node, '-e', `process.stdin.resume();process.stdin.once('end',()=>process.exit(0));console.log('${ready}');`,
  ], needsReady: true };
  if (platform === 'win32') {
    const script = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LoopWorkIdleSleep {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern uint SetThreadExecutionState(uint flags);
}
'@
if ([LoopWorkIdleSleep]::SetThreadExecutionState([uint32]2147483649) -eq 0) { throw 'SetThreadExecutionState failed' }
try {
  $stop = [Console]::In.ReadLineAsync()
  [Console]::Out.WriteLine('${ready}')
  [Console]::Out.Flush()
  while (-not $stop.IsCompleted) { [System.Threading.Thread]::Sleep(1000) }
} finally { [void][LoopWorkIdleSleep]::SetThreadExecutionState([uint32]2147483648) }
`;
    return { command: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], needsReady: true };
  }
  throw new Error(`当前平台尚无防空闲休眠适配器：${platform}`);
}

export function createNativeIdleSleepInhibitor(ports: { spawn?: typeof spawn; platform?: NodeJS.Platform; readinessTimeoutMs?: number } = {}): IdleSleepInhibitor {
  return async signal => {
    signal.throwIfAborted();
    const specification = idleSleepHelper(ports.platform || process.platform, process.env.LOOP_DESKTOP_NODE || process.execPath);
    const child = (ports.spawn || spawn)(specification.command, specification.args, {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, ...(process.env.LOOP_DESKTOP_NODE ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
    });
    let error: Error | undefined;
    let diagnostic = '';
    let output = '';
    let settled = false;
    let closed = false;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const started = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const markReady = () => { if (!settled) { settled = true; resolveReady(); } };
    const failReady = (reason: Error) => { if (!settled) { settled = true; rejectReady(reason); } };
    const exited = new Promise<void>(resolve => {
      child.once('close', (code, reason) => {
        closed = true;
        error ||= new Error(`防休眠 helper 退出：code=${code}, signal=${reason}, stderr=${diagnostic}`);
        failReady(error || new Error(`防休眠 helper 提前退出：code=${code}, signal=${reason}, stderr=${diagnostic}`));
        resolve();
      });
    });
    child.once('error', reason => { error = reason; failReady(reason); });
    child.stdin.on('error', reason => { error = reason; failReady(reason); });
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-4_000); });
    child.stdout.on('data', chunk => {
      output = (output + chunk.toString()).slice(-512);
      if (output.includes(ready)) markReady();
    });
    // caffeinate does not emit readiness. Its successful spawn and continued
    // process lifetime are monitored; actual macOS assertions are smoke-tested.
    let spawnTimer: NodeJS.Timeout | undefined;
    child.once('spawn', () => { if (!specification.needsReady) spawnTimer = setTimeout(markReady, 100); });
    const timeout = setTimeout(() => failReady(new Error(`防休眠 helper 启动超时：${diagnostic}`)), ports.readinessTimeoutMs || 10_000);
    const aborted = () => failReady(new Error('防休眠申请已取消'));
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    let inputEnded = false;
    async function release() {
      if (!inputEnded) { inputEnded = true; child.stdin.end('\n'); }
      if (closed) return;
      child.kill('SIGTERM');
      const wait = async (ms: number) => {
        let timer: NodeJS.Timeout | undefined;
        try { return await Promise.race([exited.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
        finally { if (timer) clearTimeout(timer); }
      };
      if (!await wait(2_000)) {
        child.kill('SIGKILL');
        if (!await wait(5_000)) throw new Error(`防休眠 helper ${child.pid} 实际退出尚未确认`);
      }
    }
    const handle = { isActive: () => !error && !closed && child.exitCode === null && child.signalCode === null, release, failure: () => error };
    try {
      await started;
      signal.throwIfAborted();
      return handle;
    } catch (reason) {
      try { await release(); }
      catch (cleanup) { throw new IdleSleepAcquisitionFailure(`防休眠申请失败且退出未确认：${String(reason)}；${String(cleanup)}`, handle, { cause: reason }); }
      throw reason;
    }
    finally {
      clearTimeout(timeout);
      if (spawnTimer) clearTimeout(spawnTimer);
      signal.removeEventListener('abort', aborted);
    }
  };
}
