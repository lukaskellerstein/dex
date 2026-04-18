import fs from "node:fs";
import path from "node:path";
import { DEX_HOME, LOGS_ROOT, FALLBACK_LOG, migrateIfNeeded } from "./paths.js";

export type LogLevel = "INFO" | "ERROR" | "DEBUG" | "WARN";

export function formatLogLine(level: string, msg: string, data?: unknown): string {
  const ts = new Date().toISOString();
  return data
    ? `[${ts}] [${level}] ${msg} ${JSON.stringify(data, null, 0)}\n`
    : `[${ts}] [${level}] ${msg}\n`;
}

/**
 * Structured per-run logger.
 *
 * Directory layout:
 *   ~/.dex/logs/<project-name>/<run-id>/
 *     run.log                          — run-level lifecycle events
 *     phase-<N>_<slug>/
 *       agent.log                      — all events for this phase's agent
 *       subagents/
 *         <subagent-id>.log            — per-subagent lifecycle + raw SDK input
 */
export class RunLogger {
  private runDir: string;
  private phaseDir: string | null = null;

  constructor(projectName: string, runId: string) {
    this.runDir = path.join(LOGS_ROOT, projectName, runId);
    fs.mkdirSync(this.runDir, { recursive: true });
  }

  /** Log to run.log (run-level events) */
  run(level: LogLevel, msg: string, data?: unknown): void {
    fs.appendFileSync(path.join(this.runDir, "run.log"), formatLogLine(level, msg, data));
  }

  /** Set the active phase directory — call at phase start */
  startPhase(phaseNumber: number, phaseName: string, phaseTraceId: string): void {
    const slug = phaseName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    this.phaseDir = path.join(this.runDir, `phase-${phaseNumber}_${slug}`);
    fs.mkdirSync(path.join(this.phaseDir, "subagents"), { recursive: true });
    this.run("INFO", `Phase ${phaseNumber} started: ${phaseName}`, { phaseTraceId });
    this.phase("INFO", `Phase ${phaseNumber}: ${phaseName} — phaseTraceId=${phaseTraceId}`);
  }

  /** Log to the current phase's agent.log */
  phase(level: LogLevel, msg: string, data?: unknown): void {
    if (!this.phaseDir) {
      this.run(level, msg, data);
      return;
    }
    fs.appendFileSync(path.join(this.phaseDir, "agent.log"), formatLogLine(level, msg, data));
  }

  /** Log to a subagent's dedicated log file within the current phase */
  subagent(subagentId: string, level: LogLevel, msg: string, data?: unknown): void {
    if (!this.phaseDir) {
      this.run(level, `[subagent:${subagentId}] ${msg}`, data);
      return;
    }
    const file = path.join(this.phaseDir, "subagents", `${subagentId}.log`);
    fs.appendFileSync(file, formatLogLine(level, msg, data));
  }

  /** Convenience: log to both phase agent.log AND subagent file */
  subagentEvent(subagentId: string, level: LogLevel, msg: string, data?: unknown): void {
    this.phase(level, `[subagent:${subagentId}] ${msg}`, data);
    this.subagent(subagentId, level, msg, data);
  }

  get currentRunDir(): string { return this.runDir; }
  get currentPhaseDir(): string | null { return this.phaseDir; }
}

/** Fallback logger used before a run starts (global orchestrator log). */
let fallbackMigrated = false;
export function fallbackLog(level: LogLevel, msg: string, data?: unknown): void {
  if (!fallbackMigrated) {
    migrateIfNeeded(path.join(DEX_HOME, "orchestrator.log"), FALLBACK_LOG);
    fallbackMigrated = true;
  }
  fs.mkdirSync(path.dirname(FALLBACK_LOG), { recursive: true });
  fs.appendFileSync(FALLBACK_LOG, formatLogLine(level, msg, data));
}
