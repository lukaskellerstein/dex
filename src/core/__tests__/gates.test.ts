/**
 * The gates as tables (SC-001): one case per row of data-model.md § Gate rules,
 * plus flaky checks and the stall fingerprint. No agent, no fs, no git.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { AcceptanceRecord } from "../acceptance.ts";
import type { Finding, StageRecord } from "../evidence.ts";
import {
  baseline,
  done,
  FLAKY_LIMIT,
  fingerprint,
  flakyPause,
  isCrash,
  type ProgressInput,
  progress,
  redFirst,
  stalled,
} from "../gates.ts";
import type { SensorResult, SensorRun } from "../sensors.ts";

function run(name: string, result: SensorResult, tail: string[] = []): SensorRun {
  return {
    name,
    command: `check ${name}`,
    exitCode: result === "pass" || result === "flaky" ? 0 : 1,
    signal: null,
    durationMs: 10,
    result,
    reruns: result === "flaky" ? 1 : 0,
    tail,
  };
}

const outcome = (d: { outcome: string; pauseReason: string | null; next: string | null }) =>
  [d.outcome, d.pauseReason, d.next] as const;

// ── baseline ──

for (const [name, runs, expected] of [
  ["all green", [run("unit", "pass"), run("lint", "pass")], ["pass", null, null]],
  ["one red", [run("unit", "fail"), run("lint", "pass")], ["fail", null, "restore"]],
  ["flaky counts as green", [run("unit", "flaky")], ["pass", null, null]],
  ["a timeout is red", [run("unit", "timeout")], ["fail", null, "restore"]],
  ["an error is red", [run("unit", "error")], ["fail", null, "restore"]],
  ["no checks", [], ["pass", null, null]],
  [
    "before verify, a red standing run counts too",
    [run("unit", "pass"), run("full suite", "fail")],
    ["fail", null, "restore"],
  ],
] as const) {
  test(`baseline: ${name}`, () => {
    assert.deepEqual(outcome(baseline([...runs])), expected);
  });
}

test("baseline: the reason names the red checks", () => {
  assert.match(baseline([run("unit", "fail"), run("types", "timeout")]).reason, /"unit", "types"/);
});

// ── progress ──

const NO_CHANGES = { frozenChanged: [], testsDeletedOrRenamed: [] };

function prog(over: Partial<ProgressInput>): ProgressInput {
  return {
    mode: "phase",
    runs: [run("unit", "pass")],
    newlyTicked: ["T001"],
    planViolations: [],
    testChanges: NO_CHANGES,
    redAtBaseline: [],
    ...over,
  };
}

for (const [name, input, expected] of [
  ["phase: a new tick and green", prog({}), ["pass", null, null]],
  ["phase: a new tick and red", prog({ runs: [run("unit", "fail")] }), ["fail", null, "restore"]],
  ["phase: no tick and green", prog({ newlyTicked: [] }), ["fail", null, null]],
  [
    "phase: no tick and red",
    prog({ newlyTicked: [], runs: [run("unit", "fail")] }),
    ["fail", null, "restore"],
  ],
  ["phase: a tick and flaky", prog({ runs: [run("unit", "flaky")] }), ["pass", null, null]],
  ["phase: no fast checks, a tick (FR-020)", prog({ runs: [] }), ["pass", null, null]],
  [
    "phase: a plan violation pauses even when green",
    prog({ planViolations: ['T002 was reworded: "a" → "b"'] }),
    ["pause", "plan_changed", null],
  ],
  [
    "phase: a frozen test changed",
    prog({ testChanges: { frozenChanged: ["tests/a.spec.ts"], testsDeletedOrRenamed: [] } }),
    ["pause", "frozen_changed", null],
  ],
  [
    "phase: a test file deleted",
    prog({ testChanges: { frozenChanged: [], testsDeletedOrRenamed: ["src/a.test.ts"] } }),
    ["pause", "tests_changed", null],
  ],
  [
    "restore: every check red at baseline is green now",
    prog({ mode: "restore", newlyTicked: [], redAtBaseline: ["unit"] }),
    ["pass", null, null],
  ],
  [
    "restore: flaky counts as green",
    prog({
      mode: "restore",
      newlyTicked: [],
      redAtBaseline: ["unit"],
      runs: [run("unit", "flaky")],
    }),
    ["pass", null, null],
  ],
  [
    "restore: one still red",
    prog({
      mode: "restore",
      newlyTicked: [],
      redAtBaseline: ["unit", "lint"],
      runs: [run("unit", "pass"), run("lint", "fail")],
    }),
    ["fail", null, "restore"],
  ],
  [
    "restore: a violation pauses",
    prog({ mode: "restore", redAtBaseline: ["unit"], planViolations: ["T001 was re-opened"] }),
    ["pause", "plan_changed", null],
  ],
] as const) {
  test(`progress: ${name}`, () => {
    assert.deepEqual(outcome(progress(input)), expected);
  });
}

test("progress: the reason of a tick while red names the task and the check", () => {
  const d = progress(prog({ newlyTicked: ["T014"], runs: [run("unit", "fail")] }));
  assert.equal(d.reason, 'T014 is ticked, but the fast check "unit" is red');
  assert.equal(d.gate, "progress");
});

// ── fingerprint and stalled ──

test("fingerprint: the order of check names does not matter", () => {
  const a = fingerprint([run("unit", "fail", ["E1"]), run("lint", "fail", ["E2"])], "d");
  const b = fingerprint([run("lint", "fail", ["E2"]), run("unit", "fail", ["E1"])], "d");
  assert.equal(a, b);
});

test("fingerprint: a different first error line or diff hash changes it", () => {
  const base = fingerprint([run("unit", "fail", ["", "  E1", "more"])], "d");
  assert.notEqual(fingerprint([run("unit", "fail", ["E2"])], "d"), base);
  assert.notEqual(fingerprint([run("unit", "fail", ["E1"])], "other"), base);
  assert.equal(
    fingerprint([run("unit", "fail", ["E1", "other line"])], "d"),
    base,
    "first non-empty line",
  );
});

test("fingerprint: flaky and passing checks are left out", () => {
  const red = fingerprint([run("unit", "fail", ["E1"])], "d");
  assert.equal(fingerprint([run("unit", "fail", ["E1"]), run("lint", "flaky", ["x"])], "d"), red);
  assert.equal(fingerprint([run("unit", "fail", ["E1"]), run("types", "pass")], "d"), red);
});

for (const [name, fps, expected] of [
  ["three equal", ["a", "a", "a"], true],
  ["two equal", ["a", "a"], false],
  ["three with one different", ["a", "b", "a"], false],
  ["the last three equal after a different one", ["b", "a", "a", "a"], true],
  ["three missing", [null, null, null], false],
] as const) {
  test(`stalled: ${name}`, () => {
    assert.equal(stalled([...fps]), expected);
  });
}

// ── flaky ──

function rec(runs: SensorRun[]): StageRecord {
  return {
    version: 1,
    entryId: "001-a",
    stage: "implement",
    n: 1,
    mode: "phase",
    taskPhase: 1,
    key: null,
    tasksHash: null,
    startSha: null,
    endSha: null,
    treeStamp: "t",
    runs,
    planDiff: null,
    testChanges: null,
    fingerprint: null,
    gate: null,
    acceptanceHash: null,
    summary: null,
    at: "2026-11-05T10:00:00.000Z",
  };
}

test(`flakyPause: a check flaky ${FLAKY_LIMIT} times in the entry's records pauses, naming it`, () => {
  const flaky = run("unit", "flaky");
  const records = [rec([flaky]), rec([flaky, run("lint", "pass")]), rec([flaky])];
  const p = flakyPause(records, [flaky]);
  assert.equal(p?.reason, "flaky_check");
  assert.match(p?.detail ?? "", /"unit".*flaky 3 times.*001-a/);
});

test("flakyPause: twice is not enough; a fixed check does not pause on Resume", () => {
  const flaky = run("unit", "flaky");
  assert.equal(flakyPause([rec([flaky]), rec([flaky])], [flaky]), null);
  const three = [rec([flaky]), rec([flaky]), rec([flaky])];
  assert.equal(flakyPause(three, [run("unit", "pass")]), null, "the latest gate had no flake");
});

// ── red-first (R2, R20) ──

const ACC: AcceptanceRecord = {
  version: 1,
  command: "npx playwright test tests/acceptance/001-a",
  failExitCodes: [1],
  timeoutSec: 900,
  files: ["tests/acceptance/001-a/a.spec.ts"],
  covers: [{ test: "a.spec.ts › works", criterion: "SC-001" }],
};

function accRun(exitCode: number | null, result: SensorResult): SensorRun {
  return { ...run("acceptance", result), exitCode };
}

test("redFirst: an exit code in failExitCodes passes", () => {
  const d = redFirst(accRun(1, "fail"), ACC, false);
  assert.deepEqual(outcome(d), ["pass", null, null]);
  assert.match(d.reason, /fail by an assertion \(exit 1\)/);
});

test("redFirst: exit 0 pauses red_first_green, also after a crash", () => {
  for (const previousCrash of [false, true]) {
    const d = redFirst(accRun(0, "pass"), ACC, previousCrash);
    assert.deepEqual(outcome(d), ["pause", "red_first_green", null]);
  }
});

for (const [name, r, why] of [
  ["another exit code", accRun(2, "fail"), /crashed \(exit 2, expected one of 1\)/],
  ["a timeout", accRun(null, "timeout"), /timed out/],
  ["a command that cannot start", accRun(127, "error"), /crashed \(exit 127/],
  ["a stop by a signal", accRun(null, "error"), /could not run \(error\)/],
] as const) {
  test(`redFirst: ${name} is a crash → retry-tests; the second in a row pauses no_progress`, () => {
    const first = redFirst(r, ACC, false);
    assert.deepEqual(outcome(first), ["fail", null, "retry-tests"]);
    assert.match(first.reason, why);
    assert.ok(isCrash(first));
    const second = redFirst(r, ACC, true);
    assert.deepEqual(outcome(second), ["pause", "no_progress", null]);
    assert.match(second.reason, /second time in a row/);
    assert.ok(isCrash(second));
  });
}

test("redFirst: a missing or invalid record is a crash, and its problem is the reason", () => {
  const d = redFirst(null, null, false, 'acceptance.json: "version" must be 1');
  assert.deepEqual(outcome(d), ["fail", null, "retry-tests"]);
  assert.equal(d.reason, 'acceptance.json: "version" must be 1');
  assert.deepEqual(outcome(redFirst(null, null, true, "no file")), ["pause", "no_progress", null]);
});

// ── done (FR-005, FR-024, R13) ──

const blocking: Finding = {
  severity: "blocking",
  summary: "the cart total ignores the promo code",
  criterion: "SC-002",
  where: "src/cart/total.ts:12",
};
const minor: Finding = { severity: "minor", summary: "wording", criterion: null, where: null };

test("done: every acceptance run green and no blocking finding → pass", () => {
  assert.deepEqual(outcome(done([accRun(0, "pass")], [])), ["pass", null, null]);
  assert.deepEqual(outcome(done([accRun(0, "flaky"), run("api", "pass")], [])), [
    "pass",
    null,
    null,
  ]);
});

test("done: one red acceptance run → fail, next fix-phase", () => {
  const d = done([accRun(1, "fail"), run("api", "pass")], []);
  assert.deepEqual(outcome(d), ["fail", null, "fix-phase"]);
  assert.match(d.reason, /acceptance run is red: "acceptance"/);
});

test("done: green with a blocking finding → fail; minor findings only → pass", () => {
  const d = done([accRun(0, "pass")], [minor, blocking]);
  assert.deepEqual(outcome(d), ["fail", null, "fix-phase"]);
  assert.match(d.reason, /blocking finding is open: the cart total ignores the promo code/);
  const m = done([accRun(0, "pass")], [minor]);
  assert.deepEqual(outcome(m), ["pass", null, null]);
  assert.match(m.reason, /1 minor finding$/);
});

test("done: zero acceptance runs → fail; a review with no valid output → fail", () => {
  assert.match(done([], []).reason, /no acceptance sensor/);
  assert.equal(done([], []).outcome, "fail");
  assert.equal(done([accRun(0, "pass")], null).outcome, "fail");
});

test("done: a verifier that says passed while acceptance is red changes nothing (SC-006, SC-007)", () => {
  // The gate has no verdict parameter. The verifier's output reaches it only as findings,
  // and a "passed" verdict adds none: red acceptance stays a fail.
  const verifierOutput = { verdict: "passed", summary: "all good", findings: [] as Finding[] };
  assert.equal(done.length, 2, "done takes acceptance runs and findings, nothing else");
  assert.equal(done([accRun(1, "fail")], verifierOutput.findings).outcome, "fail");
});

test("isCrash: a pass and a red_first_green pause are not crashes", () => {
  assert.equal(isCrash(redFirst(accRun(1, "fail"), ACC, false)), false);
  assert.equal(isCrash(redFirst(accRun(0, "pass"), ACC, false)), false);
  assert.equal(isCrash(null), false);
});
