/**
 * The queue loop end to end (015 US1): `run()` with the mock agent on a temp
 * repo. The picker reads files only, so Stop / Resume and a `git reset --hard`
 * need no reconcile step.
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { OrchestratorEvent } from "../events.ts";
import { readVerifyRecord } from "../evidence.ts";
import type * as HumanInput from "../humanInput.ts";
import type * as Orchestrator from "../orchestrator.ts";
import type * as State from "../state.ts";
import type { RunConfig } from "../types.ts";
import { logSubjects, rmTmp } from "./helpers/git.ts";
import { mkLoopProject, mockFixture, stubCliTools } from "./helpers/loop.ts";

const realHome = process.env.HOME;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "dex-home-"));
let run: typeof Orchestrator.run;
let stopRun: typeof Orchestrator.stopRun;
let loadState: typeof State.loadState;
let resolveRequest: typeof HumanInput.resolveRequest;
let restorePath: () => void;

// Keep the run log tree (~/.dex/logs) out of the real home. paths.ts reads
// the home folder once, at import, so HOME changes before the first import.
before(async () => {
  process.env.HOME = tmpHome;
  ({ run, stopRun } = await import("../orchestrator.ts"));
  ({ loadState } = await import("../state.ts"));
  ({ resolveRequest } = await import("../humanInput.ts"));
  restorePath = stubCliTools();
});
after(() => {
  restorePath();
  process.env.HOME = realHome;
  rmTmp(tmpHome);
});

const QUEUE = {
  version: 3,
  kind: "new",
  entries: [
    { id: "001-alpha", title: "Alpha" },
    { id: "002-beta", title: "Beta" },
  ],
};

function config(projectDir: string, resume = false): RunConfig {
  return {
    projectDir,
    specDir: "",
    mode: "loop",
    model: "claude-opus-4-6",
    maxIterations: 50,
    maxTurns: 75,
    taskPhases: "all",
    autoClarification: true,
    resume,
  };
}

type StopWhen = (ev: OrchestratorEvent) => boolean;

async function runLoop(
  projectDir: string,
  opts: { resume?: boolean; stopWhen?: StopWhen; onEvent?: (ev: OrchestratorEvent) => void } = {},
) {
  const events: OrchestratorEvent[] = [];
  let stopped = false;
  await run(config(projectDir, opts.resume), (ev) => {
    events.push(ev);
    opts.onEvent?.(ev);
    if (!stopped && opts.stopWhen?.(ev)) {
      stopped = true;
      stopRun();
    }
  });
  return events;
}

/** `<entry>:<stage>[:<task phase>]` for each stage the picker chose, in order. */
function stagesRun(events: OrchestratorEvent[]): string[] {
  const out: string[] = [];
  for (const ev of events) {
    if (ev.type === "stage_decision" && ev.decision === "stage" && ev.stage !== "implement") {
      out.push(`${ev.entryId}:${ev.stage}`);
    }
    if (ev.type === "step_started" && ev.step === "implement") {
      out.push(`${entryOf(events, ev.cycleNumber)}:implement:${ev.taskPhaseNumber}`);
    }
  }
  return out;
}

function entryOf(events: OrchestratorEvent[], cycleNumber: number): string {
  const d = events.find((e) => e.type === "stage_decision" && e.cycleNumber === cycleNumber);
  return d?.type === "stage_decision" ? d.entryId : "?";
}

function termination(events: OrchestratorEvent[]): string | undefined {
  const t = [...events].reverse().find((e) => e.type === "loop_terminated");
  return t?.type === "loop_terminated" ? t.termination.reason : undefined;
}

const ENTRY_STAGES = (id: string) => [
  `${id}:specify`,
  `${id}:clarify`,
  `${id}:plan`,
  `${id}:tasks`,
  `${id}:implement:1`,
  `${id}:implement:2`,
  `${id}:verify`,
];

