import crypto from "node:crypto";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { DB_DIR, DB_PATH, DEX_HOME, migrateIfNeeded } from "./paths.js";

let db: Database.Database | null = null;

export function initDatabase(): void {
  if (db) return;
  fs.mkdirSync(DB_DIR, { recursive: true });
  for (const name of ["data.db", "data.db-wal", "data.db-shm"]) {
    migrateIfNeeded(path.join(DEX_HOME, name), path.join(DB_DIR, name));
  }
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      project_dir TEXT NOT NULL,
      spec_dir TEXT NOT NULL,
      mode TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT DEFAULT 'running',
      total_cost_usd REAL,
      total_duration_ms INTEGER,
      phases_completed INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS phase_traces (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      spec_dir TEXT,
      phase_number INTEGER NOT NULL,
      phase_name TEXT NOT NULL,
      status TEXT DEFAULT 'running',
      cost_usd REAL,
      duration_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS trace_steps (
      id TEXT PRIMARY KEY,
      phase_trace_id TEXT NOT NULL,
      sequence_index INTEGER NOT NULL,
      type TEXT NOT NULL,
      content TEXT,
      metadata TEXT,
      duration_ms INTEGER,
      token_count INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY (phase_trace_id) REFERENCES phase_traces(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_trace_steps_phase
      ON trace_steps(phase_trace_id, sequence_index);

    CREATE TABLE IF NOT EXISTS subagent_metadata (
      id TEXT PRIMARY KEY,
      phase_trace_id TEXT NOT NULL,
      subagent_id TEXT NOT NULL,
      subagent_type TEXT NOT NULL,
      description TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (phase_trace_id) REFERENCES phase_traces(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_subagent_phase
      ON subagent_metadata(phase_trace_id);
  `);

  // Loop mode tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS loop_cycles (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      cycle_number INTEGER NOT NULL,
      feature_name TEXT,
      spec_dir TEXT,
      decision TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      cost_usd REAL DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_loop_cycles_run ON loop_cycles(run_id);

    CREATE TABLE IF NOT EXISTS failure_tracker (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      spec_dir TEXT NOT NULL,
      impl_failures INTEGER DEFAULT 0,
      replan_failures INTEGER DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_failure_tracker_run ON failure_tracker(run_id);
  `);

  // Add loop-mode columns to runs table (safe to run multiple times — SQLite ignores if exists)
  const addColumnSafe = (table: string, column: string, type: string) => {
    try {
      db!.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    } catch {
      // Column already exists
    }
  };

  addColumnSafe("runs", "description", "TEXT");
  addColumnSafe("runs", "full_plan_path", "TEXT");
  addColumnSafe("runs", "max_loop_cycles", "INTEGER");
  addColumnSafe("runs", "max_budget_usd", "REAL");
  addColumnSafe("runs", "loops_completed", "INTEGER DEFAULT 0");
  addColumnSafe("phase_traces", "loop_cycle_id", "TEXT");

  // Clean up orphaned "running" rows from prior crashes
  cleanupOrphanedRuns(db);
}

/**
 * Mark any "running" runs/phase_traces as "crashed" on startup.
 * If the process was killed, the `finally` block in `run()` never ran,
 * leaving stale rows that confuse the UI on next launch.
 */
function cleanupOrphanedRuns(database: Database.Database): void {
  const now = new Date().toISOString();
  database
    .prepare(`UPDATE phase_traces SET status = 'crashed', completed_at = ? WHERE status = 'running'`)
    .run(now);
  database
    .prepare(`UPDATE loop_cycles SET status = 'crashed', completed_at = ? WHERE status = 'running'`)
    .run(now);
  database
    .prepare(`UPDATE runs SET status = 'crashed', completed_at = ? WHERE status = 'running'`)
    .run(now);
}

function getDb(): Database.Database {
  if (!db) throw new Error("Database not initialized — call initDatabase() first");
  return db;
}

// ── Runs ──

export function createRun(run: {
  id: string;
  projectDir: string;
  specDir: string;
  mode: string;
  model: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO runs (id, project_dir, spec_dir, mode, model, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'running', ?)`
    )
    .run(run.id, run.projectDir, run.specDir, run.mode, run.model, new Date().toISOString());
}

export function completeRun(
  runId: string,
  status: string,
  totalCostUsd: number,
  totalDurationMs: number,
  phasesCompleted: number
): void {
  getDb()
    .prepare(
      `UPDATE runs SET status = ?, total_cost_usd = ?, total_duration_ms = ?,
       phases_completed = ?, completed_at = ? WHERE id = ?`
    )
    .run(status, totalCostUsd, totalDurationMs, phasesCompleted, new Date().toISOString(), runId);
}

// ── Phase Traces ──

export function createPhaseTrace(trace: {
  id: string;
  runId: string;
  specDir: string;
  phaseNumber: number;
  phaseName: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO phase_traces (id, run_id, spec_dir, phase_number, phase_name, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'running', ?)`
    )
    .run(trace.id, trace.runId, trace.specDir, trace.phaseNumber, trace.phaseName, new Date().toISOString());
}

export function completePhaseTrace(
  traceId: string,
  status: string,
  costUsd: number,
  durationMs: number,
  inputTokens?: number,
  outputTokens?: number
): void {
  getDb()
    .prepare(
      `UPDATE phase_traces SET status = ?, cost_usd = ?, duration_ms = ?,
       input_tokens = ?, output_tokens = ?, completed_at = ? WHERE id = ?`
    )
    .run(status, costUsd, durationMs, inputTokens ?? null, outputTokens ?? null, new Date().toISOString(), traceId);
}

// ── Steps ──

export function insertStep(step: {
  id: string;
  phaseTraceId: string;
  sequenceIndex: number;
  type: string;
  content: string | null;
  metadata: Record<string, unknown> | null;
  durationMs: number | null;
  tokenCount: number | null;
  createdAt: string;
}): void {
  const content = step.content ? step.content.slice(0, 10_000) : null;
  const metadata = step.metadata ? JSON.stringify(step.metadata) : null;
  getDb()
    .prepare(
      `INSERT INTO trace_steps (id, phase_trace_id, sequence_index, type, content, metadata, duration_ms, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(step.id, step.phaseTraceId, step.sequenceIndex, step.type, content, metadata, step.durationMs, step.tokenCount, step.createdAt);
}

// ── Subagents ──

export function insertSubagent(subagent: {
  id: string;
  phaseTraceId: string;
  subagentId: string;
  subagentType: string;
  description: string | null;
  startedAt: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO subagent_metadata (id, phase_trace_id, subagent_id, subagent_type, description, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(subagent.id, subagent.phaseTraceId, subagent.subagentId, subagent.subagentType, subagent.description, subagent.startedAt);
}

export function completeSubagent(subagentId: string): void {
  getDb()
    .prepare(
      `UPDATE subagent_metadata SET completed_at = ? WHERE subagent_id = ? AND completed_at IS NULL`
    )
    .run(new Date().toISOString(), subagentId);
}

// ── Loop Cycles ──

export function insertLoopCycle(cycle: {
  id: string;
  runId: string;
  cycleNumber: number;
  featureName: string | null;
  specDir: string | null;
  decision: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO loop_cycles (id, run_id, cycle_number, feature_name, spec_dir, decision, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`
    )
    .run(cycle.id, cycle.runId, cycle.cycleNumber, cycle.featureName, cycle.specDir, cycle.decision, new Date().toISOString());
}

export function updateLoopCycle(
  cycleId: string,
  status: string,
  costUsd: number,
  durationMs: number
): void {
  getDb()
    .prepare(
      `UPDATE loop_cycles SET status = ?, cost_usd = ?, duration_ms = ?, completed_at = ? WHERE id = ?`
    )
    .run(status, costUsd, durationMs, new Date().toISOString(), cycleId);
}

export interface LoopCycleRow {
  id: string;
  run_id: string;
  cycle_number: number;
  feature_name: string | null;
  spec_dir: string | null;
  decision: string;
  status: string;
  cost_usd: number | null;
  duration_ms: number | null;
  created_at: string;
  completed_at: string | null;
}

export function getLoopCycles(runId: string): LoopCycleRow[] {
  return getDb()
    .prepare(`SELECT * FROM loop_cycles WHERE run_id = ? ORDER BY cycle_number`)
    .all(runId) as LoopCycleRow[];
}

// ── Failure Tracker ──

export interface FailureTrackerRow {
  id: string;
  run_id: string;
  spec_dir: string;
  impl_failures: number;
  replan_failures: number;
  updated_at: string;
}

export function getFailureRecord(
  runId: string,
  specDir: string
): FailureTrackerRow | null {
  const row = getDb()
    .prepare(`SELECT * FROM failure_tracker WHERE run_id = ? AND spec_dir = ?`)
    .get(runId, specDir) as FailureTrackerRow | undefined;
  return row ?? null;
}

export function upsertFailureRecord(
  runId: string,
  specDir: string,
  implFailures: number,
  replanFailures: number
): void {
  const existing = getFailureRecord(runId, specDir);
  if (existing) {
    getDb()
      .prepare(
        `UPDATE failure_tracker SET impl_failures = ?, replan_failures = ?, updated_at = ? WHERE id = ?`
      )
      .run(implFailures, replanFailures, new Date().toISOString(), existing.id);
  } else {
    const id = crypto.randomUUID();
    getDb()
      .prepare(
        `INSERT INTO failure_tracker (id, run_id, spec_dir, impl_failures, replan_failures, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, runId, specDir, implFailures, replanFailures, new Date().toISOString());
  }
}

export function resetFailures(runId: string, specDir: string): void {
  upsertFailureRecord(runId, specDir, 0, 0);
}

// ── Loop Run Updates ──

export function updateRunLoopsCompleted(runId: string, loopsCompleted: number): void {
  getDb()
    .prepare(`UPDATE runs SET loops_completed = ? WHERE id = ?`)
    .run(loopsCompleted, runId);
}

// ── Queries (for history UI) ──

export interface RunRow {
  id: string;
  project_dir: string;
  spec_dir: string;
  mode: string;
  model: string;
  status: string;
  total_cost_usd: number | null;
  total_duration_ms: number | null;
  phases_completed: number;
  created_at: string;
  completed_at: string | null;
}

export interface PhaseTraceRow {
  id: string;
  run_id: string;
  spec_dir: string | null;
  phase_number: number;
  phase_name: string;
  status: string;
  cost_usd: number | null;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
  completed_at: string | null;
}

export interface TraceStepRow {
  id: string;
  phase_trace_id: string;
  sequence_index: number;
  type: string;
  content: string | null;
  metadata: string | null;
  duration_ms: number | null;
  token_count: number | null;
  created_at: string;
}

export interface SubagentRow {
  id: string;
  phase_trace_id: string;
  subagent_id: string;
  subagent_type: string;
  description: string | null;
  started_at: string;
  completed_at: string | null;
}

export function getLatestProjectRun(projectDir: string): { run: RunRow; phases: PhaseTraceRow[]; loopCycles: LoopCycleRow[] } | null {
  const run = getDb()
    .prepare(`SELECT * FROM runs WHERE project_dir = ? ORDER BY created_at DESC LIMIT 1`)
    .get(projectDir) as RunRow | undefined;
  if (!run) return null;
  const phases = getDb()
    .prepare(`SELECT * FROM phase_traces WHERE run_id = ? ORDER BY phase_number, created_at`)
    .all(run.id) as PhaseTraceRow[];
  const loopCycleRows = getDb()
    .prepare(`SELECT * FROM loop_cycles WHERE run_id = ? ORDER BY cycle_number`)
    .all(run.id) as LoopCycleRow[];
  return { run, phases, loopCycles: loopCycleRows };
}

export function listRuns(limit = 20): RunRow[] {
  return getDb()
    .prepare(`SELECT * FROM runs ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as RunRow[];
}

export function getRun(runId: string): { run: RunRow; phases: PhaseTraceRow[] } | null {
  const run = getDb().prepare(`SELECT * FROM runs WHERE id = ?`).get(runId) as RunRow | undefined;
  if (!run) return null;
  const phases = getDb()
    .prepare(`SELECT * FROM phase_traces WHERE run_id = ? ORDER BY phase_number`)
    .all(runId) as PhaseTraceRow[];
  return { run, phases };
}

export function getStepsForPhase(phaseTraceId: string): TraceStepRow[] {
  return getDb()
    .prepare(`SELECT * FROM trace_steps WHERE phase_trace_id = ? ORDER BY sequence_index`)
    .all(phaseTraceId) as TraceStepRow[];
}

export function getSubagentsForPhase(phaseTraceId: string): SubagentRow[] {
  return getDb()
    .prepare(`SELECT * FROM subagent_metadata WHERE phase_trace_id = ? ORDER BY started_at`)
    .all(phaseTraceId) as SubagentRow[];
}

export function getLatestPhaseTrace(
  projectDir: string,
  specDir: string,
  phaseNumber: number
): PhaseTraceRow | null {
  const row = getDb()
    .prepare(
      `SELECT pt.* FROM phase_traces pt
       JOIN runs r ON r.id = pt.run_id
       WHERE r.project_dir = ? AND pt.phase_number = ?
         AND (pt.spec_dir = ? OR pt.spec_dir IS NULL)
       ORDER BY pt.created_at DESC LIMIT 1`
    )
    .get(projectDir, phaseNumber, specDir) as PhaseTraceRow | undefined;
  return row ?? null;
}

/**
 * Get the latest phase trace for each phase of a spec.
 * Returns one row per phase (the most recent trace for that phase).
 */
export function getSpecPhaseStats(
  projectDir: string,
  specDir: string
): PhaseTraceRow[] {
  return getDb()
    .prepare(
      `SELECT pt.* FROM phase_traces pt
       JOIN runs r ON r.id = pt.run_id
       WHERE r.project_dir = ? AND (pt.spec_dir = ? OR pt.spec_dir IS NULL)
         AND pt.id = (
           SELECT pt2.id FROM phase_traces pt2
           JOIN runs r2 ON r2.id = pt2.run_id
           WHERE r2.project_dir = ? AND pt2.phase_number = pt.phase_number
             AND (pt2.spec_dir = ? OR pt2.spec_dir IS NULL)
           ORDER BY pt2.created_at DESC LIMIT 1
         )
       ORDER BY pt.phase_number`
    )
    .all(projectDir, specDir, projectDir, specDir) as PhaseTraceRow[];
}

export interface SpecStats {
  totalCostUsd: number;
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  phasesWithTraces: number;
}

/**
 * Aggregate stats across the latest trace of each phase for a spec.
 */
export function getSpecAggregateStats(
  projectDir: string,
  specDir: string
): SpecStats {
  const phases = getSpecPhaseStats(projectDir, specDir);
  let totalCostUsd = 0;
  let totalDurationMs = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const p of phases) {
    totalCostUsd += p.cost_usd ?? 0;
    totalDurationMs += p.duration_ms ?? 0;
    totalInputTokens += p.input_tokens ?? 0;
    totalOutputTokens += p.output_tokens ?? 0;
  }

  return {
    totalCostUsd,
    totalDurationMs,
    totalInputTokens,
    totalOutputTokens,
    phasesWithTraces: phases.length,
  };
}

export interface ActiveRunState {
  runId: string;
  projectDir: string;
  specDir: string;
  mode: string;
  model: string;
  phaseTraceId: string;
  phaseNumber: number;
  phaseName: string;
}

/**
 * Query for a currently active run + its currently running phase trace.
 * Both `runs.status` and `phase_traces.status` must be 'running'.
 * Returns null if nothing is actively running.
 *
 * @deprecated No longer used for resume — resume now reads from .dex/state.json.
 * Kept for backward compatibility with any code that still calls it.
 */
export function getActiveRunState(): ActiveRunState | null {
  const row = getDb()
    .prepare(
      `SELECT r.id AS run_id, r.project_dir, r.spec_dir AS run_spec_dir, r.mode, r.model,
              pt.id AS phase_trace_id, pt.spec_dir AS phase_spec_dir, pt.phase_number, pt.phase_name
       FROM runs r
       JOIN phase_traces pt ON pt.run_id = r.id AND pt.status = 'running'
       WHERE r.status = 'running'
       ORDER BY pt.created_at DESC
       LIMIT 1`
    )
    .get() as {
      run_id: string;
      project_dir: string;
      run_spec_dir: string;
      mode: string;
      model: string;
      phase_trace_id: string;
      phase_spec_dir: string | null;
      phase_number: number;
      phase_name: string;
    } | undefined;

  if (!row) return null;

  return {
    runId: row.run_id,
    projectDir: row.project_dir,
    specDir: row.phase_spec_dir ?? row.run_spec_dir,
    mode: row.mode,
    model: row.model,
    phaseTraceId: row.phase_trace_id,
    phaseNumber: row.phase_number,
    phaseName: row.phase_name,
  };
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
