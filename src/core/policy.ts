/**
 * What: The project's own policy, `.dex/policy.json` (contracts/policy-json.md) — types and defaults, `parsePolicy` (strict validation; a refusal for skipping permission checks in an existing project, FR-014), `loadPolicy`, and the pure `decideToolUse(policy, call, env, scope?)` the PreToolUse hook and canUseTool ask: deny rules → the stage's scope (scope.ts, 016) → write roots and frozen files (write tools) → ask rules → no opinion.
 * Not: Does not talk to the SDK or hold anything for a human (agent/permissions.ts does). Does not run preflight commands or check frozen files after a stage (stages/post-stage.ts).
 * Deps: node:fs, node:path. `isTrackedAtHead` is injected so the decision stays pure.
 */

import fs from "node:fs";
import path from "node:path";
import { type StageScope, scopeDecision } from "./scope.js";
import { parseSensorSpecs, type SensorSpec } from "./sensors.js";

// ── Types (data-model.md § Policy) ──

export type QueueKind = "new" | "existing";

export interface PolicyRule {
  /** Exact tool name, or "*" for any tool. */
  tool: string;
  /** JavaScript RegExp source, tested on the call's subject. */
  pattern: string;
  /** Shown to the agent and in the trace. */
  reason: string;
}

export interface CompiledRule extends PolicyRule {
  regex: RegExp;
}

export interface PolicyLimits {
  maxBudgetUsdPerStage?: number;
  maxBudgetUsdPerRun?: number;
  maxTurnsPerStage?: number;
  maxImplementRunsWithoutProgress: number;
  maxVerifyRounds: number;
}

const SETTING_SOURCES = ["user", "project", "local"] as const;
const SKIP_CHECKS_MODE = "bypassPermissions";
const PERMISSION_MODES = ["default", "acceptEdits", "plan", SKIP_CHECKS_MODE] as const;
const QUESTION_MODES = ["recommended-then-review", "wait"] as const;
export type QuestionMode = (typeof QUESTION_MODES)[number];

/** The project's checks (016 contracts/policy-json.md): fast ones around every implement run, standing ones before verify. */
export interface PolicyChecks {
  fast: SensorSpec[];
  standing: SensorSpec[];
  /** Re-runs of a red check; a pass on a re-run is `flaky` (R12). */
  rerunOnFail: number;
}

/** What counts as a test file (research R9). */
export const DEFAULT_TEST_GLOBS: readonly string[] = [
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
  "**/e2e/**",
  "**/*.test.*",
  "**/*.spec.*",
  "**/test_*.py",
  "**/*_test.py",
  "**/*_test.go",
];

/** What else the tests stage may write to set up its runner (research R19). */
export const DEFAULT_TEST_SUPPORT: readonly string[] = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "playwright.config.*",
  "vitest.config.*",
  "jest.config.*",
  "pytest.ini",
  "pyproject.toml",
  "uv.lock",
  "**/conftest.py",
  "go.mod",
  "go.sum",
];

const CHECK_TIMEOUT_SEC = 600;

export interface Policy {
  settingSources: (typeof SETTING_SOURCES)[number][];
  permissionMode: (typeof PERMISSION_MODES)[number];
  env: Record<string, string>;
  deny: CompiledRule[];
  ask: CompiledRule[];
  /** Relative to the project; the temp folder is always writable too. */
  writeRoots: string[];
  /** Project-relative globs (`path.matchesGlob`, `*` stays inside one folder). */
  frozen: string[];
  preflight: string[];
  repos: string[];
  /** Project-relative path of a Markdown file appended to the system prompt. */
  systemPromptAppend: string | null;
  questions: QuestionMode;
  openPullRequest: boolean;
  limits: PolicyLimits;
  checks: PolicyChecks;
  /** `path.matchesGlob` globs, like `frozen`. */
  testGlobs: string[];
  testSupport: string[];
  /** `browser`: the verifier in review mode works the feature in a browser (Playwright MCP). */
  verify: { browser: boolean };
}

export const DEFAULT_POLICY: Readonly<Policy> = Object.freeze({
  settingSources: ["user", "project", "local"],
  permissionMode: "default",
  // Loop agents neither read nor write the machine owner's personal auto memory (D-015-3).
  env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
  deny: [],
  ask: [],
  writeRoots: ["."],
  frozen: [],
  preflight: [],
  repos: [],
  systemPromptAppend: null,
  questions: "recommended-then-review",
  openPullRequest: false,
  limits: { maxImplementRunsWithoutProgress: 2, maxVerifyRounds: 3 },
  checks: { fast: [], standing: [], rerunOnFail: 1 },
  testGlobs: [...DEFAULT_TEST_GLOBS],
  testSupport: [...DEFAULT_TEST_SUPPORT],
  verify: { browser: false },
} satisfies Policy);