test("loop: a two-entry queue runs every stage from files and ends queue_complete", async () => {
  const dir = mkLoopProject({ queue: QUEUE, mock: mockFixture("new-project.json") });
  try {
    const events = await runLoop(dir);

    assert.equal(termination(events), "queue_complete");
    assert.deepEqual(stagesRun(events), [
      ...ENTRY_STAGES("001-alpha"),
      ...ENTRY_STAGES("002-beta"),
    ]);
    for (const id of ["001-alpha", "002-beta"]) {
      assert.equal(readVerifyRecord(dir, id)?.verdict, "passed");
      assert.equal(fs.existsSync(path.join(dir, "specs", id, "verify.md")), false);
    }
    // Dex writes no tracked file: the records are ignored, the tree is clean.
    assert.equal(execSync("git status --porcelain", { cwd: dir, encoding: "utf8" }), "");
    // Dex commits nothing: every commit after setup is the agent's.
    const subjects = logSubjects(dir, "main..HEAD");
    assert.ok(subjects.length > 0);
    assert.deepEqual(
      subjects.filter((s) => !s.startsWith("mock(")),
      [],
    );
    assert.equal((await loadState(dir))?.status, "completed");
    assert.equal(
      events.some((e) => e.type.includes("reconcil")),
      false,
    );
  } finally {
    rmTmp(dir);
  }
});

