/**
 * What: One Claude Agent SDK `query()` session — the options (`buildQueryOptions`, from the project's policy), the trace and permission hooks, the message loop and the usage totals. Shared by `runStep` and `runTaskPhase`, so both get the same abort, environment, system prompt, permission chain and accounting.
 * Not: Does not build prompts. Does not decide what a tool call may do — permissions.ts does, from the policy. Does not know about stages, cycles or task phases beyond the trace slug it is given.
 * Deps: @anthropic-ai/claude-agent-sdk (lazy `query` import; types only at load time), ./permissions, ./settingsRules, policy.skipsPermissionChecks, runs.{appendAgentStep, recordSubagent, completeSubagent}, parser.parseTasksFile, ./steps.
 */

import fs from "node:fs";
import path from "node:path";
import type {
  CanUseTool,
  HookCallbackMatcher,
  HookEvent,
  Options,
} from "@anthropic-ai/claude-agent-sdk";
import { questionModeFor } from "../humanInput.js";
import type { RunLogger } from "../log.js";
import { parseTasksFile } from "../parser.js";
import { type Policy, skipsPermissionChecks } from "../policy.js";
import * as runs from "../runs.js";
import type { AgentStep, EmitFn, RunConfig, StepType } from "../types.js";
import {
  makeCanUseTool,
  type PermissionDeps,
  policyEnvFor,
  preToolUseDecision,
} from "./permissions.js";
import { loadSettingsAskRules } from "./settingsRules.js";
import {
  estimateCost,
  makeStep,
  stringifyResponse,
  toSubagentInfo,
  toToolCallStep,
  toToolResultStep,
} from "./steps.js";

export interface SessionParams {
  config: RunConfig;
  prompt: string;
  runId: string;
  agentRunId: string;
  /** Where the trace lands on disk, and how log lines name this session. */
  trace: { slug: string; number: number; label: string; completedText: string };
  /** Spec folder (relative to the project) — a write to its tasks.md re-emits the task board. */
  specDir: string | null;
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  /** Extra environment for this stage, merged over `process.env`. */
  env?: Record<string, string>;
  abortController: AbortController | null;
  emit: EmitFn;
  rlog: RunLogger;
  /** The project's policy (`.dex/policy.json`, or the defaults). */
  policy: Policy;
  /** The queue entry this session works on; null for project-level stages and build mode. */
  entryId: string | null;
  /** The stage this session runs; decides the question mode. */
  step: StepType;
  /** Trace steps emitted right after the prompt (the task phase's skill_invoke). */
  leadSteps?: Array<(sequenceIndex: number) => AgentStep>;
}

export interface SessionResult {
  resultText: string;
  structuredOutput: unknown | null;
  /** The SDK result subtype (`success`, `error_max_turns`, …); null when no result arrived. */
  subtype: string | null;
  cost: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  sessionId: string | null;
}

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

/** Running totals and the trace writer for one session. */
class SessionTrace {
  private sequenceIndex = 0;
  cost = 0;
  inputTokens = 0;
  outputTokens = 0;
  /** The model the session reports in its init message; prices the running estimate. */
  model: string;
  sessionId: string | null = null;
  readonly knownSubagents = new Set<string>();
  readonly activeSubagents = new Set<string>();
  private readonly p: SessionParams;

  constructor(p: SessionParams) {
    this.p = p;
    this.model = p.config.model;
  }

  push(
    type: AgentStep["type"],
    content: string | null,
    metadata: Record<string, unknown> | null = null,
  ): void {
    this.store(makeStep(type, this.sequenceIndex++, content, metadata));
  }

  pushWith(build: (sequenceIndex: number) => AgentStep): void {
    this.store(build(this.sequenceIndex++));
  }

  private store(step: AgentStep): void {
    const active = this.activeSubagents.size === 1 ? [...this.activeSubagents][0] : null;
    const enriched: AgentStep = {
      ...step,
      metadata: {
        ...step.metadata,
        costUsd: this.cost || null,
        inputTokens: this.inputTokens || null,
        outputTokens: this.outputTokens || null,
        ...(active ? { belongsToSubagent: active } : {}),
      },
    };
    this.p.emit({ type: "agent_step", agentStep: enriched });
    runs.appendAgentStep(
      this.p.config.projectDir,
      this.p.runId,
      this.p.trace.slug,
      this.p.trace.number,
      {
        ...enriched,
        agentRunId: this.p.agentRunId,
      },
    );
  }
}

/** Claude Code's preset system prompt, plus the policy's append file when it names one. */
function systemPrompt(policy: Policy, projectDir: string): Options["systemPrompt"] {
  if (!policy.systemPromptAppend) return { type: "preset", preset: "claude_code" };
  const append = fs.readFileSync(path.resolve(projectDir, policy.systemPromptAppend), "utf-8");
  return { type: "preset", preset: "claude_code", append };
}

