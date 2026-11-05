import fs from "node:fs";
import path from "node:path";

export interface DexConfig {
  /**
   * Name of the agent backend to drive the orchestrator with. Currently
   * supported: `"claude"` (real, via `@anthropic-ai/claude-agent-sdk`)
   * and `"mock"` (scripted, via `.dex/mock-config.json`). Future: `"codex"`,
   * `"copilot"`. Default `"claude"`. The actual dispatch lives in
   * `createAgentRunner` (src/core/agent/index.ts), which throws a clear
   * error for unknown values.
   */
  agent: string;
}

export class DexConfigParseError extends Error {
  readonly filePath: string;
  constructor(filePath: string, cause: unknown) {
    super(
      `DexConfigParseError: failed to parse ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
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

const DEFAULT_DEX_CONFIG: DexConfig = {
  agent: "claude",
};

export function dexConfigPath(projectDir: string): string {
  return path.join(projectDir, ".dex", "dex-config.json");
}

/**
 * Load `.dex/dex-config.json` from a project.
 * Absent file → returns the default (`{ agent: "claude" }`).
 * Parse error → throws `DexConfigParseError`.
 * Schema violation → throws `DexConfigInvalidError`.
 * The `agent` value is NOT validated against known runners here — that
 * lives in `createAgentRunner` so the error message can list valid names.
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
  // `agent` is optional — absent or undefined defaults to "claude".
  let agent = "claude";
  if ("agent" in obj && obj.agent !== undefined) {
    if (typeof obj.agent !== "string" || obj.agent.length === 0) {
      throw new DexConfigInvalidError(file, "'agent' must be a non-empty string if present");
    }
    agent = obj.agent;
  }
  return {
    agent,
  };
}
