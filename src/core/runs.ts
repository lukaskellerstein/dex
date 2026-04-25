import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { LOGS_ROOT } from "./paths.js";
import type { StepType, AgentStep } from "./types.js";

// ── Types ──

export type RunMode = "loop" | "build" | "plan";
export type RunStatus = "running" | "completed" | "paused" | "failed" | "stopped" | "crashed";
export type AgentRunStatus = "running" | "completed" | "failed" | "stopped" | "crashed";
export type SubagentStatus = "running" | "ok" | "failed" | "crashed";

export interface SubagentRecord {
  id: string;
  type: string;
  description: string | null;
  status: SubagentStatus;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  costUsd: number;
}

export interface AgentRunRecord {
  agentRunId: string;
  runId: string;
  specDir: string | null;
  taskPhaseNumber: number;
  taskPhaseName: string;
  step: StepType | null;
  cycleNumber: number | null;
  featureSlug: string | null;
  startedAt: string;
  endedAt: string | null;
  status: AgentRunStatus;
  costUsd: number;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  subagents: SubagentRecord[];
  checkpointTag: string | null;
  candidateSha: string | null;
}

export interface RunRecord {
  runId: string;
  mode: RunMode;
  model: string;
  specDir: string;
  startedAt: string;
  endedAt: string | null;
  status: RunStatus;
  totalCostUsd: number;
  totalDurationMs: number | null;
  taskPhasesCompleted: number;
  writerPid: number;
  description: string | null;
  fullPlanPath: string | null;
  maxLoopCycles: number | null;
  maxBudgetUsd: number | null;
  cyclesCompleted: number;
  agentRuns: AgentRunRecord[];
  failureCounters: Record<string, { impl: number; replan: number }>;
}

export type AgentStepRecord = AgentStep & { agentRunId: string };

export interface SpecStats {
  totalCostUsd: number;
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  agentRunsWithTraces: number;
}

// ── Directory helpers ──

export function runsDir(projectDir: string): string {
  return path.join(projectDir, ".dex", "runs");
}

export function ensureRunsDir(projectDir: string): void {
  fs.mkdirSync(runsDir(projectDir), { recursive: true });
}

// ── Low-level I/O ──

export function writeRun(projectDir: string, run: RunRecord): void {
  if (!run.runId || run.runId.includes("/") || run.runId.includes("\\")) {
    throw new Error(`writeRun: invalid runId ${JSON.stringify(run.runId)}`);
  }
  ensureRunsDir(projectDir);
  const target = path.join(runsDir(projectDir), `${run.runId}.json`);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(run, null, 2) + "\n");
  fs.renameSync(tmp, target);
}

export function readRun(projectDir: string, runId: string): RunRecord | null {
  const p = path.join(runsDir(projectDir), `${runId}.json`);
  if (!fs.existsSync(p)) return null;
  return migrateLegacyRun(JSON.parse(fs.readFileSync(p, "utf8")));
}

export function listRuns(projectDir: string, limit = 50): RunRecord[] {
  const dir = runsDir(projectDir);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const out: RunRecord[] = [];
  for (const f of files) {
    try {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      out.push(migrateLegacyRun(JSON.parse(text)));
    } catch (e) {
      console.warn(`runs.ts listRuns: skipping malformed file ${f}: ${(e as Error).message}`);
    }
  }
  out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return out.slice(0, limit);
}

