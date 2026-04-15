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

// ── Configuration ──

export interface RunConfig {
  projectDir: string;
  specDir: string;
  mode: "plan" | "build";
  model: string;
  maxIterations: number;
  maxTurns: number;
  phases: number[] | "all";
  runAllSpecs?: boolean;
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
  | { type: "error"; message: string; phaseNumber?: number };

export type EmitFn = (event: OrchestratorEvent) => void;
