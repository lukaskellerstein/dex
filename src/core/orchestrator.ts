import crypto from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type {
  AgentStep,
  EmitFn,
  Phase,
  RunConfig,
  SubagentInfo,
  Task,
} from "./types.js";
import { parseTasksFile, derivePhaseStatus, extractTaskIds, discoverNewSpecDir } from "./parser.js";
import {
  initDatabase,
  createRun,
  completeRun,
  createPhaseTrace,
  completePhaseTrace,
  insertStep,
  insertSubagent,
  completeSubagent,
  insertLoopCycle,
  updateLoopCycle,
  upsertFailureRecord,
  getFailureRecord,
  updateRunLoopsCompleted,
  getRun,
  getLoopCycles,
} from "./database.js";
import {
  getCurrentBranch,
  createBranch,
  createPullRequest,
  createLoopPullRequest,
  commitCheckpoint,
  getHeadSha,
} from "./git.js";
import {
  createInitialState,
  saveState,
  loadState,
  clearState,
  updateState,
  hashFile,
  detectStaleState,
  acquireStateLock,
  resolveWorkingTreeConflict,
  reconcileState,
  migrateFromDbResume,
} from "./state.js";
import type { DexState } from "./state.js";
import {
  buildProductClarificationPrompt,
  buildTechnicalClarificationPrompt,
  buildClarificationSynthesisPrompt,
  buildManifestExtractionPrompt,
  buildFeatureEvaluationPrompt,
  buildConstitutionPrompt,
  buildSpecifyPrompt,
  buildLoopPlanPrompt,
  buildLoopTasksPrompt,
  buildImplementPrompt,
  buildVerifyPrompt,
  buildVerifyFixPrompt,
  buildLearningsPrompt,
  MANIFEST_SCHEMA,
  GAP_ANALYSIS_SCHEMA,
  VERIFY_SCHEMA,
  LEARNINGS_SCHEMA,
  SYNTHESIS_SCHEMA,
} from "./prompts.js";
import {
  loadManifest,
  saveManifest,
  getNextFeature,
  getActiveFeature,
  updateFeatureStatus,
  updateFeatureSpecDir,
  checkSourceDrift,
  hashFile as hashManifestFile,
  appendLearnings,
} from "./manifest.js";
import type { FeatureManifest } from "./manifest.js";
import type {
  LoopStageType,
  GapAnalysisDecision,
  FailureRecord,
  LoopTermination,
  TerminationReason,
  PrerequisiteCheck,
  PrerequisiteCheckName,
} from "./types.js";

// ── Logging ──

const LOGS_ROOT = path.join(os.homedir(), ".dex", "logs");

