import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, powerMonitor, powerSaveBlocker, shell, Tray } from 'electron';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { configureUpdater, detachUpdaterWindow } from './updater.mjs';
import { runtimeFallbackDocument } from './runtime-fallback.mjs';
import {createDesktopRuntimeHost,startDesktopRuntimeUi} from './runtime-host.mjs';

let mainWindow;
let lifecycle;
let tray;
let quitting = false;
let quitPrepared = false;
let systemShutdown = false;
let updatePreparation;
let selectedRuntimeRoot;
let acceptedRendererUrl;
let startupStore;
let startupPromise;
let uiRecoveryTimer;
let uiRecoveryDelay = 1_000;
const startupCancellation=new AbortController();

function runtimeRoot() {
  return selectedRuntimeRoot || (app.isPackaged
    ? join(process.resourcesPath, 'app-server')
    : join(app.getAppPath(), '..', 'desktop-runtime'));
}

function managementRuntimeRoot() {
  return app.isPackaged
    ? join(process.resourcesPath, 'management-bootstrap')
    : join(app.getAppPath(), '..', 'desktop-runtime');
}

function configureRuntimeEnvironment(root) {
  process.env.LOOP_DESKTOP = '1';
  process.env.LOOP_DESKTOP_NODE = process.execPath;
  process.env.LOOP_APP_ROOT = root;
  process.env.LOOP_DATA_ROOT = join(app.getPath('userData'), 'data');
}

async function createLifecycle(root) {
  // Load recovery code and its native dependencies from an independently
  // packaged image. The mutable/selected business image is only data passed
  // to that root and may already be damaged before any capability starts.
  const managementRoot=managementRuntimeRoot();
  const requireFromRuntime = createRequire(join(managementRoot, 'package.json'));
  const { createNativeExternalService } = requireFromRuntime(join(managementRoot, 'desktop-runners', 'external-runtime.cjs'));
  const options = {
    appRoot: root, managementRoot, dataRoot: join(app.getPath('userData'), 'data'),
    executable: process.execPath, electronNode: true,
    signal:startupCancellation.signal,onStoreReady:store=>{startupStore=store;},
    ownerId: `electron-${process.pid}-${randomUUID()}`,
    onError: (error) => console.error('[runtime]', error),
    onUiUnavailable:(error)=>{
      if(mainWindow&&!mainWindow.isDestroyed()&&!quitting){
        acceptedRendererUrl=`data:text/html;charset=utf-8,${encodeURIComponent(runtimeFallbackDocument(error.message))}`;
        void mainWindow.loadURL(acceptedRendererUrl).then(scheduleUiRecovery).catch(reason=>console.error('[control-page]',reason));
      }
    },
    inhibitIdleSleep: async (signal) => {
      signal.throwIfAborted();
      const blocker = powerSaveBlocker.start('prevent-app-suspension');
      return { isActive: () => powerSaveBlocker.isStarted(blocker),
        release: async () => { if (powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker); } };
    },
  };
  const setStartup = (desired) => {
    if (!app.isPackaged) return;
    app.setLoginItemSettings({ openAtLogin: desired === 'running', openAsHidden: desired === 'running', args: desired === 'running' ? ['--hidden'] : [] });
  };
  const pending=createDesktopRuntimeHost({createService:()=>createNativeExternalService(options),setStartup,
    onCreated:host=>{lifecycle=host;},isQuitting:()=>quitting,deferStartup:true,onError:error=>console.error('[startup]',error)});
  startupPromise=pending;
  try{
    const host=await pending;
    selectedRuntimeRoot=host.service.store.runtimeInstallation()?.artifact.root||host.service.bootstrap.root;
    configureRuntimeEnvironment(runtimeRoot());
    return host;
  }finally{if(startupPromise===pending){startupPromise=undefined;startupStore=undefined;}}
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

async function startServer() {
  if(!lifecycle&&startupPromise)await startupPromise;
  if (!lifecycle) throw new Error('独立运行宿主尚未初始化');
  return startDesktopRuntimeUi(lifecycle,availablePort);
}

function cancelUiRecovery(){
  if(uiRecoveryTimer)clearTimeout(uiRecoveryTimer);
  uiRecoveryTimer=undefined;uiRecoveryDelay=1_000;
}

function scheduleUiRecovery(){
  if(uiRecoveryTimer||quitting||!mainWindow||mainWindow.isDestroyed())return;
  const delay=uiRecoveryDelay;
  uiRecoveryTimer=setTimeout(async()=>{
    uiRecoveryTimer=undefined;
    if(quitting||!mainWindow||mainWindow.isDestroyed())return;
    try{
      const {url}=await startServer();
      acceptedRendererUrl=url;await mainWindow.loadURL(url);cancelUiRecovery();
    }catch(error){
      console.error('[ui-recovery]',error);
      uiRecoveryDelay=Math.min(delay*2,30_000);scheduleUiRecovery();
    }
  },delay);
  uiRecoveryTimer.unref();
}

async function stopServer() {
  if (lifecycle && !await lifecycle.ui.stop()) throw new Error('界面服务实际退出未确认');
}

function prepareForUpdate(targetVersion) {
  if (updatePreparation) return updatePreparation;
  updatePreparation = (async () => {
    if (!targetVersion) throw new Error('更新目标版本缺失');
    quitting = true;
    await stopServer().catch(error=>console.error('[update-ui-stop]',error));
    await lifecycle.shutdown().catch(error=>console.error('[update-runtime-stop]',error));
    quitPrepared = true;
  })().catch(async (error) => {
    quitting = false;
    updatePreparation = undefined;
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        const { url } = await startServer();
        acceptedRendererUrl=url;
        await mainWindow.loadURL(url);
      } catch (restartError) {
        const detail = restartError instanceof Error ? restartError.message : String(restartError);
        acceptedRendererUrl=`data:text/html;charset=utf-8,${encodeURIComponent(runtimeFallbackDocument(detail))}`;
        await mainWindow.loadURL(acceptedRendererUrl);
        throw new Error(`${error instanceof Error ? error.message : String(error)}；恢复控制界面失败：${detail}`);
      }
    }
    throw error;
  });
  return updatePreparation;
}

