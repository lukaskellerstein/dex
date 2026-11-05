import { type BrowserWindow, ipcMain } from "electron";
import { type RequestAnswer, resolveRequest } from "../../core/humanInput.js";
import { getRunState, run, stopRun } from "../../core/orchestrator.js";
import { loadState } from "../../core/state.js";
import type { OrchestratorEvent, RunConfig } from "../../core/types.js";

/**
 * Orchestrator IPC. `stopRun` reaches the active run through core's
 * module-level `runtimeState`; an answer reaches the waiting agent through
 * `humanInput.resolveRequest`, keyed by the request id the event carried.
 */
export function registerOrchestratorHandlers(getWindow: () => BrowserWindow | null): void {
  const emit = (event: OrchestratorEvent) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send("orchestrator:event", event);
    }
  };

  ipcMain.handle("orchestrator:start", async (_event, config: RunConfig) => {
    run(config, emit).catch((err) => {
      emit({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    });
  });

  ipcMain.handle("orchestrator:stop", () => {
    stopRun();
  });

  ipcMain.handle("orchestrator:answer-request", (_event, requestId: string, answer: RequestAnswer) => {
    resolveRequest(requestId, answer);
  });

  ipcMain.handle("orchestrator:getRunState", () => {
    return getRunState();
  });

  ipcMain.handle("orchestrator:getProjectState", async (_event, projectDir: string) => {
    return loadState(projectDir);
  });
}
