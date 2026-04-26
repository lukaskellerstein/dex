import { useMemo } from "react";
import {
  ArrowLeft,
  CheckCircle,
  Loader2,
  GitBranch,
} from "lucide-react";
import type { SubagentInfo, AgentStep } from "../../../core/types.js";
import { AgentStepList } from "./AgentStepList.js";

interface SubagentDetailViewProps {
  subagent: SubagentInfo;
  parentSteps: AgentStep[];
  allSubagents: SubagentInfo[];
  isRunning: boolean;
  onBack: () => void;
}

export function SubagentDetailView({
  subagent,
  parentSteps,
  allSubagents,
  isRunning: parentIsRunning,
  onBack,
}: SubagentDetailViewProps) {
  // A subagent is only "running" if the parent is live AND it has no completedAt.
  // For historical traces (parentIsRunning=false), never show "Running" even if
  // completedAt is null due to stale DB data from the old SDK field-name bug.
  const isRunning = parentIsRunning && !subagent.completedAt;

  // For duration: if completedAt is missing but we have steps, use the last step's timestamp
  const lastStepTime = parentSteps.length > 0
    ? parentSteps[parentSteps.length - 1].createdAt
    : null;
  const endTime = subagent.completedAt ?? (isRunning ? null : lastStepTime);
  const durationMs = endTime
    ? new Date(endTime).getTime() - new Date(subagent.startedAt).getTime()
    : Date.now() - new Date(subagent.startedAt).getTime();

  // Detect if this subagent was part of a parallel batch:
  // other subagents with startedAt within 2s of this one
  const isParallel = useMemo(() => {
    const t0 = new Date(subagent.startedAt).getTime();
    return allSubagents.some(
      (s) => s.subagentId !== subagent.subagentId
        && Math.abs(new Date(s.startedAt).getTime() - t0) < 2000
    );
  }, [allSubagents, subagent.subagentId, subagent.startedAt]);

  // Extract steps that belong to this subagent.
  // Strategy:
  //   1. Tagged steps (belongsToSubagent === subId) — reliable when only 1 subagent active
  //   2. Positional window (spawn→result) — works for sequential subagents
  //   3. For parallel subagents with no tagged steps — show prompt only
  //
  // Also extracts the prompt from the Agent/Task tool_call that triggered this spawn.
  // For parallel spawns, matches by description since tool_use_id isn't available.
  const subagentSteps = useMemo(() => {
    const subId = subagent.subagentId;
    const result: AgentStep[] = [];

    // Find the spawn index for this subagent
    let spawnIndex = -1;
    for (let i = 0; i < parentSteps.length; i++) {
      if (
        parentSteps[i].type === "subagent_spawn" &&
        (parentSteps[i].metadata?.subagentId as string) === subId
      ) {
        spawnIndex = i;
        break;
      }
    }

    // Extract the prompt from the matching Task/Agent tool_call.
    // For parallel spawns, all spawns appear AFTER all Task calls, so we can't
    // just look at the nearest one. Instead, match by description field.
    if (spawnIndex >= 0) {
      const spawnDesc = subagent.description;
      // Collect all Task/Agent tool_calls that precede ANY spawn in this batch
      const taskCalls: { step: AgentStep; index: number }[] = [];
      for (let i = spawnIndex - 1; i >= 0; i--) {
        const prev = parentSteps[i];
        if (prev.type === "tool_call") {
          const toolName = prev.metadata?.toolName as string | undefined;
          if (toolName === "Task" || toolName === "Agent") {
            taskCalls.push({ step: prev, index: i });
          }
        }
        // Stop searching once we hit a non-tool-call/non-spawn step far enough back
        if (taskCalls.length > 0 && prev.type !== "tool_call" && prev.type !== "subagent_spawn") break;
      }

      // Try to match by description first (most reliable for parallel spawns)
      let matchedPrompt: string | undefined;
      if (spawnDesc && taskCalls.length > 1) {
        const match = taskCalls.find((tc) => {
          const input = tc.step.metadata?.toolInput as Record<string, unknown> | undefined;
          return input?.description === spawnDesc;
        });
        if (match) {
          matchedPrompt = (match.step.metadata?.toolInput as Record<string, unknown>)?.prompt as string | undefined;
        }
      }

      // Fallback: for single spawns, just take the nearest Task/Agent call
      if (!matchedPrompt && taskCalls.length > 0) {
        const nearest = taskCalls[0];
        matchedPrompt = (nearest.step.metadata?.toolInput as Record<string, unknown>)?.prompt as string | undefined;
      }

      if (matchedPrompt) {
        result.push({
          id: `subagent-prompt-${subId}`,
          sequenceIndex: -1,
          type: "user_message",
          content: matchedPrompt,
          metadata: null,
          durationMs: null,
          tokenCount: null,
          createdAt: subagent.startedAt,
        });
      }
    }

    // Primary: collect steps tagged with belongsToSubagent matching this subagent
    const tagged = parentSteps.filter(
      (s) => (s.metadata?.belongsToSubagent as string) === subId
    );

    if (tagged.length > 0) {
      result.push(...tagged);
    } else if (!isParallel) {
      // Fallback for sequential subagents: capture steps in the spawn→result window
      let capturing = false;
      for (const step of parentSteps) {
        if (
          step.type === "subagent_spawn" &&
          (step.metadata?.subagentId as string) === subId
        ) {
          capturing = true;
          continue;
        }
        if (
          step.type === "subagent_result" &&
          (step.metadata?.subagentId as string) === subId
        ) {
          break;
        }
        if (capturing) {
          result.push(step);
        }
      }
    }
    // For parallel subagents with no tagged steps: we only show the prompt.
    // The parent timeline has all interleaved steps — we can't attribute them.

    // Append a synthetic "completed" step so the timeline ends cleanly
    if (subagent.completedAt) {
      result.push({
        id: `subagent-completed-${subId}`,
        sequenceIndex: 999999,
        type: "completed",
        content: "Subagent completed",
        metadata: null,
        durationMs: null,
        tokenCount: null,
        createdAt: subagent.completedAt,
      });
    }

    return result;
  }, [parentSteps, subagent.subagentId, subagent.startedAt, subagent.completedAt, subagent.description, isParallel]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {/* Breadcrumb + status row */}
      <div
        style={{
          padding: "8px 14px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "color-mix(in srgb, var(--primary) 4%, var(--background))",
        }}
      >
        <button
          onClick={onBack}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "4px 8px",
            borderRadius: "var(--radius)",
            border: "1px solid var(--border)",
            background: "var(--surface-elevated)",
            color: "var(--foreground-muted)",
            fontSize: "0.77rem",
            cursor: "pointer",
            transition: "border-color 0.15s, color 0.15s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = "var(--primary)";
            e.currentTarget.style.color = "var(--foreground)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = "var(--border)";
            e.currentTarget.style.color = "var(--foreground-muted)";
          }}
        >
          <ArrowLeft size={12} />
          Parent Agent
        </button>
        {isParallel && (
          <span style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            fontSize: "0.7rem",
            color: "var(--foreground-dim)",
            padding: "2px 6px",
            borderRadius: "var(--radius)",
            background: "var(--primary-muted)",
          }}>
            <GitBranch size={10} />
            parallel
          </span>
        )}
        <span
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 4,
            fontSize: "0.77rem",
            color: isRunning ? "var(--primary)" : "var(--status-success)",
          }}
        >
          {isRunning ? (
            <>
              <Loader2
                size={12}
                style={{ animation: "spin 1s linear infinite" }}
              />
              Running
            </>
          ) : (
            <>
              <CheckCircle size={12} />
              Completed
            </>
          )}
        </span>
      </div>

      {/* Subagent steps timeline */}
      <AgentStepList
        steps={subagentSteps}
        isRunning={parentIsRunning && isRunning}
        agentId={subagent.subagentId}
        startedAt={subagent.startedAt}
        durationMs={durationMs}
        showSubagentSteps
      />
    </div>
  );
}
