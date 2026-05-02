# 013-cleanup-2 — Branch namespace + Record-mode cleanup

## Context

Two pieces of vestigial machinery in the timeline / checkpoints layer carry maintenance cost without any user-visible benefit:

1. **Record mode** — flag, badge, env-var, auto-promote behaviour, `capture/*` branch family, `checkpoint/done-*` tag family. None of this is reachable from the UI; the only ways to enable record mode are `DEX_RECORD_MODE=1` (env var) or hand-editing `state.json`. For every real user the entire feature is dead.
2. **`attempt-*` branch family** — variant slots and Try Again were retired in 008/012; the only remaining producer is the dirty-tree-save flow (`attempt-<ts>-saved`), which is itself easily replaced with a commit on the current branch (no side branch needed).

Both lift weight on the same files (`timeline.ts`, `tags.ts`, `checkpoints/index.ts`, `useTimeline.ts`, `electron.d.ts`, `prune-example-branches.sh`) and both contribute to the same end-state: **the timeline runs on a single two-family branch namespace — `dex/*` + `selected-*`**. Bundling them means we touch each shared file once and the new feature work in `014-branch-management` can assume a clean slate.

After this spec lands:

- The branch namespace running in production is exactly `main` / `master` / `dex/*` / `selected-*`. No `attempt-*` (one carve-out: `scripts/reset-example-to.sh` keeps minting `attempt-${STAMP}` for the testing fixture flow — see [Keep untouched](#keep-untouched) for the rationale). No `capture/*`.
- The tag namespace is exactly `checkpoint/after-<step>` (cycle 0) and `checkpoint/cycle-<N>-after-<step>` (cycle ≥ 1) — the format produced by `checkpointTagFor()` in `tags.ts:64-67`. Feature slug, when present, lives in the commit body (`[feature:<slug>]` trailer), not in the tag name. Tags are created out-of-band by `scripts/promote-checkpoint.sh` for testing; in normal runs no `checkpoint/*` tags are created. No `checkpoint/done-*`. No auto-promotion during runs.
- The dirty-tree-save flow autosaves onto the current branch with a normal commit (subject renamed from the current `dex: dirty-tree autosave before jumpTo` to the shorter `dex: pre-jump autosave`), then proceeds with the navigation. No side branch.
- No REC badge, no `recordMode` flag, no `DEX_RECORD_MODE` env-var check anywhere in the running app.

This is **a no-op behavioural change for end-users**. Nothing visible was reaching them; the cleanup just removes the dead paths.

`014-branch-management` is the immediate next spec — it adds the user-facing delete + promote-to-main flow on top of this clean slate.

## Scope summary

### Part A — Record mode (removed entirely)

**Remove:**

- `recordMode` runtime flag (state file + UI badge + env-var check).
- `capture/<date>-<runId>` branch family (only producer is the Record-mode termination block).
- `checkpoint/done-<slice>` tag family (only producer is the same block; only consumer is a special-case branch in `timeline.ts`).
- Auto-promote-during-run behaviour (`autoPromoteIfRecordMode` called from `finalize.ts`).
- `checkpoint_promoted` orchestrator-event payload that the termination block emits (verify no other producer first; if exclusive, delete the event-type discriminant).

**Relocate (not delete):**

- `syncStateFromHead` — moves out of `recordMode.ts` into `src/core/checkpoints/syncState.ts`. Same signature, same body, same dependencies. This function is called from `App.tsx:289` before resuming a run and is unrelated to Record mode despite living in the same file historically.

### Part B — `attempt-*` branch family (removed entirely)

**Rewrite (one call site):**

- The `force: "save"` body in `src/core/checkpoints/jumpTo.ts:129-141` — replace branch creation + commit on `attempt-<ts>-saved` with `git add -A && git commit -q -m "dex: pre-jump autosave"` on the current branch (this is also a rename — the current code uses `"dex: dirty-tree autosave before jumpTo"`; no test greps for the old subject, verified). Add a detached-HEAD refusal path (`git symbolic-ref -q HEAD` returns non-zero → friendly error, no commit; inline the check, do not extract a helper — only call site). The `<GoBackConfirm>` modal text is updated to drop the leaky branch name from user-visible copy.

**Remove (everything else `attempt-*`):**

- `attemptBranchName()` factory.
- `AttemptInfo` type and the `attempts: AttemptInfo[]`, `currentAttempt: AttemptInfo | null` fields on `TimelineSnapshot`.
- The `git branch --list 'attempt-*'` query block in `timeline.ts:185-219`.
- The `attempt-*` line in `canonicalPriority` and the `visibleBranches` filter; the variant-letter regex (`-(a-e)$`).
- The `attempt-*` glob in `scripts/prune-example-branches.sh`.
- All re-exports of `attemptBranchName`, `AttemptInfo` in `src/core/checkpoints/index.ts`.
- Renderer consumers of `attempts`/`currentAttempt` (`useTimeline.ts`, `electron.d.ts`, anywhere they're rendered).
- Doc-comment references to `attempt-*` in `jumpTo.ts` (`maybePruneEmptySelected`'s rationale, the `JumpToResult` decision-tree comment, etc.) — just text cleanup.

### Keep untouched

- `commitCheckpoint` and the `[checkpoint:<step>:<cycle>]` commit-subject convention. Step commits are still produced on every stage boundary as today; they just become "pending candidates" in the timeline (the `pending: PendingCandidate[]` mechanism on `TimelineSnapshot`) instead of getting auto-promoted to canonical tags.
- The `checkpoint/after-<step>` / `checkpoint/cycle-<N>-after-<step>` tag family — created out-of-band by `scripts/promote-checkpoint.sh` (testing helper) and by any future user-driven "Keep this" verb. None of those go through `recordMode.ts`.
- `scripts/reset-example-to.sh`, `scripts/promote-checkpoint.sh` — they read/write `checkpoint/*` tags directly and are independent of the deleted machinery. `scripts/prune-example-branches.sh` keeps its `dex/*` glob; only the `attempt-*` glob is dropped. **Note**: `reset-example-to.sh:53` (and the file-header comment at line 14) keeps minting `attempt-${STAMP}` branches — this is a deliberate carve-out. The script is a testing fixture entry point only ever pointed at `dex-ecommerce`; the `attempt-*` name is internal scaffolding, never reaches the running app or the timeline (the example project is not the project Dex is opened on). Renaming would be churn for zero user benefit. The `prune-example-branches.sh` `attempt-*` glob is gone, so reset-created branches stay until manually deleted — fine for a test fixture.
- `selectedBranchName()` factory — still used by `jumpTo`'s navigation-fork path. The dirty-tree-save flow no longer creates any branch, so it does not call this factory; that's a use-site change, not a factory change.

## Why this is safe

Six things to verify before deleting. Re-run these greps as the first step of implementation; if anything beyond the file map appears, update the spec before proceeding.

1. **`promoteToCheckpoint` is only called from the Record-mode termination block.** `grep -rn "promoteToCheckpoint" src/`: the only non-export call site is `src/core/orchestrator.ts:287`, inside the `if (recordMode)` block. Deleting that block makes `promoteToCheckpoint` dead.
2. **`autoPromoteIfRecordMode` is only called from `finalize.ts:99`.** `grep -rn "autoPromoteIfRecordMode" src/`: the only non-export call site is `src/core/stages/finalize.ts:99`. Removing that call deletes the only consumer.
3. **`checkpointDoneTag` is only called from `orchestrator.ts:286`.** `grep -rn "checkpointDoneTag" src/`: the only non-export call site is the Record-mode termination block. The only consumer that *reads* `checkpoint/done-*` tags is the special-case branch in `src/core/checkpoints/timeline.ts:135-150`.
4. **`syncStateFromHead` has live consumers.** `grep -rn "syncStateFromHead" src/`: `App.tsx:289`, `src/main/ipc/checkpoints.ts:117`, `src/main/preload-modules/checkpoints-api.ts:12`, `src/renderer/services/checkpointService.ts:88`, `src/renderer/electron.d.ts:33`. Must be relocated, not deleted.
5. **`attemptBranchName` has exactly one live producer call site.** `grep -rn "attemptBranchName" src/`: only `jumpTo.ts:130` constructs an `attempt-<ts>-saved` branch name; everywhere else is type/export plumbing. Rewriting that one body line removes the only producer.
6. **`checkpoint_promoted` event has TWO producers, but BOTH are removed by this spec.** `grep -rn "checkpoint_promoted" src/`: producers are `src/core/orchestrator.ts:289` (inside the Record-mode termination block being deleted) AND `src/core/checkpoints/recordMode.ts:65` (inside `autoPromoteIfRecordMode`, which is deleted along with the entire `recordMode.ts` file). Consumers are `src/renderer/components/checkpoints/hooks/useTimeline.ts:70` (refresh trigger `case`) and `src/renderer/App.tsx:365-369` (DEBUG-badge state update). After the orchestrator block is deleted (Part A step 4) **and** `recordMode.ts` is deleted (Part A step 7), zero producers remain — the discriminant in `events.ts` and both consumer sites must also be removed in the same step. Do NOT remove the discriminant before both producers are gone, or `recordMode.ts` will fail to type-check during the intermediate state.

## Files

| File | Change |
|---|---|
| **Spec** | |
| `docs/my-specs/013-cleanup-2/README.md` | NEW — this document |
| **Part A — Record mode** | |
| `src/core/checkpoints/syncState.ts` | NEW — contains `syncStateFromHead()` moved verbatim from `recordMode.ts`, plus its module-private helper `snapshotResumeFields()` (`recordMode.ts:162-184`) which has no other callers. Same function signatures, same bodies. Rewrite the file-header `What/Not/Deps` JSDoc — the recordMode.ts one mentions promotion + record mode and is wrong for the new home. New header should narrate "post-jumpTo state.json reconciliation from HEAD's step-commit subject". Dependencies after the move: `_helpers` (`gitExec`, `log`, `RunLoggerLike`), `../state.js` (`loadState`, `updateState`, `DexState`), `../types.js` (`StepType`). No `tags.ts` dep (the function does its own subject regex). |
| `src/core/checkpoints/recordMode.ts` | DELETE entire file — `readRecordMode`, `autoPromoteIfRecordMode`, `promoteToCheckpoint` all dead after the producer/consumer removals below. (`syncStateFromHead` already moved to `syncState.ts` in the previous row.) |
| `src/core/orchestrator.ts` | DELETE the entire Record-mode termination block (`orchestrator.ts:280-299`) — the outer `if (runtimeState.activeProjectDir && terminationReason !== "user_abort")` guard plus the inner `if (recordMode)` arm, including the `promoteToCheckpoint` call, the `checkpoint_promoted` event emit, and the `git branch -f ${captureBranchName(runId)} HEAD` exec. DELETE the now-unused imports: `checkpointDoneTag`, `captureBranchName`, `promoteToCheckpoint`, `readRecordMode` (lines 20-23), AND `getHeadSha` from `./git.js` (line 18 — its only call site is line 285 inside the deleted block; `getCurrentBranch` and `createBranch` survive). UPDATE the file-header `Deps:` line (line 4) — drop `checkpoints (record-mode termination)` and `git.getHeadSha`. |
| `src/core/stages/finalize.ts` | DELETE the `await autoPromoteIfRecordMode(...)` call at line 99 and the comment at line 98. DELETE the `autoPromoteIfRecordMode` import at line 11. UPDATE the file-header `What:` summary to drop the `autoPromoteIfRecordMode` reference. |
| `src/core/state.ts` | DELETE the `recordMode?: boolean` field on the `DexUiPrefs` interface (line 25). The interface is named `DexUiPrefs`, not `UiState`. |
| `src/core/events.ts` | DELETE the `checkpoint_promoted` discriminant from the orchestrator-event union (currently at `events.ts:100`). Both producers (orchestrator.ts:289 and recordMode.ts:65) die in this spec — see [Why this is safe](#why-this-is-safe) #6. The deletion must happen AFTER both producers are gone (i.e. after Part A step 7); otherwise `recordMode.ts` fails to type-check in the intermediate state. Cascades to consumer removals in `useTimeline.ts:70` (`case "checkpoint_promoted":`) and `App.tsx:365-369` (event handler block) — see those rows below. |
| `src/renderer/components/checkpoints/RecBadge.tsx` | DELETE entire file. |
| `src/renderer/components/layout/Topbar.tsx` | DELETE the `recordMode` `useState` + `useEffect` polling block (lines 44-58). DELETE the `<RecBadge recordMode={recordMode} />` render line (line 194). DELETE the `RecBadge` import. |
| **Part B — `attempt-*`** | |
| `src/core/checkpoints/jumpTo.ts` | Rewrite the `force: "save"` body (`jumpTo.ts:129-141`): replace branch creation + commit on `attempt-<ts>-saved` with `git add -A && git commit -q -m "dex: pre-jump autosave"` on the current branch. **The new commit subject also replaces the existing `"dex: dirty-tree autosave before jumpTo"` string at the current `gitExec` call (jumpTo.ts:134) — no test asserts on the old subject (verified), but call this out so it does not look like an accidental rename in review.** Add detached-HEAD refusal: `if git symbolic-ref -q HEAD returns non-zero → return { ok: false, error: "git_error", message: "Cannot save changes while in detached-HEAD state. Switch to a branch first." }` and skip the commit entirely. Inline the check — do not extract a helper (only one call site, verified). Remove the `attemptBranchName` import (line 9). Update the `JumpToResult` decision-tree comment (lines 71-79) + `maybePruneEmptySelected` rationale comment (lines 194-201) to drop `attempt-*` references. UPDATE the file-header `Deps:` line (line 4) — drop `attemptBranchName` from the `tags.ts` import list, leaving only `selectedBranchName`. **Note on `selected-*` interaction**: when HEAD is on a `selected-*` branch, the autosave commits onto that `selected-*`. After the subsequent jump, `maybePruneEmptySelected` correctly preserves it (the new commit means the branch isn't "empty" relative to the target). No code change needed — but document this in the JSDoc so future readers don't assume autosave is always on `dex/*`. |
| `src/renderer/components/checkpoints/GoBackConfirm.tsx` | THREE edits — all of these leak the old branch model to the user: (1) REPLACE the explanatory paragraph at lines 55-58 ("Save commits these files to a new `attempt-…-saved` branch…") with: **"Save commits these changes to the current version so you can keep working with them later."** (2) UPDATE the **button label** at line 28 from `Save on a new branch` to **`Save`**. (3) UPDATE the JSDoc at line 12 from "Save (stash uncommitted changes on a new branch)" to "Save (commit dirty changes onto the current branch before jumping)". No "branch" in user-visible text anywhere. |
| `scripts/prune-example-branches.sh` | DELETE the `attempt-*` glob; keep the `dex/*` glob. |
| **Shared (touched by both Part A and Part B)** | |
| `src/core/checkpoints/tags.ts` | Part A: DELETE `checkpointDoneTag()` + `captureBranchName()` factories. Part B: DELETE `attemptBranchName()` factory. |
| `src/core/checkpoints/timeline.ts` | Part A: DELETE the `checkpoint/done-*` reading branch (lines 135-150 of the current `listTimeline`); DELETE `captureBranches: string[]` from `TimelineSnapshot`; DELETE the `git branch --list 'capture/*'` query block (lines 221-225 — `git branch --list` exec on 221, push loop on 222-225); UPDATE the `visibleBranches`-comment that mentions `capture/*` is excluded. Part B: DELETE `AttemptInfo` type (lines 25-33); DELETE `attempts`/`currentAttempt` fields on `TimelineSnapshot` (lines 101-102); DELETE the `git branch --list 'attempt-*'` query block (lines 185-219); DELETE the `attempt-*` entry in `canonicalPriority` (line 94); DELETE the `attempt-*` line in the `visibleBranches` filter (line 303); DELETE the variant-letter regex (line 190); DELETE `attempts` initialisation + sort calls (line 118, 217-218, 443); DELETE `currentAttempt` declaration + assignment (line 121, 218). UPDATE the narrative JSDoc on `canonicalPriority` (lines 84-90) and on `TimelineCommit.branch` (lines 56-60) — both narrate "main → dex/* → attempt-* → selected-*"; collapse to "main → dex/* → selected-*". UPDATE the file-header `What:` doc (line 2) — drop "attempts" and "capture branches" from the description of what `listTimeline` returns. |
| `src/core/checkpoints/index.ts` | TWO surfaces to clean up — flat re-exports AND the `checkpoints` namespace object. **Flat re-exports** (lines 9-48): Part A — DELETE `checkpointDoneTag`, `captureBranchName` from the `tags.js` re-export block; DELETE the entire `recordMode.js` re-export block (lines 22-27) and replace with `export { syncStateFromHead } from "./syncState.js";`. Part B — DELETE `attemptBranchName` from `tags.js` re-export; DELETE `AttemptInfo` from the `timeline.js` re-export (lines 35-43). **Namespace object** (lines 52-110): Part A — DELETE the `recordMode.js` import block (lines 61-66) and replace with `import { syncStateFromHead } from "./syncState.js";`; DELETE the namespace fields `doneTag`, `captureBranchName`, `promote`, `readRecordMode`, `autoPromoteIfRecordMode` (and the "Promotion + record mode" section comment on line 98). Part B — DELETE `attemptBranchName` from the `tags.js` import (line 56) and from the namespace object (line 93). |
| `src/main/ipc/checkpoints.ts` | Part A: UPDATE the `syncStateFromHead` import (line 10) to come through `checkpoints/index.ts` (which re-exports it from the new `syncState.ts`) — keeping a single import surface from this module. DELETE `captureBranches: []` (line 83) from the `listTimeline` error-fallback object. Part B: in the SAME error-fallback object, DELETE `attempts: []` (line 79) and `currentAttempt: null` (line 80) — the `TimelineSnapshot` type loses these fields, so the fallback stops type-checking otherwise. |
| `src/renderer/components/checkpoints/hooks/useTimeline.ts` | Part A: DELETE `captureBranches: []` from the initial-snapshot state object (line 14 of the `EMPTY` constant). DELETE the `case "checkpoint_promoted":` refresh trigger at line 70 — after the `events.ts` discriminant deletion this case becomes a TS error. Part B: DELETE `attempts: []` / `currentAttempt: null` from the same `EMPTY` constant (lines 10-11). Drop downstream consumers if any. |
| `src/renderer/electron.d.ts` | Part A: DELETE `captureBranches` from the `TimelineSnapshot` type definition; DELETE `recordMode` from any `UiState`-shaped type. The `syncStateFromHead` typing on line 33 stays (only its import path may change). Part B: DELETE typings for the removed `attempts`/`currentAttempt` snapshot fields. |
| `src/renderer/services/checkpointService.ts` | UPDATE the file-header `What:` doc string — drop any "Record mode" mention. The exposed methods are unchanged. |
| `src/renderer/App.tsx` | TWO unrelated edits. **(1) Event-handler removal (Part A)**: DELETE the `checkpoint_promoted` event-handler block at lines 365-369 (currently updates `checkpointDebug.lastPromotedAt` or similar DEBUG-badge state). After the `events.ts` discriminant deletion this becomes a TS error. **(2) Misleading field name**: the `step_candidate.attemptBranch` field (still emitted by `finalize.ts`) becomes misleading — its value is always `dex/*` or `selected-*`, never `attempt-*`. Threaded through App.tsx as `currentAttemptBranch` (lines 36, 68, 347, 350, 361, 397, 414) and into the **DEBUG badge payload** (line 68 — surfaces in user-shareable diagnostic copy). **Decision**: do NOT rename in this spec — it would balloon the diff into the orchestrator event union, finalize.ts emit, runs.ts patches, and the renderer state machine. Keep the name; add a one-line comment at `App.tsx:36`: `// TODO(post-013): rename to currentRunBranch — value is the current run branch (dex/* or selected-*), never attempt-*. Deferred per 013-cleanup-2.` so the deferred rename is grep-discoverable. A dedicated rename spec can land independently if it ever matters. |
| **Tests** | |
| `src/core/__tests__/recordMode.test.ts` (or `recordMode_*.test.ts`) | DELETE if any exist (any test that asserts `autoPromoteIfRecordMode` / `readRecordMode` / `promoteToCheckpoint` behaviour). |
| `src/core/__tests__/finalize.test.ts` | Lines 77 and 99 reference `autoPromoteIfRecordMode` behaviour — DELETE those assertions/setup. The rest of the file (the non-record-mode finalize coverage) stays. |
| `src/renderer/services/__tests__/checkpointService.test.ts` | The `EMPTY` fixture at line 52 includes `captureBranches: []` — DELETE that line. Also DELETE `attempts: []` and `currentAttempt: null` from the same fixture (Part B). The `syncStateFromHead` test at lines 69-77 stays (the service method survives the relocation, only its import path changes). |
| `src/core/__tests__/timelineLayout.test.ts` | The `EMPTY` fixture at line 38 includes the removed snapshot fields — DELETE `attempts: []`, `currentAttempt: null`, `captureBranches: []` so the fixture matches the new `TimelineSnapshot` shape. |
| `src/core/__tests__/jumpTo.test.ts:218` — *"jumpTo: 008 attempt-<ts> branch is NEVER auto-pruned (only selected-* navigation forks are)"* | DELETE entirely. With no `attempt-*` producer left, the behaviour under test is meaningless. |
| `src/core/__tests__/jumpTo.test.ts:239` — *"jumpTo: attempt-<ts>-saved is NEVER auto-pruned (autosave is meaningful)"* | DELETE entirely. REPLACE with a new test asserting the post-013 contract: dirty-tree + `force: "save"` → exactly one new commit on the current branch (subject `dex: pre-jump autosave`), zero new branches (`git branch --list` count unchanged), HEAD then moves to the click target. |
| `src/core/__tests__/jumpTo.test.ts:280` — block referencing `attempt-*-saved` | DELETE; folded into the new assertion above. |
| `src/core/__tests__/jumpTo.test.ts` — add a new test for **detached-HEAD save refusal**: `git checkout <sha>` → modify a tracked file → `jumpTo(target, { force: "save" })` → assert `{ ok: false, error: "git_error", message: <friendly> }` and zero new commits. |
| `src/core/__tests__/checkpoints.test.ts:98-99` — `attemptBranchName` factory tests | DELETE (factory deleted). |
| `src/core/__tests__/checkpoints.test.ts:104` — `captureBranchName` factory test | DELETE (factory deleted). |
| `src/core/__tests__/checkpoints.test.ts:311` — uses `attempt-test-a` as fixture for unrelated behaviour | RETARGET the fixture branch name to `dex/test-a` (or `selected-test-a` if the test exercises the selected-* path) so the surrounding assertion still runs. |
| Tests asserting `captureBranches`, `checkpoint/done-*` reading, `RecBadge` rendering, `recordMode` state field, or `attempts: AttemptInfo[]` shape | DELETE / UPDATE per case. |

≈ 22 files touched in `src/` (incl. 3 test fixtures) + 1 script, 2 deleted (`recordMode.ts`, `RecBadge.tsx`), 2 new (`syncState.ts`, this spec doc), plus the symbol-level deletions above and the documentation punch list in [Out of scope / follow-ups](#out-of-scope--follow-ups).

## Implementation order

1. **Spec doc** — already in place at `docs/my-specs/013-cleanup-2/README.md`.
2. **Pre-flight grep** — re-run the [Why this is safe](#why-this-is-safe) greps and these companion checks; if anything beyond what's listed in the file map appears, update the spec before proceeding:
   ```
   grep -rn "promoteToCheckpoint" src/ | grep -v test
   grep -rn "autoPromoteIfRecordMode" src/ | grep -v test
   grep -rn "checkpointDoneTag" src/ | grep -v test
   grep -rn "captureBranchName\|captureBranches\|capture/" src/ | grep -v test
   grep -rn "recordMode\|DEX_RECORD_MODE\|RecBadge" src/ | grep -v test
   grep -rn "checkpoint_promoted" src/ | grep -v test
   grep -rn "attemptBranchName\|AttemptInfo\|attempt-" src/ | grep -v test
   # User-visible copy leaks: catches the GoBackConfirm strings + any docstring
   # repeating them. Should return zero hits in renderer/ after Part B step 8.
   grep -rn "stash uncommitted changes on a new branch\|attempt-…-saved\|Save on a new branch" src/
   ```

### Part A — Record mode

3. **Relocate `syncStateFromHead`** — create `src/core/checkpoints/syncState.ts` with the function moved verbatim (signature, body, deps). Update `src/core/checkpoints/index.ts` to re-export from the new path. `npx tsc --noEmit` + `npm test` green before moving on.
4. **Delete the producer side** — the Record-mode termination block in `orchestrator.ts:280-299`, the `autoPromoteIfRecordMode` call in `finalize.ts:99`. Remove the now-unused imports. Build + tests.
5. **Delete the consumer side** — the `checkpoint/done-*` reading branch in `timeline.ts:135-150`, the `git branch --list 'capture/*'` block in `timeline.ts:221-225`, the `captureBranches` field on `TimelineSnapshot`, downstream renderer/IPC/electron.d.ts updates. Build + tests.
6. **Delete the UI** — `RecBadge.tsx`, the `Topbar.tsx` polling block, the `RecBadge` import. Build.
7. **Delete the now-dead module** — `recordMode.ts` (which is the SECOND `checkpoint_promoted` producer, not just a holder of dead helpers), the `checkpointDoneTag` + `captureBranchName` factories, the `recordMode` field in `DexUiPrefs` (`state.ts:25`). Update `index.ts` BOTH surfaces — the flat re-exports AND the `checkpoints` namespace object (drop `doneTag`, `captureBranchName`, `promote`, `readRecordMode`, `autoPromoteIfRecordMode` fields). Build + tests.
7b. **Now both `checkpoint_promoted` producers are gone** — DELETE the discriminant from `src/core/events.ts:100`, the `case "checkpoint_promoted":` from `useTimeline.ts:70`, and the event-handler block from `App.tsx:365-369`. Doing this earlier (e.g. before step 7) breaks `recordMode.ts` type-checking; doing it later leaves a dead type. Build + tests must be green before step 8.

### Part B — `attempt-*`

8. **Rewrite the dirty-tree-save body** in `jumpTo.ts:129-141` to commit on the current branch instead of creating `attempt-<ts>-saved`. Add detached-HEAD refusal. Remove the `attemptBranchName` import. Update doc comments + the `Deps:` line. Update the `<GoBackConfirm>` component — all three sites: paragraph text, button label (`Save on a new branch` → `Save`), JSDoc. Verify the save flow manually (modify a tracked file, click a different timeline node, pick "Save", confirm an extra commit appeared on the current branch and HEAD jumped). Also verify the on-`selected-*` variant per DoD #13.
9. **Delete `attemptBranchName()` factory** in `tags.ts`.
10. **Delete `AttemptInfo` + `attempts`/`currentAttempt` fields** + the `git branch --list 'attempt-*'` query block + `canonicalPriority` `attempt-*` line + `visibleBranches` filter line + variant-letter regex in `timeline.ts`. Build.
11. **Update consumers** — `useTimeline.ts`, `electron.d.ts`, `prune-example-branches.sh`, `src/main/ipc/checkpoints.ts` error-fallback (drop `attempts: []` and `currentAttempt: null` alongside `captureBranches: []`). Drop re-exports AND namespace fields from `checkpoints/index.ts` (Part B side). Add the legacy-name comment on `App.tsx:36` (`currentAttemptBranch`). Update existing tests per the named entries in the file map; add the new "autosave on current branch", "detached-HEAD refusal", and "save on `selected-*`" assertions. Build + tests.

### Final

12. **Final sweep** — `grep -rn "recordMode\|DEX_RECORD_MODE\|RecBadge\|capture/\|captureBranch\|checkpointDoneTag\|autoPromoteIfRecordMode\|promoteToCheckpoint\|readRecordMode\|checkpoint/done-\|attemptBranchName\|AttemptInfo\|attempt-" src/` returns nothing in non-test code. Run the same sweep against `scripts/` — only `reset-example-to.sh`'s deliberate `attempt-${STAMP}` line should match (carve-out per [Keep untouched](#keep-untouched)). Sweep `CLAUDE.md`, `.claude/rules/06-testing.md`, and `docs/my-specs/01X-state-reconciliation/README.md` per the documentation punch list in [Out of scope / follow-ups](#out-of-scope--follow-ups). Verify build + tests + lint.
13. **End-to-end verification** — see DoD.

## Verification (DoD)

1. **Pre-flight grep clean** — the final sweep at step 12 returns no live references.
2. **Type/build** — `npx tsc --noEmit` passes; `npm test` passes; `npm run lint` passes.
3. **Resume flow still works** — the relocated `syncStateFromHead` is exercised on resume. Reset the example project to a checkpointable state (`./scripts/reset-example-to.sh <some after-tasks checkpoint>`), open it, click **Resume**. Confirm the run resumes from the next stage.
4. **No `capture/*` after a run** — `./scripts/reset-example-to.sh clean` and complete one autonomous loop end-to-end. Confirm `git branch --list 'capture/*'` is empty.
5. **No `checkpoint/done-*` after a run** — same run. Confirm `git tag --list 'checkpoint/done-*'` is empty.
6. **No auto-promoted `checkpoint/<step>:<cycle>` tags during a run** — same run. Confirm `git tag --list 'checkpoint/*'` is empty (no auto-promotion). The step commits exist as commits with `[checkpoint:<step>:<cycle>]` in their subject (`git log --grep '^\[checkpoint:'` finds them) but no tags point at them. The timeline UI shows these as **pending candidates** (the existing `pending` mechanism), not as red-ringed canonical checkpoints.
7. **Promote script still works** — actual signature: `./scripts/promote-checkpoint.sh <project-dir> <checkpoint-name> [<sha>]`. Concrete check: `./scripts/promote-checkpoint.sh /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce manual-013-test` creates `checkpoint/manual-013-test` at HEAD. Confirm with `git -C /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce tag --list 'checkpoint/manual-013-test'`; then `./scripts/reset-example-to.sh manual-013-test` resets to it. Validates the manual-promote path is intact post-cleanup. Clean up after with `git -C /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce tag -d checkpoint/manual-013-test`.
8. **No REC badge in UI** — open the example project; confirm via MCP `take_snapshot` that no element with `RecBadge` testid (or any "REC" text in the topbar) is rendered, including under conditions that previously triggered it (`DEX_RECORD_MODE=1` env var, hand-edited `state.json.ui.recordMode = true`).
9. **`DEX_RECORD_MODE=1` is a no-op** — set the env var, launch Electron, run a loop. Confirm none of the removed behaviours fires (no `capture/*` branch, no `checkpoint/done-*` tag, no auto-promote, no badge). The env var is now ignored.
10. **No `attempt-*` after a run** — same `./scripts/reset-example-to.sh clean` + autonomous loop. Confirm `git branch --list 'attempt-*'` is empty.
11. **Autosave on current branch** — open the example project, modify a tracked file, click a different timeline node, pick "Save" in the dirty-tree dialog. Confirm:
    - **No new branch** was created (`git branch --list` shows the same set as before the click).
    - The current branch has one extra commit (`dex: pre-jump autosave`) containing the dirty change.
    - HEAD then moved to the click target as expected.
    - The `<GoBackConfirm>` dialog body uses the new copy ("Save commits these changes to the current version…") with no leaky branch names.
12. **Detached-HEAD save refusal** — manually `git checkout <some sha>` to detach HEAD, modify a tracked file, click a different timeline node, pick "Save". Confirm a friendly refusal appears and no commit was created.
13. **Save while on `selected-*`** — start on a `selected-*` branch (jump to a mid-branch ancestor to fork one), modify a tracked file, click a different timeline node, pick "Save". Confirm: the autosave commits onto the `selected-*` branch (not main, not dex/*), HEAD then jumps to target, and the original `selected-*` survives the post-jump auto-prune (because it now has a commit the new branch doesn't). The autosave is therefore reachable from the timeline's `selected-*` lane and can be revisited via click-to-jump.
14. **Visual check** — MCP screenshots before and after: topbar (badge slot gone or collapsed cleanly), timeline (no `attempt-*` / `capture/*` lanes anywhere).

## Out of scope / follow-ups

- **Re-introducing record mode in a different form** — if the auto-promote-during-run behaviour turns out to be useful, a future spec can resurrect it as an explicit per-run toggle in the run-config UI (not a hidden state-file flag). Not in v1.
- **Removing the `pending: PendingCandidate[]` mechanism** — pending candidates are still visible in the timeline (as un-tagged step commits with the `[checkpoint:...]` subject convention). Some downstream consumers may rely on this; this spec does not touch it.
- **Removing `commitCheckpoint`'s `[checkpoint:<step>:<cycle>]` subject convention** — the convention is now the *only* mechanism by which the timeline identifies stage boundaries. Must stay.
- **Migrating existing user state files** — projects that have `state.json.ui.recordMode: true` set today (developer-only) will silently ignore the field after the cleanup. No migration needed; the field is unread, no error is thrown.
- **Pre-existing git-ref leftovers** — users with leftover `capture/<date>-<id>` branches, `checkpoint/done-<id>` tags, or `attempt-<ts>[-<letter>]` branches from prior Record-mode / variant runs will see those refs lingering in their repo (the running app no longer produces or cleans them, and `prune-example-branches.sh` only ever runs against `dex-ecommerce`). Defensible — these are git refs, not corruption — but explicitly out of scope. A user who wants a clean repo can `git branch -D` / `git tag -d` them by hand. No automated first-launch cleanup.
- **`scripts/reset-example-to.sh` cleanup-of-checkpoint-tags-on-reset** — unaffected. The script wipes attempt branches, not tags. After this spec lands the `attempt-*` cleanup in that script becomes a no-op (no branches will match) but doesn't error.
- **Documentation updates** — concrete punch list of files with live `attempt-*` / `recordMode` / `capture/*` / RecBadge references that must be cleaned up in the same PR (small text-only edits, but enumerating them prevents stragglers):
  - `CLAUDE.md` `## On-Disk Layout` block (around lines 79-80 — references `worktrees/` and historical structure); sweep the whole file for `attempt-*` / `capture/*` / `recordMode` mentions.
  - `.claude/rules/06-testing.md:48` — narrative says reset-example-to.sh "creates a fresh `attempt-<ts>` branch". Still true *for the fixture*; clarify "fixture-only".
  - `.claude/rules/06-testing.md:75` — branch hygiene paragraph says "go-backs and variants leave behind `attempt-*` branches". False post-013 — rewrite to say only the fixture script produces them; the 30-day rule applies only to the fixture project.
  - `docs/my-specs/01X-state-reconciliation/README.md:110` — table cites `attempt-*` branches as part of the History layer; annotate as pre-013 or update.
  - Older specs (`008-interactive-checkpoint`, `010-interactive-timeline`) — these document the original `attempt-*` / Record mode design. **Do NOT rewrite** — historical specs are immutable. Add a one-line "Superseded in 013-cleanup-2" banner at the top.
- **`step_candidate.attemptBranch` field rename** — see the `App.tsx` row in the file map. Field name is now misleading but renaming would touch the orchestrator event union, finalize.ts emit, runs.ts patches, App.tsx state, and the DEBUG badge surface. Out of scope; deferred to a dedicated rename spec if it ever matters. **One semantic change worth noting**: `finalize.ts:74-95` populates the field via `getCurrentBranch()` with a silent fallback to `""` on detached HEAD. Pre-013, the empty string was effectively unreachable (the orchestrator always landed on `attempt-*` or `dex/*`). Post-013, the empty case is legitimate — e.g. a future feature that runs finalize while inspecting a checkpoint via detached HEAD. No code change needed; downstream consumers already tolerate the empty string.
- **`014-branch-management`** — the user-facing delete + promote-to-main + AI conflict resolver feature lands on top of this clean slate. Independent spec; depends on this one.
