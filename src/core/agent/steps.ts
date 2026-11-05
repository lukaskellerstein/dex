import crypto from "node:crypto";
import type { AgentStep, SubagentInfo } from "../types.js";

// ── Pricing (USD per 1M tokens) ──
// Only the running estimate shown while a session streams uses this table. The
// session's result frame carries the SDK's own `total_cost_usd`, which replaces
// the estimate at the end.

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/** Longest key first, so "claude-opus-5-5" is not priced as "claude-opus-5". */
const PRICING_BY_PREFIX = Object.entries(MODEL_PRICING).sort(([a], [b]) => b.length - a.length);

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  // Match by prefix — e.g. a dated "claude-sonnet-4-5-20250929" matches "claude-sonnet-4-5"
  const pricing = PRICING_BY_PREFIX.find(([k]) => model.startsWith(k))?.[1];
  if (!pricing) return 0;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

// ── Step Construction Helpers ──

export function makeStep(
  type: AgentStep["type"],
  sequenceIndex: number,
  content: string | null,
  metadata: Record<string, unknown> | null = null,
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

export function toToolCallStep(input: Record<string, unknown>, idx: number): AgentStep {
  return makeStep("tool_call", idx, null, {
    toolName: input.tool_name ?? "unknown",
    toolInput: input.tool_input ?? {},
    toolUseId: input.tool_use_id ?? null,
  });
}

export function stringifyResponse(response: unknown): string {
  if (typeof response === "string") return response;
  try {
    return JSON.stringify(response, null, 2);
  } catch {
    return String(response);
  }
}

export function toToolResultStep(input: Record<string, unknown>, idx: number): AgentStep {
  const response = input.tool_response ?? input.tool_result ?? "";
  const text = stringifyResponse(response);
  const isError = typeof response === "string" && response.startsWith("Error");
  return makeStep(isError ? "tool_error" : "tool_result", idx, text, {
    toolName: input.tool_name ?? "unknown",
    toolUseId: input.tool_use_id ?? null,
  });
}

export function toSubagentInfo(input: Record<string, unknown>): SubagentInfo {
  return {
    id: crypto.randomUUID(),
    subagentId: String(input.subagent_id ?? input.agent_id ?? crypto.randomUUID()),
    subagentType: String(input.subagent_type ?? input.agent_type ?? "unknown"),
    description: input.description ? String(input.description) : null,
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
}
