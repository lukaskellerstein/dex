# Feature Specification: Branch Namespace + Record-mode Cleanup

**Feature Branch**: `013-cleanup-2`
**Created**: 2026-05-02
**Status**: Draft
**Input**: User description: "Branch namespace and Record-mode cleanup — remove `recordMode` flag, `capture/*` branch family, `checkpoint/done-*` tag family, RecBadge UI, auto-promote-during-run behaviour, and the `attempt-*` branch family. Rewrite the dirty-tree-save flow to commit on the current branch instead of creating an `attempt-<ts>-saved` side branch. Relocate `syncStateFromHead` to its own module. Source: `docs/my-specs/013-cleanup-2/README.md`."

## Overview

Two pieces of vestigial machinery in the timeline / checkpoints layer carry maintenance cost without user-visible benefit:

1. **Record mode** — a developer-only `recordMode` runtime flag (only reachable via `DEX_RECORD_MODE=1` or hand-edited `state.json`) that, when on, auto-promotes step commits to canonical `checkpoint/<step>:<cycle>` tags during a run, mints a `capture/<date>-<runId>` branch on termination, and surfaces a "REC" badge in the topbar. Unreachable from the UI.
2. **`attempt-*` branch family** — variant slots and Try-Again were retired in 008/012; the only remaining producer is the dirty-tree-save flow inside `jumpTo`, which creates an `attempt-<ts>-saved` side branch when the user clicks **Save** in the Go-Back confirm dialog. Replacing this with a normal commit on the current branch removes the entire family from the running app.

Both touch the same files (`timeline.ts`, `tags.ts`, `checkpoints/index.ts`, `useTimeline.ts`, `electron.d.ts`, `prune-example-branches.sh`) and converge on the same end-state: **the timeline runs on a single two-family branch namespace — `dex/*` plus `selected-*`**. Bundling them means each shared file is touched once, and the next spec (`014-branch-management`) lands on a clean slate.

This is a **no-op behavioural change for end-users in normal flows** — Record mode was never reachable from the UI, and `attempt-*` only surfaced in the dirty-tree-save fork, where the new flow is strictly easier to reason about (one commit on the current branch instead of a side-branched commit). The single user-visible UX change is in the **Go-Back confirm dialog**: the **Save** button no longer says "Save on a new branch", and the body copy stops referencing branch names.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Save dirty changes when navigating the timeline (Priority: P1)

A user is in the middle of editing tracked files. They click a different node on the timeline to jump to an earlier checkpoint. The Go-Back confirm dialog appears, asking what to do with the uncommitted edits. The user picks **Save** and expects their changes to be preserved somewhere reachable, with no surprise about *where* — and then the timeline jumps to the clicked target.

**Why this priority**: This is the only end-user-visible behavioural change in the cleanup. Today the Save path creates a hidden `attempt-<ts>-saved` side branch and exposes that branch name in dialog copy ("Save commits these files to a new `attempt-…-saved` branch"). After cleanup, Save produces a normal commit on whatever branch HEAD is currently on, and the dialog copy stops leaking branch names. Anyone who used Save during the `attempt-*` era now sees a simpler model.

**Independent Test**: Open the example project, modify a tracked file, click a different timeline node, pick **Save** in the dialog. Verify (a) no new branch was created, (b) the current branch has exactly one new commit with subject `dex: pre-jump autosave` containing the dirty change, (c) HEAD then moved to the click target, (d) the dialog copy uses the new wording and references no branch name. This story can be exercised end-to-end without any of the Record-mode or `capture/*` work landing.

**Acceptance Scenarios**:

