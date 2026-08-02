import { ipcRenderer } from "electron";

export const windowApi = {
  minimize: () => ipcRenderer.invoke("window-minimize"),
  maximize: () => ipcRenderer.invoke("window-maximize"),
  close: () => ipcRenderer.invoke("window-close"),
  isMaximized: () => ipcRenderer.invoke("window-is-maximized"),
  onMaximizedChange: (cb: (maximized: boolean) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, val: boolean) => cb(val);
    ipcRenderer.on("window-maximized-changed", handler);
    return () => ipcRenderer.removeListener("window-maximized-changed", handler);
  },
};
