import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

let db: Database.Database | null = null;

function getDbPath(): string {
  const dir = path.join(os.homedir(), ".ralph-claude");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "data.db");
}

export function initDatabase(): void {
  if (db) return;
  db = new Database(getDbPath());
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
