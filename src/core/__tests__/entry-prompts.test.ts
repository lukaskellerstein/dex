/**
 * The implement, restore and tests prompts of 016 US4 (FR-014–FR-016, R8, R10):
 * failures go to the structured `notes`, frozen tests are named with the way to
 * ask for an amendment, and amend mode is about one file.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  ATTEMPT_SCHEMA,
  buildImplementPrompt,
  buildRestorePrompt,
  buildTestsPrompt,
} from "../entry-prompts.ts";
import { resolveEntries } from "../queue.ts";

const [ENTRY] = resolveEntries(
  { version: 3, kind: "existing", entries: [{ id: "003-promo", title: "Promo codes" }] },
  "main",
  null,
);
const FROZEN = ["tests/acceptance/003-promo/expired.spec.ts", "specs/003-promo/acceptance.json"];
const PHASE = { number: 2, name: "Core", purpose: "", tasks: [], status: "partial" as const };

test("implement prompt: failures go to `notes`, tasks.md keeps its plan, frozen tests name the amendment question", () => {
  const p = buildImplementPrompt(ENTRY, "/p", { phase: PHASE, goalPath: null, frozen: FROZEN });
  assert.doesNotMatch(p, /write the error under the task/);
  assert.match(p, /say so in your structured output's `notes`/);
  assert.match(p, /no new, removed, reworded or reordered task and no changed phase heading/);
  assert.match(
    p,
    /tests\/acceptance\/003-promo\/expired\.spec\.ts, specs\/003-promo\/acceptance\.json\. Never edit, move or delete them/,
  );
  assert.match(p, /header "Test amendment", question "Amend <path>: <reason>"/);
  const none = buildImplementPrompt(ENTRY, "/p", { phase: PHASE, goalPath: null });
  assert.doesNotMatch(none, /Test amendment/, "nothing frozen yet, no amendment rule");
});

test("restore prompt: the frozen tests and the attempt output too", () => {
  const p = buildRestorePrompt(ENTRY, "/p", { failing: [], frozen: FROZEN });
  assert.match(p, /frozen acceptance tests/);
  assert.match(p, /`summary` \(what you did\) and `notes`/);
});

test("tests prompt, amend mode: one file and its reason, no red-first, no new record", () => {
  const p = buildTestsPrompt(ENTRY, "/p", {
    testGlobs: ["**/*.spec.*"],
    testSupport: [],
    lastCrash: null,
    amendment: { file: FROZEN[0], reason: "the contract says 422, not 410" },
  });
  assert.match(p, /- File: \/p\/tests\/acceptance\/003-promo\/expired\.spec\.ts/);
  assert.match(p, /- Reason: the contract says 422, not 410/);
  assert.match(
    p,
    /Write only \/p\/tests\/acceptance\/003-promo\/expired\.spec\.ts and files in \/p\/specs\/003-promo/,
  );
  assert.doesNotMatch(p, /## Record them/);
  assert.doesNotMatch(p, /must fail now/);
});

test("ATTEMPT_SCHEMA: summary and notes, nothing else", () => {
  assert.deepEqual(ATTEMPT_SCHEMA.required, ["summary", "notes"]);
  assert.equal(ATTEMPT_SCHEMA.additionalProperties, false);
});
