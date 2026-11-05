/**
 * What: The gates (D-016-1, data-model.md § Gate decision) — pure functions from evidence to a decision. `redFirst` (after the tests stage: the acceptance tests fail by an assertion, R2, R20), `baseline` (every check green before implement or verify), `progress` (after an implement run: a new in-scope tick with green checks and an intact plan, or for a restore run every check red at its baseline green again), `done` (after verify: every acceptance run green and no blocking finding; it takes no verdict, R13), `fingerprint` and `stalled` (three equal implement fingerprints, R11), `flakyPause` (a check flaky three times in one entry, R12). A gate passes only on Dex's own sensor runs; an agent's output can add a reason to fail, never a reason to pass (FR-005).
 * Not: No `fs`, no git, no clock, no agent: every decision is a table case (SC-001). Running the sensors and writing the records is stages/gate-runs.ts.
 * Deps: node:crypto (hashing only), sensors.{SensorRun, isGreen}; types from state and evidence.
 */

import crypto from "node:crypto";
import type { AcceptanceRecord } from "./acceptance.js";
import type { Finding, StageRecord, TestChangesRecord } from "./evidence.js";
import { isGreen, type SensorRun } from "./sensors.js";
import type { PauseReason } from "./state.js";

export type GateName = "red-first" | "baseline" | "progress" | "done";

/** What one gate decided, stored in a stage record or the done record. */
export interface GateDecision {
  gate: GateName;
  outcome: "pass" | "fail" | "pause";
  /** Set only when `outcome` is `pause`. */
  pauseReason: PauseReason | null;
  /** One line for the trace and the digest. */
  reason: string;
  /** What the loop does next: `restore`, `retry-tests`, `fix-phase`, … */
  next: string | null;
}

/** A pause a guard raises between stages, in post-stage's shape. */
export interface GatePause {
  reason: PauseReason;
  detail: string;
}

const pass = (gate: GateName, reason: string): GateDecision => ({
  gate,
  outcome: "pass",
  pauseReason: null,
  reason,
  next: null,
});

const fail = (gate: GateName, reason: string, next: string | null): GateDecision => ({
  gate,
  outcome: "fail",
  pauseReason: null,
  reason,
  next,
});

const pause = (gate: GateName, pauseReason: PauseReason, reason: string): GateDecision => ({
  gate,
  outcome: "pause",
  pauseReason,
  reason,
  next: null,
});

const quoted = (names: string[]) => names.map((n) => `"${n}"`).join(", ");

/** The names of the runs that are not green. */
export function redNames(runs: SensorRun[]): string[] {
  return runs.filter((r) => !isGreen(r)).map((r) => r.name);
}

// ── Baseline (FR-019) ──

/** Before implement (fast checks) or verify (fast and standing): every run green. */
export function baseline(runs: SensorRun[]): GateDecision {
  if (runs.length === 0) return pass("baseline", "no checks declared");
  const red = redNames(runs);
  if (red.length === 0) return pass("baseline", `every check is green (${runs.length})`);
  return fail("baseline", `red before the stage: ${quoted(red)}`, "restore");
}

// ── Progress (FR-018, FR-026, FR-027) ──

export interface ProgressInput {
  mode: "phase" | "restore";
  /** The fast checks, run after the implement run. */
  runs: SensorRun[];
  /** In-scope task ids ticked by this run. */
  newlyTicked: string[];
  /** tasks.md changes other than a checkbox flip (R8). */
  planViolations: string[];
  testChanges: Pick<TestChangesRecord, "frozenChanged" | "testsDeletedOrRenamed">;
  /** restore mode: the checks that were red at the run's baseline. */
  redAtBaseline: string[];
}

/** A violation pauses whatever the checks say: the gates read the plan and tests it protects. */
function violation(input: ProgressInput): GateDecision | null {
  const { planViolations, testChanges } = input;
  if (planViolations.length > 0)
    return pause("progress", "plan_changed", `tasks.md changed: ${planViolations.join("; ")}`);
  if (testChanges.frozenChanged.length > 0)
    return pause(
      "progress",
      "frozen_changed",
      `the run changed frozen acceptance tests: ${testChanges.frozenChanged.join(", ")}`,
    );
  if (testChanges.testsDeletedOrRenamed.length > 0)
    return pause(
      "progress",
      "tests_changed",
      `the run deleted or renamed test files: ${testChanges.testsDeletedOrRenamed.join(", ")}`,
    );
  return null;
}

function restoreProgress(input: ProgressInput): GateDecision {
  const greenNow = new Set(input.runs.filter(isGreen).map((r) => r.name));
  const still = input.redAtBaseline.filter((n) => !greenNow.has(n));
  if (still.length === 0)
    return pass("progress", `restored: ${quoted(input.redAtBaseline)} green again`);
  return fail("progress", `still red after the restore run: ${quoted(still)}`, "restore");
}

/** After an implement run (FR-018). Flaky counts as green. */
export function progress(input: ProgressInput): GateDecision {
  const v = violation(input);
  if (v) return v;
  if (input.mode === "restore") return restoreProgress(input);
  const red = redNames(input.runs);
  const ticked = input.newlyTicked;
  if (ticked.length > 0 && red.length === 0) {
    const checks = input.runs.length === 0 ? "no fast checks declared" : "every fast check is green";
    return pass("progress", `${ticked.join(", ")} ticked; ${checks}`);
  }
  if (ticked.length > 0)
    return fail(
      "progress",
      `${ticked.join(", ")} ${ticked.length === 1 ? "is" : "are"} ticked, but the fast check${red.length === 1 ? "" : "s"} ${quoted(red)} ${red.length === 1 ? "is" : "are"} red`,
      "restore",
    );
  if (red.length > 0)
    return fail("progress", `no new in-scope task is ticked, and ${quoted(red)} red`, "restore");
  return fail("progress", "no new in-scope task is ticked", null);
}

