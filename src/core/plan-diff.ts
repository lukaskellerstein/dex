/**
 * What: What an implement run did to the plan and the tests (research R8, R9) — pure text in, findings out. `diffTasks` compares the task lines and phase headings of `tasks.md` before and after, by task id: the only allowed change is an open box that becomes done; a removed, added, reworded, reordered or re-opened task, or a changed phase heading, is a violation that names it. `testFileChanges` reads `git diff --name-status -M` output: frozen test files changed, moved or deleted, and files matching `testGlobs` deleted or renamed. `addedLines` and `skipMarkers` find new skip and expected-failure markers in the added lines of a diff.
 * Not: Runs no git and reads no file (stages/gate-runs.ts does). Prose and notes in tasks.md are ignored: only task lines and phase headings count.
 * Deps: node:path (matchesGlob).
 */

import path from "node:path";

const TASK_LINE = /^- \[([ xX~])\] (T\d+)\b\s*(.*)$/;
const PHASE_HEADER = /^## (?:TaskPhase|Phase) \d+: .+$/;

interface TaskLine {
  id: string;
  done: boolean;
  /** The line without its checkbox. */
  text: string;
}

function planOf(md: string): { tasks: TaskLine[]; headings: string[] } {
  const tasks: TaskLine[] = [];
  const headings: string[] = [];
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    if (PHASE_HEADER.test(line)) headings.push(line);
    const m = TASK_LINE.exec(line);
    if (m) tasks.push({ id: m[2], done: m[1] === "x" || m[1] === "X", text: m[3].trim() });
  }
  return { tasks, headings };
}

function headingChanges(before: string[], after: string[]): string[] {
  const out = before.filter((h) => !after.includes(h)).map((h) => `the phase heading "${h}" was changed or removed`);
  out.push(...after.filter((h) => !before.includes(h)).map((h) => `the phase heading "${h}" was added`));
  if (out.length === 0 && before.join("\n") !== after.join("\n")) out.push("the phase headings were reordered");
  return out;
}

/** Every change to tasks.md other than ticking an open task, each naming its task (R8). Empty when intact. */
export function diffTasks(before: string, after: string): string[] {
  const a = planOf(before);
  const b = planOf(after);
  const byId = new Map(b.tasks.map((t) => [t.id, t]));
  const beforeIds = new Set(a.tasks.map((t) => t.id));
  const out: string[] = [];
  for (const t of a.tasks) {
    const now = byId.get(t.id);
    if (!now) out.push(`${t.id} was removed`);
    else if (now.text !== t.text) out.push(`${t.id} was reworded: "${t.text}" → "${now.text}"`);
    else if (t.done && !now.done) out.push(`${t.id} was re-opened`);
  }
  out.push(...b.tasks.filter((t) => !beforeIds.has(t.id)).map((t) => `${t.id} was added`));
  const order = (ts: TaskLine[], keep: Set<string>) => ts.map((t) => t.id).filter((id) => keep.has(id));
  const common = new Set(a.tasks.map((t) => t.id).filter((id) => byId.has(id)));
  const was = order(a.tasks, common);
  const is = order(b.tasks, common);
  const moved = was.findIndex((id, i) => is[i] !== id);
  if (moved >= 0) out.push(`the task order changed at ${was[moved]}`);
  return [...out, ...headingChanges(a.headings, b.headings)];
}

const matchesAny = (rel: string, globs: readonly string[]) => globs.some((g) => path.matchesGlob(rel, g));

/** Frozen tests changed, moved or deleted, and test files deleted or renamed, from `git diff --name-status -M`. */
export function testFileChanges(
  nameStatus: string,
  testGlobs: readonly string[],
  frozen: readonly string[],
): { frozenChanged: string[]; testsDeletedOrRenamed: string[] } {
  const frozenSet = new Set(frozen);
  const frozenChanged: string[] = [];
  const testsDeletedOrRenamed: string[] = [];
  for (const line of nameStatus.split("\n")) {
    const [status = "", from = "", to] = line.split("\t");
    if (!from) continue;
    const kind = status[0];
    if (frozenSet.has(from) && kind !== "A") frozenChanged.push(from);
    const gone = kind === "D" || kind === "R";
    if (gone && matchesAny(from, testGlobs)) {
      testsDeletedOrRenamed.push(kind === "R" && to ? `${from} → ${to}` : from);
    }
  }
  return { frozenChanged, testsDeletedOrRenamed };
}

/** The lines a unified diff adds, with their file (`git diff <sha>`). */
export function addedLines(diff: string): Array<{ file: string; line: string }> {
  const out: Array<{ file: string; line: string }> = [];
  let file = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line.slice(4).replace(/^b\//, "");
      continue;
    }
    if (line.startsWith("+") && file && file !== "/dev/null") out.push({ file, line: line.slice(1) });
  }
  return out;
}

/** Skip and expected-failure markers of the common test runners (FR-028). */
const SKIP_MARKERS = [
  /@pytest\.mark\.(skip|skipif|xfail)\b/,
  /\bpytest\.(skip|xfail)\(/,
  /@unittest\.(skip\w*|expectedFailure)\b/,
  /\.skip\(/,
  /\b(xit|xdescribe|xtest)\(/,
  /\.todo\(/,
  /\.fixme\(/,
  /\.failing\(/,
  /\bt\.Skip(Now|f)?\(/,
];

/** New markers in test files, as `<file>: <line>`. Reported in the digest, never a pause. */
export function skipMarkers(
  added: Array<{ file: string; line: string }>,
  testGlobs: readonly string[],
): string[] {
  return added
    .filter((a) => matchesAny(a.file, testGlobs) && SKIP_MARKERS.some((re) => re.test(a.line)))
    .map((a) => `${a.file}: ${a.line.trim()}`);
}
