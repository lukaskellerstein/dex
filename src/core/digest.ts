/**
 * What: The one-page digest of an entry (016 R15, FR-037) — `.dex/digests/<id>.md`, rewritten at every pause that has an entry and when the entry is done. `digestFacts` reads what Dex knows: the stage records (check runs, acceptance runs, skip markers), `done.json` (the verifier's findings), tasks.md (in-scope tasks done), the run state (questions answered by default, the entry's cost this run), and a diff stat per repo from the entry's first stage start (the project's `startSha`; an extra checkout of the policy's `repos` from its HEAD at the first record's time). `renderDigest` turns the facts into the page, sections in FR-037 order; `writeDigest` writes it into a folder that ignores itself; `publishDigest` does all three and emits `digest_written`.
 * Not: Decides nothing and pauses nothing (the loop does). Writes no tracked file.
 * Deps: evidence.{readStageRecords, readDoneRecord}, acceptance.fastChecksFor, parser.parseTasksMd, queue.isInScope, state.readState, run-snapshot.costsByEntry, sensors.isGreen, node:child_process (git, no shell), node:fs, node:path.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fastChecksFor } from "./acceptance.js";
import type { EmitFn } from "./events.js";
import { type DoneRecord, readDoneRecord, readStageRecords, type StageRecord } from "./evidence.js";
import type { ReviewItem } from "./humanInput.js";
import { parseTasksMd } from "./parser.js";
import type { Policy } from "./policy.js";
import { isInScope, type ResolvedEntry } from "./queue.js";
import { costsByEntry } from "./run-snapshot.js";
import { isGreen, type SensorRun } from "./sensors.js";
import { readState } from "./state.js";

export interface FileDiff {
  path: string;
  /** Null for a binary file. */
  added: number | null;
  deleted: number | null;
}

export interface RepoDiff {
  /** Project-relative; "" for the project itself. */
  repo: string;
  /** Short start commit; null when there is none to compare with. */
  since: string | null;
  files: FileDiff[];
}

export interface DigestFacts {
  entryId: string;
  /** `done`, or `paused at <stage>: <reason>`. */
  status: string;
  /** The pause detail; null when done. */
  why: string | null;
  diffs: RepoDiff[];
  tasks: { done: string[]; inScope: number };
  /** FR-020: false when the policy and the entry declare no fast check. */
  fastDeclared: boolean;
  /** Every check's runs over the entry's baseline and implement records, oldest first. */
  checks: Array<{ name: string; runs: SensorRun[] }>;
  /** The newest acceptance runs and where they ran; null before any. */
  acceptance: { stage: string; runs: SensorRun[] } | null;
  done: DoneRecord | null;
  skipMarkers: string[];
  answered: ReviewItem[];
  costUsd: number;
}

// ── Facts ──

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
}

function numstat(cwd: string, sha: string): FileDiff[] {
  return git(cwd, ["diff", "--numstat", "-M", sha])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [a, d, ...rest] = line.split("\t");
      const num = (v: string) => (v === "-" ? null : Number(v));
      return { path: rest.join("\t"), added: num(a), deleted: num(d) };
    });
}

function repoDiff(cwd: string, repo: string, sha: string | null): RepoDiff {
  if (!sha) return { repo, since: null, files: [] };
  try {
    return { repo, since: sha.slice(0, 7), files: numstat(cwd, sha) };
  } catch {
    return { repo, since: null, files: [] };
  }
}

/** The policy's extra checkouts, project-relative, sorted. */
function extraRepos(projectDir: string, policy: Policy): string[] {
  return policy.repos
    .flatMap((glob) => fs.globSync(glob, { cwd: projectDir }))
    .filter((rel) => fs.existsSync(path.join(projectDir, rel, ".git")))
    .sort();
}

function diffs(projectDir: string, policy: Policy, records: StageRecord[]): RepoDiff[] {
  const first = records.find((r) => r.startSha) ?? null;
  const at = records[0]?.at ?? null;
  const extra = extraRepos(projectDir, policy).map((rel) => {
    const cwd = path.join(projectDir, rel);
    let sha: string | null = null;
    try {
      sha = at ? git(cwd, ["rev-list", "-1", `--before=${at}`, "HEAD"]).trim() || null : null;
    } catch {
      sha = null;
    }
    return repoDiff(cwd, rel, sha);
  });
  return [repoDiff(projectDir, "", first?.startSha ?? null), ...extra];
}

