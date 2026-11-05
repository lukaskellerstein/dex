import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { acceptanceHash } from "../acceptance.ts";
import { evidenceKey, tasksHash, writeDoneRecord, writeStageRecord } from "../evidence.ts";
import { type GateDecision, redFirst } from "../gates.ts";
import { describeQueue, type PickerDecision, pickNext } from "../picker.ts";
import { type QueueEntry, type QueueV3, resolveEntries } from "../queue.ts";
import { gateCheck } from "../stages/post-stage.ts";
import { commitFile, mkTmpRepo, rmTmp } from "./helpers/git.ts";
import { mkTmpProject, writeFiles } from "./helpers/project.ts";

// ── Fixtures ──

const SPEC_CLARIFIED = "# Spec\n\n## Clarifications\n\n### Session 2026-11-05\n\n- Q: a → A: b\n";

type TaskRow = [id: string, done: boolean];
function tasksMd(phases: Array<[name: string, rows: TaskRow[]]>): string {
  return phases
    .map(
      ([name, rows], i) =>
        `## Phase ${i + 1}: ${name}\n\n${rows.map(([id, done]) => `- [${done ? "X" : " "}] ${id} do ${id}`).join("\n")}\n`,
    )
    .join("\n");
}

const ALL_DONE = tasksMd([
  [
    "Setup",
    [
      ["T001", true],
      ["T002", true],
    ],
  ],
]);

/** A valid acceptance.json for `id` and its test file: the tests stage is done (016 R4). */
function acceptanceFiles(id: string, over: Record<string, unknown> = {}): Record<string, string> {
  const file = `tests/acceptance/${id}.spec.ts`;
  const record = {
    version: 1,
    command: `npx playwright test ${file}`,
    files: [file],
    covers: [{ test: `${id}.spec.ts › works`, criterion: "SC-001" }],
    ...over,
  };
  return { [file]: "// acceptance\n", [`specs/${id}/acceptance.json`]: JSON.stringify(record) };
}

/** Every artefact for `id`, every task checked. Verify needs a record too (`recordVerify`). */
function doneEntryFiles(id: string): Record<string, string> {
  return {
    [`specs/${id}/spec.md`]: SPEC_CLARIFIED,
    [`specs/${id}/plan.md`]: "# Plan\n",
    [`specs/${id}/tasks.md`]: ALL_DONE,
    ...acceptanceFiles(id),
  };
}

type RecordOpts = { gate?: "passed" | "failed"; tasks?: string; red?: boolean; blocking?: boolean };

/** Writes the done record a verify stage would leave for `id`, keyed by the entry as it is now. */
function recordVerify(dir: string, id: string, kind: QueueV3["kind"], o: RecordOpts = {}): void {
  const specDir = `specs/${id}`;
  const key = evidenceKey(dir, kind, { branch: id, specDir });
  assert.ok(key, `no evidence key for ${id}`);
  const tasks = o.tasks ?? fs.readFileSync(path.join(dir, specDir, "tasks.md"), "utf8");
  const exitCode = o.red ? 1 : 0;
  writeDoneRecord(dir, {
    version: 2,
    entryId: id,
    key,
    tasksHash: tasksHash(tasks),
    checked: "2026-11-05T10:00:00Z",
    acceptance: [
      {
        name: "acceptance",
        command: "npx playwright test",
        exitCode,
        signal: null,
        durationMs: 1,
        result: o.red ? "fail" : "pass",
        reruns: 0,
        tail: [],
      },
    ],
    mode: o.red ? "diagnose" : "review",
    findings: o.blocking
      ? [{ severity: "blocking", summary: "the total is wrong", criterion: "SC-001", where: null }]
      : [],
    hypotheses: [],
    summary: "",
    gate: o.gate ?? (o.red || o.blocking ? "failed" : "passed"),
  });
}

function newQueue(entries: QueueEntry[]): QueueV3 {
  return { version: 3, kind: "new", entries };
}

