/**
 * What: Post-jumpTo state.json reconciliation. Forces `status=paused` and overrides `currentSpecDir` when HEAD's commit subject names a different feature than the loaded state. Most cursor fields (lastCompletedStep, currentCycleNumber, cyclesCompleted) now ride the committed state.json restored by `git checkout`, so this function only touches the slice that can still drift across the jump.
 * Not: Does not commit. Does not own subject parsing for any other consumer (timeline.ts has its own pending-candidate regex). Does not migrate state.
 * Deps: _helpers (gitExec, log, RunLoggerLike), ../state.js (loadState, updateState, DexState), ../types.js (StepType).
 */

import { gitExec, log, type RunLoggerLike } from "./_helpers.js";
import { loadState, updateState } from "../state.js";
import type { DexState } from "../state.js";
import type { StepType } from "../types.js";

/**
 * Force the loaded state into the `paused` status so the orchestrator's
 * Resume flow takes the resume path. If HEAD is on a step-commit and its
 * `[feature:<slug>]` differs from the loaded state's `currentSpecDir`,
 * override that field too — this catches the rare edge case where HEAD
 * lands on a step-commit mid-feature-transition where the committed state
 * snapshot trails the commit subject by one step.
 *
 * Pre-014 fork-resume reconciliation, this function patched 5 fields
 * (lastCompletedStep, currentCycleNumber, cyclesCompleted, currentSpecDir,
 * status). Now state.json is committed alongside checkpoint commits and
 * `git checkout -B selected-<ts> <sha>` restores it directly — those fields
 * arrive correct. Only `status` (committed state may have been "running" or
 * "completed") and the rare currentSpecDir drift still need patching.
 *
 * No-op when HEAD isn't on a step-commit (e.g., main's tip). Returns
 * `step` and `cycle` for backward-compatible callers (renderer test fixtures).
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

  const preState = await loadState(projectDir);
  const preSnapshot = preState ? snapshotResumeFields(preState) : null;

  const patch: Parameters<typeof updateState>[1] = {
    status: "paused",
    pausedAt: new Date().toISOString(),
  };

  // Only override currentSpecDir when the parsed slug differs from the
  // committed state's value. The committed state.json is now authoritative
  // for cursor position; touch it only when HEAD's subject says otherwise.
  if (featureSlug && featureSlug !== "-" && preState && preState.currentSpecDir !== featureSlug) {
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
