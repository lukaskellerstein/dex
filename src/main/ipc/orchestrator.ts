import { ipcMain, type BrowserWindow } from "electron";
import type { RunConfig, OrchestratorEvent } from "../../core/types.js";
import { run, stopRun, getRunState, submitUserAnswer } from "../../core/orchestrator.js";
import { loadState } from "../../core/state.js";

/**
 * 011-A1 residual singleton note.
 *
 * `stopRun` and `submitUserAnswer` are invoked from IPC handlers that arrive
 * on a *different* IPC channel than the one running `runLoop`. They need to
 * reach into the active run's `OrchestrationContext`. Inside `core/orchestrator.ts`
 * we keep one module-level `currentContext: OrchestrationContext | null` for
 * exactly this reason — it points at the active run's ctx (set when run starts,
 * nulled when it ends). `stopRun` calls `currentContext?.abort.abort()`;
 * `submitUserAnswer` (currently in `core/userInput.ts`) resolves a pending
 * promise via its own keyed map.
 *
 * Future work (A3 — clarification extraction) will migrate `submitUserAnswer`
 * to read `currentContext.pendingQuestion.resolve` so the handle lives on ctx.
 *
 * See: specs/011-refactoring/contracts/orchestration-context.md
 */
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
