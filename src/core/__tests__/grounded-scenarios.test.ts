/**
 * The grounded loop's unhappy paths under the mock (016 D-016-11, FR-044):
 * `run()` on the existing-project fixture with fake sensors that are real
 * commands, so the real sensor runner, gates and records decide — at zero cost.
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { OrchestratorEvent } from "../events.ts";
import { readDoneRecord, readStageRecords, type StageRecord } from "../evidence.ts";
import type * as HumanInput from "../humanInput.ts";
import type * as Orchestrator from "../orchestrator.ts";
import type * as State from "../state.ts";
import type { RunConfig } from "../types.ts";
import { rmTmp } from "./helpers/git.ts";
import {
  GROUNDED_QUEUE,
  type GroundedOptions,
  mkGroundedProject,
  stubCliTools,
} from "./helpers/loop.ts";

const realHome = process.env.HOME;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "dex-home-"));
let run: typeof Orchestrator.run;
let loadState: typeof State.loadState;
let resolveRequest: typeof HumanInput.resolveRequest;
let restorePath: () => void;

before(async () => {
  process.env.HOME = tmpHome;
  ({ run } = await import("../orchestrator.ts"));
  ({ loadState } = await import("../state.ts"));
  ({ resolveRequest } = await import("../humanInput.ts"));
  restorePath = stubCliTools();
});
after(() => {
  restorePath();
  process.env.HOME = realHome;
  rmTmp(tmpHome);
});

const ENTRY = "900-fixture-a";

function config(projectDir: string, resume = false): RunConfig {
  return {
    projectDir,
    specDir: "",
    mode: "loop",
    model: "claude-opus-4-6",
    maxIterations: 50,
    maxTurns: 75,
    taskPhases: "all",
    autoClarification: false,
    resume,
  };
}

interface Outcome {
  dir: string;
  events: OrchestratorEvent[];
  termination: string | undefined;
  records: StageRecord[];
  state: Awaited<ReturnType<typeof State.loadState>>;
}

type End = { termination: "queue_complete" } | { termination: "paused"; pauseReason: string };

/**
 * FR-044 and contracts/mock-config.md § Scenario fixtures, as one table: every
 * fixture in fixtures/mock/grounded/ and how its run ends. `scenario()` checks
 * the end of every run against it; a variant of a fixture names its own.
 */
const ENDS: Record<string, End> = {
  "ticks-while-red.json": { termination: "queue_complete" },
  "rewords-task.json": { termination: "paused", pauseReason: "plan_changed" },
  "edits-frozen-test.json": { termination: "queue_complete" },
  "tests-already-pass.json": { termination: "paused", pauseReason: "red_first_green" },
  "tests-crash.json": { termination: "paused", pauseReason: "no_progress" },
  "same-fingerprint.json": { termination: "paused", pauseReason: "stalled" },
  "flaky-check.json": { termination: "queue_complete" },
  "verifier-passes-red.json": { termination: "queue_complete" },
  "blocking-finding.json": { termination: "queue_complete" },
  "skip-tests-no-acceptance.json": { termination: "paused", pauseReason: "invalid_input" },
  "happy-path.json": { termination: "queue_complete" },
  "test-amendment.json": { termination: "queue_complete" },
};

test("the scenario table names every fixture in fixtures/mock/grounded/", () => {
  // The tests run from the repo root, like helpers/loop.ts reads the fixtures.
  const dir = path.join(process.cwd(), "fixtures/mock/grounded");
  const fixtures = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "policy.json");
  assert.deepEqual(fixtures.sort(), Object.keys(ENDS).sort());
});

async function scenario(
  fixture: string,
  opts: GroundedOptions & { onEvent?: (ev: OrchestratorEvent) => void; end?: End },
  check: (o: Outcome) => void | Promise<void>,
): Promise<void> {
  const dir = mkGroundedProject(fixture, opts);
  try {
    const events: OrchestratorEvent[] = [];
    await run(config(dir), (ev) => {
      events.push(ev);
      opts.onEvent?.(ev);
    });
    const end = [...events].reverse().find((e) => e.type === "loop_terminated");
    assert.deepEqual(
      events.filter((e) => e.type === "error"),
      [],
    );
    const termination = end?.type === "loop_terminated" ? end.termination.reason : undefined;
    const state = await loadState(dir);
    const expected = opts.end ?? ENDS[fixture];
    assert.ok(expected, `${fixture} has a row in the scenario table`);
    assert.deepEqual(
      expected.termination === "paused" ? { termination, pauseReason: state?.pauseReason } : { termination },
      expected,
      `${fixture} ends as the table says`,
    );
    await check({ dir, events, termination, records: readStageRecords(dir, ENTRY), state });
    assert.equal((await loadState(dir))?.cumulativeCostUsd, 0, "every scenario costs nothing");
  } finally {
    rmTmp(dir);
  }
}

