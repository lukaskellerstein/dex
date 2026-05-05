import type { OrchestratorEvent, TaskPhase, RunConfig, StepType } from "../core/types.js";
import type { DexState } from "../core/state.js";
import type {
  RunRecord,
  AgentRunRecord,
  AgentStepRecord,
  SubagentRecord,
  SpecStats,
} from "../core/runs.js";
import type {
  TimelineSnapshot,
  JumpToResult,
  DeleteBranchResult,
  MergeToMainResult,
  PromoteSummary,
} from "../core/checkpoints.js";
import type {
  ProfileEntry,
  DexJsonShape,
} from "../core/agent-profile.js";

interface CheckpointsApi {
  listTimeline(projectDir: string): Promise<TimelineSnapshot>;
  checkIsRepo(projectDir: string): Promise<boolean>;
  checkIdentity(projectDir: string): Promise<{
    name: string | null;
    email: string | null;
    suggestedName: string;
    suggestedEmail: string;
  }>;
  deleteBranch(
    projectDir: string,
    branchName: string,
    opts?: { confirmedLoss?: boolean },
  ): Promise<DeleteBranchResult | { ok: false; error: "locked_by_other_instance" }>;
  promoteSummary(projectDir: string, sourceBranch: string): Promise<PromoteSummary>;
  mergeToMain(
    projectDir: string,
    sourceBranch: string,
    opts?: { force?: "save" | "discard" },
  ): Promise<MergeToMainResult | { ok: false; error: "locked_by_other_instance" }>;
  acceptResolverResult(
    projectDir: string,
  ): Promise<
    | { ok: true; mergeSha: string }
    | { ok: false; error: string }
    | { ok: false; error: "locked_by_other_instance" }
  >;
  abortResolverMerge(
    projectDir: string,
  ): Promise<
    | { ok: true }
    | { ok: false; error: string }
    | { ok: false; error: "locked_by_other_instance" }
  >;
  openInEditor(
    projectDir: string,
    files: string[],
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  syncStateFromHead(projectDir: string): Promise<
    | { ok: true; updated: boolean; step?: string; cycle?: number }
    | { ok: false; error: string }
    | { ok: false; error: "locked_by_other_instance" }
  >;
  jumpTo(
    projectDir: string,
    targetSha: string,
    options?: { force?: "save" | "discard" },
  ): Promise<JumpToResult | { ok: false; error: "locked_by_other_instance" }>;
  initRepo(projectDir: string): Promise<{ ok: true } | { ok: false; error: string }>;
  setIdentity(projectDir: string, name: string, email: string): Promise<
    { ok: true } | { ok: false; error: string }
  >;
}

export interface DexAPI {
  // Project
  openProject(): Promise<string | null>;
  listSpecs(dir: string): Promise<string[]>;
  parseSpec(dir: string, spec: string): Promise<TaskPhase[]>;
  readFile(filePath: string): Promise<string | null>;
  writeFile(filePath: string, content: string): Promise<boolean>;
  pickFolder(): Promise<string | null>;
  createProject(parentDir: string, name: string): Promise<{ path: string } | { error: string }>;
  openProjectPath(projectPath: string): Promise<{ path: string } | { error: string }>;
  pathExists(targetPath: string): Promise<boolean>;

  // App config (global ~/.dex/app-config.json)
  getWelcomeDefaults(): Promise<{ defaultLocation: string; defaultName: string }>;

  // Orchestrator
  getProjectState(dir: string): Promise<DexState | null>;
  startRun(config: RunConfig): Promise<void>;
  stopRun(): Promise<void>;
  answerQuestion(requestId: string, answers: Record<string, string>): Promise<void>;
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
  getAgentRunSubagents(projectDir: string, runId: string, agentRunId: string): Promise<SubagentRecord[]>;
  getLatestAgentRun(projectDir: string, specDir: string, taskPhaseNumber: number): Promise<AgentRunRecord | null>;
  getSpecAgentRuns(projectDir: string, specDir: string): Promise<AgentRunRecord[]>;
  getSpecAggregateStats(projectDir: string, specDir: string): Promise<SpecStats>;

  // Checkpoints (008)
  checkpoints: CheckpointsApi;

  // Agent profiles (010 — US4)
  profiles: {
    list(projectDir: string): Promise<ProfileEntry[]>;
    saveDexJson(projectDir: string, name: string, dexJson: DexJsonShape): Promise<
      | { ok: true }
      | { ok: false; error: string }
      | { ok: false; error: "locked_by_other_instance" }
    >;
  };

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

export {};
