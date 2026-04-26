import { ipcMain, type BrowserWindow } from "electron";
import type { RunConfig, OrchestratorEvent } from "../../core/types.js";
import { run, stopRun, getRunState, submitUserAnswer } from "../../core/orchestrator.js";
import { loadState } from "../../core/state.js";

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

  ipcMain.handle(
    "orchestrator:answer-question",
    (_event, requestId: string, answers: Record<string, string>) => {
      submitUserAnswer(requestId, answers);
    }
  );

  ipcMain.handle("orchestrator:getRunState", () => {
    return getRunState();
  });

  ipcMain.handle("orchestrator:getProjectState", async (_event, projectDir: string) => {
    return loadState(projectDir);
  });
}
