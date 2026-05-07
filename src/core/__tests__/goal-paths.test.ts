import test from "node:test";
import assert from "node:assert/strict";
import { deriveGoalPaths } from "../goal-paths.ts";

test("deriveGoalPaths — default GOAL.md produces canonical derivatives", () => {
  const paths = deriveGoalPaths("/proj/GOAL.md");
  assert.equal(paths.goal, "/proj/GOAL.md");
  assert.equal(paths.clarified, "/proj/GOAL_clarified.md");
  assert.equal(paths.productDomain, "/proj/GOAL_product_domain.md");
  assert.equal(paths.technicalDomain, "/proj/GOAL_technical_domain.md");
});

test("deriveGoalPaths — custom basename carries through to all derivatives", () => {
  const paths = deriveGoalPaths("/proj/MY_GOAL.md");
  assert.equal(paths.clarified, "/proj/MY_GOAL_clarified.md");
  assert.equal(paths.productDomain, "/proj/MY_GOAL_product_domain.md");
  assert.equal(paths.technicalDomain, "/proj/MY_GOAL_technical_domain.md");
});

test("deriveGoalPaths — preserves the directory of the source path", () => {
  const paths = deriveGoalPaths("/some/nested/dir/PROJECT.md");
  assert.equal(paths.clarified, "/some/nested/dir/PROJECT_clarified.md");
  assert.equal(paths.productDomain, "/some/nested/dir/PROJECT_product_domain.md");
});

test("deriveGoalPaths — empty extension defaults to .md", () => {
  const paths = deriveGoalPaths("/proj/PROJECT");
  assert.equal(paths.clarified, "/proj/PROJECT_clarified.md");
});

test("deriveGoalPaths — rejects names that already end in a derivative suffix", () => {
  assert.throws(() => deriveGoalPaths("/proj/FOO_clarified.md"), /collides with derivative/);
  assert.throws(() => deriveGoalPaths("/proj/FOO_product_domain.md"), /collides with derivative/);
  assert.throws(() => deriveGoalPaths("/proj/FOO_technical_domain.md"), /collides with derivative/);
});
