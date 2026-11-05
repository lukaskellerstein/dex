/**
 * What: The evidence Dex keeps per entry in `.dex/evidence/<id>/`, untracked (contracts/evidence.md). The done record `done.json` (016 R5, replacing 015's `verify.json`): after each verify Dex writes one from its own done gate; the picker counts an entry done only when a passing record matches the entry as it is now — the record's `key` plus the `tasks.md` hash. The key is the entry branch's HEAD in an existing project, so any later commit sends the entry back to verify. In a new project every entry shares one run branch, so the key is a content hash of the entry's spec folder instead: a later entry's commits do not undo an earlier entry. The stage records: `writeStageRecord` numbers one record per stage run (`implement-3.json`), `readStageRecords` reads them back oldest first — the sensor runs and gate decisions every later check derives its counts from. The test amendments (`amendments.json`, R10): the human's decision on each, and which approved one the test author has not applied yet.
 * Not: Runs no agent and decides no stage. Never writes a tracked file: the evidence folder carries its own `.gitignore` (`*`). A 015 `verify.json` is never read: the entry is verified once more.
 * Deps: node:child_process (git rev-parse, no shell), node:crypto, node:fs, node:path; types from gates, queue, sensors.
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { GateDecision } from "./gates.js";
import type { StageName } from "./queue.js";
import type { SensorRun } from "./sensors.js";

/** One thing the verifier found in review mode (data-model.md § Finding). */
export interface Finding {
  severity: "blocking" | "minor";
  summary: string;
  /** The success criterion it concerns. */
  criterion: string | null;
  /** A file and line, or a page and step. */
  where: string | null;
}

/** `.dex/evidence/<id>/done.json`: the last verify's result, decided by Dex's done gate. */
export interface DoneRecord {
  version: 2;
  entryId: string;
  /** Existing project: the entry branch's HEAD. New project: `spec:<sha256 of the spec folder>`. Taken before the stage. */
  key: string;
  tasksHash: string;
  /** ISO-8601, when Dex wrote the record. */
  checked: string;
  acceptance: SensorRun[];
  mode: "diagnose" | "review";
  /** Empty in diagnose mode. */
  findings: Finding[];
  /** Diagnose mode only. */
  hypotheses: string[];
  /** The verifier's own summary. */
  summary: string;
  /** Dex's decision, never the agent's. */
  gate: "passed" | "failed";
}

/** What the picker needs to judge verify for one entry. */
export interface Evidence {
  record: DoneRecord | null;
  /** The entry's key now; null when it cannot be computed (no branch, no spec folder). */
  key: string | null;
}

const EVIDENCE_DIR = path.join(".dex", "evidence");
const DONE_FILE = "done.json";

