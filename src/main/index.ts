import { app, BrowserWindow, ipcMain, globalShortcut } from "electron";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { registerProjectHandlers } from "./ipc/project.js";
import { registerOrchestratorHandlers } from "./ipc/orchestrator.js";
import { registerHistoryHandlers } from "./ipc/history.js";

// One-shot cleanup of the legacy SQLite directory retired in 007-sqlite-removal.
// Audit trail now lives per-project in <projectDir>/.dex/runs/.
function cleanupLegacyDb(): void {
  const legacyDb = path.join(os.homedir(), ".dex", "db");
  if (fs.existsSync(legacyDb)) {
    fs.rmSync(legacyDb, { recursive: true, force: true });
    console.info("[dex] removed legacy SQLite directory:", legacyDb);
  }
}

let mainWindow: BrowserWindow | null = null;

// Parse CLI arguments
const args = process.argv.slice(2);
const isDev = args.includes("--dev");
const vitePortIdx = args.indexOf("--vite-port");
const vitePort = vitePortIdx !== -1 && args[vitePortIdx + 1]
  ? args[vitePortIdx + 1]
  : "5173";

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    icon: path.join(__dirname, "../../docs/logo/logo.png"),
    frame: false,
    backgroundColor: "#131520",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL(`http://localhost:${vitePort}`);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  // Window control IPC
  ipcMain.handle("window-minimize", () => mainWindow?.minimize());
  ipcMain.handle("window-maximize", () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });
  ipcMain.handle("window-close", () => mainWindow?.close());
  ipcMain.handle("window-is-maximized", () =>
    mainWindow?.isMaximized() ?? false
  );

  // Forward window state changes to renderer
  mainWindow.on("maximize", () => {
    mainWindow?.webContents.send("window-maximized-changed", true);
  });
  mainWindow.on("unmaximize", () => {
    mainWindow?.webContents.send("window-maximized-changed", false);
  });

  // Register IPC handlers (audit storage now lives per-project; no global init)
  registerProjectHandlers();
  registerOrchestratorHandlers(() => mainWindow);
  registerHistoryHandlers();

  // DevTools toggle
  globalShortcut.register("F12", () => {
    mainWindow?.webContents.toggleDevTools();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  cleanupLegacyDb();
  createWindow();
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