1. **Given** the user is on a `dex/*` branch with a dirty working tree, **When** they click a different timeline node and pick **Save** in the confirm dialog, **Then** a single new commit (subject `dex: pre-jump autosave`) is created on the current `dex/*` branch, no new branch is created, and HEAD moves to the click target.
2. **Given** the user is on a `selected-*` branch with a dirty working tree, **When** they click a different timeline node and pick **Save**, **Then** the autosave commit lands on the same `selected-*` branch (not on `main`, not on `dex/*`), and the post-jump auto-prune of empty `selected-*` branches preserves it (the new commit makes the branch non-empty).
3. **Given** the user is on a detached HEAD with a dirty working tree, **When** they click a different timeline node and pick **Save**, **Then** the system refuses with a friendly explanation, no commit is created, and the timeline does not jump.
4. **Given** the user opens the Go-Back confirm dialog, **When** they read the body and the Save button, **Then** they see no reference to "branch", "attempt-", or "new branch" — only "Save" on the button and "Save commits these changes to the current version so you can keep working with them later." in the body.

---

### User Story 2 — Run an autonomous loop and inspect the resulting git state (Priority: P2)

A user (typically a contributor or someone debugging the loop) resets the example project, runs one autonomous loop end-to-end, and inspects the git state afterwards. They expect a small, predictable namespace: one `dex/<date>-<id>` run branch, the `main` branch, and `[checkpoint:<step>:<cycle>]` step commits along the run branch — and **nothing else** the running app produced.

**Why this priority**: Confirms the cleanup actually deletes the producers — not just hides them. Anyone debugging timeline-related issues, or auditing the repo state of a project Dex has touched, benefits from a smaller surface to reason about.

**Independent Test**: `./scripts/reset-example-to.sh clean`; complete one autonomous loop; run a small set of git queries against the example project repo to confirm the absence of `capture/*`, `checkpoint/done-*`, `attempt-*`, and any auto-created `checkpoint/*` tags.

**Acceptance Scenarios**:

1. **Given** a clean reset of the example project, **When** an autonomous loop runs to completion, **Then** `git branch --list 'capture/*'` returns empty.
2. **Given** the same run, **When** queried, **Then** `git tag --list 'checkpoint/done-*'` returns empty.
3. **Given** the same run, **When** queried, **Then** `git tag --list 'checkpoint/*'` returns empty (no auto-promoted canonical tags), but `git log --grep='^\[checkpoint:'` still finds the per-step commits — they exist as **pending candidates** in the timeline, not as red-ringed canonical checkpoints.
4. **Given** the same run, **When** queried, **Then** `git branch --list 'attempt-*'` returns empty (the user's project — the example project's reset script intentionally still mints fixture-only `attempt-*` branches; that carve-out is unaffected).

---

### User Story 3 — Resume a partially completed run (Priority: P2)

A user resets the example project to a checkpoint that landed mid-run (any `checkpoint/cycle-N-after-<step>` from the existing tree), opens it in Dex, and clicks **Resume**. They expect Dex to reconcile its filesystem state from the HEAD step-commit subject and pick up at the next stage — exactly as it does today.

**Why this priority**: The `syncStateFromHead` function performs this reconciliation. The cleanup relocates it from `recordMode.ts` (where it lived for historical reasons) into a new `syncState.ts` module, but its signature, body, and dependencies are unchanged. This story is a regression check — the cleanup must not break the resume flow.

**Independent Test**: Reset to any `checkpoint/cycle-N-after-tasks` checkpoint; open in Dex; verify the welcome submit reads **Open Existing**; on the Loop page click **Resume**; verify the orchestrator skips `prerequisites`, reuses the existing `runId`, and resumes from the next stage after `state.lastCompletedStage`.

**Acceptance Scenarios**:

1. **Given** the example project is reset to a checkpoint mid-run, **When** the user clicks **Resume**, **Then** Dex resumes from the stage immediately following the checkpoint's stage, without re-running `prerequisites`.
2. **Given** the same scenario, **When** the run progresses, **Then** the `~/.dex/logs/<project>/<runId>/run.log` records the resumed `runId` matching the pre-existing one (not a new one).

---

### User Story 4 — Inspect the topbar and timeline UI (Priority: P3)

Any user looking at the running app expects the topbar to be free of vestigial badges and the timeline to be free of vestigial lanes. After this cleanup, the **REC** badge is gone permanently (including under the conditions that previously triggered it: `DEX_RECORD_MODE=1` env var and a hand-edited `state.json.ui.recordMode=true`), and the timeline never renders an `attempt-*` or `capture/*` lane regardless of repo state.

