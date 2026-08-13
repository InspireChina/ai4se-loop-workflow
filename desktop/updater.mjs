import { app, ipcMain } from 'electron';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { autoUpdater } = require('electron-updater');

let targetWindow;
let initialized = false;
let state = initialState();

function initialState() {
  return {
    supported: app.isPackaged && (process.platform === 'darwin' || process.platform === 'win32'),
    packaged: app.isPackaged,
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    status: 'idle',
  };
}

function publicError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(github\.com\/)repos\/[^\s]+/gi, '$1…');
}

function updateState(patch) {
  state = { ...state, ...patch };
  targetWindow?.webContents.send('loopwork:updater:state', state);
  return state;
}

function assertTrustedSender(event) {
  if (!targetWindow || event.sender !== targetWindow.webContents) {
    throw new Error('Updater request rejected');
  }
}

function assertSupported() {
  if (!state.supported) throw new Error('自动升级仅支持已安装的 Windows 和 macOS 桌面应用');
}

function installHandlers() {
  ipcMain.handle('loopwork:updater:get-state', (event) => {
    assertTrustedSender(event);
    return state;
  });
  ipcMain.handle('loopwork:updater:check', async (event) => {
    assertTrustedSender(event);
    assertSupported();
    if (state.status === 'checking' || state.status === 'downloading') return state;
    updateState({ status: 'checking', error: undefined });
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      updateState({ status: 'error', error: publicError(error) });
    }
    return state;
  });
  ipcMain.handle('loopwork:updater:download', async (event) => {
    assertTrustedSender(event);
    assertSupported();
    if (state.status !== 'available' && state.status !== 'error') return state;
    updateState({ status: 'downloading', error: undefined, percent: 0 });
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      updateState({ status: 'error', error: publicError(error) });
    }
    return state;
  });
  ipcMain.handle('loopwork:updater:install', (event) => {
    assertTrustedSender(event);
    assertSupported();
    if (state.status !== 'downloaded') return false;
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return true;
  });
}

function installUpdaterEvents() {
  autoUpdater.on('checking-for-update', () => updateState({ status: 'checking', error: undefined }));
  autoUpdater.on('update-available', (info) => updateState({
    status: 'available',
    latestVersion: info.version,
    releaseName: typeof info.releaseName === 'string' ? info.releaseName : undefined,
    releaseDate: info.releaseDate,
    error: undefined,
  }));
  autoUpdater.on('update-not-available', (info) => updateState({
    status: 'up-to-date',
    latestVersion: info.version,
    releaseDate: info.releaseDate,
    error: undefined,
  }));
  autoUpdater.on('download-progress', (progress) => updateState({
    status: 'downloading',
    percent: Math.max(0, Math.min(100, progress.percent)),
    transferred: progress.transferred,
    total: progress.total,
    bytesPerSecond: progress.bytesPerSecond,
    error: undefined,
  }));
  autoUpdater.on('update-downloaded', (info) => updateState({
    status: 'downloaded',
    latestVersion: info.version,
    percent: 100,
    error: undefined,
  }));
  autoUpdater.on('error', (error) => updateState({ status: 'error', error: publicError(error) }));
}

export function configureUpdater(window) {
  targetWindow = window;
  state = { ...state, currentVersion: app.getVersion(), packaged: app.isPackaged };
  if (initialized) return;
  initialized = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = console;
  installUpdaterEvents();
  installHandlers();
}

export function detachUpdaterWindow(window) {
  if (targetWindow === window) targetWindow = undefined;
}