function pickIn(
  files: Record<string, string>,
  queue: QueueV3,
  verified: Record<string, RecordOpts> = {},
): PickerDecision {
  const dir = mkTmpProject(files);
  try {
    for (const [id, o] of Object.entries(verified)) recordVerify(dir, id, queue.kind, o);
    return pickNext({ projectDir: dir, queue, runBranch: null });
  } finally {
    rmTmp(dir);
  }
}

function assertStage(d: PickerDecision, entryId: string, stage: string, taskPhase?: number): void {
  assert.equal(d.kind, "stage", `expected a stage, got ${JSON.stringify(d)}`);
  if (d.kind !== "stage") return;
  assert.equal(d.entry.id, entryId);
  assert.equal(d.stage, stage);
  if (taskPhase !== undefined) assert.equal(d.taskPhase, taskPhase);
  assert.ok(d.reason.length > 0, "a decision carries its reason");
}

function assertPause(d: PickerDecision, entryId: string, pattern: RegExp): void {
  assert.equal(d.kind, "pause", `expected a pause, got ${JSON.stringify(d)}`);
  if (d.kind !== "pause") return;
  assert.equal(d.entry.id, entryId);
  assert.equal(d.reason, "invalid_input");
  assert.match(d.detail, pattern);
}

const A = { id: "001-a", title: "A" };
const B = { id: "002-b", title: "B" };

// ── T037: one fixture per D-015-1 row ──

test("picker: brief missing and the entry has generate → brief", () => {
  const e = { ...A, brief: "docs/001-a.md", generate: { sources: ["GOAL.md"] } };
  assertStage(pickIn({ "GOAL.md": "goal\n" }, newQueue([e])), "001-a", "brief");
});

test("picker: no spec folder → specify", () => {
  assertStage(pickIn({}, newQueue([A])), "001-a", "specify");
});

test("picker: spec folder without spec.md → specify", () => {
  assertStage(pickIn({ "specs/001-a/notes.md": "x\n" }, newQueue([A])), "001-a", "specify");
});

test("picker: spec.md without ## Clarifications → clarify", () => {
  const files = { "specs/001-a/spec.md": "# Spec\n\n## Requirements\n" };
  assertStage(pickIn(files, newQueue([A])), "001-a", "clarify");
});

test("picker: no plan.md → plan", () => {
  const files = { "specs/001-a/spec.md": SPEC_CLARIFIED };
  assertStage(pickIn(files, newQueue([A])), "001-a", "plan");
});

test("picker: no tasks.md → tasks", () => {
  const files = { "specs/001-a/spec.md": SPEC_CLARIFIED, "specs/001-a/plan.md": "# Plan\n" };
  assertStage(pickIn(files, newQueue([A])), "001-a", "tasks");
});

test("picker: an unchecked task → implement on the first phase that has one", () => {
  const files = {
    ...acceptanceFiles("001-a"),
    "specs/001-a/spec.md": SPEC_CLARIFIED,
    "specs/001-a/plan.md": "# Plan\n",
    "specs/001-a/tasks.md": tasksMd([
      [
        "Setup",
        [
          ["T001", true],
          ["T002", true],
        ],
      ],
      [
        "Core",
        [
          ["T003", true],
          ["T004", false],
        ],
      ],
      ["Polish", [["T005", false]]],
    ]),
  };
  assertStage(pickIn(files, newQueue([A])), "001-a", "implement", 2);
});

test("picker: every task checked and no verify record → verify", () => {
  assertStage(pickIn(doneEntryFiles("001-a"), newQueue([A])), "001-a", "verify");
});

test("picker: a verify record for a different tasks.md → verify", () => {
  const d = pickIn(doneEntryFiles("001-a"), newQueue([A]), { "001-a": { tasks: "other\n" } });
  assertStage(d, "001-a", "verify");
});

test("picker: a done record that failed for the entry as it is → verify again, naming why", () => {
  const red = pickIn(doneEntryFiles("001-a"), newQueue([A]), { "001-a": { red: true } });
  assertStage(red, "001-a", "verify");
  assert.match(red.kind === "stage" ? red.reason : "", /acceptance run was red \(acceptance\)/);
  const blocking = pickIn(doneEntryFiles("001-a"), newQueue([A]), { "001-a": { blocking: true } });
  assert.match(blocking.kind === "stage" ? blocking.reason : "", /1 blocking finding was open/);
});

