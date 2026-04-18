// ── State Management Types (used by both types.ts and state.ts) ──

export interface DriftSummary {
  missingArtifacts: string[];
  modifiedArtifacts: string[];
  taskRegressions: Record<string, string[]>;
  taskProgressions: Record<string, string[]>;
  extraCommits: number;
  pendingQuestionReask: boolean;
}

// ── Spec-Kit Types (parsed from tasks.md for UI display) ──

export interface Phase {
  number: number;
  name: string;
  purpose: string;
  tasks: Task[];
  status: "complete" | "partial" | "not_started";
}

export interface Task {
  id: string;
  userStory: string | null;
  priority: string | null;
  description: string;
  status: "done" | "not_done" | "code_exists" | "in_progress";
  lineNumber: number;
  phase: number;
}

// ── Agent Execution Types ──

export type StepType =
  | "debug"
  | "user_message"
  | "thinking"
  | "text"
  | "tool_call"
  | "tool_result"
  | "tool_error"
  | "skill_invoke"
  | "skill_result"
  | "subagent_spawn"
  | "subagent_result"
  | "completed"
  | "error";

export interface AgentStep {
  id: string;
  sequenceIndex: number;
  type: StepType;
  content: string | null;
  metadata: Record<string, unknown> | null;
  durationMs: number | null;
  tokenCount: number | null;
  createdAt: string;
}

export interface SubagentInfo {
  id: string;
  subagentId: string;
  subagentType: string;
  description: string | null;
  startedAt: string;
  completedAt: string | null;
}

// ── Loop Stage Types ──

export type LoopStageType =
  | "prerequisites"
  | "clarification"
  | "clarification_product"
  | "clarification_technical"
  | "clarification_synthesis"
  | "constitution"
  | "manifest_extraction"
  | "gap_analysis"
  | "specify"
  | "plan"
  | "tasks"
  | "implement"
  | "implement_fix"
  | "verify"
  | "learnings";

export interface LoopStage {
  type: LoopStageType;
  specDir?: string;
  phaseNumber?: number;
  startedAt: string;
  completedAt?: string;
  costUsd: number;
  durationMs: number;
  result?: string;
}

export type GapAnalysisDecision =
  | { type: "NEXT_FEATURE"; name: string; description: string; featureId: number }
  | { type: "RESUME_FEATURE"; specDir: string }
  | { type: "REPLAN_FEATURE"; specDir: string }
  | { type: "RESUME_AT_STAGE"; specDir: string; resumeAtStage: LoopStageType }
  | { type: "GAPS_COMPLETE" };

export interface LoopCycle {
  id: string;
  runId: string;
  cycleNumber: number;
  featureName: string | null;
  specDir: string | null;
  decision: GapAnalysisDecision;
  stages: LoopStage[];
  status: "running" | "completed" | "failed" | "skipped";
  costUsd: number;
  durationMs: number;
  startedAt: string;
  completedAt?: string;
}

export interface FailureRecord {
  specDir: string;
  implFailures: number;
  replanFailures: number;
}

export type TerminationReason =
  | "gaps_complete"
  | "budget_exceeded"
  | "max_cycles_reached"
  | "user_abort";

export interface LoopTermination {
  reason: TerminationReason;
  cyclesCompleted: number;
  totalCostUsd: number;
  totalDurationMs: number;
  featuresCompleted: string[];
  featuresSkipped: string[];
}

// ── User Input (AskUserQuestion) ──

export interface UserInputQuestionOption {
  label: string;
  description: string;
  recommended?: boolean;
}

export interface UserInputQuestion {
  question: string;
  header: string;
  options: UserInputQuestionOption[];
  multiSelect: boolean;
}

// ── Prerequisites Check Types ──

export type PrerequisiteCheckName = "claude_cli" | "specify_cli" | "git_init" | "github_repo" | "speckit_init";
export type PrerequisiteCheckStatus = "running" | "pass" | "fail" | "fixed";

export interface PrerequisiteCheck {
  name: PrerequisiteCheckName;
  status: PrerequisiteCheckStatus;
  message?: string;
}

// ── Configuration ──

export interface RunConfig {
  projectDir: string;
  specDir: string;
  mode: "plan" | "build" | "loop";
  model: string;
  maxIterations: number;
  maxTurns: number;
  phases: number[] | "all";
  runAllSpecs?: boolean;

