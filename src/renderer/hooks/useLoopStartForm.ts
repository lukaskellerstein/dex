/**
 * What: Owns LoopStartPanel form state — goalPath, goalContent, goalDetected, showEditor, saving, autoClarification — plus the auto-detect / save / pick-file side-effects.
 * Not: Does not render. Does not own start-run logic; the panel calls onStart with the form's current values. Does not own per-run budget caps (max cycles / max budget) — those move to dex-config.json or programmatic config, not this UI.
 * Deps: projectService for readFile/writeFile/pickGoalFile.
 */
import { useState, useEffect, useCallback } from "react";
import { projectService } from "../services/projectService.js";

const GOAL_TEMPLATE = `# Project Goal

## Overview
Describe what you want to build at a high level.

## Key Features
- Feature 1
- Feature 2
- Feature 3

## Technical Constraints
- Any specific technologies, frameworks, or requirements

## Success Criteria
- What does "done" look like?
`;

export interface UseLoopStartFormResult {
  goalPath: string;
  setGoalPath: (s: string) => void;
  goalContent: string;
  setGoalContent: (s: string) => void;
  goalDetected: boolean;
  showEditor: boolean;
  setShowEditor: (b: boolean) => void;
  saving: boolean;
  autoClarification: boolean;
  setAutoClarification: (b: boolean | ((prev: boolean) => boolean)) => void;
  saveGoal: () => Promise<void>;
  loadGoalFromPath: (path: string) => Promise<void>;
  pickGoalFile: () => Promise<void>;
}

export function useLoopStartForm(projectDir: string): UseLoopStartFormResult {
  const [goalPath, setGoalPath] = useState("");
  const [autoClarification, setAutoClarificationState] = useState(false);
  const [goalDetected, setGoalDetected] = useState(false);
  const [goalContent, setGoalContent] = useState("");
  const [showEditor, setShowEditor] = useState(false);
  const [saving, setSaving] = useState(false);

  const setAutoClarification = useCallback(
    (b: boolean | ((prev: boolean) => boolean)) => {
      setAutoClarificationState(b);
    },
    [],
  );

  // Auto-detect goal file in project root. Order:
  //   1. previous run's choice (state.json `config.descriptionFile`) — honors a
  //      non-default file the user picked last time without forcing a retype.
  //   2. `GOAL.md` — the conventional default.
  // Falls back to an empty path (with the editor primed for new content) when
  // neither resolves.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const candidates: string[] = [];
      const stateRaw = await projectService.readFile(`${projectDir}/.dex/state.json`);
      if (stateRaw) {
        try {
          const persisted = JSON.parse(stateRaw)?.config?.descriptionFile;
          if (typeof persisted === "string" && persisted.length > 0) {
            candidates.push(persisted);
          }
        } catch {
          // ignore — state.json being malformed shouldn't break the welcome screen
        }
      }
      candidates.push(`${projectDir}/GOAL.md`);

      for (const candidate of candidates) {
        const content = await projectService.readFile(candidate);
        if (cancelled) return;
        if (content !== null) {
          setGoalPath(candidate);
          setGoalDetected(true);
          setGoalContent(content);
          setShowEditor(false);
          return;
        }
      }

      if (cancelled) return;
      setGoalDetected(false);
      setGoalPath("");
      setGoalContent(GOAL_TEMPLATE);
      setShowEditor(false);
    })();
    return () => { cancelled = true; };
  }, [projectDir]);

  const saveGoal = useCallback(async () => {
    const filePath = goalPath.trim() || `${projectDir}/GOAL.md`;
    setSaving(true);
    const ok = await projectService.writeFile(filePath, goalContent);
    setSaving(false);
    if (ok) {
      setGoalPath(filePath);
      setGoalDetected(true);
    }
  }, [projectDir, goalPath, goalContent]);

  const loadGoalFromPath = useCallback(async (path: string) => {
    if (!path) return;
    const c = await projectService.readFile(path);
    if (c) setGoalContent(c);
  }, []);

  const pickGoalFile = useCallback(async () => {
    const picked = await projectService.pickGoalFile(projectDir);
    if (!picked) return;
    setGoalPath(picked);
    setGoalDetected(true);
    setShowEditor(false);
    const content = await projectService.readFile(picked);
    if (content !== null) setGoalContent(content);
  }, [projectDir]);

  return {
    goalPath,
    setGoalPath,
    goalContent,
    setGoalContent,
    goalDetected,
    showEditor,
    setShowEditor,
    saving,
    autoClarification,
    setAutoClarification,
    saveGoal,
    loadGoalFromPath,
    pickGoalFile,
  };
}
