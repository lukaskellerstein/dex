import { ipcMain } from "electron";
import { type DexJsonShape, listProfiles, saveDexJson } from "../../core/agent-profile.js";
import { withLock } from "./lock-utils.js";

export function registerProfilesHandlers(): void {
  // Read-only — no lock required.
  ipcMain.handle("profiles:list", (_e, projectDir: string) => {
    try {
      return listProfiles(projectDir);
    } catch (err) {
      console.warn("[profiles-ipc] list failed", err);
      return [];
    }
  });

  // Mutating — lock-wrapped.
  ipcMain.handle(
    "profiles:saveDexJson",
    async (_e, projectDir: string, name: string, dexJson: DexJsonShape) =>
      withLock(projectDir, () => saveDexJson(projectDir, name, dexJson)),
  );
}
