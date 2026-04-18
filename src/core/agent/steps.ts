import crypto from "node:crypto";
import type { AgentStep, SubagentInfo } from "../types.js";

// ── Pricing (USD per 1M tokens) ──

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-5-20250514": { input: 3, output: 15 },
  "claude-sonnet-4-6":          { input: 3, output: 15 },
  "claude-opus-4-5-20250414":   { input: 15, output: 75 },
  "claude-opus-4-6":            { input: 15, output: 75 },
  "claude-haiku-4-5-20251001":  { input: 0.80, output: 4 },
};

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  // Match by prefix — e.g. "claude-sonnet-4-5-20250514" matches "claude-sonnet-4-5"
  const pricing = MODEL_PRICING[model]
    ?? Object.entries(MODEL_PRICING).find(([k]) => model.startsWith(k))?.[1];
  if (!pricing) return 0;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

// ── Step Construction Helpers ──

export function makeStep(
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

export function toToolCallStep(
  input: Record<string, unknown>,
  idx: number
): AgentStep {
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

export function toToolResultStep(
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
