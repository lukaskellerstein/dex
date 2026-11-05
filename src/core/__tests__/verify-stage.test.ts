/**
 * The verify stage's pure parts (016 research R13): the two output parsers, the
 * schemas (no verdict field), where a fix phase goes, and the prompt per mode.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildVerifyPrompt } from "../entry-prompts.ts";
import { type QueueV3, resolveEntries } from "../queue.ts";
import type { SensorRun } from "../sensors.ts";
import {
  DIAGNOSE_SCHEMA,
  parseDiagnose,
  parseReview,
  REVIEW_SCHEMA,
  verifyFacts,
} from "../stages/verify-stage.ts";

const FINDING = {
  severity: "blocking",
  summary: "the total ignores the promo code",
  criterion: "SC-002",
  where: "src/cart/total.ts:12",
};

test("parseReview: the R13 shape; a verdict field is ignored", () => {
  const out = parseReview({
    verdict: "passed",
    summary: "one blocking finding",
    criteria: [{ criterion: "SC-002", met: false, note: "wrong total" }],
    findings: [FINDING, { severity: "minor", summary: "wording", criterion: null, where: "" }],
  });
  assert.deepEqual(out, {
    summary: "one blocking finding",
    criteria: [{ criterion: "SC-002", met: false, note: "wrong total" }],
    findings: [FINDING, { severity: "minor", summary: "wording", criterion: null, where: null }],
  });
  assert.equal("verdict" in (out ?? {}), false);
});

test("parseReview: a malformed output is null", () => {
  for (const bad of [
    null,
    "passed",
    { summary: "x" },
    { summary: "x", findings: "none" },
    { summary: "x", findings: [{ severity: "critical", summary: "y" }] },
    { summary: "x", findings: [{ severity: "minor", summary: "" }] },
    { findings: [] },
  ]) {
    assert.equal(parseReview(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(
    parseReview({ summary: "ok", findings: [] })?.criteria,
    [],
    "criteria may be missing",
  );
});

test("parseDiagnose: the R13 shape; a verdict field is ignored; malformed → null", () => {
  assert.deepEqual(
    parseDiagnose({ verdict: "passed", summary: "red", hypotheses: ["the route is missing"] }),
    { summary: "red", hypotheses: ["the route is missing"] },
  );
  for (const bad of [
    null,
    { summary: "x" },
    { summary: "x", hypotheses: [1] },
    { hypotheses: [] },
  ]) {
    assert.equal(parseDiagnose(bad), null, JSON.stringify(bad));
  }
});

test("schemas: neither has a verdict field (FR-005, SC-006)", () => {
  assert.equal("verdict" in REVIEW_SCHEMA.properties, false);
  assert.equal("verdict" in DIAGNOSE_SCHEMA.properties, false);
  assert.deepEqual(REVIEW_SCHEMA.properties.findings.items.properties.severity.enum, [
    "blocking",
    "minor",
  ]);
});

test("verifyFacts: the round, the next phase number and the next task id", () => {
  const tasks =
    "## Phase 1: Core\n\n- [X] T001 a\n- [X] T009 b\n\n## Phase 2: Verify fixes V1\n\n- [X] T010 fix\n";
  assert.deepEqual(verifyFacts(tasks), { round: 2, nextPhaseNumber: 3, nextTaskId: "T011" });
});

// ── The prompt per mode ──

const QUEUE: QueueV3 = { version: 3, kind: "new", entries: [{ id: "001-cart", title: "Cart" }] };
const [ENTRY] = resolveEntries(QUEUE, "main", "dex/run");

function acc(result: "pass" | "fail"): SensorRun {
  return {
    name: "acceptance",
    command: "npx playwright test tests/acceptance/001-cart",
    exitCode: result === "pass" ? 0 : 1,
    signal: null,
    durationMs: 10,
    result,
    reruns: 0,
    tail: result === "pass" ? [] : ["✘ cart › applies a promo code", "  expected 90, got 100"],
  };
}

const facts = { round: 1, nextPhaseNumber: 3, nextTaskId: "T010" };

test("buildVerifyPrompt diagnose: Dex's red tails, the diff stat, a fix phase; no verdict", () => {
  const p = buildVerifyPrompt(ENTRY, "/p", {
    ...facts,
    mode: "diagnose",
    acceptance: [acc("fail")],
    diffStat: " src/cart/total.ts | 4 ++--",
    browser: false,
  });
  assert.match(p, /— diagnose mode\./);
  assert.match(p, /expected 90, got 100/);
  assert.match(p, /src\/cart\/total\.ts \| 4/);
  assert.match(p, /^## Phase 3: Verify fixes V1$/m);
  assert.match(p, /^- \[ \] T010 /m);
  assert.match(p, /`hypotheses`/);
  assert.doesNotMatch(p, /verdict/i);
});

test("buildVerifyPrompt review: findings with a severity, a fix phase per blocking one; browser only when on", () => {
  const extras = { ...facts, mode: "review" as const, acceptance: [acc("pass")], diffStat: null };
  const p = buildVerifyPrompt(ENTRY, "/p", { ...extras, browser: false });
  assert.match(p, /— review mode\./);
  assert.match(p, /\("acceptance"\), and they are green/);
  assert.match(p, /`blocking`: a criterion is not met/);
  assert.match(p, /one task per blocking finding/);
  assert.doesNotMatch(p, /verdict/i);
  assert.doesNotMatch(p, /browser tools/);
  assert.match(buildVerifyPrompt(ENTRY, "/p", { ...extras, browser: true }), /browser tools/);
});
