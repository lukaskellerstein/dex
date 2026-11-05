// Discriminated-union of all events the orchestrator emits to the UI.
// Each event carries enough context for the renderer to update without
// querying back into core (events flow one way: core → IPC → renderer).

import type { RunConfig } from "./config.js";
import type { GateDecision } from "./gates.js";
import type { StageName } from "./queue.js";
import type { SensorRun } from "./sensors.js";
import type { PauseReason } from "./state.js";
import type {
  AgentStep,
  LoopTermination,
  PrerequisiteCheck,
  StepType,
  SubagentInfo,
  TaskPhase,
  UserInputQuestion,
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
  // User input request/response (AskUserQuestion)
  | { type: "user_input_request"; runId: string; requestId: string; questions: UserInputQuestion[] }
  | { type: "user_input_response"; requestId: string; answers: Record<string, string> }
  // The picker's choice before each stage (D-015-1)
  | {
      type: "stage_decision";
      runId: string;
      cycleNumber: number;
      entryId: string;
      stage: StageName | null;
      decision: "stage" | "pause" | "complete";
      reason: string;
    }
  // A stage left files uncommitted (research R4); the next branch switch pauses on them
  | { type: "tree_dirty"; runId: string; cycleNumber: number; files: string[] }
  // The policy denied a tool call in the PreToolUse hook (contracts/policy-json.md)
  | {
      type: "policy_denied";
      runId: string;
      agentRunId: string;
      toolName: string;
      subject: string;
      reason: string;
      rule: "deny" | "writeRoots" | "frozen" | "scope";
    }
  // 016: one run of one sensor, in Dex's own process (D-016-1)
  | {
      type: "sensor_run";
      runId: string;
      entryId: string;
      stage: string;
      agentRunId: string | null;
      run: SensorRun;
    }
  // 016: what a gate decided, and the record that holds the evidence
  | {
      type: "gate_decided";
      runId: string;
      entryId: string;
      agentRunId: string | null;
      decision: GateDecision;
      /** Project-relative, e.g. `.dex/evidence/003-promo-codes/implement-3.json`. */
      evidenceFile: string;
    }
  // 016: the entry's one-page digest was (re)written
  | { type: "digest_written"; runId: string; entryId: string; path: string }
  // A tool call waits for a human (a policy or settings `ask` rule)
  | {
      type: "tool_approval_request";
      runId: string;
      requestId: string;
      toolName: string;
      subject: string;
      input: unknown;
      source: "policy" | "settings";
      reason?: string;
    }
  // A held human request was answered (or cancelled by Stop)
  | {
      type: "request_resolved";
      requestId: string;
      by: "human" | "default" | "answer_book" | "stop";
    }
  | {
      type: "paused";
      runId: string;
      reason: PauseReason;
      detail?: string;
      step?: StepType;
    };

export type EmitFn = (event: OrchestratorEvent) => void;
