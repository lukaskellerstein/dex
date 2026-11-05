import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  type Amendment,
  type DoneRecord,
  evidenceKey,
  markAmendmentApplied,
  type NewStageRecord,
  pendingAmendment,
  readDoneRecord,
  readStageRecords,
  recordAmendment,
  tasksHash,
  writeDoneRecord,
  writeStageRecord,
} from "../evidence.ts";
import { commitFile, mkTmpRepo, rmTmp } from "./helpers/git.ts";
import { mkTmpProject, writeFiles } from "./helpers/project.ts";

const ENTRY = { branch: "001-cart", specDir: "specs/001-cart" };

function record(key: string, over: Partial<DoneRecord> = {}): DoneRecord {
  return {
    version: 2,
    entryId: "001-cart",
    key,
    tasksHash: tasksHash("- [X] T001 add the cart\n"),
    checked: "2026-11-05T10:00:00Z",
    acceptance: [
      {
        name: "acceptance",
        command: "npx playwright test tests/acceptance/001-cart",
        exitCode: 0,
        signal: null,
        durationMs: 1200,
        result: "pass",
        reruns: 0,
        tail: [],
      },
    ],
    mode: "review",
    findings: [{ severity: "minor", summary: "wording", criterion: "SC-001", where: null }],
    hypotheses: [],
    summary: "acceptance is green; one minor finding",
    gate: "passed",
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

test("done record: write then read; the folder ignores itself, git stays clean", () => {
  const dir = mkTmpRepo();
  try {
    assert.equal(readDoneRecord(dir, "001-cart"), null);
    assert.equal(writeDoneRecord(dir, record("abc")), ".dex/evidence/001-cart/done.json");
    assert.deepEqual(readDoneRecord(dir, "001-cart"), record("abc"));
    assert.equal(fs.readFileSync(path.join(dir, ".dex/evidence/.gitignore"), "utf8"), "*\n");
    assert.equal(execSync("git status --porcelain", { cwd: dir, encoding: "utf8" }), "");
    writeDoneRecord(dir, record("def", { gate: "failed", mode: "diagnose", hypotheses: ["h1"] }));
    const last = readDoneRecord(dir, "001-cart");
    assert.equal(last?.gate, "failed", "the last record wins");
    assert.deepEqual(last?.hypotheses, ["h1"]);
  } finally {
    rmTmp(dir);
  }
});

test("done record: unreadable, not version 2, or only a 015 verify.json → null, so the picker verifies again", () => {
  const verify015 = JSON.stringify({
    version: 1,
    entryId: "001-cart",
    key: "abc",
    tasksHash: "x",
    verdict: "passed",
  });
  const dir = mkTmpProject({ ".dex/evidence/001-cart/verify.json": verify015 });
  try {
    assert.equal(readDoneRecord(dir, "001-cart"), null, "a 015 verify.json is never read");
    writeFiles(dir, { ".dex/evidence/001-cart/done.json": "{ not json" });
    assert.equal(readDoneRecord(dir, "001-cart"), null);
    writeFiles(dir, { ".dex/evidence/001-cart/done.json": verify015 });
    assert.equal(readDoneRecord(dir, "001-cart"), null, "version 1 in done.json");
    writeFiles(dir, {
      ".dex/evidence/001-cart/done.json": JSON.stringify({ ...record("abc"), gate: "maybe" }),
    });
    assert.equal(readDoneRecord(dir, "001-cart"), null, "a gate that is not passed or failed");
  } finally {
    rmTmp(dir);
  }
});

function stageRecord(stage: NewStageRecord["stage"], over: Partial<NewStageRecord> = {}) {
  return {
    entryId: "001-cart",
    stage,
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
    gate: null,
    acceptanceHash: null,
    summary: null,
    ...over,
  } satisfies NewStageRecord;
}

test("stage records: numbered per stage, written atomically, the folder ignores itself", () => {
  const dir = mkTmpRepo();
  try {
    const a = writeStageRecord(dir, stageRecord("implement"));
    const b = writeStageRecord(dir, stageRecord("implement", { fingerprint: "f2" }));
    const c = writeStageRecord(dir, stageRecord("baseline"));
    assert.deepEqual(
      [a.file, b.file, c.file],
      [
        ".dex/evidence/001-cart/implement-1.json",
        ".dex/evidence/001-cart/implement-2.json",
        ".dex/evidence/001-cart/baseline-1.json",
      ],
    );
    assert.equal(b.record.n, 2);
    assert.equal(b.record.version, 1);
    assert.match(b.record.at, /^\d{4}-\d\d-\d\dT/);
    assert.equal(fs.readFileSync(path.join(dir, ".dex/evidence/.gitignore"), "utf8"), "*\n");
    assert.deepEqual(
      fs.readdirSync(path.join(dir, ".dex/evidence/001-cart")).filter((f) => f.endsWith(".tmp")),
      [],
    );
    assert.equal(execSync("git status --porcelain", { cwd: dir, encoding: "utf8" }), "");
    const red = writeStageRecord(dir, stageRecord("red-first"));
    assert.equal(red.file, ".dex/evidence/001-cart/red-first-1.json", "a stage with a dash");
  } finally {
    rmTmp(dir);
  }
});

test("stage records: read back oldest first, filtered by stage; an unreadable one is skipped", () => {
  const dir = mkTmpRepo();
  try {
    assert.deepEqual(readStageRecords(dir, "001-cart"), []);
    writeStageRecord(dir, stageRecord("implement", { fingerprint: "f1" }));
    writeStageRecord(dir, stageRecord("baseline"));
    writeStageRecord(dir, stageRecord("implement", { fingerprint: "f2" }));
    writeFiles(dir, {
      ".dex/evidence/001-cart/implement-9.json": "{ torn",
      ".dex/evidence/001-cart/verify.json": '{"verdict":"passed"}',
    });
    assert.deepEqual(
      readStageRecords(dir, "001-cart", "implement").map((r) => r.fingerprint),
      ["f1", "f2"],
    );
    assert.deepEqual(
      readStageRecords(dir, "001-cart").map((r) => `${r.stage}-${r.n}`),
      ["implement-1", "baseline-1", "implement-2"],
    );
  } finally {
    rmTmp(dir);
  }
});

test("amendments: the first approved one is pending until applied; rejected ones never are", () => {
  const dir = mkTmpProject({});
  try {
    const at = "2026-11-12T09:50:00.000Z";
    const item = (file: string, status: Amendment["status"]): Amendment => ({
      file,
      reason: "wrong status code",
      status,
      askedAt: at,
      decidedAt: at,
    });
    assert.equal(pendingAmendment(dir, "003-promo"), null, "no file");
    recordAmendment(dir, "003-promo", item("tests/a.spec.ts", "rejected"));
    assert.equal(pendingAmendment(dir, "003-promo"), null);
    recordAmendment(dir, "003-promo", item("tests/b.spec.ts", "approved"));
    recordAmendment(dir, "003-promo", item("tests/c.spec.ts", "approved"));
    assert.equal(pendingAmendment(dir, "003-promo")?.file, "tests/b.spec.ts");
    markAmendmentApplied(dir, "003-promo", "tests/a.spec.ts");
    assert.equal(pendingAmendment(dir, "003-promo")?.file, "tests/b.spec.ts", "a rejected one is not applied");
    markAmendmentApplied(dir, "003-promo", "tests/b.spec.ts");
    assert.equal(pendingAmendment(dir, "003-promo")?.file, "tests/c.spec.ts");
    const file = path.join(dir, ".dex/evidence/003-promo/amendments.json");
    const items = JSON.parse(fs.readFileSync(file, "utf-8")).items as Amendment[];
    assert.deepEqual(
      items.map((i) => i.status),
      ["rejected", "applied", "approved"],
    );
    assert.equal(fs.readFileSync(path.join(dir, ".dex/evidence/.gitignore"), "utf-8"), "*\n");
  } finally {
    rmTmp(dir);
  }
});
