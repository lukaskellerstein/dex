/**
 * T042 — phase-lifecycle.test.ts
 *
 * **Runtime status**: Same caveat as T022 / T030 / T040 — `phase-lifecycle.ts`
 * imports `../runs.js`, which transitively imports `./paths.js`; Node 24's
 * `--experimental-strip-types` loader cannot rewrite the inner `.js` literals.
 * Tests document the contract; execution deferred to Wave D vitest infra
 * (vitest natively resolves `.js` → `.ts`).
 *
 * Contract enforcement until Wave D:
 *   1. Orientation block on the source file.
 *   2. tsc --noEmit (this file compiles — the input shapes are pinned).
 *   3. Wave A Gate 3 golden-trace diff (any drift in phase boundary ordering
 *      shows as missing/reordered `step_started` or "TaskPhase N started"
 *      log lines).
 */
import test from "node:test";
import assert from "node:assert/strict";
import type {
  PhaseStartInput,
  PhaseCompleteInput,
  PhaseFailureInput,
  SkippedStepInput,
} from "../phase-lifecycle.ts";

// ── Compile-time pins — break the build if input shapes drift ─────────────

test("phase-lifecycle: PhaseStartInput shape pinned", () => {
  const fake: PhaseStartInput = {
    ctx: {} as PhaseStartInput["ctx"],
    runId: "r-1",
    agentRun: {
      agentRunId: "a-1",
      taskPhaseNumber: 1,
      taskPhaseName: "loop:specify",
      step: "specify",
      cycleNumber: 1,
      specDir: null,
      featureSlug: null,
    },
    rlog: {} as PhaseStartInput["rlog"],
    logStrategy: "agent-run",
  };
  assert.equal(fake.logStrategy, "agent-run");
});

test("phase-lifecycle: logStrategy union is the documented set", () => {
  // Compile-time pin: only "agent-run" | "run-only" | "none" should be assignable.
  const a: PhaseStartInput["logStrategy"] = "agent-run";
  const b: PhaseStartInput["logStrategy"] = "run-only";
  const c: PhaseStartInput["logStrategy"] = "none";
  assert.deepEqual([a, b, c], ["agent-run", "run-only", "none"]);
});

test("phase-lifecycle: PhaseCompleteInput status union", () => {
  const ok: PhaseCompleteInput["status"] = "completed";
  const stopped: PhaseCompleteInput["status"] = "stopped";
  assert.deepEqual([ok, stopped], ["completed", "stopped"]);
});

test("phase-lifecycle: PhaseFailureInput requires error", () => {
  const fake: PhaseFailureInput = {
    ctx: {} as PhaseFailureInput["ctx"],
    runId: "r-1",
    agentRunId: "a-1",
    error: new Error("boom"),
  };
  assert.ok(fake.error instanceof Error);
});

test("phase-lifecycle: SkippedStepInput exposes minimal shape", () => {
  const fake: SkippedStepInput = {
    ctx: {} as SkippedStepInput["ctx"],
    runId: "r-1",
    agentRunId: "a-1",
    step: "specify",
    cycleNumber: 0,
  };
  assert.equal(fake.step, "specify");
  assert.equal(fake.specDir, undefined);
  assert.equal(fake.featureSlug, undefined);
});

// ── Behaviour tests (executed when vitest infra lands in Wave D) ────────────
//
// recordPhaseStart — mock runs.startAgentRun and rlog:
//   - runs.startAgentRun called once with the expected agentRun shape
//     (startedAt is ISO-8601, status is "running")
//   - logStrategy="agent-run" → rlog.startAgentRun(N, name, agentRunId) called
//   - logStrategy="run-only"  → rlog.run("INFO", "TaskPhase N started: name", { agentRunId })
//   - logStrategy="none"      → no rlog method called
//
// recordPhaseComplete:
//   - runs.completeAgentRun called once with status default "completed"
//   - status="stopped" round-trips
//   - costUsd / durationMs / inputTokens / outputTokens default to 0/0/null/null
//
// recordPhaseFailure:
//   - runs.completeAgentRun called once with { status: "failed", costUsd: 0 }
//   - rlog.agentRun("ERROR", ...) AND rlog.run("ERROR", ...) both fire when rlog provided
//   - Error.stack is forwarded on the agentRun call
//   - Non-Error errors are stringified
//
// emitSkippedStep:
//   - Emits step_started THEN step_completed in that order (no other events between)
//   - runs.startAgentRun followed by runs.completeAgentRun, both with cost=0/duration=0
//   - taskPhaseName is "loop:<step>"
//   - cycleNumber threads through to all 4 calls
//   - When specDir is provided, the step_started event includes it
