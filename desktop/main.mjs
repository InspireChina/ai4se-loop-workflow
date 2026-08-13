import { app, BrowserWindow, dialog, shell } from 'electron';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { configureUpdater, detachUpdaterWindow } from './updater.mjs';

let mainWindow;
let serverProcess;
let quitting = false;

function runtimeRoot() {
  return app.isPackaged
    ? join(process.resourcesPath, 'app-server')
    : join(app.getAppPath(), '..', 'desktop-runtime');
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
  serverProcess.stdout?.on('data', (chunk) => console.log(`[server] ${chunk.toString().trimEnd()}`));
  serverProcess.stderr?.on('data', (chunk) => console.error(`[server] ${chunk.toString().trimEnd()}`));
  await waitForServer(url, serverProcess);
  return url;
}

function stopServer() {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  serverProcess.kill('SIGTERM');
  serverProcess = undefined;
}

async function createWindow() {
  const url = await startServer();
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
  configureUpdater(window);
  window.once('closed', () => {
    detachUpdaterWindow(window);
    if (mainWindow === window) mainWindow = undefined;
  });
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  window.once('ready-to-show', () => window.show());
  await window.loadURL(url);
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();
else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });
  app.whenReady().then(createWindow).catch(async (error) => {
    console.error(error);
    await dialog.showMessageBox({
      type: 'error',
      title: 'LoopWork failed to start',
      message: 'LoopWork failed to start',
      detail: error instanceof Error ? error.stack || error.message : String(error),
    });
    app.quit();
  });
}

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && !quitting) void createWindow();
});

app.on('before-quit', () => {
  quitting = true;
  stopServer();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
