/**
 * The grounded loop's unhappy paths under the mock (016 D-016-11, FR-044),
 * part 1: the scenario table itself, progress (US1), the tests stage (US3) and
 * the done gate (US2). The harness and the table are in helpers/grounded.ts;
 * protection, amendments and the digest are in grounded-protection.test.ts.
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { OrchestratorEvent } from "../events.ts";
import { readDoneRecord, readStageRecords } from "../evidence.ts";
import { rmTmp } from "./helpers/git.ts";
import {
  ENDS,
  ENTRY,
  gates,
  groundedHarness,
  label,
  prompts,
  queueWith,
  stagesRun,
  WITH_TESTS,
} from "./helpers/grounded.ts";
import { mkGroundedProject } from "./helpers/loop.ts";

const { scenario, runLoop } = groundedHarness();

test("the scenario table names every fixture in fixtures/mock/grounded/", () => {
  // The tests run from the repo root, like helpers/loop.ts reads the fixtures.
  const dir = path.join(process.cwd(), "fixtures/mock/grounded");
  const fixtures = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "policy.json");
  assert.deepEqual(fixtures.sort(), Object.keys(ENDS).sort());
});

// ── US1: progress counts only when Dex's own checks agree ──

test("scenario ticks-while-red: the tick does not count; the next run restores green, then the entry finishes", async () => {
  await scenario("ticks-while-red.json", {}, ({ termination, records, events, state }) => {
    assert.equal(termination, "queue_complete");
    assert.deepEqual(records.map(label), [
      "baseline-1:implement:pass",
      "implement-1:phase:fail",
      "implement-2:restore:pass",
      "implement-3:phase:pass",
      "verify-1:review:pass",
    ]);
    const first = records[1];
    assert.equal(first.gate?.next, "restore");
    assert.match(first.gate?.reason ?? "", /T002 is ticked, but the fast check "unit" is red/);
    const unit = first.runs.find((r) => r.name === "unit");
    assert.equal(unit?.result, "fail");
    assert.equal(unit?.exitCode, 1);
    assert.equal(unit?.reruns, 1);
    assert.deepEqual(unit?.tail, ["unit: FAIL (fake exit 1)"]);
    // The restore run's prompt carries the red check's name, command and tail.
    const restore = prompts(events).find((p) => p.includes("Restore green first"));
    assert.ok(restore, "a restore prompt was sent");
    assert.match(restore, /### unit — fail \(exit 1\)/);
    assert.match(restore, /node \.dex\/fake\/check\.mjs unit/);
    assert.match(restore, /unit: FAIL \(fake exit 1\)/);
    assert.match(restore, /Tick no task/);
    // Every later baseline reused the progress run before it: no second run on the same tree.
    assert.equal(records.filter((r) => r.stage === "baseline").length, 1);
    assert.deepEqual(gates(events), [
      "baseline:pass",
      "progress:fail",
      "progress:pass",
      "progress:pass",
      "done:pass",
    ]);
    assert.equal(state?.counters[ENTRY]?.implementRunsWithoutProgress, 0);
  });
});

test("scenario same-fingerprint: three restore runs that change nothing pause stalled with the evidence", async () => {
  await scenario(
    "same-fingerprint.json",
    { fake: { unit: "1\n" } },
    ({ termination, records, state }) => {
      assert.equal(termination, "paused");
      assert.equal(state?.pauseReason, "stalled");
      assert.match(state?.pauseDetail ?? "", /the last three implement runs ended the same way/);
      assert.match(state?.pauseDetail ?? "", /unit: unit: FAIL \(fake exit 1\)/);
      assert.match(
        state?.pauseDetail ?? "",
        /implement-1\.json, implement-2\.json, implement-3\.json/,
      );
      const implement = records.filter((r) => r.stage === "implement");
      assert.equal(implement.length, 3);
      assert.ok(implement.every((r) => r.mode === "restore" && r.gate?.outcome === "fail"));
      assert.equal(new Set(implement.map((r) => r.fingerprint)).size, 1);
      assert.equal(
        records.filter((r) => r.stage === "baseline").length,
        1,
        "the first baseline ran; the rest reused it",
      );
    },
  );
});

test("scenario flaky-check: unit fails, then passes on its re-run — recorded flaky, not blocking", async () => {
  await scenario("flaky-check.json", { fake: { unit: "1\n0\n" } }, ({ termination, records }) => {
    assert.equal(termination, "queue_complete");
    const base = records.find((r) => r.stage === "baseline");
    const unit = base?.runs.find((r) => r.name === "unit");
    assert.equal(unit?.result, "flaky");
    assert.equal(unit?.reruns, 1);
    assert.equal(base?.gate?.outcome, "pass");
    assert.ok(
      records.filter((r) => r.stage === "implement").every((r) => r.gate?.outcome === "pass"),
    );
  });
});

// ── US3: the tests come first, from an agent that does not implement ──

test("scenario tests-already-pass: the acceptance tests pass before the feature exists → red_first_green", async () => {
  await scenario(
    "tests-already-pass.json",
    { queue: WITH_TESTS },
    ({ termination, records, state, events }) => {
      assert.equal(termination, "paused");
      assert.equal(state?.pauseReason, "red_first_green");
      assert.match(state?.pauseDetail ?? "", /pass before the feature exists/);
      assert.deepEqual(records.map(label), ["tests-1:create:-", "red-first-1:-:pause"]);
      assert.equal(records[1].runs[0]?.exitCode, 0);
      assert.ok(records[1].acceptanceHash, "the red-first record is keyed by acceptance.json");
      assert.deepEqual(stagesRun(events), ["tests"]);
    },
  );
});

test("scenario tests-crash: a crash at red-first sends the loop back to tests once, then pauses", async () => {
  await scenario(
    "tests-crash.json",
    { queue: WITH_TESTS },
    ({ termination, records, state, events }) => {
      assert.equal(termination, "paused");
      assert.equal(state?.pauseReason, "no_progress");
      assert.match(
        state?.pauseDetail ?? "",
        /crashed \(exit 2, expected one of 1\), for the second time in a row/,
      );
      assert.deepEqual(records.map(label), [
        "tests-1:create:-",
        "red-first-1:-:fail",
        "tests-2:create:-",
        "red-first-2:-:pause",
      ]);
      assert.equal(records[1].gate?.next, "retry-tests");
      // The retry's prompt carries the crash and its evidence.
      const retry = prompts(events).filter((p) => p.includes("You are the test author"))[1];
      assert.match(retry ?? "", /## Your last attempt crashed/);
      assert.match(retry ?? "", /acceptance: FAIL \(fake exit 2\)/);
      assert.deepEqual(stagesRun(events), ["tests", "tests"]);
    },
  );
});

test("scenario skip-tests-no-acceptance: an entry that skips tests with no acceptance pauses before implement", async () => {
  const queue = queueWith({ acceptance: undefined });
  await scenario(
    "skip-tests-no-acceptance.json",
    { queue },
    ({ termination, records, state, events }) => {
      assert.equal(termination, "paused");
      assert.equal(state?.pauseReason, "invalid_input");
      assert.match(state?.pauseDetail ?? "", /skips "tests" and has no "acceptance" command/);
      assert.deepEqual(records, []);
      assert.deepEqual(stagesRun(events), []);
    },
  );
});

test("scenario happy-path: tests → red-first pass → implement, every gate green", async () => {
  await scenario(
    "happy-path.json",
    { queue: WITH_TESTS },
    ({ termination, records, events, dir }) => {
      assert.equal(termination, "queue_complete");
      assert.deepEqual(records.slice(0, 2).map(label), ["tests-1:create:-", "red-first-1:-:pass"]);
      assert.equal(records[0].summary, "one acceptance test for SC-001");
      assert.equal(records[1].runs[0]?.exitCode, 1);
      assert.ok(
        records.filter((r) => r.stage === "implement").every((r) => r.gate?.outcome === "pass"),
      );
      assert.deepEqual(stagesRun(events).slice(0, 3), ["tests", "implement", "implement"]);
      assert.ok(fs.existsSync(path.join(dir, "specs/900-fixture-a/acceptance.json")));
      // The tests prompt names the test patterns and asks for acceptance.json.
      const p = prompts(events).find((x) => x.includes("You are the test author")) ?? "";
      assert.match(p, /acceptance\.json/);
      assert.match(p, /\*\*\/\*\.test\.\*/);
      const doneRec = readDoneRecord(dir, ENTRY);
      assert.equal(doneRec?.gate, "passed");
      assert.equal(doneRec?.mode, "review");
      assert.deepEqual(
        doneRec?.acceptance.map((r) => `${r.name}:${r.result}`),
        ["acceptance:pass"],
      );
    },
  );
});