**Why this priority**: Aesthetic / clarity-of-mental-model. Not gating any user task, but cuts confusion for anyone who happened to discover Record mode during the dev-only era.

**Independent Test**: Open the example project under each of the three Record-mode-trigger conditions (default, `DEX_RECORD_MODE=1`, hand-edited state). In all three, MCP `take_snapshot` of the topbar finds no element with a `RecBadge` testid and no "REC" text. Inspect the timeline view; no `attempt-*` or `capture/*` lane is rendered even if such refs exist in the underlying repo (the queries that would have surfaced them are removed entirely).

**Acceptance Scenarios**:

1. **Given** Dex is launched with `DEX_RECORD_MODE=1`, **When** the user opens any project, **Then** no REC badge is rendered in the topbar and the env var has no other observable effect.
2. **Given** a project's `state.json` was hand-edited to set `ui.recordMode = true`, **When** the user opens that project, **Then** no REC badge is rendered and the field is silently ignored.
3. **Given** a repo contains pre-existing `capture/<date>-<id>` branches or `attempt-<ts>` branches from a prior Record-mode / variant run, **When** the timeline renders, **Then** those refs are not surfaced as lanes — they linger in the repo (no auto-cleanup) but are invisible in the UI.

---

### Edge Cases

- **Detached HEAD + dirty tree + Save**: The autosave commit on the "current branch" is undefined; the system must refuse with a friendly message and create no commit. Covered by US1 acceptance #3 and the new `jumpTo.test.ts` assertion.
- **Save while on `selected-*`**: The autosave must commit onto the `selected-*` branch (not `main`, not `dex/*`). The post-jump auto-prune of empty `selected-*` branches must correctly preserve it because the new commit makes the branch non-empty relative to the target. Covered by US1 acceptance #2.
- **Pre-existing `attempt-*` / `capture/*` / `checkpoint/done-*` refs**: Users with leftover refs from prior runs see them lingering — the running app no longer produces or cleans them. Out of scope (no automated migration).
- **`DEX_RECORD_MODE=1` after the cleanup**: Silently ignored — the env var read site is removed.
- **`state.json.ui.recordMode = true` after the cleanup**: Silently ignored — the field is unread, no error thrown. No migration tooling.
- **`step_candidate.attemptBranch` event field**: The orchestrator-event field name remains `attemptBranch`, but its value will always be `dex/*`, `selected-*`, or empty (detached HEAD on a future feature). Renaming is deferred to a future spec; a `TODO(post-013)` comment marks the deferred rename in `App.tsx`.
- **`finalize.ts` running on detached HEAD**: Pre-cleanup, `getCurrentBranch()` always returned `attempt-*` or `dex/*` — the empty-string fallback was unreachable. Post-cleanup, the empty case becomes legitimate (e.g. a future feature inspecting a checkpoint via detached HEAD); downstream consumers already tolerate the empty string. No code change needed.
- **`promote-checkpoint.sh` and `reset-example-to.sh`**: Both keep working unchanged — they read/write `checkpoint/*` tags and `attempt-*` branches directly against the example project repo, independent of the deleted machinery. The fixture-only `attempt-*` minting in `reset-example-to.sh:53` is a deliberate carve-out.
- **`prune-example-branches.sh` after the cleanup**: The `attempt-*` glob is deleted (the running app stops producing `attempt-*` so the glob would never match anyway, except for fixture remnants). The `dex/*` glob stays. After the change, fixture-created `attempt-*` branches in the example project linger until manually deleted — acceptable for a test fixture.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001 — Dirty-tree-save commits on current branch.** When the user picks **Save** in the Go-Back confirm dialog with uncommitted changes in the working tree, the system MUST stage all tracked changes and create exactly one commit on the currently checked-out branch with subject `dex: pre-jump autosave`. The system MUST NOT create any new branch in this flow.
- **FR-002 — Detached-HEAD save refusal.** When the user picks **Save** while HEAD is detached, the system MUST refuse to autosave with a friendly explanation, MUST NOT create any commit, and MUST NOT proceed with the timeline jump.
- **FR-003 — Go-Back confirm dialog copy is branch-free.** The Go-Back confirm dialog body and the Save button label MUST NOT reference "branch", "attempt-", "new branch", or any internal git-ref name. The Save button label is **Save**; the body uses the wording "Save commits these changes to the current version so you can keep working with them later."
- **FR-004 — `selected-*` autosave preservation.** When the user is on a `selected-*` branch and triggers an autosave, the post-jump auto-prune mechanism MUST NOT delete that `selected-*` branch (it is non-empty relative to the jump target because of the new commit).
- **FR-005 — No `capture/*` branches produced.** The running app MUST NOT create any `capture/<date>-<runId>` branches under any condition (env var, state-file flag, command). Pre-existing `capture/*` refs in the repo are not affected.
- **FR-006 — No `checkpoint/done-*` tags produced.** The running app MUST NOT create any `checkpoint/done-<slice>` tags under any condition. Pre-existing tags are not affected.
- **FR-007 — No auto-promoted `checkpoint/*` tags during a run.** The running app MUST NOT auto-create canonical `checkpoint/<step>:<cycle>` or `checkpoint/cycle-<N>-after-<step>` tags during the run lifecycle. Tags of that family are still creatable out-of-band by `promote-checkpoint.sh` and by any future user-driven verb. Per-step *commits* with `[checkpoint:<step>:<cycle>]` in their subject continue to be produced — they appear in the timeline as **pending candidates** via the existing `pending: PendingCandidate[]` mechanism.
- **FR-008 — No `attempt-*` branches produced.** The running app MUST NOT create any `attempt-<ts>` or `attempt-<ts>-saved` branches under any condition. The fixture-only minting in `scripts/reset-example-to.sh` is unaffected (it only ever runs against the example project repo, never against the project Dex is opened on).
- **FR-009 — No REC badge in topbar.** The topbar MUST NOT render any "REC" badge or any element with a `RecBadge` testid, under any conditions. The badge component, its polling code, and its testid are removed entirely.
- **FR-010 — `DEX_RECORD_MODE` env var is ignored.** Setting `DEX_RECORD_MODE=1` in the environment MUST have no observable effect on the running app — no badge, no auto-promotion, no `capture/*` branch, no `checkpoint/done-*` tag.
- **FR-011 — `state.json.ui.recordMode` field is ignored.** A pre-existing `recordMode` field on the UI-prefs object MUST be silently ignored (unread, no error). No migration is performed.
- **FR-012 — Resume flow preserved.** The state-reconciliation function (`syncStateFromHead`) is relocated from `src/core/checkpoints/recordMode.ts` to `src/core/checkpoints/syncState.ts` with its signature, body, and dependencies unchanged. All existing call sites (`App.tsx`, `src/main/ipc/checkpoints.ts`, `src/main/preload-modules/checkpoints-api.ts`, `src/renderer/services/checkpointService.ts`, `src/renderer/electron.d.ts`) MUST continue to work.
- **FR-013 — `checkpoint_promoted` orchestrator-event removed.** The `checkpoint_promoted` discriminant on the orchestrator-event union is deleted. Both producers (the Record-mode termination block in `orchestrator.ts:280-299` and `autoPromoteIfRecordMode` in `recordMode.ts:65`) are deleted in the same change. Both consumers (`useTimeline.ts:70` `case` and `App.tsx:365-369` event-handler block) are deleted in the same change. The discriminant deletion MUST happen only after both producers are gone, otherwise `recordMode.ts` fails to type-check during the intermediate state.
- **FR-014 — `TimelineSnapshot` shape is reduced.** The `attempts: AttemptInfo[]`, `currentAttempt: AttemptInfo | null`, and `captureBranches: string[]` fields on `TimelineSnapshot` are deleted. Consumers in IPC error fallbacks, the `EMPTY` constant in `useTimeline.ts`, the renderer typings, and test fixtures are updated to match.
- **FR-015 — `prune-example-branches.sh` no longer prunes `attempt-*`.** The `attempt-*` glob is removed from the script (no producer remains in the running app). The `dex/*` glob is preserved. Fixture-created `attempt-*` branches in the example project linger until manually deleted.
- **FR-016 — Pre-flight grep cleanliness.** After the cleanup lands, the following greps MUST return zero hits in non-test code under `src/`:
  - `grep -rn "promoteToCheckpoint\|autoPromoteIfRecordMode\|checkpointDoneTag" src/`
  - `grep -rn "captureBranchName\|captureBranches\|capture/" src/`
  - `grep -rn "recordMode\|DEX_RECORD_MODE\|RecBadge" src/`
  - `grep -rn "checkpoint_promoted" src/`
  - `grep -rn "attemptBranchName\|AttemptInfo\|attempt-" src/`
  - `grep -rn "stash uncommitted changes on a new branch\|attempt-…-saved\|Save on a new branch" src/`

  The fixture-only `attempt-${STAMP}` line in `scripts/reset-example-to.sh` is the only allowed match in `scripts/`.

