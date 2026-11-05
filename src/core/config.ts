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

  // Loop-mode fields (only relevant when mode === "loop"). Budgets, turns and
  // retry counts are the project's: `.dex/policy.json` limits (research R9).
  descriptionFile?: string;
  autoClarification?: boolean;

  // Resume: set to true to resume from .dex/state.json
  resume?: boolean;

  // `dex run --once`: run one stage (one task phase for implement), then stop.
  once?: boolean;

  // Agent backend override. When set, wins over .dex/dex-config.json's
  // `agent` field. Must match a name `createAgentRunner` knows about
  // ("claude", "mock"; later "codex", "copilot").
  agent?: string;
}

/** The loop settings `dex run` uses: the same values the app's run buttons use (App.tsx). */
export const LOOP_DEFAULTS = { model: "claude-opus-4-6", maxIterations: 50, maxTurns: 75 } as const;