// ── Errors ──

export class PolicyInvalidError extends Error {
  readonly file: string;
  constructor(file: string, detail: string) {
    super(`${file}: ${detail}`);
    this.name = "PolicyInvalidError";
    this.file = file;
  }
}

export class PolicyRefusedError extends Error {
  readonly file: string;
  constructor(file: string, detail: string) {
    super(`${file}: ${detail}`);
    this.name = "PolicyRefusedError";
    this.file = file;
  }
}

// ── Parsing ──

const POLICY_FIELDS = Object.keys(DEFAULT_POLICY);
const RULE_FIELDS = ["tool", "pattern", "reason"];
const LIMIT_FIELDS = [
  "maxBudgetUsdPerStage",
  "maxBudgetUsdPerRun",
  "maxTurnsPerStage",
  "maxImplementRunsWithoutProgress",
  "maxVerifyRounds",
];

type Fail = (detail: string) => never;

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function rejectUnknown(
  obj: Record<string, unknown>,
  known: string[],
  prefix: string,
  fail: Fail,
): void {
  const extra = Object.keys(obj).find((k) => !known.includes(k));
  if (extra) fail(`unknown field "${prefix}${extra}"`);
}

function oneOf<T extends string>(v: unknown, values: readonly T[], field: string, fail: Fail): T {
  if (!values.includes(v as T)) fail(`"${field}" must be one of ${values.join(", ")}`);
  return v as T;
}

function stringList(v: unknown, field: string, fail: Fail): string[] {
  if (!Array.isArray(v) || !v.every((s) => typeof s === "string"))
    fail(`"${field}" must be a list of strings`);
  return [...(v as string[])];
}

function rules(v: unknown, field: string, fail: Fail): CompiledRule[] {
  if (!Array.isArray(v)) fail(`"${field}" must be a list of rules`);
  return (v as unknown[]).map((raw, i) => {
    const where = `${field}[${i}]`;
    if (!isObject(raw)) fail(`"${where}" must be an object`);
    const r = raw as Record<string, unknown>;
    rejectUnknown(r, RULE_FIELDS, `${where}.`, fail);
    for (const key of RULE_FIELDS) {
      if (typeof r[key] !== "string" || r[key] === "")
        fail(`"${where}.${key}" must be a non-empty string`);
    }
    let regex: RegExp;
    try {
      regex = new RegExp(r.pattern as string, "u");
    } catch (err) {
      fail(`"${where}.pattern" is not a valid regular expression (${(err as Error).message})`);
    }
    return {
      tool: r.tool as string,
      pattern: r.pattern as string,
      reason: r.reason as string,
      regex,
    };
  });
}

function limits(v: unknown, fail: Fail): PolicyLimits {
  if (!isObject(v)) fail(`"limits" must be an object`);
  const raw = v as Record<string, unknown>;
  rejectUnknown(raw, LIMIT_FIELDS, "limits.", fail);
  const out: PolicyLimits = { ...DEFAULT_POLICY.limits };
  for (const key of ["maxBudgetUsdPerStage", "maxBudgetUsdPerRun"] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "number" || !(raw[key] > 0))
      fail(`"limits.${key}" must be a positive number`);
    out[key] = raw[key] as number;
  }
  for (const key of [
    "maxTurnsPerStage",
    "maxImplementRunsWithoutProgress",
    "maxVerifyRounds",
  ] as const) {
    if (raw[key] === undefined) continue;
    if (!Number.isInteger(raw[key]) || (raw[key] as number) < 1)
      fail(`"limits.${key}" must be a positive integer`);
    out[key] = raw[key] as number;
  }
  return out;
}

function checks(v: unknown, fail: Fail): PolicyChecks {
  if (!isObject(v)) fail(`"checks" must be an object`);
  const raw = v as Record<string, unknown>;
  rejectUnknown(raw, ["fast", "standing", "rerunOnFail"], "checks.", fail);
  const list = (key: "fast" | "standing") =>
    raw[key] === undefined
      ? []
      : parseSensorSpecs(raw[key], `checks.${key}`, CHECK_TIMEOUT_SEC, fail);
  const rerun = raw.rerunOnFail ?? DEFAULT_POLICY.checks.rerunOnFail;
  if (!Number.isInteger(rerun) || (rerun as number) < 0 || (rerun as number) > 5)
    fail(`"checks.rerunOnFail" must be an integer from 0 to 5`);
  return { fast: list("fast"), standing: list("standing"), rerunOnFail: rerun as number };
}