/** sha256 of tasks.md. */
export function tasksHash(content: string): string {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

// ── Keys ──

function branchHead(projectDir: string, branch: string): string | null {
  try {
    return execFileSync(
      "git",
      ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`],
      {
        cwd: projectDir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
  } catch {
    return null;
  }
}

function filesUnder(dir: string, rel = ""): string[] {
  return fs
    .readdirSync(path.join(dir, rel), { withFileTypes: true })
    .flatMap((d) => {
      const child = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) return filesUnder(dir, child);
      return d.isFile() ? [child] : [];
    })
    .sort();
}

/** sha256 over every file of the folder (path, then content), uncommitted changes included. */
function folderHash(dir: string): string | null {
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return null;
  const h = crypto.createHash("sha256");
  for (const rel of filesUnder(dir)) {
    h.update(`${rel}\0`);
    h.update(fs.readFileSync(path.join(dir, rel)));
    h.update("\0");
  }
  return h.digest("hex");
}

/** The entry's key now: its branch HEAD (existing project) or its spec folder's content hash (new project). */
export function evidenceKey(
  projectDir: string,
  kind: "new" | "existing",
  entry: { branch: string; specDir: string },
): string | null {
  if (kind === "existing") return branchHead(projectDir, entry.branch);
  const hash = folderHash(path.join(projectDir, entry.specDir));
  return hash ? `spec:${hash}` : null;
}

// ── The done record ──

function donePath(projectDir: string, entryId: string): string {
  return path.join(projectDir, EVIDENCE_DIR, entryId, DONE_FILE);
}

/** The entry's done record. Missing, unreadable or not version 2 is null: the picker then verifies again. */
export function readDoneRecord(projectDir: string, entryId: string): DoneRecord | null {
  let raw: Partial<DoneRecord>;
  try {
    raw = JSON.parse(fs.readFileSync(donePath(projectDir, entryId), "utf-8"));
  } catch {
    return null;
  }
  const ok =
    raw?.version === 2 &&
    typeof raw.key === "string" &&
    typeof raw.tasksHash === "string" &&
    (raw.gate === "passed" || raw.gate === "failed");
  if (!ok) return null;
  const list = <T>(v: T[] | undefined): T[] => (Array.isArray(v) ? v : []);
  return {
    ...(raw as DoneRecord),
    entryId,
    acceptance: list(raw.acceptance),
    findings: list(raw.findings),
    hypotheses: list(raw.hypotheses),
  };
}

/** Writes the entry's done record, replacing the last one. The folder ignores itself, so git never sees it. */
export function writeDoneRecord(projectDir: string, record: DoneRecord): string {
  ensureEntryDir(projectDir, record.entryId);
  const file = donePath(projectDir, record.entryId);
  writeJsonAtomic(file, record);
  return path.relative(projectDir, file);
}

// ── Stage records (contracts/evidence.md § Stage record) ──

/** The folder of one entry's evidence; the evidence root ignores itself (`*`). */
export function ensureEntryDir(projectDir: string, entryId: string): string {
  const root = path.join(projectDir, EVIDENCE_DIR);
  const dir = path.join(root, entryId);
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(root, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n", "utf-8");
  return dir;
}

/** Through `<file>.tmp` and a rename, so a reader never sees half a file. */
export function writeJsonAtomic(file: string, value: unknown): void {
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  fs.renameSync(`${file}.tmp`, file);
}

/** A queue stage, or one of Dex's own runs between stages. */
export type RecordStage = StageName | "baseline" | "red-first";

export interface PlanDiffRecord {
  /** In-scope task ids that went from `[ ]` to `[x]` in this run. */
  newlyTicked: string[];
  /** One line per change other than a checkbox flip, naming the task (R8). */
  violations: string[];
}

export interface TestChangesRecord {
  /** Frozen test files the run changed, moved or deleted. */
  frozenChanged: string[];
  /** Files matching `testGlobs` the run deleted or renamed. */
  testsDeletedOrRenamed: string[];
  /** New skip or expected-failure markers, as `<file>: <line>`. */
  skipMarkers: string[];
}

/** One stage run of one entry, written by Dex only. */
export interface StageRecord {
  version: 1;
  entryId: string;
  stage: RecordStage;
  /** Counts per stage from 1. */
  n: number;
  /** `create` · `amend` (tests); `phase` · `restore` (implement); `diagnose` · `review` (verify). */
  mode: string | null;
  taskPhase: number | null;
  /** 015's evidence key at the start. */
  key: string | null;
  tasksHash: string | null;
  startSha: string | null;
  endSha: string | null;
  /** research R6, after the stage. */
  treeStamp: string;
  runs: SensorRun[];
  planDiff: PlanDiffRecord | null;
  testChanges: TestChangesRecord | null;
  fingerprint: string | null;
  gate: GateDecision | null;
  /** red-first only: sha256 of acceptance.json. */
  acceptanceHash: string | null;
  /** The agent's own summary, when the stage returned one. Input to the attempt log, never to a gate. */
  summary: string | null;
  at: string;
}

export type NewStageRecord = Omit<StageRecord, "version" | "n" | "at">;

const RECORD_RE = /^(.+)-(\d+)\.json$/;

let lastAtMs = 0;

/** Now, but never the same millisecond twice in this process, so `at` orders the records. */
function recordTime(): string {
  lastAtMs = Math.max(Date.now(), lastAtMs + 1);
  return new Date(lastAtMs).toISOString();
}

function recordFiles(dir: string): Array<{ stage: string; n: number; file: string }> {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((name) => {
    const m = RECORD_RE.exec(name);
    return m ? [{ stage: m[1], n: Number(m[2]), file: path.join(dir, name) }] : [];
  });
}

/** Writes the next record of its stage (`implement-3.json`). Returns it with its project-relative path. */
export function writeStageRecord(
  projectDir: string,
  record: NewStageRecord,
): { record: StageRecord; file: string } {
  const dir = ensureEntryDir(projectDir, record.entryId);
  const last = recordFiles(dir)
    .filter((f) => f.stage === record.stage)
    .reduce((max, f) => Math.max(max, f.n), 0);
  const full: StageRecord = { version: 1, ...record, n: last + 1, at: recordTime() };
  const file = path.join(dir, `${record.stage}-${full.n}.json`);
  writeJsonAtomic(file, full);
  return { record: full, file: path.relative(projectDir, file) };
}

// ── Test amendments (contracts/evidence.md § amendments.json, research R10) ──

/** The header that marks an implementer's question as a test amendment. */
export const AMENDMENT_HEADER = "Test amendment";

export type AmendmentStatus = "approved" | "rejected" | "applied";

export interface Amendment {
  /** The project-relative test file. */
  file: string;
  reason: string;
  status: AmendmentStatus;
  askedAt: string;
  decidedAt: string;
}

function amendmentsPath(projectDir: string, entryId: string): string {
  return path.join(projectDir, EVIDENCE_DIR, entryId, "amendments.json");
}

function readAmendments(projectDir: string, entryId: string): Amendment[] {
  try {
    const raw = JSON.parse(fs.readFileSync(amendmentsPath(projectDir, entryId), "utf-8"));
    return Array.isArray(raw?.items) ? raw.items : [];
  } catch {
    return [];
  }
}

function writeAmendments(projectDir: string, entryId: string, items: Amendment[]): void {
  ensureEntryDir(projectDir, entryId);
  writeJsonAtomic(amendmentsPath(projectDir, entryId), { items });
}

/** Adds the human's decision on one amendment. */
export function recordAmendment(projectDir: string, entryId: string, item: Amendment): void {
  writeAmendments(projectDir, entryId, [...readAmendments(projectDir, entryId), item]);
}

/** The first approved amendment the test author has not applied yet; the picker's amend row. */
export function pendingAmendment(projectDir: string, entryId: string): Amendment | null {
  return readAmendments(projectDir, entryId).find((a) => a.status === "approved") ?? null;
}

/** Marks the first approved amendment of `file` applied, after the tests stage in amend mode. */
export function markAmendmentApplied(projectDir: string, entryId: string, file: string): void {
  const items = readAmendments(projectDir, entryId);
  const i = items.findIndex((a) => a.status === "approved" && a.file === file);
  if (i < 0) return;
  items[i] = { ...items[i], status: "applied", decidedAt: new Date().toISOString() };
  writeAmendments(projectDir, entryId, items);
}

/** The entry's stage records, oldest first; `stage` filters. An unreadable file is skipped. */
export function readStageRecords(
  projectDir: string,
  entryId: string,
  stage?: RecordStage,
): StageRecord[] {
  const dir = path.join(projectDir, EVIDENCE_DIR, entryId);
  const out: StageRecord[] = [];
  for (const f of recordFiles(dir)) {
    if (stage && f.stage !== stage) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(f.file, "utf-8")) as StageRecord;
      if (raw?.version === 1 && raw.stage === f.stage) out.push(raw);
    } catch {
      // A torn or hand-edited record says nothing; the gates run again.
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at) || a.n - b.n);
}
