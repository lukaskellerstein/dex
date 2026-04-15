import * as fs from "node:fs";
import * as path from "node:path";
import type { Phase, Task } from "./types.js";

const PHASE_HEADER = /^## Phase (\d+): (.+)$/;
const PURPOSE_LINE = /^\*\*Purpose\*\*: (.+)$/;
const TASK_LINE = /^- \[([ x~])\] (T\d+)\s+(.+)$/;
const BRACKET_TAG = /\[([^\]]+)\]/g;

function extractTags(raw: string): {
  userStory: string | null;
  priority: string | null;
  description: string;
} {
  let userStory: string | null = null;
  let priority: string | null = null;

  // Extract all [TAG] brackets for known tag patterns
  // biome-ignore lint: resetting lastIndex is intentional for global regex reuse
  BRACKET_TAG.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BRACKET_TAG.exec(raw)) !== null) {
    const tag = match[1];
    if (/^US\d+$/i.test(tag)) {
      userStory = tag.toUpperCase();
    } else if (/^P\d?$/.test(tag)) {
      priority = tag;
    }
  }

  // Strip matched tags from description
  const description = raw.replace(BRACKET_TAG, (full, tag) => {
    if (/^US\d+$/i.test(tag) || /^P\d?$/.test(tag)) return "";
    return full;
  }).trim();

  return { userStory, priority, description };
}

export function derivePhaseStatus(
  tasks: Task[]
): "complete" | "partial" | "not_started" {
  if (tasks.length === 0) return "not_started";
  const allDone = tasks.every((t) => t.status === "done");
  if (allDone) return "complete";
  const anyStarted = tasks.some(
    (t) => t.status === "done" || t.status === "code_exists" || t.status === "in_progress"
  );
  return anyStarted ? "partial" : "not_started";
}

function parseTaskStatus(marker: string): Task["status"] {
  if (marker === "x") return "done";
  if (marker === "~") return "code_exists";
  return "not_done";
}

export function parseTasksMd(content: string): Phase[] {
  const lines = content.split("\n");
  const phases: Phase[] = [];
  let currentPhase: Phase | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const phaseMatch = line.match(PHASE_HEADER);
    if (phaseMatch) {
      if (currentPhase) {
        currentPhase.status = derivePhaseStatus(currentPhase.tasks);
        phases.push(currentPhase);
      }
      currentPhase = {
        number: parseInt(phaseMatch[1], 10),
        name: phaseMatch[2].trim(),
        purpose: "",
        tasks: [],
        status: "not_started",
      };
      continue;
    }

    if (currentPhase) {
      const purposeMatch = line.match(PURPOSE_LINE);
      if (purposeMatch) {
        currentPhase.purpose = purposeMatch[1].trim();
        continue;
      }

      const taskMatch = line.match(TASK_LINE);
      if (taskMatch) {
        const { userStory, priority, description } = extractTags(taskMatch[3]);
        currentPhase.tasks.push({
          id: taskMatch[2],
          userStory,
          priority,
          description,
          status: parseTaskStatus(taskMatch[1]),
          lineNumber: i + 1,
          phase: currentPhase.number,
        });
      }
    }
  }

  if (currentPhase) {
    currentPhase.status = derivePhaseStatus(currentPhase.tasks);
    phases.push(currentPhase);
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
  let match: RegExpExecArray | null;

  // First pass: expand ranges
  while ((match = RANGE_RE.exec(content)) !== null) {
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
  while ((match = SINGLE_RE.exec(content)) !== null) {
    const inRange = rangeSpans.some(([s, e]) => match!.index >= s && match!.index < e);
    if (!inRange && !ids.includes(match[1])) {
      ids.push(match[1]);
    }
  }

  return ids;
}

export function parseTasksFile(
  projectDir: string,
  specDir: string
): Phase[] {
  const tasksPath = path.join(projectDir, specDir, "tasks.md");
  const content = fs.readFileSync(tasksPath, "utf-8");
  return parseTasksMd(content);
}
