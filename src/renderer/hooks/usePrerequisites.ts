/**
 * What: Owns prerequisite-check state — prerequisitesChecks, isCheckingPrerequisites — and updates them in response to prerequisites_* events.
 * Not: Does not own loop/cycle state, live-trace, or user-question state. Does not run prerequisite checks; that's core/stages/prerequisites.ts.
 * Deps: orchestratorService.subscribeEvents; PrerequisiteCheck / OrchestratorEvent types.
 */
import { useState, useEffect } from "react";
import type {
  OrchestratorEvent,
  PrerequisiteCheck,
} from "../../core/types.js";
import { orchestratorService } from "../services/orchestratorService.js";

export interface UsePrerequisitesResult {
  prerequisitesChecks: PrerequisiteCheck[];
  isCheckingPrerequisites: boolean;
  setPrerequisitesChecks: React.Dispatch<React.SetStateAction<PrerequisiteCheck[]>>;
  setIsCheckingPrerequisites: React.Dispatch<React.SetStateAction<boolean>>;
}

export function usePrerequisites(): UsePrerequisitesResult {
  const [prerequisitesChecks, setPrerequisitesChecks] = useState<PrerequisiteCheck[]>([]);
  const [isCheckingPrerequisites, setIsCheckingPrerequisites] = useState(false);

  useEffect(() => {
    const unsub = orchestratorService.subscribeEvents((event: OrchestratorEvent) => {
      switch (event.type) {
        case "run_started":
          setPrerequisitesChecks([]);
          setIsCheckingPrerequisites(false);
          break;

        case "prerequisites_started":
          setIsCheckingPrerequisites(true);
          setPrerequisitesChecks([]);
          break;

        case "prerequisites_check":
          setPrerequisitesChecks((prev) => {
            const idx = prev.findIndex((c) => c.name === event.check.name);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = event.check;
              return next;
            }
            return [...prev, event.check];
          });
          break;

        case "prerequisites_completed":
          setIsCheckingPrerequisites(false);
          break;
      }
    });
    return unsub;
  }, []);

  return {
    prerequisitesChecks,
    isCheckingPrerequisites,
    setPrerequisitesChecks,
    setIsCheckingPrerequisites,
  };
}
