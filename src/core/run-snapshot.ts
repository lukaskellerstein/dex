/**
 * What: The one read the app's queue and status views come from (research R17, contracts/ipc-events.md § RunSnapshot): the fresh `.dex/state.json`, the picker's `describeQueue` view with each entry's cost summed from `.dex/runs/<runId>.json`, and every queue or policy validation error, verbatim. `dex run --status` prints the same snapshot.
 * Not: Writes nothing (a v2 manifest migrates in memory only) and runs no stage. Does not decide what to show.
 * Deps: state.readState, queue.loadQueue, policy.loadPolicy, picker.describeQueue, runs.readRun.
 */

import { describeQueue, type QueueView } from "./picker.js";
import { loadPolicy } from "./policy.js";
import { loadQueue, type QueueV3 } from "./queue.js";
import * as runs from "./runs.js";
import { type DexState, readState } from "./state.js";

export interface RunSnapshot {
  state: DexState | null;
  /** Null before a new project has a queue, and when the queue is invalid. */
  queue: QueueView | null;
  errors: string[];
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Cost per queue entry id in one run, from its agent runs. */
export function costsByEntry(projectDir: string, runId: string): Record<string, number> {
  const costs: Record<string, number> = {};
  for (const r of runs.readRun(projectDir, runId)?.agentRuns ?? []) {
    if (r.featureSlug) costs[r.featureSlug] = (costs[r.featureSlug] ?? 0) + r.costUsd;
  }
  return costs;
}

export function runSnapshot(projectDir: string): RunSnapshot {
  const state = readState(projectDir);
  const errors: string[] = [];
  let queue: QueueV3 | null = null;
  try {
    queue = loadQueue(projectDir, { persistMigration: false });
    if (queue) loadPolicy(projectDir, queue.kind);
  } catch (err) {
    errors.push(message(err));
  }
  if (!queue) return { state, queue: null, errors };
  try {
    const costs = state ? costsByEntry(projectDir, state.runId) : {};
    return { state, queue: describeQueue({ projectDir, queue, runBranch: state?.runBranch ?? null }, costs), errors };
  } catch (err) {
    return { state, queue: null, errors: [...errors, message(err)] };
  }
}
