import fs from "node:fs";
import path from "node:path";
import type { StepType } from "../types.js";

// ── Types ──────────────────────────────────────────────────

export interface WriteSpec {
  /**
   * Destination. Relative paths resolve against projectDir; absolute paths
   * (including the ones produced by `{goalFile}` / `{goalProductDomain}` /
   * `{goalTechnicalDomain}` / `{goalClarified}`) are written as-is.
   * Other tokens: `{specDir}`, `{cycle}`, `{feature}`.
   */
  path: string;
  /**
   * Inline content the mock writes verbatim (after token substitution — same
   * tokens as `path`). The earlier `from`-fixture-file variant was removed —
   * mock outputs are inlined into mock-config.json to keep mock state in one
   * place and avoid coupling the orchestrator repo to per-project fixture
   * files.
   */
  content: string;
}

export interface AppendSpec {
  path: string;
  line: string;
}

export interface StepDescriptor {
  delay: number;
  writes?: WriteSpec[];
  appends?: AppendSpec[];
  structured_output?: Record<string, unknown>;
}

export type PhaseEntry = Record<string, StepDescriptor>;

export interface CycleEntry {
  feature: { id: string; title: string };
  stages: Record<string, StepDescriptor>;
}

export interface DexLoopEntry {
  cycles: CycleEntry[];
}

/**
 * 014 — scripted response for `MockAgentRunner.runOneShot`. Each entry maps a
 * prompt match (string-exact or RegExp source) to a deterministic reply, with
 * an optional file-edit side effect so resolver tests can simulate the agent
 * actually editing a conflicted file.
 */
export interface MockOneShotResponse {
  /** Either an exact-match string or a RegExp source string compiled at lookup time. */
  matchPrompt: string;
  /** When true, `matchPrompt` is treated as a regular expression (`new RegExp(matchPrompt).test(prompt)`). */
  isRegex?: boolean;
  finalText: string;
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
  finishedNormally?: boolean;
  /** Mock writes this content to {ctx.cwd}/{path} before returning — simulates an Edit tool call. */
  editFile?: { path: string; content: string };
  /** Simulated invocation latency. */
  delayMs?: number;
}

export interface MockConfig {
  prerequisites: PhaseEntry;
  clarification: PhaseEntry;
  dex_loop: DexLoopEntry;
  completion: PhaseEntry;
  /** 014 — scripted runOneShot responses. Optional; mock returns a permissive default when unset. */
  oneShotResponses?: MockOneShotResponse[];
}

// ── Error classes ──────────────────────────────────────────