// Migrate pre-rename JSON shape (phases[]/phaseTraceId/loopsCompleted/phasesCompleted)
// to current shape (agentRuns[]/agentRunId/cyclesCompleted/taskPhasesCompleted).
// Mutates and returns the input record.
function migrateLegacyRun(raw: Record<string, unknown>): RunRecord {
  if (Array.isArray((raw as { phases?: unknown }).phases) && !(raw as { agentRuns?: unknown }).agentRuns) {
    const legacyPhases = (raw as { phases: Array<Record<string, unknown>> }).phases;
    (raw as { agentRuns: Record<string, unknown>[] }).agentRuns = legacyPhases.map((p) => {
      const out: Record<string, unknown> = { ...p };
      if (out.phaseTraceId !== undefined) {
        out.agentRunId = out.phaseTraceId;
        delete out.phaseTraceId;
      }
      if (out.phaseNumber !== undefined) {
        out.taskPhaseNumber = out.phaseNumber;
        delete out.phaseNumber;
      }
      if (out.phaseName !== undefined) {
        out.taskPhaseName = out.phaseName;
        delete out.phaseName;
      }
      if (out.stage !== undefined) {
        out.step = out.stage;
        delete out.stage;
      }
      return out;
    });
    delete (raw as { phases?: unknown }).phases;
  }
  if ((raw as { loopsCompleted?: unknown }).loopsCompleted !== undefined && (raw as { cyclesCompleted?: unknown }).cyclesCompleted === undefined) {
    (raw as { cyclesCompleted: unknown }).cyclesCompleted = (raw as { loopsCompleted: unknown }).loopsCompleted;
    delete (raw as { loopsCompleted?: unknown }).loopsCompleted;
  }
  if ((raw as { phasesCompleted?: unknown }).phasesCompleted !== undefined && (raw as { taskPhasesCompleted?: unknown }).taskPhasesCompleted === undefined) {
    (raw as { taskPhasesCompleted: unknown }).taskPhasesCompleted = (raw as { phasesCompleted: unknown }).phasesCompleted;
    delete (raw as { phasesCompleted?: unknown }).phasesCompleted;
  }
  return raw as unknown as RunRecord;
}

// ── Mutation helpers ──

export function updateRun(
  projectDir: string,
  runId: string,
  mutator: (r: RunRecord) => void,
): RunRecord {
  const run = readRun(projectDir, runId);
  if (!run) throw new Error(`updateRun: run ${runId} not found in ${projectDir}`);
  mutator(run);
  writeRun(projectDir, run);
  return run;
}

export interface StartRunInput {
  runId: string;
  mode: RunMode;
  model: string;
  specDir: string;
  startedAt: string;
  status: RunStatus;
  writerPid: number;
  description?: string | null;
  fullPlanPath?: string | null;
  maxLoopCycles?: number | null;
  maxBudgetUsd?: number | null;
}

export function startRun(projectDir: string, input: StartRunInput): RunRecord {
  const run: RunRecord = {
    runId: input.runId,
    mode: input.mode,
    model: input.model,
    specDir: input.specDir,
    startedAt: input.startedAt,
    endedAt: null,
    status: input.status,
    totalCostUsd: 0,
    totalDurationMs: null,
    taskPhasesCompleted: 0,
    writerPid: input.writerPid,
    description: input.description ?? null,
    fullPlanPath: input.fullPlanPath ?? null,
    maxLoopCycles: input.maxLoopCycles ?? null,
    maxBudgetUsd: input.maxBudgetUsd ?? null,
    cyclesCompleted: 0,
    agentRuns: [],
    failureCounters: {},
  };
  writeRun(projectDir, run);
  return run;
}

export function completeRun(
  projectDir: string,
  runId: string,
  status: RunStatus,
  totalCostUsd: number,
  totalDurationMs: number,
  taskPhasesCompleted: number,
): void {
  updateRun(projectDir, runId, (r) => {
    r.status = status;
    r.totalCostUsd = totalCostUsd;
    r.totalDurationMs = totalDurationMs;
    r.taskPhasesCompleted = taskPhasesCompleted;
    r.endedAt = new Date().toISOString();
  });
}

export function updateRunCyclesCompleted(
  projectDir: string,
  runId: string,
  cyclesCompleted: number,
): void {
  updateRun(projectDir, runId, (r) => {
    r.cyclesCompleted = cyclesCompleted;
  });
}

// ── AgentRun helpers ──

export interface StartAgentRunInput {
  agentRunId: string;
  runId: string;
  specDir: string | null;
  taskPhaseNumber: number;
  taskPhaseName: string;
  step: StepType | null;
  cycleNumber: number | null;
  featureSlug: string | null;
  startedAt: string;
  status: AgentRunStatus;
}

export function startAgentRun(projectDir: string, runId: string, agentRun: StartAgentRunInput): void {
  updateRun(projectDir, runId, (r) => {
    r.agentRuns.push({
      ...agentRun,
      endedAt: null,
      costUsd: 0,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      subagents: [],
      checkpointTag: null,
      candidateSha: null,
    });
  });
}

