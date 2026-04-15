import { ipcMain, type BrowserWindow } from "electron";
import type { RunConfig, OrchestratorEvent } from "../../core/types.js";
import { run, stopRun, isRunning, getRunState } from "../../core/orchestrator.js";

export function registerOrchestratorHandlers(
  getWindow: () => BrowserWindow | null
): void {
  const emit = (event: OrchestratorEvent) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send("orchestrator:event", event);
    }
  };

  ipcMain.handle(
    "orchestrator:start",
    async (_event, config: RunConfig) => {
      run(config, emit).catch((err) => {
        emit({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
    }
  );

  ipcMain.handle("orchestrator:stop", () => {
    stopRun();
  });

  ipcMain.handle("orchestrator:isRunning", () => {
    return isRunning();
  });

  ipcMain.handle("orchestrator:getRunState", () => {
    return getRunState();
  });
}