/**
 * The SDK options every Dex agent runs with, from the project's policy (research
 * R6). One builder for both call sites, so the abort controller, the
 * environment, the system prompt and the permission settings cannot drift apart.
 */
export function buildQueryOptions(
  p: Pick<SessionParams, "config" | "env" | "outputFormat" | "abortController" | "policy">,
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>,
  canUseTool: CanUseTool,
): Options {
  const { policy } = p;
  const turnLimit = policy.limits.maxTurnsPerStage;
  const stageBudget = policy.limits.maxBudgetUsdPerStage;
  return {
    model: p.config.model,
    cwd: p.config.projectDir,
    maxTurns: turnLimit ? Math.min(p.config.maxTurns, turnLimit) : p.config.maxTurns,
    permissionMode: policy.permissionMode,
    // The SDK refuses to skip its checks without this opt-in; only a new
    // project's policy can ask for that (policy.ts refuses it elsewhere).
    ...(skipsPermissionChecks(policy) ? { allowDangerouslySkipPermissions: true } : {}),
    settingSources: [...policy.settingSources],
    abortController: p.abortController ?? undefined,
    // 0.3 replaces the child's environment with `env`, so PATH and HOME must be
    // carried over explicitly. The stage's own variables win over the policy's.
    env: { ...process.env, ...policy.env, ...p.env },
    systemPrompt: systemPrompt(policy, p.config.projectDir),
    ...(stageBudget ? { maxBudgetUsd: stageBudget } : {}),
    canUseTool,
    hooks,
    ...(p.outputFormat ? { outputFormat: p.outputFormat } : {}),
  };
}

function permissionDeps(p: SessionParams, isAborted: () => boolean): PermissionDeps {
  return {
    policy: p.policy,
    policyEnv: policyEnvFor(p.config.projectDir),
    io: { projectDir: p.config.projectDir, runId: p.runId, emit: p.emit },
    agentRunId: p.agentRunId,
    entryId: p.entryId,
    questions: {
      mode: questionModeFor(p.step, p.config.autoClarification ?? false, p.policy),
      step: p.step,
    },
    isAborted,
    rlog: p.rlog,
    settingsAsk: loadSettingsAskRules(p.config.projectDir, p.policy.settingSources),
  };
}

/** Runs one `query()` to its end (or to abort) and returns its totals. */
export async function runClaudeSession(p: SessionParams): Promise<SessionResult> {
  const startTime = Date.now();
  const trace = new SessionTrace(p);
  const isAborted = () => p.abortController?.signal.aborted ?? false;
  let resultText = "";
  let structuredOutput: unknown | null = null;
  let subtype: string | null = null;

  trace.push("user_message", p.prompt);
  for (const build of p.leadSteps ?? []) trace.pushWith(build);

  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const permissions = permissionDeps(p, isAborted);
  const options = buildQueryOptions(
    p,
    buildHooks(p, trace, permissions),
    makeCanUseTool(permissions),
  );

  for await (const msg of query({ prompt: p.prompt, options })) {
    if (isAborted()) {
      p.rlog.agentRun("INFO", `${p.trace.label}: abort detected in message loop — breaking out`);
      break;
    }
    const message = msg as Record<string, unknown>;
    captureSessionId(message, trace, p);
    if (message.type === "system" && message.subtype === "init") onInit(message, trace, p);
    if (message.type === "assistant") onAssistant(message, trace);
    if (message.type === "result") {
      const r = onResult(message, trace, p);
      resultText = r.resultText;
      structuredOutput = r.structuredOutput;
      subtype = r.subtype;
    }
  }

  const durationMs = Date.now() - startTime;
  if (!isAborted()) {
    trace.push("completed", p.trace.completedText, {
      inputTokens: trace.inputTokens || null,
      outputTokens: trace.outputTokens || null,
    });
  }
  p.rlog.agentRun("INFO", `${p.trace.label}: completed`, { cost: trace.cost, durationMs, subtype });

  return {
    resultText,
    structuredOutput,
    subtype,
    cost: trace.cost,
    durationMs,
    inputTokens: trace.inputTokens,
    outputTokens: trace.outputTokens,
    sessionId: trace.sessionId,
  };
}

// ── Hooks ───────────────────────────────────────────────────────────────────

