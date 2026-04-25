import fs from "node:fs";
import path from "node:path";

export interface DexConfig {
  /** Name of the registered agent runner. Must match AGENT_REGISTRY key. */
  agent: string;
}

export class DexConfigParseError extends Error {
  readonly filePath: string;
  constructor(filePath: string, cause: unknown) {
    super(`DexConfigParseError: failed to parse ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "DexConfigParseError";
    this.filePath = filePath;
  }
}

export class DexConfigInvalidError extends Error {
  readonly filePath: string;
  constructor(filePath: string, detail: string) {
    super(`DexConfigInvalidError: ${filePath}: ${detail}`);
    this.name = "DexConfigInvalidError";
    this.filePath = filePath;
  }
}

export const DEFAULT_DEX_CONFIG: DexConfig = { agent: "claude" };

export function dexConfigPath(projectDir: string): string {
  return path.join(projectDir, ".dex", "dex-config.json");
}

/**
 * Load `.dex/dex-config.json` from a project.
 * Absent file → returns the default (`{ agent: "claude" }`) — spec 009 FR-002.
 * Parse error → throws `DexConfigParseError`.
 * Schema violation → throws `DexConfigInvalidError`.
 * The `agent` value is NOT validated against the registry here — the registry
 * lookup in `createAgentRunner` owns that error with the registered-names list.
 */
export function loadDexConfig(projectDir: string): DexConfig {
  const file = dexConfigPath(projectDir);
  if (!fs.existsSync(file)) {
    return { ...DEFAULT_DEX_CONFIG };
  }
  const raw = fs.readFileSync(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new DexConfigParseError(file, err);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DexConfigInvalidError(file, "root must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.agent !== "string" || obj.agent.length === 0) {
    throw new DexConfigInvalidError(file, "'agent' field is required and must be a non-empty string");
  }
  return { agent: obj.agent };
}