function trustedRenderer(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Lifecycle request rejected');
  const current=event.sender.getURL();
  if(!acceptedRendererUrl)throw new Error('Lifecycle request rejected');
  if(acceptedRendererUrl.startsWith('data:')){if(current!==acceptedRendererUrl)throw new Error('Lifecycle request rejected');}
  else if(new URL(current).origin!==new URL(acceptedRendererUrl).origin)throw new Error('Lifecycle request rejected');
}

function installLifecycleHandlers() {
  ipcMain.handle('loopwork:lifecycle:retry-ui',async(event)=>{
    trustedRenderer(event);const {url}=await startServer();acceptedRendererUrl=url;await mainWindow.loadURL(url);cancelUiRecovery();
  });
  ipcMain.handle('loopwork:lifecycle:status', async (event) => {
    trustedRenderer(event);
    if(!lifecycle)return {initializing:true,message:'运行宿主正在初始化'};
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
  return nativeImage.createFromPath(join(app.getAppPath(), 'assets', 'tray-icon.png'));
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function reportShutdownFailure(error){
  quitting=false;console.error('[shutdown]',error);
  if(mainWindow&&!mainWindow.isDestroyed()){
    acceptedRendererUrl=`data:text/html;charset=utf-8,${encodeURIComponent(runtimeFallbackDocument(error instanceof Error?error.message:String(error)))}`;
    void mainWindow.loadURL(acceptedRendererUrl).catch(reason=>console.error('[control-page]',reason));
  }
}

async function requestExplicitQuit() {
  if (quitPrepared) return;
  quitting = true;
  cancelUiRecovery();
  let commandError;
  if(!lifecycle&&startupPromise){
    try{startupStore?.setIntent('stopped',randomUUID());}catch(error){commandError=error;}
    startupCancellation.abort(new Error('user-stop-during-startup'));
    await startupPromise.catch(()=>undefined);
  }
  if (lifecycle) {
    try { const receipt=await lifecycle.command({
      requestId: randomUUID(),
      source: { adapter: 'electron', instanceId: `electron-${process.pid}`, actor: 'human' },
      action: { kind: 'stop', reason: 'application-exit' },
    });
      if(receipt.outcome==='cleanup-pending')commandError=new Error(receipt.error||'停止清理尚未完成');
    } catch(error) { commandError=error; }
  }
  const cleanup=await Promise.allSettled([lifecycle?.shutdown()]);
  const failures=cleanup.flatMap(result=>result.status==='rejected'?[result.reason]:[]);
  if(failures.length||commandError){quitting=false;throw new AggregateError([...failures,...(commandError?[commandError]:[])],'退出尚未完成，进程屏障保留');}
  quitPrepared = true;
  app.quit();
}

async function requestSystemShutdown() {
  if (quitPrepared) return;
  systemShutdown = true;
  quitting = true;
  cancelUiRecovery();
  await lifecycle?.shutdown(true);
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
    { label: '退出 LoopWork', click: () => void requestExplicitQuit().catch(reportShutdownFailure) },
  ]));
  tray.on('click', showMainWindow);
}

