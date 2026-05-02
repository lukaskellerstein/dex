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
  | "completion"
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

// ── Re-exports ──
//
// RunConfig and OrchestratorEvent live in their own modules but are re-exported
// here so existing `import { RunConfig, OrchestratorEvent } from "./types.js"`
// call sites continue to work. New code can import directly from the source.

export type { RunConfig } from "./config.js";
export type { OrchestratorEvent, EmitFn } from "./events.js";
