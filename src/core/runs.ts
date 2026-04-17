import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { LOGS_ROOT } from "./paths.js";
import type { LoopStageType, AgentStep } from "./types.js";

// ── Types ──

export type RunMode = "loop" | "build" | "plan";
export type RunStatus = "running" | "completed" | "paused" | "failed" | "stopped" | "crashed";
export type PhaseStatus = "running" | "completed" | "failed" | "stopped" | "crashed";
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

export interface PhaseRecord {
  phaseTraceId: string;
  runId: string;
  specDir: string | null;
  phaseNumber: number;
  phaseName: string;
  stage: LoopStageType | null;
  cycleNumber: number | null;
  featureSlug: string | null;
  startedAt: string;
  endedAt: string | null;
  status: PhaseStatus;
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
  phasesCompleted: number;
  writerPid: number;
  description: string | null;
  fullPlanPath: string | null;
  maxLoopCycles: number | null;
  maxBudgetUsd: number | null;
  loopsCompleted: number;
  phases: PhaseRecord[];
  failureCounters: Record<string, { impl: number; replan: number }>;
}

export type StepRecord = AgentStep & { phaseTraceId: string };

export interface SpecStats {
  totalCostUsd: number;
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  phasesWithTraces: number;
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
  return JSON.parse(fs.readFileSync(p, "utf8")) as RunRecord;
}

export function listRuns(projectDir: string, limit = 50): RunRecord[] {
  const dir = runsDir(projectDir);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const out: RunRecord[] = [];
  for (const f of files) {
    try {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      out.push(JSON.parse(text) as RunRecord);
    } catch (e) {
      console.warn(`runs.ts listRuns: skipping malformed file ${f}: ${(e as Error).message}`);
    }
  }
  out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return out.slice(0, limit);
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
    phasesCompleted: 0,
    writerPid: input.writerPid,
    description: input.description ?? null,
    fullPlanPath: input.fullPlanPath ?? null,
    maxLoopCycles: input.maxLoopCycles ?? null,
    maxBudgetUsd: input.maxBudgetUsd ?? null,
    loopsCompleted: 0,
    phases: [],
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
  phasesCompleted: number,
): void {
  updateRun(projectDir, runId, (r) => {
    r.status = status;
    r.totalCostUsd = totalCostUsd;
    r.totalDurationMs = totalDurationMs;
    r.phasesCompleted = phasesCompleted;
    r.endedAt = new Date().toISOString();
  });
}

export function updateRunLoopsCompleted(
  projectDir: string,
  runId: string,
  loopsCompleted: number,
): void {
  updateRun(projectDir, runId, (r) => {
    r.loopsCompleted = loopsCompleted;
  });
}

// ── Phase helpers ──

export interface StartPhaseInput {
  phaseTraceId: string;
  runId: string;
  specDir: string | null;
  phaseNumber: number;
  phaseName: string;
  stage: LoopStageType | null;
  cycleNumber: number | null;
  featureSlug: string | null;
  startedAt: string;
  status: PhaseStatus;
}

