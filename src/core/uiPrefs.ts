/**
 * What: Per-developer UI preferences (`<projectDir>/.dex/ui.json`) — atomic
 *       load/update helpers parallel to state.ts but for fields that should
 *       NOT travel across `git checkout` between developers (e.g. step-mode
 *       pause toggle). Lives outside `state.json` so the latter can be
 *       committed without leaking machine-specific UI prefs to teammates.
 * Not: Does not own state.json. Does not touch git.
 * Deps: node:fs, node:path.
 */

import fs from "node:fs";
import path from "node:path";

const STATE_DIR = ".dex";
const UI_FILE = "ui.json";
const UI_TMP = "ui.json.tmp";

export interface DexUiPrefs {
  pauseAfterStage?: boolean;
}

function uiPath(projectDir: string): string {
  return path.join(projectDir, STATE_DIR, UI_FILE);
}

function uiTmpPath(projectDir: string): string {
  return path.join(projectDir, STATE_DIR, UI_TMP);
}

function ensureStateDir(projectDir: string): void {
  const dir = path.join(projectDir, STATE_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export async function loadUiPrefs(projectDir: string): Promise<DexUiPrefs> {
  try {
    const raw = JSON.parse(fs.readFileSync(uiPath(projectDir), "utf-8"));
    if (raw && typeof raw === "object") return raw as DexUiPrefs;
    return {};
  } catch {
    return {};
  }
}

export async function updateUiPrefs(
  projectDir: string,
  patch: Partial<DexUiPrefs>,
): Promise<void> {
  ensureStateDir(projectDir);
  const current = await loadUiPrefs(projectDir);
  const updated = { ...current, ...patch };
  const tmp = uiTmpPath(projectDir);
  const target = uiPath(projectDir);
  fs.writeFileSync(tmp, JSON.stringify(updated, null, 2), "utf-8");
  fs.renameSync(tmp, target);
}
