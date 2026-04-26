import fs from "node:fs";
import path from "node:path";

/**
 * Per-variant Agent Profile (010-interactive-timeline).
 *
 * A profile is a folder under `<projectDir>/.dex/agents/<name>/` containing:
 *   • `dex.json`              — Dex-side knobs (model / systemPromptAppend / allowedTools)
 *   • optional runner-native subdir (`.claude/`, `.codex/`, …) — the runner's native
 *     config that gets overlaid into the variant's worktree at spawn time.
 *
 * The folder name IS the profile name. `agentDir` is the absolute path computed
 * at load time. Neither is stored inside `dex.json`.
 */

export type AgentRunnerKind = "claude-sdk" | "codex" | "copilot";

export interface BaseProfile {
  name: string;
  agentDir: string;
}

export interface ClaudeProfile extends BaseProfile {
  agentRunner: "claude-sdk";
  model: string;
  systemPromptAppend?: string;
  allowedTools?: string[];
}

export interface CodexProfile extends BaseProfile {
  agentRunner: "codex";
  model: string;
  systemPromptAppend?: string;
}

export interface CopilotProfile extends BaseProfile {
  agentRunner: "copilot";
  model: string;
  systemPromptAppend?: string;
}

export type AgentProfile = ClaudeProfile | CodexProfile | CopilotProfile;

/**
 * Editable Dex-side fields written to disk as `dex.json`. The folder name and
 * `agentDir` are NOT serialized — they're derived from the filesystem.
 */
export interface DexJsonShape {
  agentRunner: AgentRunnerKind;
  model: string;
  systemPromptAppend?: string;
  allowedTools?: string[];
}

export interface OverlaySummary {
  hasClaude: boolean;
  skills: number;
  subagents: number;
  mcpServers: number;
  hasClaudeMd: boolean;
}

export type ProfileEntry =
  | { kind: "ok"; profile: AgentProfile; overlaySummary: OverlaySummary }
  | { kind: "warn"; folder: string; agentDir: string; reason: string };

const VALID_RUNNERS: ReadonlySet<string> = new Set(["claude-sdk", "codex", "copilot"]);

/** v1 quick-fill persona presets the modal wires to its persona-prompt buttons. */
export const PERSONA_PRESETS: ReadonlyArray<{
  name: string;
  systemPromptAppend: string;
}> = [
  {
    name: "Conservative",
    systemPromptAppend:
      "Minimize change. Prefer the smallest diff that satisfies the requirement. Avoid introducing new dependencies.",
  },
  {
    name: "Standard",
    systemPromptAppend: "",
  },
  {
    name: "Innovative",
    systemPromptAppend:
      "Use modern libraries and idioms freely. Refactor opportunistically for clarity. Prefer clean abstractions over preserving legacy patterns.",
  },
];

function agentsDir(projectDir: string): string {
  return path.join(projectDir, ".dex", "agents");
}

function profileDir(projectDir: string, name: string): string {
  return path.join(agentsDir(projectDir), name);
}

/**
 * Validate a parsed `dex.json` payload. Returns null on success, a human-readable
 * reason string on failure.
 */
function validateDexJson(value: unknown): { ok: true; value: DexJsonShape } | { ok: false; reason: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "dex.json must be a JSON object" };
  }
  const v = value as Record<string, unknown>;
  if (typeof v.agentRunner !== "string") {
    return { ok: false, reason: "missing or non-string field: agentRunner" };
  }
  if (!VALID_RUNNERS.has(v.agentRunner)) {
    return { ok: false, reason: `unknown agentRunner: '${v.agentRunner}'` };
  }
  if (typeof v.model !== "string" || v.model.length === 0) {
    return { ok: false, reason: "missing or empty field: model" };
  }
  if (v.systemPromptAppend !== undefined && typeof v.systemPromptAppend !== "string") {
    return { ok: false, reason: "systemPromptAppend must be a string when present" };
  }
  if (v.allowedTools !== undefined) {
    if (!Array.isArray(v.allowedTools) || !v.allowedTools.every((t) => typeof t === "string")) {
      return { ok: false, reason: "allowedTools must be a string[] when present" };
    }
  }
  return {
    ok: true,
    value: {
      agentRunner: v.agentRunner as AgentRunnerKind,
      model: v.model,
      systemPromptAppend: v.systemPromptAppend as string | undefined,
      allowedTools: v.allowedTools as string[] | undefined,
    },
  };
}

