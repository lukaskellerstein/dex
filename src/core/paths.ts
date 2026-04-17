import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEX_HOME = path.join(os.homedir(), ".dex");
export const DB_DIR = path.join(DEX_HOME, "db");
export const DB_PATH = path.join(DB_DIR, "data.db");
export const LOGS_ROOT = path.join(DEX_HOME, "logs");
export const FALLBACK_LOG = path.join(LOGS_ROOT, "_orchestrator.log");
export const DEV_LOGS_DIR = path.join(DEX_HOME, "dev-logs");

/** Idempotent one-time move. Safe to call repeatedly. */
export function migrateIfNeeded(oldPath: string, newPath: string): void {
  if (!fs.existsSync(oldPath)) return;
  if (fs.existsSync(newPath)) return;
  fs.mkdirSync(path.dirname(newPath), { recursive: true });
  fs.renameSync(oldPath, newPath);
}