function verifyOptions(v: unknown, fail: Fail): Policy["verify"] {
  if (!isObject(v)) fail(`"verify" must be an object`);
  const raw = v as Record<string, unknown>;
  rejectUnknown(raw, ["browser"], "verify.", fail);
  return { browser: raw.browser === undefined ? false : bool(raw.browser, "verify.browser", fail) };
}

function globList(v: unknown, field: string, fail: Fail): string[] {
  const list = stringList(v, field, fail);
  if (list.length === 0) fail(`"${field}" must not be empty`);
  return list;
}

function env(v: unknown, fail: Fail): Record<string, string> {
  if (!isObject(v) || !Object.values(v).every((s) => typeof s === "string")) {
    fail(`"env" must be an object of strings`);
  }
  return { ...(v as Record<string, string>) };
}

function appendFile(v: unknown, projectDir: string, fail: Fail): string {
  if (typeof v !== "string" || v === "") fail(`"systemPromptAppend" must be a non-empty string`);
  const abs = path.resolve(projectDir, v as string);
  if (!fs.existsSync(abs)) fail(`"systemPromptAppend" file ${abs} does not exist`);
  return v as string;
}

/** Validates a parsed `.dex/policy.json`; every absent field takes its default. */
export function parsePolicy(
  raw: unknown,
  kind: QueueKind,
  opts: { file: string; projectDir: string },
): Policy {
  const fail: Fail = (detail) => {
    throw new PolicyInvalidError(opts.file, detail);
  };
  if (!isObject(raw)) fail("root must be a JSON object");
  const r = raw as Record<string, unknown>;
  rejectUnknown(r, POLICY_FIELDS, "", fail);
  const has = (k: string) => r[k] !== undefined;
  const policy: Policy = {
    settingSources: has("settingSources")
      ? stringList(r.settingSources, "settingSources", fail).map((s, i) =>
          oneOf(s, SETTING_SOURCES, `settingSources[${i}]`, fail),
        )
      : [...DEFAULT_POLICY.settingSources],
    permissionMode: has("permissionMode")
      ? oneOf(r.permissionMode, PERMISSION_MODES, "permissionMode", fail)
      : DEFAULT_POLICY.permissionMode,
    env: { ...DEFAULT_POLICY.env, ...(has("env") ? env(r.env, fail) : {}) },
    deny: has("deny") ? rules(r.deny, "deny", fail) : [],
    ask: has("ask") ? rules(r.ask, "ask", fail) : [],
    writeRoots: has("writeRoots") ? stringList(r.writeRoots, "writeRoots", fail) : ["."],
    frozen: has("frozen") ? stringList(r.frozen, "frozen", fail) : [],
    preflight: has("preflight") ? stringList(r.preflight, "preflight", fail) : [],
    repos: has("repos") ? stringList(r.repos, "repos", fail) : [],
    // `null` is the default spelled out (`dex queue init` writes it).
    systemPromptAppend:
      has("systemPromptAppend") && r.systemPromptAppend !== null
        ? appendFile(r.systemPromptAppend, opts.projectDir, fail)
        : null,
    questions: has("questions")
      ? oneOf(r.questions, QUESTION_MODES, "questions", fail)
      : DEFAULT_POLICY.questions,
    openPullRequest: has("openPullRequest")
      ? bool(r.openPullRequest, "openPullRequest", fail)
      : false,
    limits: has("limits") ? limits(r.limits, fail) : { ...DEFAULT_POLICY.limits },
    checks: has("checks") ? checks(r.checks, fail) : { fast: [], standing: [], rerunOnFail: 1 },
    testGlobs: has("testGlobs")
      ? globList(r.testGlobs, "testGlobs", fail)
      : [...DEFAULT_TEST_GLOBS],
    testSupport: has("testSupport")
      ? stringList(r.testSupport, "testSupport", fail)
      : [...DEFAULT_TEST_SUPPORT],
    verify: has("verify") ? verifyOptions(r.verify, fail) : { browser: false },
  };
  if (policy.permissionMode === SKIP_CHECKS_MODE && kind === "existing") {
    throw new PolicyRefusedError(
      opts.file,
      `permissionMode "${SKIP_CHECKS_MODE}" is refused for an existing project — the project's own permission rules would be skipped.`,
    );
  }
  return policy;
}