function formatLogLine(level: string, msg: string, data?: unknown): string {
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
class RunLogger {
  private runDir: string;
  private phaseDir: string | null = null;

  constructor(projectName: string, runId: string) {
    this.runDir = path.join(LOGS_ROOT, projectName, runId);
    fs.mkdirSync(this.runDir, { recursive: true });
  }

  /** Log to run.log (run-level events) */
  run(level: "INFO" | "ERROR" | "DEBUG" | "WARN", msg: string, data?: unknown): void {
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
  phase(level: "INFO" | "ERROR" | "DEBUG" | "WARN", msg: string, data?: unknown): void {
    if (!this.phaseDir) {
      this.run(level, msg, data);
      return;
    }
    fs.appendFileSync(path.join(this.phaseDir, "agent.log"), formatLogLine(level, msg, data));
  }

  /** Log to a subagent's dedicated log file within the current phase */
  subagent(subagentId: string, level: "INFO" | "ERROR" | "DEBUG" | "WARN", msg: string, data?: unknown): void {
    if (!this.phaseDir) {
      this.run(level, `[subagent:${subagentId}] ${msg}`, data);
      return;
    }
    const file = path.join(this.phaseDir, "subagents", `${subagentId}.log`);
    fs.appendFileSync(file, formatLogLine(level, msg, data));
  }

  /** Convenience: log to both phase agent.log AND subagent file */
  subagentEvent(subagentId: string, level: "INFO" | "ERROR" | "DEBUG" | "WARN", msg: string, data?: unknown): void {
    this.phase(level, `[subagent:${subagentId}] ${msg}`, data);
    this.subagent(subagentId, level, msg, data);
  }

  get currentRunDir(): string { return this.runDir; }
  get currentPhaseDir(): string | null { return this.phaseDir; }
}

/** Fallback logger used before a run starts (global orchestrator log). */
const FALLBACK_LOG = path.join(os.homedir(), ".dex", "orchestrator.log");
function log(level: "INFO" | "ERROR" | "DEBUG" | "WARN", msg: string, data?: unknown): void {
  fs.mkdirSync(path.dirname(FALLBACK_LOG), { recursive: true });
  fs.appendFileSync(FALLBACK_LOG, formatLogLine(level, msg, data));
}

let abortController: AbortController | null = null;
let activeProjectDir: string | null = null;
let releaseLock: (() => void) | null = null;

/** Sentinel error thrown when abort is detected between stages to skip remaining work. */
class AbortError extends Error {
  constructor() {
    super("Run stopped by user");
    this.name = "AbortError";
  }
}

// ── Module-level run state (survives renderer reload) ──

interface RunState {
  runId: string;
  projectDir: string;
  specDir: string;
  mode: string;
  model: string;
  phaseTraceId: string;
  phaseNumber: number;
  phaseName: string;
  // Loop-mode fields
  currentCycle?: number;
  currentStage?: LoopStageType;
  isClarifying?: boolean;
  loopsCompleted?: number;
}

let currentRunState: RunState | null = null;

/**
 * Returns the current run state if the orchestrator is actively running.
 * This is the authoritative source — DB rows can be stale from crashes.
 */
export function getRunState(): RunState | null {
  if (!abortController) return null;
  return currentRunState;
}

// ── User Input (AskUserQuestion) ──

/** Pending question resolvers — keyed by requestId */
const pendingQuestions = new Map<string, (answers: Record<string, string>) => void>();

/**
 * Called from IPC when the user submits answers to a clarification question.
 */
export function submitUserAnswer(requestId: string, answers: Record<string, string>): void {
  const resolver = pendingQuestions.get(requestId);
  if (resolver) {
    resolver(answers);
    pendingQuestions.delete(requestId);
  } else {
    log("WARN", `submitUserAnswer: no pending question for requestId=${requestId}`);
  }
}

/**
 * Waits for user input. Emits the question event, then blocks until the user responds.
 */
function waitForUserInput(
  emit: EmitFn,
  runId: string,
  questions: import("./types.js").UserInputQuestion[]
): Promise<Record<string, string>> {
  const requestId = crypto.randomUUID();

  // Persist pending question to state file so it survives crashes
  if (activeProjectDir) {
    updateState(activeProjectDir, {
      pendingQuestion: {
        id: requestId,
        question: questions.map(q => q.question).join("; "),
        context: `runId:${runId}`,
        askedAt: new Date().toISOString(),
      },
    }).catch(() => {});
  }

  emit({ type: "user_input_request", runId, requestId, questions });
  return new Promise<Record<string, string>>((resolve) => {
    pendingQuestions.set(requestId, (answers) => {
      // Clear pending question from state file on answer
      if (activeProjectDir) {
        updateState(activeProjectDir, { pendingQuestion: null }).catch(() => {});
      }
      resolve(answers);
    });
  });
}

// ── Pricing (USD per 1M tokens) ──

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-5-20250514": { input: 3, output: 15 },
  "claude-sonnet-4-6":          { input: 3, output: 15 },
  "claude-opus-4-5-20250414":   { input: 15, output: 75 },
  "claude-opus-4-6":            { input: 15, output: 75 },
  "claude-haiku-4-5-20251001":  { input: 0.80, output: 4 },
};

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  // Match by prefix — e.g. "claude-sonnet-4-5-20250514" matches "claude-sonnet-4-5"
  const pricing = MODEL_PRICING[model]
    ?? Object.entries(MODEL_PRICING).find(([k]) => model.startsWith(k))?.[1];
  if (!pricing) return 0;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

// ── Step Construction Helpers ──

function makeStep(
  type: AgentStep["type"],
  sequenceIndex: number,
  content: string | null,
  metadata: Record<string, unknown> | null = null
): AgentStep {
  return {
    id: crypto.randomUUID(),
    sequenceIndex,
    type,
    content,
    metadata,
    durationMs: null,
    tokenCount: null,
    createdAt: new Date().toISOString(),
  };
}

function toToolCallStep(
  input: Record<string, unknown>,
  idx: number
): AgentStep {
  return makeStep("tool_call", idx, null, {
    toolName: input.tool_name ?? "unknown",
    toolInput: input.tool_input ?? {},
    toolUseId: input.tool_use_id ?? null,
  });
}

function stringifyResponse(response: unknown): string {
  if (typeof response === "string") return response;
  try {
    return JSON.stringify(response, null, 2);
  } catch {
    return String(response);
  }
}

function toToolResultStep(
  input: Record<string, unknown>,
  idx: number
): AgentStep {
  const response = input.tool_response ?? input.tool_result ?? "";
  const text = stringifyResponse(response);
  const isError = typeof response === "string" && response.startsWith("Error");
  return makeStep(
    isError ? "tool_error" : "tool_result",
    idx,
    text,
    {
      toolName: input.tool_name ?? "unknown",
      toolUseId: input.tool_use_id ?? null,
    }
  );
}

function toSubagentInfo(input: Record<string, unknown>): SubagentInfo {
  return {
    id: crypto.randomUUID(),
    subagentId: String(input.subagent_id ?? input.agent_id ?? crypto.randomUUID()),
    subagentType: String(input.subagent_type ?? input.agent_type ?? "unknown"),
    description: input.description ? String(input.description) : null,
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
}

// ── Spec Discovery ──

function listSpecDirs(projectDir: string): string[] {
  const candidates = [
    path.join(projectDir, "specs"),
    path.join(projectDir, ".specify", "specs"),
  ];

  for (const specsRoot of candidates) {
    if (fs.existsSync(specsRoot)) {
      const entries = fs.readdirSync(specsRoot, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .filter((e) => fs.existsSync(path.join(specsRoot, e.name, "tasks.md")))
        .map((e) => path.relative(projectDir, path.join(specsRoot, e.name)))
        .sort();
    }
  }

  return [];
}

function isSpecComplete(projectDir: string, specDir: string): boolean {
  const phases = parseTasksFile(projectDir, specDir);
  return phases.length > 0 && phases.every((p) => p.status === "complete");
}

// ── In-Memory Task State ──

const STATUS_RANK: Record<string, number> = {
  not_done: 0,
  code_exists: 1,
  in_progress: 2,
  done: 3,
};

class RunTaskState {
  private phases: Phase[];
  private taskMap: Map<string, Task>;

  constructor(initialPhases: Phase[]) {
    // Deep-clone so mutations don't affect the caller's data
    this.phases = JSON.parse(JSON.stringify(initialPhases));
    this.taskMap = new Map();
    for (const p of this.phases) {
      for (const t of p.tasks) {
        this.taskMap.set(t.id, t);
      }
    }
  }

  /** Apply TodoWrite statuses. Promotes only (never demotes). Returns current phases. */
  updateFromTodoWrite(
    todos: Array<{ content?: string; status?: string }>
  ): Phase[] {
    const updates = new Map<string, "in_progress" | "done">();

    for (const todo of todos) {
      if (!todo.content) continue;
      const ids = extractTaskIds(todo.content);
      const mapped =
        todo.status === "completed" ? "done" : todo.status === "in_progress" ? "in_progress" : null;
      if (!mapped) continue;
      for (const id of ids) {
        updates.set(id, mapped);
      }
    }

    if (updates.size === 0) return this.phases;

    for (const [id, newStatus] of updates) {
      const task = this.taskMap.get(id);
      if (task && STATUS_RANK[newStatus] > STATUS_RANK[task.status]) {
        task.status = newStatus;
      }
    }

    // Re-derive phase statuses
    for (const p of this.phases) {
      p.status = derivePhaseStatus(p.tasks);
    }

    return this.phases;
  }

  /**
   * Re-read tasks.md from disk and reconcile with in-memory state.
   * Promote-only: a task that is "done" on disk but "not_done" in memory
   * gets promoted. A task that is "done" in memory stays "done" even if
   * disk says otherwise (agent may have used TodoWrite earlier).
   */
  reconcileFromDisk(freshPhases: Phase[]): Phase[] {
    for (const freshPhase of freshPhases) {
      for (const freshTask of freshPhase.tasks) {
        const memTask = this.taskMap.get(freshTask.id);
        if (memTask && STATUS_RANK[freshTask.status] > STATUS_RANK[memTask.status]) {
          memTask.status = freshTask.status;
        }
      }
    }

    for (const p of this.phases) {
      p.status = derivePhaseStatus(p.tasks);
    }

    return this.phases;
  }

  getPhases(): Phase[] {
    return this.phases;
  }

  getIncompletePhases(filter: "all" | number[]): Phase[] {
    if (filter === "all") {
      return this.phases.filter((p) => p.status !== "complete");
    }
    return this.phases.filter(
      (p) => filter.includes(p.number) && p.status !== "complete"
    );
  }
}

// ── Prompt Builders ──

function buildPrompt(config: RunConfig, phase: Phase): string {
  // Resolve the spec directory to an absolute path so the agent knows exactly
  // which spec to work on (specDir may be relative like "specs/001-product-catalog").
  const specPath = config.specDir.startsWith("/")
    ? config.specDir
    : `${config.projectDir}/${config.specDir}`;

  const skillName = config.mode === "plan" ? "speckit-plan" : "speckit-implement";

  // The prompt starts with the slash command — the SDK harness expands it
  // as a user invocation (disable-model-invocation only blocks the model
  // from calling the Skill tool on its own, not user-invoked slash commands).
  const afterSteps = config.mode === "plan"
    ? `After analyzing:
- Update ${specPath}/tasks.md with accurate task statuses
- If you learned operational patterns, update CLAUDE.md
- Commit: git add -A -- ':!.dex/' && git commit -m "plan: Phase ${phase.number} gap analysis"`
    : `IMPORTANT — update tasks.md incrementally:
- After completing EACH task, immediately mark it [x] in ${specPath}/tasks.md before moving to the next task. This drives a real-time progress UI.

After implementing all tasks:
- Run build/typecheck to verify changes compile
- Run tests if they exist
- Commit: git add -A -- ':!.dex/' && git commit -m "Phase ${phase.number}: ${phase.name}"
- If you learned operational patterns, update CLAUDE.md`;

  return `/${skillName} ${specPath} --phase ${phase.number}

${afterSteps}`;
}

// ── Phase Runner ──

async function runPhase(
  config: RunConfig,
  phase: Phase,
  phaseTraceId: string,
  emit: EmitFn,
  rlog: RunLogger,
  runTaskState: RunTaskState
): Promise<{ cost: number; durationMs: number; inputTokens: number; outputTokens: number }> {
  const startTime = Date.now();
  let stepIndex = 0;
  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const knownSubagentIds = new Set<string>();
  const activeSubagentSet = new Set<string>();

  const skillName = config.mode === "plan" ? "speckit-plan" : "speckit-implement";
  const specPath = config.specDir.startsWith("/")
    ? config.specDir
    : `${config.projectDir}/${config.specDir}`;

  const prompt = buildPrompt(config, phase);
  rlog.phase("INFO", `runPhase: spawning agent for Phase ${phase.number}: ${phase.name}`);
  rlog.phase("DEBUG", "runPhase: prompt", { length: prompt.length, prompt });

  // Dual-write helper: emit to UI via IPC + persist to SQLite
  // Attaches running cost/token totals so the renderer can display live stats.
  // Tags steps with the active subagent ID when exactly one subagent is active.
  // When multiple subagents run in parallel, we can't determine which one owns
  // a step, so we leave the tag empty.
  const emitAndStore = (step: AgentStep) => {
    const activeSubagent = activeSubagentSet.size === 1 ? [...activeSubagentSet][0] : null;
    const enriched: AgentStep = {
      ...step,
      metadata: {
        ...step.metadata,
        costUsd: totalCost || null,
        inputTokens: totalInputTokens || null,
        outputTokens: totalOutputTokens || null,
        ...(activeSubagent ? { belongsToSubagent: activeSubagent } : {}),
      },
    };
    rlog.phase("DEBUG", `emitAndStore: step type=${enriched.type}`, { id: enriched.id, seq: enriched.sequenceIndex });
    emit({ type: "agent_step", step: enriched });
    insertStep({ ...enriched, phaseTraceId });
  };

  // Emit the initial prompt as a user_message step
  emitAndStore(makeStep("user_message", stepIndex++, prompt));

  // Emit skill_invoke step to show which skill is being expanded
  emitAndStore(
    makeStep("skill_invoke", stepIndex++, null, {
      skillName,
      skillArgs: `${specPath} --phase ${phase.number}`,
    })
  );

  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  rlog.phase("DEBUG", "runPhase: SDK imported, calling query()");

  const isAborted = () => abortController?.signal.aborted ?? false;
  let sessionId: string | null = null;

  for await (const msg of query({
    prompt,
    options: {
      model: config.model,
      cwd: config.projectDir,
      maxTurns: config.maxTurns,
      permissionMode: "bypassPermissions",
      settingSources: ["project"],
      hooks: {
        PreToolUse: [
          {
            matcher: undefined,
            hooks: [
              async (input: Record<string, unknown>) => {
                const toolName = String(input.tool_name ?? "unknown");
                rlog.phase("DEBUG", `PreToolUse: ${toolName}`, { toolUseId: input.tool_use_id, toolInput: input.tool_input });

                // Emit skill_invoke for Skill tool calls
                if (toolName === "Skill") {
                  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
                  emitAndStore(
                    makeStep("skill_invoke", stepIndex++, null, {
                      skillName: toolInput.skill ?? "",
                      skillArgs: toolInput.args ?? "",
                      toolUseId: input.tool_use_id ?? null,
                    })
                  );
                } else {
                  emitAndStore(toToolCallStep(input, stepIndex++));
                }

                if (isAborted()) {
                  return {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: "deny",
                      permissionDecisionReason: "Run stopped by user",
                    },
                  };
                }
                return {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "allow",
                  },
                };
              },
            ],
          },
        ],
        PostToolUse: [
          {
            matcher: undefined,
            hooks: [
              async (input: Record<string, unknown>) => {
                const toolName = String(input.tool_name ?? "unknown");
                rlog.phase("DEBUG", `PostToolUse: ${toolName}`, { toolUseId: input.tool_use_id });

                // Emit skill_result for Skill tool results
                if (toolName === "Skill") {
                  const response = input.tool_response ?? input.tool_result ?? "";
                  emitAndStore(
                    makeStep("skill_result", stepIndex++, stringifyResponse(response), {
                      toolUseId: input.tool_use_id ?? null,
                    })
                  );
                } else {
                  emitAndStore(toToolResultStep(input, stepIndex++));
                }

                // Detect TodoWrite — update in-memory task state (sole source of truth during run)
                if (toolName === "TodoWrite") {
                  try {
                    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
                    const todos = (toolInput.todos ?? []) as Array<{
                      content?: string;
                      status?: string;
                    }>;
                    const updatedPhases = runTaskState.updateFromTodoWrite(todos);
                    emit({ type: "tasks_updated", phases: updatedPhases });
                    rlog.phase("DEBUG", "PostToolUse: TodoWrite detected, emitted tasks_updated");
                  } catch (err) {
                    rlog.phase("WARN", "PostToolUse: failed to process TodoWrite", { err: String(err) });
                  }
                }

                return {
                  hookSpecificOutput: { hookEventName: "PostToolUse" },
                };
              },
            ],
          },
        ],
        SubagentStart: [
          {
            matcher: undefined,
            hooks: [
              async (input: Record<string, unknown>) => {
                const info = toSubagentInfo(input);
                knownSubagentIds.add(info.subagentId);
                rlog.subagentEvent(info.subagentId, "INFO", "SubagentStart", {
                  subagentType: info.subagentType,
                  description: info.description,
                  rawInput: input,
                });
                emit({ type: "subagent_started", info });
                insertSubagent({ ...info, phaseTraceId });
                emitAndStore(
                  makeStep("subagent_spawn", stepIndex++, null, {
                    subagentId: info.subagentId,
                    subagentType: info.subagentType,
                    description: info.description,
                  })
                );
                // Add AFTER emitting spawn step so the spawn itself isn't tagged
                activeSubagentSet.add(info.subagentId);
                return {};
              },
            ],
          },
        ],
        SubagentStop: [
          {
            matcher: undefined,
            hooks: [
              async (input: Record<string, unknown>) => {
                const subagentId = String(input.subagent_id ?? input.agent_id ?? "unknown");
                rlog.subagentEvent(subagentId, "INFO", "SubagentStop", { rawInput: input });

                // Remove BEFORE emitting result step so the result itself isn't tagged
                activeSubagentSet.delete(subagentId);

                // Skip subagents we never saw start — these are session-init
                // subagents spawned before our hooks were registered.
                if (!knownSubagentIds.has(subagentId)) {
                  rlog.phase("DEBUG", `SubagentStop: ignoring orphan subagent ${subagentId} (no matching start)`);
                  return {};
                }

                emit({ type: "subagent_completed", subagentId });
                completeSubagent(subagentId);
                emitAndStore(
                  makeStep("subagent_result", stepIndex++, null, {
                    subagentId,
                  })
                );
                return {};
              },
            ],
          },
        ],
      },
    },
  })) {
    // Break out of streaming when abort requested
    if (isAborted()) {
      rlog.phase("INFO", "runPhase: abort detected in message loop, breaking");
      break;
    }

    const message = msg as Record<string, unknown>;

    // Log system init message — shows what skills/plugins/tools the agent sees
    if (message.type === "system") {
      const skills = message.skills as unknown[] | undefined;
      const plugins = message.plugins as unknown[] | undefined;
      const tools = message.tools as unknown[] | undefined;
      const agents = message.agents as unknown[] | undefined;
      const slashCommands = message.slash_commands as unknown[] | undefined;
      const model = message.model as string | undefined;
      rlog.phase("INFO", "runPhase: system init", {
        model,
        toolCount: tools?.length ?? 0,
        skillCount: skills?.length ?? 0,
        pluginCount: plugins?.length ?? 0,
        agentCount: agents?.length ?? 0,
        slashCommandCount: slashCommands?.length ?? 0,
      });
      if (skills && skills.length > 0) {
        rlog.phase("INFO", "runPhase: available skills", { skills });
      } else {
        rlog.phase("WARN", "runPhase: NO SKILLS available to agent");
      }
      if (plugins && plugins.length > 0) {
        rlog.phase("INFO", "runPhase: available plugins", { plugins });
      }
      if (slashCommands && slashCommands.length > 0) {
        rlog.phase("INFO", "runPhase: available slash commands", { slashCommands });
      }

      // Extract tool names and separate MCP servers from built-in tools
      const toolNames: string[] = [];
      const mcpServers = new Map<string, string[]>();
      if (tools) {
        for (const t of tools) {
          const name = typeof t === "object" && t !== null
            ? String((t as Record<string, unknown>).name ?? t)
            : String(t);
          toolNames.push(name);
          if (name.startsWith("mcp__")) {
            // Format: mcp__<server>__<tool>
            const parts = name.split("__");
            if (parts.length >= 3) {
              const server = parts[1];
              if (!mcpServers.has(server)) mcpServers.set(server, []);
              mcpServers.get(server)!.push(parts.slice(2).join("__"));
            }
          }
        }
        rlog.phase("DEBUG", "runPhase: available tools", { tools: toolNames });
      }

      // Emit debug step with all agent capabilities
      emitAndStore(
        makeStep("debug", stepIndex++, null, {
          model: model ?? null,
          mcpServers: Object.fromEntries(mcpServers),
          skills: skills ?? [],
          plugins: plugins ?? [],
          agents: agents ?? [],
          slashCommands: slashCommands ?? [],
          toolCount: toolNames.length,
        })
      );
    }

    // Capture session_id from the first message that carries it
    if (!sessionId && typeof message.session_id === "string") {
      sessionId = message.session_id;
      rlog.phase("INFO", `runPhase: session_id=${sessionId}`);
      emitAndStore(
        makeStep("text", stepIndex++, `Session: ${sessionId}`, { sessionId })
      );
    }

    if (message.type === "assistant") {
      // Content blocks live at message.message.content (SDK wraps the API response)
      const innerMsg = message.message as Record<string, unknown> | undefined;
      const content = innerMsg?.content as
        | Array<Record<string, unknown>>
        | undefined;

      // Accumulate per-turn token usage from the API response
      // Try inner message (API response wrapper) first, then outer message
      const usage = (innerMsg?.usage ?? message.usage) as Record<string, unknown> | undefined;
      if (usage) {
        if (typeof usage.input_tokens === "number") totalInputTokens += usage.input_tokens;
        if (typeof usage.output_tokens === "number") totalOutputTokens += usage.output_tokens;
        totalCost = estimateCost(config.model, totalInputTokens, totalOutputTokens);
      }

      rlog.phase("DEBUG", "assistant message", {
        outerKeys: Object.keys(message),
        innerKeys: innerMsg ? Object.keys(innerMsg) : null,
        blockTypes: content?.map((b) => b.type) ?? [],
        usage: usage ?? null,
        runningTokens: { input: totalInputTokens, output: totalOutputTokens },
      });
      if (content) {
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string") {
            emitAndStore(makeStep("text", stepIndex++, block.text));
          }
          if (
            block.type === "thinking" &&
            typeof block.thinking === "string"
          ) {
            emitAndStore(makeStep("thinking", stepIndex++, block.thinking));
          }
        }
      }
    }

    if (message.type === "result") {
      const costUsd = message.total_cost_usd;
      if (typeof costUsd === "number") totalCost = costUsd;

      // Extract token totals from result.usage (authoritative final values)
      const resultUsage = message.usage as Record<string, unknown> | undefined;
      if (resultUsage) {
        if (typeof resultUsage.input_tokens === "number") totalInputTokens = resultUsage.input_tokens;
        if (typeof resultUsage.output_tokens === "number") totalOutputTokens = resultUsage.output_tokens;
      }

      rlog.phase("INFO", `runPhase: result received`, {
        cost: costUsd,
        durationMs: message.duration_ms,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        usage: resultUsage ?? null,
        isError: message.is_error,
        subtype: message.subtype,
        result: typeof message.result === "string" ? message.result.slice(0, 500) : message.result,
        numTurns: message.num_turns,
      });
    }
  }

  const durationMs = Date.now() - startTime;
  rlog.phase("INFO", `runPhase: completed, cost=$${totalCost}, duration=${durationMs}ms`);

  // Emit a completed step at the end
  if (!isAborted()) {
    emitAndStore(makeStep("completed", stepIndex++, `Phase ${phase.number}: ${phase.name} completed`, {
      inputTokens: totalInputTokens || null,
      outputTokens: totalOutputTokens || null,
    }));
  }

  return { cost: totalCost, durationMs, inputTokens: totalInputTokens, outputTokens: totalOutputTokens };
}

