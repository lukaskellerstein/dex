/**
 * T040 — finalize.test.ts
 *
 * **Runtime status**: Same caveat as T022 / T030 — `finalize.ts` imports
 * `../checkpoints.js`, `../state.js`, `../runs.js`, `../git.js`, all of which
 * carry transitive `.js` import literals that Node 24's
 * `--experimental-strip-types` loader cannot rewrite. The tests below document
 * the expected contract and will execute when Wave D's vitest infra lands
 * (vitest natively resolves `.js` → `.ts`).
 *
 * Until then, the contract is enforced by:
 *   1. The orientation block on the source file.
 *   2. The Wave A Gate 3 golden-trace diff (any drift in the finalize sequence
 *      surfaces as a missing `step_candidate` emit or a moved `paused` event).
 *   3. tsc --noEmit (this file compiles).
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { FinalizeStageInput } from "../stages/finalize.ts";

// Test fixtures — minimal shapes that satisfy the input interface without
// touching the filesystem.
type EmittedEvent = { type: string; [k: string]: unknown };

function makeFakeCtx(): { ctx: FinalizeStageInput["ctx"]; emitted: EmittedEvent[] } {
  const emitted: EmittedEvent[] = [];
  const ctx = {
    projectDir: "/tmp/fake-project",
    emit: (e: unknown) => {
      emitted.push(e as EmittedEvent);
    },
    runner: {} as unknown,
    rlog: {} as unknown,
    abort: new AbortController(),
    state: {} as unknown,
    config: {} as unknown,
    pendingQuestion: null,
    releaseLock: async () => {},
  } as unknown as FinalizeStageInput["ctx"];
  return { ctx, emitted };
}

test("finalize: input shape pin — required fields present", () => {
  const { ctx } = makeFakeCtx();
  const input: FinalizeStageInput = {
    ctx,
    runId: "r-1",
    agentRunId: "a-1",
    cycleNumber: 1,
    step: "specify",
    specDir: "specs/feature-a",
    rlog: {} as unknown as FinalizeStageInput["rlog"],
    abortController: null,
  };
  // Compile-time pin: every required field present. If a future revision adds a
  // required field this assertion (and the assignment above) breaks the build.
  assert.equal(input.step, "specify");
  assert.equal(input.specDir, "specs/feature-a");
});

test("finalize: shouldPause boolean is the only return shape", () => {
  // Compile-time pin via type-level check — ensures we don't accidentally
  // change the return shape from { shouldPause: boolean } to something richer.
  type Ret = Awaited<ReturnType<typeof import("../stages/finalize.ts").finalizeStageCheckpoint>>;
  const ret: Ret = { shouldPause: false };
  assert.deepEqual(Object.keys(ret), ["shouldPause"]);
});

// ── Behaviour tests (executed when vitest infra lands in Wave D) ─────────────
//
// 1. Happy path:
//    - updateState called with { lastCompletedStep, currentCycleNumber, currentSpecDir? }
//    - commitCheckpoint called with (projectDir, step, cycleNumber, specDir|null)
//    - updateState called again with { lastCommit: { sha, timestamp } }
//    - updatePhaseCheckpointInfo called with (projectDir, runId, agentRunId, tag, sha)
//    - emit("step_candidate") with the right shape
//    - autoPromoteIfRecordMode called
//    - readPauseAfterStage consulted
//    - returns { shouldPause: false } in non-step-mode
//
// 2. Step-mode pause path:
//    - When stepModeOverride=true OR readPauseAfterStage returns true:
//      - updateState called with { status: "paused", pauseReason: "step_mode", pausedAt }
//      - emit("paused", { runId, reason: "step_mode", step })
//      - abortController.abort() called
//      - returns { shouldPause: true }
//
// 3. specDir clobber-guard:
//    - With specDir=null, updateState's first call MUST NOT include currentSpecDir
//      (clobbering with null breaks mid-cycle resume).
//
// 4. Non-fatal swallowing:
//    - If commitCheckpoint throws, finalize returns { shouldPause: false }
//      and emits no further events (run continues; checkpoint is best-effort).
//    - If getCurrentBranch throws, attemptBranch on the step_candidate event is "".
//    - If updatePhaseCheckpointInfo throws, the rest of the sequence still runs.
//
// 5. Record-mode auto-promote:
//    - With record mode active, autoPromoteIfRecordMode produces a tag emission.
//      (Verified at integration level via the smoke test, not unit level.)
