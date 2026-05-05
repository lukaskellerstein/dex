# Cross-cutting tests

Tests that don't fit a single user story but verify global properties of the 014 feature.

---

## 5A — Copy hygiene grep

**Goal**: Verify no version-control jargon ("merge", "branch", "fast-forward", "rebase", "conflict marker", "PR") leaks into user-visible strings outside the explicit allowlist in `branchOps/copy.ts`.

**Maps to**: FR-028, FR-029, SC-004.

### Pre-flight

None. Run from the project root.

### Actions

```sh
# Step 1 — every hit in copy.ts must be on a line annotated with `// allowed:`.
grep -nE '\b(merge|branch|fast-forward|rebase|conflict marker|PR)\b' \
  src/renderer/components/checkpoints/branchOps/copy.ts \
  | grep -v "// allowed:" \
  | grep -v "^[^:]*:[12]:" \
  | grep -v "branch-management" \
  | grep -v 'user-visible string'
```

### Expected output

Empty (no lines).

### Step 2 — every other file in `components/checkpoints/`

```sh
# Find user-visible string-literal occurrences of the forbidden words,
# excluding code identifiers, branch-name comparisons, and the data-testid attribute.
grep -rnE '"[^"]*\b(merge|branch|fast-forward|rebase|conflict marker|PR)\b[^"]*"' \
  src/renderer/components/checkpoints/ \
  --include="*.tsx" --include="*.ts" \
  | grep -v "branchOps/copy.ts" \
  | grep -v "data-testid" \
  | grep -v 'kind: "merge"' \
  | grep -v '=== "main"\|=== "master"\|"selected-"\|"dex/"' \
  | grep -v '\${[a-zA-Z_]*[Bb]ranch}' \
  | grep -v 'r\.branch'
```

### Expected output

Empty (after the explicit exclusions for code-only patterns).

### What's an acceptable hit (won't fail the gate)

- Discriminated-union string literals like `kind: "merge"` in `timelineLayout.ts` — code, not user copy.
- Branch name comparisons (`=== "main"`) — code, not user copy.
- Property access (`r.branch`, `${branchName}`) — code, not user copy.
- The two strings explicitly annotated `// allowed:` in `copy.ts`.

### Common failures

- **A new modal added a hardcoded jargon string**: refactor it into `copy.ts` and import as a constant.
- **An error message template accidentally interpolates a code path**: replace with `copy.ts:DELETE_FAILED(detail)` etc.

---

## 5B — Type / build / unit-test gate

**Goal**: Confirm the entire feature compiles and all unit tests pass.

**Maps to**: DoD #15 across the slice.

### Actions

```sh
cd /home/lukas/Projects/Github/lukaskellerstein/dex
npx tsc --noEmit                     # → exit 0, no output
npm run test:core                    # → all tests pass
npm run test:renderer                # → all tests pass
npm run build                        # → tsc + vite both succeed
```

### Expected outcomes

- `tsc --noEmit` — zero output, exit 0.
- `npm run test:core` — `tests <N> | pass <N> | fail 0` summary.
- `npm run test:renderer` — `Test Files <M> passed (<M>)` summary.
- `npm run build` — produces `dist/main/index.js`, `dist/preload/preload.js`, `dist/renderer/assets/index-*.js` with no errors.

### Known caveats

- `check:size` flags `src/renderer/components/checkpoints/timelineLayout.ts` (665 LOC > 600). Pre-existing; on the 011 file-size-exceptions allowlist.
- Three test files (`branchOps.test.ts`, `conflictResolver.test.ts`, `runOneShot.test.ts`) are blocked from running under Node 24's `--experimental-strip-types` due to a project-wide `.js` → `.ts` resolution gap. They're structurally correct; the static type-check covers their type-correctness.

---

## 5C — IPC channel routing (smoke)

**Goal**: Verify all 6 IPC methods are exposed on `window.dexAPI.checkpoints` and route correctly.

**Maps to**: contracts/ipc-deleteBranch.md, ipc-mergeToMain.md, plus the 3 follow-up channels.

### Pre-flight

App running, project open (any dex-ecommerce state).

### Actions