// ── Stage Runner (lightweight query() wrapper for loop stages) ──

async function runStage(
  config: RunConfig,
  prompt: string,
  emit: EmitFn,
  rlog: RunLogger,
  runId: string,
  cycleNumber: number,
  stageType: import("./types.js").LoopStageType,
  specDir?: string,
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> }
): Promise<{ result: string; structuredOutput: unknown | null; cost: number; durationMs: number; inputTokens: number; outputTokens: number }> {
  const startTime = Date.now();
  let stepIndex = 0;
  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let resultText = "";
  let structuredOutput: unknown | null = null;
  const knownSubagentIds = new Set<string>();
  const activeSubagentSet = new Set<string>();

  // Create a phase trace for this stage so steps are persisted
  const phaseTraceId = crypto.randomUUID();
  createPhaseTrace({
    id: phaseTraceId,
    runId,
    specDir: specDir ?? "",
    phaseNumber: cycleNumber,
    phaseName: `loop:${stageType}`,
  });

  rlog.phase("INFO", `runStage: ${stageType} for cycle ${cycleNumber}`);

  // Keep currentRunState in sync so the renderer can recover after refresh
  if (currentRunState) {
    currentRunState.currentStage = stageType;
    currentRunState.phaseTraceId = phaseTraceId;
  }

  const emitAndStore = (step: AgentStep) => {
    const activeSubagent = activeSubagentSet.size === 1 ? [...activeSubagentSet][0] : null;
    const enriched: AgentStep = {
      ...step,
      metadata: {
        ...step.metadata,
        costUsd: totalCost || null,
        inputTokens: totalInputTokens || null,
        outputTokens: totalOutputTokens || null,
        ...(activeSubagent ? { belongsToSubagent: activeSubagent } : {}),
      },
    };
    emit({ type: "agent_step", step: enriched });
    insertStep({ ...enriched, phaseTraceId });
  };

  emitAndStore(makeStep("user_message", stepIndex++, prompt));

  emit({
    type: "stage_started",
    runId,
    cycleNumber,
    stage: stageType,
    phaseTraceId,
    specDir,
  });

  const isAborted = () => abortController?.signal.aborted ?? false;

  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  for await (const msg of query({
    prompt,
    options: {
      model: config.model,
      cwd: config.projectDir,
      maxTurns: config.maxTurns,
      permissionMode: "bypassPermissions",
      settingSources: ["project"],
      abortController: abortController ?? undefined,
      ...(outputFormat ? { outputFormat } : {}),
      canUseTool: async (toolName: string, toolInput: Record<string, unknown>) => {
        if (toolName === "AskUserQuestion") {
          rlog.phase("INFO", "canUseTool: AskUserQuestion intercepted");

          // Parse SDK question format into our typed format
          const rawQuestions = (toolInput.questions ?? []) as Array<Record<string, unknown>>;
          const questions: import("./types.js").UserInputQuestion[] = rawQuestions.map((q) => ({
            question: String(q.question ?? ""),
            header: String(q.header ?? ""),
            options: ((q.options ?? []) as Array<Record<string, unknown>>).map((o) => ({
              label: String(o.label ?? ""),
              description: String(o.description ?? ""),
              recommended: Boolean(o.recommended),
            })),
            multiSelect: Boolean(q.multiSelect),
          }));

          let answers: Record<string, string>;

          if (config.autoClarification) {
            // Auto-answer with recommended options
            answers = {};
            for (const q of questions) {
              const recommended = q.options.find((o) => o.recommended);
              if (recommended) {
                answers[q.question] = recommended.label;
              } else if (q.options.length > 0) {
                // Fallback: pick the first option if no recommended
                answers[q.question] = q.options[0].label;
                rlog.phase("WARN", `canUseTool: no recommended option for "${q.question}", using first option`);
              }
            }
            // Still emit the event so the UI can show what was auto-selected
            const requestId = crypto.randomUUID();
            emit({ type: "user_input_request", runId, requestId, questions });
            emit({ type: "user_input_response", requestId, answers });
            rlog.phase("INFO", "canUseTool: auto-answered (autoClarification)", { answers });
          } else {
            // Interactive: emit event and wait for user answer
            answers = await waitForUserInput(emit, runId, questions);
            rlog.phase("INFO", "canUseTool: user answered", { answers });
          }

          return {
            behavior: "allow" as const,
            updatedInput: { questions: rawQuestions, answers },
          };
        }

        // All other tools: auto-approve (bypassPermissions handles this too, belt-and-suspenders)
        return { behavior: "allow" as const, updatedInput: toolInput };
      },
      hooks: {
        PreToolUse: [
          {
            matcher: undefined,
            hooks: [
              async (input: Record<string, unknown>) => {
                const toolName = String(input.tool_name ?? "unknown");
                rlog.phase("DEBUG", `runStage PreToolUse: ${toolName}`);

                if (toolName === "Skill") {
                  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
                  emitAndStore(
                    makeStep("skill_invoke", stepIndex++, null, {
                      skillName: toolInput.skill ?? "",
                      skillArgs: toolInput.args ?? "",
                      toolUseId: input.tool_use_id ?? null,
                    })
                  );
                } else {
                  emitAndStore(toToolCallStep(input, stepIndex++));
                }

                if (isAborted()) {
                  return {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: "deny",
                      permissionDecisionReason: "Run stopped by user",
                    },
                  };
                }
                return {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "allow",
                  },
                };
              },
            ],
          },
        ],
        PostToolUse: [
          {
            matcher: undefined,
            hooks: [
              async (input: Record<string, unknown>) => {
                const toolName = String(input.tool_name ?? "unknown");
                if (toolName === "Skill") {
                  const response = input.tool_response ?? input.tool_result ?? "";
                  emitAndStore(
                    makeStep("skill_result", stepIndex++, stringifyResponse(response), {
                      toolUseId: input.tool_use_id ?? null,
                    })
                  );
                } else {
                  emitAndStore(toToolResultStep(input, stepIndex++));
                }
                return { hookSpecificOutput: { hookEventName: "PostToolUse" } };
              },
            ],
          },
        ],
        SubagentStart: [
          {
            matcher: undefined,
            hooks: [
              async (input: Record<string, unknown>) => {
                const info = toSubagentInfo(input);
                knownSubagentIds.add(info.subagentId);
                emit({ type: "subagent_started", info });
                insertSubagent({ ...info, phaseTraceId });
                emitAndStore(
                  makeStep("subagent_spawn", stepIndex++, null, {
                    subagentId: info.subagentId,
                    subagentType: info.subagentType,
                    description: info.description,
                  })
                );
                activeSubagentSet.add(info.subagentId);
                return {};
              },
            ],
          },
        ],
        SubagentStop: [
          {
            matcher: undefined,
            hooks: [
              async (input: Record<string, unknown>) => {
                const subagentId = String(input.subagent_id ?? input.agent_id ?? "unknown");
                activeSubagentSet.delete(subagentId);
                if (!knownSubagentIds.has(subagentId)) return {};
                emit({ type: "subagent_completed", subagentId });
                completeSubagent(subagentId);
                emitAndStore(
                  makeStep("subagent_result", stepIndex++, null, { subagentId })
                );
                return {};
              },
            ],
          },
        ],
      },
    },
  })) {
    if (isAborted()) {
      rlog.phase("INFO", `runStage(${stageType}): abort detected in message loop — breaking out (SDK query may continue in background)`);
      break;
    }

    const message = msg as Record<string, unknown>;

    if (message.type === "assistant") {
      const innerMsg = message.message as Record<string, unknown> | undefined;
      const content = innerMsg?.content as Array<Record<string, unknown>> | undefined;
      const usage = (innerMsg?.usage ?? message.usage) as Record<string, unknown> | undefined;
      if (usage) {
        if (typeof usage.input_tokens === "number") totalInputTokens += usage.input_tokens;
        if (typeof usage.output_tokens === "number") totalOutputTokens += usage.output_tokens;
        totalCost = estimateCost(config.model, totalInputTokens, totalOutputTokens);
      }
      if (content) {
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string") {
            emitAndStore(makeStep("text", stepIndex++, block.text));
          }
          if (block.type === "thinking" && typeof block.thinking === "string") {
            emitAndStore(makeStep("thinking", stepIndex++, block.thinking));
          }
        }
      }
    }

    if (message.type === "result") {
      if (typeof message.total_cost_usd === "number") totalCost = message.total_cost_usd;
      const resultUsage = message.usage as Record<string, unknown> | undefined;
      if (resultUsage) {
        if (typeof resultUsage.input_tokens === "number") totalInputTokens = resultUsage.input_tokens;
        if (typeof resultUsage.output_tokens === "number") totalOutputTokens = resultUsage.output_tokens;
      }
      if (typeof message.result === "string") resultText = message.result;

      // Structured output handling
      if (outputFormat) {
        if (message.subtype === "error_max_structured_output_retries") {
          rlog.phase("ERROR", `runStage(${stageType}): structured output validation failed after max retries`);
          throw new Error(`Structured output validation failed for ${stageType} — agent could not produce valid JSON matching the schema`);
        }
        structuredOutput = (message as Record<string, unknown>).structured_output ?? null;
        if (structuredOutput === null) {
          rlog.phase("WARN", `runStage(${stageType}): outputFormat requested but structured_output is null — falling back to raw text`);
        }
      }

      rlog.phase("INFO", `runStage: ${stageType} result received`, {
        cost: totalCost,
        resultPreview: resultText.slice(0, 200),
      });
    }
  }

  const durationMs = Date.now() - startTime;

  // Emit a completed step so the UI timeline ends cleanly (mirrors runPhase behavior)
  if (!isAborted()) {
    emitAndStore(makeStep("completed", stepIndex++, `Stage ${stageType} completed`, {
      inputTokens: totalInputTokens || null,
      outputTokens: totalOutputTokens || null,
    }));
  }

  const stageStatus = isAborted() ? "stopped" : "completed";
  completePhaseTrace(phaseTraceId, stageStatus, totalCost, durationMs, totalInputTokens || undefined, totalOutputTokens || undefined);

  emit({
    type: "stage_completed",
    runId,
    cycleNumber,
    stage: stageType,
    phaseTraceId,
    costUsd: totalCost,
    durationMs,
    ...(isAborted() ? { stopped: true } : {}),
  });

  // Checkpoint: update state file and commit after each completed stage
  if (!isAborted() && activeProjectDir) {
    try {
      await updateState(activeProjectDir, {
        lastCompletedStage: stageType,
        currentCycleNumber: cycleNumber,
        currentSpecDir: specDir ?? null,
      });
      const sha = commitCheckpoint(activeProjectDir, stageType, cycleNumber, specDir ?? null, totalCost);
      await updateState(activeProjectDir, {
        checkpoint: { sha, timestamp: new Date().toISOString() },
      });
    } catch {
      // Checkpoint failure shouldn't crash the run
    }
  }

  return { result: resultText, structuredOutput, cost: totalCost, durationMs, inputTokens: totalInputTokens, outputTokens: totalOutputTokens };
}

