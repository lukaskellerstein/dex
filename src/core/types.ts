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

/**
 * Every stage the orchestrator can run. The new-project stages come first; the
 * per-entry stages (brief … verify) match `StageName` in queue.ts.
 */
export type StepType =
  | "prerequisites"
  | "clarification"
  | "clarification_product"
  | "clarification_technical"
  | "clarification_synthesis"
  | "constitution"
  | "manifest_extraction"
  | "brief"
  | "specify"
  | "clarify"
  | "plan"
  | "tasks"
  | "implement"
  | "verify"
  | "completion";

export type TerminationReason =
  | "queue_complete"
  | "user_abort"
  | "paused"
  | "budget_exceeded"
  | "failed";

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

export type PrerequisiteCheckName =
  | "claude_cli"
  | "specify_cli"
  | "git_init"
  | "github_repo"
  | "speckit_init";
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
export type { EmitFn, OrchestratorEvent } from "./events.js";
