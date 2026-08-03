# Feature Specification: Cleanup — Retire Variant-Groups Verbs and Step Candidate Prompt

**Feature Branch**: `012-cleanup`
**Created**: 2026-04-29
**Status**: Draft
**Input**: User description: see [`docs/my-specs/012-cleanup/README.md`](../../docs/my-specs/012-cleanup/README.md). Three right-click verbs on the Timeline canvas — **Keep this**, **Unmark kept**, **Try N ways from here** — and the related **Step Candidate** prompt modal are being retired. Variant-groups feature (worktrees, attempt branches, compare/resume modals) is torn out. Record Mode auto-promote, Go-Back, Jump-to-Checkpoint, and the timeline core all stay.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Cleaner Timeline canvas (Priority: P1)

A Dex user opens the Timeline tab on the Loop Dashboard and right-clicks a step-commit dot. Nothing happens — no context menu, no popover, no error. Left-click on a kept commit still jumps; the Go-Back confirmation still fires when there are dirty files; the Record-mode badge still shows. The right-click affordance is gone, and that's the intended end state.

**Why this priority**: This is the user-visible payoff. The verbs being retired (Keep / Unmark / Try N ways) duplicate behaviour Record Mode already handles automatically; their removal is the headline experience change. Anything else (engine deletions, IPC pruning) supports this outcome.

**Independent Test**: Open the Timeline tab against `dex-ecommerce` after running a stage. Right-click a commit dot — the snapshot must show no popover and the console log must be clean. Left-click jump-to-checkpoint, Go-Back confirmation, branch focus, and the Record-mode badge must continue to work.

**Acceptance Scenarios**:

1. **Given** a Dex run has produced step-commit dots on the Timeline, **When** the user right-clicks any commit node, **Then** no context menu appears and no console error is logged.
2. **Given** the user is on the Timeline view, **When** the user left-clicks a commit tagged `checkpoint/*`, **Then** Jump-to-Checkpoint runs as before (with Go-Back confirmation if the working tree is dirty).
3. **Given** Record Mode is active (`DEX_RECORD_MODE=1`), **When** a stage completes, **Then** a `checkpoint/*` tag is created automatically and the Record-mode badge is visible.

---

### User Story 2 — Step-mode pauses resume from the Loop Dashboard (Priority: P1)

A Dex user runs a stage with step-mode enabled (`ui.pauseAfterStage = true`). The orchestrator pauses; instead of seeing an in-flow `CandidatePrompt` modal, the user finds a single **Resume** button on the Loop Dashboard and clicks it. The orchestrator continues. Behind the scenes the `step_candidate` event still fires — the Timeline marker refresh works, the DEBUG badge payload still carries `candidateSha` / `lastCheckpointTag` — but the user never has to interact with a modal popup.

**Why this priority**: Removes the second-most-visible UX element being retired. The `CandidatePrompt` modal duplicates the Resume button's role and forces the user into a modal flow that the Loop Dashboard already handles non-modally. Same priority as US1 because both affect the same Timeline + run-control surface.

**Independent Test**: Set `ui.pauseAfterStage = true` in `.dex/state.json` and start a stage. The orchestrator must pause without spawning a `CandidatePrompt` modal. Click Resume on the Loop Dashboard — the orchestrator continues. After the run, click the DEBUG badge: `lastCheckpointTag` and `candidateSha` must be non-null.

**Acceptance Scenarios**:

1. **Given** step-mode is enabled, **When** a stage completes and the orchestrator pauses, **Then** the Resume button on the Loop Dashboard becomes available and no modal appears.
2. **Given** the orchestrator is paused after a stage, **When** the user clicks Resume, **Then** the next stage starts without requiring any other interaction.
3. **Given** a `step_candidate` event has fired during the run, **When** the user clicks the DEBUG badge after the run, **Then** the payload shows non-null `candidateSha` and `lastCheckpointTag`.

---

### User Story 3 — Smaller, more readable codebase (Priority: P2)