// ── Build Mode Runner (extracted from run()) ──

async function runBuild(
  config: RunConfig,
  emit: EmitFn,
  runId: string,
  rlog: RunLogger
): Promise<{ phasesCompleted: number; totalCost: number }> {
  let phasesCompleted = 0;
  let totalCost = 0;
  const runStart = Date.now();

  // Determine which specs to process
  const specDirs = config.runAllSpecs
    ? listSpecDirs(config.projectDir).filter(
        (s) => !isSpecComplete(config.projectDir, s)
      )
    : [config.specDir];

  if (specDirs.length === 0) {
    rlog.run("INFO", "runBuild: no unfinished specs found");
    return { phasesCompleted, totalCost };
  }

  rlog.run("INFO", `runBuild: will process ${specDirs.length} spec(s)`, { specDirs });

  for (const specDir of specDirs) {
    if (abortController?.signal.aborted) break;

    const specConfig = { ...config, specDir };

    emit({ type: "spec_started", specDir });
    if (currentRunState) currentRunState.specDir = specDir;
    rlog.run("INFO", `runBuild: starting spec ${specDir}`);

    const initialPhases = parseTasksFile(config.projectDir, specDir);
    const runTaskState = new RunTaskState(initialPhases);

    let iteration = 0;
    let specFailed = false;

    while (iteration < config.maxIterations) {
      if (abortController?.signal.aborted) break;

      const targetPhases = runTaskState.getIncompletePhases(config.phases);

      const phase = targetPhases[0];
      if (!phase) break;

      const phaseTraceId = crypto.randomUUID();
      createPhaseTrace({
        id: phaseTraceId,
        runId,
        specDir,
        phaseNumber: phase.number,
        phaseName: phase.name,
      });

      rlog.startPhase(phase.number, phase.name, phaseTraceId);
      if (currentRunState) {
        currentRunState.phaseTraceId = phaseTraceId;
        currentRunState.phaseNumber = phase.number;
        currentRunState.phaseName = phase.name;
      }
      emit({ type: "phase_started", phase, iteration, phaseTraceId });
      emit({ type: "tasks_updated", phases: runTaskState.getPhases() });

      try {
        const result = await runPhase(specConfig, phase, phaseTraceId, emit, rlog, runTaskState);

        completePhaseTrace(
          phaseTraceId,
          "completed",
          result.cost,
          result.durationMs,
          result.inputTokens || undefined,
          result.outputTokens || undefined
        );

        phasesCompleted++;
        totalCost += result.cost;

        const freshPhases = parseTasksFile(config.projectDir, specDir);
        const reconciledPhases = runTaskState.reconcileFromDisk(freshPhases);
        emit({ type: "tasks_updated", phases: reconciledPhases });

        emit({
          type: "phase_completed",
          phase: { ...phase, status: "complete" },
          cost: result.cost,
          durationMs: result.durationMs,
        });
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        rlog.phase("ERROR", `Phase ${phase.number} failed: ${message}`, { stack });
        rlog.run("ERROR", `Phase ${phase.number} failed: ${message}`);
        completePhaseTrace(phaseTraceId, "failed", 0, Date.now() - runStart);
        emit({
          type: "error",
          message: `Phase ${phase.number} failed: ${message}`,
          phaseNumber: phase.number,
        });
        specFailed = true;
        break;
      }

      iteration++;
    }

    if (!specFailed && !abortController?.signal.aborted) {
      rlog.run("INFO", `runBuild: spec ${specDir} completed`);
      emit({ type: "spec_completed", specDir, phasesCompleted });
    }

    if (specFailed) break;
  }

  return { phasesCompleted, totalCost };
}

// ── Main Entry Point ──

export async function run(config: RunConfig, emit: EmitFn): Promise<void> {
  initDatabase();
  abortController = new AbortController();

  // For loop mode, defer branch creation to after prerequisites (which may init git).
  // For resume, stay on the current branch — don't create a new one.
  let baseBranch = "";
  let branchName = "";
  if (config.resume) {
    // Resume: stay on current branch (the user is already on the paused run's branch)
    branchName = getCurrentBranch(config.projectDir);
  } else if (config.mode !== "loop") {
    baseBranch = getCurrentBranch(config.projectDir);
    branchName = createBranch(config.projectDir, config.mode);
  }

  // On resume: keep the previous runId so phase_traces from the paused run
  // continue to be associated with the same run in the DB and UI.
  let runId: string = crypto.randomUUID();
  if (config.resume) {
    const prevState = await loadState(config.projectDir);
    if (prevState?.runId) {
      runId = prevState.runId;
    }
  }

  const projectName = path.basename(config.projectDir);
  const rlog = new RunLogger(projectName, runId);
  rlog.run("INFO", `run: ${config.resume ? "resuming" : "starting"} orchestrator`, { mode: config.mode, model: config.model, specDir: config.specDir, branch: branchName || "(deferred)", baseBranch: baseBranch || "(deferred)", runId });

  // Only create a new DB row for fresh starts. On resume, the row already exists.
  if (!config.resume) {
    createRun({
      id: runId,
      projectDir: config.projectDir,
      specDir: config.specDir,
      mode: config.mode,
      model: config.model,
    });
  }

  activeProjectDir = config.projectDir;

  // Acquire state lock to prevent concurrent writes
  try {
    releaseLock = await acquireStateLock(config.projectDir);
  } catch (lockErr) {
    emit({ type: "error", message: lockErr instanceof Error ? lockErr.message : String(lockErr) });
    abortController = null;
    activeProjectDir = null;
    return;
  }

  // Create initial state file (unless resuming — state already exists)
  if (!config.resume) {
    const initialState = createInitialState(config, runId, branchName, baseBranch);
    await saveState(config.projectDir, initialState);
  }

  emit({ type: "run_started", config, runId, branchName });

  currentRunState = {
    runId,
    projectDir: config.projectDir,
    specDir: config.specDir,
    mode: config.mode,
    model: config.model,
    phaseTraceId: "",
    phaseNumber: 0,
    phaseName: "",
  };

  let phasesCompleted = 0;
  let totalCost = 0;
  const runStart = Date.now();

  try {
    if (config.mode === "loop") {
      const result = await runLoop(config, emit, runId, rlog);
      phasesCompleted = result.phasesCompleted;
      totalCost = result.totalCost;
      // Branch was created inside runLoop after prerequisites
      baseBranch = result.baseBranch;
      branchName = result.branchName;
    } else {
      const result = await runBuild(config, emit, runId, rlog);
      phasesCompleted = result.phasesCompleted;
      totalCost = result.totalCost;
    }
  } catch (err) {
    // AbortError is expected when the user stops a run — not a real error
    if (!(err instanceof AbortError)) throw err;
  } finally {
    const wasStopped = abortController?.signal.aborted ?? false;
    abortController = null;
    currentRunState = null;

    const totalDuration = Date.now() - runStart;
    const finalStatus = wasStopped ? "stopped" : "completed";
    completeRun(runId, finalStatus, totalCost, totalDuration, phasesCompleted);

    // Update state file: paused if stopped, clear if completed
    if (activeProjectDir) {
      try {
        if (wasStopped) {
          await updateState(activeProjectDir, {
            status: "paused",
            pausedAt: new Date().toISOString(),
            cumulativeCostUsd: totalCost,
          });
        } else {
          await updateState(activeProjectDir, { status: "completed" });
        }
      } catch {
        // State write failure shouldn't crash the cleanup
      }
    }

    // Release state lock
    if (releaseLock) {
      releaseLock();
      releaseLock = null;
    }
    activeProjectDir = null;

    let prUrl: string | null = null;
    if (!wasStopped && phasesCompleted > 0 && branchName) {
      rlog.run("INFO", `run: creating PR for branch ${branchName}`);
      prUrl = createPullRequest(
        config.projectDir,
        branchName,
        baseBranch,
        config.mode,
        phasesCompleted,
        totalCost,
        totalDuration
      );
      rlog.run("INFO", `run: PR created`, { prUrl });
    }

    emit({
      type: "run_completed",
      totalCost,
      totalDuration,
      phasesCompleted,
      branchName,
      prUrl,
    });
  }
}

// ── Prerequisites Check ──

