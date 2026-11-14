const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  selectSource: (id, audio) => ipcRenderer.invoke('select-source', id, audio),
  launchOptions: () => ipcRenderer.invoke('launch-options'),
  log: (...parts) => ipcRenderer.send('log', parts.map(String).join(' ')),
  // Fernsteuerung
  controlAsk: (name) => ipcRenderer.invoke('control-ask', name),
  controlEnd: () => ipcRenderer.send('control-end'),
  controlInput: (ev) => ipcRenderer.send('control-input', ev),
  onControlEndedLocal: (fn) => ipcRenderer.on('control-ended-local', () => fn()),
  stopControlFromOverlay: () => ipcRenderer.send('control-stop-local'),
  cursorPos: () => ipcRenderer.invoke('cursor-pos'),
});
