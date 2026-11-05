/**
 * What: What happens after each per-entry stage, and the check before the next one (research R4, R9, R13) — `recordStage` writes `state.current`, adds the cost and keeps the implement counter (runs that checked no new in-scope task); `frozenCheck` pauses when the stage changed a frozen file; `leftUncommitted` lists what the stage did not commit (the loop emits `tree_dirty`); `progressCheck` stops a loop: the same entry and stage picked again right after it ran (`no_progress`), or implement without progress too often (`limit_reached`); `verifyRoundsCheck`, `limitCheck` and `runBudgetLeft` apply the policy's other limits; `gateCheck` pauses after a stage the entry gates (R10). Every pause names the limit or the gate it hit.
 * Not: Does not run stages or pick them. Stores nothing about a gate's approval: Resume is the approval.
 * Deps: state.mutateState, git.frozenChangesSince, branching.dirtyFiles, picker.PickerDecision, policy.PolicyLimits, queue.ResolvedEntry.
 */

import type { LimitHit } from "../agent/AgentRunner.js";
import { dirtyFiles } from "../branching.js";
import { frozenChangesSince } from "../git.js";
import type { PickerDecision } from "../picker.js";
import type { PolicyLimits } from "../policy.js";
import type { ResolvedEntry, StageName } from "../queue.js";
import { type DexStateV2, mutateState, type PauseReason } from "../state.js";

export interface LastStage {
  entryId: string;
  stage: StageName;
  taskPhase: number | null;
}

export interface ImplementProgress {
  checkedBefore: number;
  checkedAfter: number;
}

/** Records the stage that just ran. Returns the entry's runs-without-progress count. */
export function recordStage(
  projectDir: string,
  last: LastStage,
  costUsd: number,
  implement: ImplementProgress | null,
): number {
  let count = 0;
  mutateState(projectDir, (s) => {
    const counters = { ...s.counters };
    count = counters[last.entryId]?.implementRunsWithoutProgress ?? 0;
    if (implement) {
      count = implement.checkedAfter > implement.checkedBefore ? 0 : count + 1;
      counters[last.entryId] = { implementRunsWithoutProgress: count };
    }
    return { ...s, current: last, cumulativeCostUsd: s.cumulativeCostUsd + costUsd, counters };
  });
  return count;
}

export interface Guard {
  reason: PauseReason;
  detail: string;
}

/**
 * A gated stage finished: pause so the owner can look before the next stage
 * (research R10). Resume is the approval; the picker then finds the stage's
 * artefact in place and moves on.
 */
export function gateCheck(entry: ResolvedEntry, stage: StageName): Guard | null {
  if (!entry.gates.includes(stage)) return null;
  return {
    reason: "gate",
    detail: `${entry.id} · ${stage} is done, and the queue gates it: review the result, then Resume to go on`,
  };
}

/**
 * The stage changed a file the policy freezes: modified, deleted or renamed
 * since `stageStartSha`, committed or not (research R13). Null when nothing
 * changed, or when there was no commit to compare against.
 */
export function frozenCheck(projectDir: string, frozen: string[], stageStartSha: string | null): Guard | null {
  if (!stageStartSha || frozen.length === 0) return null;
  const files = frozenChangesSince(projectDir, stageStartSha, frozen);
  if (files.length === 0) return null;
  return { reason: "frozen_changed", detail: `the stage changed frozen files: ${files.join(", ")}` };
}

/**
 * Files the stage left uncommitted, without Dex's runtime files. Informational:
 * the next branch switch pauses on them (research R4). Empty outside a repository.
 */
export function leftUncommitted(projectDir: string): string[] {
  try {
    return dirtyFiles(projectDir);
  } catch {
    return [];
  }
}

/**
 * Checks the picker's next decision against the stage that just ran in this
 * process. Null when the run may go on. A Resume starts with `last = null`,
 * so a resumed run always gets one more attempt.
 */
export function progressCheck(
  last: LastStage | null,
  decision: PickerDecision,
  counters: DexStateV2["counters"],
  limits: PolicyLimits,
): Guard | null {
  if (!last || decision.kind !== "stage" || decision.entry.id !== last.entryId) return null;
  if (decision.stage === "implement") {
    const runs = counters[last.entryId]?.implementRunsWithoutProgress ?? 0;
    const max = limits.maxImplementRunsWithoutProgress;
    if (runs < max) return null;
    return {
      reason: "limit_reached",
      detail: `implement ran ${runs} times for ${last.entryId} without checking a new task (limits.maxImplementRunsWithoutProgress: ${max})`,
    };
  }
  if (decision.stage !== last.stage) return null;
  return {
    reason: "no_progress",
    detail: `${last.stage} ran for ${last.entryId}, but the files still ask for ${decision.stage}: ${decision.reason}`,
  };
}

/**
 * Before implement or verify: the entry has failed verify `rounds` times
 * (its `Verify fixes V<k>` phases) and is still not done (research R9).
 * The files decide the count, so Resume pauses again until a human acts.
 */
export function verifyRoundsCheck(decision: PickerDecision, rounds: number, limits: PolicyLimits): Guard | null {
  if (decision.kind !== "stage" || (decision.stage !== "implement" && decision.stage !== "verify")) return null;
  const max = limits.maxVerifyRounds;
  if (rounds < max) return null;
  return {
    reason: "limit_reached",
    detail: `verify failed ${rounds} times for ${decision.entry.id} (limits.maxVerifyRounds: ${max}) — fix it by hand and mark it "done" in queue.json, raise the limit in .dex/policy.json, or mark it "skipped"`,
  };
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** A stage that the SDK stopped at its turn or budget limit pauses the run, naming the limit (FR-037). */
export function limitCheck(
  limitHit: LimitHit | null,
  d: Extract<PickerDecision, { kind: "stage" }>,
  limits: PolicyLimits,
  configMaxTurns: number,
): Guard | null {
  if (!limitHit) return null;
  const policyTurns = limits.maxTurnsPerStage;
  const limit =
    limitHit === "turns"
      ? policyTurns !== undefined && policyTurns <= configMaxTurns
        ? `the turn limit (limits.maxTurnsPerStage: ${policyTurns})`
        : `the turn limit (maxTurns: ${configMaxTurns})`
      : `the budget limit (limits.maxBudgetUsdPerStage: ${usd(limits.maxBudgetUsdPerStage ?? 0)})`;
  return { reason: "limit_reached", detail: `${d.entry.id} · ${d.stage} stopped at ${limit}` };
}

/** False once the run has spent its budget (`limits.maxBudgetUsdPerRun`); the run stops before the next stage. */
export function runBudgetLeft(spentUsd: number, limits: PolicyLimits): boolean {
  const max = limits.maxBudgetUsdPerRun;
  return max === undefined || spentUsd < max;
}
