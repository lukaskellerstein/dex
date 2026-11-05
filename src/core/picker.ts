/**
 * What: The next-stage picker (D-015-1). Decides from files alone what runs next: `pickNext` returns one decision, `describeQueue` the derived status of every entry. Each entry's files are read from its own tree — working tree or a git ref — never through a checkout (research R3).
 * Not: Never writes and never switches branches. Does not run stages and does not count attempts (post-stage does). Does not validate the queue (queue.ts does).
 * Deps: queue.{resolveEntries, ResolvedEntry, StageName}, tree-reader, evidence.{evidenceKey, readVerifyRecord, tasksHash}, parser.parseTasksMd, git.{getCurrentBranch, branchExists}.
 */

import { type Evidence, evidenceKey, readVerifyRecord, tasksHash } from "./evidence.js";
import { branchExists, getCurrentBranch } from "./git.js";
import { parseTasksMd } from "./parser.js";
import {
  hasOpenScopedTask,
  isFixPhase,
  type QueueV3,
  type ResolvedEntry,
  resolveEntries,
  type StageName,
} from "./queue.js";
import { gitRef, type TreeReader, workingTree } from "./tree-reader.js";
import type { TaskPhase } from "./types.js";

// ── Public types ──

export interface PickerInput {
  projectDir: string;
  queue: QueueV3;
  /** The new-project run branch; null before it exists and for existing projects. */
  runBranch: string | null;
}

export type PickerDecision =
  | { kind: "stage"; entry: ResolvedEntry; stage: StageName; taskPhase?: number; reason: string }
  | { kind: "pause"; entry: ResolvedEntry; reason: "invalid_input"; detail: string }
  | { kind: "complete" };

export interface QueueViewEntry {
  id: string;
  title: string;
  status: "pending" | "active" | "done" | "skipped";
  nextStage: StageName | null;
  reason: string;
  taskPhase: number | null;
  costUsd: number;
}

export interface QueueView {
  kind: QueueV3["kind"];
  entries: QueueViewEntry[];
}

/** What the files say about one entry. */
type Outcome =
  | { kind: "stage"; stage: StageName; taskPhase?: number; reason: string }
  | { kind: "done" | "skipped"; reason: string }
  | { kind: "pause"; detail: string };

const CLARIFICATIONS_RE = /^## Clarifications\s*$/m;

// ── One entry ──

const stage = (s: StageName, reason: string, taskPhase?: number): Outcome =>
  taskPhase === undefined
    ? { kind: "stage", stage: s, reason }
    : { kind: "stage", stage: s, reason, taskPhase };

/** brief → specify → clarify → plan → tasks, in D-015-1 order. Null when all are in place. */
function artefactStage(entry: ResolvedEntry, tree: TreeReader): Outcome | null {
  const skip = new Set(entry.skip);
  const spec = (f: string) => `${entry.specDir}/${f}`;
  if (entry.brief && !skip.has("brief") && !tree.exists(entry.brief)) {
    return entry.generate
      ? stage("brief", `the brief ${entry.brief} is missing; generate it`)
      : {
          kind: "pause",
          detail: `the brief ${entry.brief} is missing and the entry has no "generate"`,
        };
  }
  if (!skip.has("specify") && !tree.exists(spec("spec.md"))) {
    return stage("specify", `${spec("spec.md")} is missing`);
  }
  if (!skip.has("clarify") && !CLARIFICATIONS_RE.test(tree.read(spec("spec.md")) ?? "")) {
    return stage("clarify", `${spec("spec.md")} has no ## Clarifications section`);
  }
  if (!skip.has("plan") && !tree.exists(spec("plan.md"))) {
    return stage("plan", `${spec("plan.md")} is missing`);
  }
  if (!skip.has("tasks") && !tree.exists(spec("tasks.md"))) {
    return stage("tasks", `${spec("tasks.md")} is missing`);
  }
  return null;
}

/** The first task phase with an unchecked in-scope task, or a pause for unknown scope ids. */
function implementStage(entry: ResolvedEntry, phases: TaskPhase[]): Outcome | null {
  const scope = entry.tasks ? new Set(entry.tasks) : null;
  if (scope) {
    const known = new Set(phases.flatMap((p) => p.tasks.map((t) => t.id)));
    const unknown = [...scope].filter((id) => !known.has(id));
    if (unknown.length > 0) {
      return {
        kind: "pause",
        detail: `tasks ${unknown.join(", ")} are not in ${entry.specDir}/tasks.md`,
      };
    }
  }
  const open = phases.find((p) => hasOpenScopedTask(entry, p));
  return open
    ? stage("implement", `phase ${open.number} (${open.name}) has unchecked tasks`, open.number)
    : null;
}

/** The verify row of D-015-1: a passing record that matches the entry now (contracts/evidence.md). */
function verifyStage(entry: ResolvedEntry, tasks: string, evidence: Evidence): Outcome {
  const { record, key } = evidence;
  if (!record) return stage("verify", `no verify record in .dex/evidence/${entry.id}/`);
  if (key === null || record.key !== key) {
    return stage(
      "verify",
      record.key.startsWith("spec:")
        ? `${entry.specDir} changed since the last verify`
        : `branch "${entry.branch}" has commits since the last verify`,
    );
  }
  if (record.tasksHash !== tasksHash(tasks)) {
    return stage("verify", "the last verify checked a different tasks.md");
  }
  if (record.verdict !== "passed") return stage("verify", "the last verify failed");
  return { kind: "done", reason: "verify passed for the current commit and tasks.md" };
}