export class MockConfigParseError extends Error {
  readonly filePath: string;
  constructor(filePath: string, cause: unknown) {
    super(`MockConfigParseError: failed to parse ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "MockConfigParseError";
    this.filePath = filePath;
  }
}

export class MockConfigInvalidError extends Error {
  readonly filePath: string;
  constructor(filePath: string, detail: string) {
    super(`MockConfigInvalidError: ${filePath}: ${detail}`);
    this.name = "MockConfigInvalidError";
    this.filePath = filePath;
  }
}

export class MockConfigMissingEntryError extends Error {
  readonly phase: string;
  readonly step: string;
  readonly cycleNumber: number | null;
  readonly featureId: string | null;
  constructor(phase: string, step: string, cycleNumber: number | null, featureId: string | null, extra?: string) {
    const coords = [`phase=${phase}`, `step=${step}`];
    if (cycleNumber !== null) coords.push(`cycle=${cycleNumber}`);
    if (featureId !== null) coords.push(`feature=${featureId}`);
    const suffix = extra ? `. ${extra}` : "";
    super(`MockConfigMissingEntryError: no script entry for ${coords.join(", ")}${suffix}. Update .dex/mock-config.json.`);
    this.name = "MockConfigMissingEntryError";
    this.phase = phase;
    this.step = step;
    this.cycleNumber = cycleNumber;
    this.featureId = featureId;
  }
}

export class MockConfigInvalidPathError extends Error {
  readonly badPath: string;
  readonly unknownToken: string;
  readonly allowedTokens: readonly string[];
  constructor(badPath: string, unknownToken: string, allowedTokens: readonly string[]) {
    super(`MockConfigInvalidPathError: path '${badPath}' contains unknown substitution token '{${unknownToken}}'. Allowed tokens: ${allowedTokens.map((t) => `{${t}}`).join(", ")}`);
    this.name = "MockConfigInvalidPathError";
    this.badPath = badPath;
    this.unknownToken = unknownToken;
    this.allowedTokens = allowedTokens;
  }
}

// ── Phase → steps mapping ──────────────────────────────────
// Which top-level key of MockConfig owns each StepType.

export const PHASE_OF_STEP: Record<StepType, "prerequisites" | "clarification" | "dex_loop" | "completion"> = {
  prerequisites:            "prerequisites",
  create_branch:            "prerequisites",
  clarification:            "clarification",
  clarification_product:    "clarification",
  clarification_technical:  "clarification",
  clarification_synthesis:  "clarification",
  constitution:             "clarification",
  manifest_extraction:      "clarification",
  gap_analysis:             "dex_loop",
  specify:                  "dex_loop",
  plan:                     "dex_loop",
  tasks:                    "dex_loop",
  implement:                "dex_loop",
  implement_fix:            "dex_loop",
  verify:                   "dex_loop",
  learnings:                "dex_loop",
  completion:               "completion",
  commit:                   "dex_loop",
};

// ── Loader + validator ─────────────────────────────────────

const REQUIRED_TOP_LEVEL = ["prerequisites", "clarification", "dex_loop", "completion"] as const;
const REQUIRED_CYCLE_STAGES = ["gap_analysis", "specify", "plan", "tasks", "implement", "verify", "learnings"] as const;

export function mockConfigPath(projectDir: string): string {
  return path.join(projectDir, ".dex", "mock-config.json");
}

/**
 * Parse and validate .dex/mock-config.json. Caller decides whether to
 * actually use the mock — that's `dex-config.json`'s `mocked` flag.
 */
export function loadMockConfig(projectDir: string): MockConfig {
  const file = mockConfigPath(projectDir);
  if (!fs.existsSync(file)) {
    throw new MockConfigInvalidError(file, "file does not exist. Create it or set 'mocked: false' in .dex/dex-config.json.");
  }
  const raw = fs.readFileSync(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new MockConfigParseError(file, err);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MockConfigInvalidError(file, "root must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;

  for (const key of REQUIRED_TOP_LEVEL) {
    if (!(key in obj)) {
      throw new MockConfigInvalidError(file, `missing required top-level key '${key}'`);
    }
  }

  validatePhaseEntry(file, "prerequisites", obj.prerequisites);
  validatePhaseEntry(file, "clarification", obj.clarification);
  validatePhaseEntry(file, "completion", obj.completion);
  validateDexLoop(file, obj.dex_loop);

  const oneShotResponses = obj.oneShotResponses;
  if (oneShotResponses !== undefined) {
    if (!Array.isArray(oneShotResponses)) {
      throw new MockConfigInvalidError(file, "'oneShotResponses' must be an array if present");
    }
    oneShotResponses.forEach((r, i) =>
      validateOneShotResponse(file, `oneShotResponses[${i}]`, r),
    );
  }

  return {
    prerequisites: obj.prerequisites as PhaseEntry,
    clarification: obj.clarification as PhaseEntry,
    dex_loop: obj.dex_loop as DexLoopEntry,
    completion: obj.completion as PhaseEntry,
    oneShotResponses: oneShotResponses as MockOneShotResponse[] | undefined,
  };
}

function validateOneShotResponse(file: string, where: string, spec: unknown): void {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new MockConfigInvalidError(file, `${where} must be an object`);
  }
  const r = spec as Record<string, unknown>;
  if (typeof r.matchPrompt !== "string") {
    throw new MockConfigInvalidError(file, `${where}.matchPrompt must be a string`);
  }
  if (typeof r.finalText !== "string") {
    throw new MockConfigInvalidError(file, `${where}.finalText must be a string`);
  }
  if (r.isRegex !== undefined && typeof r.isRegex !== "boolean") {
    throw new MockConfigInvalidError(file, `${where}.isRegex must be a boolean if present`);
  }
  if (r.cost !== undefined && (typeof r.cost !== "number" || r.cost < 0)) {
    throw new MockConfigInvalidError(file, `${where}.cost must be a non-negative number if present`);
  }
  if (r.delayMs !== undefined && (typeof r.delayMs !== "number" || r.delayMs < 0)) {
    throw new MockConfigInvalidError(file, `${where}.delayMs must be a non-negative number if present`);
  }
  if (r.editFile !== undefined) {
    if (!r.editFile || typeof r.editFile !== "object" || Array.isArray(r.editFile)) {
      throw new MockConfigInvalidError(file, `${where}.editFile must be an object if present`);
    }
    const ef = r.editFile as Record<string, unknown>;
    if (typeof ef.path !== "string" || ef.path.length === 0) {
      throw new MockConfigInvalidError(file, `${where}.editFile.path must be a non-empty string`);
    }
    if (typeof ef.content !== "string") {
      throw new MockConfigInvalidError(file, `${where}.editFile.content must be a string`);
    }
  }
}

function validatePhaseEntry(file: string, name: string, entry: unknown): void {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new MockConfigInvalidError(file, `'${name}' must be an object mapping stage name to descriptor`);
  }
  for (const [stepName, descriptor] of Object.entries(entry as Record<string, unknown>)) {
    validateStepDescriptor(file, `${name}.${stepName}`, descriptor);
  }
}

function validateDexLoop(file: string, entry: unknown): void {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new MockConfigInvalidError(file, "'dex_loop' must be an object with a 'cycles' array");
  }
  const cycles = (entry as Record<string, unknown>).cycles;
  if (!Array.isArray(cycles) || cycles.length === 0) {
    throw new MockConfigInvalidError(file, "'dex_loop.cycles' must be a non-empty array");
  }
  cycles.forEach((cycle, idx) => {
    validateCycle(file, idx, cycle);
  });
}

function validateCycle(file: string, idx: number, cycle: unknown): void {
  const where = `dex_loop.cycles[${idx}]`;
  if (!cycle || typeof cycle !== "object" || Array.isArray(cycle)) {
    throw new MockConfigInvalidError(file, `${where} must be an object`);
  }
  const c = cycle as Record<string, unknown>;
  const feature = c.feature;
  if (!feature || typeof feature !== "object" || Array.isArray(feature)) {
    throw new MockConfigInvalidError(file, `${where}.feature must be an object`);
  }
  const f = feature as Record<string, unknown>;
  if (typeof f.id !== "string" || f.id.length === 0) {
    throw new MockConfigInvalidError(file, `${where}.feature.id must be a non-empty string`);
  }
  if (typeof f.title !== "string" || f.title.length === 0) {
    throw new MockConfigInvalidError(file, `${where}.feature.title must be a non-empty string`);
  }
  // Mock-config on-disk JSON keys remain "stages" (not "steps") to avoid
  // breaking existing user mock-config.json files. Renaming the JSON key
  // is deferred to a follow-up PR with a migration step.
  const stages = c.stages;
  if (!stages || typeof stages !== "object" || Array.isArray(stages)) {
    throw new MockConfigInvalidError(file, `${where}.stages must be an object`);
  }
  for (const req of REQUIRED_CYCLE_STAGES) {
    if (!(req in (stages as Record<string, unknown>))) {
      throw new MockConfigInvalidError(file, `${where}.stages.${req} is required`);
    }
  }
  for (const [stepName, desc] of Object.entries(stages as Record<string, unknown>)) {
    validateStepDescriptor(file, `${where}.stages.${stepName}`, desc);
  }
}

function validateStepDescriptor(file: string, where: string, desc: unknown): void {
  if (!desc || typeof desc !== "object" || Array.isArray(desc)) {
    throw new MockConfigInvalidError(file, `${where} must be an object`);
  }
  const d = desc as Record<string, unknown>;
  if (typeof d.delay !== "number" || !Number.isFinite(d.delay) || d.delay < 0) {
    throw new MockConfigInvalidError(file, `${where}.delay must be a non-negative finite number`);
  }
  if (d.writes !== undefined) {
    if (!Array.isArray(d.writes)) {
      throw new MockConfigInvalidError(file, `${where}.writes must be an array`);
    }
    d.writes.forEach((w, i) => validateWriteSpec(file, `${where}.writes[${i}]`, w));
  }
  if (d.appends !== undefined) {
    if (!Array.isArray(d.appends)) {
      throw new MockConfigInvalidError(file, `${where}.appends must be an array`);
    }
    d.appends.forEach((a, i) => validateAppendSpec(file, `${where}.appends[${i}]`, a));
  }
  if (d.structured_output !== undefined) {
    if (!d.structured_output || typeof d.structured_output !== "object" || Array.isArray(d.structured_output)) {
      throw new MockConfigInvalidError(file, `${where}.structured_output must be a JSON object`);
    }
  }
}

function validateWriteSpec(file: string, where: string, spec: unknown): void {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new MockConfigInvalidError(file, `${where} must be an object`);
  }
  const w = spec as Record<string, unknown>;
  if (typeof w.path !== "string" || w.path.length === 0) {
    throw new MockConfigInvalidError(file, `${where}.path must be a non-empty string`);
  }
  if (typeof w.content !== "string") {
    throw new MockConfigInvalidError(file, `${where}.content must be a string`);
  }
}

function validateAppendSpec(file: string, where: string, spec: unknown): void {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new MockConfigInvalidError(file, `${where} must be an object`);
  }
  const a = spec as Record<string, unknown>;
  if (typeof a.path !== "string" || a.path.length === 0) {
    throw new MockConfigInvalidError(file, `${where}.path must be a non-empty string`);
  }
  if (typeof a.line !== "string") {
    throw new MockConfigInvalidError(file, `${where}.line must be a string`);
  }
}
