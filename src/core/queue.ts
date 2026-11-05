/**
 * What: The work queue — `.dex/queue.json` v3 types, strict validation, default resolution (`resolveEntries`), load (with the one-time v2 feature-manifest migration) and atomic save.
 * Not: Does not derive entry status (the picker does, from files) and is never called to write during a run — Dex writes queue.json only in setup moments (research R2). Runs no git.
 * Deps: node:fs, node:path, parser.extractTaskIds.
 */

import fs from "node:fs";
import path from "node:path";
import { extractTaskIds } from "./parser.js";
import type { Task, TaskPhase } from "./types.js";

// ── Types ──

export const STAGE_NAMES = [
  "brief",
  "specify",
  "clarify",
  "plan",
  "tasks",
  "implement",
  "verify",
] as const;
export type StageName = (typeof STAGE_NAMES)[number];

export interface QueueGenerate {
  sources: string[];
  instructions?: string;
}

export interface QueueEntry {
  id: string;
  title: string;
  description?: string;
  /** Human-owned override. Absent = derived by the picker. */
  status?: "done" | "skipped";
  brief?: string;
  generate?: QueueGenerate;
  specDir?: string;
  branch?: string;
  baseBranch?: string;
  tasks?: string[];
  skip?: StageName[];
  gates?: StageName[];
}

export interface QueueV3 {
  version: 3;
  /** "new": Dex created the project, one run branch. "existing": Dex never creates branches, commits or pushes. */
  kind: "new" | "existing";
  entries: QueueEntry[];
}

/** An entry with every default filled — what the picker, prompts and UI use. */
export interface ResolvedEntry {
  index: number;
  id: string;
  title: string;
  description: string | null;
  status: "done" | "skipped" | null;
  brief: string | null;
  generate: QueueGenerate | null;
  specDir: string;
  branch: string;
  baseBranch: string;
  /** Expanded task-id scope, or null for "every task". */
  tasks: string[] | null;
  skip: StageName[];
  gates: StageName[];
}

export class QueueInvalidError extends Error {
  readonly filePath: string;
  constructor(filePath: string, where: string, detail: string) {
    super(`QueueInvalidError: ${filePath}: ${where}: ${detail}`);
    this.name = "QueueInvalidError";
    this.filePath = filePath;
  }
}

// ── Paths ──

const STATE_DIR = ".dex";
const QUEUE_FILE = "queue.json";

export function queuePath(projectDir: string): string {
  return path.join(projectDir, STATE_DIR, QUEUE_FILE);
}

// ── Validation ──

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const TASK_RE = /^T(\d+)(?:-T(\d+))?$/;
const TOP_KEYS = new Set(["version", "kind", "entries"]);
const ENTRY_KEYS = new Set([
  "id",
  "title",
  "description",
  "status",
  "brief",
  "generate",
  "specDir",
  "branch",
  "baseBranch",
  "tasks",
  "skip",
  "gates",
]);
const GENERATE_KEYS = new Set(["sources", "instructions"]);
const OPTIONAL_STRINGS = ["description", "brief", "specDir", "branch", "baseBranch"] as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function rejectUnknown(
  file: string,
  where: string,
  obj: Record<string, unknown>,
  keys: Set<string>,
): void {
  const unknown = Object.keys(obj).find((k) => !keys.has(k));
  if (unknown) throw new QueueInvalidError(file, where, `unknown field "${unknown}"`);
}

function checkStages(file: string, where: string, field: string, v: unknown): void {
  if (v === undefined) return;
  if (!Array.isArray(v)) throw new QueueInvalidError(file, where, `"${field}" must be an array`);
  const bad = v.find((s) => !STAGE_NAMES.includes(s as StageName));
  if (bad !== undefined) {
    throw new QueueInvalidError(file, where, `"${field}" has unknown stage "${String(bad)}"`);
  }
}

function checkTasks(file: string, where: string, v: unknown): void {
  if (v === undefined) return;
  if (!Array.isArray(v)) throw new QueueInvalidError(file, where, `"tasks" must be an array`);
  for (const item of v) {
    const m = typeof item === "string" ? TASK_RE.exec(item) : null;
    if (!m || (m[2] !== undefined && Number(m[1]) > Number(m[2]))) {
      throw new QueueInvalidError(file, where, `"tasks" item "${String(item)}" is not T<n> or T<a>-T<b>`);
    }
  }
}