const gates = (events: OrchestratorEvent[]) =>
  events.flatMap((e) =>
    e.type === "gate_decided" ? [`${e.decision.gate}:${e.decision.outcome}`] : [],
  );

const prompts = (events: OrchestratorEvent[]) =>
  events.flatMap((e) =>
    e.type === "agent_step" && e.agentStep.type === "user_message"
      ? [e.agentStep.content ?? ""]
      : [],
  );

const label = (r: StageRecord) => `${r.stage}-${r.n}:${r.mode ?? "-"}:${r.gate?.outcome ?? "-"}`;

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
  await scenario("same-fingerprint.json", { fake: { unit: "1\n" } }, ({ termination, records, state }) => {
    assert.equal(termination, "paused");
    assert.equal(state?.pauseReason, "stalled");
    assert.match(state?.pauseDetail ?? "", /the last three implement runs ended the same way/);
    assert.match(state?.pauseDetail ?? "", /unit: unit: FAIL \(fake exit 1\)/);
    assert.match(state?.pauseDetail ?? "", /implement-1\.json, implement-2\.json, implement-3\.json/);
    const implement = records.filter((r) => r.stage === "implement");
    assert.equal(implement.length, 3);
    assert.ok(implement.every((r) => r.mode === "restore" && r.gate?.outcome === "fail"));
    assert.equal(new Set(implement.map((r) => r.fingerprint)).size, 1);
    assert.equal(records.filter((r) => r.stage === "baseline").length, 1, "the first baseline ran; the rest reused it");
  });
});

test("scenario flaky-check: unit fails, then passes on its re-run — recorded flaky, not blocking", async () => {
  await scenario("flaky-check.json", { fake: { unit: "1\n0\n" } }, ({ termination, records }) => {
    assert.equal(termination, "queue_complete");
    const base = records.find((r) => r.stage === "baseline");
    const unit = base?.runs.find((r) => r.name === "unit");
    assert.equal(unit?.result, "flaky");
    assert.equal(unit?.reruns, 1);
    assert.equal(base?.gate?.outcome, "pass");
    assert.ok(records.filter((r) => r.stage === "implement").every((r) => r.gate?.outcome === "pass"));
  });
});

// ── US3: the tests come first, from an agent that does not implement ──

/** Fixture A's queue entry, changed by `over`. */
function queueWith(over: Record<string, unknown>): Record<string, unknown> {
  const [entry] = GROUNDED_QUEUE.entries;
  return { ...GROUNDED_QUEUE, entries: [{ ...entry, ...over }] };
}

/** Fixture A with the tests stage on, and no queue acceptance. */
const WITH_TESTS = queueWith({
  skip: ["brief", "specify", "clarify", "plan", "tasks"],
  acceptance: undefined,
});

const stagesRun = (events: OrchestratorEvent[]) =>
  events.flatMap((e) =>
    e.type === "stage_decision" && e.decision === "stage" ? [e.stage ?? ""] : [],
  );

test("scenario tests-already-pass: the acceptance tests pass before the feature exists → red_first_green", async () => {
  await scenario("tests-already-pass.json", { queue: WITH_TESTS }, ({ termination, records, state, events }) => {
    assert.equal(termination, "paused");
    assert.equal(state?.pauseReason, "red_first_green");
    assert.match(state?.pauseDetail ?? "", /pass before the feature exists/);
    assert.deepEqual(records.map(label), ["tests-1:create:-", "red-first-1:-:pause"]);
    assert.equal(records[1].runs[0]?.exitCode, 0);
    assert.ok(records[1].acceptanceHash, "the red-first record is keyed by acceptance.json");
    assert.deepEqual(stagesRun(events), ["tests"]);
  });
});

test("scenario tests-crash: a crash at red-first sends the loop back to tests once, then pauses", async () => {
  await scenario("tests-crash.json", { queue: WITH_TESTS }, ({ termination, records, state, events }) => {
    assert.equal(termination, "paused");
    assert.equal(state?.pauseReason, "no_progress");
    assert.match(state?.pauseDetail ?? "", /crashed \(exit 2, expected one of 1\), for the second time in a row/);
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
  });
});

