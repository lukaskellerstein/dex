import { useCallback, useEffect, useState } from "react";
import type { TimelineSnapshot } from "../../../../core/checkpoints.js";
import { checkpointService } from "../../../services/checkpointService.js";
import { orchestratorService } from "../../../services/orchestratorService.js";

const POLL_INTERVAL_MS = 30_000;

const EMPTY: TimelineSnapshot = {
  checkpoints: [],
  attempts: [],
  currentAttempt: null,
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

  // Invalidate on orchestrator step events (triggered externally via refresh())
  useEffect(() => {
    if (!projectDir) return;
    const off = orchestratorService.subscribeEvents((e) => {
      const type = (e as { type?: string }).type;
      if (
        type === "stage_candidate" ||
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
