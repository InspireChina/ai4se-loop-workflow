import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, powerMonitor, shell, Tray } from 'electron';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { configureUpdater, detachUpdaterWindow } from './updater.mjs';

let mainWindow;
let serverProcess;
let serverRegistration;
let lifecycle;
let tray;
let quitting = false;
let quitPrepared = false;
let systemShutdown = false;
let updatePreparation;

function runtimeRoot() {
  return app.isPackaged
    ? join(process.resourcesPath, 'app-server')
    : join(app.getAppPath(), '..', 'desktop-runtime');
}

function configureRuntimeEnvironment(root) {
  process.env.LOOP_DESKTOP = '1';
  process.env.LOOP_DESKTOP_NODE = process.execPath;
  process.env.LOOP_APP_ROOT = root;
  process.env.LOOP_DATA_ROOT = join(app.getPath('userData'), 'data');
}

async function createLifecycle(root) {
  const requireFromRuntime = createRequire(join(root, 'package.json'));
  const { createLoopRunLifecycle } = requireFromRuntime(join(root, 'desktop-runners', 'lifecycle-host.cjs'));
  const host = createLoopRunLifecycle({
    ownerId: `electron-${process.pid}-${randomUUID()}`,
    adapter: 'electron',
    installedVersion: app.getVersion(),
    setLoginStartup: async (enabled) => {
      if (!app.isPackaged) return true;
      app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: enabled, args: enabled ? ['--hidden'] : [] });
      return app.getLoginItemSettings().openAtLogin === enabled;
    },
  });
  await host.start();
  return host;
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function waitForServer(url, child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      if (child.exitCode !== null) {
        reject(new Error(`LoopWork server exited with code ${child.exitCode}`));
        return;
      }
      try {
        const response = await fetch(url);
        if (response.ok || response.status < 500) {
          resolve();
          return;
        }
      } catch { /* server is still starting */ }
      if (Date.now() >= deadline) {
        reject(new Error('Timed out while starting the LoopWork server'));
        return;
      }
      setTimeout(poll, 150);
    };
    void poll();
  });
}

