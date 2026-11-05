/**
 * An existing project end to end (015 US3, SC-004): `run()` with the mock agent
 * on a temp repo that already uses spec-kit, with a hand-written queue. Dex
 * creates no branch, makes no commit and pushes nothing: the only new branch is
 * the one spec-kit's `specify` makes for entry B, and every new commit is an
 * agent's. The repo has no remote, so a push would fail with an `error` event.
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { OrchestratorEvent } from "../events.ts";
import type * as Orchestrator from "../orchestrator.ts";
import type { RunConfig } from "../types.ts";
import { branches, currentBranch, headSha, logSubjects, rmTmp } from "./helpers/git.ts";
import {
  FIXTURE_FEATURE_JSON,
  mkExistingProject,
  stubCliTools,
  writeFile as write,
} from "./helpers/loop.ts";

const realHome = process.env.HOME;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "dex-home-"));
let run: typeof Orchestrator.run;
let restorePath: () => void;

before(async () => {
  process.env.HOME = tmpHome;
  ({ run } = await import("../orchestrator.ts"));
  restorePath = stubCliTools();
});
after(() => {
  restorePath();
  process.env.HOME = realHome;
  rmTmp(tmpHome);
});

function config(projectDir: string): RunConfig {
  return {
    projectDir,
    specDir: "",
    mode: "loop",
    model: "claude-opus-4-6",
    maxIterations: 50,
    maxTurns: 75,
    taskPhases: "all",
    autoClarification: false,
  };
}

function stagesRun(events: OrchestratorEvent[]): string[] {
  return events.flatMap((ev) =>
    ev.type === "stage_decision" && ev.decision === "stage" ? [`${ev.entryId}:${ev.stage}`] : [],
  );
}

test("existing project: both entries run to done; Dex makes no branch, no commit and no push", async () => {
  const dir = mkExistingProject();
  try {
    const before = headSha(dir);
    const branchesBefore = branches(dir);
    const events: OrchestratorEvent[] = [];
    await run(config(dir), (ev) => events.push(ev));

    const errors = events.filter((e) => e.type === "error");
    assert.deepEqual(errors, []);
    const end = events.find((e) => e.type === "loop_terminated");
    assert.equal(end?.type === "loop_terminated" && end.termination.reason, "queue_complete");
    assert.deepEqual(stagesRun(events), [
      "900-fixture-a:implement",
      "900-fixture-a:implement",
      "900-fixture-a:verify",
      "901-fixture-b:specify",
      "901-fixture-b:clarify",
      "901-fixture-b:plan",
      "901-fixture-b:tasks",
      "901-fixture-b:implement",
      "901-fixture-b:verify",
    ]);
    assert.equal(events.filter((e) => e.type === "tree_dirty").length, 0);

    // Branches: only spec-kit's, for entry B; the run ends on it.
    assert.deepEqual(
      branches(dir).filter((b) => !branchesBefore.includes(b)),
      ["901-fixture-b"],
    );
    assert.equal(currentBranch(dir), "901-fixture-b");

    // Commits: every new one is an agent's. A passing verify changes no file, so it commits nothing.
    const subjects = logSubjects(dir, `--all ^${before}`);
    assert.equal(subjects.length, 7, `expected 7 agent commits, got ${subjects.length}`);
    assert.deepEqual(
      subjects.filter((s) => !s.startsWith("mock(")),
      [],
    );
    assert.equal(logSubjects(dir, "--all").filter((s) => s.includes("[checkpoint:")).length, 0);

    // Files Dex never writes: spec-kit's feature.json, and A's out-of-scope task.
    assert.equal(
      fs.readFileSync(path.join(dir, ".specify/feature.json"), "utf-8"),
      FIXTURE_FEATURE_JSON,
    );
    const tasksA = execSync("git show 900-fixture-a:specs/900-fixture-a/tasks.md", {
      cwd: dir,
      encoding: "utf-8",
    });
    assert.match(tasksA, /- \[X\] T002 /);
    assert.match(tasksA, /- \[X\] T005 /);
    assert.match(tasksA, /- \[ \] T006 /);
    assert.equal(execSync("git status --porcelain", { cwd: dir, encoding: "utf-8" }), "");
  } finally {
    rmTmp(dir);
  }
});

test("existing project, build mode: a queued spec folder keeps its task scope, and Dex makes no branch", async () => {
  const dir = mkExistingProject();
  try {
    const branchesBefore = branches(dir);
    const events: OrchestratorEvent[] = [];
    await run({ ...config(dir), mode: "build", specDir: "specs/900-fixture-a" }, (ev) =>
      events.push(ev),
    );
    assert.deepEqual(
      events.filter((e) => e.type === "error"),
      [],
    );
    const phases = events.flatMap((e) =>
      e.type === "task_phase_started" ? [e.taskPhase.number] : [],
    );
    assert.deepEqual(phases, [1, 2]);
    assert.deepEqual(branches(dir), branchesBefore);
    assert.equal(currentBranch(dir), "900-fixture-a");
    const tasks = fs.readFileSync(path.join(dir, "specs/900-fixture-a/tasks.md"), "utf-8");
    assert.match(tasks, /- \[X\] T004 /);
    assert.match(tasks, /- \[ \] T006 /);
  } finally {
    rmTmp(dir);
  }
});

test("existing project: prerequisites only check — no spec-kit pauses with the list and nothing is set up", async () => {
  const dir = mkExistingProject();
  try {
    execSync("git rm -rq .specify && git commit -q -m 'drop spec-kit'", { cwd: dir });
    const before = headSha(dir);
    const events: OrchestratorEvent[] = [];
    await run(config(dir), (ev) => events.push(ev));
    const paused = events.find((e) => e.type === "paused");
    assert.equal(paused?.type === "paused" && paused.reason, "preflight_failed");
    assert.match((paused?.type === "paused" && paused.detail) || "", /\.specify\/ is missing/);
    const checks = events.flatMap((e) =>
      e.type === "prerequisites_check" ? [`${e.check.name}:${e.check.status}`] : [],
    );
    assert.deepEqual(checks, [
      "claude_cli:pass",
      "specify_cli:pass",
      "git_init:pass",
      "speckit_init:fail",
    ]);
    assert.equal(fs.existsSync(path.join(dir, ".specify")), false);
    assert.equal(headSha(dir), before);
    assert.deepEqual(stagesRun(events), []);
  } finally {
    rmTmp(dir);
  }
});

test("existing project: a dirty tree before a branch switch pauses dirty_tree and names the file", async () => {
  const dir = mkExistingProject();
  try {
    // Entry A is done already; entry B starts from 900-fixture-a, so put the checkout elsewhere.
    execSync("git switch -q main", { cwd: dir });
    write(dir, "notes.txt", "uncommitted\n");
    const queue = JSON.parse(
      execSync("git show 900-fixture-a:.dex/queue.json", { cwd: dir, encoding: "utf-8" }),
    );
    queue.entries[0].status = "done";
    write(dir, ".dex/queue.json", `${JSON.stringify(queue, null, 2)}\n`);
    for (const f of ["policy.json", "mock-config.json", "dex-config.json"]) {
      write(
        dir,
        `.dex/${f}`,
        execSync(`git show 900-fixture-a:.dex/${f}`, { cwd: dir, encoding: "utf-8" }),
      );
    }
    execSync("git add .dex && git commit -q -m 'queue on main'", { cwd: dir });

    const events: OrchestratorEvent[] = [];
    await run(config(dir), (ev) => events.push(ev));
    const paused = events.find((e) => e.type === "paused");
    assert.equal(paused?.type === "paused" && paused.reason, "dirty_tree");
    assert.match((paused?.type === "paused" && paused.detail) || "", /notes\.txt/);
    assert.equal(currentBranch(dir), "main");
    // The picker chose specify; the switch it needs paused the run before any agent started.
    assert.deepEqual(stagesRun(events), ["901-fixture-b:specify"]);
    assert.deepEqual(
      events.filter((e) => e.type === "step_started" && e.step !== "prerequisites"),
      [],
    );
  } finally {
    rmTmp(dir);
  }
});
