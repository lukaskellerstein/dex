/**
 * What: The app's queue and status model (research R17, FR-043): `project:get-run-snapshot` read on mount, on every stage-boundary event (`run_started`, `step_started`, `step_completed`, `paused`, `run_completed`, `loop_terminated`) and on `refresh()`. The newest answer wins; a failed read keeps the last snapshot.
 * Not: Infers nothing from events, and does not follow the live trace (`agent_step`, `subagent_*` stay event-driven in useLiveTrace). `startActionFor` and `queueProgress` read the snapshot; they decide nothing the files do not say.
 * Deps: projectService.getRunSnapshot, orchestratorService.subscribeEvents.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { RunSnapshot } from "../../core/run-snapshot.js";
import { orchestratorService } from "../services/orchestratorService.js";
import { projectService } from "../services/projectService.js";

const BOUNDARIES = new Set([
  "run_started",
  "step_started",
  "step_completed",
  "paused",
  "run_completed",
  "loop_terminated",
]);

export interface RunSnapshotApi {
  snapshot: RunSnapshot | null;
  refresh: () => Promise<void>;
}

export function useRunSnapshot(projectDir: string | null): RunSnapshotApi {
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  // Each read gets a number; only the newest one may land.
  const latest = useRef(0);

  const refresh = useCallback(async () => {
    if (!projectDir) return;
    const ticket = ++latest.current;
    try {
      const next = await projectService.getRunSnapshot(projectDir);
      if (ticket === latest.current) setSnapshot(next);
    } catch (err) {
      console.warn("[useRunSnapshot] read failed; keeping the last snapshot", err);
    }
  }, [projectDir]);

  useEffect(() => {
    setSnapshot(null);
    void refresh();
    return orchestratorService.subscribeEvents((event) => {
      if (BOUNDARIES.has(event.type)) void refresh();
    });
  }, [refresh]);

  return { snapshot, refresh };
}

/** What Start does for the project now: Resume its run, start the queue loop, build mode, or nothing. */
export type StartAction = "resume" | "start-loop" | "build" | "none";

/**
 * Start, from the snapshot (research R17). An invalid queue or policy refuses.
 * Without a queue, a new project's run before its manifest resumes (its state
 * carries the goal file); otherwise build mode runs the unfinished spec
 * folders. With a queue, a paused run resumes, and an open entry starts the
 * loop — or resumes it, when a run state exists (Resume follows the checkout).
 */
export function startActionFor(snapshot: RunSnapshot | null, unfinishedSpecs: number): StartAction {
  if (!snapshot || snapshot.errors.length > 0) return "none";
  const { state, queue } = snapshot;
  if (!queue) {
    if (state?.config.descriptionFile) return "resume";
    return unfinishedSpecs > 0 ? "build" : "none";
  }
  if (state?.status === "paused") return "resume";
  const open = queue.entries.some((e) => e.status === "active" || e.status === "pending");
  if (!open) return "none";
  return state ? "resume" : "start-loop";
}

/** The queue's entry counts: done, all that will run (skipped ones do not), and not started yet. */
export interface QueueProgress {
  done: number;
  total: number;
  pending: number;
}

/** Entry counts from the queue view, for the cycle count and the placeholder cycles; null without a queue. */
export function queueProgress(snapshot: RunSnapshot | null): QueueProgress | null {
  const entries = snapshot?.queue?.entries;
  if (!entries) return null;
  const count = (status: string) => entries.filter((e) => e.status === status).length;
  return { done: count("done"), total: entries.length - count("skipped"), pending: count("pending") };
}
