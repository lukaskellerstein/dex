import assert from "node:assert/strict";
import test from "node:test";
import { estimateCost } from "../steps.ts";

test("estimateCost matches the longest model prefix", () => {
  // Opus 5.5 is $4/$20, Opus 5 is $5/$25 — a shorter-prefix match would misprice it.
  assert.equal(estimateCost("claude-opus-5-5", 1_000_000, 0), 4);
  assert.equal(estimateCost("claude-opus-5", 1_000_000, 0), 5);
  assert.equal(estimateCost("claude-sonnet-4-5-20250929", 0, 1_000_000), 15);
  assert.equal(estimateCost("some-unknown-model", 1_000_000, 1_000_000), 0);
});