A Dex maintainer (or AI agent reading the code, per the project's refactor objective) opens `src/core/checkpoints/` and `src/renderer/components/checkpoints/`. The variant-groups feature surface is gone: no `variants.ts`, no `agent-overlay.ts`, no `TryNWaysModal`, no `VariantCompareModal`, no `ContinueVariantGroupModal`, no `AgentProfileForm`, no `CommitContextMenu`, no `CandidatePrompt`. The surviving code paths (`promoteToCheckpoint`, `autoPromoteIfRecordMode`, `jumpToCheckpoint`, `unselect`, the timeline rendering hooks) are unchanged. Type-check passes; the test suite is green.

**Why this priority**: This is the engineering payoff and prerequisite for keeping the rest of the checkpoints subsystem reasonable to maintain. Demoted to P2 because end users don't see it, but it's the largest mechanical chunk of the change.

**Independent Test**: After the cleanup, `npx tsc --noEmit` returns zero errors, `npm test` is green, and a `grep -rn` for the removed symbols (per the README's verification block) returns zero hits inside `src/`.

**Acceptance Scenarios**:

1. **Given** the cleanup has landed, **When** running `npx tsc --noEmit`, **Then** there are zero compile errors.
2. **Given** the cleanup has landed, **When** running `npm test`, **Then** all suites pass — in particular `src/core/__tests__/checkpoints.test.ts` (with the variant-related blocks removed and the `promoteToCheckpoint` block intact) and `src/renderer/services/__tests__/checkpointService.test.ts` (with the shrunk method-set assertion).
3. **Given** the cleanup has landed, **When** grepping `src/` for removed symbols, **Then** zero hits are returned for the verification regex (`VariantGroupFile`, `spawnVariants`, `CandidatePrompt`, `TryNWaysModal`, `unmarkCheckpoint`, `checkpoints:promote`, etc.).

---

### User Story 4 — Superseded specs flag themselves (Priority: P3)

A maintainer browsing `docs/my-specs/` opens `008-interactive-checkpoint/README.md` or `010-interactive-timeline/README.md`. Directly under the H1, a one-line `> **Status:** ...` banner declares that the relevant sections are superseded by `012-cleanup`, and that Record Mode auto-promote, Go-Back, and Jump-to-Checkpoint remain authoritative.

**Why this priority**: Prevents future readers from chasing ghost behaviours. Demoted to P3 because the banner is a 30-second documentation hygiene step, not a behavioural change.

**Independent Test**: Read both READMEs; the banner is present as the second non-blank line below the H1. Running `grep -l "Try N ways\|Keep this\|spawnVariants\|VariantGroupFile\|Unmark kept" docs/my-specs/` surfaces any other spec README needing the same banner; that one gets it too.

**Acceptance Scenarios**:

1. **Given** the cleanup has landed, **When** opening `docs/my-specs/008-interactive-checkpoint/README.md`, **Then** a `> **Status:** ...` banner directly under the H1 names `012-cleanup` as the supersession point.
2. **Given** the cleanup has landed, **When** opening `docs/my-specs/010-interactive-timeline/README.md`, **Then** the same banner is present in the same position.
3. **Given** the grep `grep -l "Try N ways\|Keep this\|spawnVariants\|VariantGroupFile\|Unmark kept" docs/my-specs/` lists additional READMEs (e.g. `009-testing-checkpointing`), **Then** each of those READMEs has the banner too.

---

### Edge Cases

- **Pre-existing on-disk variant-group artefacts.** Users who upgrade may have orphaned `.dex/variant-groups/<groupId>.json` files and `.dex/worktrees/<…>` directories. These are gitignored and harmless. The system MUST NOT auto-delete them on first launch — too risky on user repos. Users may `rm -rf .dex/variant-groups .dex/worktrees` themselves.
- **Pre-existing `attempt-<ts>-<letter>` branches.** Created by the deleted variant-spawn path. Already pruned by `scripts/prune-example-branches.sh` after 30 days; no surviving UI path mints new ones.
- **Pre-existing `checkpoint/*` tags created via the deleted "Keep this" verb.** These remain valid: Record Mode produces the same tag shape, and `jumpToCheckpoint` honours them unchanged.
- **`.gitignore` seed for `.dex/variant-groups/` and `.dex/worktrees/`.** Keep these entries as forward-compat for users upgrading with leftover dirs (decision noted in the seed README; the entries are harmless reservations).
- **`AgentProfile.claudeDir` residue.** This field and `agent-overlay.ts`-related fields exist *only* to support variant spawning. Once `variants.ts` and `agent-overlay.ts` are gone, `claudeDir` becomes unused. Leaving the residue is acceptable for this cleanup; a follow-up spec collapses the field. **Do not** thread the collapse into 012.
- **`WORKTREE_LOCKED` error code.** After the cleanup, no surviving call path produces a worktree-lock error (`spawnVariants` / `cleanupVariantWorktree` were the only sources). The cleanup MUST drop both the code and its `mapToCheckpointError` regex branch unless `grep -rn "WORKTREE_LOCKED\|worktree.*lock" src/` surfaces a non-variant caller.
- **`scripts/promote-checkpoint.sh`.** Continues to work — it shells out to `git tag -f` directly, doesn't touch the IPC path.
- **`step_candidate` event consumers.** Two listeners survive: `useTimeline.ts:69` (refresh trigger for timeline markers) and `App.tsx:332` (DEBUG-badge payload). The `CheckpointsEnvelope` listener is gone. The event itself keeps firing from `stages/finalize.ts:89`.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST NOT render a right-click context menu on Timeline commit nodes. The `CommitContextMenu` mount and the `onContextMenu` plumbing into `<TimelineGraph>` MUST be removed.
- **FR-002**: System MUST NOT show the `CandidatePrompt` modal in any flow. Step-mode pauses MUST resume via the existing **Resume** button on the Loop Dashboard.
- **FR-003**: System MUST preserve all current Timeline affordances unchanged: jump-to-checkpoint via left-click, drop-from-selected-path, branch focus, the Record-mode badge, the Go-Back confirmation flow, and timeline marker refresh on `step_candidate`.
- **FR-004**: System MUST preserve Record Mode auto-promotion. `promoteToCheckpoint` and `autoPromoteIfRecordMode` MUST continue to function and produce `checkpoint/*` git tags. Their unit-test coverage in `src/core/__tests__/checkpoints.test.ts` (the `promoteToCheckpoint` block at line 131) MUST remain.
- **FR-005**: System MUST keep the `step_candidate` event firing from `stages/finalize.ts`. The two surviving consumers (`useTimeline.ts` and `App.tsx`) MUST continue to function. The `variant_group_resume_needed` and `variant_group_complete` events MUST be removed from the orchestrator event union.
- **FR-006**: System MUST delete the variant-groups source files: `src/core/checkpoints/variants.ts`, `src/core/checkpoints/variantGroups.ts`, `src/core/agent-overlay.ts`, `src/core/__tests__/agentOverlay.test.ts`, `src/renderer/components/checkpoints/TryNWaysModal.tsx`, `src/renderer/components/checkpoints/VariantCompareModal.tsx`, `src/renderer/components/checkpoints/ContinueVariantGroupModal.tsx`, `src/renderer/components/checkpoints/AgentProfileForm.tsx`, `src/renderer/components/checkpoints/CommitContextMenu.tsx`, `src/renderer/components/checkpoints/CandidatePrompt.tsx`.
- **FR-007**: System MUST remove the corresponding IPC handlers from `src/main/ipc/checkpoints.ts`: `checkpoints:estimateVariantCost`, `checkpoints:readPendingVariantGroups`, `checkpoints:promote`, `checkpoints:unmark`, `checkpoints:spawnVariants`, `checkpoints:cleanupVariantGroup`, `checkpoints:compareAttempts`. The matching preload bridge methods in `src/main/preload-modules/checkpoints-api.ts` and the `dexAPI.checkpoints` shape in `src/renderer/electron.d.ts` MUST be removed in lockstep.
- **FR-008**: System MUST remove `unmarkCheckpoint` from `src/core/checkpoints/jumpTo.ts`. The barrel re-exports in `src/core/checkpoints/index.ts` MUST drop `unmarkCheckpoint`, `spawnVariants`, `cleanupVariantWorktree`, `VariantSpawnRequest`, `VariantSpawnResult`, `writeVariantGroupFile`, `readVariantGroupFile`, `deleteVariantGroupFile`, `readPendingVariantGroups`, `VariantGroupFile`, and the matching namespace-object keys (`unmark`, `spawnVariants`, `cleanupVariantWorktree`, `readVariantGroupFile`, `writeVariantGroupFile`, `deleteVariantGroupFile`, `readPendingVariantGroups`). `promoteToCheckpoint` and `autoPromoteIfRecordMode` re-exports MUST stay.
- **FR-009**: System MUST remove `emitPendingVariantGroups` from `src/core/run-lifecycle.ts` and its two call sites; variant groups can no longer be created, so resume-needed emission is dead.
- **FR-010**: System MUST remove the variant-related methods, types, error codes, and test fixture entries from the renderer service surface — `src/renderer/services/checkpointService.ts` (`estimateVariantCost`, `readPendingVariantGroups`, `promote`, `unmark`, `spawnVariants`, `cleanupVariantGroup`, `compareAttempts`, the `VariantGroupFile` / `VariantSpawnRequest` / `VariantSpawnResult` type imports, and the `VARIANT_GROUP_MISSING` error-code branch) — and from the matching test file `src/renderer/services/__tests__/checkpointService.test.ts` (block deletions, mock-fixture trimming, "exposes the documented method set" assertion update).
- **FR-011**: System MUST drop the `WORKTREE_LOCKED` error code from `CheckpointErrorCode` and its `mapToCheckpointError` branch unless a non-variant caller is surfaced by `grep -rn "WORKTREE_LOCKED\|worktree.*lock" src/`.
- **FR-012**: System MUST remove the variant-related test blocks from `src/core/__tests__/checkpoints.test.ts` (`spawnVariants: parallel stage creates worktrees`, `spawnVariants: sequential stage creates branches only`, `unmarkCheckpoint: deletes canonical step tags at sha, leaves others alone`, `unmarkCheckpoint: no canonical tags → no-op success`, `variant group file: write → read → delete round-trip`). The `promoteToCheckpoint` block MUST stay (it is the only Record-Mode unit coverage today).
- **FR-013**: System MUST gut `CheckpointsEnvelope.tsx` so that only the InitRepo + Identity prompt flow survives. State, handlers, JSX, imports, and the `readPendingVariantGroups` poll for variant-group / step-candidate handling MUST be removed.
- **FR-014**: System MUST remove right-click wiring from `TimelinePanel.tsx` (handlers, menu state, `CommitContextMenu` JSX) and `TimelineGraph.tsx` (the `onContextMenu` prop, listener, cursor styling). The `onTryNWaysAt` prop chain through `TimelinePanel` and `TimelineView` MUST be deleted in lockstep with the removed handlers and the `TryNWaysModal` mount.
- **FR-015**: System MUST NOT migrate or auto-delete pre-existing on-disk artefacts on first launch (`.dex/variant-groups/`, `.dex/worktrees/`, `attempt-<ts>-<letter>` branches, `checkpoint/*` tags from "Keep this"). Users delete these manually if they want to.
- **FR-016**: System MUST add a `> **Status:** The "Keep this", "Unmark kept", "Try N ways from here", and Step Candidate prompt sections of this spec are superseded by`012-cleanup`. Record Mode auto-promote, Go-Back, and Jump-to-Checkpoint remain authoritative.` banner directly under the H1 of `docs/my-specs/008-interactive-checkpoint/README.md` and `docs/my-specs/010-interactive-timeline/README.md`. Any other spec README returned by `grep -l "Try N ways\|Keep this\|spawnVariants\|VariantGroupFile\|Unmark kept" docs/my-specs/` MUST also receive the banner. Full prose edits are out of scope.
- **FR-017**: After the change, `npx tsc --noEmit` MUST pass with zero errors and `npm test` MUST pass with all suites green.

### Non-Goals

- No behavioural changes to Record Mode, Go-Back, Jump-to-Checkpoint, or the broader agent-profile system (`agent-profile.ts`, `profilesService`, `ipc/profiles`, `AgentRunner` profile threading).
- No collapse of `AgentProfile.claudeDir` or other variant-only `agent-profile.ts` fields. They become unused; a follow-up spec retires them.
- No prose rewrite of the superseded spec READMEs beyond the one-line banner.
- No migration logic for orphaned on-disk artefacts.
- No new functions, abstractions, or dependencies — this is deletion-only.

### Key Entities

- **Right-click Timeline context menu** *(removed)* — the `CommitContextMenu` UI affordance and its three verbs (Keep this, Unmark kept, Try N ways from here).
- **Variant group** *(removed)* — `.dex/variant-groups/<groupId>.json` file representing an in-flight set of attempt branches/worktrees spawned by "Try N ways from here".
- **Step Candidate prompt** *(removed)* — the `CandidatePrompt` modal that previously appeared after a step-mode pause.
- **Checkpoint tag** *(preserved)* — `checkpoint/<name>` git tag written by Record Mode; remains the sole canonical save-point primitive.
- **Record Mode** *(preserved)* — the auto-promote behaviour in `recordMode.ts` (`promoteToCheckpoint` + `autoPromoteIfRecordMode`).
- **Step-candidate event** *(preserved)* — `step_candidate`, fired from `stages/finalize.ts:89`. Two surviving consumers: `useTimeline.ts:69` (timeline marker refresh) and `App.tsx:332` (DEBUG-badge payload).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Right-clicking a Timeline commit node produces no UI feedback (no menu, no popover, no console error). Verified via `mcp__electron-chrome__take_snapshot` (no popover present) and `mcp__electron-chrome__list_console_messages` (no error logged) after the click.
- **SC-002**: A step-mode pause completes through the existing **Resume** button alone — the `CandidatePrompt` modal does not appear in any UI snapshot during the flow.
- **SC-003**: With `DEX_RECORD_MODE=1` enabled, running stages against `dex-ecommerce` produces `checkpoint/*` git tags (verified via `git tag --list 'checkpoint/*'`). Record-mode badge remains visible during the run.
- **SC-004**: After a run completes, the DEBUG badge payload on the Loop Dashboard shows non-null `lastCheckpointTag` and `candidateSha`, proving the surviving `step_candidate` consumer (`App.tsx:332`) is intact.
- **SC-005**: `grep -rn "VariantGroupFile\|VariantSpawnRequest\|VariantSpawnResult\|VariantSlotState\|DEFAULT_SLOT\|spawnVariants\|cleanupVariantWorktree\|cleanupVariantGroup\|estimateVariantCost\|readPendingVariantGroups\|writeVariantGroupFile\|readVariantGroupFile\|deleteVariantGroupFile\|CommitContextMenu\|CandidatePrompt\|TryNWaysModal\|VariantCompareModal\|ContinueVariantGroupModal\|AgentProfileForm\|agent-overlay\|applyOverlay\|emitPendingVariantGroups\|variant_group_resume_needed\|variant_group_complete\|unmarkCheckpoint\|compareAttempts\|VARIANT_GROUP_MISSING\|lastStageRef\|checkpoints:promote\|checkpoints:unmark\|checkpoints:spawnVariants\|checkpoints:cleanupVariantGroup\|checkpoints:readPendingVariantGroups\|checkpoints:estimateVariantCost\|checkpoints:compareAttempts" src/` returns zero hits after the change. (`WORKTREE_LOCKED` and `claudeDir` excluded — see edge cases.)
- **SC-006**: `npx tsc --noEmit` returns zero errors after each chunk (engine → IPC + preload → renderer service → renderer components → tests) and at the end. `npm test` returns zero failures at the end.
- **SC-007**: Running an autonomous loop against `dex-ecommerce` does not grow the count of `attempt-*` branches (`git -C /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce branch --list 'attempt-*' | wc -l` is the same before and after the smoke run). `capture/*` branches from Record Mode are out of scope for this count.
- **SC-008**: The two superseded spec READMEs (`008-interactive-checkpoint`, `010-interactive-timeline`) and any other README surfaced by the documentation grep have a `Status:` banner directly under their H1 referencing `012-cleanup`.

## Assumptions

- The variant-groups feature has no active users today. Removing it is a YAGNI/dead-code action, not a breaking-change deprecation, so no migration window is needed.
- `AgentProfile.claudeDir` and other variant-only fields in `agent-profile.ts` may remain as residue. A follow-up spec will collapse them once it's clear no other consumer surfaces.
- `.dex/variant-groups/` and `.dex/worktrees/` `.gitignore` entries remain as forward-compat reservations for users upgrading with leftover directories. The PR description records the keep-or-scrub choice explicitly.
- `WORKTREE_LOCKED` is dropped only if `grep -rn` confirms no non-variant call site; otherwise it stays.
- This spec is deletion-only. No new functions, types, abstractions, or dependencies are introduced. The remaining code paths (`promoteToCheckpoint`, `autoPromoteIfRecordMode`, `jumpToCheckpoint`, `unselect`, the timeline rendering hooks) are already exercised and unchanged.
- Verification is local-only (`tsc`, `vitest`, `dex-ecommerce` smoke test per `.claude/rules/06-testing.md` §4c). No CI gates or rollout strategy beyond the existing PR + merge flow.
- The 30-day branch-pruning script (`scripts/prune-example-branches.sh`) continues to handle stale `attempt-*` branches; this spec adds no extra cleanup obligation.
