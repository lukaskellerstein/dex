/**
 * What: Owns run-session metadata — mode, isRunning, currentRunId, totalDuration, activeSpecDir, activeTask, viewingHistorical — and exposes the modeRef + viewingHistoricalRef other hooks read.
 * Not: Does not own loop-cycle state (useLoopState), live-trace state (useLiveTrace), user-question state, or prerequisites. Does not call IPC; subscribes to events only.
 * Deps: orchestratorService.subscribeEvents; OrchestratorEvent / Task types.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import type { OrchestratorEvent, Task } from "../../core/types.js";
import { orchestratorService } from "../services/orchestratorService.js";

export interface UseRunSessionResult {
  // primary state
  mode: string | null;
  isRunning: boolean;
  currentRunId: string | null;
  totalDuration: number;
  activeSpecDir: string | null;
  activeTask: Task | null;
  viewingHistorical: boolean;
  // refs for cross-hook reads (consumed by useLiveTrace and the composer's load* helpers)
  modeRef: React.MutableRefObject<string | null>;
  viewingHistoricalRef: React.MutableRefObject<boolean>;
  // imperative setters used by the composer's load* / switchToLive helpers
  setMode: (s: string | null) => void;
  setIsRunning: React.Dispatch<React.SetStateAction<boolean>>;
  setCurrentRunId: React.Dispatch<React.SetStateAction<string | null>>;
  setTotalDuration: React.Dispatch<React.SetStateAction<number>>;
  setActiveSpecDir: React.Dispatch<React.SetStateAction<string | null>>;
  setActiveTask: React.Dispatch<React.SetStateAction<Task | null>>;
  setViewingHistorical: (b: boolean) => void;
}

export function useRunSession(): UseRunSessionResult {
  const [mode, setModeState] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [totalDuration, setTotalDuration] = useState(0);
  const [activeSpecDir, setActiveSpecDir] = useState<string | null>(null);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [viewingHistorical, setViewingHistoricalState] = useState(false);

  const modeRef = useRef<string | null>(null);
  const viewingHistoricalRef = useRef<boolean>(false);

  const setMode = useCallback((m: string | null) => {
    setModeState(m);
    modeRef.current = m;
  }, []);

  const setViewingHistorical = useCallback((b: boolean) => {
    setViewingHistoricalState(b);
    viewingHistoricalRef.current = b;
  }, []);

  useEffect(() => {
    const unsub = orchestratorService.subscribeEvents((event: OrchestratorEvent) => {
      switch (event.type) {
        case "run_started":
          setIsRunning(true);
          setViewingHistorical(false);
          setTotalDuration(0);
          setCurrentRunId(event.runId);
          setActiveSpecDir(event.config.specDir);
          setMode(event.config.mode);
          break;

        case "spec_started":
          setActiveSpecDir(event.specDir);
          break;

        case "spec_completed":
          setActiveSpecDir(null);
          break;

        case "step_started":
          if (event.specDir) setActiveSpecDir(event.specDir);
          break;

        case "task_phase_started":
          if (!viewingHistoricalRef.current) {
            setActiveTask(null);
          }
          break;

        case "task_phase_completed":
          setTotalDuration((prev) => prev + event.durationMs);
          break;

        case "step_completed":
          setTotalDuration((prev) => prev + event.durationMs);
          break;

        case "tasks_updated": {
          // Find the first in-progress task across all phases.
          const inProgress =
            event.taskPhases
              .flatMap((p) => p.tasks)
              .find((t) => t.status === "in_progress") ?? null;
          setActiveTask(inProgress);
          break;
        }

        case "run_completed":
          setIsRunning(false);
          setActiveSpecDir(null);
          setActiveTask(null);
          setTotalDuration(event.totalDuration);
          break;

        case "state_reconciled":
          if (event.driftSummary) {
            const ds = event.driftSummary;
            if (
              ds.missingArtifacts.length > 0 ||
              ds.modifiedArtifacts.length > 0 ||
              Object.keys(ds.taskRegressions).length > 0
            ) {
              console.info("[dex] State reconciliation detected drift:", ds);
            }
          }
          break;

        case "error":
          // Run-level error sink — phase-discriminated errors are handled by their domain hooks.
          // Composer-level fatal-error sink (B4) catches unmatched.
          break;
      }
    });
    return unsub;
  }, [setMode, setViewingHistorical]);

  return {
    mode,
    isRunning,
    currentRunId,
    totalDuration,
    activeSpecDir,
    activeTask,
    viewingHistorical,
    modeRef,
    viewingHistoricalRef,
    setMode,
    setIsRunning,
    setCurrentRunId,
    setTotalDuration,
    setActiveSpecDir,
    setActiveTask,
    setViewingHistorical,
  };
}
