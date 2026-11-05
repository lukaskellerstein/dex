/**
 * What: The attempt log (016 R14, FR-034–FR-036) — `.dex/evidence/<id>/progress.md`, one Markdown section per stage of an entry, oldest first: time, stage, task phase, the agent's own summary and notes, Dex's gate result, and each failing run's name and first error line (contracts/evidence.md § progress.md). `attemptSlice` gives the next prompt the newest whole sections that fit in 8,000 characters (about 2,000 tokens); `archiveAttempts` moves the log to `archive/progress-<ISO>.md` when the done gate passes, so history is never fed back.
 * Not: Decides nothing and is never a gate input: the agent's words here are for the next agent, not for Dex. Writes no tracked file: the evidence folder ignores itself.
 * Deps: evidence.ensureEntryDir, sensors.SensorRun, node:fs, node:path.
 */

import fs from "node:fs";
import path from "node:path";
import { ensureEntryDir } from "./evidence.js";
import type { SensorRun } from "./sensors.js";

/** One stage's section of the log. */
export interface AttemptEntry {
  /** ISO-8601; written to the second. */
  at: string;
  stage: string;
  taskPhase: number | null;
  summary: string | null;
  notes: string[];
  /** Dex's gate result, `<gate> <outcome> — <reason>`; null when the stage has no gate. */
  gate: string | null;
  failing: SensorRun[];
}

/** About 2,000 tokens at 4 characters per token (R14). */
export const ATTEMPT_BUDGET = 8000;
const MAX_LINE = 200;
const ERROR_RE = /\b(error|errors|fail|failed|failure|failing|assert\w*|panic|exception)\b|✗|✖/i;

function logPath(projectDir: string, entryId: string): string {
  return path.join(projectDir, ".dex", "evidence", entryId, "progress.md");
}

const toSecond = (iso: string) => iso.replace(/\.\d{3}Z$/, "Z");

/** The first output line that names an error or a failure, else the last non-empty one; at most 200 characters. */
export function firstErrorLine(tail: string[]): string {
  const lines = tail.map((l) => l.trim()).filter((l) => l !== "");
  const line = lines.find((l) => ERROR_RE.test(l)) ?? lines.at(-1) ?? "(no output)";
  return line.slice(0, MAX_LINE);
}

/** One section, in the contract's format, ending in a newline. */
export function formatAttempt(e: AttemptEntry): string {
  const phase = e.taskPhase === null ? "" : ` · phase ${e.taskPhase}`;
  const lines = [
    `## ${toSecond(e.at)} · ${e.stage}${phase}`,
    "",
    `**Agent**: ${e.summary?.trim() || "(no summary)"}`,
  ];
  if (e.notes.length > 0) lines.push(`**Notes**: ${e.notes.join(" · ")}`);
  if (e.gate) lines.push(`**Gate**: ${e.gate}`);
  if (e.failing.length > 0) {
    lines.push(
      `**Failing**: ${e.failing.map((r) => `${r.name} — \`${firstErrorLine(r.tail)}\``).join(" · ")}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Adds the stage's section at the end of the entry's log. */
export function appendAttempt(projectDir: string, entryId: string, e: AttemptEntry): void {
  ensureEntryDir(projectDir, entryId);
  const file = logPath(projectDir, entryId);
  const sep = fs.existsSync(file) ? "\n" : "";
  fs.appendFileSync(file, `${sep}${formatAttempt(e)}`, "utf-8");
}

function sections(md: string): string[] {
  return md
    .split(/^(?=## )/m)
    .map((s) => `${s.trimEnd()}\n`)
    .filter((s) => s.startsWith("## "));
}

/** The newest whole sections that fit in `budget` characters, oldest of them first; "" when there are none. */
export function attemptSlice(projectDir: string, entryId: string, budget = ATTEMPT_BUDGET): string {
  let md: string;
  try {
    md = fs.readFileSync(logPath(projectDir, entryId), "utf-8");
  } catch {
    return "";
  }
  const picked: string[] = [];
  let size = 0;
  for (const s of sections(md).reverse()) {
    const add = s.length + (picked.length > 0 ? 1 : 0);
    if (size + add > budget) break;
    picked.unshift(s);
    size += add;
  }
  return picked.join("\n");
}

/** Moves the log to `archive/progress-<ISO>.md` (FR-036). Returns its project-relative path, or null with no log. */
export function archiveAttempts(
  projectDir: string,
  entryId: string,
  now = new Date(),
): string | null {
  const file = logPath(projectDir, entryId);
  if (!fs.existsSync(file)) return null;
  const archive = path.join(path.dirname(file), "archive");
  fs.mkdirSync(archive, { recursive: true });
  const dest = path.join(
    archive,
    `progress-${toSecond(now.toISOString()).replaceAll(":", "-")}.md`,
  );
  fs.renameSync(file, dest);
  return path.relative(projectDir, dest);
}