### Non-Functional Requirements

- **NFR-001 — Type-checks and tests pass at every step.** The implementation order in the README is sequenced to avoid intermediate breakage; each numbered step ends with `npx tsc --noEmit` + `npm test` green. Specifically: the `events.ts` discriminant deletion is gated on both producers being gone (step 7b in the README), and the `syncStateFromHead` relocation lands before any `recordMode.ts` deletion.
- **NFR-002 — Documentation does not lag the cleanup.** The same PR updates `CLAUDE.md` (the `## On-Disk Layout` block, plus any `attempt-*` / `capture/*` / `recordMode` mentions), `.claude/rules/06-testing.md` (lines 48 and 75 around `attempt-*` / branch hygiene), and `docs/my-specs/01X-state-reconciliation/README.md` (the History-layer table at line 110). Older specs (`008-interactive-checkpoint`, `010-interactive-timeline`) get a "Superseded in 013-cleanup-2" banner — they are not rewritten (historical specs are immutable).

### Key Entities

- **`TimelineSnapshot`** — the data structure backing the timeline view. After the cleanup it loses `attempts`, `currentAttempt`, and `captureBranches`; it keeps `commits`, `pending`, `visibleBranches`, and the rest. Consumers in IPC, renderer, and tests are updated to match.
- **Branch namespace** — running-app productions are exactly: `main` (or `master`), `dex/<date>-<id>` (one per autonomous run), and `selected-<...>` (one per timeline navigation fork). Removed: `attempt-*` (entire family), `capture/*` (entire family).
- **Tag namespace** — running-app productions are exactly: zero (no auto-promotion). Tags of the form `checkpoint/after-<step>` (cycle 0) or `checkpoint/cycle-<N>-after-<step>` (cycle ≥ 1) are still creatable out-of-band by `scripts/promote-checkpoint.sh` and by any future user-driven verb. Removed entirely from running-app production: `checkpoint/done-*` family, plus auto-creation of any `checkpoint/*` tag during a run.
- **Per-step commit-subject convention** — `[checkpoint:<step>:<cycle>]` in the commit subject. **Unchanged**; this is now the *only* mechanism by which the timeline identifies stage boundaries (via the `pending: PendingCandidate[]` mechanism).
- **`syncStateFromHead`** — the post-`jumpTo` state-reconciliation function. **Relocated** from `src/core/checkpoints/recordMode.ts` to `src/core/checkpoints/syncState.ts` with body/signature/deps unchanged. Re-exported from `checkpoints/index.ts`.
- **Go-Back confirm dialog (`<GoBackConfirm>`)** — the confirm modal that appears when the user clicks a different timeline node with a dirty working tree. After the cleanup: the **Save** button label is "Save", the body copy references "the current version" (no branch names), and the underlying flow commits on the current branch instead of creating an `attempt-<ts>-saved` side branch.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001 — Save-flow simplification visible in the dialog.** 100% of users who open the Go-Back confirm dialog see a Save button labelled "Save" (not "Save on a new branch") and dialog body copy that references no branch name. (Verified by MCP `take_snapshot` of the dialog after triggering it on a dirty tree.)
- **SC-002 — Branch namespace shrinks.** After one autonomous loop run on a freshly-reset example project, the count of branches matching `attempt-*` or `capture/*` patterns is exactly zero (excluding pre-existing leftovers from before the cleanup landed). Measured by `git branch --list 'attempt-*' 'capture/*' | wc -l`.
- **SC-003 — Tag namespace shrinks.** After one autonomous loop run on a freshly-reset example project, the count of tags matching `checkpoint/done-*` is exactly zero, and the count of any auto-created `checkpoint/*` tag is exactly zero. Measured by `git tag --list 'checkpoint/done-*' 'checkpoint/*' | wc -l`.
- **SC-004 — Resume regression-free.** A reset to any `checkpoint/cycle-N-after-<step>` checkpoint followed by a **Resume** click completes within the same time bound and produces the same next-stage transition as before the cleanup (verified by spot-check of `~/.dex/logs/<project>/<runId>/run.log` showing the same `runId` reused and the next stage entered).
- **SC-005 — No REC badge under any trigger condition.** Under three trigger conditions (default, `DEX_RECORD_MODE=1`, `state.json.ui.recordMode=true`), zero topbar elements with a `RecBadge` testid or "REC" text are rendered. Measured by MCP `take_snapshot` in each condition.
- **SC-006 — Code-surface reduction.** Two source files (`recordMode.ts`, `RecBadge.tsx`) are deleted; one new file (`syncState.ts`) is added; net file count decreases by one. Approximately 22 files in `src/` are modified, plus one script. (Lower bound for change tracking; not a hard contract.)
- **SC-007 — Tests, types, lint all green.** `npx tsc --noEmit` exits 0, `npm test` exits 0, `npm run lint` exits 0 — at the head of the merged branch and at every numbered step in the implementation order specified in the README.
- **SC-008 — Pre-flight greps return zero.** All grep patterns in FR-016 return zero hits in non-test code under `src/`. The fixture-only `attempt-${STAMP}` line in `scripts/reset-example-to.sh` is the only allowed match in `scripts/`.

