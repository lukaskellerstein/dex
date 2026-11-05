import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  evidenceKey,
  parseVerdict,
  readVerifyRecord,
  tasksHash,
  type VerifyRecord,
  writeVerifyRecord,
} from "../evidence.ts";
import { commitFile, mkTmpRepo, rmTmp } from "./helpers/git.ts";
import { mkTmpProject, writeFiles } from "./helpers/project.ts";

const ENTRY = { branch: "001-cart", specDir: "specs/001-cart" };

function record(key: string, over: Partial<VerifyRecord> = {}): VerifyRecord {
  return {
    version: 1,
    entryId: "001-cart",
    key,
    tasksHash: tasksHash("- [X] T001 add the cart\n"),
    checked: "2026-11-05T10:00:00Z",
    verdict: "passed",
    summary: "every criterion is met",
    commands: [{ command: "npm test", exitCode: 0 }],
    criteria: [{ criterion: "SC-001", met: true, note: "" }],
    ...over,
  };
}

test("evidenceKey: existing project → the entry branch's HEAD; a new commit changes it", () => {
  const dir = mkTmpRepo();
  try {
    assert.equal(evidenceKey(dir, "existing", ENTRY), null, "no branch yet");
    execSync("git switch -q -c 001-cart", { cwd: dir });
    commitFile(dir, "src/cart.ts", "export {};\n", "cart");
    const head = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    assert.equal(evidenceKey(dir, "existing", ENTRY), head);
    commitFile(dir, "src/cart.ts", "export const total = 0;\n", "total");
    assert.notEqual(evidenceKey(dir, "existing", ENTRY), head);
  } finally {
    rmTmp(dir);
  }
});

test("evidenceKey: new project → a hash of the spec folder; only that folder counts", () => {
  const dir = mkTmpProject({
    "specs/001-cart/spec.md": "# Cart\n",
    "specs/001-cart/tasks.md": "x\n",
  });
  try {
    const key = evidenceKey(dir, "new", ENTRY);
    assert.match(key ?? "", /^spec:[0-9a-f]{64}$/);
    writeFiles(dir, { "src/checkout.ts": "export {};\n" });
    assert.equal(evidenceKey(dir, "new", ENTRY), key, "a file outside the folder");
    writeFiles(dir, { "specs/001-cart/checklists/ux.md": "- [ ] ok\n" });
    assert.notEqual(evidenceKey(dir, "new", ENTRY), key, "a new file in the folder");
    assert.equal(evidenceKey(dir, "new", { ...ENTRY, specDir: "specs/404" }), null);
  } finally {
    rmTmp(dir);
  }
});

test("verify record: write then read; the folder ignores itself, git stays clean", () => {
  const dir = mkTmpRepo();
  try {
    assert.equal(readVerifyRecord(dir, "001-cart"), null);
    writeVerifyRecord(dir, record("abc"));
    assert.deepEqual(readVerifyRecord(dir, "001-cart"), record("abc"));
    assert.equal(fs.readFileSync(path.join(dir, ".dex/evidence/.gitignore"), "utf8"), "*\n");
    assert.equal(execSync("git status --porcelain", { cwd: dir, encoding: "utf8" }), "");
    writeVerifyRecord(dir, record("def", { verdict: "failed" }));
    assert.equal(readVerifyRecord(dir, "001-cart")?.verdict, "failed", "the last record wins");
  } finally {
    rmTmp(dir);
  }
});

test("verify record: an unreadable record is null, so the picker verifies again", () => {
  const dir = mkTmpProject({ ".dex/evidence/001-cart/verify.json": "{ not json" });
  try {
    assert.equal(readVerifyRecord(dir, "001-cart"), null);
    writeFiles(dir, { ".dex/evidence/001-cart/verify.json": '{"verdict":"passed"}' });
    assert.equal(readVerifyRecord(dir, "001-cart"), null, "no key, no tasks hash");
  } finally {
    rmTmp(dir);
  }
});

test("parseVerdict: needs a passed or failed verdict; fills missing lists", () => {
  assert.equal(parseVerdict(null), null);
  assert.equal(parseVerdict("passed"), null);
  assert.equal(parseVerdict({ verdict: "ok" }), null);
  assert.deepEqual(parseVerdict({ verdict: "failed" }), {
    verdict: "failed",
    summary: "",
    commands: [],
    criteria: [],
  });
});