  // Loop-mode fields (only relevant when mode === "loop")
  descriptionFile?: string;
  maxLoopCycles?: number;
  maxBudgetUsd?: number;
  autoClarification?: boolean;

  // Resume: set to true to resume from .dex/state.json
  resume?: boolean;

  // Structured outputs configuration
  maxVerifyRetries?: number;       // default: 1 — fix-reverify attempts per cycle
  maxLearningsPerCategory?: number; // default: 20 — cap per category in learnings.md

  // Step mode: when true, orchestrator pauses after every stage awaiting
  // user Keep/Try again/Try N ways decision. Distinct from user_abort.
  stepMode?: boolean;

  // Agent backend override (009). When set, wins over .dex/dex-config.json.
  // Must match a name registered in AGENT_REGISTRY ("claude" | "mock" | future providers).
  agent?: string;
}

// ── Events: Orchestrator → UI ──

export type OrchestratorEvent =
  | { type: "run_started"; config: RunConfig; runId: string; branchName: string }
  | { type: "spec_started"; specDir: string }
  | { type: "spec_completed"; specDir: string; phasesCompleted: number }
  | { type: "phase_started"; phase: Phase; iteration: number; phaseTraceId: string }
  | { type: "agent_step"; step: AgentStep }
  | { type: "subagent_started"; info: SubagentInfo }
  | { type: "subagent_completed"; subagentId: string }
  | { type: "tasks_updated"; phases: Phase[] }
  | {
      type: "phase_completed";
      phase: Phase;
      cost: number;
      durationMs: number;
    }
  | {
      type: "run_completed";
      totalCost: number;
      totalDuration: number;
      phasesCompleted: number;
      branchName: string;
      prUrl: string | null;
    }
  | { type: "error"; message: string; phaseNumber?: number }
  // Prerequisites events
  | { type: "prerequisites_started"; runId: string }
  | { type: "prerequisites_check"; runId: string; check: PrerequisiteCheck }
  | { type: "prerequisites_completed"; runId: string }
  // Loop mode events
  | { type: "clarification_started"; runId: string }
  | { type: "clarification_question"; runId: string; question: string }
  | { type: "clarification_completed"; runId: string; fullPlanPath: string }
  | { type: "loop_cycle_started"; runId: string; cycleNumber: number }
  | {
      type: "loop_cycle_completed";
      runId: string;
      cycleNumber: number;
      decision: string;
      featureName: string | null;
      specDir: string | null;
      costUsd: number;
    }
  | {
      type: "stage_started";
      runId: string;
      cycleNumber: number;
      stage: LoopStageType;
      phaseTraceId: string;
      specDir?: string;
      phaseNumber?: number;
    }
  | {
      type: "stage_completed";
      runId: string;
      cycleNumber: number;
      stage: LoopStageType;
      phaseTraceId: string;
      costUsd: number;
      durationMs: number;
      stopped?: boolean;
    }
  | { type: "loop_terminated"; runId: string; termination: LoopTermination }
  // Manifest & structured output events
  | { type: "manifest_created"; runId: string; featureCount: number }
  | { type: "manifest_drift_detected"; runId: string }
  | { type: "verify_failed"; runId: string; cycleNumber: number; blockingCount: number; summary: string }
  // User input request/response (AskUserQuestion)
  | { type: "user_input_request"; runId: string; requestId: string; questions: UserInputQuestion[] }
  | { type: "user_input_response"; requestId: string; answers: Record<string, string> }
  // State reconciliation events
  | { type: "state_reconciling"; runId: string }
  | { type: "state_reconciled"; runId: string; driftSummary: DriftSummary }
  // Interactive checkpoint events (008)
  | {
      type: "stage_candidate";
      runId: string;
      cycleNumber: number;
      stage: LoopStageType;
      checkpointTag: string;
      candidateSha: string;
      attemptBranch: string;
    }
  | {
      type: "checkpoint_promoted";
      runId: string;
      checkpointTag: string;
      sha: string;
    }
  | {
      type: "paused";
      runId: string;
      reason: "user_abort" | "step_mode" | "budget" | "failure";
      stage?: LoopStageType;
    }
  | {
      type: "variant_group_resume_needed";
      projectDir: string;
      groupId: string;
      stage: LoopStageType;
      pendingCount: number;
      runningCount: number;
    }
  | {
      type: "variant_group_complete";
      groupId: string;
    };

export type EmitFn = (event: OrchestratorEvent) => void;
