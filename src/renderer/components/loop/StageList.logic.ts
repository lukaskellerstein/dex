/**
 * What: Pure helpers for StageList — stage visibility (per gap-analysis decision), stage-status derivation, and pause-pending resolution.
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
  | "paused"
  | "pause-pending";

export function getStageVisibility(stageType: StepType, decision: string | null): "show" | "skip" {
  if (!decision) return "show";
  switch (stageType) {
    case "specify":
      return decision === "NEXT_FEATURE" ? "show" : "skip";
    case "plan":
    case "tasks":
      return decision === "NEXT_FEATURE" || decision === "REPLAN_FEATURE" ? "show" : "skip";
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
  hasVerifyOrLater: boolean,
  implementPhases: ImplementSubPhase[],
  isRunning: boolean,
  isPausedCycle: boolean,
  /** 010: stage types whose step-commit is on the active path. Overlay for navigated state. */
  pathStages: ReadonlySet<StepType>,
  /** 010: stage type reserved as the "next" pause-pending row when paused. */
  pausePendingStage: StepType | null,
): StageStatus {
  // For implement, derive from currentStage and implementPhases.
  if (stageType === "implement") {
    if (actual) {
      if (actual.status === "stopped") return "paused";
      // In a paused cycle, implement was the last real work — mark as paused.
      if (actual.status === "completed" && isPausedCycle) return "paused";
      if (actual.status === "completed") return "completed";
      if (actual.status === "failed") return isRunning ? "failed" : "paused";
      return "running";
    }
    if (isActiveCycle && currentStage === "implement") return "running";
    if (hasVerifyOrLater && !isPausedCycle) return "completed";
    if (implementPhases.length > 0) {
      const allDone = implementPhases.every((ip) => ip.status === "completed");
      // Even if all sub-phases that ran are done, if verify never ran and the
      // orchestrator isn't running, the implementation was interrupted.
      if (allDone && !isRunning && !hasVerifyOrLater) return "paused";
      if (isPausedCycle) return "paused";
      if (allDone) return "completed";
      return isRunning ? "running" : "paused";
    }
    if (pathStages.has("implement")) return "completed";
    if (pausePendingStage === "implement") return "pause-pending";
    if (!isActiveCycle && decision) return "pending";
    return "pending";
  }

  // In a paused cycle, verify/learnings that ran as abort artifacts should show as skipped.
  if (isPausedCycle && (stageType === "verify" || stageType === "learnings")) {
    if (actual && actual.status === "completed" && actual.durationMs < 5000) {
      return "skipped";
    }
  }

  if (actual) {
    if (actual.status === "completed") return "completed";
    if (actual.status === "stopped") return "paused";
    if (actual.status === "failed") return isRunning ? "failed" : "paused";
    return "running";
  }

  if (getStageVisibility(stageType, decision) === "skip") return "skipped";

  // 010 — selectedPath overlay: orchestrator has no record but the active path's commits do.
  if (pathStages.has(stageType)) return "completed";

  // 010 — pause-pending: marks the next-unstarted stage when paused.
  if (pausePendingStage === stageType) return "pause-pending";

  return "pending";
}

/**
 * Resolves which visible stage is the "next on resume" pause-pending row, or null
 * if this cycle isn't paused. Pure — no React.
 */
export function resolvePausePendingStage(
  visibleStages: StepType[],
  stages: UiLoopStage[],
  pathStages: ReadonlySet<StepType>,
  isPausedCycle: boolean,
  isActiveCycle: boolean,
): StepType | null {
  if (!isPausedCycle || !isActiveCycle) return null;
  for (const st of visibleStages) {
    const hasActual = stages.some((s) => s.type === st);
    if (hasActual) continue;
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
