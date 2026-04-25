import type { StepType } from "../../../core/types.js";

/**
 * Stage order for UI lookup — mirrors STEP_ORDER in src/core/state.ts.
 * Renderer has its own copy because it can't import from core (they're in
 * different build contexts).
 */
export const STAGE_ORDER_RENDERER: StepType[] = [
  "prerequisites",
  "clarification",
  "clarification_product",
  "clarification_technical",
  "clarification_synthesis",
  "constitution",
  "manifest_extraction",
  "gap_analysis",
  "specify",
  "plan",
  "tasks",
  "implement",
  "implement_fix",
  "verify",
  "learnings",
];