function shapeToProfile(name: string, agentDir: string, shape: DexJsonShape): AgentProfile {
  const base: BaseProfile = { name, agentDir };
  switch (shape.agentRunner) {
    case "claude-sdk":
      return {
        ...base,
        agentRunner: "claude-sdk",
        model: shape.model,
        systemPromptAppend: shape.systemPromptAppend,
        allowedTools: shape.allowedTools,
      };
    case "codex":
      return {
        ...base,
        agentRunner: "codex",
        model: shape.model,
        systemPromptAppend: shape.systemPromptAppend,
      };
    case "copilot":
      return {
        ...base,
        agentRunner: "copilot",
        model: shape.model,
        systemPromptAppend: shape.systemPromptAppend,
      };
  }
}

export function buildOverlaySummary(agentDir: string): OverlaySummary {
  const claudeDir = path.join(agentDir, ".claude");
  if (!fs.existsSync(claudeDir) || !fs.statSync(claudeDir).isDirectory()) {
    return { hasClaude: false, skills: 0, subagents: 0, mcpServers: 0, hasClaudeMd: false };
  }
  const skillsDir = path.join(claudeDir, "skills");
  const agentsSubDir = path.join(claudeDir, "agents");
  const claudeMd = path.join(claudeDir, "CLAUDE.md");
  const mcpJson = path.join(claudeDir, ".mcp.json");

  const skills = countFilesRecursive(skillsDir);
  const subagents = countFilesRecursive(agentsSubDir);
  let mcpServers = 0;
  if (fs.existsSync(mcpJson)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(mcpJson, "utf-8"));
      if (parsed && typeof parsed === "object" && parsed.mcpServers && typeof parsed.mcpServers === "object") {
        mcpServers = Object.keys(parsed.mcpServers).length;
      }
    } catch {
      // Soft fail — leave mcpServers at 0.
    }
  }
  return {
    hasClaude: true,
    skills,
    subagents,
    mcpServers,
    hasClaudeMd: fs.existsSync(claudeMd),
  };
}

function countFilesRecursive(dir: string): number {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) count += countFilesRecursive(full);
    else if (entry.isFile()) count += 1;
  }
  return count;
}

/**
 * Enumerate profile folders under `<projectDir>/.dex/agents/`. Returns:
 *   • `kind: "ok"` for folders with a parseable, valid `dex.json`.
 *   • `kind: "warn"` for folders that look like attempts at profiles but failed
 *     validation — the modal renders these as disabled rows so users can see
 *     why their profile isn't pickable.
 *   • Hidden folders (starting with `.`) are silently skipped.
 *
 * Sorted alphabetically by folder name.
 */
export function listProfiles(projectDir: string): ProfileEntry[] {
  const dir = agentsDir(projectDir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const result: ProfileEntry[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith(".")) continue;
    if (!e.isDirectory()) continue;
    const folderPath = path.join(dir, e.name);
    const dexJsonPath = path.join(folderPath, "dex.json");
    if (!fs.existsSync(dexJsonPath)) {
      result.push({ kind: "warn", folder: e.name, agentDir: folderPath, reason: "missing dex.json" });
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(dexJsonPath, "utf-8"));
    } catch (err) {
      result.push({
        kind: "warn",
        folder: e.name,
        agentDir: folderPath,
        reason: `invalid JSON: ${(err as Error).message}`,
      });
      continue;
    }
    const v = validateDexJson(raw);
    if (!v.ok) {
      result.push({ kind: "warn", folder: e.name, agentDir: folderPath, reason: v.reason });
      continue;
    }
    const profile = shapeToProfile(e.name, folderPath, v.value);
    result.push({ kind: "ok", profile, overlaySummary: buildOverlaySummary(folderPath) });
  }
  return result;
}

/**
 * Single-folder convenience wrapper. Returns null if the folder doesn't exist
 * or `dex.json` fails parse / validation.
 */
export function loadProfile(projectDir: string, name: string): AgentProfile | null {
  const folderPath = profileDir(projectDir, name);
  const dexJsonPath = path.join(folderPath, "dex.json");
  if (!fs.existsSync(dexJsonPath)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(dexJsonPath, "utf-8"));
  } catch {
    return null;
  }
  const v = validateDexJson(raw);
  if (!v.ok) return null;
  return shapeToProfile(name, folderPath, v.value);
}

/**
 * Atomic write of the profile's `dex.json`. Validates the payload first.
 * Refuses if the agent folder doesn't exist (won't auto-create it).
 */
export function saveDexJson(
  projectDir: string,
  name: string,
  dexJson: DexJsonShape,
): { ok: true } | { ok: false; error: string } {
  const folderPath = profileDir(projectDir, name);
  if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    return { ok: false, error: `agent folder not found: ${name}` };
  }
  const v = validateDexJson(dexJson);
  if (!v.ok) return { ok: false, error: v.reason };
  const target = path.join(folderPath, "dex.json");
  const tmp = `${target}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(dexJson, null, 2) + "\n", "utf-8");
    fs.renameSync(tmp, target);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
