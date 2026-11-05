/**
 * The attempt log (016 US5, FR-034–FR-036, R14): one section per stage in
 * `.dex/evidence/<id>/progress.md`, the newest that fit in 8,000 characters
 * for the next prompt, and an archive when the entry is done.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  type AttemptEntry,
  appendAttempt,
  archiveAttempts,
  attemptSlice,
  firstErrorLine,
  formatAttempt,
} from "../attempt-log.ts";
import type { SensorRun } from "../sensors.ts";
import { rmTmp } from "./helpers/git.ts";
import { mkTmpProject } from "./helpers/project.ts";

const ID = "003-promo-codes";
const LOG = `.dex/evidence/${ID}/progress.md`;

const red = (name: string, tail: string[]): SensorRun => ({
  name,
  command: `npm run ${name}`,
  exitCode: 1,
  signal: null,
  durationMs: 1200,
  result: "fail",
  reruns: 1,
  tail,
});

const ATTEMPT: AttemptEntry = {
  at: "2026-11-12T09:41:07.123Z",
  stage: "implement",
  taskPhase: 2,
  summary: "Added the promo-code lookup; the expiry check is not wired yet.",
  notes: ["`src/cart/promo.ts` needs the clock from `src/lib/time.ts` to test expiry."],
  gate: "progress fail — unit is red",
  failing: [red("unit", ["> vitest run", "FAIL src/cart/promo.test.ts > rejects an expired code", "  at x"])],
};

test("formatAttempt: the contract's section — time, stage, phase, agent, notes, gate, failing first lines", () => {
  assert.equal(
    formatAttempt(ATTEMPT),
    [
      "## 2026-11-12T09:41:07Z · implement · phase 2",
      "",
      "**Agent**: Added the promo-code lookup; the expiry check is not wired yet.",
      "**Notes**: `src/cart/promo.ts` needs the clock from `src/lib/time.ts` to test expiry.",
      "**Gate**: progress fail — unit is red",
      "**Failing**: unit — `FAIL src/cart/promo.test.ts > rejects an expired code`",
      "",
    ].join("\n"),
  );
  const bare = formatAttempt({ ...ATTEMPT, stage: "tests", taskPhase: null, summary: null, notes: [], gate: null, failing: [] });
  assert.equal(bare, "## 2026-11-12T09:41:07Z · tests\n\n**Agent**: (no summary)\n");
});

test("firstErrorLine: the first line that names an error or failure, else the last line", () => {
  assert.equal(firstErrorLine(["ok 1", "Error: boom", "FAIL x"]), "Error: boom");
  assert.equal(firstErrorLine(["", "compiling", "exit status 2", ""]), "exit status 2");
  assert.equal(firstErrorLine([]), "(no output)");
  assert.equal(firstErrorLine([`FAIL ${"x".repeat(400)}`]).length, 200);
});

test("appendAttempt: one section per stage, oldest first; the folder ignores itself", () => {
  const dir = mkTmpProject({});
  try {
    appendAttempt(dir, ID, ATTEMPT);
    appendAttempt(dir, ID, { ...ATTEMPT, at: "2026-11-12T10:00:00.000Z", taskPhase: 3, failing: [] });
    const md = fs.readFileSync(path.join(dir, LOG), "utf-8");
    assert.equal(md.match(/^## /gm)?.length, 2);
    assert.ok(md.indexOf("phase 2") < md.indexOf("phase 3"));
    assert.equal(fs.readFileSync(path.join(dir, ".dex/evidence/.gitignore"), "utf-8"), "*\n");
  } finally {
    rmTmp(dir);
  }
});

test("attemptSlice: the newest sections that fit the budget, whole, oldest of them first", () => {
  const dir = mkTmpProject({});
  try {
    assert.equal(attemptSlice(dir, ID), "", "no log yet");
    for (let i = 1; i <= 5; i++) {
      appendAttempt(dir, ID, { ...ATTEMPT, taskPhase: i, summary: `run ${i} ${"x".repeat(2400)}`, failing: [] });
    }
    const slice = attemptSlice(dir, ID);
    assert.ok(slice.length <= 8000);
    assert.deepEqual(
      [...slice.matchAll(/^## .* · phase (\d)$/gm)].map((m) => m[1]),
      ["3", "4", "5"],
    );
    assert.ok(slice.endsWith("\n"), "never a cut section");
    assert.equal(attemptSlice(dir, ID, 100), "", "one section over the budget is left out, not cut");
  } finally {
    rmTmp(dir);
  }
});

test("archiveAttempts: moves the log to archive/progress-<ISO>.md; the next slice is empty", () => {
  const dir = mkTmpProject({});
  try {
    assert.equal(archiveAttempts(dir, ID, new Date("2026-11-12T11:00:00.000Z")), null, "nothing to archive");
    appendAttempt(dir, ID, ATTEMPT);
    const moved = archiveAttempts(dir, ID, new Date("2026-11-12T11:00:00.000Z"));
    assert.equal(moved, `.dex/evidence/${ID}/archive/progress-2026-11-12T11-00-00Z.md`);
    assert.match(fs.readFileSync(path.join(dir, moved ?? ""), "utf-8"), /phase 2/);
    assert.equal(fs.existsSync(path.join(dir, LOG)), false);
    assert.equal(attemptSlice(dir, ID), "");
  } finally {
    rmTmp(dir);
  }
});