function isCommandOnPath(cmd: string): boolean {
  try {
    const whichCmd = process.platform === "win32" ? "where" : "which";
    execSync(`${whichCmd} ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function getScriptType(): "sh" | "ps" {
  return process.platform === "win32" ? "ps" : "sh";
}

async function runPrerequisites(
  config: RunConfig,
  emit: EmitFn,
  runId: string,
  rlog: RunLogger
): Promise<void> {
  rlog.run("INFO", "runPrerequisites: starting prerequisites checks");
  emit({ type: "prerequisites_started", runId });

  // Create a phase trace so the stage appears in preCycleStages
  const phaseTraceId = crypto.randomUUID();
  createPhaseTrace({
    id: phaseTraceId,
    runId,
    specDir: "",
    phaseNumber: 0,
    phaseName: "loop:prerequisites",
  });

  emit({
    type: "stage_started",
    runId,
    cycleNumber: 0,
    stage: "prerequisites",
    phaseTraceId,
  });

  const startTime = Date.now();

  const emitCheck = (check: PrerequisiteCheck) => {
    emit({ type: "prerequisites_check", runId, check });
  };

  // Track final status of each check
  const checkResults = new Map<PrerequisiteCheckName, "pass" | "fail" | "fixed">();

  // ── Check 1: Claude CLI ──
  emitCheck({ name: "claude_cli", status: "running" });
  let claudeOk = isCommandOnPath("claude");
  if (claudeOk) {
    rlog.run("INFO", "runPrerequisites: claude CLI found");
    emitCheck({ name: "claude_cli", status: "pass" });
    checkResults.set("claude_cli", "pass");
  } else {
    rlog.run("WARN", "runPrerequisites: claude CLI not found");
    emitCheck({ name: "claude_cli", status: "fail", message: "Claude Code CLI not found on PATH" });

    let resolved = false;
    while (!resolved) {
      if (abortController?.signal.aborted) return;
      const answers = await waitForUserInput(emit, runId, [{
        question: "Claude Code CLI is not installed or not on your PATH. Please install it and try again.",
        header: "Missing: Claude CLI",
        options: [
          { label: "I've installed it — check again", description: "Re-run the check after you've installed Claude Code" },
          { label: "Skip this check", description: "Proceed without verifying (not recommended)" },
        ],
        multiSelect: false,
      }]);
      const answer = Object.values(answers)[0];
      if (answer === "Skip this check") {
        emitCheck({ name: "claude_cli", status: "fixed", message: "Skipped by user" });
        checkResults.set("claude_cli", "fixed");
        resolved = true;
      } else {
        claudeOk = isCommandOnPath("claude");
        if (claudeOk) {
          emitCheck({ name: "claude_cli", status: "pass" });
          checkResults.set("claude_cli", "pass");
          resolved = true;
        } else {
          emitCheck({ name: "claude_cli", status: "fail", message: "Still not found — please check your PATH" });
        }
      }
    }
  }

  // ── Check 2: Specify CLI ──
  emitCheck({ name: "specify_cli", status: "running" });
  let specifyOk = isCommandOnPath("specify");
  if (specifyOk) {
    rlog.run("INFO", "runPrerequisites: specify CLI found");
    emitCheck({ name: "specify_cli", status: "pass" });
    checkResults.set("specify_cli", "pass");
  } else {
    rlog.run("WARN", "runPrerequisites: specify CLI not found");
    emitCheck({ name: "specify_cli", status: "fail", message: "Spec-Kit CLI not found on PATH" });

    let resolved = false;
    while (!resolved) {
      if (abortController?.signal.aborted) return;
      const answers = await waitForUserInput(emit, runId, [{
        question: "Spec-Kit CLI (specify) is not installed. Install it with:\n\nuv tool install specify-cli --from git+https://github.com/github/spec-kit.git\n\nThen try again.",
        header: "Missing: Spec-Kit CLI",
        options: [
          { label: "I've installed it — check again", description: "Re-run the check after you've installed spec-kit" },
          { label: "Skip this check", description: "Proceed without spec-kit (the loop will likely fail)" },
        ],
        multiSelect: false,
      }]);
      const answer = Object.values(answers)[0];
      if (answer === "Skip this check") {
        emitCheck({ name: "specify_cli", status: "fixed", message: "Skipped by user" });
        checkResults.set("specify_cli", "fixed");
        resolved = true;
      } else {
        specifyOk = isCommandOnPath("specify");
        if (specifyOk) {
          emitCheck({ name: "specify_cli", status: "pass" });
          checkResults.set("specify_cli", "pass");
          resolved = true;
        } else {
          emitCheck({ name: "specify_cli", status: "fail", message: "Still not found — please check your PATH" });
        }
      }
    }
  }

  // ── Check 3: Git repository ──
  emitCheck({ name: "git_init", status: "running" });
  const gitDir = path.join(config.projectDir, ".git");
  if (fs.existsSync(gitDir)) {
    rlog.run("INFO", "runPrerequisites: git repo already exists");
    emitCheck({ name: "git_init", status: "pass" });
    checkResults.set("git_init", "pass");
  } else {
    rlog.run("INFO", "runPrerequisites: initializing git repo");
    try {
      execSync("git init", {
        cwd: config.projectDir,
        stdio: "pipe",
        timeout: 15_000,
      });
      if (fs.existsSync(gitDir)) {
        rlog.run("INFO", "runPrerequisites: git init succeeded");
        emitCheck({ name: "git_init", status: "pass" });
        checkResults.set("git_init", "pass");
      } else {
        rlog.run("WARN", "runPrerequisites: git init ran but .git/ not found");
        emitCheck({ name: "git_init", status: "fail", message: "git init ran but .git/ directory was not created" });
        checkResults.set("git_init", "fail");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      rlog.run("ERROR", "runPrerequisites: git init failed", { error: msg });
      emitCheck({ name: "git_init", status: "fail", message: `git init failed: ${msg}` });
      checkResults.set("git_init", "fail");
    }
  }

  // ── Check 4: Spec-Kit initialized in project ──
  emitCheck({ name: "speckit_init", status: "running" });
  const integrationJson = path.join(config.projectDir, ".specify", "integration.json");
  if (fs.existsSync(integrationJson)) {
    rlog.run("INFO", "runPrerequisites: spec-kit already initialized");
    emitCheck({ name: "speckit_init", status: "pass" });
    checkResults.set("speckit_init", "pass");
  } else if (specifyOk) {
    // Auto-run specify init
    rlog.run("INFO", "runPrerequisites: running specify init");
    try {
      const scriptType = getScriptType();
      execSync(`specify init . --force --ai claude --script ${scriptType}`, {
        cwd: config.projectDir,
        stdio: "pipe",
        timeout: 60_000,
      });
      if (fs.existsSync(integrationJson)) {
        rlog.run("INFO", "runPrerequisites: specify init succeeded");
        emitCheck({ name: "speckit_init", status: "pass" });
        checkResults.set("speckit_init", "pass");
      } else {
        rlog.run("WARN", "runPrerequisites: specify init ran but integration.json not found");
        emitCheck({ name: "speckit_init", status: "fail", message: "specify init ran but .specify/integration.json was not created" });
        checkResults.set("speckit_init", "fail");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      rlog.run("ERROR", "runPrerequisites: specify init failed", { error: msg });
      emitCheck({ name: "speckit_init", status: "fail", message: `specify init failed: ${msg}` });
      checkResults.set("speckit_init", "fail");
    }
  } else {
    rlog.run("WARN", "runPrerequisites: cannot init spec-kit — specify CLI not available");
    emitCheck({ name: "speckit_init", status: "fail", message: "Cannot initialize — specify CLI not available" });
    checkResults.set("speckit_init", "fail");
  }

  // ── Check 5: GitHub repository (optional) ──
  // Runs after spec-kit init so the initial commit includes all generated files
  emitCheck({ name: "github_repo", status: "running" });
  let hasRemote = false;
  try {
    const remote = execSync("git remote get-url origin", {
      cwd: config.projectDir,
      stdio: "pipe",
      timeout: 5_000,
    }).toString().trim();
    hasRemote = remote.length > 0;
  } catch {
    // No remote configured
  }

  if (hasRemote) {
    rlog.run("INFO", "runPrerequisites: GitHub remote already configured");
    emitCheck({ name: "github_repo", status: "pass" });
    checkResults.set("github_repo", "pass");
  } else {
    const ghOk = isCommandOnPath("gh");
    if (!ghOk) {
      rlog.run("INFO", "runPrerequisites: gh CLI not found, skipping GitHub repo setup");
      emitCheck({ name: "github_repo", status: "fixed", message: "GitHub CLI (gh) not installed — skipped" });
      checkResults.set("github_repo", "fixed");
    } else {
      let ghAuthed = false;
      try {
        execSync("gh auth status", { cwd: config.projectDir, stdio: "pipe", timeout: 10_000 });
        ghAuthed = true;
      } catch {
        // Not authenticated
      }

      if (!ghAuthed) {
        rlog.run("INFO", "runPrerequisites: gh not authenticated, skipping GitHub repo setup");
        emitCheck({ name: "github_repo", status: "fixed", message: "GitHub CLI not authenticated — run 'gh auth login' to enable" });
        checkResults.set("github_repo", "fixed");
      } else {
        if (abortController?.signal.aborted) return;
        const answers = await waitForUserInput(emit, runId, [{
          question: "Would you like to create a GitHub repository for this project?",
          header: "GitHub Repository (optional)",
          options: [
            { label: "Yes — create a new repo", description: "Create a GitHub repository and push this project" },
            { label: "No — skip", description: "Continue without a GitHub remote" },
          ],
          multiSelect: false,
        }]);
        const answer = Object.values(answers)[0];

        if (answer === "No — skip") {
          emitCheck({ name: "github_repo", status: "fixed", message: "Skipped by user" });
          checkResults.set("github_repo", "fixed");
        } else {
          if (abortController?.signal.aborted) return;
          const repoAnswers = await waitForUserInput(emit, runId, [{
            question: "Enter the name for your new GitHub repository:",
            header: "Repository Name",
            options: [
              { label: path.basename(config.projectDir), description: "Use project folder name" },
            ],
            multiSelect: false,
          }]);
          const repoName = Object.values(repoAnswers)[0];

          rlog.run("INFO", `runPrerequisites: creating GitHub repo '${repoName}'`);
          try {
            // Commit all files created during prerequisites (GOAL.md, .specify/, .claude/, etc.)
            execSync("git add -A -- ':!.dex/' && git commit -m \"Initial project setup (prerequisites)\"", {
              cwd: config.projectDir,
              stdio: "pipe",
              timeout: 10_000,
            });
            execSync(`gh repo create "${repoName}" --private --source . --push`, {
              cwd: config.projectDir,
              stdio: "pipe",
              timeout: 30_000,
            });
            rlog.run("INFO", "runPrerequisites: GitHub repo created successfully");
            emitCheck({ name: "github_repo", status: "pass" });
            checkResults.set("github_repo", "pass");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            rlog.run("ERROR", "runPrerequisites: gh repo create failed", { error: msg });
            emitCheck({ name: "github_repo", status: "fail", message: `Failed to create repo: ${msg}` });
            checkResults.set("github_repo", "fail");
          }
        }
      }
    }
  }

  // ── If any check failed, block until user acknowledges ──
  const failedChecks = [...checkResults.entries()].filter(([, s]) => s === "fail");
  if (failedChecks.length > 0) {
    const failedNames = failedChecks.map(([name]) => name).join(", ");
    rlog.run("WARN", `runPrerequisites: ${failedChecks.length} check(s) failed: ${failedNames}`);

    await waitForUserInput(emit, runId, [{
      question: `${failedChecks.length} prerequisite check(s) failed: ${failedNames}. You can continue, but the loop may not work correctly.`,
      header: "Prerequisites incomplete",
      options: [
        { label: "Continue anyway", description: "Proceed to clarification despite failed checks" },
      ],
      multiSelect: false,
    }]);
  }

  const allPassed = failedChecks.length === 0;
  const durationMs = Date.now() - startTime;
  completePhaseTrace(phaseTraceId, allPassed ? "completed" : "completed", 0, durationMs, 0, 0);

  emit({
    type: "stage_completed",
    runId,
    cycleNumber: 0,
    stage: "prerequisites",
    phaseTraceId,
    costUsd: 0,
    durationMs,
  });

  emit({ type: "prerequisites_completed", runId });
  rlog.run("INFO", "runPrerequisites: completed", { durationMs, allPassed });
}

// ── Loop Mode Runner ──

async function runLoop(
  config: RunConfig,
  emit: EmitFn,
  runId: string,
  rlog: RunLogger
): Promise<{ phasesCompleted: number; totalCost: number; baseBranch: string; branchName: string }> {
  // Validate: loop mode requires a GOAL.md input
  const goalPath = config.descriptionFile ?? path.join(config.projectDir, "GOAL.md");
  if (!fs.existsSync(goalPath)) {
    throw new Error(`Loop mode requires GOAL.md at ${goalPath}`);
  }

  // Detect stale state from a different branch or completed run
  if (config.resume) {
    const staleCheck = await detectStaleState(config.projectDir);
    if (staleCheck === "stale" || staleCheck === "completed") {
      rlog.run("INFO", `runLoop: stale state detected (${staleCheck}) — clearing and starting fresh`);
      await clearState(config.projectDir);
      config = { ...config, resume: false };
    } else if (staleCheck === "none") {
      rlog.run("INFO", "runLoop: no state file found — starting fresh");
      config = { ...config, resume: false };
    }
  }

  const clarifiedPath = path.join(config.projectDir, "GOAL_clarified.md");
  let fullPlanPath = "";
  let cumulativeCost = 0;
  let cyclesCompleted = 0;
  const featuresCompleted: string[] = [];
  const featuresSkipped: string[] = [];
  const failureTracker = new Map<string, FailureRecord>();

  const getOrCreateFailureRecord = (specDir: string): FailureRecord => {
    let record = failureTracker.get(specDir);
    if (!record) {
      record = { specDir, implFailures: 0, replanFailures: 0 };
      failureTracker.set(specDir, record);
    }
    return record;
  };

  const persistFailure = (specDir: string) => {
    const record = getOrCreateFailureRecord(specDir);
    upsertFailureRecord(runId, specDir, record.implFailures, record.replanFailures);
    // Also persist to state file
    updateState(config.projectDir, {
      failureCounts: { [specDir]: { implFailures: record.implFailures, replanFailures: record.replanFailures } },
    }).catch(() => { /* state write failure shouldn't crash the run */ });
  };

  // ── Determine resume context from state file ──
  let resumeSpecDir: string | null = null;
  let resumeLastStage: string | null = null;
  if (config.resume) {
    // Resolve working-tree vs committed state (crash recovery)
    let savedState = await resolveWorkingTreeConflict(config.projectDir);
    if (!savedState) {
      savedState = await loadState(config.projectDir);
    }

    if (savedState) {
      // Reconcile artifact integrity
      const reconciliation = await reconcileState(config.projectDir, savedState, emit, runId);

      // Apply state patches from reconciliation
      if (Object.keys(reconciliation.statePatches).length > 0) {
        await updateState(config.projectDir, reconciliation.statePatches);
      }

      // Log warnings
      for (const w of reconciliation.warnings) {
        rlog.run("WARN", `runLoop: reconciliation: ${w}`);
      }

      // Restore position from state file
      resumeSpecDir = savedState.currentSpecDir;
      resumeLastStage = savedState.lastCompletedStage;
      cumulativeCost = savedState.cumulativeCostUsd;
      cyclesCompleted = savedState.cyclesCompleted;
      featuresCompleted.push(...savedState.featuresCompleted);
      featuresSkipped.push(...savedState.featuresSkipped);
      fullPlanPath = savedState.fullPlanPath ?? "";

      // Restore failure counts from state file
      for (const [specDir, counts] of Object.entries(savedState.failureCounts)) {
        failureTracker.set(specDir, {
          specDir,
          implFailures: counts.implFailures,
          replanFailures: counts.replanFailures,
        });
      }

      // Use reconciliation resume point if drift was detected
      if (reconciliation.resumeFrom.specDir) {
        resumeSpecDir = reconciliation.resumeFrom.specDir;
      }

      rlog.run("INFO", "runLoop: resuming from state file", {
        resumeSpecDir,
        resumeLastStage,
        cumulativeCost,
        cyclesCompleted,
        drift: reconciliation.driftSummary,
      });
    }
  }

  const isResume = !!config.resume;

  // ── Phase 0: Prerequisites (skip on resume) ──
  if (!isResume) {
    await runPrerequisites(config, emit, runId, rlog);
    if (abortController?.signal.aborted) {
      emit({ type: "loop_terminated", runId, termination: { reason: "user_abort", cyclesCompleted: 0, totalCostUsd: 0, totalDurationMs: 0, featuresCompleted: [], featuresSkipped: [] } });
      return { phasesCompleted: 0, totalCost: 0, baseBranch: "", branchName: "" };
    }
  } else {
    rlog.run("INFO", "runLoop: skipping prerequisites (resume)");
    // Emit synthetic events so the UI can reconstruct the stepper state
    emit({ type: "prerequisites_started", runId });
    const prereqTraceId = crypto.randomUUID();
    emit({ type: "stage_started", runId, cycleNumber: 0, stage: "prerequisites", phaseTraceId: prereqTraceId });
    emit({ type: "stage_completed", runId, cycleNumber: 0, stage: "prerequisites", phaseTraceId: prereqTraceId, costUsd: 0, durationMs: 0 });
    emit({ type: "prerequisites_completed", runId });
  }

  // ── Create git branch (skip on resume — stay on current branch) ──
  let baseBranch: string;
  let branchName: string;
  if (isResume) {
    branchName = getCurrentBranch(config.projectDir);
    // Infer base branch — typically "main" or "master"
    try {
      execSync("git rev-parse --verify main", { cwd: config.projectDir, stdio: "ignore" });
      baseBranch = "main";
    } catch {
      baseBranch = "master";
    }
    rlog.run("INFO", `runLoop: resuming on branch ${branchName}, baseBranch=${baseBranch}`);
  } else {
    baseBranch = getCurrentBranch(config.projectDir);
    branchName = createBranch(config.projectDir, config.mode);
    rlog.run("INFO", `runLoop: created branch ${branchName} from ${baseBranch}`);
    // Persist branch info to state so detectStaleState can match on resume
    if (activeProjectDir) {
      await updateState(activeProjectDir, { branchName, baseBranch });
    }
  }

  // ── Phase A: Multi-Domain Clarification ──
  // Skip if specs already exist (resume mode) — use existing GOAL_clarified.md
  // Helper to emit a synthetic completed stage event (for skipped stages)
  const emitSkippedStage = (stage: import("./types.js").LoopStageType, cycleNum = 0) => {
    const traceId = crypto.randomUUID();
    createPhaseTrace({ id: traceId, runId, specDir: "", phaseNumber: cycleNum, phaseName: `loop:${stage}` });
    emit({ type: "stage_started", runId, cycleNumber: cycleNum, stage, phaseTraceId: traceId });
    completePhaseTrace(traceId, "completed", 0, 0);
    emit({ type: "stage_completed", runId, cycleNumber: cycleNum, stage, phaseTraceId: traceId, costUsd: 0, durationMs: 0 });
  };

  const existingSpecsAtStart = listSpecDirs(config.projectDir);
  if (existingSpecsAtStart.length > 0 && fs.existsSync(clarifiedPath)) {
    fullPlanPath = clarifiedPath;
    rlog.run("INFO", `runLoop: specs exist (${existingSpecsAtStart.length}), skipping clarification, using ${clarifiedPath}`);
    // Emit synthetic clarification events so the UI stepper advances past clarification
    emit({ type: "clarification_started", runId });
    emitSkippedStage("clarification_product");
    emitSkippedStage("clarification_technical");
    emitSkippedStage("clarification_synthesis");
    emitSkippedStage("constitution");
    emit({ type: "clarification_completed", runId, fullPlanPath: clarifiedPath });
  } else {
    emit({ type: "clarification_started", runId });
    rlog.run("INFO", "runLoop: starting multi-domain clarification (Phase A)");

    if (currentRunState) {
      currentRunState.isClarifying = true;
    }

    // Step 1: Product domain clarification
    const productDomainPath = path.join(config.projectDir, "GOAL_product_domain.md");
    if (!fs.existsSync(productDomainPath)) {
      rlog.run("INFO", "runLoop: starting product domain clarification");
      const prompt = buildProductClarificationPrompt(goalPath);
      const result = await runStage(config, prompt, emit, rlog, runId, 0, "clarification_product");
      cumulativeCost += result.cost;
      if (abortController?.signal.aborted) throw new AbortError();
      if (!fs.existsSync(productDomainPath)) {
        throw new Error("Product clarification completed but GOAL_product_domain.md not found");
      }
    } else {
      rlog.run("INFO", "runLoop: GOAL_product_domain.md exists, skipping product clarification");
      emitSkippedStage("clarification_product");
    }

    // Step 2: Technical domain clarification
    if (abortController?.signal.aborted) throw new AbortError();
    const technicalDomainPath = path.join(config.projectDir, "GOAL_technical_domain.md");
    if (!fs.existsSync(technicalDomainPath)) {
      rlog.run("INFO", "runLoop: starting technical domain clarification");
      const prompt = buildTechnicalClarificationPrompt(goalPath, productDomainPath);
      const result = await runStage(config, prompt, emit, rlog, runId, 0, "clarification_technical");
      cumulativeCost += result.cost;
      if (abortController?.signal.aborted) throw new AbortError();
      if (!fs.existsSync(technicalDomainPath)) {
        throw new Error("Technical clarification completed but GOAL_technical_domain.md not found");
      }
    } else {
      rlog.run("INFO", "runLoop: GOAL_technical_domain.md exists, skipping technical clarification");
      emitSkippedStage("clarification_technical");
    }

    // Step 3: Synthesis → GOAL_clarified.md + CLAUDE.md (with structured confirmation)
    if (abortController?.signal.aborted) throw new AbortError();
    if (!fs.existsSync(clarifiedPath)) {
      rlog.run("INFO", "runLoop: starting clarification synthesis");
      const prompt = buildClarificationSynthesisPrompt(goalPath, productDomainPath, technicalDomainPath);
      const result = await runStage(
        config, prompt, emit, rlog, runId, 0, "clarification_synthesis", undefined,
        { type: "json_schema", schema: SYNTHESIS_SCHEMA as unknown as Record<string, unknown> }
      );
      cumulativeCost += result.cost;
      if (abortController?.signal.aborted) throw new AbortError();

      // Try structured output first, fall back to filesystem probing
      const synthesisOutput = result.structuredOutput as { filesProduced?: string[]; goalClarifiedPath?: string } | null;
      if (synthesisOutput?.goalClarifiedPath) {
        const resolvedPath = path.isAbsolute(synthesisOutput.goalClarifiedPath)
          ? synthesisOutput.goalClarifiedPath
          : path.join(config.projectDir, synthesisOutput.goalClarifiedPath);
        if (!fs.existsSync(resolvedPath)) {
          rlog.run("WARN", `Synthesis structured output claimed ${synthesisOutput.goalClarifiedPath} but file not found — falling back to filesystem check`);
        }
      }

      if (!fs.existsSync(clarifiedPath)) {
        throw new Error("Synthesis completed but GOAL_clarified.md not found");
      }
    } else {
      rlog.run("INFO", "runLoop: GOAL_clarified.md exists, skipping synthesis");
      emitSkippedStage("clarification_synthesis");
    }

    fullPlanPath = clarifiedPath;

    // Step 4: Constitution (final step of clarification)
    // The file may exist as an unfilled template (with [PLACEHOLDER] tokens) from `specify init`.
    // Only skip if it exists AND has been filled (no placeholder tokens remain).
    if (abortController?.signal.aborted) throw new AbortError();
    const constitutionPath = path.join(config.projectDir, ".specify", "memory", "constitution.md");
    const constitutionNeedsGeneration = !fs.existsSync(constitutionPath)
      || fs.readFileSync(constitutionPath, "utf-8").includes("[PROJECT_NAME]");
    if (constitutionNeedsGeneration) {
      rlog.run("INFO", "runLoop: generating constitution");
      const prompt = buildConstitutionPrompt(config, fullPlanPath);
      const result = await runStage(config, prompt, emit, rlog, runId, 0, "constitution");
      cumulativeCost += result.cost;
    } else {
      rlog.run("INFO", "runLoop: constitution already filled, skipping");
      emitSkippedStage("constitution");
    }

    emit({ type: "clarification_completed", runId, fullPlanPath });
    rlog.run("INFO", `runLoop: clarification completed, fullPlanPath=${fullPlanPath}`);

    if (currentRunState) {
      currentRunState.isClarifying = false;
    }
  }

  // ── Manifest Extraction (one-time after clarification) ──

  let manifest = loadManifest(config.projectDir);
  if (!manifest) {
    type ManifestExtraction = { features: Array<{ id: number; title: string; description: string }> };
    let extracted: ManifestExtraction | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const prompt = buildManifestExtractionPrompt(fullPlanPath);
        const result = await runStage(
          config, prompt, emit, rlog, runId, 0,
          "manifest_extraction", undefined,
          { type: "json_schema", schema: MANIFEST_SCHEMA as unknown as Record<string, unknown> }
        );
        cumulativeCost += result.cost;
        extracted = result.structuredOutput as ManifestExtraction | null;
        if (!extracted) {
          rlog.run("WARN", `Manifest extraction attempt ${attempt}: structured_output was null`);
          if (attempt === 2) throw new Error("Manifest extraction failed after 2 attempts — structured output was null. Check GOAL_clarified.md format.");
          continue;
        }
        if (!extracted.features?.length) {
          rlog.run("WARN", `Manifest extraction attempt ${attempt}: empty features array`);
          if (attempt === 2) throw new Error("Manifest extraction failed after 2 attempts — extracted zero features. Check GOAL_clarified.md format.");
          continue;
        }
        break;
      } catch (err) {
        rlog.run("ERROR", `Manifest extraction attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`);
        if (attempt === 2) throw new Error("Manifest extraction failed after 2 attempts — cannot proceed without a feature manifest. Check GOAL_clarified.md format.");
      }
    }
    manifest = {
      version: 1,
      sourceHash: hashManifestFile(fullPlanPath),
      features: extracted!.features.map((f) => ({
        ...f,
        status: "pending" as const,
        specDir: null,
      })),
    };
    saveManifest(config.projectDir, manifest);
    emit({ type: "manifest_created", runId, featureCount: manifest.features.length });
    rlog.run("INFO", `runLoop: manifest created with ${manifest.features.length} features`);
  } else if (checkSourceDrift(config.projectDir, manifest, fullPlanPath)) {
    rlog.run("WARN", "GOAL_clarified.md has changed since manifest was created");
    emit({ type: "manifest_drift_detected", runId });
  }

  // ── Phase B: Autonomous Loop ──

  while (true) {
    // Check abort
    if (abortController?.signal.aborted) {
      rlog.run("INFO", "runLoop: abort detected");
      break;
    }

    // Check max cycles
    if (config.maxLoopCycles && cyclesCompleted >= config.maxLoopCycles) {
      rlog.run("INFO", `runLoop: max cycles reached (${config.maxLoopCycles})`);
      break;
    }

    // Check budget
    if (config.maxBudgetUsd && cumulativeCost >= config.maxBudgetUsd) {
      rlog.run("INFO", `runLoop: budget exceeded ($${cumulativeCost.toFixed(2)} >= $${config.maxBudgetUsd})`);
      break;
    }

    const cycleNumber = cyclesCompleted + 1;
    const cycleId = crypto.randomUUID();
    const cycleStart = Date.now();

    emit({ type: "loop_cycle_started", runId, cycleNumber });
    rlog.run("INFO", `runLoop: starting cycle ${cycleNumber}`);

    if (currentRunState) {
      currentRunState.currentCycle = cycleNumber;
    }

    // ── Gap Analysis — Deterministic Manifest Walk ──
    let decision: GapAnalysisDecision;
    if (resumeSpecDir && cycleNumber === cyclesCompleted + 1) {
      decision = { type: "RESUME_FEATURE", specDir: resumeSpecDir };
      rlog.run("INFO", `runLoop: resume — skipping gap analysis, using RESUME_FEATURE for ${resumeSpecDir}`);
      const traceId = crypto.randomUUID();
      createPhaseTrace({ id: traceId, runId, specDir: resumeSpecDir, phaseNumber: cycleNumber, phaseName: "loop:gap_analysis" });
      emit({ type: "stage_started", runId, cycleNumber, stage: "gap_analysis", phaseTraceId: traceId });
      completePhaseTrace(traceId, "completed", 0, 0);
      emit({ type: "stage_completed", runId, cycleNumber, stage: "gap_analysis", phaseTraceId: traceId, costUsd: 0, durationMs: 0 });
      resumeSpecDir = null;
    } else {
      try {
        const manifest = loadManifest(config.projectDir);
        if (!manifest) {
          throw new Error("Feature manifest not found — manifest extraction should have run before the loop");
        }

        if (currentRunState) {
          currentRunState.currentStage = "gap_analysis";
        }

        const active = getActiveFeature(manifest);
        const nextPending = getNextFeature(manifest);

        // Emit a synthetic (deterministic, cost=0) gap_analysis stage so the UI shows it completed
        const emitSyntheticGapAnalysis = (specDir: string) => {
          const traceId = crypto.randomUUID();
          createPhaseTrace({ id: traceId, runId, specDir, phaseNumber: cycleNumber, phaseName: "loop:gap_analysis" });
          emit({ type: "stage_started", runId, cycleNumber, stage: "gap_analysis", phaseTraceId: traceId, specDir });
          completePhaseTrace(traceId, "completed", 0, 0);
          emit({ type: "stage_completed", runId, cycleNumber, stage: "gap_analysis", phaseTraceId: traceId, costUsd: 0, durationMs: 0 });
        };

        if (active) {
          if (active.specDir) {
            // Active feature with specDir — evaluate RESUME vs REPLAN (LLM call)
            const evaluationPrompt = buildFeatureEvaluationPrompt(config, active.specDir);
            const evalResult = await runStage(
              config, evaluationPrompt, emit, rlog, runId, cycleNumber,
              "gap_analysis", active.specDir,
              { type: "json_schema", schema: GAP_ANALYSIS_SCHEMA as unknown as Record<string, unknown> }
            );
            cumulativeCost += evalResult.cost;
            const evaluation = evalResult.structuredOutput as { decision: string; reason: string } | null;
            if (!evaluation) {
              throw new Error(`Gap analysis for ${active.specDir} returned null structured output — cannot determine RESUME vs REPLAN`);
            }
            if (evaluation.decision === "REPLAN_FEATURE") {
              decision = { type: "REPLAN_FEATURE", specDir: active.specDir };
            } else {
              decision = { type: "RESUME_FEATURE", specDir: active.specDir };
            }
          } else {
            // Active but no specDir — re-run specify for this feature (deterministic)
            emitSyntheticGapAnalysis("");
            decision = {
              type: "NEXT_FEATURE",
              name: active.title,
              description: active.description,
              featureId: active.id,
            };
          }
        } else if (nextPending) {
          // Deterministic — no LLM call needed
          updateFeatureStatus(config.projectDir, nextPending.id, "active");
          emitSyntheticGapAnalysis("");
          decision = {
            type: "NEXT_FEATURE",
            name: nextPending.title,
            description: nextPending.description,
            featureId: nextPending.id,
          };
        } else {
          decision = { type: "GAPS_COMPLETE" };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        rlog.run("ERROR", `runLoop: gap analysis failed: ${msg}`);
        emit({ type: "error", message: `Gap analysis failed: ${msg}` });
        break;
      }
    }

    // Record the cycle
    const decisionType = decision.type;
    const featureName = decision.type === "NEXT_FEATURE" ? decision.name : null;
    let specDir = decision.type === "RESUME_FEATURE" || decision.type === "REPLAN_FEATURE"
      ? decision.specDir
      : null;
    let cycleFailed = false;

    insertLoopCycle({
      id: cycleId,
      runId,
      cycleNumber,
      featureName,
      specDir,
      decision: decisionType,
    });

    // ── GAPS_COMPLETE → terminate ──
    if (decision.type === "GAPS_COMPLETE") {
      rlog.run("INFO", "runLoop: all gaps complete");
      updateLoopCycle(cycleId, "completed", 0, Date.now() - cycleStart);
      emit({
        type: "loop_cycle_completed",
        runId,
        cycleNumber,
        decision: decisionType,
        featureName: null,
        specDir: null,
        costUsd: 0,
      });
      break;
    }

    // ── Failure threshold checks (T038) ──
    if (specDir) {
      const record = getOrCreateFailureRecord(specDir);
      if (record.replanFailures >= 3) {
        rlog.run("WARN", `runLoop: skipping feature at ${specDir} — 3 replan failures`);
        // Mark feature as skipped in manifest
        const skipManifest = loadManifest(config.projectDir);
        if (skipManifest) {
          const skipEntry = skipManifest.features.find((f) => f.specDir === specDir);
          if (skipEntry) updateFeatureStatus(config.projectDir, skipEntry.id, "skipped");
        }
        featuresSkipped.push(specDir);
        updateLoopCycle(cycleId, "skipped", 0, Date.now() - cycleStart);
        emit({
          type: "loop_cycle_completed",
          runId,
          cycleNumber,
          decision: "skipped",
          featureName,
          specDir,
          costUsd: 0,
        });
        // Update FeatureArtifacts.status to "skipped"
        if (activeProjectDir && specDir) {
          updateState(activeProjectDir, {
            artifacts: { features: { [specDir]: { status: "skipped" } } },
            featuresSkipped: [...featuresSkipped],
          } as never).catch(() => {});
        }
        cyclesCompleted++;
        updateRunLoopsCompleted(runId, cyclesCompleted);
        continue;
      }
      if (record.implFailures >= 3) {
        // Force replan
        decision = { type: "REPLAN_FEATURE", specDir };
        rlog.run("WARN", `runLoop: forcing replan for ${specDir} — 3 impl failures`);
      }
    }

    let cycleCost = 0;

    try {
      // ── RESUME_FEATURE: emit synthetic completed events for skipped stages ──
      if (decision.type === "RESUME_FEATURE") {
        emitSkippedStage("specify", cycleNumber);
        emitSkippedStage("plan", cycleNumber);
        emitSkippedStage("tasks", cycleNumber);
      }

      // ── NEXT_FEATURE: specify → plan → tasks → implement → verify → learnings ──
      if (decision.type === "NEXT_FEATURE") {
        // Specify (T030)
        if (currentRunState) {
          currentRunState.currentStage = "specify";
        }
        const knownSpecs = listSpecDirs(config.projectDir);
        const specifyPrompt = buildSpecifyPrompt(decision.name, decision.description);
        const specifyResult = await runStage(config, specifyPrompt, emit, rlog, runId, cycleNumber, "specify");
        cycleCost += specifyResult.cost;

        if (abortController?.signal.aborted) throw new AbortError();

        // Discover the newly created spec directory and link to manifest
        specDir = discoverNewSpecDir(config.projectDir, knownSpecs);
        if (!specDir) {
          throw new Error("Specify completed but no new spec directory was created");
        }
        rlog.run("INFO", `runLoop: new spec directory: ${specDir}`);
        updateFeatureSpecDir(config.projectDir, decision.featureId, specDir);

        // Update FeatureArtifacts.status to "specifying"
        if (activeProjectDir) {
          updateState(activeProjectDir, {
            artifacts: { features: { [specDir]: { specDir, status: "specifying", spec: null, plan: null, tasks: null, lastImplementedPhase: 0 } } },
          } as never).catch(() => {});
        }
      }

      // Plan (T031) — for NEXT_FEATURE and REPLAN_FEATURE
      if (decision.type === "NEXT_FEATURE" || decision.type === "REPLAN_FEATURE") {
        if (abortController?.signal.aborted) throw new AbortError();

        const targetSpecDir = specDir!;
        const specPath = targetSpecDir.startsWith("/")
          ? targetSpecDir
          : path.join(config.projectDir, targetSpecDir);

        if (currentRunState) {
          currentRunState.currentStage = "plan";
        }
        // Update FeatureArtifacts.status to "planning"
        if (activeProjectDir && targetSpecDir) {
          updateState(activeProjectDir, {
            artifacts: { features: { [targetSpecDir]: { status: "planning" } } },
          } as never).catch(() => {});
        }
        const planPrompt = buildLoopPlanPrompt(config, specPath);
        const planResult = await runStage(config, planPrompt, emit, rlog, runId, cycleNumber, "plan", targetSpecDir);
        cycleCost += planResult.cost;

        if (abortController?.signal.aborted) throw new AbortError();

        // Tasks (T031)
        if (currentRunState) {
          currentRunState.currentStage = "tasks";
        }
        const tasksPrompt = buildLoopTasksPrompt(config, specPath);
        const tasksResult = await runStage(config, tasksPrompt, emit, rlog, runId, cycleNumber, "tasks", targetSpecDir);
        cycleCost += tasksResult.cost;
      }

      if (abortController?.signal.aborted) throw new AbortError();

      // Implement (T032)
      const implSpecDir = specDir!;
      const implSpecPath = implSpecDir.startsWith("/")
        ? implSpecDir
        : path.join(config.projectDir, implSpecDir);

      if (currentRunState) {
        currentRunState.currentStage = "implement";
        currentRunState.specDir = implSpecDir;
      }
      // Update FeatureArtifacts.status to "implementing"
      if (activeProjectDir && implSpecDir) {
        updateState(activeProjectDir, {
          artifacts: { features: { [implSpecDir]: { status: "implementing" } } },
        } as never).catch(() => {});
      }

      // Create a stage-level phase trace so the UI shows implement in the stage list
      const implStageTraceId = crypto.randomUUID();
      createPhaseTrace({
        id: implStageTraceId,
        runId,
        specDir: implSpecDir,
        phaseNumber: cycleNumber,
        phaseName: "loop:implement",
      });

      emit({
        type: "stage_started",
        runId,
        cycleNumber,
        stage: "implement",
        phaseTraceId: implStageTraceId,
        specDir: implSpecDir,
      });

      const implStageStart = Date.now();
      let implStageCost = 0;
      let implStageInputTokens = 0;
      let implStageOutputTokens = 0;
      let activePhaseTraceId: string | null = null;
      let implStageFailed = false;

      // Parse tasks.md to get phases, then run each phase.
      // RunTaskState is created ONCE and reused across all phases so that
      // progress from earlier phases is preserved (promote-only semantics).
      const phases = parseTasksFile(config.projectDir, implSpecDir);
      const implConfig = { ...config, specDir: implSpecDir };
      const runTaskState = new RunTaskState(phases);

      // Emit initial task state so the UI can show the spec card immediately
      emit({ type: "tasks_updated", phases: runTaskState.getPhases() });

      try {
        for (const phase of phases) {
          if (abortController?.signal.aborted) break;
          if (phase.status === "complete") continue;

          const phaseTraceId = crypto.randomUUID();
          activePhaseTraceId = phaseTraceId;
          createPhaseTrace({
            id: phaseTraceId,
            runId,
            specDir: implSpecDir,
            phaseNumber: phase.number,
            phaseName: phase.name,
          });

          if (currentRunState) {
            currentRunState.phaseTraceId = phaseTraceId;
            currentRunState.phaseNumber = phase.number;
            currentRunState.phaseName = phase.name;
          }

          emit({ type: "phase_started", phase, iteration: 0, phaseTraceId });

          const phaseResult = await runPhase(implConfig, phase, phaseTraceId, emit, rlog, runTaskState);
          completePhaseTrace(
            phaseTraceId,
            "completed",
            phaseResult.cost,
            phaseResult.durationMs,
            phaseResult.inputTokens || undefined,
            phaseResult.outputTokens || undefined
          );
          activePhaseTraceId = null;
          cycleCost += phaseResult.cost;
          implStageCost += phaseResult.cost;
          implStageInputTokens += phaseResult.inputTokens;
          implStageOutputTokens += phaseResult.outputTokens;

          // Reconcile task state from disk
          const freshPhases = parseTasksFile(config.projectDir, implSpecDir);
          runTaskState.reconcileFromDisk(freshPhases);
          emit({ type: "tasks_updated", phases: runTaskState.getPhases() });
          emit({
            type: "phase_completed",
            phase: { ...phase, status: "complete" },
            cost: phaseResult.cost,
            durationMs: phaseResult.durationMs,
          });
        }
      } catch (implErr) {
        implStageFailed = true;
        // Mark any in-flight phase trace as failed so it doesn't dangle as "running"
        if (activePhaseTraceId) {
          try {
            completePhaseTrace(activePhaseTraceId, "failed", 0, Date.now() - implStageStart);
          } catch { /* best-effort */ }
        }
        throw implErr;
      } finally {
        // Always close the loop:implement stage trace, even on exception, so the
        // UI never sees an orphaned "running" implement stage.
        const implStageDurationMs = Date.now() - implStageStart;
        const implAborted = abortController?.signal.aborted ?? false;
        const implFinalStatus = implAborted ? "stopped" : implStageFailed ? "failed" : "completed";
        completePhaseTrace(implStageTraceId, implFinalStatus, implStageCost, implStageDurationMs, implStageInputTokens || undefined, implStageOutputTokens || undefined);
        emit({
          type: "stage_completed",
          runId,
          cycleNumber,
          stage: "implement",
          phaseTraceId: implStageTraceId,
          costUsd: implStageCost,
          durationMs: implStageDurationMs,
          ...(implAborted ? { stopped: true } : {}),
        });
      }

      // The implement stage trace and stage_completed event were already emitted
      // in the finally block above. Now decide whether to continue to verify/learnings.
      const implAborted = abortController?.signal.aborted ?? false;

      if (implAborted) throw new AbortError();

      // Verify — structured output with fix-reverify loop
      if (currentRunState) {
        currentRunState.currentStage = "verify";
      }
      // Update FeatureArtifacts.status to "verifying"
      if (activeProjectDir && implSpecDir) {
        updateState(activeProjectDir, {
          artifacts: { features: { [implSpecDir]: { status: "verifying" } } },
        } as never).catch(() => {});
      }
      const verifyPrompt = buildVerifyPrompt(config, implSpecPath, fullPlanPath);
      const verifyResult = await runStage(
        config, verifyPrompt, emit, rlog, runId, cycleNumber, "verify", implSpecDir,
        { type: "json_schema", schema: VERIFY_SCHEMA as unknown as Record<string, unknown> }
      );
      cycleCost += verifyResult.cost;

      type VerifyOutput = {
        passed: boolean;
        buildSucceeded: boolean;
        testsSucceeded: boolean;
        failures: Array<{ criterion: string; description: string; severity: string }>;
        summary: string;
      };

      let verification: VerifyOutput = (verifyResult.structuredOutput as VerifyOutput | null) ?? {
        passed: false,
        buildSucceeded: false,
        testsSucceeded: false,
        failures: [{ criterion: "structured_output", description: "Verify agent did not return structured output", severity: "blocking" }],
        summary: "Verification could not be evaluated — structured output was null",
      };

      if (!verification.passed) {
        const blockingFailures = verification.failures.filter((f) => f.severity === "blocking");
        if (blockingFailures.length > 0) {
          const maxRetries = config.maxVerifyRetries ?? 1;
          for (let retryNum = 1; retryNum <= maxRetries; retryNum++) {
            const currentBlocking = verification.failures.filter((f) => f.severity === "blocking");
            rlog.run("WARN", `runLoop: verify found ${currentBlocking.length} blocking failure(s) — fix attempt ${retryNum}/${maxRetries}`);
            emit({ type: "verify_failed", runId, cycleNumber, blockingCount: currentBlocking.length, summary: verification.summary });

            if (abortController?.signal.aborted) throw new AbortError();

            const fixPrompt = buildVerifyFixPrompt(config, implSpecPath, currentBlocking);
            const fixResult = await runStage(config, fixPrompt, emit, rlog, runId, cycleNumber, "implement_fix", implSpecDir);
            cycleCost += fixResult.cost;

            if (abortController?.signal.aborted) throw new AbortError();

            const reVerifyResult = await runStage(
              config, verifyPrompt, emit, rlog, runId, cycleNumber, "verify", implSpecDir,
              { type: "json_schema", schema: VERIFY_SCHEMA as unknown as Record<string, unknown> }
            );
            cycleCost += reVerifyResult.cost;

            verification = (reVerifyResult.structuredOutput as VerifyOutput | null) ?? {
              passed: false,
              buildSucceeded: false,
              testsSucceeded: false,
              failures: [{ criterion: "structured_output", description: "Re-verify agent did not return structured output", severity: "blocking" }],
              summary: "Re-verification could not be evaluated — structured output was null",
            };

            if (verification.passed) {
              rlog.run("INFO", `runLoop: re-verify passed on attempt ${retryNum}`);
              break;
            }
            if (retryNum === maxRetries) {
              rlog.run("WARN", `runLoop: re-verify still failing after ${maxRetries} fix attempt(s) — proceeding to learnings`);
            }
          }
        }
      }

      if (abortController?.signal.aborted) throw new AbortError();

      // Learnings — structured output with dedup
      if (currentRunState) {
        currentRunState.currentStage = "learnings";
      }
      const learningsPrompt = buildLearningsPrompt(config, implSpecPath);
      const learningsResult = await runStage(
        config, learningsPrompt, emit, rlog, runId, cycleNumber, "learnings", implSpecDir,
        { type: "json_schema", schema: LEARNINGS_SCHEMA as unknown as Record<string, unknown> }
      );
      cycleCost += learningsResult.cost;

      const learnings = learningsResult.structuredOutput as {
        insights: Array<{ category: string; insight: string; context: string }>;
      } | null;

      if (learnings?.insights?.length) {
        appendLearnings(config.projectDir, learnings.insights, config.maxLearningsPerCategory);
      } else if (!learnings) {
        rlog.run("WARN", "runLoop: learnings structured output was null — skipping append");
      }

      // Success — reset failure counters and update manifest
      if (implSpecDir) {
        const record = getOrCreateFailureRecord(implSpecDir);
        record.implFailures = 0;
        record.replanFailures = 0;
        persistFailure(implSpecDir);
      }

      // Mark feature as completed in manifest and FeatureArtifacts if verify passed
      if (verification.passed) {
        if (decision.type === "NEXT_FEATURE") {
          updateFeatureStatus(config.projectDir, decision.featureId, "completed");
        } else if (implSpecDir) {
          const currentManifest = loadManifest(config.projectDir);
          if (currentManifest) {
            const entry = currentManifest.features.find((f) => f.specDir === implSpecDir);
            if (entry) updateFeatureStatus(config.projectDir, entry.id, "completed");
          }
        }
        // Update FeatureArtifacts.status to "completed"
        if (activeProjectDir && implSpecDir) {
          updateState(activeProjectDir, {
            artifacts: { features: { [implSpecDir]: { status: "completed" } } },
          } as never).catch(() => {});
        }
      }

      featuresCompleted.push(featureName ?? implSpecDir);

      // Update state file with feature completion
      if (activeProjectDir) {
        updateState(activeProjectDir, {
          featuresCompleted: [...featuresCompleted],
          cumulativeCostUsd: cumulativeCost + cycleCost,
        }).catch(() => {});
      }

    } catch (err) {
      // AbortError is a clean exit — not a stage failure
      if (err instanceof AbortError) {
        rlog.run("INFO", `runLoop: cycle ${cycleNumber} aborted by user`);
      } else {
        cycleFailed = true;
        // ── Stage failure handling (T040) ──
        const msg = err instanceof Error ? err.message : String(err);
        rlog.run("ERROR", `runLoop: cycle ${cycleNumber} failed: ${msg}`);

        if (specDir) {
          const record = getOrCreateFailureRecord(specDir);
          // Determine which counter to increment based on the current stage
          const currentStage = currentRunState?.currentStage;
          if (currentStage === "plan" || currentStage === "tasks") {
            record.replanFailures++;
          } else {
            record.implFailures++;
          }
          persistFailure(specDir);
        }

        emit({ type: "error", message: `Cycle ${cycleNumber} failed: ${msg}` });
      }
    }

    cumulativeCost += cycleCost;
    const cycleAborted = abortController?.signal.aborted ?? false;
    const cycleStatus = cycleAborted ? "stopped" : cycleFailed ? "failed" : "completed";
    cyclesCompleted++;

    updateLoopCycle(cycleId, cycleStatus, cycleCost, Date.now() - cycleStart);
    updateRunLoopsCompleted(runId, cyclesCompleted);

    // Update state file with cycle completion
    if (activeProjectDir) {
      updateState(activeProjectDir, {
        cumulativeCostUsd: cumulativeCost,
        cyclesCompleted,
        currentCycleNumber: cycleNumber,
      }).catch(() => {});
    }

    if (currentRunState) {
      currentRunState.loopsCompleted = cyclesCompleted;
    }

    emit({
      type: "loop_cycle_completed",
      runId,
      cycleNumber,
      decision: cycleAborted ? "stopped" : decisionType,
      featureName,
      specDir,
      costUsd: cycleCost,
    });

    // Check termination conditions after cycle
    if (abortController?.signal.aborted) break;
    if (config.maxBudgetUsd && cumulativeCost >= config.maxBudgetUsd) break;
    if (config.maxLoopCycles && cyclesCompleted >= config.maxLoopCycles) break;
  }

  // ── Termination (T042) ──
  let terminationReason: TerminationReason = "gaps_complete";
  if (abortController?.signal.aborted) {
    terminationReason = "user_abort";
  } else if (config.maxBudgetUsd && cumulativeCost >= config.maxBudgetUsd) {
    terminationReason = "budget_exceeded";
  } else if (config.maxLoopCycles && cyclesCompleted >= config.maxLoopCycles) {
    terminationReason = "max_cycles_reached";
  }

  const termination: LoopTermination = {
    reason: terminationReason,
    cyclesCompleted,
    totalCostUsd: cumulativeCost,
    totalDurationMs: 0, // Will be set by caller
    featuresCompleted,
    featuresSkipped,
  };

  emit({ type: "loop_terminated", runId, termination });
  rlog.run("INFO", `runLoop: terminated — reason=${terminationReason}, cycles=${cyclesCompleted}, features=${featuresCompleted.length}/${featuresSkipped.length}`);

  return { phasesCompleted: cyclesCompleted, totalCost: cumulativeCost, baseBranch, branchName };
}

export function stopRun(): void {
  if (abortController) {
    console.log("[stopRun] abort signal sent to orchestrator");
    abortController.abort();
  } else {
    console.log("[stopRun] called but no active abortController");
  }
}

export function isRunning(): boolean {
  return abortController !== null;
}
