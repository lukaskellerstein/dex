/**
 * What: Wraps the per-stage post-execution checkpoint sequence — updateState (lastCompletedStep + currentCycleNumber + currentSpecDir) → commitCheckpoint → updateState (lastCommit) → updatePhaseCheckpointInfo (runs record patch) → step_candidate emit → autoPromoteIfRecordMode → readPauseAfterStage → optional `paused` emit + abort. Returns whether the orchestrator should pause.
 * Not: Does not own the runStage execution itself. Does not decide whether to run the finalize step at all — caller checks abort + activeProjectDir before calling. Does not catch its own errors at the inner level — the surrounding try/catch in the caller does (matches the pre-extraction "Checkpoint failure shouldn't crash the run" semantics).
 * Deps: state.updateState, checkpoints (commit, recordMode, tags), git.getCurrentBranch, runs.updateRun, OrchestrationContext.emit.
 */

import { updateState } from "../state.js";
import * as runs from "../runs.js";
import {
  commitCheckpoint,
  autoPromoteIfRecordMode,
  readPauseAfterStage,
  checkpointTagFor,
} from "../checkpoints.js";
import { getCurrentBranch } from "../git.js";
import type { OrchestrationContext } from "../context.js";
import type { StepType } from "../types.js";
import type { RunLogger } from "../log.js";

export interface FinalizeStageInput {
  ctx: OrchestrationContext;
  runId: string;
  agentRunId: string;
  cycleNumber: number;
  step: StepType;
  /**
   * The active spec dir for this stage, or null when the stage doesn't carry
   * one (specify, clarification stages). When null, currentSpecDir is left
   * untouched in state.json — clobbering it with null would break mid-cycle
   * resume.
   */
  specDir: string | null;
  rlog: RunLogger;
  /** Whether the run is in step-mode (config.stepMode || readPauseAfterStage). */
  stepModeOverride?: boolean;
  /** Abort handle — if `paused` fires we abort the controller so the cycle iterator unwinds. */
  abortController: AbortController | null;
}

/**
 * Runs the post-stage checkpoint sequence. Returns `{ shouldPause: true }`
 * when step-mode requested a pause (caller's cycle iterator should unwind).
 *
 * Catches all errors internally — checkpoint failures are non-fatal in the
 * existing convention (the run continues; only the candidate-emission and
 * pause-detection steps degrade). This mirrors the bare `try/catch {}` block
 * at orchestrator.ts:441-509 pre-extraction.
 */
export async function finalizeStageCheckpoint(
  input: FinalizeStageInput,
): Promise<{ shouldPause: boolean }> {
  const { ctx, runId, agentRunId, cycleNumber, step, specDir, rlog, stepModeOverride, abortController } = input;
  const projectDir = ctx.projectDir;

  try {
    // 1. Persist last-completed-step pointer (so resume can pick up the next stage).
    //    Only overwrite currentSpecDir when this stage carries one — see the
    //    clobbering note in the JSDoc above.
    await updateState(projectDir, {
      lastCompletedStep: step,
      currentCycleNumber: cycleNumber,
      ...(specDir ? { currentSpecDir: specDir } : {}),
    });

    // 2. Commit a [checkpoint:<step>:<cycle>] git commit and remember its sha.
    const sha = commitCheckpoint(projectDir, step, cycleNumber, specDir ?? null);
    await updateState(projectDir, {
      lastCommit: { sha, timestamp: new Date().toISOString() },
    });

    // 3. Patch the runs/<runId>.json agent-run entry with the checkpoint tag +
    //    candidate sha so the DEBUG badge / cost estimator can correlate.
    const checkpointTag = checkpointTagFor(step, cycleNumber);
    let attemptBranch = "";
    try {
      attemptBranch = getCurrentBranch(projectDir);
    } catch {
      // getCurrentBranch can fail in degenerate states (detached HEAD, etc.)
      // — non-fatal; the candidate event just carries an empty branch.
    }
    try {
      updatePhaseCheckpointInfo(projectDir, runId, agentRunId, checkpointTag, sha);
    } catch {
      // non-fatal
    }

    // 4. Notify the renderer of the new candidate (Timeline / Try-N-ways).
    ctx.emit({
      type: "step_candidate",
      runId,
      cycleNumber,
      step,
      checkpointTag,
      candidateSha: sha,
      attemptBranch,
    });

    // 5. Record mode: auto-promote every candidate to canonical (no-op outside record mode).
    await autoPromoteIfRecordMode(projectDir, checkpointTag, sha, runId, ctx.emit, rlog);

    // 6. Step mode: pause after this stage awaiting Keep / Try-again. The
    //    caller's resume path (config.resume=true) picks up the next stage.
    const stepMode = Boolean(stepModeOverride) || (await readPauseAfterStage(projectDir));
    if (stepMode) {
      await updateState(projectDir, {
        status: "paused",
        pauseReason: "step_mode",
        pausedAt: new Date().toISOString(),
      });
      ctx.emit({
        type: "paused",
        runId,
        reason: "step_mode",
        step,
      });
      abortController?.abort();
      return { shouldPause: true };
    }
    return { shouldPause: false };
  } catch {
    // Checkpoint failure shouldn't crash the run.
    return { shouldPause: false };
  }
}

/**
 * Patches the matching agent-run record in `<projectDir>/.dex/runs/<runId>.json`
 * with `checkpointTag` and `candidateSha`. Non-fatal — silently swallows on
 * IO error so a transient FS hiccup doesn't crash the run.
 *
 * Moved from `src/core/orchestrator.ts:517-534` as part of A6 (T039).
 */
export function updatePhaseCheckpointInfo(
  projectDir: string,
  runId: string,
  agentRunId: string,
  checkpointTag: string,
  candidateSha: string,
): void {
  try {
    runs.updateRun(projectDir, runId, (r) => {
      const ph = r.agentRuns.find((p) => p.agentRunId === agentRunId);
      if (!ph) return;
      ph.checkpointTag = checkpointTag;
      ph.candidateSha = candidateSha;
    });
  } catch {
    // non-fatal
  }
}