export function completeAgentRun(
  projectDir: string,
  runId: string,
  agentRunId: string,
  patch: Partial<AgentRunRecord> & { status: AgentRunStatus },
): void {
  updateRun(projectDir, runId, (r) => {
    const ar = r.agentRuns.find((a) => a.agentRunId === agentRunId);
    if (!ar) {
      console.warn(`runs.ts completeAgentRun: no agentRun ${agentRunId} in run ${runId}`);
      return;
    }
    Object.assign(ar, patch);
    if (!ar.endedAt) ar.endedAt = new Date().toISOString();
    if (ar.durationMs == null && ar.startedAt && ar.endedAt) {
      ar.durationMs = new Date(ar.endedAt).getTime() - new Date(ar.startedAt).getTime();
    }
    r.totalCostUsd = r.agentRuns
      .filter((a) => a.status === "completed" || a.status === "failed")
      .reduce((s, a) => s + a.costUsd, 0);
    r.taskPhasesCompleted = r.agentRuns.filter((a) => a.status === "completed").length;
  });
}

// ── Subagent helpers ──

export function recordSubagent(
  projectDir: string,
  runId: string,
  agentRunId: string,
  sub: SubagentRecord,
): void {
  updateRun(projectDir, runId, (r) => {
    const ar = r.agentRuns.find((a) => a.agentRunId === agentRunId);
    if (!ar) {
      console.warn(`runs.ts recordSubagent: no agentRun ${agentRunId} in run ${runId}`);
      return;
    }
    const existing = ar.subagents.find((s) => s.id === sub.id);
    if (existing) Object.assign(existing, sub);
    else ar.subagents.push(sub);
  });
}

/**
 * Mark a subagent terminal. Looks up the subagent by id across all agent runs
 * of the run and patches its status/endedAt/durationMs.
 */
export function completeSubagent(
  projectDir: string,
  runId: string,
  subagentId: string,
  status: SubagentStatus = "ok",
): void {
  updateRun(projectDir, runId, (r) => {
    const now = new Date().toISOString();
    for (const ar of r.agentRuns) {
      const sub = ar.subagents.find((s) => s.id === subagentId);
      if (!sub || sub.endedAt !== null) continue;
      sub.status = status;
      sub.endedAt = now;
      sub.durationMs = new Date(now).getTime() - new Date(sub.startedAt).getTime();
      return;
    }
  });
}

// ── Failure-counter helpers ──

export function getFailureCount(
  projectDir: string,
  runId: string,
  specDir: string,
): { impl: number; replan: number } {
  const r = readRun(projectDir, runId);
  if (!r) return { impl: 0, replan: 0 };
  return r.failureCounters[specDir] ?? { impl: 0, replan: 0 };
}

export function upsertFailureCount(
  projectDir: string,
  runId: string,
  specDir: string,
  impl: number,
  replan: number,
): void {
  updateRun(projectDir, runId, (r) => {
    r.failureCounters[specDir] = { impl, replan };
  });
}

export function resetFailureCount(projectDir: string, runId: string, specDir: string): void {
  upsertFailureCount(projectDir, runId, specDir, 0, 0);
}

// ── Crash-recovery sweep ──

export function reconcileCrashedRuns(
  projectDir: string,
  aliveCheck: (pid: number) => boolean = isAlive,
): void {
  const dir = runsDir(projectDir);
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const now = new Date().toISOString();
  for (const f of files) {
    let r: RunRecord;
    try {
      r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as RunRecord;
    } catch {
      continue;
    }
    if (r.status !== "running") continue;
    if (aliveCheck(r.writerPid)) continue;
    r.status = "crashed";
    r.endedAt = now;
    for (const ar of r.agentRuns) {
      if (ar.status === "running") {
        ar.status = "crashed";
        ar.endedAt = now;
        for (const s of ar.subagents) {
          if (s.status === "running") {
            s.status = "crashed";
            s.endedAt = now;
          }
        }
      }
    }
    writeRun(projectDir, r);
  }
}

function isAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // ESRCH = no such process. EPERM = exists but not ours (treat as alive).
    return code === "EPERM";
  }
}

