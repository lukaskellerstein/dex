import { useCallback, useEffect, useState } from "react";
import type { TimelineSnapshot } from "../../../../core/checkpoints.js";
import { checkpointService } from "../../../services/checkpointService.js";
import { orchestratorService } from "../../../services/orchestratorService.js";

const POLL_INTERVAL_MS = 30_000;

const EMPTY: TimelineSnapshot = {
  checkpoints: [],
  attempts: [],
  currentAttempt: null,
  currentBranch: "",
  pending: [],
  captureBranches: [],
  startingPoint: null,
  commits: [],
  selectedPath: [],
};

export function useTimeline(projectDir: string | null): {
  snapshot: TimelineSnapshot;
  refresh: () => void;
} {
  const [snapshot, setSnapshot] = useState<TimelineSnapshot>(EMPTY);

  const refresh = useCallback(async () => {
    if (!projectDir) {
      setSnapshot(EMPTY);
      return;
    }
    try {
      const snap = await checkpointService.listTimeline(projectDir);
      setSnapshot(snap);
    } catch {
      setSnapshot(EMPTY);
    }
  }, [projectDir]);

  // Initial + projectDir change
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Window focus + periodic poll
  useEffect(() => {
    if (!projectDir) return;
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [projectDir, refresh]);

  // Invalidate on orchestrator events. The set below covers run-start (so the
  // new branch shows up as soon as its first commit lands), per-step lifecycle
  // (started → completed), checkpoint commits (`step_candidate`), promotions,
  // and variant-group completion. Refresh is debounced to ~the round-trip of
  // `listTimeline`, which is fast (~tens of ms on a typical repo).
  useEffect(() => {
    if (!projectDir) return;
    const off = orchestratorService.subscribeEvents((e) => {
      const type = (e as { type?: string }).type;
      if (
        type === "run_started" ||
        type === "step_started" ||
        type === "step_completed" ||
        type === "step_candidate" ||
        type === "checkpoint_promoted" ||
        type === "variant_group_complete"
      ) {
        refresh();
      }
    });
    return off;
  }, [projectDir, refresh]);

  return { snapshot, refresh };
}
