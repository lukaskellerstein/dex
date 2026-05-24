/**
 * What: Pure helpers for StageList — stage visibility (per gap-analysis decision), stage-status derivation, and resume-target resolution.
 * Not: Does not render. Does not own state. The component rewires the helpers into JSX.
 * Deps: StepType, UiLoopStage, ImplementSubPhase types only.
 */
import type { StepType } from "../../../core/types.js";
import type { UiLoopStage, ImplementSubPhase } from "../../hooks/useOrchestrator.js";

export const CYCLE_STAGES: StepType[] = [
  "gap_analysis",
  "specify",
  "plan",
  "tasks",
  "implement",
  "verify",
  "learnings",
];

export const STEP_LABELS: Record<StepType, string> = {
  prerequisites: "Prerequisites",
  create_branch: "Create Branch",
  clarification: "Clarification",
  clarification_product: "Clarification (Product)",
  clarification_technical: "Clarification (Technical)",
  clarification_synthesis: "Clarification (Synthesis)",
  constitution: "Constitution",
  manifest_extraction: "Manifest Extraction",
  gap_analysis: "Gap Analysis",
  specify: "Specify",
  plan: "Plan",
  tasks: "Tasks",
  implement: "Implement",
  implement_fix: "Implement Fix",
  verify: "Verify",
  learnings: "Learnings",
  commit: "Commit",
};

export type StageStatus =
  | "pending"
  | "running"
  | "completed"
  | "skipped"
  | "failed"
  | "paused";

export function getStageVisibility(stageType: StepType, decision: string | null): "show" | "skip" {
  if (!decision) return "show";
  // `decision` on UiLoopCycle is overloaded: it carries gap-analysis values
  // (NEXT_FEATURE / RESUME_FEATURE / REPLAN_FEATURE / RESUME_AT_STEP) for
  // active cycles, and cycle-outcome strings ("stopped", "skipped",
  // "completed") emitted by `loop_cycle_completed`. Only the explicit
  // gap-analysis skip cases actually mean "this stage will not run" —
  // anything else (including cycle outcomes) must keep the stage visible
  // so its real `actual.status` (e.g. "stopped" → paused) can drive the icon.
  switch (stageType) {
    case "specify":
      return decision === "RESUME_FEATURE" || decision === "REPLAN_FEATURE" ? "skip" : "show";
    case "plan":
    case "tasks":
      return decision === "RESUME_FEATURE" ? "skip" : "show";
    default:
      return "show";
  }
}

export function deriveStageStatus(
  stageType: StepType,
  actual: UiLoopStage | undefined,
  currentStage: StepType | null,
  isActiveCycle: boolean,
  decision: string | null,
  _hasVerifyOrLater: boolean,
  implementPhases: ImplementSubPhase[],
  isRunning: boolean,
  _isPausedCycle: boolean,
  /** 010: stage types whose step-commit is on the active path. Truth for committed history. */
  pathStages: ReadonlySet<StepType>,
  /** Single resume-target stage when paused — surfaces as "paused". */
  pausePendingStage: StepType | null,
): StageStatus {
  // Path commits are the source of truth: a step-commit means the stage finished.
  if (pathStages.has(stageType)) return "completed";

  // The orchestrator can advance currentStage before publishing a UiLoopStage
  // record (warmup window after Resume — step_started fires before the first
  // event that materialises `actual`). Without this, the active stage briefly
  // renders as plain "pending" right after the user clicks Resume.
  if (isRunning && isActiveCycle && currentStage === stageType) return "running";

  if (stageType === "implement") {
    if (actual) {
      if (actual.status === "completed") return "completed";
      if (actual.status === "stopped") return "paused";
      if (actual.status === "failed") return isRunning ? "failed" : "paused";
      return "running";
    }
    if (isActiveCycle && currentStage === "implement") return "running";
    if (implementPhases.length > 0) {
      const allDone = implementPhases.every((ip) => ip.status === "completed");
      if (allDone) return isRunning ? "completed" : "paused";
      return isRunning ? "running" : "paused";
    }
    if (pausePendingStage === "implement") return "paused";
    return "pending";
  }

  // Actual data wins over the abstract visibility rule — if a stage has a
  // record, it ran (or is running) and its real status drives the icon.
  // Without this, stopping mid-plan (cycle.decision becomes "stopped") would
  // render plan as dimmed "skipped" instead of "paused".
  if (actual) {
    if (actual.status === "completed") return "completed";
    if (actual.status === "stopped") return "paused";
    if (actual.status === "failed") return isRunning ? "failed" : "paused";
    return "running";
  }

  if (getStageVisibility(stageType, decision) === "skip") return "skipped";

  if (pausePendingStage === stageType) return "paused";

  return "pending";
}

/**
 * Resolves which visible stage is the single "paused" resume target, or null
 * if this cycle isn't paused or warming up. Pure — no React.
 *
 * Fires in three cases:
 *  1. Paused cycle (live run inactive, cycle.status === "running"). The first
 *     visible stage with no commit on path and no orchestrator record is where
 *     resume will pick up.
 *  2. Resume warmup (live run active, this is the active cycle, the
 *     orchestrator hasn't yet emitted `step_started` for any cycle stage —
 *     `currentStage` is null or sits outside the visible cycle stages, e.g.
 *     "prerequisites"). Without this, the dashboard shows the about-to-run
 *     stage as plain "pending" right after Resume — no signal that the user's
 *     click took effect.
 *  3. Navigated mid-cycle (live run inactive, HEAD sits on a checkpoint
 *     between two stages of this cycle). The merged cycle.status can still
 *     read "completed" — it's pulled from the original run that pushed past
 *     these commits — so isPausedCycle is false. The active path is the
 *     source of truth: when only *some* visible stages have step-commits on
 *     path, Resume will pick up from the first missing one.
 */
export function resolvePausePendingStage(
  visibleStages: StepType[],
  stages: UiLoopStage[],
  pathStages: ReadonlySet<StepType>,
  isPausedCycle: boolean,
  isActiveCycle: boolean = false,
  isRunning: boolean = false,
  currentStage: StepType | null = null,
): StepType | null {
  const inWarmup =
    isRunning &&
    isActiveCycle &&
    (currentStage === null || !visibleStages.includes(currentStage));
  const inNavigatedMidCycle =
    !isRunning &&
    visibleStages.some((st) => pathStages.has(st)) &&
    visibleStages.some((st) => !pathStages.has(st));
  if (!isPausedCycle && !inWarmup && !inNavigatedMidCycle) return null;
  for (const st of visibleStages) {
    const a = stages.find((s) => s.type === st);
    if (a) {
      // A stopped/failed actual is itself the resume target — it already
      // renders as paused via its own status. Returning a *later* stage here
      // would double-mark (e.g. plan paused AND implement paused).
      if (a.status === "stopped" || a.status === "failed") return null;
      continue;
    }
    if (pathStages.has(st)) continue;
    return st;
  }
  return null;
}

export function computeImplementMetrics(
  stageType: StepType,
  implementPhases: ImplementSubPhase[],
): { cost: number; durationMs: number } {
  if (stageType !== "implement") return { cost: 0, durationMs: 0 };
  return {
    cost: implementPhases.reduce((sum, ip) => sum + ip.costUsd, 0),
    durationMs: implementPhases.reduce((sum, ip) => sum + ip.durationMs, 0),
  };
}
