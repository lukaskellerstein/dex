/**
 * What: Owns live agent-trace state — liveSteps, subagents, currentPhase, currentPhaseTraceId — plus the latestAction memo and labelForStep helper.
 * Not: Does not own loop-cycle progression (useLoopState), run-session metadata (useRunSession), or user-question state. Does not call IPC; subscribes to events and accepts setters via composer.
 * Deps: orchestratorService.subscribeEvents; AgentStep / SubagentInfo / TaskPhase types; viewingHistorical and mode refs from useRunSession.
 */
import { useState, useEffect, useMemo, useRef, type MutableRefObject } from "react";
import type {
  AgentStep,
  SubagentInfo,
  TaskPhase,
  OrchestratorEvent,
} from "../../core/types.js";
import { orchestratorService } from "../services/orchestratorService.js";

export interface LatestAction {
  label: string;
  createdAt: string;
}

export interface UseLiveTraceOptions {
  /** Read-only ref into useRunSession's viewingHistorical state. Live updates are skipped when true. */
  viewingHistoricalRef: MutableRefObject<boolean>;
  /** Read-only ref into useRunSession's mode. */
  modeRef: MutableRefObject<string | null>;
}

export interface UseLiveTraceResult {
  liveSteps: AgentStep[];
  subagents: SubagentInfo[];
  currentPhase: TaskPhase | null;
  currentPhaseTraceId: string | null;
  latestAction: LatestAction | null;
  /** Mirrors `currentPhaseTraceId` but is never overwritten by historical loaders — used by switchToLive to recover. */
  livePhaseTraceIdRef: MutableRefObject<string | null>;
  /** Mirrors `currentPhase` but is never overwritten by historical loaders — used by switchToLive to recover. */
  livePhaseRef: MutableRefObject<TaskPhase | null>;
  // imperative setters used by the composer's load* / switchToLive helpers
  setLiveSteps: React.Dispatch<React.SetStateAction<AgentStep[]>>;
  setSubagents: React.Dispatch<React.SetStateAction<SubagentInfo[]>>;
  setCurrentPhase: React.Dispatch<React.SetStateAction<TaskPhase | null>>;
  setCurrentPhaseTraceId: React.Dispatch<React.SetStateAction<string | null>>;
}

function truncate(s: string, n: number): string {
  const trimmed = s.trim().replace(/\s+/g, " ");
  return trimmed.length > n ? trimmed.slice(0, n - 1) + "…" : trimmed;
}

/** Human label for a step, or null if it's not "live indicator" material. */
export function labelForStep(step: AgentStep): string | null {
  const meta = (step.metadata ?? {}) as Record<string, unknown>;
  switch (step.type) {
    case "tool_call": {
      const tool = typeof meta.toolName === "string" ? meta.toolName : "tool";
      return tool;
    }
    case "subagent_spawn": {
      const desc = typeof meta.description === "string" && meta.description ? meta.description : "subagent";
      return `Task: ${truncate(desc, 40)}`;
    }
    case "subagent_result":
      return "Task done";
    case "thinking":
      return "thinking…";
    case "text": {
      const preview = step.content ? truncate(step.content, 40) : "";
      return preview ? `replying: ${preview}` : "replying…";
    }
    default:
      return null;
  }
}

export function useLiveTrace({
  viewingHistoricalRef,
  modeRef,
}: UseLiveTraceOptions): UseLiveTraceResult {
  const [liveSteps, setLiveSteps] = useState<AgentStep[]>([]);
  const [subagents, setSubagents] = useState<SubagentInfo[]>([]);
  const [currentPhase, setCurrentPhase] = useState<TaskPhase | null>(null);
  const [currentPhaseTraceId, setCurrentPhaseTraceId] = useState<string | null>(null);
  const livePhaseTraceIdRef = useRef<string | null>(null);
  const livePhaseRef = useRef<TaskPhase | null>(null);

  useEffect(() => {
    const unsub = orchestratorService.subscribeEvents((event: OrchestratorEvent) => {
      switch (event.type) {
        case "spec_completed":
          setCurrentPhase(null);
          setCurrentPhaseTraceId(null);
          break;

        case "task_phase_started":
          // In loop mode, the step-level phase name (e.g. "loop:plan") wins
          // over the internal task phase name; in build mode, replace.
          if (modeRef.current !== "loop") {
            setCurrentPhase(event.taskPhase);
            livePhaseRef.current = event.taskPhase;
          }
          setCurrentPhaseTraceId(event.agentRunId);
          livePhaseTraceIdRef.current = event.agentRunId;
          if (!viewingHistoricalRef.current) {
            setLiveSteps([]);
            setSubagents([]);
          }
          break;

        case "agent_step":
          if (!viewingHistoricalRef.current) {
            setLiveSteps((prev) => [...prev, event.agentStep]);
          }
          break;

        case "subagent_started":
          if (!viewingHistoricalRef.current) {
            setSubagents((prev) => [...prev, event.info]);
          }
          break;

        case "subagent_completed":
          if (!viewingHistoricalRef.current) {
            setSubagents((prev) =>
              prev.map((s) =>
                s.subagentId === event.subagentId
                  ? { ...s, completedAt: new Date().toISOString() }
                  : s,
              ),
            );
          }
          break;

        case "tasks_updated":
          // Keep currentPhase in sync with the updated phase data.
          setCurrentPhase((prev) => {
            if (!prev) return prev;
            const updated = event.taskPhases.find((p) => p.number === prev.number);
            return updated ?? prev;
          });
          break;

        case "run_completed":
          setCurrentPhase(null);
          setCurrentPhaseTraceId(null);
          break;

        case "step_started": {
          setCurrentPhaseTraceId(event.agentRunId);
          livePhaseTraceIdRef.current = event.agentRunId;
          const stageTaskPhase: TaskPhase = {
            number: 0,
            name: `loop:${event.step}`,
            purpose: "",
            tasks: [],
            status: "partial",
          };
          livePhaseRef.current = stageTaskPhase;
          if (!viewingHistoricalRef.current) {
            setCurrentPhase(stageTaskPhase);
            setLiveSteps([]);
            setSubagents([]);
          }
          break;
        }
      }
    });
    return unsub;
  }, [viewingHistoricalRef, modeRef]);

  const latestAction = useMemo<LatestAction | null>(() => {
    for (let i = liveSteps.length - 1; i >= 0; i--) {
      const step = liveSteps[i];
      const label = labelForStep(step);
      if (label) return { label, createdAt: step.createdAt };
    }
    return null;
  }, [liveSteps]);

  return {
    liveSteps,
    subagents,
    currentPhase,
    currentPhaseTraceId,
    latestAction,
    livePhaseTraceIdRef,
    livePhaseRef,
    setLiveSteps,
    setSubagents,
    setCurrentPhase,
    setCurrentPhaseTraceId,
  };
}