export function startPhase(projectDir: string, runId: string, phase: StartPhaseInput): void {
  updateRun(projectDir, runId, (r) => {
    r.phases.push({
      ...phase,
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

export function completePhase(
  projectDir: string,
  runId: string,
  phaseTraceId: string,
  patch: Partial<PhaseRecord> & { status: PhaseStatus },
): void {
  updateRun(projectDir, runId, (r) => {
    const ph = r.phases.find((p) => p.phaseTraceId === phaseTraceId);
    if (!ph) {
      console.warn(`runs.ts completePhase: no phase ${phaseTraceId} in run ${runId}`);
      return;
    }
    Object.assign(ph, patch);
    if (!ph.endedAt) ph.endedAt = new Date().toISOString();
    if (ph.durationMs == null && ph.startedAt && ph.endedAt) {
      ph.durationMs = new Date(ph.endedAt).getTime() - new Date(ph.startedAt).getTime();
    }
    r.totalCostUsd = r.phases
      .filter((p) => p.status === "completed" || p.status === "failed")
      .reduce((s, p) => s + p.costUsd, 0);
    r.phasesCompleted = r.phases.filter((p) => p.status === "completed").length;
  });
}

// ── Subagent helpers ──

export function recordSubagent(
  projectDir: string,
  runId: string,
  phaseTraceId: string,
  sub: SubagentRecord,
): void {
  updateRun(projectDir, runId, (r) => {
    const ph = r.phases.find((p) => p.phaseTraceId === phaseTraceId);
    if (!ph) {
      console.warn(`runs.ts recordSubagent: no phase ${phaseTraceId} in run ${runId}`);
      return;
    }
    const existing = ph.subagents.find((s) => s.id === sub.id);
    if (existing) Object.assign(existing, sub);
    else ph.subagents.push(sub);
  });
}

/**
 * Mark a subagent terminal. Looks up the subagent by id across all phases of
 * the run and patches its status/endedAt/durationMs. Mirrors the legacy
 * SQLite `completeSubagent(subagentId)` which had no phaseTraceId param.
 */
export function completeSubagent(
  projectDir: string,
  runId: string,
  subagentId: string,
  status: SubagentStatus = "ok",
): void {
  updateRun(projectDir, runId, (r) => {
    const now = new Date().toISOString();
    for (const ph of r.phases) {
      const sub = ph.subagents.find((s) => s.id === subagentId);
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
    for (const ph of r.phases) {
      if (ph.status === "running") {
        ph.status = "crashed";
        ph.endedAt = now;
        for (const s of ph.subagents) {
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

// ── Steps helpers (steps.jsonl) ──

export function phaseLogDir(
  projectDir: string,
  runId: string,
  phaseSlug: string,
  phaseNumber: number,
): string {
  const projectName = path.basename(projectDir);
  return path.join(LOGS_ROOT, projectName, runId, `phase-${phaseNumber}_${phaseSlug}`);
}

export function appendStep(
  projectDir: string,
  runId: string,
  phaseSlug: string,
  phaseNumber: number,
  step: StepRecord,
): void {
  const dir = phaseLogDir(projectDir, runId, phaseSlug, phaseNumber);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "steps.jsonl"), JSON.stringify(step) + "\n");
}

export function readSteps(
  projectDir: string,
  runId: string,
  phaseSlug: string,
  phaseNumber: number,
): StepRecord[] {
  const file = path.join(phaseLogDir(projectDir, runId, phaseSlug, phaseNumber), "steps.jsonl");
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  const out: StepRecord[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      out.push(JSON.parse(line) as StepRecord);
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
  stages: string[];
}

export function cycleSummary(run: RunRecord): CycleSummaryRow[] {
  const byCycle = new Map<number, PhaseRecord[]>();
  for (const p of run.phases) {
    if (p.cycleNumber == null) continue;
    const list = byCycle.get(p.cycleNumber) ?? [];
    list.push(p);
    byCycle.set(p.cycleNumber, list);
  }
  return [...byCycle.entries()]
    .sort(([a], [b]) => a - b)
    .map(([cycleNumber, phases]) => ({
      cycleNumber,
      costUsd: phases.reduce((s, p) => s + p.costUsd, 0),
      durationMs: phases.reduce((s, p) => s + (p.durationMs ?? 0), 0),
      stages: phases.map((p) => p.stage ?? p.phaseName),
    }));
}

export function latestPhasesForSpec(projectRuns: RunRecord[], specDir: string): PhaseRecord[] {
  const latest = new Map<number, PhaseRecord>();
  for (const run of projectRuns) {
    for (const phase of run.phases) {
      if (phase.specDir !== specDir && phase.specDir !== null) continue;
      const existing = latest.get(phase.phaseNumber);
      if (!existing || existing.startedAt < phase.startedAt) {
        latest.set(phase.phaseNumber, phase);
      }
    }
  }
  return [...latest.values()].sort((a, b) => a.phaseNumber - b.phaseNumber);
}

export function getSpecAggregateStats(projectRuns: RunRecord[], specDir: string): SpecStats {
  const phases = latestPhasesForSpec(projectRuns, specDir);
  let totalCostUsd = 0;
  let totalDurationMs = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  for (const p of phases) {
    totalCostUsd += p.costUsd;
    totalDurationMs += p.durationMs ?? 0;
    totalInputTokens += p.inputTokens ?? 0;
    totalOutputTokens += p.outputTokens ?? 0;
  }
  return {
    totalCostUsd,
    totalDurationMs,
    totalInputTokens,
    totalOutputTokens,
    phasesWithTraces: phases.length,
  };
}

// ── Utilities ──

export const newRunId = (): string => crypto.randomUUID();

export function slugForPhaseName(phaseName: string): string {
  return phaseName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
