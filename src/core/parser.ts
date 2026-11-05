import * as fs from "node:fs";
import * as path from "node:path";
import type { Task, TaskPhase } from "./types.js";

const PHASE_HEADER = /^## (?:TaskPhase|Phase) (\d+): (.+)$/;
const PURPOSE_LINE = /^\*\*Purpose\*\*: (.+)$/;
// spec-kit writes `[X]`; hand edits often use `[x]`. Both mean done.
const TASK_LINE = /^- \[([ xX~])\] (T\d+)\s+(.+)$/;
const BRACKET_TAG = /\[([^\]]+)\]/g;

function extractTags(raw: string): {
  userStory: string | null;
  priority: string | null;
  description: string;
} {
  let userStory: string | null = null;
  let priority: string | null = null;

  // Extract all [TAG] brackets for known tag patterns.
  // matchAll leaves BRACKET_TAG.lastIndex untouched, so the shared module-level
  // regex needs no manual reset between calls.
  for (const match of raw.matchAll(BRACKET_TAG)) {
    const tag = match[1];
    if (/^US\d+$/i.test(tag)) {
      userStory = tag.toUpperCase();
    } else if (/^P\d?$/.test(tag)) {
      priority = tag;
    }
  }

  // Strip matched tags from description
  const description = raw
    .replace(BRACKET_TAG, (full, tag) => {
      if (/^US\d+$/i.test(tag) || /^P\d?$/.test(tag)) return "";
      return full;
    })
    .trim();

  return { userStory, priority, description };
}

export function deriveTaskPhaseStatus(tasks: Task[]): "complete" | "partial" | "not_started" {
  if (tasks.length === 0) return "not_started";
  const allDone = tasks.every((t) => t.status === "done");
  if (allDone) return "complete";
  const anyStarted = tasks.some(
    (t) => t.status === "done" || t.status === "code_exists" || t.status === "in_progress",
  );
  return anyStarted ? "partial" : "not_started";
}

function parseTaskStatus(marker: string): Task["status"] {
  if (marker === "x" || marker === "X") return "done";
  if (marker === "~") return "code_exists";
  return "not_done";
}

/** Parses tasks.md content into its task phases. Pure — callers choose where the content comes from. */
export function parseTasksMd(content: string): TaskPhase[] {
  const lines = content.split("\n");
  const phases: TaskPhase[] = [];
  let currentTaskPhase: TaskPhase | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const phaseMatch = line.match(PHASE_HEADER);
    if (phaseMatch) {
      if (currentTaskPhase) {
        currentTaskPhase.status = deriveTaskPhaseStatus(currentTaskPhase.tasks);
        phases.push(currentTaskPhase);
      }
      currentTaskPhase = {
        number: parseInt(phaseMatch[1], 10),
        name: phaseMatch[2].trim(),
        purpose: "",
        tasks: [],
        status: "not_started",
      };
      continue;
    }

    if (currentTaskPhase) {
      const purposeMatch = line.match(PURPOSE_LINE);
      if (purposeMatch) {
        currentTaskPhase.purpose = purposeMatch[1].trim();
        continue;
      }

      const taskMatch = line.match(TASK_LINE);
      if (taskMatch) {
        const { userStory, priority, description } = extractTags(taskMatch[3]);
        currentTaskPhase.tasks.push({
          id: taskMatch[2],
          userStory,
          priority,
          description,
          status: parseTaskStatus(taskMatch[1]),
          lineNumber: i + 1,
          phase: currentTaskPhase.number,
        });
      }
    }
  }

  if (currentTaskPhase) {
    currentTaskPhase.status = deriveTaskPhaseStatus(currentTaskPhase.tasks);
    phases.push(currentTaskPhase);
  }

  return phases;
}

/**
 * Extract all task IDs from a string, handling ranges (T046-T050) and
 * multiple individual IDs (T046, T048). Returns deduplicated array.
 */
export function extractTaskIds(content: string): string[] {
  const ids: string[] = [];
  const RANGE_RE = /\bT(\d+)\s*[-–]\s*T(\d+)\b/g;
  const SINGLE_RE = /\b(T\d+)\b/g;

  // Track character spans covered by ranges to avoid double-counting
  const rangeSpans: [number, number][] = [];

  // First pass: expand ranges
  for (const match of content.matchAll(RANGE_RE)) {
    const startNum = parseInt(match[1], 10);
    const endNum = parseInt(match[2], 10);
    const padLen = match[1].length;
    for (let n = startNum; n <= endNum; n++) {
      const id = `T${String(n).padStart(padLen, "0")}`;
      if (!ids.includes(id)) ids.push(id);
    }
    rangeSpans.push([match.index, match.index + match[0].length]);
  }

  // Second pass: individual IDs not already covered by a range
  for (const match of content.matchAll(SINGLE_RE)) {
    const inRange = rangeSpans.some(([s, e]) => match.index >= s && match.index < e);
    if (!inRange && !ids.includes(match[1])) {
      ids.push(match[1]);
    }
  }

  return ids;
}

// ── T015: Discover New Spec Directory ──

export function parseTasksFile(projectDir: string, specDir: string): TaskPhase[] {
  const tasksPath = path.join(projectDir, specDir, "tasks.md");
  const content = fs.readFileSync(tasksPath, "utf-8");
  return parseTasksMd(content);
}
