/**
 * The one-page digest (016 US5, FR-037, FR-020, R15): every section in order,
 * flaky checks and skip markers marked, the questions answered by default, a
 * diff stat per repo, and a folder that ignores itself.
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { type DigestFacts, digestFacts, idRanges, renderDigest, writeDigest } from "../digest.ts";
import { type NewStageRecord, writeStageRecord } from "../evidence.ts";
import { DEFAULT_POLICY, type Policy } from "../policy.ts";
import { resolveEntries } from "../queue.ts";
import type { SensorRun } from "../sensors.ts";
import { headSha, mkTmpRepo, rmTmp } from "./helpers/git.ts";
import { writeFiles } from "./helpers/project.ts";

const run = (name: string, result: SensorRun["result"], exitCode = result === "pass" || result === "flaky" ? 0 : 1): SensorRun => ({
  name,
  command: `npm run ${name}`,
  exitCode,
  signal: null,
  durationMs: 900,
  result,
  reruns: result === "flaky" ? 1 : 0,
  tail: [],
});

const FACTS: DigestFacts = {
  entryId: "003-promo-codes",
  status: "paused at implement: stalled",
  why: "003-promo-codes: three implement runs ended with the same failure and no new diff",
  diffs: [{ repo: "", since: "a1b2c3d", files: [{ path: "src/cart/promo.ts", added: 84, deleted: 3 }] }],
  tasks: { done: ["T010", "T011", "T012", "T014"], inScope: 9 },
  fastDeclared: true,
  checks: [
    { name: "unit", runs: [run("unit", "fail"), run("unit", "fail"), run("unit", "fail")] },
    { name: "lint", runs: [run("lint", "flaky"), run("lint", "pass")] },
  ],
  acceptance: { stage: "red-first", runs: [run("acceptance", "fail")] },
  done: null,
  skipMarkers: ["tests/cart/promo.test.ts: it.skip('expired', () => {})"],
  answered: [
    { question: "Store codes case-insensitively?", answer: "Yes (Recommended)", entryId: "003-promo-codes", stage: "plan", at: "" },
  ],
  costUsd: 1.84,
};

const ORDER = [
  "# 003-promo-codes — paused at implement: stalled",
  "**Why**:",
  "**Diff** (since a1b2c3d): src/cart/promo.ts +84 −3 · 1 file",
  "**Tasks done**: T010–T012, T014 (4 of 9 in scope)",
  "**Checks**: unit ✗ (red 3 runs in a row) · lint ✓ (flaky ×1)",
  "**Acceptance** (at red-first): acceptance ✗ (exit 1)",
  "**Verifier**: —",
  "**Skip markers**: tests/cart/promo.test.ts: it.skip('expired', () => {})",
  '**Answered by default**: 1 — "Store codes case-insensitively?" → "Yes (Recommended)"',
  "**Cost**: $1.84 this entry, this run",
];

test("renderDigest: every FR-037 section, in order, with flaky checks, skip markers and defaults", () => {
  const md = renderDigest(FACTS);
  let at = -1;
  for (const line of ORDER) {
    const i = md.indexOf(line);
    assert.ok(i > at, `"${line}" is in the digest, after the section before it`);
    at = i;
  }
});

test("renderDigest: no fast checks → says so (FR-020); the verifier's findings are listed", () => {
  const md = renderDigest({
    ...FACTS,
    status: "done",
    why: null,
    fastDeclared: false,
    checks: [],
    done: {
      version: 2,
      entryId: FACTS.entryId,
      key: "k",
      tasksHash: "h",
      checked: "",
      acceptance: [],
      mode: "review",
      findings: [{ severity: "minor", summary: "wording", criterion: null, where: "src/cart/promo.ts:12" }],
      hypotheses: [],
      summary: "acceptance is green",
      gate: "passed",
    },
  });
  assert.match(md, /\*\*Checks\*\*: no fast checks ran \(none declared; the progress gate rests on the plan diff alone\)/);
  assert.match(md, /\*\*Verifier\*\* \(review, done gate passed\): 0 blocking, 1 minor — acceptance is green\n\n- minor: wording \(src\/cart\/promo\.ts:12\)/);
  assert.doesNotMatch(md, /\*\*Why\*\*/);
});