// ── Agent step helpers (steps.jsonl) ──
//
// On-disk path is still `phase-<N>_<slug>` for backward compatibility with
// existing log trees. Renaming the directory layout is deferred to a follow-up
// (see plan: ~/.claude/plans/what-is-the-wording-wobbly-avalanche.md).

export function agentRunLogDir(
  projectDir: string,
  runId: string,
  taskPhaseSlug: string,
  taskPhaseNumber: number,
): string {
  const projectName = path.basename(projectDir);
  return path.join(LOGS_ROOT, projectName, runId, `phase-${taskPhaseNumber}_${taskPhaseSlug}`);
}

export function appendAgentStep(
  projectDir: string,
  runId: string,
  taskPhaseSlug: string,
  taskPhaseNumber: number,
  agentStep: AgentStepRecord,
): void {
  const dir = agentRunLogDir(projectDir, runId, taskPhaseSlug, taskPhaseNumber);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "steps.jsonl"), JSON.stringify(agentStep) + "\n");
}

export function readAgentSteps(
  projectDir: string,
  runId: string,
  taskPhaseSlug: string,
  taskPhaseNumber: number,
): AgentStepRecord[] {
  const file = path.join(agentRunLogDir(projectDir, runId, taskPhaseSlug, taskPhaseNumber), "steps.jsonl");
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  const out: AgentStepRecord[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      // Migrate legacy phaseTraceId field from older JSONL files
      if (parsed.phaseTraceId !== undefined && parsed.agentRunId === undefined) {
        parsed.agentRunId = parsed.phaseTraceId;
        delete parsed.phaseTraceId;
      }
      out.push(parsed as unknown as AgentStepRecord);
    } catch {
      console.warn(`steps.jsonl: skipping malformed line in ${file}`);
    }
  }
  return out;
}

// ── Derived views ──

export interface CycleSummaryRow {
  cycleNumber: number;
  costUsd: number;
  durationMs: number;
  steps: string[];
}

export function cycleSummary(run: RunRecord): CycleSummaryRow[] {
  const byCycle = new Map<number, AgentRunRecord[]>();
  for (const ar of run.agentRuns) {
    if (ar.cycleNumber == null) continue;
    const list = byCycle.get(ar.cycleNumber) ?? [];
    list.push(ar);
    byCycle.set(ar.cycleNumber, list);
  }
  return [...byCycle.entries()]
    .sort(([a], [b]) => a - b)
    .map(([cycleNumber, agentRuns]) => ({
      cycleNumber,
      costUsd: agentRuns.reduce((s, a) => s + a.costUsd, 0),
      durationMs: agentRuns.reduce((s, a) => s + (a.durationMs ?? 0), 0),
      steps: agentRuns.map((a) => a.step ?? a.taskPhaseName),
    }));
}

export function latestAgentRunsForSpec(projectRuns: RunRecord[], specDir: string): AgentRunRecord[] {
  const latest = new Map<number, AgentRunRecord>();
  for (const run of projectRuns) {
    for (const ar of run.agentRuns) {
      if (ar.specDir !== specDir && ar.specDir !== null) continue;
      const existing = latest.get(ar.taskPhaseNumber);
      if (!existing || existing.startedAt < ar.startedAt) {
        latest.set(ar.taskPhaseNumber, ar);
      }
    }
  }
  return [...latest.values()].sort((a, b) => a.taskPhaseNumber - b.taskPhaseNumber);
}

export function getSpecAggregateStats(projectRuns: RunRecord[], specDir: string): SpecStats {
  const agentRuns = latestAgentRunsForSpec(projectRuns, specDir);
  let totalCostUsd = 0;
  let totalDurationMs = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  for (const ar of agentRuns) {
    totalCostUsd += ar.costUsd;
    totalDurationMs += ar.durationMs ?? 0;
    totalInputTokens += ar.inputTokens ?? 0;
    totalOutputTokens += ar.outputTokens ?? 0;
  }
  return {
    totalCostUsd,
    totalDurationMs,
    totalInputTokens,
    totalOutputTokens,
    agentRunsWithTraces: agentRuns.length,
  };
}

// ── Utilities ──

export const newRunId = (): string => crypto.randomUUID();

export function slugForTaskPhaseName(taskPhaseName: string): string {
  return taskPhaseName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