test("picker: only a 015 verify.json, with a passed verdict → verify (it reads as absent)", () => {
  const dir = mkTmpProject(doneEntryFiles("001-a"));
  try {
    const key = evidenceKey(dir, "new", { branch: "001-a", specDir: "specs/001-a" });
    writeFiles(dir, {
      ".dex/evidence/001-a/verify.json": JSON.stringify({
        version: 1,
        entryId: "001-a",
        key,
        tasksHash: tasksHash(ALL_DONE),
        verdict: "passed",
      }),
    });
    const d = pickNext({ projectDir: dir, queue: newQueue([A]), runBranch: null });
    assertStage(d, "001-a", "verify");
    assert.match(d.kind === "stage" ? d.reason : "", /no done record/);
  } finally {
    rmTmp(dir);
  }
});

test("picker: verify passed for the entry as it is → done, the next entry is picked", () => {
  const d = pickIn(doneEntryFiles("001-a"), newQueue([A, B]), { "001-a": {} });
  assertStage(d, "002-b", "specify");
});

test("picker: every entry done or skipped → complete", () => {
  const queue = newQueue([A, { ...B, status: "skipped" }]);
  assert.deepEqual(pickIn(doneEntryFiles("001-a"), queue, { "001-a": {} }), { kind: "complete" });
});

test("picker: [X] and [x] both count as checked", () => {
  const lower = ALL_DONE.replaceAll("[X]", "[x]");
  const files = { ...doneEntryFiles("001-a"), "specs/001-a/tasks.md": lower };
  assert.deepEqual(pickIn(files, newQueue([A]), { "001-a": {} }), { kind: "complete" });
});

test("picker: new project — a change in the spec folder after verify → verify again", () => {
  const dir = mkTmpProject(doneEntryFiles("001-a"));
  try {
    recordVerify(dir, "001-a", "new");
    writeFiles(dir, { "specs/001-a/plan.md": "# Plan\n\nchanged\n" });
    assertStage(
      pickNext({ projectDir: dir, queue: newQueue([A]), runBranch: null }),
      "001-a",
      "verify",
    );
  } finally {
    rmTmp(dir);
  }
});

test("picker: new project — later work outside the spec folder keeps the entry done", () => {
  const dir = mkTmpProject(doneEntryFiles("001-a"));
  try {
    recordVerify(dir, "001-a", "new");
    writeFiles(dir, { "src/002-b/index.ts": "export {};\n", "specs/002-b/spec.md": "# Spec\n" });
    assertStage(
      pickNext({ projectDir: dir, queue: newQueue([A, B]), runBranch: null }),
      "002-b",
      "clarify",
    );
  } finally {
    rmTmp(dir);
  }
});

// ── T038: skip, human status, task scope, bad input, existing projects ──

test("picker: skip treats the listed stages as done", () => {
  const e = { ...A, skip: ["specify", "clarify", "plan"] as QueueEntry["skip"] };
  assertStage(pickIn({}, newQueue([e])), "001-a", "tasks");
  const noVerify = { ...A, skip: ["verify"] as QueueEntry["skip"] };
  assert.deepEqual(pickIn(doneEntryFiles("001-a"), newQueue([noVerify])), { kind: "complete" });
});

test("picker: human status done or skipped passes over the entry without reading files", () => {
  const d = pickIn(
    {},
    newQueue([
      { ...A, status: "done" },
      { ...B, status: "skipped" },
    ]),
  );
  assert.deepEqual(d, { kind: "complete" });
});

test("picker: out-of-scope unchecked tasks do not block verify", () => {
  const tasks = tasksMd([
    [
      "Core",
      [
        ["T001", true],
        ["T002", false],
      ],
    ],
    ["Later", [["T003", false]]],
  ]);
  const files = {
    ...acceptanceFiles("001-a"),
    "specs/001-a/spec.md": SPEC_CLARIFIED,
    "specs/001-a/plan.md": "# Plan\n",
    "specs/001-a/tasks.md": tasks,
  };
  assertStage(pickIn(files, newQueue([{ ...A, tasks: ["T001"] }])), "001-a", "verify");
  assertStage(pickIn(files, newQueue([{ ...A, tasks: ["T001-T002"] }])), "001-a", "implement", 1);
});

