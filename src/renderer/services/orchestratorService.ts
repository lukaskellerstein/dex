/**
 * What: Typed wrapper over window.dexAPI orchestrator surface — startRun, stopRun, answerQuestion, getProjectState, getRunState, subscribeEvents.
 * Not: Does not own loop/trace/question/run-session state — those are renderer hooks (Wave B). Does not transform events.
 * Deps: window.dexAPI orchestrator + getProjectState; OrchestratorEvent / RunConfig / DexState types.
 */
import type { OrchestratorEvent, RunConfig } from "../../core/types.js";
import type { DexState } from "../../core/state.js";

export type OrchestratorErrorCode =
  | "ABORTED"
  | "MISSING_GOAL_FILE"
  | "MANIFEST_NOT_FOUND"
  | "MANIFEST_EXTRACTION_FAILED"
  | "MANIFEST_UPDATE_FAILED"
  | "GAP_ANALYSIS_FAILED"
  | "SPEC_NOT_CREATED"
  | "STRUCTURED_OUTPUT_INVALID"
  | "RUNNER_NOT_INITIALIZED"
  | "INVALID_RUN_ID"
  | "ORCHESTRATOR_FAILURE";

export class OrchestratorError extends Error {
  readonly code: OrchestratorErrorCode;

  constructor(code: OrchestratorErrorCode, message: string) {
    super(message);
    this.name = "OrchestratorError";
    this.code = code;
  }
}

function mapToOrchestratorError(err: unknown): OrchestratorError {
  if (err instanceof OrchestratorError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (/abort/i.test(message)) {
    return new OrchestratorError("ABORTED", message);
  }
  if (/GOAL.*not found|requires GOAL/i.test(message)) {
    return new OrchestratorError("MISSING_GOAL_FILE", message);
  }
  if (/manifest extraction failed/i.test(message)) {
    return new OrchestratorError("MANIFEST_EXTRACTION_FAILED", message);
  }
  if (/manifest not found|feature manifest/i.test(message)) {
    return new OrchestratorError("MANIFEST_NOT_FOUND", message);
  }
  if (/cannot update.*manifest|featureId.*not found/i.test(message)) {
    return new OrchestratorError("MANIFEST_UPDATE_FAILED", message);
  }
  if (/gap analysis.*null|gap analysis.*returned/i.test(message)) {
    return new OrchestratorError("GAP_ANALYSIS_FAILED", message);
  }
  if (/specify completed but no new spec/i.test(message)) {
    return new OrchestratorError("SPEC_NOT_CREATED", message);
  }
  if (/structured output validation/i.test(message)) {
    return new OrchestratorError("STRUCTURED_OUTPUT_INVALID", message);
  }
  if (/runner was resolved|currentRunner/i.test(message)) {
    return new OrchestratorError("RUNNER_NOT_INITIALIZED", message);
  }
  if (/invalid runId/i.test(message)) {
    return new OrchestratorError("INVALID_RUN_ID", message);
  }
  return new OrchestratorError("ORCHESTRATOR_FAILURE", message);
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    throw mapToOrchestratorError(err);
  }
}

export type RunStateSnapshot = {
  runId: string;
  projectDir: string;
  specDir: string;
  mode: string;
  model: string;
  agentRunId: string;
  taskPhaseNumber: number;
  taskPhaseName: string;
  currentCycle?: number;
  currentStep?: string;
  isClarifying?: boolean;
  cyclesCompleted?: number;
};

export const orchestratorService = {
  startRun(config: RunConfig): Promise<void> {
    return call(() => window.dexAPI.startRun(config));
  },

  stopRun(): Promise<void> {
    return call(() => window.dexAPI.stopRun());
  },

  answerQuestion(requestId: string, answers: Record<string, string>): Promise<void> {
    return call(() => window.dexAPI.answerQuestion(requestId, answers));
  },

  getProjectState(dir: string): Promise<DexState | null> {
    return call(() => window.dexAPI.getProjectState(dir));
  },

  getRunState(): Promise<RunStateSnapshot | null> {
    return call(() => window.dexAPI.getRunState());
  },

  subscribeEvents(handler: (event: OrchestratorEvent) => void): () => void {
    return window.dexAPI.onOrchestratorEvent(handler);
  },
};