test("scenario skip-tests-no-acceptance: an entry that skips tests with no acceptance pauses before implement", async () => {
  const queue = queueWith({ acceptance: undefined });
  await scenario("skip-tests-no-acceptance.json", { queue }, ({ termination, records, state, events }) => {
    assert.equal(termination, "paused");
    assert.equal(state?.pauseReason, "invalid_input");
    assert.match(state?.pauseDetail ?? "", /skips "tests" and has no "acceptance" command/);
    assert.deepEqual(records, []);
    assert.deepEqual(stagesRun(events), []);
  });
});

test("scenario happy-path: tests → red-first pass → implement, every gate green", async () => {
  await scenario("happy-path.json", { queue: WITH_TESTS }, ({ termination, records, events, dir }) => {
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
    assert.deepEqual(doneRec?.acceptance.map((r) => `${r.name}:${r.result}`), ["acceptance:pass"]);
  });
});

// ── US2: done means Dex's own acceptance run is green and no blocking finding is open ──

test("scenario verifier-passes-red: acceptance red → diagnose mode and a fix phase, whatever the verdict says", async () => {
  await scenario("verifier-passes-red.json", { queue: WITH_TESTS }, ({ termination, records, events, dir }) => {
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
  });
});

test("scenario blocking-finding: green acceptance with a blocking finding is not done; minor only is", async () => {
  await scenario("blocking-finding.json", { queue: WITH_TESTS }, ({ termination, records, dir }) => {
    assert.equal(termination, "queue_complete");
    const verify = records.filter((r) => r.stage === "verify");
    assert.deepEqual(verify.map(label), ["verify-1:review:fail", "verify-2:review:pass"]);
    assert.match(verify[0].gate?.reason ?? "", /blocking finding is open: An empty name greets/);
    assert.match(verify[1].gate?.reason ?? "", /1 minor finding/);
    const doneRec = readDoneRecord(dir, ENTRY);
    assert.equal(doneRec?.gate, "passed", "a 'failed' verdict with only a minor finding is still done");
    assert.deepEqual(
      doneRec?.findings.map((f) => `${f.severity}: ${f.summary}`),
      ['minor: The error text says "empty" where the spec says "blank"'],
    );
  });
});

test("scenario happy-path, then a commit on the entry's branch: verify runs again with a new acceptance run (SC-005)", async () => {
  const dir = mkGroundedProject("happy-path.json", { queue: WITH_TESTS });
  try {
    await run(config(dir), () => {});
    assert.equal(readDoneRecord(dir, ENTRY)?.gate, "passed");
    execSync("git commit -q --allow-empty -m 'a late change'", { cwd: dir });
    const events: OrchestratorEvent[] = [];
    await run(config(dir), (ev) => events.push(ev));
    const decision = events.find((e) => e.type === "stage_decision" && e.decision === "stage");
    assert.equal(decision?.type === "stage_decision" && decision.stage, "verify");
    assert.match(decision?.type === "stage_decision" ? decision.reason : "", /commits since the last verify/);
    const verify = readStageRecords(dir, ENTRY, "verify");
    assert.equal(verify.length, 2);
    assert.notEqual(verify[1].runs[0]?.durationMs, undefined, "verify-2.json has its own acceptance run");
    assert.notEqual(verify[1].key, verify[0].key);
    assert.equal(readDoneRecord(dir, ENTRY)?.key, verify[1].key);
  } finally {
    rmTmp(dir);
  }
});

// ── US4: the implementer cannot weaken the tests or rewrite the plan ──

const FROZEN_TEST = "specs/900-fixture-a/acceptance.test.mjs";
const OLD_TEST = "src/fixture-a/greet.test.ts";

/** The first implement run of happy-path.json, for a variant scenario. */
function firstRun(mock: Record<string, unknown>): Record<string, unknown[]> {
  const entries = mock.entries as Record<string, Record<string, { runs: Record<string, unknown[]>[] }>>;
  return entries["*"].implement.runs[0];
}

