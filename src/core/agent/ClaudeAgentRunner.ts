import * as runs from "../runs.js";
import {
  type AgentRunner,
  limitHitOf,
  type StepContext,
  type StepResult,
  type TaskPhaseContext,
  type TaskPhaseResult,
} from "./AgentRunner.js";
import { runClaudeSession } from "./claudeSession.js";
import { makeStep } from "./steps.js";

/**
 * Claude Code backend — wraps `@anthropic-ai/claude-agent-sdk` `query()`
 * through `runClaudeSession`. Stateless: every call takes its config and the
 * project's policy from the passed context, and no SDK import happens until a
 * session starts.
 */
export class ClaudeAgentRunner implements AgentRunner {
  async runStep(ctx: StepContext): Promise<StepResult> {
    const { config, step } = ctx;
    const r = await runClaudeSession({
      config,
      prompt: ctx.prompt,
      runId: ctx.runId,
      agentRunId: ctx.agentRunId,
      trace: {
        slug: runs.slugForTaskPhaseName(`loop:${step}`),
        number: ctx.cycleNumber,
        label: `runStep(${step})`,
        completedText: `Step ${step} completed`,
      },
      specDir: ctx.specDir,
      outputFormat: ctx.outputFormat,
      env: ctx.env,
      abortController: ctx.abortController,
      emit: ctx.emit,
      rlog: ctx.rlog,
      policy: ctx.policy,
      entryId: ctx.entryId ?? null,
      step,
    });
    return {
      result: r.resultText,
      structuredOutput: r.structuredOutput,
      cost: r.cost,
      durationMs: r.durationMs,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      sessionId: r.sessionId,
      limitHit: limitHitOf(r.subtype),
    };
  }

  async runTaskPhase(ctx: TaskPhaseContext): Promise<TaskPhaseResult> {
    const { config, taskPhase } = ctx;
    const skillName = config.mode === "plan" ? "speckit-plan" : "speckit-implement";
    const specPath = config.specDir.startsWith("/")
      ? config.specDir
      : `${config.projectDir}/${config.specDir}`;
    ctx.rlog.agentRun(
      "INFO",
      `runTaskPhase: spawning agent for Phase ${taskPhase.number}: ${taskPhase.name}`,
    );

    const r = await runClaudeSession({
      config,
      prompt: ctx.prompt,
      runId: ctx.runId,
      agentRunId: ctx.agentRunId,
      trace: {
        slug: runs.slugForTaskPhaseName(taskPhase.name),
        number: taskPhase.number,
        label: `runTaskPhase(${taskPhase.number})`,
        completedText: `Phase ${taskPhase.number}: ${taskPhase.name} completed`,
      },
      specDir: config.specDir,
      env: ctx.env,
      abortController: ctx.abortController,
      emit: ctx.emit,
      rlog: ctx.rlog,
      policy: ctx.policy,
      entryId: ctx.entryId ?? null,
      step: "implement",
      leadSteps: [
        (i) =>
          makeStep("skill_invoke", i, null, {
            skillName,
            skillArgs: `${specPath} --phase ${taskPhase.number}`,
          }),
      ],
    });
    return {
      cost: r.cost,
      durationMs: r.durationMs,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      limitHit: limitHitOf(r.subtype),
    };
  }
}