test("idRanges: consecutive ids collapse into a range", () => {
  assert.equal(idRanges(["T002", "T004", "T005", "T006", "T009"]), "T002, T004–T006, T009");
  assert.equal(idRanges([]), "");
});

const PAST = { GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };

test("digestFacts: a diff stat per repo — the project from the first record's startSha, an extra checkout from its HEAD then", () => {
  const dir = mkTmpRepo();
  try {
    writeFiles(dir, {
      "specs/003-promo/tasks.md": "## Phase 1: Core\n\n- [X] T001 Lookup\n- [ ] T002 Expiry\n",
      "src/promo.ts": "export const a = 1;\n",
    });
    execSync("git add -A && git commit -q -m base", { cwd: dir });
    const api = path.join(dir, "services/api");
    fs.mkdirSync(api, { recursive: true });
    execSync("git init -q -b main && git config user.email t@d && git config user.name T", { cwd: api });
    writeFiles(api, { "handler.ts": "one\n" });
    execSync("git add -A && git commit -q -m base", { cwd: api, env: { ...process.env, ...PAST } });
    const [entry] = resolveEntries({ version: 3, kind: "existing", entries: [{ id: "003-promo", title: "Promo" }] }, "main", null);
    const rec: NewStageRecord = {
      entryId: entry.id, stage: "baseline", mode: null, taskPhase: null, key: null, tasksHash: null,
      startSha: headSha(dir), endSha: null, treeStamp: "", runs: [run("unit", "pass")], planDiff: null,
      testChanges: null, fingerprint: null, gate: null, acceptanceHash: null, summary: null,
    };
    writeStageRecord(dir, rec);
    writeFiles(dir, { "src/promo.ts": "export const a = 1;\nexport const b = 2;\n" });
    writeFiles(api, { "handler.ts": "one\ntwo\nthree\n" });
    const policy: Policy = { ...DEFAULT_POLICY, repos: ["services/*"], checks: { fast: [{ name: "unit", command: "x", timeoutSec: 1 }], standing: [], rerunOnFail: 1 } };
    const facts = digestFacts(dir, entry, policy, { status: "done", why: null });
    assert.deepEqual(
      facts.diffs.map((d) => [d.repo, d.files.map((f) => `${f.path} +${f.added}`)]),
      [
        ["", ["src/promo.ts +1"]],
        ["services/api", ["handler.ts +2"]],
      ],
    );
    assert.deepEqual(facts.tasks, { done: ["T001"], inScope: 2 });
    assert.deepEqual(facts.checks.map((c) => `${c.name}:${c.runs.length}`), ["unit:1"]);
    const md = renderDigest(facts);
    assert.match(md, /\*\*Diff\*\* \(since [0-9a-f]{7}\): src\/promo\.ts \+1 −0 · 1 file\n\n\*\*Diff\*\* services\/api \(since [0-9a-f]{7}\): handler\.ts \+2 −0 · 1 file/);
  } finally {
    rmTmp(dir);
  }
});

test("writeDigest: .dex/digests/<id>.md in a folder that ignores itself; git stays clean", () => {
  const dir = mkTmpRepo();
  try {
    const file = writeDigest(dir, "003-promo", "# 003-promo — done\n");
    assert.equal(file, path.join(dir, ".dex/digests/003-promo.md"));
    assert.equal(fs.readFileSync(path.join(dir, ".dex/digests/.gitignore"), "utf-8"), "*\n");
    assert.equal(execSync("git status --porcelain", { cwd: dir, encoding: "utf-8" }), "");
  } finally {
    rmTmp(dir);
  }
});