function buildHooks(
  p: SessionParams,
  trace: SessionTrace,
  permissions: PermissionDeps,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const one = (hook: (input: Record<string, unknown>) => Promise<Record<string, unknown>>) => [
    { hooks: [(input: unknown) => hook(input as Record<string, unknown>)] },
  ];
  return {
    // Never returns `allow`: that would skip the project's own deny and ask rules.
    PreToolUse: one(async (input) => {
      recordToolCall(input, trace);
      const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
      return preToolUseDecision(permissions, String(input.tool_name ?? ""), toolInput);
    }),
    PostToolUse: one(async (input) => {
      recordToolResult(input, trace);
      reemitTasksIfWritten(input, p);
      return { hookSpecificOutput: { hookEventName: "PostToolUse" } };
    }),
    SubagentStart: one(async (input) => {
      onSubagentStart(input, trace, p);
      return {};
    }),
    SubagentStop: one(async (input) => {
      onSubagentStop(input, trace, p);
      return {};
    }),
  };
}

function recordToolCall(input: Record<string, unknown>, trace: SessionTrace): void {
  if (input.tool_name === "Skill") {
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    trace.push("skill_invoke", null, {
      skillName: toolInput.skill ?? "",
      skillArgs: toolInput.args ?? "",
      toolUseId: input.tool_use_id ?? null,
    });
    return;
  }
  trace.pushWith((i) => toToolCallStep(input, i));
}

function recordToolResult(input: Record<string, unknown>, trace: SessionTrace): void {
  if (input.tool_name === "Skill") {
    const response = input.tool_response ?? input.tool_result ?? "";
    trace.push("skill_result", stringifyResponse(response), {
      toolUseId: input.tool_use_id ?? null,
    });
    return;
  }
  trace.pushWith((i) => toToolResultStep(input, i));
}

/**
 * The task board follows tasks.md itself: when an agent writes the spec's
 * tasks.md, re-parse it and emit `tasks_updated`. Replaces the TodoWrite feed,
 * which SDK 0.3 sessions no longer produce (they use TaskCreate/TaskUpdate).
 */
function reemitTasksIfWritten(input: Record<string, unknown>, p: SessionParams): void {
  if (!p.specDir || !WRITE_TOOLS.has(String(input.tool_name))) return;
  const filePath = (input.tool_input as Record<string, unknown> | undefined)?.file_path;
  if (typeof filePath !== "string") return;
  const tasksPath = path.resolve(p.config.projectDir, p.specDir, "tasks.md");
  if (path.resolve(p.config.projectDir, filePath) !== tasksPath) return;
  try {
    p.emit({ type: "tasks_updated", taskPhases: parseTasksFile(p.config.projectDir, p.specDir) });
  } catch (err) {
    p.rlog.agentRun("WARN", "PostToolUse: tasks.md re-parse failed", { err: String(err) });
  }
}

function onSubagentStart(
  input: Record<string, unknown>,
  trace: SessionTrace,
  p: SessionParams,
): void {
  const info = toSubagentInfo(input);
  trace.knownSubagents.add(info.subagentId);
  p.rlog.subagentEvent(info.subagentId, "INFO", "SubagentStart", {
    subagentType: info.subagentType,
    description: info.description,
    rawInput: input,
  });
  p.emit({ type: "subagent_started", info });
  runs.recordSubagent(p.config.projectDir, p.runId, p.agentRunId, {
    id: info.subagentId,
    type: info.subagentType,
    description: info.description,
    status: "running",
    startedAt: info.startedAt,
    endedAt: null,
    durationMs: null,
    costUsd: 0,
  });
  trace.push("subagent_spawn", null, {
    subagentId: info.subagentId,
    subagentType: info.subagentType,
    description: info.description,
  });
  // After the spawn step, so the spawn itself is not tagged as the subagent's.
  trace.activeSubagents.add(info.subagentId);
}

function onSubagentStop(
  input: Record<string, unknown>,
  trace: SessionTrace,
  p: SessionParams,
): void {
  const subagentId = String(input.subagent_id ?? input.agent_id ?? "unknown");
  p.rlog.subagentEvent(subagentId, "INFO", "SubagentStop", { rawInput: input });
  // Before the result step, so the result is not tagged as the subagent's.
  trace.activeSubagents.delete(subagentId);
  // Session-init subagents start before the hooks are registered: no start, no stop.
  if (!trace.knownSubagents.has(subagentId)) return;
  p.emit({ type: "subagent_completed", subagentId });
  runs.completeSubagent(p.config.projectDir, p.runId, subagentId);
  trace.push("subagent_result", null, { subagentId });
}

// ── Messages ────────────────────────────────────────────────────────────────

function captureSessionId(
  message: Record<string, unknown>,
  trace: SessionTrace,
  p: SessionParams,
): void {
  if (trace.sessionId || typeof message.session_id !== "string") return;
  trace.sessionId = message.session_id;
  p.rlog.agentRun("INFO", `${p.trace.label}: session_id=${trace.sessionId}`);
  trace.push("text", `Session: ${trace.sessionId}`, { sessionId: trace.sessionId });
}