test("picker: a fix phase is in scope even with a task filter", () => {
  const tasks = `${tasksMd([
    [
      "Core",
      [
        ["T001", true],
        ["T002", false],
      ],
    ],
  ])}\n## Phase 2: Verify fixes V1\n\n- [ ] T003 fix it\n`;
  const files = {
    ...acceptanceFiles("001-a"),
    "specs/001-a/spec.md": SPEC_CLARIFIED,
    "specs/001-a/plan.md": "# Plan\n",
    "specs/001-a/tasks.md": tasks,
  };
  assertStage(pickIn(files, newQueue([{ ...A, tasks: ["T001"] }])), "001-a", "implement", 2);
});

test("picker: task ids that tasks.md does not have → pause invalid_input", () => {
  const files = {
    ...acceptanceFiles("001-a"),
    "specs/001-a/spec.md": SPEC_CLARIFIED,
    "specs/001-a/plan.md": "# Plan\n",
    "specs/001-a/tasks.md": ALL_DONE,
  };
  assertPause(
    pickIn(files, newQueue([{ ...A, tasks: ["T001", "T900-T901"] }])),
    "001-a",
    /T900, T901/,
  );
});

test("picker: a brief path that is missing, with no generate → pause invalid_input", () => {
  assertPause(pickIn({}, newQueue([{ ...A, brief: "docs/a.md" }])), "001-a", /docs\/a\.md/);
});

test("picker: an existing brief goes straight to specify", () => {
  const e = { ...A, brief: "docs/a.md", generate: { sources: ["GOAL.md"] } };
  assertStage(pickIn({ "docs/a.md": "# Brief\n" }, newQueue([e])), "001-a", "specify");
});

test("picker: existing project reads an entry's own branch while another is checked out", () => {
  const dir = mkTmpRepo();
  try {
    // 020 is finished on its own branch; 021 has a brief on main and no branch yet.
    execSync("git switch -q -c 020-catalog", { cwd: dir });
    for (const [rel, content] of Object.entries(doneEntryFiles("020-catalog"))) {
      commitFile(dir, rel, content, `add ${rel}`);
    }
    execSync("git switch -q main", { cwd: dir });
    recordVerify(dir, "020-catalog", "existing", { tasks: ALL_DONE });
    commitFile(dir, "docs/021.md", "# Brief\n", "brief 021");

    const queue: QueueV3 = {
      version: 3,
      kind: "existing",
      entries: [
        { id: "020-catalog", title: "Catalog" },
        { id: "021-cart", title: "Cart", brief: "docs/021.md", baseBranch: "main" },
      ],
    };
    const d = pickNext({ projectDir: dir, queue, runBranch: null });
    assertStage(d, "021-cart", "specify");

    const view = describeQueue({ projectDir: dir, queue, runBranch: null });
    assert.deepEqual(
      view.entries.map((e) => [e.id, e.status, e.nextStage]),
      [
        ["020-catalog", "done", null],
        ["021-cart", "active", "specify"],
      ],
    );
  } finally {
    rmTmp(dir);
  }
});

test("picker: existing project with the entry branch missing reads the base branch", () => {
  const dir = mkTmpRepo();
  try {
    execSync("git switch -q -c develop", { cwd: dir });
    commitFile(dir, "docs/a.md", "# Brief\n", "brief on develop");
    execSync("git switch -q main", { cwd: dir });
    const queue: QueueV3 = {
      version: 3,
      kind: "existing",
      entries: [{ id: "001-a", title: "A", brief: "docs/a.md", baseBranch: "develop" }],
    };
    // The brief lives only on develop. Read from main it would be "missing".
    assertStage(pickNext({ projectDir: dir, queue, runBranch: null }), "001-a", "specify");
  } finally {
    rmTmp(dir);
  }
});

