import { spawn } from 'node:child_process';
import { mkdir, open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { paths } from './database';
import { terminateProcessTree } from './process-tree';
import { isProcessAlive } from './run-process';
import { isDesktopRuntime, runtimeNodeEnvironment, runtimeNodeExecutable, runtimeScript } from './runtime-entry';

export function maintenancePidPath() {
  return join(paths.dataDir, 'software-maintenance', 'runner.pid');
}

function launchLockPath() {
  return join(paths.dataDir, 'software-maintenance', 'launch.lock');
}

async function currentMaintenancePid() {
  try {
    const pid = Number((await readFile(maintenancePidPath(), 'utf8')).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

export async function startMaintenanceRunner() {
  await mkdir(join(paths.dataDir, 'software-maintenance'), { recursive: true });
  let lock;
  try {
    lock = await open(launchLockPath(), 'wx', 0o600);
  } catch (error) {
    try {
      const age = Date.now() - (await stat(launchLockPath())).mtimeMs;
      if (age > 30_000) {
        await unlink(launchLockPath());
        return startMaintenanceRunner();
      }
    } catch { /* another launcher completed */ }
    return { started: false, pid: await currentMaintenancePid() };
  }
  try {
    const current = await currentMaintenancePid();
    if (isProcessAlive(current)) return { started: false, pid: current };
    const script = runtimeScript('maintenance-runner');
    const args = isDesktopRuntime()
      ? [script]
      : [createRequire(join(paths.appRoot, 'package.json')).resolve('tsx/cli'), script];
    const child = spawn(runtimeNodeExecutable(), args, {
      cwd: paths.appRoot,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ...runtimeNodeEnvironment(), LOOP_APP_ROOT: paths.appRoot, LOOP_WORKSPACE_ROOT_OVERRIDE: paths.root },
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
    if (!child.pid) throw new Error('无法启动 software maintenance runner：未获得 PID');
    await writeFile(maintenancePidPath(), String(child.pid), 'utf8');
    return { started: true, pid: child.pid };
  } finally {
    await lock.close();
    try { await unlink(launchLockPath()); } catch { /* lock already cleared */ }
  }
}

export async function stopMaintenanceRunner() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const pid = await currentMaintenancePid();
    if (!pid) break;
    if (!await terminateProcessTree(pid)) {
      throw new Error(`无法停止 software maintenance 进程树 pid=${pid}`);
    }
    try { await unlink(maintenancePidPath()); } catch { /* runner already removed its PID */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const remainingPid = await currentMaintenancePid();
  if (isProcessAlive(remainingPid)) {
    throw new Error(`software maintenance 进程在停止后重新启动 pid=${remainingPid}`);
  }
  try { await unlink(maintenancePidPath()); } catch { /* no maintenance runner is active */ }
}
