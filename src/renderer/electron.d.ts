import type { OrchestratorEvent, Phase, RunConfig, LoopStageType, LoopTermination, UserInputQuestion, DriftSummary } from "../core/types.js";
import type { DexState } from "../core/state.js";
import type {
  RunRow,
  PhaseTraceRow,
  TraceStepRow,
  SubagentRow,
  LoopCycleRow,
  SpecStats,
} from "../core/database.js";

interface DexAPI {
  // Project
  openProject(): Promise<string | null>;
  listSpecs(dir: string): Promise<string[]>;
  parseSpec(dir: string, spec: string): Promise<Phase[]>;
  readFile(filePath: string): Promise<string | null>;
  writeFile(filePath: string, content: string): Promise<boolean>;
  pickFolder(): Promise<string | null>;
  createProject(parentDir: string, name: string): Promise<{ path: string } | { error: string }>;

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

  // History
  listRuns(limit?: number): Promise<RunRow[]>;
  getRun(runId: string): Promise<{ run: RunRow; phases: PhaseTraceRow[] } | null>;
  getLatestProjectRun(projectDir: string): Promise<{ run: RunRow; phases: PhaseTraceRow[]; loopCycles: LoopCycleRow[] } | null>;
  getPhaseSteps(phaseTraceId: string): Promise<TraceStepRow[]>;
  getPhaseSubagents(phaseTraceId: string): Promise<SubagentRow[]>;
  getLatestPhaseTrace(projectDir: string, specDir: string, phaseNumber: number): Promise<PhaseTraceRow | null>;
  getSpecPhaseStats(projectDir: string, specDir: string): Promise<PhaseTraceRow[]>;
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
