// Run-time configuration for a single orchestrator run. Persisted into
// state.json (config snapshot) so resume continues with the same params.

export interface RunConfig {
  projectDir: string;
  specDir: string;
  mode: "plan" | "build" | "loop";
  model: string;
  maxIterations: number;
  maxTurns: number;
  taskPhases: number[] | "all";
  runAllSpecs?: boolean;

  // Loop-mode fields (only relevant when mode === "loop")
  descriptionFile?: string;
  maxLoopCycles?: number;
  maxBudgetUsd?: number;
  autoClarification?: boolean;

  // Resume: set to true to resume from .dex/state.json
  resume?: boolean;

  // Structured outputs configuration
  maxVerifyRetries?: number; // default: 1 — fix-reverify attempts per cycle
  maxLearningsPerCategory?: number; // default: 20 — cap per category in learnings.md

  // Step mode: when true, orchestrator pauses after every step awaiting
  // user Keep/Try again/Try N ways decision. Distinct from user_abort.
  stepMode?: boolean;

  // Agent backend override. When set, wins over .dex/dex-config.json's
  // `agent` field. Must match a name `createAgentRunner` knows about
  // ("claude", "mock"; later "codex", "copilot").
  agent?: string;
}
