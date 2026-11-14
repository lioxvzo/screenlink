const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  selectSource: (id) => ipcRenderer.invoke('select-source', id),
  launchOptions: () => ipcRenderer.invoke('launch-options'),
  log: (...parts) => ipcRenderer.send('log', parts.map(String).join(' ')),
});