## Assumptions

- **Existing repo state is not migrated.** Users with leftover `capture/*` branches, `checkpoint/done-*` tags, or `attempt-*` branches from prior runs see those refs lingering. The running app stops producing them but does not auto-clean them. A user who wants a clean repo can delete refs by hand.
- **`promoteToCheckpoint` becomes dead after the Record-mode termination block deletes.** Verified by `grep -rn "promoteToCheckpoint" src/`: the only non-export call site is `src/core/orchestrator.ts:287`, inside the `if (recordMode)` arm. Deleting that block makes the function dead and it can be removed with the rest of `recordMode.ts`.
- **`autoPromoteIfRecordMode` has exactly one caller.** Verified by `grep -rn "autoPromoteIfRecordMode" src/`: `src/core/stages/finalize.ts:99`. Removing that call deletes the only consumer.
- **`checkpointDoneTag` has exactly one caller.** Verified by `grep -rn "checkpointDoneTag" src/`: `src/core/orchestrator.ts:286`, inside the same Record-mode termination block.
- **`attemptBranchName` has exactly one live producer call site.** Verified by `grep -rn "attemptBranchName" src/`: only `jumpTo.ts:130` constructs an `attempt-<ts>-saved` branch name; everywhere else is type/export plumbing. Rewriting that one body removes the only producer.
- **`syncStateFromHead` has live consumers.** Verified by `grep -rn "syncStateFromHead" src/`: `App.tsx:289`, `src/main/ipc/checkpoints.ts:117`, `src/main/preload-modules/checkpoints-api.ts:12`, `src/renderer/services/checkpointService.ts:88`, `src/renderer/electron.d.ts:33`. It must be relocated, not deleted.
- **`checkpoint_promoted` orchestrator-event has two producers, both removed by this spec.** Producers: `src/core/orchestrator.ts:289` (deleted with the Record-mode block) and `src/core/checkpoints/recordMode.ts:65` (deleted with the file). Consumers: `useTimeline.ts:70` and `App.tsx:365-369` (both deleted). After both producers are gone the discriminant in `events.ts` and both consumer sites are removed in the same step (sequencing matters — see FR-013 / NFR-001).
- **No test asserts on the old autosave commit subject** (`"dex: dirty-tree autosave before jumpTo"`). Verified by inspection of the test files. The rename to `dex: pre-jump autosave` is mechanical with no test breakage.
- **The `step_candidate.attemptBranch` orchestrator-event field rename is out of scope.** Renaming would balloon the diff into the orchestrator event union, `finalize.ts` emit, `runs.ts` patches, App.tsx state, and the DEBUG badge surface. A `TODO(post-013)` comment at `App.tsx:36` marks the deferred rename. Field semantics: post-cleanup the value is always `dex/*`, `selected-*`, or empty (detached HEAD); downstream consumers already tolerate the empty string.
- **No new tests are required to validate Record-mode removal beyond deleting the existing ones.** Existing Record-mode tests are deleted (`src/core/__tests__/recordMode.test.ts` if any, plus the lines in `finalize.test.ts:77,99`). The new tests are limited to (a) the autosave-on-current-branch contract in `jumpTo.test.ts`, (b) the detached-HEAD refusal, and (c) the `selected-*` autosave-preservation case. The `syncStateFromHead` test in `checkpointService.test.ts:69-77` stays as-is (only its import path changes).
- **`scripts/reset-example-to.sh` keeps minting fixture-only `attempt-*` branches.** Deliberate carve-out: the script is a testing fixture entry point only ever pointed at `dex-ecommerce`, where the `attempt-*` name is internal scaffolding that never reaches the running app or the timeline. Renaming would be churn for zero user benefit.