test("loop: Stop during the first implement task phase, Resume runs the same entry and task phase", async () => {
  const dir = mkLoopProject({ queue: QUEUE, mock: mockFixture("new-project.json") });
  try {
    const first = await runLoop(dir, {
      stopWhen: (ev) => ev.type === "task_phase_started",
    });
    assert.equal(termination(first), "user_abort");
    const paused = await loadState(dir);
    assert.equal(paused?.status, "paused");
    assert.equal(paused?.pauseReason, "user_abort");

    const resumed = await runLoop(dir, { resume: true });
    assert.equal(termination(resumed), "queue_complete");
    assert.equal(stagesRun(resumed)[0], "001-alpha:implement:1");
    // Resume keeps the run id and the branch, and skips the real prerequisite checks.
    const runIdOf = (evs: OrchestratorEvent[]) => {
      const s = evs.find((e) => e.type === "run_started");
      return s?.type === "run_started" ? s.runId : undefined;
    };
    assert.ok(runIdOf(first));
    assert.equal(runIdOf(resumed), runIdOf(first));
    assert.equal((await loadState(dir))?.runBranch, paused?.runBranch);
    assert.match(paused?.runBranch ?? "", /^dex\//);
    assert.equal(
      resumed.some((e) => e.type === "prerequisites_check"),
      false,
    );
  } finally {
    rmTmp(dir);
  }
});

const ONE_ENTRY = { version: 3, kind: "new", entries: [{ id: "001-alpha", title: "Alpha" }] };

test("loop: verify fails once → fix phase V1 appended → implement runs it → verify passes → done", async () => {
  const dir = mkLoopProject({ queue: ONE_ENTRY, mock: mockFixture("verify-fails-once.json") });
  try {
    const events = await runLoop(dir);
    assert.equal(termination(events), "queue_complete");
    assert.deepEqual(stagesRun(events), [
      ...ENTRY_STAGES("001-alpha"),
      "001-alpha:implement:3",
      "001-alpha:verify",
    ]);
    const tasks = fs.readFileSync(path.join(dir, "specs/001-alpha/tasks.md"), "utf8");
    assert.match(tasks, /^## Phase 3: Verify fixes V1$/m);
    assert.match(tasks, /^- \[X\] T005 Handle an empty list in src\/001-alpha\/index\.ts$/m);
    assert.equal(readVerifyRecord(dir, "001-alpha")?.verdict, "passed");
  } finally {
    rmTmp(dir);
  }
});

test("loop: an implement that never checks a task pauses limit_reached after 2 runs", async () => {
  const mock = mockFixture("new-project.json") as {
    entries: Record<string, Record<string, Record<string, unknown>>>;
  };
  mock.entries["*"].implement.tick = false;
  const dir = mkLoopProject({ queue: ONE_ENTRY, mock });
  try {
    const events = await runLoop(dir);
    assert.equal(termination(events), "paused");
    assert.deepEqual(stagesRun(events).slice(-2), [
      "001-alpha:implement:1",
      "001-alpha:implement:1",
    ]);
    const state = await loadState(dir);
    assert.equal(state?.pauseReason, "limit_reached");
    assert.match(state?.pauseDetail ?? "", /limits\.maxImplementRunsWithoutProgress: 2/);
    assert.equal(state?.counters["001-alpha"]?.implementRunsWithoutProgress, 2);
  } finally {
    rmTmp(dir);
  }
});

test("loop: a recommended question is answered and listed for review; one without a marker waits for the human", async () => {
  type Stages = Record<string, Record<string, unknown>>;
  const mock = mockFixture("new-project.json") as { entries: Record<string, Stages> };
  mock.entries["*"].clarify.asks = [
    {
      question: "Which store?",
      options: [{ label: "Postgres (Recommended)" }, { label: "SQLite" }],
    },
  ];
  mock.entries["*"].plan.asks = [
    { question: "Which SLA?", options: [{ label: "99.9%" }, { label: "99.99%" }] },
  ];
  const dir = mkLoopProject({ queue: ONE_ENTRY, mock });
  try {
    const humanAnswered: string[] = [];
    const events = await runLoop(dir, {
      // The human answers whatever waits; a defaulted question has no waiter, so this is a no-op for it.
      onEvent: (ev) => {
        if (ev.type !== "user_input_request") return;
        setImmediate(() => {
          if (
            resolveRequest(ev.requestId, { kind: "question", answers: { "Which SLA?": "99.99%" } })
          ) {
            humanAnswered.push(ev.questions[0].question);
          }
        });
      },
    });
    assert.equal(termination(events), "queue_complete");
    assert.deepEqual(humanAnswered, ["Which SLA?"]);
    const by = events.flatMap((e) => (e.type === "request_resolved" ? [e.by] : []));
    assert.deepEqual(by, ["default", "human"]);
    const state = await loadState(dir);
    assert.deepEqual(
      state?.reviewList.map((r) => [r.entryId, r.stage, r.question, r.answer]),
      [["001-alpha", "clarify", "Which store?", "Postgres (Recommended)"]],
    );
    assert.deepEqual(state?.pendingRequests, []);
    const md = fs.readFileSync(path.join(dir, ".dex/questions.md"), "utf8");
    assert.match(md, /"Which store\?" → \*\*Postgres\*\* \(recommended\)/);
  } finally {
    rmTmp(dir);
  }
});

/** The new-project mock with a `brief` stage for every entry (the mock writes the entry's brief file). */
function mockWithBrief(): Record<string, unknown> {
  const mock = mockFixture("new-project.json") as {
    entries: Record<string, Record<string, unknown>>;
  };
  mock.entries["*"].brief = { delay: 0 };
  return mock;
}

/** The pause request a gate leaves in the state, as [reason, options]. */
async function gatePause(dir: string): Promise<[string | undefined, string[]]> {
  const state = await loadState(dir);
  const request = state?.pendingRequests.find((r) => r.kind === "pause");
  return [state?.pauseReason, request?.kind === "pause" ? request.options : []];
}

test("loop: generate and no brief → brief writes it, the run pauses at the gate, Resume runs specify", async () => {
  const queue = {
    version: 3,
    kind: "new",
    entries: [
      {
        id: "001-alpha",
        title: "Alpha",
        brief: "docs/briefs/001-alpha.md",
        generate: {
          sources: ["docs/sources/alpha-notes.md"],
          instructions: "Keep it to one page.",
        },
      },
    ],
  };
  const dir = mkLoopProject({
    queue,
    mock: mockWithBrief(),
    files: { "docs/sources/alpha-notes.md": "# Notes\n\nAlpha lists products.\n" },
  });
  try {
    const first = await runLoop(dir);
    assert.equal(termination(first), "paused");
    assert.deepEqual(stagesRun(first), ["001-alpha:brief"]);
    const brief = fs.readFileSync(path.join(dir, "docs/briefs/001-alpha.md"), "utf8");
    assert.match(brief, /^## Acceptance$/m);
    assert.deepEqual(await gatePause(dir), ["gate", ["Continue", "Stop"]]);
    assert.ok(logSubjects(dir).includes("mock(brief): 001-alpha"));

    const second = await runLoop(dir, { resume: true });
    assert.equal(termination(second), "queue_complete");
    assert.deepEqual(stagesRun(second), ENTRY_STAGES("001-alpha"));
  } finally {
    rmTmp(dir);
  }
});

test("loop: gates [plan] pause after plan; Resume runs tasks", async () => {
  const queue = {
    version: 3,
    kind: "new",
    entries: [{ id: "001-alpha", title: "Alpha", gates: ["plan"] }],
  };
  const dir = mkLoopProject({ queue, mock: mockFixture("new-project.json") });
  try {
    const first = await runLoop(dir);
    assert.equal(termination(first), "paused");
    assert.deepEqual(stagesRun(first), [
      "001-alpha:specify",
      "001-alpha:clarify",
      "001-alpha:plan",
    ]);
    assert.deepEqual(await gatePause(dir), ["gate", ["Continue", "Stop"]]);
    assert.match((await loadState(dir))?.pauseDetail ?? "", /001-alpha · plan/);

    const second = await runLoop(dir, { resume: true });
    assert.equal(stagesRun(second)[0], "001-alpha:tasks");
    assert.equal(termination(second), "queue_complete");
  } finally {
    rmTmp(dir);
  }
});

test("loop: a stage that changes a committed frozen file pauses frozen_changed; a new frozen file does not", async () => {
  const mock = mockFixture("new-project.json") as {
    entries: Record<string, Record<string, { writes?: unknown[] }>>;
  };
  const stages = mock.entries["*"];
  stages.specify.writes?.push({ path: "docs/claim-new.md", content: "a new claim\n" });
  stages.plan.writes?.push({ path: "docs/thresholds.md", content: "p99 < 900ms\n" });
  const dir = mkLoopProject({
    queue: QUEUE,
    mock,
    files: {
      "docs/thresholds.md": "p99 < 300ms\n",
      ".dex/policy.json": JSON.stringify({ frozen: ["docs/thresholds.md", "docs/claim*.md"] }),
    },
  });
  try {
    const events = await runLoop(dir);
    assert.equal(termination(events), "paused");
    assert.deepEqual(stagesRun(events), [
      "001-alpha:specify",
      "001-alpha:clarify",
      "001-alpha:plan",
    ]);
    const state = await loadState(dir);
    assert.equal(state?.pauseReason, "frozen_changed");
    assert.match(state?.pauseDetail ?? "", /docs\/thresholds\.md/);
    assert.doesNotMatch(state?.pauseDetail ?? "", /claim-new/);
    assert.equal(state?.pendingRequests[0]?.kind, "pause");
  } finally {
    rmTmp(dir);
  }
});

test("loop: git reset --hard to the mock(tasks) commit, Resume picks implement with no reconcile", async () => {
  const dir = mkLoopProject({ queue: QUEUE, mock: mockFixture("new-project.json") });
  try {
    await runLoop(dir);
    const sha = execSync('git log --format=%H --grep="^mock(tasks): 001-alpha$"', {
      cwd: dir,
      encoding: "utf8",
    }).trim();
    assert.match(sha, /^[0-9a-f]{40}$/);
    execSync(`git reset -q --hard ${sha}`, { cwd: dir });

    const resumed = await runLoop(dir, { resume: true });
    assert.equal(stagesRun(resumed)[0], "001-alpha:implement:1");
    assert.equal(termination(resumed), "queue_complete");
    assert.equal(
      resumed.some((e) => e.type.includes("reconcil")),
      false,
    );
  } finally {
    rmTmp(dir);
  }
});
