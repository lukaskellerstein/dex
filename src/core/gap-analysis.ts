/**
 * What: Parses the gap-analysis agent's structured output into a typed GapAnalysisDecision and exposes the per-decision dispatch helpers used by the cycle iterator.
 * Not: Does not invoke the gap-analysis agent itself — main-loop owns the runStage call. Does not mutate manifest state — that stays in main-loop where the deterministic NEXT_FEATURE / GAPS_COMPLETE decisions are also constructed.
 * Deps: types.GapAnalysisDecision (discriminated union), types.StepType (cycle ordering).
 */

import type { GapAnalysisDecision, StepType } from "./types.js";

// Source of truth for in-cycle stage ordering. Keep aligned with the cycle
// iterator in stages/main-loop.ts (gap_analysis is implicit cycle-entry, not in this list).
const STEP_ORDER: ReadonlyArray<StepType> = [
  "specify",
  "plan",
  "tasks",
  "implement",
  "verify",
  "learnings",
];

// LLM gap-analysis emits exactly two decisions; the other three variants
// (NEXT_FEATURE, RESUME_AT_STEP, GAPS_COMPLETE) are constructed deterministically
// in main-loop.ts from manifest state and resume hints.
type LlmDecision = Extract<GapAnalysisDecision, { type: "RESUME_FEATURE" | "REPLAN_FEATURE" }>;

/**
 * Parses the structured output returned by the gap-analysis stage's LLM call.
 *
 * Throws — never returns a fallback — if the input is malformed (null, not an
 * object, missing `decision` field, non-string `decision`, or an unknown
 * decision string). Callers that want a fallback must catch.
 */
export function parseGapAnalysisDecision(
  structuredOutput: unknown,
  specDir: string,
): LlmDecision {
  if (structuredOutput === null || typeof structuredOutput !== "object") {
    throw new Error(
      `parseGapAnalysisDecision: expected object, got ${structuredOutput === null ? "null" : typeof structuredOutput}`,
    );
  }
  const obj = structuredOutput as Record<string, unknown>;
  const decision = obj.decision;
  if (typeof decision !== "string") {
    throw new Error(
      `parseGapAnalysisDecision: 'decision' field is missing or not a string (got ${typeof decision})`,
    );
  }
  if (decision !== "RESUME_FEATURE" && decision !== "REPLAN_FEATURE") {
    throw new Error(
      `parseGapAnalysisDecision: unknown decision "${decision}" — must be RESUME_FEATURE or REPLAN_FEATURE`,
    );
  }
  if (!specDir) {
    throw new Error("parseGapAnalysisDecision: specDir is required for RESUME_FEATURE / REPLAN_FEATURE");
  }
  return { type: decision, specDir };
}

/**
 * Returns the entry-point dispatch info for a decision: which stage to enter
 * and which spec dir to operate on. The caller iterates from `nextStep` using
 * `shouldRunStage` to gate subsequent stages.
 *
 * Spec form (T037) declared this `Promise<{...}>`, but no async work is
 * required — the function is pure. Sync return is correct and lets the test
 * contract avoid await noise.
 */
export function applyGapAnalysisDecision(
  decision: GapAnalysisDecision,
): { nextSpecDir?: string; nextStep?: StepType; terminate?: boolean } {
  switch (decision.type) {
    case "NEXT_FEATURE":
      return { nextStep: "specify" };
    case "RESUME_FEATURE":
      return { nextSpecDir: decision.specDir, nextStep: "implement" };
    case "REPLAN_FEATURE":
      return { nextSpecDir: decision.specDir, nextStep: "plan" };
    case "RESUME_AT_STEP": {
      const idx = STEP_ORDER.indexOf(decision.resumeAtStep);
      // resumeAtStep is the *last completed* step → next step is one ahead.
      // If resumeAtStep is the last step in STEP_ORDER, there's nothing left.
      const next = STEP_ORDER[idx + 1];
      return next
        ? { nextSpecDir: decision.specDir, nextStep: next }
        : { nextSpecDir: decision.specDir, terminate: true };
    }
    case "GAPS_COMPLETE":
      return { terminate: true };
  }
}

/**
 * Whether a given cycle stage should run for this decision. Mirrors the
 * inline switch currently embedded in stages/main-loop.ts; centralising it
 * here lets new decision variants surface a TypeScript exhaustiveness error
 * in one place instead of scattering `default: throw` defenses across the
 * cycle iterator.
 */
export function shouldRunStage(
  decision: GapAnalysisDecision,
  step: StepType,
): boolean {
  switch (decision.type) {
    case "NEXT_FEATURE":
      return step !== "gap_analysis";
    case "REPLAN_FEATURE":
      return (
        step === "plan"
        || step === "tasks"
        || step === "implement"
        || step === "verify"
        || step === "learnings"
      );
    case "RESUME_FEATURE":
      return step === "implement" || step === "verify" || step === "learnings";
    case "RESUME_AT_STEP":
      return STEP_ORDER.indexOf(step) > STEP_ORDER.indexOf(decision.resumeAtStep);
    case "GAPS_COMPLETE":
      return false;
  }
}

/**
 * Returns the spec dir associated with a decision (`null` for `NEXT_FEATURE`
 * and `GAPS_COMPLETE` — both lack a spec dir at the moment the decision is
 * made; specify creates one for `NEXT_FEATURE`).
 */
export function getDecisionSpecDir(decision: GapAnalysisDecision): string | null {
  switch (decision.type) {
    case "RESUME_FEATURE":
    case "REPLAN_FEATURE":
    case "RESUME_AT_STEP":
      return decision.specDir;
    case "NEXT_FEATURE":
    case "GAPS_COMPLETE":
      return null;
  }
}