## Dependencies

- **Predecessors**: `008-interactive-checkpoint` (introduced the `[checkpoint:...]` subject convention and the `pending: PendingCandidate[]` mechanism this spec relies on), `012-cleanup` (retired the variant slots that the `attempt-*` family also used to carry).
- **Successors**: `014-branch-management` (user-facing delete + promote-to-main + AI conflict-resolver) lands on top of this clean two-family namespace. Independent spec; explicitly depends on this one.
- **Internal**: The implementation order in the README is the dependency graph between the symbol-level deletions in this spec; it MUST be followed (in particular the `events.ts` discriminant deletion must be gated on both `checkpoint_promoted` producers being gone, see FR-013).

## Out of Scope (deferred)

- **Re-introducing record mode in a different form.** If the auto-promote-during-run behaviour turns out to be useful, a future spec can resurrect it as an explicit per-run toggle in the run-config UI (not a hidden state-file flag). Not in v1.
- **Removing the `pending: PendingCandidate[]` mechanism.** Pending candidates remain visible in the timeline (as un-tagged step commits with the `[checkpoint:...]` subject). This spec does not touch the mechanism.
- **Removing the `[checkpoint:<step>:<cycle>]` commit-subject convention.** It is now the *only* mechanism by which the timeline identifies stage boundaries — must stay.
- **Migrating existing user state files.** Projects with `state.json.ui.recordMode: true` set today (developer-only) silently ignore the field after the cleanup. No migration tooling.
- **Auto-cleaning pre-existing git-ref leftovers.** Users with leftover `capture/<date>-<id>` branches, `checkpoint/done-<id>` tags, or `attempt-<ts>` branches from prior Record-mode / variant runs see those refs lingering. Defensible (these are git refs, not corruption) but explicitly out of scope. No automated first-launch cleanup.
- **`step_candidate.attemptBranch` field rename.** See the App.tsx row in the README file map and the Assumptions section. Deferred to a dedicated rename spec if it ever matters.
- **Updates to `008-interactive-checkpoint` and `010-interactive-timeline` spec docs beyond a one-line "Superseded in 013-cleanup-2" banner.** Historical specs are immutable.