/** D-015-1 for one entry over one tree. `evidence` is read only when the entry reaches verify. */
export function stageFor(
  entry: ResolvedEntry,
  tree: TreeReader,
  evidence: () => Evidence,
): Outcome {
  const before = artefactStage(entry, tree);
  if (before) return before;
  const tasks = tree.read(`${entry.specDir}/tasks.md`) ?? "";
  if (!entry.skip.includes("implement")) {
    const impl = implementStage(entry, parseTasksMd(tasks));
    if (impl) return impl;
  }
  if (entry.skip.includes("verify"))
    return { kind: "done", reason: "every stage is done or skipped" };
  return verifyStage(entry, tasks, evidence());
}

/** Verify rounds so far: the `Verify fixes V<k>` phases in tasks.md (research R8). */
export function countVerifyRounds(tasksMd: string): number {
  return parseTasksMd(tasksMd).filter(isFixPhase).length;
}

// ── Trees (research R3) ──

function currentBranchOf(projectDir: string): string {
  try {
    return getCurrentBranch(projectDir);
  } catch {
    return "";
  }
}

type EntryTree = { tree: TreeReader; fromBase: boolean } | { error: string };

function entryTree(input: PickerInput, entry: ResolvedEntry, current: string): EntryTree {
  const { projectDir, queue } = input;
  if (queue.kind === "new") return { tree: workingTree(projectDir), fromBase: false };
  const on = (ref: string) => (ref === current ? workingTree(projectDir) : gitRef(projectDir, ref));
  if (entry.branch === current || branchExists(projectDir, entry.branch)) {
    return { tree: on(entry.branch), fromBase: false };
  }
  if (entry.baseBranch === current || branchExists(projectDir, entry.baseBranch)) {
    return { tree: on(entry.baseBranch), fromBase: true };
  }
  return { error: `neither branch "${entry.branch}" nor its base "${entry.baseBranch}" exists` };
}

function evaluate(input: PickerInput, entry: ResolvedEntry, current: string): Outcome {
  if (entry.status === "skipped") return { kind: "skipped", reason: "skipped in queue.json" };
  if (entry.status === "done") return { kind: "done", reason: "marked done in queue.json" };
  const t = entryTree(input, entry, current);
  if ("error" in t) return { kind: "pause", detail: t.error };
  const outcome = stageFor(entry, t.tree, () => ({
    record: readVerifyRecord(input.projectDir, entry.id),
    key: evidenceKey(input.projectDir, input.queue.kind, entry),
  }));
  // Without its own branch, an entry can only start (brief, specify) or be done.
  if (
    t.fromBase &&
    outcome.kind === "stage" &&
    outcome.stage !== "brief" &&
    outcome.stage !== "specify"
  ) {
    return {
      kind: "pause",
      detail: `branch "${entry.branch}" does not exist, but "${entry.baseBranch}" already has ${entry.specDir}/spec.md; create the branch or set "branch" in queue.json`,
    };
  }
  return outcome;
}

function resolved(input: PickerInput): { entries: ResolvedEntry[]; current: string } {
  const current = currentBranchOf(input.projectDir);
  return { entries: resolveEntries(input.queue, current, input.runBranch), current };
}

// ── Public API ──

/** The next thing to do for the queue. Reads files only. */
export function pickNext(input: PickerInput): PickerDecision {
  const { entries, current } = resolved(input);
  for (const entry of entries) {
    const o = evaluate(input, entry, current);
    if (o.kind === "stage") {
      return o.taskPhase === undefined
        ? { kind: "stage", entry, stage: o.stage, reason: o.reason }
        : { kind: "stage", entry, stage: o.stage, taskPhase: o.taskPhase, reason: o.reason };
    }
    if (o.kind === "pause")
      return { kind: "pause", entry, reason: "invalid_input", detail: o.detail };
  }
  return { kind: "complete" };
}

/** A file of the entry (project-relative), read from the same tree the picker decides on. */
export function readEntryFile(
  input: PickerInput,
  entry: ResolvedEntry,
  rel: string,
): string | null {
  const t = entryTree(input, entry, currentBranchOf(input.projectDir));
  return "error" in t ? null : t.tree.read(rel);
}

/** The entry's verify rounds, read from the same tree the picker decides on. */
export function verifyRoundsOf(input: PickerInput, entry: ResolvedEntry): number {
  return countVerifyRounds(readEntryFile(input, entry, `${entry.specDir}/tasks.md`) ?? "");
}

/** Every entry, resolved, with its derived status, in queue order. Each is evaluated on its own tree. */
export function describeEntries(
  input: PickerInput,
  costsByEntry: Record<string, number> = {},
): Array<{ entry: ResolvedEntry; view: QueueViewEntry }> {
  const { entries, current } = resolved(input);
  let activeSeen = false;
  return entries.map((entry) => {
    const o = evaluate(input, entry, current);
    const finished = o.kind === "done" || o.kind === "skipped";
    const status: QueueViewEntry["status"] = finished
      ? (o.kind as "done" | "skipped")
      : activeSeen
        ? "pending"
        : "active";
    if (!finished) activeSeen = true;
    const view: QueueViewEntry = {
      id: entry.id,
      title: entry.title,
      status,
      nextStage: o.kind === "stage" ? o.stage : null,
      reason: o.kind === "pause" ? o.detail : o.reason,
      taskPhase: o.kind === "stage" ? (o.taskPhase ?? null) : null,
      costUsd: costsByEntry[entry.id] ?? 0,
    };
    return { entry, view };
  });
}

/** Derived status of every entry, for the queue panel, `--status` and `--dry-run`. */
export function describeQueue(
  input: PickerInput,
  costsByEntry: Record<string, number> = {},
): QueueView {
  return {
    kind: input.queue.kind,
    entries: describeEntries(input, costsByEntry).map((e) => e.view),
  };
}
