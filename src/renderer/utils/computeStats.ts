import type { AgentStep } from "../../core/types.js";

export interface AgentStats {
  durationMs: number | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  stepCount: number;
  toolCount: number;
  mcpCount: number;
  subagentCount: number;
  skillCount: number;
  errorCount: number;
}

/**
 * Derive stats from an array of AgentSteps — same approach as VEX.
 * Counts unique tools, MCP servers, subagents, skills, and errors.
 * Extracts token counts from the "completed" step metadata if available.
 */
export function computeStats(
  steps: AgentStep[],
  overrides?: { durationMs?: number | null }
): AgentStats {
  let toolCount = 0;
  const mcpServers = new Set<string>();
  const subagents = new Set<string>();
  const skills = new Set<string>();
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let errorCount = 0;
  let costUsd: number | null = null;

  for (const step of steps) {
    if (step.type === "tool_error" || step.type === "error") {
      errorCount++;
    }

    // Extract running cost/token totals from step metadata (each step carries
    // the latest accumulated values, so the last one wins)
    if (step.metadata) {
      if (typeof step.metadata.costUsd === "number") costUsd = step.metadata.costUsd;
      if (typeof step.metadata.inputTokens === "number") inputTokens = step.metadata.inputTokens;
      if (typeof step.metadata.outputTokens === "number") outputTokens = step.metadata.outputTokens;
    }

    // Count total tool invocations
    if (step.type === "tool_call") {
      toolCount++;
      const toolName = step.metadata?.toolName as string | undefined;
      if (toolName?.startsWith("mcp__")) {
        const parts = toolName.split("__");
        if (parts.length >= 2) mcpServers.add(parts[1]);
      }
    }

    // Count subagents
    if (step.type === "subagent_spawn") {
      const id = (step.metadata?.subagentId as string) ?? "";
      if (id) subagents.add(id);
    }

    // Count skills
    if (step.type === "skill_invoke") {
      const name = (step.metadata?.skillName as string) ?? "";
      if (name) skills.add(name);
    }
  }

  return {
    durationMs: overrides?.durationMs ?? null,
    costUsd,
    inputTokens,
    outputTokens,
    stepCount: steps.length,
    toolCount,
    mcpCount: mcpServers.size,
    subagentCount: subagents.size,
    skillCount: skills.size,
    errorCount,
  };
}