function tasksDone(projectDir: string, entry: ResolvedEntry): DigestFacts["tasks"] {
  let md = "";
  try {
    md = fs.readFileSync(path.join(projectDir, entry.specDir, "tasks.md"), "utf-8");
  } catch {
    return { done: [], inScope: 0 };
  }
  const scoped = parseTasksMd(md).flatMap((p) => p.tasks.filter((t) => isInScope(entry, p, t)));
  return {
    done: scoped.filter((t) => t.status === "done").map((t) => t.id),
    inScope: scoped.length,
  };
}

function checkRuns(
  policy: Policy,
  entry: ResolvedEntry,
  records: StageRecord[],
): DigestFacts["checks"] {
  const names = [...fastChecksFor(policy, entry), ...policy.checks.standing].map((c) => c.name);
  const runs = records
    .filter((r) => r.stage === "baseline" || r.stage === "implement")
    .flatMap((r) => r.runs);
  return [...new Set(names)].map((name) => ({ name, runs: runs.filter((r) => r.name === name) }));
}

function acceptanceRuns(records: StageRecord[]): DigestFacts["acceptance"] {
  const last = records
    .filter((r) => (r.stage === "verify" || r.stage === "red-first") && r.runs.length > 0)
    .at(-1);
  return last ? { stage: last.stage, runs: last.runs } : null;
}

/** What Dex knows about the entry now. */
export function digestFacts(
  projectDir: string,
  entry: ResolvedEntry,
  policy: Policy,
  status: { status: string; why: string | null },
): DigestFacts {
  const records = readStageRecords(projectDir, entry.id);
  const state = readState(projectDir);
  const markers = records.flatMap((r) => r.testChanges?.skipMarkers ?? []);
  return {
    entryId: entry.id,
    ...status,
    diffs: diffs(projectDir, policy, records),
    tasks: tasksDone(projectDir, entry),
    fastDeclared: fastChecksFor(policy, entry).length > 0,
    checks: checkRuns(policy, entry, records),
    acceptance: acceptanceRuns(records),
    done: readDoneRecord(projectDir, entry.id),
    skipMarkers: [...new Set(markers)],
    answered: (state?.reviewList ?? []).filter((i) => i.entryId === entry.id),
    costUsd: state ? (costsByEntry(projectDir, state.runId)[entry.id] ?? 0) : 0,
  };
}

// ── The page ──

const MAX_FILES = 5;
const mark = (run: SensorRun) => (isGreen(run) ? "✓" : "✗");

function diffLine(d: RepoDiff): string {
  const label = d.repo ? `**Diff** ${d.repo}` : "**Diff**";
  if (!d.since) return `${label}: no start commit to compare with`;
  if (d.files.length === 0) return `${label} (since ${d.since}): no changes`;
  const size = (f: FileDiff) => (f.added ?? 0) + (f.deleted ?? 0);
  const top = [...d.files].sort((a, b) => size(b) - size(a)).slice(0, MAX_FILES);
  const shown = top.map((f) =>
    f.added === null ? `${f.path} (binary)` : `${f.path} +${f.added} −${f.deleted}`,
  );
  const more = d.files.length > MAX_FILES ? ` · … ${d.files.length - MAX_FILES} more` : "";
  const n = d.files.length;
  return `${label} (since ${d.since}): ${shown.join(" · ")}${more} · ${n} file${n === 1 ? "" : "s"}`;
}

/** T002, T004, T005 → "T002, T004–T005". */
export function idRanges(ids: string[]): string {
  const groups: string[][] = [];
  for (const id of ids) {
    const prev = groups.at(-1)?.at(-1);
    if (prev && Number(id.slice(1)) === Number(prev.slice(1)) + 1) groups.at(-1)?.push(id);
    else groups.push([id]);
  }
  return groups.map((g) => (g.length > 1 ? `${g[0]}–${g.at(-1)}` : g[0])).join(", ");
}

function checkLine(c: DigestFacts["checks"][number]): string {
  const last = c.runs.at(-1);
  if (!last) return `${c.name} not run`;
  let redRun = 0;
  for (const r of [...c.runs].reverse()) {
    if (isGreen(r)) break;
    redRun++;
  }
  const flaky = c.runs.filter((r) => r.result === "flaky").length;
  const notes = [
    redRun > 1 ? `red ${redRun} runs in a row` : "",
    flaky > 0 ? `flaky ×${flaky}` : "",
  ].filter(Boolean);
  return `${c.name} ${mark(last)}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`;
}