test("picker: base branch has work past specify but the entry branch is missing → pause", () => {
  const dir = mkTmpRepo();
  try {
    commitFile(dir, "specs/001-a/spec.md", SPEC_CLARIFIED, "spec on main");
    const queue: QueueV3 = { version: 3, kind: "existing", entries: [{ id: "001-a", title: "A" }] };
    assertPause(pickNext({ projectDir: dir, queue, runBranch: null }), "001-a", /branch "001-a"/);
  } finally {
    rmTmp(dir);
  }
});

test("picker: the working tree counts for the current branch (uncommitted ticks)", () => {
  const dir = mkTmpRepo();
  try {
    execSync("git switch -q -c 001-a", { cwd: dir });
    const pending = tasksMd([["Core", [["T001", false]]]]);
    for (const [rel, content] of Object.entries(acceptanceFiles("001-a"))) {
      commitFile(dir, rel, content, `add ${rel}`);
    }
    commitFile(dir, "specs/001-a/spec.md", SPEC_CLARIFIED, "spec");
    commitFile(dir, "specs/001-a/plan.md", "# Plan\n", "plan");
    commitFile(dir, "specs/001-a/tasks.md", pending, "tasks");
    writeFiles(dir, { "specs/001-a/tasks.md": pending.replace("[ ]", "[X]") });
    const queue: QueueV3 = { version: 3, kind: "existing", entries: [{ id: "001-a", title: "A" }] };
    assertStage(pickNext({ projectDir: dir, queue, runBranch: null }), "001-a", "verify");
  } finally {
    rmTmp(dir);
  }
});

test("picker: existing project — a commit on the entry branch after done → verify again", () => {
  const dir = mkTmpRepo();
  try {
    execSync("git switch -q -c 001-a", { cwd: dir });
    for (const [rel, content] of Object.entries(doneEntryFiles("001-a"))) {
      commitFile(dir, rel, content, `add ${rel}`);
    }
    const queue: QueueV3 = { version: 3, kind: "existing", entries: [{ id: "001-a", title: "A" }] };
    recordVerify(dir, "001-a", "existing");
    assert.deepEqual(pickNext({ projectDir: dir, queue, runBranch: null }), { kind: "complete" });
    assert.equal(execSync("git status --porcelain", { cwd: dir, encoding: "utf8" }), "");

    commitFile(dir, "src/index.ts", "export const late = 1;\n", "a late change");
    const d = pickNext({ projectDir: dir, queue, runBranch: null });
    assertStage(d, "001-a", "verify");
    assert.match(d.kind === "stage" ? d.reason : "", /commits since the last verify/);
  } finally {
    rmTmp(dir);
  }
});

test("describeQueue: statuses and next stages for every entry, read-only", () => {
  const files = { ...doneEntryFiles("001-a"), "specs/002-b/spec.md": "# Spec\n" };
  const dir = mkTmpProject(files);
  try {
    recordVerify(dir, "001-a", "new");
    const queue = newQueue([
      A,
      B,
      { id: "003-c", title: "C" },
      { id: "004-d", title: "D", status: "skipped" },
    ]);
    const view = describeQueue({ projectDir: dir, queue, runBranch: null }, { "002-b": 1.5 });
    assert.equal(view.kind, "new");
    assert.deepEqual(
      view.entries.map((e) => [e.id, e.status, e.nextStage, e.costUsd]),
      [
        ["001-a", "done", null, 0],
        ["002-b", "active", "clarify", 1.5],
        ["003-c", "pending", "specify", 0],
        ["004-d", "skipped", null, 0],
      ],
    );
  } finally {
    rmTmp(dir);
  }
});

// ── 016 research R4: the tests rows between tasks and implement ──

const PLANNED = {
  "specs/001-a/spec.md": SPEC_CLARIFIED,
  "specs/001-a/plan.md": "# Plan\n",
  "specs/001-a/tasks.md": tasksMd([["Core", [["T001", false]]]]),
};

