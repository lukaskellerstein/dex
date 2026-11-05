import fs from "node:fs";
import path from "node:path";
import { STAGE_NAMES, type StageName } from "../queue.js";
import type { StepType } from "../types.js";

// ── Types ──────────────────────────────────────────────────

export interface WriteSpec {
  /**
   * Destination. Relative paths resolve against projectDir; absolute paths
   * (including the ones produced by `{goalFile}` / `{goalProductDomain}` /
   * `{goalTechnicalDomain}` / `{goalClarified}`) are written as-is.
   * Other tokens: `{specDir}`, `{cycle}`, `{feature}` (the entry id).
   */
  path: string;
  /** Inline content the mock writes verbatim, after token substitution. */
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
  /** implement only: false leaves tasks.md unticked, like an agent that makes no progress. Default true. */
  tick?: boolean;
  /** Questions the stage asks before it writes, answered like AskUserQuestion (research R7). */
  asks?: MockQuestion[];
  /** Project paths the stage deletes, like an agent's `rm` (016 R16); checked by the policy and scope. */
  deletes?: string[];
}

/** An AskUserQuestion call; mark an option recommended by ending its label in `(Recommended)`. */
export interface MockQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string }>;
}

/** A review-mode finding, as the verifier returns it (016 data-model.md § Finding). */
export interface MockFinding {
  severity: "blocking" | "minor";
  summary: string;
  criterion?: string | null;
  where?: string | null;
}

/** What the mock verifier returns by mode (016 R16); a round's own values win over the descriptor's. */
interface VerifyOutput {
  /** Review mode. A blocking one makes the mock append the fix phase. */
  findings?: MockFinding[];
  /** Diagnose mode. */
  hypotheses?: string[];
}

/**
 * One verify round. `verdict` is still returned as structured output, and the
 * done gate ignores it (016). `fixTasks` are the fix phase the mock appends in
 * diagnose mode, or in review mode with a blocking finding.
 */
export interface VerifyRound extends VerifyOutput {
  verdict: "passed" | "failed";
  fixTasks?: string[];
}

export interface VerifyDescriptor extends StepDescriptor, VerifyOutput {
  /** Round k (1-based, from the fix phases already in tasks.md) uses rounds[k-1], else the last one. */
  rounds?: VerifyRound[];
}

export interface ImplementDescriptor extends StepDescriptor {
  /** The k-th task-phase run of an entry uses runs[k-1], else the last one (016). */
  runs?: StepDescriptor[];
  /** A "restore green first" run (016 research R7); it ticks nothing. */
  restore?: StepDescriptor;
}

export type EntryStages = Partial<
  Record<Exclude<StageName, "verify" | "implement">, StepDescriptor>
> & {
  implement?: ImplementDescriptor;
  verify?: VerifyDescriptor;
};

export type PhaseEntry = Record<string, StepDescriptor>;

export interface MockConfig {
  prerequisites: PhaseEntry;
  clarification: PhaseEntry;
  /** Per-entry stage scripts, keyed by entry id; `"*"` is the fallback for every entry. */
  entries: Record<string, EntryStages>;
  completion: PhaseEntry;
}

// ── Error classes ──────────────────────────────────────────

