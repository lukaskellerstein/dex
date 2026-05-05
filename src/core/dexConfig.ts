import fs from "node:fs";
import path from "node:path";

/**
 * 014 — per-project conflict-resolver tuning. All fields optional with
 * sensible defaults so first-time users do not need to author this block.
 */
export interface ConflictResolverConfig {
  /** Override the orchestrator model. null → fall back to dex-config.json top-level `model`. */
  model: string | null;
  maxIterations: number;
  maxTurnsPerIteration: number;
  costCapUsd: number;
  /** Shell command to run after resolution. null skips verification. */
  verifyCommand: string | null;
}

export const DEFAULT_CONFLICT_RESOLVER_CONFIG: ConflictResolverConfig = {
  model: null,
  maxIterations: 5,
  maxTurnsPerIteration: 5,
  costCapUsd: 0.5,
  verifyCommand: "npx tsc --noEmit",
};

export interface DexConfig {
  /** Name of the registered agent runner. Must match AGENT_REGISTRY key. */
  agent: string;
  /** 014 — conflict resolver tuning. Always populated; defaults applied when fields are missing. */
  conflictResolver: ConflictResolverConfig;
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

const DEFAULT_DEX_CONFIG: DexConfig = {
  agent: "claude",
  conflictResolver: { ...DEFAULT_CONFLICT_RESOLVER_CONFIG },
};

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
  return {
    agent: obj.agent,
    conflictResolver: parseConflictResolver(file, obj.conflictResolver),
  };
}

function parseConflictResolver(
  file: string,
  raw: unknown,
): ConflictResolverConfig {
  if (raw === undefined || raw === null) {
    return { ...DEFAULT_CONFLICT_RESOLVER_CONFIG };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new DexConfigInvalidError(
      file,
      "'conflictResolver' must be an object if present",
    );
  }
  const r = raw as Record<string, unknown>;
  const out: ConflictResolverConfig = { ...DEFAULT_CONFLICT_RESOLVER_CONFIG };

  if ("model" in r) {
    if (r.model !== null && typeof r.model !== "string") {
      throw new DexConfigInvalidError(
        file,
        "'conflictResolver.model' must be a string or null",
      );
    }
    out.model = r.model as string | null;
  }
  if ("maxIterations" in r) {
    if (typeof r.maxIterations !== "number" || !Number.isInteger(r.maxIterations) || r.maxIterations < 1) {
      throw new DexConfigInvalidError(
        file,
        "'conflictResolver.maxIterations' must be an integer >= 1",
      );
    }
    out.maxIterations = r.maxIterations;
  }
  if ("maxTurnsPerIteration" in r) {
    if (typeof r.maxTurnsPerIteration !== "number" || !Number.isInteger(r.maxTurnsPerIteration) || r.maxTurnsPerIteration < 1) {
      throw new DexConfigInvalidError(
        file,
        "'conflictResolver.maxTurnsPerIteration' must be an integer >= 1",
      );
    }
    out.maxTurnsPerIteration = r.maxTurnsPerIteration;
  }
  if ("costCapUsd" in r) {
    if (typeof r.costCapUsd !== "number" || !Number.isFinite(r.costCapUsd) || r.costCapUsd < 0) {
      throw new DexConfigInvalidError(
        file,
        "'conflictResolver.costCapUsd' must be a non-negative finite number",
      );
    }
    out.costCapUsd = r.costCapUsd;
  }
  if ("verifyCommand" in r) {
    if (r.verifyCommand !== null && typeof r.verifyCommand !== "string") {
      throw new DexConfigInvalidError(
        file,
        "'conflictResolver.verifyCommand' must be a string or null",
      );
    }
    // Empty string normalises to null (per research.md R5).
    out.verifyCommand =
      typeof r.verifyCommand === "string" && r.verifyCommand.length === 0
        ? null
        : (r.verifyCommand as string | null);
  }

  return out;
}
