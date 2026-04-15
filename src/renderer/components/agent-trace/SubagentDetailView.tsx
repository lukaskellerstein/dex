import { useMemo } from "react";
import {
  ArrowLeft,
  CheckCircle,
  Loader2,
} from "lucide-react";
import type { SubagentInfo, AgentStep } from "../../../core/types.js";
import { AgentStepList } from "./AgentStepList.js";

export function SubagentDetailView({
  subagent,
  parentSteps,
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

  // Extract steps that belong to this subagent's lifecycle window:
  // from the subagent_spawn step to the subagent_result step (or end of steps).
  // Also extract the prompt from the Agent/Task tool_call that preceded the spawn.
  const subagentSteps = useMemo(() => {
    const subId = subagent.subagentId;
    let capturing = false;
    const result: AgentStep[] = [];
    let spawnIndex = -1;

    // Find the spawn index first
    for (let i = 0; i < parentSteps.length; i++) {
      if (
        parentSteps[i].type === "subagent_spawn" &&
        (parentSteps[i].metadata?.subagentId as string) === subId
      ) {
        spawnIndex = i;
        break;
      }
    }

    // Look backwards from spawn for the Agent/Task tool_call that triggered it
    if (spawnIndex > 0) {
      for (let i = spawnIndex - 1; i >= Math.max(0, spawnIndex - 5); i--) {
        const prev = parentSteps[i];
        if (prev.type === "tool_call") {
          const toolName = prev.metadata?.toolName as string | undefined;
          if (toolName === "Task" || toolName === "Agent") {
            const prompt = (prev.metadata?.toolInput as Record<string, unknown>)?.prompt as string | undefined;
            if (prompt) {
              result.push({
                id: `subagent-prompt-${subId}`,
                sequenceIndex: -1,
                type: "user_message",
                content: prompt,
                metadata: null,
                durationMs: null,
                tokenCount: null,
                createdAt: subagent.startedAt,
              });
            }
            break;
          }
        }
      }
    }

    // Capture steps in the spawn→result window, excluding the
    // spawn/result markers themselves (shown via the metadata card instead).
    for (const step of parentSteps) {
      if (
        step.type === "subagent_spawn" &&
        (step.metadata?.subagentId as string) === subId
      ) {
        capturing = true;
        continue; // skip the spawn card itself
      }
      if (
        step.type === "subagent_result" &&
        (step.metadata?.subagentId as string) === subId
      ) {
        break; // stop before the result card
      }
      if (capturing) {
        result.push(step);
      }
    }

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
  }, [parentSteps, subagent.subagentId, subagent.startedAt]);

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
        headerTitle="Agent Detail"
        agentId={subagent.subagentId}
        startedAt={subagent.startedAt}
        durationMs={durationMs}
      />
    </div>
  );
}
