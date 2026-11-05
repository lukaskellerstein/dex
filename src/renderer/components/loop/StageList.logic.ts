/**
 * What: Pure helpers for StageList — stage visibility, stage-status derivation, and resume-target resolution.
 * Not: Does not render. Does not own state. The component rewires the helpers into JSX.
 * Deps: StepType, UiLoopStage, ImplementSubPhase types only.
 */
import type { StepType } from "../../../core/types.js";
import type { ImplementSubPhase, UiLoopStage } from "../../hooks/useOrchestrator.js";

export const CYCLE_STAGES: StepType[] = [
  "brief",
  "specify",
  "clarify",
  "plan",
  "tasks",
  "implement",
  "verify",
];

export const STEP_LABELS: Record<StepType, string> = {
  prerequisites: "Prerequisites",
  clarification: "Clarification",
  clarification_product: "Clarification (Product)",
  clarification_technical: "Clarification (Technical)",
  clarification_synthesis: "Clarification (Synthesis)",
  constitution: "Constitution",
  manifest_extraction: "Manifest Extraction",
  brief: "Brief",
  specify: "Specify",
  clarify: "Clarify",
  plan: "Plan",
  tasks: "Tasks",
  implement: "Implement",
  verify: "Verify",
  completion: "Completion",
};

export type StageStatus = "pending" | "running" | "completed" | "skipped" | "failed" | "paused";

/**
 * `brief` runs only for an entry that generates its brief, so the row shows
 * once the stage has a record. Every other cycle stage always shows.
 */
export function getStageVisibility(stageType: StepType): "show" | "skip" {
  return stageType === "brief" ? "skip" : "show";
}

export function deriveStageStatus(
  stageType: StepType,
  actual: UiLoopStage | undefined,
  currentStage: StepType | null,
  isActiveCycle: boolean,
  implementPhases: ImplementSubPhase[],
  isRunning: boolean,
  _isPausedCycle: boolean,
  /** Single resume-target stage when paused — surfaces as "paused". */
  pausePendingStage: StepType | null,
): StageStatus {
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

  // Actual data wins over the visibility rule — if a stage has a record, it
  // ran (or is running) and its real status drives the icon.
  if (actual) {
    if (actual.status === "completed") return "completed";
    if (actual.status === "stopped") return "paused";
    if (actual.status === "failed") return isRunning ? "failed" : "paused";
    return "running";
  }

  if (getStageVisibility(stageType) === "skip") return "skipped";

  if (pausePendingStage === stageType) return "paused";

  return "pending";
}

/**
 * Resolves which visible stage is the single "paused" resume target, or null
 * if this cycle isn't paused or warming up. Pure — no React.
 *
 * Fires in two cases:
 *  1. Paused cycle (live run inactive, cycle.status === "running"). The first
 *     visible stage with no orchestrator record is where resume will pick up.
 *  2. Resume warmup (live run active, this is the active cycle, the
 *     orchestrator hasn't yet emitted `step_started` for any cycle stage —
 *     `currentStage` is null or sits outside the visible cycle stages, e.g.
 *     "prerequisites"). Without this, the dashboard shows the about-to-run
 *     stage as plain "pending" right after Resume — no signal that the user's
 *     click took effect.
 */
export function resolvePausePendingStage(
  visibleStages: StepType[],
  stages: UiLoopStage[],
  isPausedCycle: boolean,
  isActiveCycle: boolean = false,
  isRunning: boolean = false,
  currentStage: StepType | null = null,
): StepType | null {
  const inWarmup =
    isRunning && isActiveCycle && (currentStage === null || !visibleStages.includes(currentStage));
  if (!isPausedCycle && !inWarmup) return null;
  for (const st of visibleStages) {
    const a = stages.find((s) => s.type === st);
    if (a) {
      // A stopped/failed actual is itself the resume target — it already
      // renders as paused via its own status. Returning a *later* stage here
      // would double-mark (e.g. plan paused AND implement paused).
      if (a.status === "stopped" || a.status === "failed") return null;
      continue;
    }
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
