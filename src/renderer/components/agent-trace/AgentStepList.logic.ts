/**
 * What: Pure helpers for AgentStepList — synthesize subagent_result steps from SubagentInfo, group tool_call ↔ tool_result by toolUseId, batch consecutive parallel subagent_spawns into one row.
 * Not: Does not render. Does not own React state. Component memoizes the outputs.
 * Deps: AgentStep, SubagentInfo types only.
 */
import type { AgentStep, SubagentInfo } from "../../../core/types.js";

export const LINE_LEFT = 20; // center of the vertical line
export const DOT_SIZE = 9;
export const CONTENT_LEFT = 42; // padding-left for step content

export function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatDelta(ms: number): string {
  if (ms < 1000) return `+${ms}ms`;
  if (ms < 60_000) return `+${(ms / 1000).toFixed(1)}s`;
  return `+${(ms / 60_000).toFixed(1)}m`;
}

export interface GroupedStep {
  step: AgentStep;
  resultSteps: AgentStep[];
}

export type TimelineRow =
  | { kind: "single"; entry: GroupedStep; idx: number }
  | { kind: "parallel-spawns"; entries: GroupedStep[]; startIdx: number };

/**
 * Filters out raw subagent_result steps (legacy IDs are unreliable; session-init
 * subagents are noise) and synthesizes one synthetic completed step per known
 * subagent based on SubagentInfo.completedAt. Sorted by timestamp.
 */
export function processSteps(
  steps: AgentStep[],
  subagents: SubagentInfo[] | undefined,
  isRunning: boolean,
  showSubagentSteps?: boolean,
): AgentStep[] {
  const filtered = steps.filter(
    (s) =>
      s.type !== "subagent_result" &&
      (showSubagentSteps || !s.metadata?.belongsToSubagent),
  );

  if (!subagents || subagents.length === 0) return filtered;

  const spawnIndices = new Map<string, number>();
  filtered.forEach((s, i) => {
    if (s.type === "subagent_spawn") {
      const id = s.metadata?.subagentId as string;
      if (id) spawnIndices.set(id, i);
    }
  });

  const synthetics: AgentStep[] = [];
  for (const sa of subagents) {
    if (!spawnIndices.has(sa.subagentId)) continue;
    const endTime = sa.completedAt ?? (isRunning ? null : sa.startedAt);
    if (!endTime) continue;
    synthetics.push({
      id: `synth-result-${sa.subagentId}`,
      sequenceIndex: 999990,
      type: "subagent_result",
      content: null,
      metadata: {
        subagentId: sa.subagentId,
        subagentType: sa.subagentType,
      },
      durationMs: null,
      tokenCount: null,
      createdAt: endTime,
    });
  }

  if (synthetics.length === 0) return filtered;

  const merged = [...filtered, ...synthetics];
  merged.sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return ta - tb;
  });
  return merged;
}

/**
 * Pairs tool_result/tool_error/skill_result steps with their originating
 * tool_call/skill_invoke via toolUseId metadata. Handles parallel calls where
 * results may arrive in any order.
 */
export function groupToolCalls(processedSteps: AgentStep[]): GroupedStep[] {
  const result: GroupedStep[] = [];
  const callsByToolUseId = new Map<string, GroupedStep>();

  for (const step of processedSteps) {
    if (
      step.type === "tool_result" ||
      step.type === "tool_error" ||
      step.type === "skill_result"
    ) {
      const toolUseId = step.metadata?.toolUseId as string | undefined;
      const matchingCall = toolUseId ? callsByToolUseId.get(toolUseId) : null;
      if (matchingCall) {
        matchingCall.resultSteps.push(step);
        continue;
      }
    }

    const grouped: GroupedStep = { step, resultSteps: [] };
    result.push(grouped);

    if (step.type === "tool_call" || step.type === "skill_invoke") {
      const toolUseId = step.metadata?.toolUseId as string | undefined;
      if (toolUseId) {
        callsByToolUseId.set(toolUseId, grouped);
      }
    }
  }
  return result;
}

/**
 * Batches consecutive subagent_spawn steps within 2s of each other into a
 * single parallel-spawns row. Other steps remain `single`.
 */
export function buildTimelineRows(grouped: GroupedStep[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let i = 0;
  while (i < grouped.length) {
    const entry = grouped[i];
    if (entry.step.type === "subagent_spawn" && entry.step.createdAt) {
      const t0 = new Date(entry.step.createdAt).getTime();
      const batch: GroupedStep[] = [entry];
      let j = i + 1;
      while (j < grouped.length) {
        const next = grouped[j];
        if (next.step.type !== "subagent_spawn" || !next.step.createdAt) break;
        if (Math.abs(new Date(next.step.createdAt).getTime() - t0) > 2000) break;
        batch.push(next);
        j++;
      }
      if (batch.length > 1) {
        rows.push({ kind: "parallel-spawns", entries: batch, startIdx: i });
        i = j;
        continue;
      }
    }
    rows.push({ kind: "single", entry, idx: i });
    i++;
  }
  return rows;
}