function checksLine(f: DigestFacts): string {
  const runs = f.checks.filter((c) => c.runs.length > 0).map(checkLine);
  const none = f.fastDeclared
    ? []
    : ["no fast checks ran (none declared; the progress gate rests on the plan diff alone)"];
  const all = [...none, ...runs];
  return `**Checks**: ${all.length > 0 ? all.join(" · ") : "not run yet"}`;
}

function acceptanceLine(a: DigestFacts["acceptance"]): string {
  if (!a) return "**Acceptance**: not run yet";
  const runs = a.runs.map(
    (r) => `${r.name} ${mark(r)} (${r.exitCode === null ? r.result : `exit ${r.exitCode}`})`,
  );
  return `**Acceptance** (at ${a.stage}): ${runs.join(" · ")}`;
}

function verifierLines(done: DoneRecord | null): string[] {
  if (!done) return ["**Verifier**: —"];
  if (done.mode === "diagnose") {
    const h = done.hypotheses.length > 0 ? `; hypotheses: ${done.hypotheses.join(" · ")}` : "";
    return [
      `**Verifier** (diagnose, done gate ${done.gate}): ${done.summary || "(no summary)"}${h}`,
    ];
  }
  const blocking = done.findings.filter((x) => x.severity === "blocking").length;
  const head = `**Verifier** (review, done gate ${done.gate}): ${blocking} blocking, ${done.findings.length - blocking} minor — ${done.summary || "(no summary)"}`;
  const items = done.findings.map(
    (x) => `- ${x.severity}: ${x.summary}${x.where ? ` (${x.where})` : ""}`,
  );
  return items.length > 0 ? [head, "", ...items] : [head];
}

/** The page, in FR-037 order: status, diff per repo, tasks, checks, acceptance, verifier, skip markers, defaults, cost. */
export function renderDigest(f: DigestFacts): string {
  const answered = f.answered.map((i) => `"${i.question}" → "${i.answer}"`);
  const sections = [
    `# ${f.entryId} — ${f.status}`,
    ...(f.why ? [`**Why**: ${f.why}`] : []),
    f.diffs.map(diffLine).join("\n\n"),
    `**Tasks done**: ${f.tasks.done.length > 0 ? idRanges(f.tasks.done) : "none"} (${f.tasks.done.length} of ${f.tasks.inScope} in scope)`,
    checksLine(f),
    acceptanceLine(f.acceptance),
    verifierLines(f.done).join("\n"),
    `**Skip markers**: ${f.skipMarkers.length > 0 ? f.skipMarkers.join(" · ") : "none"}`,
    `**Answered by default**: ${answered.length > 0 ? `${answered.length} — ${answered.join(" · ")}` : "none"}`,
    `**Cost**: $${f.costUsd.toFixed(2)} this entry, this run`,
  ];
  return `${sections.join("\n\n")}\n`;
}

/** Writes `.dex/digests/<id>.md`; the folder ignores itself. Returns the absolute path. */
export function writeDigest(projectDir: string, entryId: string, markdown: string): string {
  const dir = path.join(projectDir, ".dex", "digests");
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n", "utf-8");
  const file = path.join(dir, `${entryId}.md`);
  fs.writeFileSync(`${file}.tmp`, markdown, "utf-8");
  fs.renameSync(`${file}.tmp`, file);
  return file;
}

/** Builds, writes and announces the entry's digest (`digest_written`). Returns the absolute path. */
export function publishDigest(
  io: { projectDir: string; runId: string; emit: EmitFn },
  entry: ResolvedEntry,
  policy: Policy,
  status: { status: string; why: string | null },
): string {
  const markdown = renderDigest(digestFacts(io.projectDir, entry, policy, status));
  const file = writeDigest(io.projectDir, entry.id, markdown);
  io.emit({ type: "digest_written", runId: io.runId, entryId: entry.id, path: file });
  return file;
}

/** A queue entry id is one path segment; anything else could read outside `.dex/digests/`. */
const ENTRY_ID_RE = /^(?!\.{1,2}$)[\w.-]+$/;

/** The digest's path, when one exists. */
export function digestPath(projectDir: string, entryId: string): string | null {
  if (!ENTRY_ID_RE.test(entryId)) return null;
  const file = path.join(projectDir, ".dex", "digests", `${entryId}.md`);
  return fs.existsSync(file) ? file : null;
}

/** The digest and its path, for the app (`project:get-digest`); null when there is none. */
export function readDigest(
  projectDir: string,
  entryId: string,
): { markdown: string; path: string } | null {
  const file = digestPath(projectDir, entryId);
  return file ? { markdown: fs.readFileSync(file, "utf-8"), path: file } : null;
}
