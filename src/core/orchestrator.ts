import crypto from "node:crypto";
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
import { parseTasksFile, derivePhaseStatus, extractTaskIds } from "./parser.js";
import {
  initDatabase,
  createRun,
  completeRun,
  createPhaseTrace,
  completePhaseTrace,
  insertStep,
  insertSubagent,
  completeSubagent,
} from "./database.js";
import {
  getCurrentBranch,
  createBranch,
  createPullRequest,
} from "./git.js";

// ── Logging ──

const LOGS_ROOT = path.join(os.homedir(), ".ralph-claude", "logs");

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
 *   ~/.ralph-claude/logs/<project-name>/<run-id>/
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
const FALLBACK_LOG = path.join(os.homedir(), ".ralph-claude", "orchestrator.log");
function log(level: "INFO" | "ERROR" | "DEBUG" | "WARN", msg: string, data?: unknown): void {
  fs.mkdirSync(path.dirname(FALLBACK_LOG), { recursive: true });
  fs.appendFileSync(FALLBACK_LOG, formatLogLine(level, msg, data));
}

let abortController: AbortController | null = null;

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
- Commit: git add -A && git commit -m "plan: Phase ${phase.number} gap analysis"`
    : `IMPORTANT — update tasks.md incrementally:
- After completing EACH task, immediately mark it [x] in ${specPath}/tasks.md before moving to the next task. This drives a real-time progress UI.

After implementing all tasks:
- Run build/typecheck to verify changes compile
- Run tests if they exist
- Commit: git add -A && git commit -m "Phase ${phase.number}: ${phase.name}"
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
): Promise<{ cost: number; durationMs: number }> {
  const startTime = Date.now();
  let stepIndex = 0;
  let totalCost = 0;
  const knownSubagentIds = new Set<string>();

  const skillName = config.mode === "plan" ? "speckit-plan" : "speckit-implement";
  const specPath = config.specDir.startsWith("/")
    ? config.specDir
    : `${config.projectDir}/${config.specDir}`;

  const prompt = buildPrompt(config, phase);
  rlog.phase("INFO", `runPhase: spawning agent for Phase ${phase.number}: ${phase.name}`);
  rlog.phase("DEBUG", "runPhase: prompt", { length: prompt.length, prompt });

  // Dual-write helper: emit to UI via IPC + persist to SQLite
  const emitAndStore = (step: AgentStep) => {
    rlog.phase("DEBUG", `emitAndStore: step type=${step.type}`, { id: step.id, seq: step.sequenceIndex });
    emit({ type: "agent_step", step });
    insertStep({ ...step, phaseTraceId });
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
      rlog.phase("DEBUG", "assistant content blocks", {
        blockTypes: content?.map((b) => b.type) ?? [],
        blockCount: content?.length ?? 0,
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
      rlog.phase("INFO", `runPhase: result received`, {
        cost: costUsd,
        durationMs: message.duration_ms,
        isError: message.is_error,
        subtype: message.subtype,
        result: typeof message.result === "string" ? message.result.slice(0, 500) : message.result,
        numTurns: message.num_turns,
        permissionDenials: message.permission_denials,
      });
    }
  }

  const durationMs = Date.now() - startTime;
  rlog.phase("INFO", `runPhase: completed, cost=$${totalCost}, duration=${durationMs}ms`);

  // Emit a completed step at the end
  if (!isAborted()) {
    emitAndStore(makeStep("completed", stepIndex++, `Phase ${phase.number}: ${phase.name} completed`));
  }

  return { cost: totalCost, durationMs };
}

// ── Main Loop ──

export async function run(config: RunConfig, emit: EmitFn): Promise<void> {
  initDatabase();
  abortController = new AbortController();

  // Create a dedicated branch for this run
  const baseBranch = getCurrentBranch(config.projectDir);
  const branchName = createBranch(config.projectDir, config.mode);

  const runId = crypto.randomUUID();
  const projectName = path.basename(config.projectDir);
  const rlog = new RunLogger(projectName, runId);
  rlog.run("INFO", "run: starting orchestrator", { mode: config.mode, model: config.model, specDir: config.specDir, branch: branchName, baseBranch });

  createRun({
    id: runId,
    projectDir: config.projectDir,
    specDir: config.specDir,
    mode: config.mode,
    model: config.model,
  });

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
    // Determine which specs to process
    const specDirs = config.runAllSpecs
      ? listSpecDirs(config.projectDir).filter(
          (s) => !isSpecComplete(config.projectDir, s)
        )
      : [config.specDir];

    if (specDirs.length === 0) {
      rlog.run("INFO", "run: no unfinished specs found");
      return;
    }

    rlog.run("INFO", `run: will process ${specDirs.length} spec(s)`, { specDirs });

    for (const specDir of specDirs) {
      if (abortController.signal.aborted) break;

      // Update the config's specDir for the current spec
      const specConfig = { ...config, specDir };

      emit({ type: "spec_started", specDir });
      if (currentRunState) currentRunState.specDir = specDir;
      rlog.run("INFO", `run: starting spec ${specDir}`);

      // Initialize in-memory task state once per spec. Updated via two paths:
      // 1. TodoWrite detection (PostToolUse hook) — real-time during phase
      // 2. Disk reconciliation (after each phase) — catches Edit tool changes
      const initialPhases = parseTasksFile(config.projectDir, specDir);
      const runTaskState = new RunTaskState(initialPhases);

      let iteration = 0;
      let specFailed = false;

      while (iteration < config.maxIterations) {
        if (abortController.signal.aborted) break;

        const targetPhases = runTaskState.getIncompletePhases(config.phases);

        const phase = targetPhases[0];
        if (!phase) break; // all target phases complete for this spec

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
            result.durationMs
          );

          phasesCompleted++;
          totalCost += result.cost;

          // Reconcile in-memory state with disk — the agent marks tasks [x]
          // by editing tasks.md directly (Edit tool), not just via TodoWrite.
          // Without this, getIncompletePhases() would re-run completed phases.
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
          // Stop the run — phases are sequential and depend on each other
          specFailed = true;
          break;
        }

        iteration++;
      }

      if (!specFailed && !abortController.signal.aborted) {
        rlog.run("INFO", `run: spec ${specDir} completed`);
        emit({ type: "spec_completed", specDir, phasesCompleted });
      }

      // If a spec failed, stop processing further specs
      if (specFailed) break;
    }
  } finally {
    const wasStopped = abortController?.signal.aborted ?? false;
    abortController = null;
    currentRunState = null;

    const totalDuration = Date.now() - runStart;
    const finalStatus = wasStopped ? "stopped" : "completed";
    completeRun(runId, finalStatus, totalCost, totalDuration, phasesCompleted);

    // Create a PR if the run completed successfully with work done
    let prUrl: string | null = null;
    if (!wasStopped && phasesCompleted > 0) {
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

export function stopRun(): void {
  if (abortController) {
    abortController.abort();
  }
}

export function isRunning(): boolean {
  return abortController !== null;
}
