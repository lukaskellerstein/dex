// Discriminated-union of all events the orchestrator emits to the UI.
// Each event carries enough context for the renderer to update without
// querying back into core (events flow one way: core → IPC → renderer).

import type { RunConfig } from "./config.js";
import type {
  TaskPhase,
  AgentStep,
  SubagentInfo,
  StepType,
  LoopTermination,
  PrerequisiteCheck,
  UserInputQuestion,
  DriftSummary,
} from "./types.js";

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
      type: "paused";
      runId: string;
      reason: "user_abort" | "step_mode" | "budget" | "failure";
      step?: StepType;
    }
  // Conflict resolver progress events (014/US3) — emitted while
  // mergeToMain hands off to the AI resolver harness. Field shapes are
  // contracted in specs/014-branch-management/contracts/conflict-resolver-events.md.
  | {
      type: "conflict-resolver:file-start";
      file: string;
      index: number;
      total: number;
    }
  | {
      type: "conflict-resolver:file-done";
      file: string;
      ok: boolean;
      iterationsUsed: number;
    }
  | {
      type: "conflict-resolver:iteration";
      n: number;
      costSoFar: number;
      currentFile: string;
    }
  | {
      type: "conflict-resolver:done";
      ok: boolean;
      costTotal: number;
      reason?:
        | "max_iterations"
        | "cost_cap"
        | "verify_failed"
        | "agent_gave_up"
        | "user_cancelled";
    };

export type EmitFn = (event: OrchestratorEvent) => void;
