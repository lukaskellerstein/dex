/**
 * What: The per-cycle failure-threshold policy extracted from `runMainLoop` —
 *       decides whether a feature has failed enough times to be skipped
 *       outright, forced through a replan, or left alone.
 * Not:  Does not own the failure counters themselves (the caller keeps the
 *       tracker and its persistence) and does not advance the cycle. Loop
 *       control stays with the caller: this reports, the caller acts.
 * Deps: manifest.{loadManifest,updateFeatureStatus}, state.updateState.
 *
 * Extracted 2026-08-03 alongside cycle-gap-analysis.ts, same A4.5 follow-up.
 * Pure code movement — the `continue` the skip branch used to perform inline is
 * returned as `{ kind: "skip" }` instead.
 */

import type { OrchestrationContext } from "../context.js";
import { loadManifest, updateFeatureStatus } from "../manifest.js";
import { updateState } from "../state.js";
import type { FailureRecord, RunConfig } from "../types.js";

export type FailureThresholdOutcome =
  /** 3 replan failures — feature abandoned; caller advances the cycle and continues. */
  | { kind: "skip" }
  /** 3 implement failures — caller forces `decision` to REPLAN_FEATURE. */
  | { kind: "replan" }
  | { kind: "proceed" };

export interface FailureThresholdInput {
  ctx: OrchestrationContext;
  config: RunConfig;
  runId: string;
  cycleNumber: number;
  specDir: string;
  featureName: string | null;
  record: FailureRecord;
  /** Mutated in place when a feature is skipped, exactly as pre-extraction. */
  featuresSkipped: string[];
}

export function applyFailureThresholds(input: FailureThresholdInput): FailureThresholdOutcome {
  const { ctx, config, runId, cycleNumber, specDir, featureName, record, featuresSkipped } = input;

  if (record.replanFailures >= 3) {
    ctx.rlog.run("WARN", `runLoop: skipping feature at ${specDir} — 3 replan failures`);
    // Mark feature as skipped in manifest
    const skipManifest = loadManifest(config.projectDir);
    if (skipManifest) {
      const skipEntry = skipManifest.features.find((f) => f.specDir === specDir);
      if (skipEntry) updateFeatureStatus(config.projectDir, skipEntry.id, "skipped");
    }
    featuresSkipped.push(specDir);
    // (loop cycle row removed in 007-sqlite-removal — derived from phases)
    ctx.emit({
      type: "loop_cycle_completed",
      runId,
      cycleNumber,
      decision: "skipped",
      featureName,
      specDir,
      costUsd: 0,
    });
    // Update FeatureArtifacts.status to "skipped"
    if (ctx.projectDir) {
      updateState(ctx.projectDir, {
        artifacts: { features: { [specDir]: { status: "skipped" } } },
        featuresSkipped: [...featuresSkipped],
      } as never).catch(() => {});
    }
    return { kind: "skip" };
  }

  if (record.implFailures >= 3) {
    ctx.rlog.run("WARN", `runLoop: forcing replan for ${specDir} — 3 impl failures`);
    return { kind: "replan" };
  }

  return { kind: "proceed" };
}