/** A red-first record for the acceptance.json in `dir`, as the tests stage leaves it. */
function recordRedFirst(dir: string, gate: GateDecision): void {
  const text = fs.readFileSync(path.join(dir, "specs/001-a/acceptance.json"), "utf8");
  writeStageRecord(dir, {
    entryId: "001-a",
    stage: "red-first",
    mode: null,
    taskPhase: null,
    key: null,
    tasksHash: null,
    startSha: null,
    endSha: null,
    treeStamp: "t",
    runs: [],
    planDiff: null,
    testChanges: null,
    fingerprint: null,
    gate,
    acceptanceHash: acceptanceHash(text),
    summary: null,
  });
}

function pickWithRedFirst(
  files: Record<string, string>,
  gate: GateDecision | null,
): PickerDecision {
  const dir = mkTmpProject(files);
  try {
    if (gate) recordRedFirst(dir, gate);
    return pickNext({ projectDir: dir, queue: newQueue([A]), runBranch: null });
  } finally {
    rmTmp(dir);
  }
}

const CRASH = redFirst(null, null, false, "the acceptance command crashed (exit 2)");

test("picker R4: acceptance.json missing → tests", () => {
  const d = pickIn(PLANNED, newQueue([A]));
  assertStage(d, "001-a", "tests");
  assert.match(d.kind === "stage" ? d.reason : "", /acceptance\.json is missing/);
});

test("picker R4: the last red-first run of this acceptance.json crashed → tests again", () => {
  const d = pickWithRedFirst({ ...PLANNED, ...acceptanceFiles("001-a") }, CRASH);
  assertStage(d, "001-a", "tests");
  assert.match(d.kind === "stage" ? d.reason : "", /crashed: the acceptance command crashed/);
});

test("picker R4: red-first passed, or no red-first record at all → implement", () => {
  const files = { ...PLANNED, ...acceptanceFiles("001-a") };
  const passed: GateDecision = {
    gate: "red-first",
    outcome: "pass",
    pauseReason: null,
    reason: "the acceptance tests fail by an assertion (exit 1)",
    next: null,
  };
  assertStage(pickWithRedFirst(files, passed), "001-a", "implement", 1);
  assertStage(pickWithRedFirst(files, null), "001-a", "implement", 1);
});

test("picker R4: a crash recorded for another acceptance.json does not send it back", () => {
  const dir = mkTmpProject({ ...PLANNED, ...acceptanceFiles("001-a") });
  try {
    recordRedFirst(dir, CRASH);
    writeFiles(dir, acceptanceFiles("001-a", { failExitCodes: [1, 2] }));
    assertStage(
      pickNext({ projectDir: dir, queue: newQueue([A]), runBranch: null }),
      "001-a",
      "implement",
    );
  } finally {
    rmTmp(dir);
  }
});

test("picker R4: skip tests with a queue acceptance → implement; without one → pause", () => {
  const skip = { ...A, skip: ["tests"] as QueueEntry["skip"] };
  const withAcc = { ...skip, acceptance: [{ name: "api", command: "npm run acc" }] };
  assertStage(pickIn(PLANNED, newQueue([withAcc])), "001-a", "implement", 1);
  assertPause(pickIn(PLANNED, newQueue([skip])), "001-a", /skips "tests" and has no "acceptance"/);
});

test("picker R4: an acceptance.json a human broke later → pause invalid_input", () => {
  const broken = { ...PLANNED, ...acceptanceFiles("001-a", { failExitCodes: [0] }) };
  assertPause(pickIn(broken, newQueue([A])), "001-a", /"failExitCodes" must be .* fix .* by hand/);
  const notJson = { ...PLANNED, "specs/001-a/acceptance.json": "{" };
  assertPause(pickIn(notJson, newQueue([A])), "001-a", /not valid JSON/);
});

test("picker R4: a tests gate pauses after the stage, and the picker then moves on", () => {
  const [entry] = resolveEntries(newQueue([{ ...A, gates: ["tests"] }]), "main", null);
  assert.equal(gateCheck(entry, "tests")?.reason, "gate");
  const files = { ...PLANNED, ...acceptanceFiles("001-a") };
  assertStage(pickIn(files, newQueue([{ ...A, gates: ["tests"] }])), "001-a", "implement");
});
