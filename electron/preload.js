const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('botApi', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (payload) => ipcRenderer.invoke('settings:save', payload),
  getRpcLimiterStatus: () => ipcRenderer.invoke('rpc-limiter:get-status'),
  sendSettingsToRpcLimiter: (payload) => ipcRenderer.invoke('rpc-limiter:send-settings', payload),
  startBot: () => ipcRenderer.invoke('bot:start'),
  stopBot: () => ipcRenderer.invoke('bot:stop'),
  getBotStatus: () => ipcRenderer.invoke('bot:get-status'),
  applySettingsNow: () => ipcRenderer.invoke('bot:apply-settings-now'),
  cancelBid: (rowId) => ipcRenderer.invoke('bot:cancel-bid', rowId),
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  checkUpdate: () => ipcRenderer.invoke('app:check-update'),
  applyUpdate: () => ipcRenderer.invoke('app:apply-update'),
  onUpdateProgress: (handler) => {
    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on('update-progress', wrapped);
    return () => ipcRenderer.removeListener('update-progress', wrapped);
  },
  onLog: (handler) => {
    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on('bot-log', wrapped);
    return () => ipcRenderer.removeListener('bot-log', wrapped);
  },
  onStatus: (handler) => {
    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on('bot-status', wrapped);
    return () => ipcRenderer.removeListener('bot-status', wrapped);
  }
});
