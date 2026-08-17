const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('loopworkUpdater', {
  getState: () => ipcRenderer.invoke('loopwork:updater:get-state'),
  checkForUpdates: () => ipcRenderer.invoke('loopwork:updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('loopwork:updater:download'),
  installUpdate: () => ipcRenderer.invoke('loopwork:updater:install'),
  subscribe: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('loopwork:updater:state', handler);
    return () => ipcRenderer.removeListener('loopwork:updater:state', handler);
  },
});

contextBridge.exposeInMainWorld('loopworkLifecycle', {
  status: () => ipcRenderer.invoke('loopwork:lifecycle:status'),
  command: (action) => ipcRenderer.invoke('loopwork:lifecycle:command', action),
});
