import * as fs from "node:fs";
import * as path from "node:path";
import type { TaskPhase, Task } from "./types.js";

const PHASE_HEADER = /^## TaskPhase (\d+): (.+)$/;
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

export function deriveTaskPhaseStatus(
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

// Gap analysis is now deterministic via the feature manifest (see manifest.ts).
// The regex-based parseGapAnalysisResult and GAP_DECISION_RE have been removed.

// ── T015: Discover New Spec Directory ──

export function discoverNewSpecDir(
  projectDir: string,
  knownSpecs: string[]
): string | null {
  const candidates = [
    path.join(projectDir, "specs"),
    path.join(projectDir, ".specify", "specs"),
  ];

  for (const specsRoot of candidates) {
    if (fs.existsSync(specsRoot)) {
      const entries = fs.readdirSync(specsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const relPath = path.relative(projectDir, path.join(specsRoot, entry.name));
        if (!knownSpecs.includes(relPath)) {
          return relPath;
        }
      }
    }
  }

  return null;
}

export function parseTasksFile(
  projectDir: string,
  specDir: string
): TaskPhase[] {
  const tasksPath = path.join(projectDir, specDir, "tasks.md");
  const content = fs.readFileSync(tasksPath, "utf-8");
  return parseTasksMd(content);
}
