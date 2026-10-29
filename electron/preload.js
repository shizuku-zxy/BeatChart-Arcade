// ============ 预加载桥：渲染进程安全访问本地文件与对话框 ============
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('beatchart', {
  isElectron: true,
  storageGet: (key) => ipcRenderer.invoke('storage:get', key),
  storageSet: (key, value) => ipcRenderer.invoke('storage:set', key, value),
  audioSave: (id, ext, data) => ipcRenderer.invoke('audio:save', id, ext, data),
  audioRead: (id, ext) => ipcRenderer.invoke('audio:read', id, ext),
  audioDelete: (fileName) => ipcRenderer.invoke('audio:delete', fileName),
  exportSave: (defaultName, data) => ipcRenderer.invoke('export:save', defaultName, data),
});