export class MockConfigParseError extends Error {
  readonly filePath: string;
  constructor(filePath: string, cause: unknown) {
    super(
      `MockConfigParseError: failed to parse ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
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
  readonly entryId: string | null;
  constructor(phase: string, step: string, entryId: string | null, extra?: string) {
    const coords = [`phase=${phase}`, `step=${step}`];
    if (entryId !== null) coords.push(`entry=${entryId}`);
    const suffix = extra ? `. ${extra}` : "";
    super(
      `MockConfigMissingEntryError: no script entry for ${coords.join(", ")}${suffix}. Update .dex/mock-config.json.`,
    );
    this.name = "MockConfigMissingEntryError";
    this.phase = phase;
    this.step = step;
    this.entryId = entryId;
  }
}

export class MockConfigInvalidPathError extends Error {
  readonly badPath: string;
  readonly unknownToken: string;
  readonly allowedTokens: readonly string[];
  constructor(badPath: string, unknownToken: string, allowedTokens: readonly string[]) {
    super(
      `MockConfigInvalidPathError: path '${badPath}' contains unknown substitution token '{${unknownToken}}'. Allowed tokens: ${allowedTokens.map((t) => `{${t}}`).join(", ")}`,
    );
    this.name = "MockConfigInvalidPathError";
    this.badPath = badPath;
    this.unknownToken = unknownToken;
    this.allowedTokens = allowedTokens;
  }
}

// ── Phase → steps mapping ──────────────────────────────────
// Which top-level key of MockConfig owns each StepType.

export const PHASE_OF_STEP: Record<
  StepType,
  "prerequisites" | "clarification" | "entries" | "completion"
> = {
  prerequisites: "prerequisites",
  clarification: "clarification",
  clarification_product: "clarification",
  clarification_technical: "clarification",
  clarification_synthesis: "clarification",
  constitution: "clarification",
  manifest_extraction: "clarification",
  brief: "entries",
  specify: "entries",
  clarify: "entries",
  plan: "entries",
  tasks: "entries",
  tests: "entries",
  implement: "entries",
  verify: "entries",
  completion: "completion",
};

/** The descriptor for `stage` of `entryId`: the entry's own, else the `"*"` one. */
export function stageScript(
  config: MockConfig,
  entryId: string | null,
  stage: StageName,
): StepDescriptor | VerifyDescriptor | ImplementDescriptor | null {
  const own = entryId ? config.entries[entryId]?.[stage] : undefined;
  return own ?? config.entries["*"]?.[stage] ?? null;
}

// ── Loader + validator ─────────────────────────────────────

export function mockConfigPath(projectDir: string): string {
  return path.join(projectDir, ".dex", "mock-config.json");
}

/**
 * Parse and validate .dex/mock-config.json. Caller decides whether to
 * actually use the mock — that's `dex-config.json`'s `agent` field.
 */
export function loadMockConfig(projectDir: string): MockConfig {
  const file = mockConfigPath(projectDir);
  if (!fs.existsSync(file)) {
    throw new MockConfigInvalidError(
      file,
      "file does not exist. Create it or set 'agent': 'claude' in .dex/dex-config.json.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new MockConfigParseError(file, err);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MockConfigInvalidError(file, "root must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  if ("dex_loop" in obj && !("entries" in obj)) {
    throw new MockConfigInvalidError(
      file,
      "'dex_loop.cycles' was replaced by 'entries' (an object keyed by entry id, with a \"*\" fallback). See fixtures/mock/new-project.json in the Dex repo.",
    );
  }
  if (!("entries" in obj)) {
    throw new MockConfigInvalidError(file, "missing required top-level key 'entries'");
  }
  // An existing project runs no clarification, so these two may be absent; a
  // step that needs a missing script still fails loudly (MockConfigMissingEntryError).
  for (const key of ["prerequisites", "clarification", "completion"] as const) {
    if (obj[key] !== undefined) validatePhaseEntry(file, key, obj[key]);
  }
  validateEntries(file, obj.entries);

  return {
    prerequisites: (obj.prerequisites ?? {}) as PhaseEntry,
    clarification: (obj.clarification ?? {}) as PhaseEntry,
    entries: obj.entries as Record<string, EntryStages>,
    completion: (obj.completion ?? {}) as PhaseEntry,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function validatePhaseEntry(file: string, name: string, entry: unknown): void {
  if (!isObject(entry)) {
    throw new MockConfigInvalidError(
      file,
      `'${name}' must be an object mapping stage name to descriptor`,
    );
  }
  for (const [stepName, descriptor] of Object.entries(entry)) {
    validateStepDescriptor(file, `${name}.${stepName}`, descriptor);
  }
}

function validateEntries(file: string, entries: unknown): void {
  if (!isObject(entries) || Object.keys(entries).length === 0) {
    throw new MockConfigInvalidError(
      file,
      "'entries' must be a non-empty object keyed by entry id (use \"*\" for every entry)",
    );
  }
  for (const [id, stages] of Object.entries(entries)) {
    const where = `entries["${id}"]`;
    if (!isObject(stages)) throw new MockConfigInvalidError(file, `${where} must be an object`);
    for (const [stage, desc] of Object.entries(stages)) {
      if (!(STAGE_NAMES as readonly string[]).includes(stage)) {
        throw new MockConfigInvalidError(
          file,
          `${where}.${stage} is not a stage (one of ${STAGE_NAMES.join(", ")})`,
        );
      }
      validateStepDescriptor(file, `${where}.${stage}`, desc);
      if (stage === "verify") {
        const d = desc as Record<string, unknown>;
        validateRounds(file, `${where}.verify`, d.rounds);
        validateVerifyOutput(file, `${where}.verify`, d);
      }
      if (stage === "implement") validateImplement(file, `${where}.implement`, desc);
    }
  }
}

function validateImplement(file: string, where: string, desc: unknown): void {
  const { runs, restore } = desc as Record<string, unknown>;
  if (runs !== undefined) {
    if (!Array.isArray(runs) || runs.length === 0) {
      throw new MockConfigInvalidError(file, `${where}.runs must be a non-empty array`);
    }
    runs.forEach((r, i) => validateStepDescriptor(file, `${where}.runs[${i}]`, r));
  }
  if (restore !== undefined) validateStepDescriptor(file, `${where}.restore`, restore);
}

function validateRounds(file: string, where: string, rounds: unknown): void {
  if (rounds === undefined) return;
  if (!Array.isArray(rounds) || rounds.length === 0) {
    throw new MockConfigInvalidError(file, `${where}.rounds must be a non-empty array`);
  }
  rounds.forEach((r, i) => {
    const w = `${where}.rounds[${i}]`;
    if (!isObject(r) || (r.verdict !== "passed" && r.verdict !== "failed")) {
      throw new MockConfigInvalidError(file, `${w}.verdict must be "passed" or "failed"`);
    }
    const fix = r.fixTasks;
    if (fix !== undefined && !(Array.isArray(fix) && fix.every((t) => typeof t === "string"))) {
      throw new MockConfigInvalidError(file, `${w}.fixTasks must be an array of strings`);
    }
    validateVerifyOutput(file, w, r);
  });
}

/** `findings` and `hypotheses`, on the verify descriptor or one of its rounds (016 R16). */
function validateVerifyOutput(file: string, where: string, d: Record<string, unknown>): void {
  const { findings, hypotheses } = d;
  if (
    hypotheses !== undefined &&
    !(Array.isArray(hypotheses) && hypotheses.every((h) => typeof h === "string"))
  ) {
    throw new MockConfigInvalidError(file, `${where}.hypotheses must be an array of strings`);
  }
  if (findings === undefined) return;
  if (!Array.isArray(findings)) {
    throw new MockConfigInvalidError(file, `${where}.findings must be an array`);
  }
  findings.forEach((f, i) => {
    const ok =
      isObject(f) &&
      (f.severity === "blocking" || f.severity === "minor") &&
      typeof f.summary === "string" &&
      f.summary !== "";
    if (!ok) {
      throw new MockConfigInvalidError(
        file,
        `${where}.findings[${i}] needs a severity ("blocking" or "minor") and a non-empty summary`,
      );
    }
  });
}

function validateStepDescriptor(file: string, where: string, desc: unknown): void {
  if (!isObject(desc)) {
    throw new MockConfigInvalidError(file, `${where} must be an object`);
  }
  if (typeof desc.delay !== "number" || !Number.isFinite(desc.delay) || desc.delay < 0) {
    throw new MockConfigInvalidError(file, `${where}.delay must be a non-negative finite number`);
  }
  if (desc.writes !== undefined) {
    if (!Array.isArray(desc.writes)) {
      throw new MockConfigInvalidError(file, `${where}.writes must be an array`);
    }
    desc.writes.forEach((w, i) => validateWriteSpec(file, `${where}.writes[${i}]`, w));
  }
  if (desc.appends !== undefined) {
    if (!Array.isArray(desc.appends)) {
      throw new MockConfigInvalidError(file, `${where}.appends must be an array`);
    }
    desc.appends.forEach((a, i) => validateAppendSpec(file, `${where}.appends[${i}]`, a));
  }
  if (desc.structured_output !== undefined && !isObject(desc.structured_output)) {
    throw new MockConfigInvalidError(file, `${where}.structured_output must be a JSON object`);
  }
  if (desc.tick !== undefined && typeof desc.tick !== "boolean") {
    throw new MockConfigInvalidError(file, `${where}.tick must be a boolean`);
  }
  const del = desc.deletes;
  if (
    del !== undefined &&
    !(Array.isArray(del) && del.every((p) => typeof p === "string" && p !== ""))
  ) {
    throw new MockConfigInvalidError(file, `${where}.deletes must be an array of non-empty paths`);
  }
  if (desc.asks !== undefined) validateAsks(file, `${where}.asks`, desc.asks);
}

function validateAsks(file: string, where: string, asks: unknown): void {
  if (!Array.isArray(asks)) throw new MockConfigInvalidError(file, `${where} must be an array`);
  asks.forEach((q, i) => {
    const at = `${where}[${i}]`;
    if (!isObject(q) || typeof q.question !== "string" || q.question === "") {
      throw new MockConfigInvalidError(file, `${at}.question must be a non-empty string`);
    }
    if (!Array.isArray(q.options) || q.options.length === 0) {
      throw new MockConfigInvalidError(file, `${at}.options must be a non-empty array`);
    }
    q.options.forEach((o, j) => {
      if (!isObject(o) || typeof o.label !== "string" || o.label === "") {
        throw new MockConfigInvalidError(
          file,
          `${at}.options[${j}].label must be a non-empty string`,
        );
      }
    });
  });
}

function validateWriteSpec(file: string, where: string, spec: unknown): void {
  if (!isObject(spec)) {
    throw new MockConfigInvalidError(file, `${where} must be an object`);
  }
  if (typeof spec.path !== "string" || spec.path.length === 0) {
    throw new MockConfigInvalidError(file, `${where}.path must be a non-empty string`);
  }
  if (typeof spec.content !== "string") {
    throw new MockConfigInvalidError(file, `${where}.content must be a string`);
  }
}

function validateAppendSpec(file: string, where: string, spec: unknown): void {
  if (!isObject(spec)) {
    throw new MockConfigInvalidError(file, `${where} must be an object`);
  }
  if (typeof spec.path !== "string" || spec.path.length === 0) {
    throw new MockConfigInvalidError(file, `${where}.path must be a non-empty string`);
  }
  if (typeof spec.line !== "string") {
    throw new MockConfigInvalidError(file, `${where}.line must be a string`);
  }
}