/** The `system`/`init` frame: what the agent can see. SDK 0.3 sends ~29 other system subtypes. */
function onInit(message: Record<string, unknown>, trace: SessionTrace, p: SessionParams): void {
  const skills = (message.skills as unknown[] | undefined) ?? [];
  const plugins = (message.plugins as unknown[] | undefined) ?? [];
  const agents = (message.agents as unknown[] | undefined) ?? [];
  const slashCommands = (message.slash_commands as unknown[] | undefined) ?? [];
  const toolNames = ((message.tools as unknown[] | undefined) ?? []).map((t) =>
    typeof t === "object" && t !== null
      ? String((t as Record<string, unknown>).name ?? t)
      : String(t),
  );
  if (typeof message.model === "string") trace.model = message.model;

  p.rlog.agentRun("INFO", `${p.trace.label}: system init`, {
    model: trace.model,
    toolCount: toolNames.length,
    skillCount: skills.length,
    pluginCount: plugins.length,
    agentCount: agents.length,
    slashCommandCount: slashCommands.length,
  });
  if (skills.length === 0)
    p.rlog.agentRun("WARN", `${p.trace.label}: NO SKILLS available to agent`);

  trace.push("debug", null, {
    model: trace.model,
    mcpServers: Object.fromEntries(groupMcpTools(toolNames)),
    skills,
    plugins,
    agents,
    slashCommands,
    toolCount: toolNames.length,
  });
}

/** `mcp__<server>__<tool>` names grouped by server. */
function groupMcpTools(toolNames: string[]): Map<string, string[]> {
  const servers = new Map<string, string[]>();
  for (const name of toolNames) {
    const parts = name.split("__");
    if (parts[0] !== "mcp" || parts.length < 3) continue;
    const list = servers.get(parts[1]) ?? [];
    list.push(parts.slice(2).join("__"));
    servers.set(parts[1], list);
  }
  return servers;
}

function onAssistant(message: Record<string, unknown>, trace: SessionTrace): void {
  const inner = message.message as Record<string, unknown> | undefined;
  const usage = (inner?.usage ?? message.usage) as Record<string, unknown> | undefined;
  if (usage) {
    if (typeof usage.input_tokens === "number") trace.inputTokens += usage.input_tokens;
    if (typeof usage.output_tokens === "number") trace.outputTokens += usage.output_tokens;
    trace.cost = estimateCost(trace.model, trace.inputTokens, trace.outputTokens);
  }
  const content = inner?.content as Array<Record<string, unknown>> | undefined;
  for (const block of content ?? []) {
    if (block.type === "text" && typeof block.text === "string") trace.push("text", block.text);
    if (block.type === "thinking" && typeof block.thinking === "string") {
      trace.push("thinking", block.thinking);
    }
  }
}

/**
 * The result frame is authoritative: `total_cost_usd` for cost, and
 * `modelUsage` (every model the session used, subagents included) for tokens.
 * `usage` covers the main loop only, so it undercounts.
 */
function onResult(
  message: Record<string, unknown>,
  trace: SessionTrace,
  p: SessionParams,
): { resultText: string; structuredOutput: unknown | null; subtype: string | null } {
  if (typeof message.total_cost_usd === "number") trace.cost = message.total_cost_usd;
  const modelUsage = message.modelUsage as
    | Record<string, { inputTokens?: number; outputTokens?: number }>
    | undefined;
  if (modelUsage) {
    const all = Object.values(modelUsage);
    trace.inputTokens = all.reduce((sum, m) => sum + (m.inputTokens ?? 0), 0);
    trace.outputTokens = all.reduce((sum, m) => sum + (m.outputTokens ?? 0), 0);
  }
  const subtype = typeof message.subtype === "string" ? message.subtype : null;
  const resultText = typeof message.result === "string" ? message.result : "";

  p.rlog.agentRun("INFO", `${p.trace.label}: result received`, {
    subtype,
    cost: trace.cost,
    inputTokens: trace.inputTokens,
    outputTokens: trace.outputTokens,
    numTurns: message.num_turns,
    resultPreview: resultText.slice(0, 500),
  });

  if (!p.outputFormat) return { resultText, structuredOutput: null, subtype };
  if (subtype === "error_max_structured_output_retries") {
    throw new Error(
      `Structured output validation failed for ${p.trace.label} — agent could not produce valid JSON matching the schema`,
    );
  }
  const structuredOutput = message.structured_output ?? null;
  if (structuredOutput === null) {
    p.rlog.agentRun(
      "WARN",
      `${p.trace.label}: outputFormat requested but structured_output is null`,
    );
  }
  return { resultText, structuredOutput, subtype };
}