function checkGenerate(file: string, where: string, v: unknown): void {
  if (v === undefined) return;
  if (!isObject(v)) throw new QueueInvalidError(file, where, `"generate" must be an object`);
  rejectUnknown(file, `${where}.generate`, v, GENERATE_KEYS);
  const { sources, instructions } = v;
  if (!Array.isArray(sources) || sources.length === 0 || sources.some((s) => typeof s !== "string" || !s)) {
    throw new QueueInvalidError(file, where, `"generate.sources" must be a non-empty list of paths`);
  }
  if (instructions !== undefined && typeof instructions !== "string") {
    throw new QueueInvalidError(file, where, `"generate.instructions" must be a string`);
  }
}

function checkEntry(file: string, i: number, raw: unknown, seen: Set<string>): void {
  if (!isObject(raw)) throw new QueueInvalidError(file, `entries[${i}]`, "must be an object");
  const id = raw.id;
  const where = `entries[${i}] "${typeof id === "string" ? id : "?"}"`;
  rejectUnknown(file, where, raw, ENTRY_KEYS);
  if (typeof id !== "string" || !ID_RE.test(id)) {
    throw new QueueInvalidError(file, where, `"id" must match ${ID_RE.source}`);
  }
  if (seen.has(id)) throw new QueueInvalidError(file, where, `"id" is a duplicate`);
  seen.add(id);
  if (typeof raw.title !== "string" || raw.title.trim() === "") {
    throw new QueueInvalidError(file, where, `"title" must be a non-empty string`);
  }
  for (const key of OPTIONAL_STRINGS) {
    const v = raw[key];
    if (v !== undefined && (typeof v !== "string" || v.trim() === "")) {
      throw new QueueInvalidError(file, where, `"${key}" must be a non-empty string`);
    }
  }
  if (raw.status !== undefined && raw.status !== "done" && raw.status !== "skipped") {
    throw new QueueInvalidError(file, where, `"status" must be "done" or "skipped"`);
  }
  checkGenerate(file, where, raw.generate);
  if (raw.generate !== undefined && raw.brief === undefined) {
    throw new QueueInvalidError(file, where, `"generate" needs "brief" — the path it writes`);
  }
  checkTasks(file, where, raw.tasks);
  checkStages(file, where, "skip", raw.skip);
  checkStages(file, where, "gates", raw.gates);
}

/** Checks `raw` against the v3 rules. Throws QueueInvalidError naming the entry and field. */
export function validateQueue(raw: unknown, file: string): QueueV3 {
  if (!isObject(raw)) throw new QueueInvalidError(file, "root", "must be an object");
  rejectUnknown(file, "root", raw, TOP_KEYS);
  if (raw.version !== 3) throw new QueueInvalidError(file, "root", `"version" must be 3`);
  if (raw.kind !== "new" && raw.kind !== "existing") {
    throw new QueueInvalidError(file, "root", `"kind" must be "new" or "existing"`);
  }
  if (!Array.isArray(raw.entries) || raw.entries.length === 0) {
    throw new QueueInvalidError(file, "root", `"entries" must be a non-empty array`);
  }
  const seen = new Set<string>();
  raw.entries.forEach((e, i) => checkEntry(file, i, e, seen));
  return raw as unknown as QueueV3;
}

// ── Resolution ──

/** Expands `["T110", "T122-T134"]` to the individual task ids, in queue order, without repeats. */
export function parseTaskScope(items: string[]): string[] {
  return [...new Set(items.flatMap((item) => extractTaskIds(item)))];
}

/**
 * Fills every default, in entry order, so a `baseBranch` default can point at
 * the previous entry's resolved `branch`. `runBranch` is the new-project run
 * branch (every entry of a `new` queue lives on it); null before it exists.
 */
export function resolveEntries(
  queue: QueueV3,
  currentBranch: string,
  runBranch: string | null,
): ResolvedEntry[] {
  const out: ResolvedEntry[] = [];
  for (const [index, e] of queue.entries.entries()) {
    const prev = out[index - 1];
    const branch =
      queue.kind === "new" ? (runBranch ?? currentBranch) : (e.branch ?? e.id);
    out.push({
      index,
      id: e.id,
      title: e.title,
      description: e.description ?? null,
      status: e.status ?? null,
      brief: e.brief ?? null,
      generate: e.generate ?? null,
      specDir: e.specDir ?? `specs/${e.id}`,
      branch,
      baseBranch: e.baseBranch ?? prev?.branch ?? currentBranch,
      tasks: e.tasks ? parseTaskScope(e.tasks) : null,
      skip: e.skip ?? [],
      gates: e.gates ?? (e.generate ? ["brief"] : []),
    });
  }
  return out;
}

