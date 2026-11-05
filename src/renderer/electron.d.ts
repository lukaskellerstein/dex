import type { RequestAnswer } from "../core/humanInput.js";
import type { RunSnapshot } from "../core/run-snapshot.js";
import type {
  AgentRunRecord,
  AgentStepRecord,
  RunRecord,
  SpecStats,
  SubagentRecord,
} from "../core/runs.js";
import type { DexState } from "../core/state.js";
import type { OrchestratorEvent, RunConfig, TaskPhase } from "../core/types.js";

export interface DexAPI {
  // Project
  openProject(): Promise<string | null>;
  listSpecs(dir: string): Promise<string[]>;
  parseSpec(dir: string, spec: string): Promise<TaskPhase[]>;
  readFile(filePath: string): Promise<string | null>;
  writeFile(filePath: string, content: string): Promise<boolean>;
  pickFolder(): Promise<string | null>;
  pickGoalFile(defaultDir: string): Promise<string | null>;
  createProject(parentDir: string, name: string): Promise<{ path: string } | { error: string }>;
  openProjectPath(projectPath: string): Promise<{ path: string } | { error: string }>;
  pathExists(targetPath: string): Promise<boolean>;
  /** Fresh state.json + the picker's queue view + validation errors (research R17). */
  getRunSnapshot(projectDir: string): Promise<RunSnapshot>;
  /** The entry's one-page digest (016 FR-038); null before Dex wrote one. */
  getDigest(
    projectDir: string,
    entryId: string,
  ): Promise<{ markdown: string; path: string } | null>;

  // App config (global ~/.dex/app-config.json)
  getWelcomeDefaults(): Promise<{ defaultLocation: string; defaultName: string }>;

  // Orchestrator
  getProjectState(dir: string): Promise<DexState | null>;
  startRun(config: RunConfig): Promise<void>;
  stopRun(): Promise<void>;
  answerRequest(requestId: string, answer: RequestAnswer): Promise<void>;
  getRunState(): Promise<{
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
  } | null>;

  // Orchestrator events
  onOrchestratorEvent(cb: (event: OrchestratorEvent) => void): () => void;

  // History — per-project JSON storage (007-sqlite-removal)
  getRun(projectDir: string, runId: string): Promise<RunRecord | null>;
  getLatestProjectRun(projectDir: string): Promise<RunRecord | null>;
  getAgentSteps(projectDir: string, runId: string, agentRunId: string): Promise<AgentStepRecord[]>;
  getAgentRunSubagents(
    projectDir: string,
    runId: string,
    agentRunId: string,
  ): Promise<SubagentRecord[]>;
  getLatestAgentRun(
    projectDir: string,
    specDir: string,
    taskPhaseNumber: number,
  ): Promise<AgentRunRecord | null>;
  getSpecAgentRuns(projectDir: string, specDir: string): Promise<AgentRunRecord[]>;
  getSpecAggregateStats(projectDir: string, specDir: string): Promise<SpecStats>;

  // Window controls
  minimize(): Promise<void>;
  maximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  onMaximizedChange(cb: (maximized: boolean) => void): () => void;

  // Dev — surface renderer errors into the main-process terminal log
  // (see src/main/preload-modules/dev-api.ts).
  reportRendererError(payload: {
    type: "error" | "unhandledrejection";
    message: string;
    source?: string;
    line?: number;
    col?: number;
    stack?: string | null;
  }): void;
}

declare global {
  interface Window {
    dexAPI: DexAPI;
  }
}