// ── US2: done means Dex's own acceptance run is green and no blocking finding is open ──

test("scenario verifier-passes-red: acceptance red → diagnose mode and a fix phase, whatever the verdict says", async () => {
  await scenario(
    "verifier-passes-red.json",
    { queue: WITH_TESTS },
    ({ termination, records, events, dir }) => {
      assert.equal(termination, "queue_complete");
      const verify = records.filter((r) => r.stage === "verify");
      assert.deepEqual(verify.map(label), ["verify-1:diagnose:fail", "verify-2:review:pass"]);
      assert.equal(verify[0].gate?.next, "fix-phase");
      assert.match(verify[0].gate?.reason ?? "", /acceptance run is red: "acceptance"/);
      // The diagnose prompt carried Dex's own red tail; the verifier's "passed" changed nothing.
      const diagnose = prompts(events).find((p) => p.includes("— diagnose mode.")) ?? "";
      assert.match(diagnose, /acceptance: FAIL \(fake exit 1\)/);
      const tasks = fs.readFileSync(path.join(dir, "specs/900-fixture-a/tasks.md"), "utf8");
      assert.match(tasks, /^## Phase 4: Verify fixes V1$/m);
      assert.match(tasks, /^- \[X\] T008 Make greet\(\) return/m);
      assert.deepEqual(stagesRun(events).slice(-3), ["verify", "implement", "verify"]);
      assert.equal(readDoneRecord(dir, ENTRY)?.gate, "passed");
    },
  );
});

test("scenario blocking-finding: green acceptance with a blocking finding is not done; minor only is", async () => {
  await scenario(
    "blocking-finding.json",
    { queue: WITH_TESTS },
    ({ termination, records, dir }) => {
      assert.equal(termination, "queue_complete");
      const verify = records.filter((r) => r.stage === "verify");
      assert.deepEqual(verify.map(label), ["verify-1:review:fail", "verify-2:review:pass"]);
      assert.match(verify[0].gate?.reason ?? "", /blocking finding is open: An empty name greets/);
      assert.match(verify[1].gate?.reason ?? "", /1 minor finding/);
      const doneRec = readDoneRecord(dir, ENTRY);
      assert.equal(
        doneRec?.gate,
        "passed",
        "a 'failed' verdict with only a minor finding is still done",
      );
      assert.deepEqual(
        doneRec?.findings.map((f) => `${f.severity}: ${f.summary}`),
        ['minor: The error text says "empty" where the spec says "blank"'],
      );
    },
  );
});

test("scenario happy-path, then a commit on the entry's branch: verify runs again with a new acceptance run (SC-005)", async () => {
  const dir = mkGroundedProject("happy-path.json", { queue: WITH_TESTS });
  try {
    await runLoop(dir, () => {});
    assert.equal(readDoneRecord(dir, ENTRY)?.gate, "passed");
    execSync("git commit -q --allow-empty -m 'a late change'", { cwd: dir });
    const events: OrchestratorEvent[] = [];
    await runLoop(dir, (ev) => events.push(ev));
    const decision = events.find((e) => e.type === "stage_decision" && e.decision === "stage");
    assert.equal(decision?.type === "stage_decision" && decision.stage, "verify");
    assert.match(
      decision?.type === "stage_decision" ? decision.reason : "",
      /commits since the last verify/,
    );
    const verify = readStageRecords(dir, ENTRY, "verify");
    assert.equal(verify.length, 2);
    assert.notEqual(
      verify[1].runs[0]?.durationMs,
      undefined,
      "verify-2.json has its own acceptance run",
    );
    assert.notEqual(verify[1].key, verify[0].key);
    assert.equal(readDoneRecord(dir, ENTRY)?.key, verify[1].key);
  } finally {
    rmTmp(dir);
  }
});