// ── Task scope (D-015-1, research R8) ──

const FIX_PHASE_RE = /^Verify fixes V\d+\b/;

/** A fix phase appended by verify (research R8). Always in scope. */
export function isFixPhase(phase: TaskPhase): boolean {
  return FIX_PHASE_RE.test(phase.name);
}

/** A task this entry's run may work on: no `tasks` filter, listed in it, or in a fix phase. */
export function isInScope(entry: ResolvedEntry, phase: TaskPhase, task: Task): boolean {
  return !entry.tasks || entry.tasks.includes(task.id) || isFixPhase(phase);
}

/** True when the phase still has an unchecked task in the entry's scope. */
export function hasOpenScopedTask(entry: ResolvedEntry, phase: TaskPhase): boolean {
  return phase.tasks.some((t) => isInScope(entry, phase, t) && t.status !== "done");
}

/** A one-off entry for a spec folder outside any queue (build mode). */
export function entryForSpecDir(specDir: string, branch: string): ResolvedEntry {
  const id = path.basename(specDir);
  return {
    index: 0,
    id,
    title: id,
    description: null,
    status: null,
    brief: null,
    generate: null,
    specDir,
    branch,
    baseBranch: branch,
    tasks: null,
    skip: [],
    gates: [],
  };
}

// ── Load / save ──

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/** `NNN-<slug(title)>` — the id manifest extraction and the v2 migration give a feature. */
export function entryIdFor(featureNumber: number, title: string): string {
  const num = String(featureNumber).padStart(3, "0");
  const s = slug(title);
  return s ? `${num}-${s}` : num;
}

/** The retired `.dex/feature-manifest.json` v2 — read only to migrate it. */
interface ManifestV2 {
  version: 2;
  features: Array<{
    id: number;
    title: string;
    description: string;
    status: "pending" | "active" | "completed" | "skipped";
    specDir: string | null;
  }>;
}

function readManifestV2(projectDir: string): ManifestV2 | null {
  const file = path.join(projectDir, STATE_DIR, "feature-manifest.json");
  if (!fs.existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    throw new QueueInvalidError(file, "root", `not valid JSON (${(err as Error).message})`);
  }
  const m = raw as Partial<ManifestV2> | null;
  return m?.version === 2 && Array.isArray(m.features) ? (m as ManifestV2) : null;
}

/** v2 feature manifest → v3 queue (data-model.md § Migration). */
function migrateManifest(projectDir: string): QueueV3 | null {
  const manifest = readManifestV2(projectDir);
  if (!manifest) return null;
  const entries = manifest.features.map((f): QueueEntry => {
    const entry: QueueEntry = { id: "", title: f.title };
    if (f.specDir) {
      const rel = path.isAbsolute(f.specDir) ? path.relative(projectDir, f.specDir) : f.specDir;
      entry.specDir = rel.replace(/\/+$/, "");
      entry.id = path.basename(entry.specDir);
    } else {
      entry.id = entryIdFor(f.id, f.title);
    }
    if (f.description) entry.description = f.description;
    if (f.status === "completed") entry.status = "done";
    if (f.status === "skipped") entry.status = "skipped";
    return entry;
  });
  return { version: 3, kind: "new", entries };
}

/**
 * Reads `.dex/queue.json`. When it is absent and a v2 feature manifest exists,
 * migrates it and writes queue.json once (the manifest stays) — unless
 * `persistMigration` is false (a dry run writes nothing). Null when the
 * project has neither.
 */
export function loadQueue(projectDir: string, opts: { persistMigration?: boolean } = {}): QueueV3 | null {
  const file = queuePath(projectDir);
  if (fs.existsSync(file)) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch (err) {
      throw new QueueInvalidError(file, "root", `not valid JSON (${(err as Error).message})`);
    }
    return validateQueue(raw, file);
  }
  const migrated = migrateManifest(projectDir);
  if (!migrated) return null;
  const queue = validateQueue(migrated, `${file} (migrated from feature-manifest.json)`);
  if (opts.persistMigration !== false) saveQueue(projectDir, queue);
  return queue;
}

/** Atomic write: temp file + rename. Only for setup moments, never mid-run. */
export function saveQueue(projectDir: string, queue: QueueV3): void {
  const file = queuePath(projectDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(queue, null, 2)}\n`, "utf-8");
  fs.renameSync(tmp, file);
}
