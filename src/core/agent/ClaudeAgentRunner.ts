import crypto from "node:crypto";
import type { AgentRunner, TaskPhaseContext, TaskPhaseResult, StepContext, StepResult } from "./AgentRunner.js";
import type { AgentStep, RunConfig, UserInputQuestion } from "../types.js";
import * as runs from "../runs.js";
import { waitForUserInput } from "../userInput.js";
import {
  estimateCost,
  makeStep,
  stringifyResponse,
  toSubagentInfo,
  toToolCallStep,
  toToolResultStep,
} from "./steps.js";

/**
 * Claude Code backend — wraps `@anthropic-ai/claude-agent-sdk` `query()`.
 * Construction is cheap: no SDK import until `runStep`/`runTaskPhase` is called.
 */
export class ClaudeAgentRunner implements AgentRunner {
  // These are held for future use (e.g., per-runner model overrides). They're
  // intentionally not read in the method bodies below, which take everything
  // they need from the per-call StageContext / PhaseContext.
  private readonly runConfig: RunConfig;
  private readonly projectDir: string;
  constructor(runConfig: RunConfig, projectDir: string) {
    this.runConfig = runConfig;
    this.projectDir = projectDir;
  }

  async runStep(ctx: StepContext): Promise<StepResult> {
    const { config, prompt: rawPrompt, runId, cycleNumber, step, agentRunId, outputFormat, abortController, emit, rlog, profile, worktreePath } = ctx;
    // 010 — apply per-variant agent profile overrides. Each is opt-in: if
    // unset, behavior is byte-identical to pre-010.
    const effectiveModel = profile?.model ?? config.model;
    const effectiveCwd = worktreePath ?? config.projectDir;
    const promptAddendum = profile?.systemPromptAppend
      ? `[Profile: ${profile.name}]\n${profile.systemPromptAppend}\n\n`
      : "";
    const prompt = promptAddendum + rawPrompt;
    const startTime = Date.now();
    let stepIndex = 0;
    let totalCost = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let resultText = "";
    let structuredOutput: unknown | null = null;
    const knownSubagentIds = new Set<string>();
    const activeSubagentSet = new Set<string>();

    const stepSlug = runs.slugForTaskPhaseName(`loop:${step}`);
    const emitAndStore = (agentStep: AgentStep) => {
      const activeSubagent = activeSubagentSet.size === 1 ? [...activeSubagentSet][0] : null;
      const enriched: AgentStep = {
        ...agentStep,
        metadata: {
          ...agentStep.metadata,
          costUsd: totalCost || null,
          inputTokens: totalInputTokens || null,
          outputTokens: totalOutputTokens || null,
          ...(activeSubagent ? { belongsToSubagent: activeSubagent } : {}),
        },
      };
      emit({ type: "agent_step", agentStep: enriched });
      runs.appendAgentStep(config.projectDir, runId, stepSlug, cycleNumber, { ...enriched, agentRunId });
    };

    emitAndStore(makeStep("user_message", stepIndex++, prompt));

    const isAborted = () => abortController?.signal.aborted ?? false;

    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    for await (const msg of query({
      prompt,
      options: {
        model: effectiveModel,
        cwd: effectiveCwd,
        maxTurns: config.maxTurns,
        permissionMode: "bypassPermissions",
        settingSources: ["project"],
        abortController: abortController ?? undefined,
        ...(outputFormat ? { outputFormat } : {}),
        ...(profile?.allowedTools ? { allowedTools: profile.allowedTools } : {}),
        canUseTool: async (toolName: string, toolInput: Record<string, unknown>) => {
          if (toolName === "AskUserQuestion") {
            rlog.agentRun("INFO", "canUseTool: AskUserQuestion intercepted");

            // Parse SDK question format into our typed format
            const rawQuestions = (toolInput.questions ?? []) as Array<Record<string, unknown>>;
            const questions: UserInputQuestion[] = rawQuestions.map((q) => ({
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
                  rlog.agentRun("WARN", `canUseTool: no recommended option for "${q.question}", using first option`);
                }
              }
              // Still emit the event so the UI can show what was auto-selected
              const requestId = crypto.randomUUID();
              emit({ type: "user_input_request", runId, requestId, questions });
              emit({ type: "user_input_response", requestId, answers });
              rlog.agentRun("INFO", "canUseTool: auto-answered (autoClarification)", { answers });
            } else {
              // Interactive: emit event and wait for user answer
              answers = await waitForUserInput(config.projectDir, emit, runId, questions);
              rlog.agentRun("INFO", "canUseTool: user answered", { answers });
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
                  rlog.agentRun("DEBUG", `runStep PreToolUse: ${toolName}`);

                  if (toolName === "Skill") {
                    const hookToolInput = (input.tool_input ?? {}) as Record<string, unknown>;
                    emitAndStore(
                      makeStep("skill_invoke", stepIndex++, null, {
                        skillName: hookToolInput.skill ?? "",
                        skillArgs: hookToolInput.args ?? "",
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
                  runs.recordSubagent(config.projectDir, runId, agentRunId, {
                    id: info.subagentId,
                    type: info.subagentType,
                    description: info.description,
                    status: "running",
                    startedAt: info.startedAt,
                    endedAt: null,
                    durationMs: null,
                    costUsd: 0,
                  });
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
                  runs.completeSubagent(config.projectDir, runId, subagentId);
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
        rlog.agentRun("INFO", `runStep(${step}): abort detected in message loop — breaking out (SDK query may continue in background)`);
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
            rlog.agentRun("ERROR", `runStep(${step}): structured output validation failed after max retries`);
            throw new Error(`Structured output validation failed for ${step} — agent could not produce valid JSON matching the schema`);
          }
          structuredOutput = (message as Record<string, unknown>).structured_output ?? null;
          if (structuredOutput === null) {
            rlog.agentRun("WARN", `runStep(${step}): outputFormat requested but structured_output is null — falling back to raw text`);
          }
        }

        rlog.agentRun("INFO", `runStep: ${step} result received`, {
          cost: totalCost,
          resultPreview: resultText.slice(0, 200),
        });
      }
    }

    const durationMs = Date.now() - startTime;

    // Emit a completed step so the UI timeline ends cleanly (mirrors runTaskPhase behavior)
    if (!isAborted()) {
      emitAndStore(makeStep("completed", stepIndex++, `Step ${step} completed`, {
        inputTokens: totalInputTokens || null,
        outputTokens: totalOutputTokens || null,
      }));
    }

    return {
      result: resultText,
      structuredOutput,
      cost: totalCost,
      durationMs,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      sessionId: null,
    };
  }

  async runTaskPhase(ctx: TaskPhaseContext): Promise<TaskPhaseResult> {
    const { config, prompt: rawPrompt, runId, taskPhase, agentRunId, abortController, emit, rlog, onTodoWrite, profile, worktreePath } = ctx;
    // 010 — see runStep above; same overrides applied here.
    const effectiveModel = profile?.model ?? config.model;
    const effectiveCwd = worktreePath ?? config.projectDir;
    const promptAddendum = profile?.systemPromptAppend
      ? `[Profile: ${profile.name}]\n${profile.systemPromptAppend}\n\n`
      : "";
    const prompt = promptAddendum + rawPrompt;
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

    rlog.agentRun("INFO", `runTaskPhase: spawning agent for Phase ${taskPhase.number}: ${taskPhase.name}`);
    rlog.agentRun("DEBUG", "runTaskPhase: prompt", { length: prompt.length, prompt });

    const taskPhaseSlug = runs.slugForTaskPhaseName(taskPhase.name);
    const emitAndStore = (agentStep: AgentStep) => {
      const activeSubagent = activeSubagentSet.size === 1 ? [...activeSubagentSet][0] : null;
      const enriched: AgentStep = {
        ...agentStep,
        metadata: {
          ...agentStep.metadata,
          costUsd: totalCost || null,
          inputTokens: totalInputTokens || null,
          outputTokens: totalOutputTokens || null,
          ...(activeSubagent ? { belongsToSubagent: activeSubagent } : {}),
        },
      };
      rlog.agentRun("DEBUG", `emitAndStore: step type=${enriched.type}`, { id: enriched.id, seq: enriched.sequenceIndex });
      emit({ type: "agent_step", agentStep: enriched });
      runs.appendAgentStep(config.projectDir, runId, taskPhaseSlug, taskPhase.number, { ...enriched, agentRunId });
    };

    // Emit the initial prompt as a user_message step
    emitAndStore(makeStep("user_message", stepIndex++, prompt));

    // Emit skill_invoke step to show which skill is being expanded
    emitAndStore(
      makeStep("skill_invoke", stepIndex++, null, {
        skillName,
        skillArgs: `${specPath} --phase ${taskPhase.number}`,
      })
    );

    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    rlog.agentRun("DEBUG", "runTaskPhase: SDK imported, calling query()");

    const isAborted = () => abortController?.signal.aborted ?? false;
    let sessionId: string | null = null;

    for await (const msg of query({
      prompt,
      options: {
        model: effectiveModel,
        cwd: effectiveCwd,
        maxTurns: config.maxTurns,
        permissionMode: "bypassPermissions",
        settingSources: ["project"],
        ...(profile?.allowedTools ? { allowedTools: profile.allowedTools } : {}),
        hooks: {
          PreToolUse: [
            {
              matcher: undefined,
              hooks: [
                async (input: Record<string, unknown>) => {
                  const toolName = String(input.tool_name ?? "unknown");
                  rlog.agentRun("DEBUG", `PreToolUse: ${toolName}`, { toolUseId: input.tool_use_id, toolInput: input.tool_input });

                  // Emit skill_invoke for Skill tool calls
                  if (toolName === "Skill") {
                    const hookToolInput = (input.tool_input ?? {}) as Record<string, unknown>;
                    emitAndStore(
                      makeStep("skill_invoke", stepIndex++, null, {
                        skillName: hookToolInput.skill ?? "",
                        skillArgs: hookToolInput.args ?? "",
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
                  rlog.agentRun("DEBUG", `PostToolUse: ${toolName}`, { toolUseId: input.tool_use_id });

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

                  // Detect TodoWrite — forward to orchestrator via callback
                  if (toolName === "TodoWrite") {
                    try {
                      const hookToolInput = (input.tool_input ?? {}) as Record<string, unknown>;
                      const todos = (hookToolInput.todos ?? []) as Array<{
                        content?: string;
                        status?: string;
                      }>;
                      onTodoWrite(todos);
                      rlog.agentRun("DEBUG", "PostToolUse: TodoWrite detected, forwarded to orchestrator");
                    } catch (err) {
                      rlog.agentRun("WARN", "PostToolUse: failed to process TodoWrite", { err: String(err) });
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
                  runs.recordSubagent(config.projectDir, runId, agentRunId, {
                    id: info.subagentId,
                    type: info.subagentType,
                    description: info.description,
                    status: "running",
                    startedAt: info.startedAt,
                    endedAt: null,
                    durationMs: null,
                    costUsd: 0,
                  });
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
                    rlog.agentRun("DEBUG", `SubagentStop: ignoring orphan subagent ${subagentId} (no matching start)`);
                    return {};
                  }

                  emit({ type: "subagent_completed", subagentId });
                  runs.completeSubagent(config.projectDir, runId, subagentId);
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
        rlog.agentRun("INFO", "runTaskPhase: abort detected in message loop, breaking");
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
        rlog.agentRun("INFO", "runTaskPhase: system init", {
          model,
          toolCount: tools?.length ?? 0,
          skillCount: skills?.length ?? 0,
          pluginCount: plugins?.length ?? 0,
          agentCount: agents?.length ?? 0,
          slashCommandCount: slashCommands?.length ?? 0,
        });
        if (skills && skills.length > 0) {
          rlog.agentRun("INFO", "runTaskPhase: available skills", { skills });
        } else {
          rlog.agentRun("WARN", "runTaskPhase: NO SKILLS available to agent");
        }
        if (plugins && plugins.length > 0) {
          rlog.agentRun("INFO", "runTaskPhase: available plugins", { plugins });
        }
        if (slashCommands && slashCommands.length > 0) {
          rlog.agentRun("INFO", "runTaskPhase: available slash commands", { slashCommands });
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
          rlog.agentRun("DEBUG", "runTaskPhase: available tools", { tools: toolNames });
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
        rlog.agentRun("INFO", `runTaskPhase: session_id=${sessionId}`);
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

        rlog.agentRun("DEBUG", "assistant message", {
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

        rlog.agentRun("INFO", `runTaskPhase: result received`, {
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
    rlog.agentRun("INFO", `runTaskPhase: completed, cost=$${totalCost}, duration=${durationMs}ms`);

    // Emit a completed step at the end
    if (!isAborted()) {
      emitAndStore(makeStep("completed", stepIndex++, `Phase ${taskPhase.number}: ${taskPhase.name} completed`, {
        inputTokens: totalInputTokens || null,
        outputTokens: totalOutputTokens || null,
      }));
    }

    return { cost: totalCost, durationMs, inputTokens: totalInputTokens, outputTokens: totalOutputTokens };
  }
}
