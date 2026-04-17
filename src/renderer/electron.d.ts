import type { OrchestratorEvent, Phase, RunConfig, LoopStageType, LoopTermination, UserInputQuestion, DriftSummary } from "../core/types.js";
import type { DexState } from "../core/state.js";
import type {
  RunRecord,
  PhaseRecord,
  StepRecord,
  SubagentRecord,
  SpecStats,
} from "../core/runs.js";

interface DexAPI {
  // Project
  openProject(): Promise<string | null>;
  listSpecs(dir: string): Promise<string[]>;
  parseSpec(dir: string, spec: string): Promise<Phase[]>;
  readFile(filePath: string): Promise<string | null>;
  writeFile(filePath: string, content: string): Promise<boolean>;
  pickFolder(): Promise<string | null>;
  createProject(parentDir: string, name: string): Promise<{ path: string } | { error: string }>;
  openProjectPath(projectPath: string): Promise<{ path: string } | { error: string }>;
  pathExists(targetPath: string): Promise<boolean>;

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
    phaseTraceId: string;
    phaseNumber: number;
    phaseName: string;
    currentCycle?: number;
    currentStage?: string;
    isClarifying?: boolean;
    loopsCompleted?: number;
  } | null>;

  // Orchestrator events
  onOrchestratorEvent(cb: (event: OrchestratorEvent) => void): () => void;

  // History — per-project JSON storage (007-sqlite-removal)
  listRuns(projectDir: string, limit?: number): Promise<RunRecord[]>;
  getRun(projectDir: string, runId: string): Promise<RunRecord | null>;
  getLatestProjectRun(projectDir: string): Promise<RunRecord | null>;
  getPhaseSteps(projectDir: string, runId: string, phaseTraceId: string): Promise<StepRecord[]>;
  getPhaseSubagents(projectDir: string, runId: string, phaseTraceId: string): Promise<SubagentRecord[]>;
  getLatestPhaseTrace(projectDir: string, specDir: string, phaseNumber: number): Promise<PhaseRecord | null>;
  getSpecPhaseStats(projectDir: string, specDir: string): Promise<PhaseRecord[]>;
  getSpecAggregateStats(projectDir: string, specDir: string): Promise<SpecStats>;

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
