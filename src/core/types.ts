// ── State Management Types (used by both types.ts and state.ts) ──

export interface DriftSummary {
  missingArtifacts: string[];
  modifiedArtifacts: string[];
  taskRegressions: Record<string, string[]>;
  taskProgressions: Record<string, string[]>;
  extraCommits: number;
  pendingQuestionReask: boolean;
}

// ── Macro Phase (4 user-facing buckets) ──

export type Phase = "prerequisites" | "clarification" | "loop" | "completion";

// ── Spec-Kit Types (parsed from tasks.md for UI display) ──

export interface TaskPhase {
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
  phase: number; // tasks.md phase number
}

// ── Agent Step Types (one per tool call / text output) ──

type AgentStepType =
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
  type: AgentStepType;
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

// ── Process Step Types ──

export type StepType =
  | "prerequisites"
  | "create_branch"
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
  | "learnings"
  | "commit";

export type GapAnalysisDecision =
  | { type: "NEXT_FEATURE"; name: string; description: string; featureId: number }
  | { type: "RESUME_FEATURE"; specDir: string }
  | { type: "REPLAN_FEATURE"; specDir: string }
  | { type: "RESUME_AT_STEP"; specDir: string; resumeAtStep: StepType }
  | { type: "GAPS_COMPLETE" };

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

interface UserInputQuestionOption {
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
type PrerequisiteCheckStatus = "running" | "pass" | "fail" | "fixed";

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
  maxVerifyRetries?: number;       // default: 1 — fix-reverify attempts per cycle
  maxLearningsPerCategory?: number; // default: 20 — cap per category in learnings.md

  // Step mode: when true, orchestrator pauses after every step awaiting
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
  | { type: "spec_completed"; specDir: string; taskPhasesCompleted: number }
  | { type: "task_phase_started"; taskPhase: TaskPhase; iteration: number; agentRunId: string }
  | { type: "agent_step"; agentStep: AgentStep }
  | { type: "subagent_started"; info: SubagentInfo }
  | { type: "subagent_completed"; subagentId: string }
  | { type: "tasks_updated"; taskPhases: TaskPhase[] }
  | {
      type: "task_phase_completed";
      taskPhase: TaskPhase;
      cost: number;
      durationMs: number;
    }
  | {
      type: "run_completed";
      totalCost: number;
      totalDuration: number;
      taskPhasesCompleted: number;
      branchName: string;
      prUrl: string | null;
    }
  | { type: "error"; message: string; taskPhaseNumber?: number }
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
      type: "step_started";
      runId: string;
      cycleNumber: number;
      step: StepType;
      agentRunId: string;
      specDir?: string;
      taskPhaseNumber?: number;
    }
  | {
      type: "step_completed";
      runId: string;
      cycleNumber: number;
      step: StepType;
      agentRunId: string;
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
      type: "step_candidate";
      runId: string;
      cycleNumber: number;
      step: StepType;
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
      step?: StepType;
    }
  | {
      type: "variant_group_resume_needed";
      projectDir: string;
      groupId: string;
      step: StepType;
      pendingCount: number;
      runningCount: number;
    }
  | {
      type: "variant_group_complete";
      groupId: string;
    };

export type EmitFn = (event: OrchestratorEvent) => void;