// ── Red-first (FR-013, R2, R20) ──

/**
 * Right after the tests stage: the recorded acceptance command must fail by an
 * assertion — an exit code in `failExitCodes`. Exit 0 pauses (the tests pass
 * before the feature exists). Anything else is a crash: a missing or invalid
 * record (`problem`), another exit code, a timeout, a command that cannot
 * start. The first crash sends the loop back to `tests`; a second in a row pauses.
 */
export function redFirst(
  run: SensorRun | null,
  record: AcceptanceRecord | null,
  previousCrash: boolean,
  problem?: string,
): GateDecision {
  if (run && record && run.exitCode !== null && run.result !== "timeout") {
    if (run.exitCode === 0)
      return pause(
        "red-first",
        "red_first_green",
        "the tests pass before the feature exists — Resume accepts them; delete acceptance.json to write them again",
      );
    if (run.result === "fail" && record.failExitCodes.includes(run.exitCode))
      return pass("red-first", `the acceptance tests fail by an assertion (exit ${run.exitCode})`);
  }
  const why =
    problem ??
    (!run
      ? "the acceptance command did not run"
      : run.result === "timeout"
        ? "the acceptance command timed out"
        : run.exitCode === null
          ? `the acceptance command could not run (${run.result})`
          : `the acceptance command crashed (exit ${run.exitCode}, expected one of ${record?.failExitCodes.join(", ")})`);
  if (previousCrash)
    return pause("red-first", "no_progress", `${why}, for the second time in a row — check the test setup`);
  return fail("red-first", why, "retry-tests");
}

/** A red-first record that was a crash: a fail, or the pause after the second crash. */
export function isCrash(gate: GateDecision | null): boolean {
  return (
    gate?.gate === "red-first" &&
    (gate.outcome === "fail" || (gate.outcome === "pause" && gate.pauseReason === "no_progress"))
  );
}

// ── Done (FR-005, FR-024, R13) ──

/**
 * After a verify: every acceptance run green and no blocking finding. It takes
 * no verdict, so a verifier's "passed" can never turn red acceptance into done.
 * `findings` is null when a review returned no valid output.
 */
export function done(acceptance: SensorRun[], findings: Finding[] | null): GateDecision {
  if (acceptance.length === 0) {
    return fail("done", "no acceptance sensor ran: the entry has no acceptance.json and no queue acceptance", null);
  }
  const red = redNames(acceptance);
  if (red.length > 0) return fail("done", `the acceptance run is red: ${quoted(red)}`, "fix-phase");
  if (findings === null) return fail("done", "acceptance is green, but the verifier returned no valid review", null);
  const blocking = findings.filter((f) => f.severity === "blocking");
  if (blocking.length > 0) {
    const more = blocking.length > 1 ? ` (and ${blocking.length - 1} more)` : "";
    return fail("done", `acceptance is green, but a blocking finding is open: ${blocking[0].summary}${more}`, "fix-phase");
  }
  const minor = findings.length;
  return pass(
    "done",
    minor > 0
      ? `acceptance is green (${acceptance.length}); ${minor} minor finding${minor > 1 ? "s" : ""}`
      : `acceptance is green (${acceptance.length}) and no finding is open`,
  );
}

// ── Stall (R11) and flaky checks (R12) ──

function firstLine(tail: string[]): string {
  return tail.find((l) => l.trim() !== "")?.trim() ?? "";
}

/** The failing checks (flaky ones are not failing), the first line of each, and the run's diff hash. */
export function fingerprint(runs: SensorRun[], diffHash: string): string {
  const failing = runs
    .filter((r) => !isGreen(r))
    .map((r) => `${r.name}\0${firstLine(r.tail)}`)
    .sort();
  return crypto
    .createHash("sha256")
    .update(`${failing.join("\n")}\n--\n${diffHash}`)
    .digest("hex");
}

/** Two runs in a row that each repeat the run before: the last three fingerprints are equal. */
export function stalled(fingerprints: Array<string | null>): boolean {
  const last = fingerprints.slice(-3);
  return last.length === 3 && last[0] !== null && last.every((f) => f === last[0]);
}

export const FLAKY_LIMIT = 3;

/**
 * After a gate whose runs were `latest`: a check that was flaky in them and
 * has now been flaky `FLAKY_LIMIT` times across the entry's records pauses the
 * run. Counted from the evidence, so it survives a restart; checked only when
 * the check flaked again, so a fixed check lets Resume go on.
 */
export function flakyPause(records: StageRecord[], latest: SensorRun[]): GatePause | null {
  for (const run of latest.filter((r) => r.result === "flaky")) {
    const count = records
      .flatMap((r) => r.runs)
      .filter((r) => r.name === run.name && r.result === "flaky").length;
    if (count >= FLAKY_LIMIT) {
      return {
        reason: "flaky_check",
        detail: `the check "${run.name}" (${run.command}) was flaky ${count} times for ${records[0]?.entryId ?? "this entry"} — fix the check or retire it from .dex/policy.json, then Resume`,
      };
    }
  }
  return null;
}