async function startServer() {
  const root = runtimeRoot();
  const entry = join(root, 'server.js');
  if (!existsSync(entry)) {
    throw new Error(`Desktop runtime is missing: ${entry}\nRun npm run desktop:prepare first.`);
  }
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, [entry], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      HOSTNAME: '127.0.0.1',
      PORT: String(port),
      LOOP_DESKTOP: '1',
      LOOP_DESKTOP_NODE: process.execPath,
      LOOP_APP_ROOT: root,
      LOOP_DATA_ROOT: join(app.getPath('userData'), 'data'),
    },
  });
  try {
    if (!serverProcess.pid) throw new Error('LoopWork server started without a PID');
    serverRegistration = await lifecycle.registerHostProcess('ui-server', serverProcess.pid);
    const registeredProcessId = serverRegistration.processId;
    serverProcess.once('exit', () => {
      if (serverRegistration?.processId === registeredProcessId) serverRegistration = undefined;
      void lifecycle?.markHostProcessExited(registeredProcessId);
    });
    serverProcess.stdout?.on('data', (chunk) => console.log(`[server] ${chunk.toString().trimEnd()}`));
    serverProcess.stderr?.on('data', (chunk) => console.error(`[server] ${chunk.toString().trimEnd()}`));
    await waitForServer(url, serverProcess);
    return { url };
  } catch (error) {
    await stopServer().catch(() => undefined);
    throw error;
  }
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for child process ${child.pid} to exit`));
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
    };
    child.once('exit', onExit);
  });
}

async function stopServer() {
  const child = serverProcess;
  if (!child || child.exitCode !== null) {
    serverProcess = undefined;
    if (serverRegistration) {
      await lifecycle?.markHostProcessExited(serverRegistration.processId);
      serverRegistration = undefined;
    }
    return;
  }
  if (process.platform === 'win32' && child.pid) {
    await new Promise((resolve, reject) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      // A non-zero status can simply mean the server exited between our
      // snapshot and taskkill. The child exit check below is authoritative.
      killer.once('close', () => resolve());
      killer.once('error', reject);
    });
  } else {
    child.kill('SIGTERM');
  }
  try {
    await waitForChildExit(child, 10_000);
  } catch (error) {
    if (process.platform !== 'win32') {
      child.kill('SIGKILL');
      await waitForChildExit(child, 5_000);
    } else {
      throw error;
    }
  }
  if (serverRegistration) {
    await lifecycle.markHostProcessExited(serverRegistration.processId);
    serverRegistration = undefined;
  }
  if (serverProcess === child) serverProcess = undefined;
}

function stopServerOnQuit() {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  serverProcess.kill('SIGTERM');
  serverProcess = undefined;
}

function prepareForUpdate(targetVersion) {
  if (updatePreparation) return updatePreparation;
  updatePreparation = (async () => {
    if (!targetVersion) throw new Error('更新目标版本缺失');
    quitting = true;
    const receipt = await lifecycle.command({
      requestId: randomUUID(),
      source: { adapter: 'electron', instanceId: `electron-${process.pid}`, actor: 'host' },
      action: { kind: 'prepare-update', attemptId: randomUUID(), targetVersion },
    });
    if (receipt.outcome !== 'ready-for-update') {
      throw new Error(receipt.error || `后台进程尚未清理：${JSON.stringify(receipt.residualProcesses || [])}`);
    }
    await stopServer();
    const gate = await lifecycle.verifyUpdateReadiness();
    if (gate.outcome !== 'ready-for-update') {
      throw new Error(gate.error || `后台进程尚未清理：${JSON.stringify(gate.residualProcesses || [])}`);
    }
  })().catch(async (error) => {
    quitting = false;
    updatePreparation = undefined;
    if (!serverProcess && mainWindow && !mainWindow.isDestroyed()) {
      try {
        const { url } = await startServer();
        await mainWindow.loadURL(url);
      } catch (restartError) {
        const detail = restartError instanceof Error ? restartError.message : String(restartError);
        throw new Error(`${error instanceof Error ? error.message : String(error)}；恢复控制界面失败：${detail}`);
      }
    }
    throw error;
  });
  return updatePreparation;
}

function trustedRenderer(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Lifecycle request rejected');
}

function installLifecycleHandlers() {
  ipcMain.handle('loopwork:lifecycle:status', async (event) => {
    trustedRenderer(event);
    return lifecycle.status();
  });
  ipcMain.handle('loopwork:lifecycle:command', async (event, action) => {
    trustedRenderer(event);
    if (!action || !['start', 'stop', 'resume-after-update'].includes(action.kind)) {
      throw new Error('Lifecycle request rejected');
    }
    const safeAction = action.kind === 'stop' ? { kind: 'stop', reason: 'user-stop' } : { kind: action.kind };
    return lifecycle.command({
      requestId: randomUUID(),
      source: { adapter: 'ui', instanceId: `renderer-${event.sender.id}`, actor: 'human' },
      action: safeAction,
    });
  });
}

function trayImage() {
  return nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAKElEQVR42mNgGAXUBv8ZGBgY/jMwMDAwMDEwMPxnYGBg+M/AwMAAAH9cBfQef4sAAAAASUVORK5CYII=');
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function requestExplicitQuit() {
  if (quitPrepared) return;
  quitting = true;
  if (lifecycle) {
    await lifecycle.command({
      requestId: randomUUID(),
      source: { adapter: 'electron', instanceId: `electron-${process.pid}`, actor: 'human' },
      action: { kind: 'stop', reason: 'application-exit' },
    });
  }
  await stopServer();
  quitPrepared = true;
  app.quit();
}

async function requestSystemShutdown() {
  if (quitPrepared) return;
  systemShutdown = true;
  quitting = true;
  await lifecycle?.shutdown(true);
  await stopServer();
  quitPrepared = true;
  app.quit();
}

function createTray() {
  if (tray) return;
  tray = new Tray(trayImage());
  tray.setToolTip('LoopWork');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 LoopWork', click: showMainWindow },
    { type: 'separator' },
    { label: '退出 LoopWork', click: () => void requestExplicitQuit() },
  ]));
  tray.on('click', showMainWindow);
}

async function createWindow() {
  const { url } = await startServer();
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1000,
    minHeight: 700,
    show: false,
    title: 'LoopWork',
    backgroundColor: '#f7f7f5',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(app.getAppPath(), 'preload.cjs'),
    },
  });
  mainWindow = window;
  configureUpdater(window, (targetVersion) => prepareForUpdate(targetVersion));
  window.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
  });
  window.on('query-session-end', (event) => {
    if (quitPrepared) return;
    event.preventDefault();
    void requestSystemShutdown();
  });
  window.once('closed', () => {
    detachUpdaterWindow(window);
    if (mainWindow === window) mainWindow = undefined;
  });
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  window.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) window.show();
  });
  await window.loadURL(url);
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();
else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });
  app.whenReady().then(async () => {
    const root = runtimeRoot();
    configureRuntimeEnvironment(root);
    lifecycle = await createLifecycle(root);
    installLifecycleHandlers();
    createTray();
    powerMonitor.on('shutdown', (event) => {
      if (quitPrepared) return;
      event.preventDefault();
      void requestSystemShutdown();
    });
    powerMonitor.on('resume', () => {
      void lifecycle.reconcile({
        source: { adapter: 'electron', instanceId: `electron-${process.pid}` },
        trigger: 'periodic-health-check',
      });
    });
    await createWindow();
  }).catch(async (error) => {
    console.error(error);
    await dialog.showMessageBox({
      type: 'error',
      title: 'LoopWork failed to start',
      message: 'LoopWork failed to start',
      detail: error instanceof Error ? error.stack || error.message : String(error),
    });
    quitting = true;
    await lifecycle?.shutdown(true).catch(() => undefined);
    await stopServer().catch(() => undefined);
    quitPrepared = true;
    app.quit();
  });
}

app.on('activate', () => {
  if (mainWindow) showMainWindow();
  else if (!quitting) void createWindow();
});

app.on('before-quit', (event) => {
  if (!quitting && !quitPrepared) {
    event.preventDefault();
    void requestExplicitQuit();
    return;
  }
  quitting = true;
  stopServerOnQuit();
  if (!quitPrepared && !updatePreparation && !systemShutdown) void lifecycle?.shutdown(true);
});

app.on('window-all-closed', () => {
  // Closing the UI leaves the Electron lifecycle host running in the tray.
});