function bool(v: unknown, field: string, fail: Fail): boolean {
  if (typeof v !== "boolean") fail(`"${field}" must be a boolean`);
  return v as boolean;
}

export function policyPath(projectDir: string): string {
  return path.join(projectDir, ".dex", "policy.json");
}

/** The project's policy; a missing file means every default. */
export function loadPolicy(projectDir: string, kind: QueueKind): Policy {
  const file = policyPath(projectDir);
  if (!fs.existsSync(file)) return parsePolicy({}, kind, { file, projectDir });
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    throw new PolicyInvalidError(file, `not valid JSON (${(err as Error).message})`);
  }
  return parsePolicy(raw, kind, { file, projectDir });
}

/** True only for a new project whose policy turns the SDK's permission checks off. */
export function skipsPermissionChecks(policy: Policy): boolean {
  return policy.permissionMode === SKIP_CHECKS_MODE;
}

// ── Decisions (contracts/policy-json.md § decideToolUse) ──

export interface ToolCall {
  toolName: string;
  input: Record<string, unknown>;
}

export interface PolicyEnv {
  projectDir: string;
  tmpDir: string;
  isTrackedAtHead: (absPath: string) => boolean;
}

export type PolicyDecision =
  | { kind: "deny"; rule: "deny" | "scope" | "writeRoots" | "frozen"; reason: string }
  | { kind: "ask"; reason: string }
  | { kind: "none" };

export const WRITE_TOOLS: readonly string[] = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
const PATH_TOOLS = new Set([...WRITE_TOOLS, "Read"]);

function targetPath(call: ToolCall, projectDir: string): string | null {
  const p = call.input.file_path ?? call.input.notebook_path;
  return typeof p === "string" ? path.resolve(projectDir, p) : null;
}

/** The one string a rule's pattern is tested on (data-model.md § Rule subject). */
export function subjectOf(call: ToolCall, projectDir: string): string {
  if (call.toolName === "Bash" && typeof call.input.command === "string") return call.input.command;
  if (PATH_TOOLS.has(call.toolName)) {
    const target = targetPath(call, projectDir);
    if (target) return target;
  }
  if (call.toolName === "WebFetch" && typeof call.input.url === "string") return call.input.url;
  return JSON.stringify(call.input);
}

function firstMatch(
  list: CompiledRule[],
  call: ToolCall,
  subject: string,
): CompiledRule | undefined {
  return list.find((r) => (r.tool === "*" || r.tool === call.toolName) && r.regex.test(subject));
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function writeDecision(policy: Policy, target: string, env: PolicyEnv): PolicyDecision | null {
  const roots = [...policy.writeRoots.map((r) => path.resolve(env.projectDir, r)), env.tmpDir];
  if (!roots.some((root) => isInside(root, target))) {
    return {
      kind: "deny",
      rule: "writeRoots",
      reason: `${target} is outside the policy's write roots`,
    };
  }
  const rel = path.relative(env.projectDir, target);
  const frozen = policy.frozen.find((glob) => path.matchesGlob(rel, glob));
  if (frozen && env.isTrackedAtHead(target)) {
    return { kind: "deny", rule: "frozen", reason: `${rel} is frozen by the policy (${frozen})` };
  }
  return null;
}

/**
 * Pure: what the policy says about one tool call. The first match wins: deny
 * rules → the stage's scope (016 R9) → write roots and frozen files → ask rules.
 */
export function decideToolUse(
  policy: Policy,
  call: ToolCall,
  env: PolicyEnv,
  scope?: StageScope,
): PolicyDecision {
  const subject = subjectOf(call, env.projectDir);
  const denied = firstMatch(policy.deny, call, subject);
  if (denied) return { kind: "deny", rule: "deny", reason: denied.reason };
  const scoped = scopeDecision(scope, call, env);
  if (scoped) return scoped;
  if (WRITE_TOOLS.includes(call.toolName)) {
    const target = targetPath(call, env.projectDir);
    const decision = target ? writeDecision(policy, target, env) : null;
    if (decision) return decision;
  }
  const asked = firstMatch(policy.ask, call, subject);
  if (asked) return { kind: "ask", reason: asked.reason };
  return { kind: "none" };
}
