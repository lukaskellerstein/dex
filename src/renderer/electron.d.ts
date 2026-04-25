import type { OrchestratorEvent, TaskPhase, RunConfig, StepType, LoopTermination, UserInputQuestion, DriftSummary } from "../core/types.js";
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
  VariantGroupFile,
  VariantSpawnRequest,
  VariantSpawnResult,
} from "../core/checkpoints.js";

interface CheckpointsApi {
  listTimeline(projectDir: string): Promise<TimelineSnapshot>;
  isLockedByAnother(projectDir: string): Promise<boolean>;
  checkIsRepo(projectDir: string): Promise<boolean>;
  checkIdentity(projectDir: string): Promise<{
    name: string | null;
    email: string | null;
    suggestedName: string;
    suggestedEmail: string;
  }>;
  estimateVariantCost(
    projectDir: string,
    step: StepType,
    variantCount: number,
  ): Promise<{
    perVariantMedian: number | null;
    perVariantP75: number | null;
    totalMedian: number | null;
    totalP75: number | null;
    sampleSize: number;
  }>;
  readPendingVariantGroups(projectDir: string): Promise<VariantGroupFile[]>;
  promote(projectDir: string, tag: string, sha: string): Promise<
    | { ok: true }
    | { ok: false; error: string }
  >;
  goBack(projectDir: string, tag: string, options?: { force?: "save" | "discard" }): Promise<
    | { ok: true; branch: string }
    | { ok: false; error: "dirty_working_tree"; files: string[] }
    | { ok: false; error: "save_failed"; detail: string }
    | { ok: false; error: "locked_by_other_instance" }
    | { ok: false; error: string }
  >;
  spawnVariants(
    projectDir: string,
    request: VariantSpawnRequest,
  ): Promise<
    | { ok: true; result: VariantSpawnResult }
    | { ok: false; error: string }
  >;
  deleteAttempt(projectDir: string, branch: string): Promise<
    { ok: true } | { ok: false; error: string }
  >;
  writeVariantGroup(projectDir: string, group: VariantGroupFile): Promise<
    { ok: true } | { ok: false; error: string }
  >;
  cleanupVariantGroup(
    projectDir: string,
    groupId: string,
    kind: "keep" | "discard",
    pickedLetter?: string,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  initRepo(projectDir: string): Promise<{ ok: true } | { ok: false; error: string }>;
  setIdentity(projectDir: string, name: string, email: string): Promise<
    { ok: true } | { ok: false; error: string }
  >;
  setRecordMode(projectDir: string, on: boolean): Promise<{ ok: true }>;
  setPauseAfterStage(projectDir: string, on: boolean): Promise<{ ok: true }>;
  compareAttempts(
    projectDir: string,
    branchA: string,
    branchB: string,
    step: StepType | null,
  ): Promise<
    | { ok: true; diff: string; mode: "path-filtered" | "stat"; paths?: string[] }
    | { ok: false; error: string }
  >;
}

interface DexAPI {
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
  isRunning(): Promise<boolean>;
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
  listRuns(projectDir: string, limit?: number): Promise<RunRecord[]>;
  getRun(projectDir: string, runId: string): Promise<RunRecord | null>;
  getLatestProjectRun(projectDir: string): Promise<RunRecord | null>;
  getAgentSteps(projectDir: string, runId: string, agentRunId: string): Promise<AgentStepRecord[]>;
  getAgentRunSubagents(projectDir: string, runId: string, agentRunId: string): Promise<SubagentRecord[]>;
  getLatestAgentRun(projectDir: string, specDir: string, taskPhaseNumber: number): Promise<AgentRunRecord | null>;
  getSpecAgentRuns(projectDir: string, specDir: string): Promise<AgentRunRecord[]>;
  getSpecAggregateStats(projectDir: string, specDir: string): Promise<SpecStats>;

  // Checkpoints (008)
  checkpoints: CheckpointsApi;

  // Window controls
  minimize(): Promise<void>;
  maximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  onMaximizedChange(cb: (maximized: boolean) => void): () => void;
}

declare global {
  interface Window {
    dexAPI: DexAPI;
  }
}

export {};
