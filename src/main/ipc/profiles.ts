import { ipcMain } from "electron";
import {
  listProfiles,
  saveDexJson,
  type DexJsonShape,
} from "../../core/agent-profile.js";
import { acquireStateLock } from "../../core/state.js";

async function withLock<T>(
  projectDir: string,
  fn: () => Promise<T> | T,
): Promise<T | { ok: false; error: "locked_by_other_instance" }> {
  let release: (() => void) | null = null;
  try {
    release = await acquireStateLock(projectDir);
  } catch {
    return { ok: false, error: "locked_by_other_instance" } as const;
  }
  try {
    return await fn();
  } finally {
    release();
  }
}

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
