import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { DEFAULT_POLICY, loadPolicy } from "../policy.ts";
import { loadQueue } from "../queue.ts";
import { initQueue, QueueExistsError } from "../queue-init.ts";
import { mkTmpRepo, rmTmp } from "./helpers/git.ts";

let dir: string;

beforeEach(() => {
  // Deliberately not a git repository: init must not need git.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dex-queue-init-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const TASKS_OPEN = "# Tasks\n\n## Phase 1: Setup\n\n- [X] T001 Do it\n- [ ] T002 Do more\n";
const TASKS_DONE = "# Tasks\n\n## Phase 1: Setup\n\n- [X] T001 Do it\n- [x] T002 Do more\n";

function fixture(): void {
  // Finished before Dex: every artefact, every task checked.
  write(
    "specs/010-done/spec.md",
    "# Feature Specification: Done thing\n\n## Clarifications\n\n- a\n",
  );
  write("specs/010-done/plan.md", "# Plan\n");
  write("specs/010-done/tasks.md", TASKS_DONE);
  // Half way: spec without clarifications, a plan, open tasks.
  write("specs/020-half/spec.md", "# Half way\n");
  write("specs/020-half/plan.md", "# Plan\n");
  write("specs/020-half/tasks.md", TASKS_OPEN);
  // A brief only, in docs/my-specs/.
  write("docs/my-specs/030-brief-only/README.md", "# Brief only feature\n\nWhat we want.\n");
  // A brief and a spec, merged by folder name.
  write("docs/my-specs/015-both/README.md", "# From the brief\n");
  write("specs/015-both/spec.md", "# From the spec\n\n## Clarifications\n");
  // Not folders: ignored.
  write("specs/README.md", "# index\n");
  write("docs/my-specs/notes.md", "# notes\n");
}

test("queue init: merges specs/ and docs/my-specs/ by folder name, sorted, with derived skip and status", () => {
  fixture();
  initQueue(dir);
  const queue = loadQueue(dir);
  assert.ok(queue);
  assert.equal(queue.kind, "existing");
  assert.deepEqual(queue.entries, [
    {
      id: "010-done",
      title: "Done thing",
      skip: ["specify", "clarify", "plan", "tasks"],
      status: "done",
    },
    {
      id: "015-both",
      title: "From the spec",
      brief: "docs/my-specs/015-both/README.md",
      skip: ["specify", "clarify"],
    },
    {
      id: "020-half",
      title: "Half way",
      skip: ["specify", "plan", "tasks"],
    },
    {
      id: "030-brief-only",
      title: "Brief only feature",
      brief: "docs/my-specs/030-brief-only/README.md",
    },
  ]);
});

test("queue init: a folder name that is not a valid id gets a lowercase id; the paths keep the real name", () => {
  write("docs/my-specs/001-Initialization/README.md", "# Initialization\n");
  write("specs/002-Promo Codes/spec.md", "# Promo codes\n");
  initQueue(dir);
  assert.deepEqual(loadQueue(dir)?.entries, [
    {
      id: "001-initialization",
      title: "Initialization",
      brief: "docs/my-specs/001-Initialization/README.md",
    },
    {
      id: "002-promo-codes",
      title: "Promo codes",
      specDir: "specs/002-Promo Codes",
      skip: ["specify"],
    },
  ]);
});

test("queue init: writes the policy with every default and .dex/.gitignore, and reports the files", () => {
  fixture();
  const written = initQueue(dir);
  assert.deepEqual(written, [".dex/queue.json", ".dex/policy.json", ".dex/.gitignore"]);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, ".dex/policy.json"), "utf-8"));
  assert.deepEqual(Object.keys(raw).sort(), Object.keys(DEFAULT_POLICY).sort());
  assert.deepEqual(loadPolicy(dir, "existing"), { ...DEFAULT_POLICY });
  assert.match(fs.readFileSync(path.join(dir, ".dex/.gitignore"), "utf-8"), /^state\.json$/m);
});

test("queue init: keeps an existing policy.json and .gitignore", () => {
  write(".dex/policy.json", '{ "frozen": ["docs/claim.md"] }\n');
  write(".dex/.gitignore", "custom\n");
  write("specs/001-a/spec.md", "# A\n");
  assert.deepEqual(initQueue(dir), [".dex/queue.json"]);
  assert.equal(
    fs.readFileSync(path.join(dir, ".dex/policy.json"), "utf-8"),
    '{ "frozen": ["docs/claim.md"] }\n',
  );
  assert.equal(fs.readFileSync(path.join(dir, ".dex/.gitignore"), "utf-8"), "custom\n");
});

test("queue init: refuses when .dex/queue.json exists and changes nothing", () => {
  write(".dex/queue.json", '{"version":3,"kind":"existing","entries":[]}\n');
  write("specs/001-a/spec.md", "# A\n");
  assert.throws(
    () => initQueue(dir),
    (err: unknown) =>
      err instanceof QueueExistsError && err.message.includes(path.join(dir, ".dex", "queue.json")),
  );
  assert.equal(fs.existsSync(path.join(dir, ".dex/policy.json")), false);
});

test("queue init: in a git repo, an open entry after a done one starts from the current branch", () => {
  // A finished feature's branch is usually merged and gone, so the default base
  // (the previous entry's branch) would not exist and the run would pause.
  const repo = mkTmpRepo("dex-queue-init-git-");
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    dir = repo;
    fixture();
    initQueue(repo);
    const base = Object.fromEntries(
      (loadQueue(repo)?.entries ?? []).map((e) => [e.id, e.baseBranch ?? null]),
    );
    assert.deepEqual(base, {
      "010-done": null,
      "015-both": "main",
      "020-half": null,
      "030-brief-only": null,
    });
  } finally {
    rmTmp(repo);
  }
});

test("queue init: a project with no feature folders is refused and nothing is written", () => {
  assert.throws(() => initQueue(dir), /no feature folders under specs\/ or docs\/my-specs\//);
  assert.equal(fs.existsSync(path.join(dir, ".dex")), false);
});
