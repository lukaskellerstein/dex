/**
 * What: Typed wrapper over window.dexAPI history.* — getRun, getLatestProjectRun, getAgentSteps, getAgentRunSubagents, getLatestAgentRun, getSpecAgentRuns, getSpecAggregateStats.
 * Not: Does not own currentRun state — that lives in useRunSession (Wave B). Does not transform records.
 * Deps: window.dexAPI history methods; RunRecord / AgentRunRecord / AgentStepRecord / SubagentRecord / SpecStats from core/runs.
 */
import type {
  RunRecord,
  AgentRunRecord,
  AgentStepRecord,
  SubagentRecord,
  SpecStats,
} from "../../core/runs.js";

export type HistoryErrorCode =
  | "RUN_NOT_FOUND"
  | "INVALID_RUN_ID"
  | "RUN_FILE_CORRUPT"
  | "HISTORY_FAILURE";

export class HistoryError extends Error {
  readonly code: HistoryErrorCode;

  constructor(code: HistoryErrorCode, message: string) {
    super(message);
    this.name = "HistoryError";
    this.code = code;
  }
}

function mapToHistoryError(err: unknown): HistoryError {
  if (err instanceof HistoryError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (/run.*not found|updateRun: run/i.test(message)) {
    return new HistoryError("RUN_NOT_FOUND", message);
  }
  if (/invalid runId/i.test(message)) {
    return new HistoryError("INVALID_RUN_ID", message);
  }
  if (/json.*parse|unexpected token|corrupt/i.test(message)) {
    return new HistoryError("RUN_FILE_CORRUPT", message);
  }
  return new HistoryError("HISTORY_FAILURE", message);
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    throw mapToHistoryError(err);
  }
}

export const historyService = {
  getRun(projectDir: string, runId: string): Promise<RunRecord | null> {
    return call(() => window.dexAPI.getRun(projectDir, runId));
  },

  getLatestProjectRun(projectDir: string): Promise<RunRecord | null> {
    return call(() => window.dexAPI.getLatestProjectRun(projectDir));
  },

  getAgentSteps(
    projectDir: string,
    runId: string,
    agentRunId: string,
  ): Promise<AgentStepRecord[]> {
    return call(() => window.dexAPI.getAgentSteps(projectDir, runId, agentRunId));
  },

  getAgentRunSubagents(
    projectDir: string,
    runId: string,
    agentRunId: string,
  ): Promise<SubagentRecord[]> {
    return call(() =>
      window.dexAPI.getAgentRunSubagents(projectDir, runId, agentRunId),
    );
  },

  getLatestAgentRun(
    projectDir: string,
    specDir: string,
    taskPhaseNumber: number,
  ): Promise<AgentRunRecord | null> {
    return call(() =>
      window.dexAPI.getLatestAgentRun(projectDir, specDir, taskPhaseNumber),
    );
  },

  getSpecAgentRuns(
    projectDir: string,
    specDir: string,
  ): Promise<AgentRunRecord[]> {
    return call(() => window.dexAPI.getSpecAgentRuns(projectDir, specDir));
  },

  getSpecAggregateStats(projectDir: string, specDir: string): Promise<SpecStats> {
    return call(() =>
      window.dexAPI.getSpecAggregateStats(projectDir, specDir),
    );
  },
};
