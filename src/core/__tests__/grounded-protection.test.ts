/**
 * The grounded loop's unhappy paths under the mock (016 D-016-11, FR-044),
 * part 2: the implementer cannot weaken the tests or rewrite the plan (US4),
 * and the attempt log and the digest (US5). The harness and the table of ends
 * are in helpers/grounded.ts.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { OrchestratorEvent } from "../events.ts";
import {
  ENTRY,
  groundedHarness,
  label,
  type Outcome,
  prompts,
  WITH_TESTS,
} from "./helpers/grounded.ts";

const { scenario, resolveRequest } = groundedHarness();

// ── US4: the implementer cannot weaken the tests or rewrite the plan ──

const FROZEN_TEST = "specs/900-fixture-a/acceptance.test.mjs";
const OLD_TEST = "src/fixture-a/greet.test.ts";

/** The first implement run of happy-path.json, for a variant scenario. */
function firstRun(mock: Record<string, unknown>): Record<string, unknown[]> {
  const entries = mock.entries as Record<
    string,
    Record<string, { runs: Record<string, unknown[]>[] }>
  >;
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
  await scenario(
    "edits-frozen-test.json",
    { queue: WITH_TESTS },
    ({ termination, events, dir, records }) => {
      const denied = events.flatMap((e) => (e.type === "policy_denied" ? [e] : []));
      assert.ok(denied.length >= 1);
      for (const d of denied) {
        assert.equal(d.rule, "scope");
        assert.match(d.subject, /acceptance\.test\.mjs$/);
        assert.match(
          d.reason,
          /is a frozen acceptance test of 900-fixture-a; ask for a test amendment instead/,
        );
      }
      assert.match(
        fs.readFileSync(path.join(dir, FROZEN_TEST), "utf-8"),
        /^\/\/ fixture A: the greeter's acceptance test/,
      );
      assert.ok(
        records
          .filter((r) => r.stage === "implement")
          .every((r) => r.testChanges?.frozenChanged.length === 0),
      );
      assert.equal(termination, "queue_complete");
    },
  );
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
    assert.match(
      state?.pauseDetail ?? "",
      /deleted or renamed test files: src\/fixture-a\/greet\.test\.ts/,
    );
    assert.deepEqual(
      records.find((r) => r.stage === "implement")?.testChanges?.testsDeletedOrRenamed,
      [OLD_TEST],
    );
    assert.equal(
      fs.existsSync(path.join(dir, OLD_TEST)),
      false,
      "a test file outside the frozen set may go — and pauses",
    );
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
    assert.match(
      first?.testChanges?.skipMarkers[0] ?? "",
      /greet\.test\.ts: .*it\.skip\('rejects an empty name'/,
    );
  });
});

/** test-amendment.json with the human's answer; the question waits even in recommended-then-review. */
async function amendment(
  answer: string,
  check: (o: Outcome & { asked: string[][] }) => void,
): Promise<void> {
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
    e.type === "agent_step" && e.agentStep.content?.startsWith("answers: ")
      ? [e.agentStep.content]
      : [],
  );

const amendmentsOf = (dir: string) =>
  JSON.parse(fs.readFileSync(path.join(dir, ".dex/evidence", ENTRY, "amendments.json"), "utf-8"))
    .items as Array<{
    file: string;
    status: string;
  }>;

test("scenario test-amendment, approved: waits, then tests runs in amend mode with no red-first, and the entry finishes", async () => {
  await amendment("Approve amendment", ({ termination, events, records, dir, state, asked }) => {
    assert.deepEqual(
      asked,
      [["Approve amendment", "Reject"]],
      "it waited for the human, with Dex's options",
    );
    assert.equal(state?.reviewList.length, 0, "never answered by default");
    assert.match(
      mockAnswers(events)[0] ?? "",
      /Approved: the test author will change specs\/900-fixture-a\/acceptance\.test\.mjs\. Go on/,
    );
    assert.deepEqual(
      records.filter((r) => r.stage === "tests" || r.stage === "red-first").map(label),
      ["tests-1:create:-", "red-first-1:-:pass", "tests-2:amend:-"],
    );
    assert.match(
      prompts(events).find((p) => p.includes("asked to change one of the acceptance tests")) ?? "",
      /Reason: SC-001 says/,
    );
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
    assert.match(
      mockAnswers(events)[0] ?? "",
      /Rejected: specs\/900-fixture-a\/acceptance\.test\.mjs stays as it is/,
    );
    assert.deepEqual(
      amendmentsOf(dir).map((a) => a.status),
      ["rejected"],
    );
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
    assert.match(
      implementPrompts[0],
      /## Earlier attempts[\s\S]*### \S+ · tests \(create\)\n\n\*\*Agent\*\*: one acceptance test for SC-001/,
    );
    assert.doesNotMatch(implementPrompts[0], /· implement/);
    assert.match(
      implementPrompts[1],
      /## Earlier attempts[\s\S]*### \S+ · tests \(create\)[\s\S]*### \S+ · implement · phase 1\n\n\*\*Agent\*\*: \(no summary\)\n\*\*Gate\*\*: progress pass/,
    );
    const evidence = path.join(dir, ".dex/evidence", ENTRY);
    assert.equal(
      fs.existsSync(path.join(evidence, "progress.md")),
      false,
      "archived when the done gate passed",
    );
    const archived = fs.readdirSync(path.join(evidence, "archive"));
    assert.equal(archived.length, 1);
    assert.match(
      fs.readFileSync(path.join(evidence, "archive", archived[0]), "utf-8"),
      /· verify \(review\)/,
    );
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
    assert.match(
      md,
      /^# 900-fixture-a — paused at implement: plan_changed\n\n\*\*Why\*\*: 900-fixture-a: tasks\.md changed: T004 was reworded/,
    );
    for (const section of [
      "**Diff**",
      "**Tasks done**",
      "**Checks**",
      "**Acceptance**",
      "**Verifier**",
      "**Skip markers**",
      "**Answered by default**",
      "**Cost**",
    ]) {
      assert.ok(md.includes(section), `the digest has ${section}`);
    }
  });
});
