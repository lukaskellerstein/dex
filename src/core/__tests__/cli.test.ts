/**
 * `dex run` (015 US6, contracts/cli.md): argument parsing, exit codes, a dry
 * run that writes nothing, `--status`, `--once`, and human input on the
 * terminal — a parked request without a TTY (exit 3), then the answer book and
 * a live prompt with one.
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type * as Args from "../cli/args.ts";
import type { Terminal } from "../cli/terminal.ts";
import type * as Cli from "../cli.ts";
import type * as State from "../state.ts";
import { logSubjects, rmTmp } from "./helpers/git.ts";
import {
  GROUNDED_QUEUE,
  mkExistingProject,
  mkGroundedProject,
  mockFixture,
  stubCliTools,
  writeFile,
} from "./helpers/loop.ts";

const realHome = process.env.HOME;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "dex-home-"));
let main: typeof Cli.main;
let parseArgs: typeof Args.parseArgs;
let readState: typeof State.readState;
let restorePath: () => void;

// paths.ts reads the home folder once, at import, so HOME changes first.
before(async () => {
  process.env.HOME = tmpHome;
  ({ main } = await import("../cli.ts"));
  ({ parseArgs } = await import("../cli/args.ts"));
  ({ readState } = await import("../state.ts"));
  restorePath = stubCliTools();
});
after(() => {
  restorePath();
  process.env.HOME = realHome;
  rmTmp(tmpHome);
});

/** A terminal that records every line; `answers` makes it a TTY that types them in order. */
function fakeTerminal(answers: string[] | null = null): {
  term: Terminal;
  text: () => string;
  left: () => number;
} {
  const lines: string[] = [];
  const queue = answers ? [...answers] : null;
  const term: Terminal = {
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
    ask: queue
      ? async (prompt) => {
          lines.push(prompt);
          const next = queue.shift();
          if (next === undefined) throw new Error(`no scripted answer for: ${prompt}`);
          return next;
        }
      : null,
    close: () => {},
  };
  return { term, text: () => lines.join("\n"), left: () => queue?.length ?? 0 };
}

/** Every file outside .git, with its sha256 — a dry run must leave this map unchanged. */
function treeHash(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of fs.readdirSync(dir, { recursive: true }) as string[]) {
    if (rel === ".git" || rel.startsWith(`.git${path.sep}`)) continue;
    const abs = path.join(dir, rel);
    if (fs.statSync(abs).isFile())
      out[rel] = crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  }
  return out;
}

/** The existing-project fixture where every implement of 900-fixture-a asks a question with no recommended option. */
function mkAskingProject(): string {
  const mock = mockFixture("existing-project.json") as {
    entries: Record<string, Record<string, Record<string, unknown>>>;
  };
  mock.entries["900-fixture-a"].implement.asks = [
    { question: "What is the SLA?", options: [{ label: "99.9%" }, { label: "99.99%" }] },
  ];
  return mkExistingProject(mock);
}

test("parseArgs: run with one mode flag and --agent, queue init; anything else is a usage error", () => {
  assert.deepEqual(parseArgs(["run", "p"]), {
    kind: "run",
    projectDir: "p",
    mode: "run",
    agent: null,
  });
  assert.deepEqual(parseArgs(["run", "p", "--once", "--agent", "mock"]), {
    kind: "run",
    projectDir: "p",
    mode: "once",
    agent: "mock",
  });
  assert.equal(parseArgs(["run", "--dry-run", "p"]).kind, "run");
  assert.deepEqual(parseArgs(["queue", "init", "p"]), { kind: "queue-init", projectDir: "p" });
  for (const bad of [
    [],
    ["run"],
    ["run", "p", "--dry-run", "--status"],
    ["run", "p", "--once", "--dry-run"],
    ["run", "p", "--agent"],
    ["run", "p", "--agent", "gpt"],
    ["run", "p", "--fast"],
    ["run", "p", "q"],
    ["queue", "init"],
  ]) {
    assert.throws(() => parseArgs(bad), { name: "UsageError" }, bad.join(" "));
  }
});

test("dex: a usage error and an invalid policy both exit 2", async () => {
  assert.equal(await main(["run", "p", "--dry-run", "--status"], fakeTerminal().term), 2);
  const dir = mkExistingProject();
  try {
    writeFile(dir, ".dex/policy.json", '{ "permissionMode": "yolo" }\n');
    const t = fakeTerminal();
    assert.equal(await main(["run", dir, "--dry-run"], t.term), 2);
    assert.match(t.text(), /policy\.json/);
    assert.equal(await main(["run", dir], fakeTerminal().term), 2);
  } finally {
    rmTmp(dir);
  }
});

