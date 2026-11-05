import assert from "node:assert/strict";
import test from "node:test";
import { addedLines, diffTasks, skipMarkers, testFileChanges } from "../plan-diff.ts";
import { DEFAULT_TEST_GLOBS } from "../policy.ts";

const BEFORE = `# Tasks

## Phase 1: Setup

- [X] T001 Create the module in src/cart/index.ts
- [ ] T002 Add the route in src/cart/routes.ts

## Phase 2: Core

Some prose the agent may change.

- [ ] T003 Apply a promo code in src/cart/promo.ts
- [ ] T004 Reject an expired code in src/cart/promo.ts
`;

test("diffTasks: ticking open tasks ([x] or [X]) is allowed; prose and notes are ignored", () => {
  const after = BEFORE.replace("- [ ] T002", "- [x] T002")
    .replace("- [ ] T003", "- [X] T003")
    .replace(
      "Some prose the agent may change.",
      "The agent rewrote this note.\n  - note: npm test is slow",
    );
  assert.deepEqual(diffTasks(BEFORE, after), []);
});

for (const [name, after, expected] of [
  [
    "a removed task",
    BEFORE.replace("- [ ] T004 Reject an expired code in src/cart/promo.ts\n", ""),
    ["T004 was removed"],
  ],
  ["an added task", `${BEFORE}- [ ] T005 Discovered: cache the codes\n`, ["T005 was added"]],
  [
    "a reworded task",
    BEFORE.replace("Reject an expired code", "Accept every code"),
    [
      'T004 was reworded: "Reject an expired code in src/cart/promo.ts" → "Accept every code in src/cart/promo.ts"',
    ],
  ],
  [
    "a reordered task",
    BEFORE.replace(
      "- [ ] T003 Apply a promo code in src/cart/promo.ts\n- [ ] T004 Reject an expired code in src/cart/promo.ts",
      "- [ ] T004 Reject an expired code in src/cart/promo.ts\n- [ ] T003 Apply a promo code in src/cart/promo.ts",
    ),
    ["the task order changed at T003"],
  ],
  ["a re-opened task", BEFORE.replace("- [X] T001", "- [ ] T001"), ["T001 was re-opened"]],
  [
    "a changed phase heading",
    BEFORE.replace("## Phase 2: Core", "## Phase 2: Core (descoped)"),
    [
      'the phase heading "## Phase 2: Core" was changed or removed',
      'the phase heading "## Phase 2: Core (descoped)" was added',
    ],
  ],
] as const) {
  test(`diffTasks: ${name} is a violation that names it`, () => {
    assert.deepEqual(diffTasks(BEFORE, after), expected);
  });
}

test("testFileChanges: frozen files changed, moved or deleted; test files deleted or renamed", () => {
  const nameStatus = [
    "M\ttests/acceptance/promo.spec.ts",
    "M\tsrc/cart/promo.ts",
    "D\tsrc/cart/promo.test.ts",
    "R087\ttests/unit/old.test.ts\ttests/unit/new.test.ts",
    "A\ttests/unit/added.test.ts",
    "R100\tsrc/a.ts\tsrc/b.ts",
    "",
  ].join("\n");
  assert.deepEqual(
    testFileChanges(nameStatus, DEFAULT_TEST_GLOBS, ["tests/acceptance/promo.spec.ts"]),
    {
      frozenChanged: ["tests/acceptance/promo.spec.ts"],
      testsDeletedOrRenamed: [
        "src/cart/promo.test.ts",
        "tests/unit/old.test.ts → tests/unit/new.test.ts",
      ],
    },
  );
  assert.deepEqual(
    testFileChanges("D\ttests/acceptance/promo.spec.ts\n", [], ["tests/acceptance/promo.spec.ts"]),
    {
      frozenChanged: ["tests/acceptance/promo.spec.ts"],
      testsDeletedOrRenamed: [],
    },
  );
});

const DIFF = `diff --git a/tests/cart.spec.ts b/tests/cart.spec.ts
--- a/tests/cart.spec.ts
+++ b/tests/cart.spec.ts
@@ -1,3 +1,4 @@
+test.skip("applies a code", () => {});
 test("totals", () => {});
diff --git a/src/list.ts b/src/list.ts
--- a/src/list.ts
+++ b/src/list.ts
@@ -1 +1 @@
+export const rest = items.skip(1);
`;

test("addedLines + skipMarkers: new markers in test files only", () => {
  const added = addedLines(DIFF);
  assert.deepEqual(
    added.map((a) => a.file),
    ["tests/cart.spec.ts", "src/list.ts"],
  );
  assert.deepEqual(skipMarkers(added, DEFAULT_TEST_GLOBS), [
    'tests/cart.spec.ts: test.skip("applies a code", () => {});',
  ]);
});

for (const marker of [
  "@pytest.mark.skip(reason='later')",
  "    pytest.skip('slow')",
  "@unittest.skip('flaky')",
  "  it.skip('x', () => {})",
  "  xit('x', () => {})",
  "  xdescribe('x', () => {})",
  "  it.todo('x')",
  "  test.fixme('x', async () => {})",
  '\tt.Skip("later")',
  "@pytest.mark.xfail",
]) {
  test(`skipMarkers: finds ${marker.trim()}`, () => {
    assert.equal(skipMarkers([{ file: "tests/x_test.go", line: marker }], ["tests/**"]).length, 1);
  });
}
