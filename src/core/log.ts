import fs from "node:fs";
import path from "node:path";
import { DEX_HOME, LOGS_ROOT, FALLBACK_LOG, migrateIfNeeded } from "./paths.js";

type LogLevel = "INFO" | "ERROR" | "DEBUG" | "WARN";

function formatLogLine(level: string, msg: string, data?: unknown): string {
  const ts = new Date().toISOString();
  return data
    ? `[${ts}] [${level}] ${msg} ${JSON.stringify(data, null, 0)}\n`
    : `[${ts}] [${level}] ${msg}\n`;
}

/**
 * Structured per-run logger.
 *
 * Directory layout (on-disk path keeps the legacy `phase-<N>_*` prefix to avoid
 * a log-tree migration; renaming the on-disk layout is deferred to a follow-up
 * PR — see ~/.claude/plans/what-is-the-wording-wobbly-avalanche.md):
 *
 *   ~/.dex/logs/<project-name>/<run-id>/
 *     run.log                          — run-level lifecycle events
 *     phase-<N>_<slug>/
 *       agent.log                      — all events for this agent run
 *       subagents/
 *         <subagent-id>.log            — per-subagent lifecycle + raw SDK input
 */
export class RunLogger {
  private runDir: string;
  private agentRunDir: string | null = null;

  constructor(projectName: string, runId: string) {
    this.runDir = path.join(LOGS_ROOT, projectName, runId);
    fs.mkdirSync(this.runDir, { recursive: true });
  }

  /** Log to run.log (run-level events) */
  run(level: LogLevel, msg: string, data?: unknown): void {
    fs.appendFileSync(path.join(this.runDir, "run.log"), formatLogLine(level, msg, data));
  }

  /** Set the active agent-run directory — call at agent-run start */
  startAgentRun(taskPhaseNumber: number, taskPhaseName: string, agentRunId: string): void {
    const slug = taskPhaseName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    this.agentRunDir = path.join(this.runDir, `phase-${taskPhaseNumber}_${slug}`);
    fs.mkdirSync(path.join(this.agentRunDir, "subagents"), { recursive: true });
    this.run("INFO", `TaskPhase ${taskPhaseNumber} started: ${taskPhaseName}`, { agentRunId });
    this.agentRun("INFO", `TaskPhase ${taskPhaseNumber}: ${taskPhaseName} — agentRunId=${agentRunId}`);
  }

  /** Log to the current agent-run's agent.log */
  agentRun(level: LogLevel, msg: string, data?: unknown): void {
    if (!this.agentRunDir) {
      this.run(level, msg, data);
      return;
    }
    fs.appendFileSync(path.join(this.agentRunDir, "agent.log"), formatLogLine(level, msg, data));
  }

  /** Log to a subagent's dedicated log file within the current agent run */
  subagent(subagentId: string, level: LogLevel, msg: string, data?: unknown): void {
    if (!this.agentRunDir) {
      this.run(level, `[subagent:${subagentId}] ${msg}`, data);
      return;
    }
    const file = path.join(this.agentRunDir, "subagents", `${subagentId}.log`);
    fs.appendFileSync(file, formatLogLine(level, msg, data));
  }

  /** Convenience: log to both agent-run agent.log AND subagent file */
  subagentEvent(subagentId: string, level: LogLevel, msg: string, data?: unknown): void {
    this.agentRun(level, `[subagent:${subagentId}] ${msg}`, data);
    this.subagent(subagentId, level, msg, data);
  }

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