async function createWindow() {
  const initialUrl=`data:text/html;charset=utf-8,${encodeURIComponent(runtimeFallbackDocument('运行宿主正在初始化，业务界面准备完成后会自动加载。'))}`;
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
    void requestSystemShutdown().catch(reportShutdownFailure);
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
  acceptedRendererUrl=initialUrl;await window.loadURL(initialUrl);
  void startServer().then(async({url})=>{
    if(mainWindow!==window||window.isDestroyed()||quitting)return;
    acceptedRendererUrl=url;await window.loadURL(url);cancelUiRecovery();
  }).catch(async error=>{
    if(mainWindow!==window||window.isDestroyed()||quitting)return;
    acceptedRendererUrl=`data:text/html;charset=utf-8,${encodeURIComponent(runtimeFallbackDocument(error instanceof Error?error.message:String(error)))}`;
    await window.loadURL(acceptedRendererUrl);scheduleUiRecovery();
  }).catch(error=>console.error('[control-page]',error));
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();
else {
  app.on('second-instance', () => {
    showMainWindow();
  });
  app.whenReady().then(async () => {
    const bootstrap = runtimeRoot();
    configureRuntimeEnvironment(bootstrap);
    const initializing=createLifecycle(bootstrap);
    installLifecycleHandlers();
    createTray();
    powerMonitor.on('shutdown', (event) => {
      if (quitPrepared) return;
      event.preventDefault();
      void requestSystemShutdown().catch(reportShutdownFailure);
    });
    powerMonitor.on('resume', () => {
      void lifecycle?.reconcile({
        source: { adapter: 'electron', instanceId: `electron-${process.pid}` },
        trigger: 'periodic-health-check',
      });
    });
    await createWindow();
    lifecycle=await initializing;
    if(quitting)return;
  }).catch(async (error) => {
    if(quitting)return;
    console.error(error);
    await dialog.showMessageBox({
      type: 'error',
      title: 'LoopWork failed to start',
      message: 'LoopWork failed to start',
      detail: error instanceof Error ? error.stack || error.message : String(error),
    });
    quitting = true;
    await stopServer().catch(() => undefined);
    await lifecycle?.shutdown(true).catch(() => undefined);
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
    void requestExplicitQuit().catch(reportShutdownFailure);
    return;
  }
  quitting = true;
  if (!quitPrepared && !updatePreparation && !systemShutdown) void lifecycle?.shutdown(true);
});

app.on('window-all-closed', () => {
  // Closing the UI leaves the Electron lifecycle host running in the tray.
});
