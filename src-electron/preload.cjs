const { contextBridge, ipcRenderer } = require("electron");
const subscribe = (channel, callback) => {
  if (typeof callback !== "function") return () => {};
  const listener = (_event, state) => callback(state);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld("desktopAPI", Object.freeze({
  getWindowState: () => ipcRenderer.invoke("desktop:window-state"),
  windowAction: action => ipcRenderer.invoke("desktop:window-action", action),
  onWindowState: callback => subscribe("desktop:window-state-changed", callback),
  getUpdateState: () => ipcRenderer.invoke("desktop:update-state"),
  checkUpdate: () => ipcRenderer.invoke("desktop:update-check"),
  downloadUpdate: () => ipcRenderer.invoke("desktop:update-download"),
  installUpdate: () => ipcRenderer.invoke("desktop:update-install"),
  onUpdateState: callback => subscribe("desktop:update-state-changed", callback),
}));