test("dex run --dry-run: one block per remaining entry, every prompt shown, nothing written", async () => {
  const dir = mkExistingProject();
  try {
    const before = treeHash(dir);
    const head = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" });
    const t = fakeTerminal();
    assert.equal(await main(["run", dir, "--dry-run"], t.term), 0);
    const out = t.text();

    assert.deepEqual(out.match(/^━━ \S+/gm), ["━━ 900-fixture-a", "━━ 901-fixture-b"]);
    const [, blockA, blockB] = out.split(/^━━ /m);
    assert.match(blockA, /^decision : implement phase 1 — phase 1 \(.+\) has unchecked tasks$/m);
    assert.match(blockA, /^branch {3}: stay on 900-fixture-a$/m);
    assert.match(
      blockA,
      /^env {6}: CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 SPECIFY_FEATURE=900-fixture-a SPECIFY_FEATURE_DIRECTORY=specs\/900-fixture-a SPECIFY_FEATURE_NO_PERSIST=1$/m,
    );
    assert.match(
      blockA,
      /^options {2}: settingSources=user,project,local permissionMode=default maxTurns=75 budget\/stage=none$/m,
    );
    assert.match(blockA, /^system {3}: claude_code preset$/m);
    assert.match(blockA, /^prompt {3}:\n {2}\S/m);
    assert.match(blockB, /^decision : specify — specs\/901-fixture-b\/spec\.md is missing$/m);
    assert.match(
      blockB,
      /^branch {3}: stay on 900-fixture-a \(base\), spec-kit creates 901-fixture-b$/m,
    );
    assert.match(blockB, /GIT_BRANCH_NAME=901-fixture-b/);
    assert.match(
      out,
      /^policy {3}: \.dex\/policy\.json · deny 1 · ask 0 · frozen 1 · preflight 1/m,
    );

    assert.deepEqual(treeHash(dir), before);
    assert.equal(execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }), head);
    assert.equal(fs.existsSync(path.join(tmpHome, ".dex", "logs")), false);
  } finally {
    rmTmp(dir);
  }
});

test("dex run --once: exactly one stage, then the run pauses user_abort and exits 0", async () => {
  const dir = mkExistingProject();
  try {
    const commits = logSubjects(dir).length;
    assert.equal(await main(["run", dir, "--once"], fakeTerminal().term), 0);
    assert.deepEqual(logSubjects(dir).slice(0, logSubjects(dir).length - commits), [
      "mock(implement): 900-fixture-a",
    ]);
    const state = readState(dir);
    assert.equal(state?.status, "paused");
    assert.equal(state?.pauseReason, "user_abort");
  } finally {
    rmTmp(dir);
  }
});

test("dex run without a TTY: a question that waits is parked, the run pauses, exit 3; --status shows it", async () => {
  const dir = mkAskingProject();
  try {
    const commits = logSubjects(dir).length;
    const t = fakeTerminal();
    assert.equal(await main(["run", dir], t.term), 3);
    const state = readState(dir);
    assert.equal(state?.status, "paused");
    assert.equal(state?.pauseReason, "question");
    assert.equal(state?.pendingRequests.length, 1);
    assert.equal(logSubjects(dir).length, commits, "the parked stage leaves nothing behind");
    assert.match(
      fs.readFileSync(path.join(dir, ".dex/questions.md"), "utf-8"),
      /What is the SLA\?/,
    );

    const before = treeHash(dir);
    const s = fakeTerminal();
    assert.equal(await main(["run", dir, "--status"], s.term), 0);
    assert.match(s.text(), /paused · question/);
    assert.match(s.text(), /^ {2}900-fixture-a +active +implement phase 1/m);
    assert.match(s.text(), /^ {2}901-fixture-b +pending +specify/m);
    assert.match(s.text(), /What is the SLA\?/);
    assert.deepEqual(treeHash(dir), before, "--status writes nothing");
  } finally {
    rmTmp(dir);
  }
});