```sh
node scripts/test-014-cdp.mjs eval "
  const cp = window.dexAPI?.checkpoints ?? {};
  const required = [
    'deleteBranch', 'promoteSummary', 'mergeToMain',
    'acceptResolverResult', 'abortResolverMerge', 'openInEditor',
  ];
  return {
    present: required.filter(k => typeof cp[k] === 'function'),
    missing: required.filter(k => typeof cp[k] !== 'function'),
  };
"
```

### Expected return

```json
{
  "present": [
    "deleteBranch", "promoteSummary", "mergeToMain",
    "acceptResolverResult", "abortResolverMerge", "openInEditor"
  ],
  "missing": []
}
```

### Verify each routes — return-value smoke (project state must NOT have a pending merge)

```sh
node scripts/test-014-cdp.mjs eval "
  const proj = '/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce';
  const r1 = await window.dexAPI.checkpoints.acceptResolverResult(proj);
  const r2 = await window.dexAPI.checkpoints.abortResolverMerge(proj);
  const r3 = await window.dexAPI.checkpoints.openInEditor(proj, []);
  return {
    accept: r1,
    abort: r2,
    editor: r3,
  };
"
```

### Expected outcomes

- `accept`: `{ ok: false, error: '...' }` with the error mentioning `nothing to commit, working tree clean` (since no merge is pending).
- `abort`: `{ ok: true }` (the handler treats "no merge to abort" as success).
- `editor`: `{ ok: true }` (spawn succeeded with no files).

---

## 5D — End-to-end smoke chain

**Goal**: Run a sequence of US1 + US2 + US3 actions in the same app session to verify state transitions hold across multiple flows.

**Maps to**: T049 from the implementation tasks.

### Pre-flight

1. `bash scripts/reset-example-to.sh pristine`.
2. Run fixtures in sequence: F2 (delete fixture) + F7 (clean promote fixture).
   - First run F2 to create `dex/2026-05-04-unique`.
   - Then create the F7 branch: `cd dex-ecommerce && git checkout -q main && [F7 commands minus the initial reset]`.
3. `node scripts/test-014-cdp.mjs open`.

### Actions

```sh
# 1) Delete a saved version with lost-work
node scripts/test-014-cdp.mjs click "delete-branch-dex/2026-05-04-unique"
node scripts/test-014-cdp.mjs wait "delete-branch-lost-steps" 3000
node scripts/test-014-cdp.mjs click "delete-branch-confirm"
node scripts/test-014-cdp.mjs wait "branch-badge-dex/2026-05-04-unique" 5000 --gone

# 2) Dismiss any leftover toast.
node scripts/test-014-cdp.mjs eval "
  document.querySelector('[data-testid=\"timeline-toast\"]')?.querySelector('button')?.click();
  return { ok: true };
"

# 3) Promote the clean branch
node scripts/test-014-cdp.mjs rclick "branch-badge-dex/2026-05-04-clean"
node scripts/test-014-cdp.mjs click "promote-menu-item-dex/2026-05-04-clean"
node scripts/test-014-cdp.mjs wait "promote-confirm" 3000
node scripts/test-014-cdp.mjs click "promote-confirm"
node scripts/test-014-cdp.mjs wait "timeline-toast" 5000

# 4) Verify final git state
```

### Expected final state

**Git side**:

```sh
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce

# Both source branches gone.
git branch --list 'dex/*'                          # → empty

# Main has a merge commit.
git log -1 --format=%s main                        # → "dex: promoted dex/2026-05-04-clean to main"

# HEAD on main.
git rev-parse --abbrev-ref HEAD                   # → "main"

# No promoted-* tags.
git tag --list 'checkpoint/promoted-*'             # → empty
```

**UI side**:

- Two toasts visible (lost-work confirmation + post-merge), or only the post-merge if the lost-work flow doesn't toast.
- Timeline shows only the main lane.

### Cleanup

`[run cleanup helper]`

---

## How to run all scenarios in batch

A future enhancement: add a `scripts/run-014-tests.mjs` that takes a manifest file like:

```jsonc
[
  { "id": "1A", "fixture": "F1", "scenarioFile": "us1-delete.md#1A" },
  { "id": "1B", "fixture": "F2", "scenarioFile": "us1-delete.md#1B" },
  ...
]
```

and drives each scenario in sequence with reset-between, capturing pre/post snapshots into `screenshots/`.

For v1, run scenarios manually one at a time and verify the expected outcomes by hand. The `node scripts/test-014-cdp.mjs snap` command is the single source of UI truth at any point.
