/**
 * What: Owns LoopStartPanel form state — goalPath, goalContent, goalDetected, showEditor, saving, maxCycles, maxBudget, autoClarification — plus the auto-detect / save side-effects.
 * Not: Does not render. Does not own start-run logic; the panel calls onStart with the form's current values.
 * Deps: projectService for readFile/writeFile.
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
  maxCycles: string;
  setMaxCycles: (s: string) => void;
  maxBudget: string;
  setMaxBudget: (s: string) => void;
  autoClarification: boolean;
  setAutoClarification: (b: boolean | ((prev: boolean) => boolean)) => void;
  saveGoal: () => Promise<void>;
  loadGoalFromPath: (path: string) => Promise<void>;
}

export function useLoopStartForm(projectDir: string): UseLoopStartFormResult {
  const [goalPath, setGoalPath] = useState("");
  const [maxCycles, setMaxCycles] = useState("");
  const [maxBudget, setMaxBudget] = useState("");
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

  // Auto-detect GOAL.md in project root.
  useEffect(() => {
    const defaultPath = `${projectDir}/GOAL.md`;
    projectService.readFile(defaultPath).then((content) => {
      if (content !== null) {
        setGoalPath(defaultPath);
        setGoalDetected(true);
        setGoalContent(content);
        setShowEditor(false);
      } else {
        setGoalDetected(false);
        setGoalPath("");
        setGoalContent(GOAL_TEMPLATE);
        setShowEditor(true);
      }
    });
  }, [projectDir]);

  const saveGoal = useCallback(async () => {
    const filePath = `${projectDir}/GOAL.md`;
    setSaving(true);
    const ok = await projectService.writeFile(filePath, goalContent);
    setSaving(false);
    if (ok) {
      setGoalPath(filePath);
      setGoalDetected(true);
    }
  }, [projectDir, goalContent]);

  const loadGoalFromPath = useCallback(async (path: string) => {
    if (!path) return;
    const c = await projectService.readFile(path);
    if (c) setGoalContent(c);
  }, []);

  return {
    goalPath,
    setGoalPath,
    goalContent,
    setGoalContent,
    goalDetected,
    showEditor,
    setShowEditor,
    saving,
    maxCycles,
    setMaxCycles,
    maxBudget,
    setMaxBudget,
    autoClarification,
    setAutoClarification,
    saveGoal,
    loadGoalFromPath,
  };
}