test("scenario rewords-task: a reworded task pauses plan_changed, naming the task", async () => {
  await scenario("rewords-task.json", { queue: WITH_TESTS }, ({ termination, state, records }) => {
    assert.equal(termination, "paused");
    assert.equal(state?.pauseReason, "plan_changed");
    assert.match(state?.pauseDetail ?? "", /T004 was reworded: "Implement `greet\(name\)`/);
    const impl = records.filter((r) => r.stage === "implement");
    assert.deepEqual(impl.map(label), ["implement-1:phase:pause"]);
    assert.deepEqual(impl[0].planDiff?.newlyTicked, ["T002"]);
    assert.equal(impl[0].planDiff?.violations.length, 1);
  });
});

test("scenario edits-frozen-test: the write is denied with rule scope, and the test stays as written", async () => {
  await scenario("edits-frozen-test.json", { queue: WITH_TESTS }, ({ termination, events, dir, records }) => {
    const denied = events.flatMap((e) => (e.type === "policy_denied" ? [e] : []));
    assert.ok(denied.length >= 1);
    for (const d of denied) {
      assert.equal(d.rule, "scope");
      assert.match(d.subject, /acceptance\.test\.mjs$/);
      assert.match(d.reason, /is a frozen acceptance test of 900-fixture-a; ask for a test amendment instead/);
    }
    assert.match(fs.readFileSync(path.join(dir, FROZEN_TEST), "utf-8"), /^\/\/ fixture A: the greeter's acceptance test/);
    assert.ok(records.filter((r) => r.stage === "implement").every((r) => r.testChanges?.frozenChanged.length === 0));
    assert.equal(termination, "queue_complete");
  });
});

test("scenario a deleted test file: the progress gate pauses tests_changed, naming the file", async () => {
  const opts = {
    queue: WITH_TESTS,
    files: { [OLD_TEST]: "it('greets by name', () => {});\n" },
    mock: (m: Record<string, unknown>) => {
      firstRun(m).deletes = [OLD_TEST];
    },
    end: { termination: "paused", pauseReason: "tests_changed" } as const,
  };
  await scenario("happy-path.json", opts, ({ termination, state, records, dir }) => {
    assert.equal(termination, "paused");
    assert.equal(state?.pauseReason, "tests_changed");
    assert.match(state?.pauseDetail ?? "", /deleted or renamed test files: src\/fixture-a\/greet\.test\.ts/);
    assert.deepEqual(records.find((r) => r.stage === "implement")?.testChanges?.testsDeletedOrRenamed, [OLD_TEST]);
    assert.equal(fs.existsSync(path.join(dir, OLD_TEST)), false, "a test file outside the frozen set may go — and pauses");
  });
});

test("scenario a new skip marker: recorded in testChanges.skipMarkers, and the run goes on", async () => {
  const opts = {
    queue: WITH_TESTS,
    files: { [OLD_TEST]: "it('greets by name', () => {});\n" },
    mock: (m: Record<string, unknown>) => {
      firstRun(m).writes.push({
        path: OLD_TEST,
        content: "it('greets by name', () => {});\nit.skip('rejects an empty name', () => {});\n",
      });
    },
  };
  await scenario("happy-path.json", opts, ({ termination, records }) => {
    assert.equal(termination, "queue_complete");
    const first = records.find((r) => r.stage === "implement");
    assert.equal(first?.gate?.outcome, "pass");
    assert.equal(first?.testChanges?.skipMarkers.length, 1);
    assert.match(first?.testChanges?.skipMarkers[0] ?? "", /greet\.test\.ts: .*it\.skip\('rejects an empty name'/);
  });
});

/** test-amendment.json with the human's answer; the question waits even in recommended-then-review. */
async function amendment(answer: string, check: (o: Outcome & { asked: string[][] }) => void): Promise<void> {
  const asked: string[][] = [];
  const onEvent = (ev: OrchestratorEvent) => {
    if (ev.type !== "user_input_request" || ev.questions[0]?.header !== "Test amendment") return;
    const q = ev.questions[0];
    setImmediate(() => {
      // True only for a request that waits: a defaulted one has no waiter.
      if (resolveRequest(ev.requestId, { kind: "question", answers: { [q.question]: answer } }))
        asked.push(q.options.map((o) => o.label));
    });
  };
  const opts = { queue: WITH_TESTS, policy: { questions: "recommended-then-review" }, onEvent };
  await scenario("test-amendment.json", opts, (o) => check({ ...o, asked }));
}

const mockAnswers = (events: OrchestratorEvent[]) =>
  events.flatMap((e) =>
    e.type === "agent_step" && e.agentStep.content?.startsWith("answers: ") ? [e.agentStep.content] : [],
  );

const amendmentsOf = (dir: string) =>
  JSON.parse(fs.readFileSync(path.join(dir, ".dex/evidence", ENTRY, "amendments.json"), "utf-8")).items as Array<{
    file: string;
    status: string;
  }>;

test("scenario test-amendment, approved: waits, then tests runs in amend mode with no red-first, and the entry finishes", async () => {
  await amendment("Approve amendment", ({ termination, events, records, dir, state, asked }) => {
    assert.deepEqual(asked, [["Approve amendment", "Reject"]], "it waited for the human, with Dex's options");
    assert.equal(state?.reviewList.length, 0, "never answered by default");
    assert.match(mockAnswers(events)[0] ?? "", /Approved: the test author will change specs\/900-fixture-a\/acceptance\.test\.mjs\. Go on/);
    assert.deepEqual(
      records.filter((r) => r.stage === "tests" || r.stage === "red-first").map(label),
      ["tests-1:create:-", "red-first-1:-:pass", "tests-2:amend:-"],
    );
    assert.match(prompts(events).find((p) => p.includes("asked to change one of the acceptance tests")) ?? "", /Reason: SC-001 says/);
    assert.deepEqual(
      amendmentsOf(dir).map((a) => `${a.file}:${a.status}`),
      [`${FROZEN_TEST}:applied`],
    );
    assert.equal(termination, "queue_complete");
  });
});

test("scenario test-amendment, rejected: the implementer reads the rejection, and no tests stage follows", async () => {
  await amendment("Reject", ({ termination, events, records, dir, asked }) => {
    assert.equal(asked.length, 1);
    assert.match(mockAnswers(events)[0] ?? "", /Rejected: specs\/900-fixture-a\/acceptance\.test\.mjs stays as it is/);
    assert.deepEqual(amendmentsOf(dir).map((a) => a.status), ["rejected"]);
    assert.equal(records.filter((r) => r.stage === "tests").length, 1);
    assert.equal(termination, "queue_complete");
  });
});

// ── US5: the digest for the owner, the attempt log for the next agent ──

const digestEvents = (events: OrchestratorEvent[]) =>
  events.flatMap((e) => (e.type === "digest_written" ? [e.path] : []));

test("scenario happy-path: the second implement prompt has the first attempt; done archives the log and writes the digest", async () => {
  await scenario("happy-path.json", { queue: WITH_TESTS }, ({ events, dir }) => {
    const implementPrompts = prompts(events).filter((p) => p.startsWith("/speckit-implement"));
    assert.equal(implementPrompts.length, 2);
    assert.match(implementPrompts[0], /## Earlier attempts[\s\S]*### \S+ · tests \(create\)\n\n\*\*Agent\*\*: one acceptance test for SC-001/);
    assert.doesNotMatch(implementPrompts[0], /· implement/);
    assert.match(implementPrompts[1], /## Earlier attempts[\s\S]*### \S+ · tests \(create\)[\s\S]*### \S+ · implement · phase 1\n\n\*\*Agent\*\*: \(no summary\)\n\*\*Gate\*\*: progress pass/);
    const evidence = path.join(dir, ".dex/evidence", ENTRY);
    assert.equal(fs.existsSync(path.join(evidence, "progress.md")), false, "archived when the done gate passed");
    const archived = fs.readdirSync(path.join(evidence, "archive"));
    assert.equal(archived.length, 1);
    assert.match(fs.readFileSync(path.join(evidence, "archive", archived[0]), "utf-8"), /· verify \(review\)/);
    const written = digestEvents(events);
    assert.deepEqual(written, [path.join(dir, ".dex/digests", `${ENTRY}.md`)]);
    const md = fs.readFileSync(written[0], "utf-8");
    assert.match(md, /^# 900-fixture-a — done\n/);
    assert.match(md, /\*\*Tasks done\*\*: T002, T004–T005 \(3 of 3 in scope\)/);
    assert.match(md, /\*\*Acceptance\*\* \(at verify\): acceptance ✓ \(exit 0\)/);
  });
});

test("scenario rewords-task: the gate pause writes the digest before the paused event, every section in it", async () => {
  await scenario("rewords-task.json", { queue: WITH_TESTS }, ({ events }) => {
    const written = digestEvents(events);
    assert.equal(written.length, 1);
    const types = events.map((e) => e.type);
    assert.ok(types.indexOf("digest_written") < types.indexOf("paused"));
    const md = fs.readFileSync(written[0], "utf-8");
    assert.match(md, /^# 900-fixture-a — paused at implement: plan_changed\n\n\*\*Why\*\*: 900-fixture-a: tasks\.md changed: T004 was reworded/);
    for (const section of ["**Diff**", "**Tasks done**", "**Checks**", "**Acceptance**", "**Verifier**", "**Skip markers**", "**Answered by default**", "**Cost**"]) {
      assert.ok(md.includes(section), `the digest has ${section}`);
    }
  });
});