test("dex run with a TTY: the parked answer goes to the answer book, a new question is asked live, exit 0", async () => {
  const dir = mkAskingProject();
  try {
    assert.equal(await main(["run", dir], fakeTerminal().term), 3);
    // "2" answers the parked question up front; "1" answers implement phase 2's question live.
    const t = fakeTerminal(["2", "1"]);
    assert.equal(await main(["run", dir], t.term), 0);
    assert.equal(t.left(), 0);
    assert.match(t.text(), /\? What is the SLA\? → 99\.99% \(answer book\)/);
    const state = readState(dir);
    assert.equal(state?.status, "completed");
    assert.deepEqual(state?.pendingRequests, []);
    assert.deepEqual(state?.answerBook, []);
  } finally {
    rmTmp(dir);
  }
});

test("dex digest: prints the digest (exit 0), none yet (exit 1), unknown entry (exit 2); dex run ends with its path", async () => {
  const dir = mkGroundedProject("rewords-task.json");
  try {
    const none = fakeTerminal();
    assert.equal(await main(["digest", dir, "900-fixture-a"], none.term), 1);
    assert.equal(none.text(), "no digest for 900-fixture-a yet");
    const unknown = fakeTerminal();
    assert.equal(await main(["digest", dir, "999-nope"], unknown.term), 2);
    assert.equal(unknown.text(), "unknown entry 999-nope");

    const ran = fakeTerminal();
    assert.equal(await main(["run", dir], ran.term), 3, "a gate pause exits 3");
    const file = path.join(dir, ".dex/digests/900-fixture-a.md");
    assert.equal(ran.text().split("\n").at(-1), `digest: ${file}`);

    const printed = fakeTerminal();
    assert.equal(await main(["digest", dir, "900-fixture-a"], printed.term), 0);
    assert.match(printed.text(), /^# 900-fixture-a — paused at implement: plan_changed\n/);
    assert.equal(printed.text(), fs.readFileSync(file, "utf-8").trimEnd());
    assert.throws(() => parseArgs(["digest", dir]), /dex digest takes <projectDir> and <entryId>/);
  } finally {
    rmTmp(dir);
  }
});

test("dex run --dry-run: a sensors section per entry (fast, entry, standing, acceptance), and no sensor runs", async () => {
  const [entry] = GROUNDED_QUEUE.entries;
  const check = { name: "greet unit", command: "node .dex/fake/check.mjs greet", timeoutSec: 60 };
  const dir = mkGroundedProject("happy-path.json", {
    fake: { unit: "1\n0\n" },
    queue: { ...GROUNDED_QUEUE, entries: [{ ...entry, checks: [check] }] },
    policy: {
      checks: {
        fast: [{ name: "unit", command: "node .dex/fake/check.mjs unit", timeoutSec: 30 }],
        standing: [{ name: "full suite", command: "node .dex/fake/check.mjs suite", timeoutSec: 1200 }],
        rerunOnFail: 1,
      },
    },
  });
  try {
    const before = treeHash(dir);
    const t = fakeTerminal();
    assert.equal(await main(["run", dir, "--dry-run"], t.term), 0);
    const block = t.text().split(/^sensors {2}:\n/m)[1]?.split(/^prompt {3}:/m)[0] ?? "";
    assert.deepEqual(
      block.trimEnd().split("\n").map((l) => l.trim().split(/\s{2,}/)),
      [
        ["fast", "unit", "node .dex/fake/check.mjs unit", "30s"],
        ["fast", "greet unit", "node .dex/fake/check.mjs greet", "60s", "(entry)"],
        ["standing", "full suite", "node .dex/fake/check.mjs suite", "1200s"],
        ["acceptance", "api", "node .dex/fake/check.mjs api", "30s"],
      ],
    );
    assert.deepEqual(treeHash(dir), before, "no sensor ran: .dex/fake/unit still starts with 1");

    writeFile(dir, ".dex/queue.json", JSON.stringify({ ...GROUNDED_QUEUE, entries: [{ ...entry, skip: ["brief", "specify", "clarify", "plan", "tasks"], acceptance: [] }] }));
    const withTests = fakeTerminal();
    assert.equal(await main(["run", dir, "--dry-run"], withTests.term), 0);
    assert.match(withTests.text(), /^decision : tests — specs\/900-fixture-a\/acceptance\.json is missing$/m);
    assert.match(withTests.text(), /^ {2}acceptance \(written by the tests stage\)$/m);
  } finally {
    rmTmp(dir);
  }
});
