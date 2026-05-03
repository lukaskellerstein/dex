/**
 * What: Post-jumpTo state.json reconciliation from HEAD's step-commit subject. Reads HEAD's commit subject; if it's a canonical `[cycle:N]` step-commit, writes the derived position cursor (lastCompletedStep, currentCycleNumber, cyclesCompleted, currentSpecDir, status=paused) into `<projectDir>/.dex/state.json` so the orchestrator's existing Resume flow picks up wherever the user navigated.
 * Not: Does not commit. Does not own subject parsing for any other consumer (timeline.ts has its own pending-candidate regex). Does not migrate state.
 * Deps: _helpers (gitExec, log, RunLoggerLike), ../state.js (loadState, updateState, DexState), ../types.js (StepType).
 */

import { gitExec, log, type RunLoggerLike } from "./_helpers.js";
import { loadState, updateState } from "../state.js";
import type { DexState } from "../state.js";
import type { StepType } from "../types.js";

/**
 * Read HEAD's commit subject; if it's a canonical step-commit, write the
 * derived position cursor into `<projectDir>/.dex/state.json`. After a
 * Timeline-driven jumpTo + this sync, the orchestrator's existing Resume
 * flow picks up from wherever the user navigated rather than where state.json
 * was last frozen. No-op when HEAD isn't on a step-commit (e.g., main's tip).
 */
export async function syncStateFromHead(
  projectDir: string,
  rlog?: RunLoggerLike,
): Promise<{ ok: true; updated: boolean; step?: StepType; cycle?: number } | { ok: false; error: string }> {
  let subject: string;
  try {
    subject = gitExec(`git log -1 --format=%s HEAD`, projectDir);
  } catch (err) {
    log(rlog, "ERROR", `syncStateFromHead: git log failed`, {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return { ok: false, error: String(err) };
  }
  // Subject pattern: `dex: <step> completed [cycle:N] [feature:<slug-or-->]`
  const m = subject.match(/^dex: (\w+) completed \[cycle:(\d+)\](?: \[feature:([^\]]+)\])?/);
  if (!m) {
    log(rlog, "INFO", `syncStateFromHead: HEAD is not a step-commit, leaving state.json alone`, { subject });
    return { ok: true, updated: false };
  }
  const step = m[1] as StepType;
  const cycleNumber = Number(m[2]);
  const featureSlug = m[3] ?? "-";

  // Snapshot the pre-sync state so the log records what we preserved vs
  // overwrote. Without this, a stale `currentSpecDir` (or `featuresCompleted`,
  // `failureCounts`, etc.) silently carrying over from a prior run is
  // invisible — it manifests downstream as "cycle 1 was burned on a
  // phantom feature", which is exactly the failure mode that bit us when
  // jumping back to clarification_synthesis. See
  // docs/my-specs/011-refactoring/ for the diagnostic plan.
  const preState = await loadState(projectDir);
  const preSnapshot = preState ? snapshotResumeFields(preState) : null;

  const patch: Parameters<typeof updateState>[1] = {
    lastCompletedStep: step,
    currentCycleNumber: cycleNumber,
    cyclesCompleted:
      step === "learnings" || step === "completion"
        ? cycleNumber
        : Math.max(0, cycleNumber - 1),
    // Pause the run so the orchestrator's resume flow takes the resume path.
    status: "paused",
    pausedAt: new Date().toISOString(),
  };
  if (featureSlug && featureSlug !== "-") {
    patch.currentSpecDir = featureSlug;
  }

  try {
    await updateState(projectDir, patch);
    const postState = await loadState(projectDir);
    const postSnapshot = postState ? snapshotResumeFields(postState) : null;
    log(rlog, "INFO", `syncStateFromHead: synced step=${step} cycle=${cycleNumber} feature=${featureSlug}`, {
      patchedFields: Object.keys(patch),
      pre: preSnapshot,
      post: postSnapshot,
      // Fields that the patch did NOT touch but which influence the resume
      // cursor — call them out explicitly so a stale value is loud in logs.
      preservedAfterSync: postSnapshot
        ? {
            currentSpecDir: postSnapshot.currentSpecDir,
            featuresCompleted: postSnapshot.featuresCompleted,
            featuresSkipped: postSnapshot.featuresSkipped,
            failureCountsKeys: postSnapshot.failureCountsKeys,
            featureArtifactsKeys: postSnapshot.featureArtifactsKeys,
          }
        : null,
    });
    return { ok: true, updated: true, step, cycle: cycleNumber };
  } catch (err) {
    log(rlog, "ERROR", `syncStateFromHead: updateState failed`, {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return { ok: false, error: String(err) };
  }
}

/**
 * Pull only the fields that influence the resume cursor out of a `DexState`
 * for compact logging. Reading the full state would dominate `electron.log`
 * with arrays we don't care about (raw artifact hashes, etc.).
 */
function snapshotResumeFields(s: DexState): {
  status: string;
  lastCompletedStep: string | null;
  currentCycleNumber: number;
  cyclesCompleted: number;
  currentSpecDir: string | null;
  featuresCompleted: string[];
  featuresSkipped: string[];
  failureCountsKeys: string[];
  featureArtifactsKeys: string[];
} {
  return {
    status: s.status,
    lastCompletedStep: s.lastCompletedStep,
    currentCycleNumber: s.currentCycleNumber,
    cyclesCompleted: s.cyclesCompleted,
    currentSpecDir: s.currentSpecDir,
    featuresCompleted: s.featuresCompleted ?? [],
    featuresSkipped: s.featuresSkipped ?? [],
    failureCountsKeys: Object.keys(s.failureCounts ?? {}),
    featureArtifactsKeys: Object.keys(s.artifacts?.features ?? {}),
  };
}
