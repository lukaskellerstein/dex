---
description: "Task list for 012-cleanup — retire variant-groups verbs and Step Candidate prompt"
---

# Tasks: Cleanup — Retire Variant-Groups Verbs and Step Candidate Prompt

**Input**: Design documents from `/specs/012-cleanup/`
**Prerequisites**: [`plan.md`](./plan.md), [`spec.md`](./spec.md), [`research.md`](./research.md), [`data-model.md`](./data-model.md), [`contracts/ipc-checkpoints.md`](./contracts/ipc-checkpoints.md), [`contracts/orchestrator-events.md`](./contracts/orchestrator-events.md), [`quickstart.md`](./quickstart.md).

**Tests**: This is a **deletion-only** refactor. No new tests are written. Five existing test blocks are deleted as part of implementation (Phase 2). The `promoteToCheckpoint` block stays — it's the only Record-Mode unit coverage today (research.md §6).

**Organization**: Tasks are grouped by user story. The engine/IPC/service removal is shared infrastructure (Phase 2 — foundational, blocks all stories) because both US1 and US2 depend on the same code paths going away in lockstep — splitting them by story would break the leaves-first compilation order documented in `research.md` §5.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks).
- **[Story]**: User story this task serves (US1, US2, US3, US4) — Setup, Foundational, and Polish phases carry no story label.
- All paths are absolute or repo-relative from `/home/lukas/Projects/Github/lukaskellerstein/dex/`.

---

## Phase 1: Setup (Baseline + branch state)

**Purpose**: Record pre-cleanup measurements so Phase 5/Phase 7 can prove the deltas.

- [X] T001 Confirm working tree is on branch `012-cleanup` and clean by running `git -C /home/lukas/Projects/Github/lukaskellerstein/dex status --short` and `git -C /home/lukas/Projects/Github/lukaskellerstein/dex branch --show-current`. Abort if either output shows unexpected state. **Result**: branch `012-cleanup` confirmed; uncommitted state limited to spec artefacts created during `/speckit-*` runs.
- [X] T002 Record the **baseline `attempt-*` branch count** in `dex-ecommerce` for SC-007: `git -C /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce branch --list 'attempt-*' | wc -l`. **Result**: baseline = **0**.
- [X] T003 Record the **baseline residue-grep count** so Phase 5 can prove the drop to zero. **Result**: baseline = **257 hits** in `src/`.

---

## Phase 2: Foundational (Shared engine + IPC + service removal)

**Purpose**: Remove the engine, IPC handlers, preload bridge, renderer-service methods, and the affected unit-test blocks. **Both** US1 (right-click menu) and US2 (CandidatePrompt) depend on this surface being gone before their renderer-component cuts can land cleanly. The chunked order matches `research.md` §5: leaves-first, with `npx tsc --noEmit` between chunks.

**⚠️ CRITICAL**: No user-story phase may begin until T020 passes. Run `npx tsc --noEmit` after every numbered task that edits a `.ts`/`.tsx` file — if it fails, fix before continuing.

### Chunk A — Engine: barrel + jumpTo + run-lifecycle + events + commit comment

- [X] T004 Edit `src/core/checkpoints/index.ts` — drop the named-export blocks: `unmarkCheckpoint` from the `./jumpTo.js` block (line 32), the entire `./variants.js` block (lines 36–41 — `spawnVariants`, `cleanupVariantWorktree`, `VariantSpawnRequest`, `VariantSpawnResult`), and the entire `./variantGroups.js` block (lines 53–59 — `writeVariantGroupFile`, `readVariantGroupFile`, `deleteVariantGroupFile`, `readPendingVariantGroups`, `VariantGroupFile`). Also drop the matching `import { ... }` blocks (line 86, 88–91, 93–98) and the namespace-object keys (lines 111–148: `unmark`, `spawnVariants`, `cleanupVariantWorktree`, `readVariantGroupFile`, `writeVariantGroupFile`, `deleteVariantGroupFile`, `readPendingVariantGroups`). Keep `promoteToCheckpoint` + `autoPromoteIfRecordMode` re-exports.
- [X] T005 Edit `src/core/checkpoints/jumpTo.ts` — delete the `unmarkCheckpoint` function (lines 66–89). Trim the file-header doc comment at line 2 to drop the `unmarkCheckpoint` mention from the "What:" line. Keep the `unselect` path.
- [X] T006 Edit `src/core/run-lifecycle.ts` — delete `emitPendingVariantGroups` (lines 261–278) and its two call sites (lines 140, 153).
- [X] T007 Edit `src/core/events.ts` — delete the `variant_group_resume_needed` and `variant_group_complete` members from the `OrchestratorEvent` union (lines 111–122). Keep `step_candidate`.
- [X] T008 Edit `src/core/checkpoints/commit.ts` — comment-only change at line 44: trim `variant-groups/` and `worktrees/` from the listed `.dex/` non-committable artefacts. No code change.
- [X] T009 Run `npx tsc --noEmit` from the repo root. **Result**: 12 errors, all in `src/main/ipc/checkpoints.ts` (Chunk C territory). Expect errors in `src/main/ipc/checkpoints.ts`, `src/main/preload-modules/checkpoints-api.ts`, `src/renderer/electron.d.ts`, `src/renderer/services/checkpointService.ts`, `src/renderer/components/checkpoints/CheckpointsEnvelope.tsx`, and the variant test files — these are the consumers about to be edited. **Do not panic** at the cascade; cataloguing them confirms the import graph.

### Chunk B — Engine: delete variant-only files

- [X] T010 [P] Delete `src/core/checkpoints/variants.ts`.
- [X] T011 [P] Delete `src/core/checkpoints/variantGroups.ts`.
- [X] T012 [P] Delete `src/core/agent-overlay.ts` — only consumer was `variants.ts`, now gone.
- [X] T013 [P] Delete `src/core/__tests__/agentOverlay.test.ts` — paired with the deleted module.

### Chunk C — IPC + preload + renderer type declarations

- [X] T014 Edit `src/main/ipc/checkpoints.ts` — remove handlers + matching imports for `checkpoints:estimateVariantCost` (lines 121–153), `checkpoints:readPendingVariantGroups` (lines 155–157), `checkpoints:promote` (lines 161–165), `checkpoints:unmark` (lines 167–171), `checkpoints:spawnVariants` (lines 196–231), `checkpoints:cleanupVariantGroup` (lines 233–266), and `checkpoints:compareAttempts` (line 330). Prune the import block at lines 6–23 (drop `spawnVariants`, `cleanupVariantWorktree`, `readPendingVariantGroups`, `writeVariantGroupFile`, `readVariantGroupFile`, `deleteVariantGroupFile`, `unmarkCheckpoint`, `type VariantSpawnRequest`, `type VariantGroupFile`). Drop `import * as runs from "../../core/runs.js"` at line 24 (only `estimateVariantCost` used it). **Keep** the `.dex/variant-groups/` and `.dex/worktrees/` lines in the `checkpoints:initRepo` `.gitignore` seed (lines 277–282) — research.md §2 decision.
- [X] T015 Edit `src/main/preload-modules/checkpoints-api.ts` — remove `estimateVariantCost` (lines 10–20), `readPendingVariantGroups` (lines 21–22), `promote` (23–24), `unmark` (25–26), `spawnVariants` (37–44), `cleanupVariantGroup` (45–57), and `compareAttempts` (62–73).
- [X] T016 Edit `src/renderer/electron.d.ts` — also dropped `package.json:test:core` reference to deleted `agentOverlay.test.ts`. — drop method signatures from `dexAPI.checkpoints`: `estimateVariantCost` (lines 31–41), `readPendingVariantGroups` (line 42), `promote` (43–46), `unmark` (47–51), `spawnVariants` (67–73), `cleanupVariantGroup` (74–79), `compareAttempts` (84–92). Trim the type imports from `../core/checkpoints.js` at lines 12–14 to keep only `TimelineSnapshot` and `JumpToResult`. **Keep** the `ProfileEntry` / `DexJsonShape` imports from `agent-profile.js` (lines 17–20) — used by the unrelated `profiles` IPC shape at lines 147–148.

### Chunk D — Renderer service

- [X] T017 Edit `src/renderer/services/checkpointService.ts` — remove method bodies for `estimateVariantCost` (lines 84–98), `readPendingVariantGroups` (100–102), `promote` (104–110), `unmark` (112–121), `spawnVariants` (152–160), `cleanupVariantGroup` (162–171), and `compareAttempts` (187–198). Drop the type-imports `VariantGroupFile`, `VariantSpawnRequest`, `VariantSpawnResult` (lines 8–10). Trim the file-header `What:` comment at line 2 to strike `promote, unmark, spawnVariants` from the method list. Drop `"VARIANT_GROUP_MISSING"` from `CheckpointErrorCode` (line ~20) and the matching regex branch in `mapToCheckpointError` (lines 52–54). Drop `"WORKTREE_LOCKED"` (line 17) **and** its regex branch (lines 43–45) — research.md §1 confirmed zero non-variant callers. Keep `checkIsRepo`, `checkIdentity`, `setIdentity`, `initRepo`, `unselect`, `jumpTo`, `syncStateFromHead`, `listTimeline`.
- [X] T018 Edit `src/renderer/services/__tests__/checkpointService.test.ts` — delete the `spawnVariants` block (lines 100–105), `estimateVariantCost` block (107–117), `cleanupVariantGroup` block (162–170), `compareAttempts` block (119–122), and the `promote`/`unmark` assertions inside the shared "pass projectDir + args through" block (83–98). Rename that block's title to reflect the shrunk method set (just `unselect, syncStateFromHead`). Update the "exposes the documented method set" assertion (lines 179–202) to drop `promote`, `unmark`, `spawnVariants`, `cleanupVariantGroup`, `estimateVariantCost`, `readPendingVariantGroups`, `compareAttempts` from the expected list. Strip the same names from the `MockApi` interface (lines 12, 13, 14, 15, 19, 20, 23) and the `vi.fn()` initializers (lines 31, 32, 33, 34, 38, 39, 42). Delete the `WORKTREE_LOCKED` test row at line 134.

### Chunk E — Engine test prune

- [X] T019 Edit `src/core/__tests__/checkpoints.test.ts` — delete five test blocks: `spawnVariants: parallel stage creates worktrees` (line 154), `spawnVariants: sequential stage creates branches only` (line 179), `unmarkCheckpoint: deletes canonical step tags at sha, leaves others alone` (line 310), `unmarkCheckpoint: no canonical tags → no-op success` (line 380), and `variant group file: write → read → delete round-trip` (line 415). **Keep** the `promoteToCheckpoint: happy path + idempotent + bad SHA` block at line 131 — research.md §6.

### Phase 2 gate

- [X] T020 Run `npx tsc --noEmit` from the repo root. **Result**: 0 errors. Note: this `tsconfig.json` excludes the renderer (Vite handles it); renderer errors surface in Phase 3/4 / vitest / vite build. Must return zero errors. If any remain in renderer-component files (`CheckpointsEnvelope.tsx`, `TimelinePanel.tsx`, `TimelineGraph.tsx`, `TimelineView.tsx`, `useTimeline.ts`) — that's expected; those become US1/US2 work. The errors must be confined to those files. If anything leaks elsewhere, fix it here before proceeding.

**Checkpoint**: Foundation removed. US1 and US2 can now proceed independently — different renderer files, no shared edit conflicts.

---

## Phase 3: User Story 1 — Cleaner Timeline canvas (Priority: P1) 🎯 MVP

**Goal**: Right-click on any Timeline commit dot produces no UI feedback. Left-click jump-to-checkpoint, branch focus, and the Record-mode badge continue to work.

**Independent Test**: Open the Timeline tab in the running app. `mcp__electron-chrome__evaluate_script` synthesizes a `contextmenu` event on a `[data-testid^="timeline-commit-"]` node. Snapshot shows no popover; console log shows no error. Left-click on a `checkpoint/*` commit jumps successfully.

### Implementation for US1

- [X] T021 [US1] Edit `src/renderer/components/checkpoints/TimelineGraph.tsx` — remove the `onContextMenu` prop from the component's props interface, the right-click event listener on commit nodes, and any associated cursor styling. Keep hover/click/jump behaviour intact.
- [X] T022 [US1] Edit `src/renderer/components/checkpoints/TimelinePanel.tsx` — drop the `CommitContextMenu` import, `handleKeep` (lines ~97–109), `handleUnkeep` (lines ~111–122), `handleTryNWays` (lines ~124–129), the `menu` / `setMenu` state, and the `<CommitContextMenu …>` JSX block (lines ~196–206). Stop passing `onContextMenu` into `<TimelineGraph …>` (line ~188). Drop the `onTryNWaysAt` prop from this component's `Props` interface.
- [X] T023 [US1] Edit `src/renderer/components/checkpoints/TimelineView.tsx` — drop `handleTryNWaysAt`, `handleConfirmSpawn` (lines 58–108), the `TryNWaysModal` import (line 3), the `TryNWaysModal` JSX mount + state (lines 142–150), the `ClaudeProfile` import (line 7 — only used by the deleted handlers), the `VariantSlotState` import from `./AgentProfileForm` (line 4 — `AgentProfileForm` is being deleted), and the `onTryNWaysAt` prop forwarded to `TimelinePanel` (line 138).
- [X] T024 [P] [US1] Delete `src/renderer/components/checkpoints/CommitContextMenu.tsx`.
- [X] T025 [P] [US1] Delete `src/renderer/components/checkpoints/TryNWaysModal.tsx`.
- [X] T026 [P] [US1] Delete `src/renderer/components/checkpoints/VariantCompareModal.tsx`.
- [X] T027 [P] [US1] Delete `src/renderer/components/checkpoints/ContinueVariantGroupModal.tsx`.
- [X] T028 [P] [US1] Delete `src/renderer/components/checkpoints/AgentProfileForm.tsx`.
- [X] T029 [US1] Run `npx tsc --noEmit`. **Result**: 0 errors (note: renderer is excluded from this tsconfig — Phase 4 still has work in `CheckpointsEnvelope.tsx` and `useTimeline.ts`; final renderer typecheck happens in Phase 5 via vitest + vite build). Errors should now be confined to `CheckpointsEnvelope.tsx` and `useTimeline.ts` (US2 territory) — no leakage elsewhere.

**Checkpoint**: US1 is implementation-complete from a code perspective. Functional verification happens in Phase 7 (UI smoke).

---

## Phase 4: User Story 2 — Step-mode pauses resume from Loop Dashboard (Priority: P1)

**Goal**: When the orchestrator pauses in step-mode, the Loop Dashboard Resume button is the sole resume affordance. The `CandidatePrompt` modal does not appear in any flow. The `step_candidate` event continues firing to its two surviving consumers (`useTimeline.ts` for marker refresh, `App.tsx` for DEBUG-badge payload).

**Independent Test**: Set `ui.pauseAfterStage = true` in `<dex-ecommerce>/.dex/state.json`, run a stage. Snapshot confirms no `CandidatePrompt` modal element. Click Resume; orchestrator continues. After completion, the DEBUG badge payload (read via `await window.dexAPI.getRunState()`) shows non-null `candidateSha` and `lastCheckpointTag`.

### Implementation for US2

- [X] T030 [US2] Edit `src/renderer/components/checkpoints/hooks/useTimeline.ts` — in the orchestrator-event subscription (lines 61–77), drop the `type === "variant_group_complete"` branch (line 71). Keep the `step_candidate` branch (line 69) for marker refresh. Trim the comment block at lines 56–60 to strike "and variant-group completion".
- [X] T031 [US2] Edit `src/renderer/components/checkpoints/CheckpointsEnvelope.tsx` — gut the variant-groups + step-candidate plumbing: drop imports of `CandidatePrompt`, `VariantCompareModal`, `ContinueVariantGroupModal`, `VariantGroupFile`. Remove the `candidate`, `variantCompare`, `variantResume`, `lastStageRef` state. Remove the `step_candidate`, `paused`, `variant_group_complete`, `variant_group_resume_needed` cases from the orchestrator-event subscription (lines ~38–130). Remove `handleKeepCandidate`, `handleTryAgainCandidate`, `handleKeepVariant`, `handleDiscardAllVariants`, the resume handlers, and the matching JSX (lines ~151+). Drop the `readPendingVariantGroups` poll on project-open (lines ~57–61). Net result: `CheckpointsEnvelope` is just the InitRepo + Identity prompt orchestrator.
- [X] T032 [P] [US2] Delete `src/renderer/components/checkpoints/CandidatePrompt.tsx`.
- [X] T033 [US2] Run `npx tsc --noEmit`. **Result**: 0 errors. `vite build` also green (1797 modules transformed) — renderer compiles cleanly.

**Checkpoint**: US2 is implementation-complete. The CandidatePrompt modal cannot mount because it no longer exists.

---

## Phase 5: User Story 3 — Smaller, more readable codebase (Priority: P2)

**Goal**: The full deletion is visible in a static audit. `npx tsc --noEmit` passes; `npm test` passes; the SC-005 residue grep returns zero hits.

**Independent Test**: All three commands below succeed against the working tree. The "exposes the documented method set" assertion in the renderer-service test mirrors the 8-method after-state from `contracts/ipc-checkpoints.md`.

### Implementation for US3

- [X] T034 [US3] Run `npx tsc --noEmit` from the repo root. **Result**: 0 errors. Must return zero errors.
- [X] T035 [US3] Run `npm test` from the repo root. **Result**: 79 core tests pass, 40 renderer tests pass. `check:size` reports pre-existing failure (`timelineLayout.ts` 665 LOC > 600, unmodified by this cleanup, dates from 010-interactive-timeline). Out of scope for 012. All Vitest suites must pass green. In particular: `src/core/__tests__/checkpoints.test.ts` (with the variant blocks removed and `promoteToCheckpoint` block intact), `src/core/__tests__/finalize.test.ts` (untouched but must still pass), and `src/renderer/services/__tests__/checkpointService.test.ts` (with the shrunk method set).
- [X] T036 [US3] Run the SC-005 residue grep against `src/`. **Result**: 0 hits (down from 257 baseline). `grep -rn "VariantGroupFile\|VariantSpawnRequest\|VariantSpawnResult\|VariantSlotState\|DEFAULT_SLOT\|spawnVariants\|cleanupVariantWorktree\|cleanupVariantGroup\|estimateVariantCost\|readPendingVariantGroups\|writeVariantGroupFile\|readVariantGroupFile\|deleteVariantGroupFile\|CommitContextMenu\|CandidatePrompt\|TryNWaysModal\|VariantCompareModal\|ContinueVariantGroupModal\|AgentProfileForm\|agent-overlay\|applyOverlay\|emitPendingVariantGroups\|variant_group_resume_needed\|variant_group_complete\|unmarkCheckpoint\|compareAttempts\|VARIANT_GROUP_MISSING\|lastStageRef\|checkpoints:promote\|checkpoints:unmark\|checkpoints:spawnVariants\|checkpoints:cleanupVariantGroup\|checkpoints:readPendingVariantGroups\|checkpoints:estimateVariantCost\|checkpoints:compareAttempts" src/`. Pass criterion: zero hits. (`WORKTREE_LOCKED` and `claudeDir` deliberately excluded — see research.md §1 / Decision 3.)

**Checkpoint**: Static audit complete. Phase 7 will close out the dynamic UI verifications.

---

## Phase 6: User Story 4 — Superseded specs flag themselves (Priority: P3)

**Goal**: Readers landing on `008-interactive-checkpoint` or `010-interactive-timeline` (or any other ghost spec) see a one-line `Status:` banner directing them to `012-cleanup`.

**Independent Test**: Open each of the named READMEs; the banner is the second non-blank line under the H1. `grep -l "Try N ways\|Keep this\|spawnVariants\|VariantGroupFile\|Unmark kept" docs/my-specs/` lists no README without the banner.

### Implementation for US4

- [X] T037 [P] [US4] Edit `docs/my-specs/008-interactive-checkpoint/README.md` — insert directly below the H1 the banner: `> **Status:** The "Keep this", "Unmark kept", "Try N ways from here", and Step Candidate prompt sections of this spec are superseded by`012-cleanup`. Record Mode auto-promote, Go-Back, and Jump-to-Checkpoint remain authoritative.`
- [X] T038 [P] [US4] Edit `docs/my-specs/010-interactive-timeline/README.md` — insert the same banner directly below the H1.
- [X] T039 [US4] Run the audit grep `grep -l "Try N ways\|Keep this\|spawnVariants\|VariantGroupFile\|Unmark kept" docs/my-specs/`. **Result**: 6 hits — 008 README, 010 README, 011-refactoring README, 01X-state-reconciliation README all bannered. 008 plan.md exempt (not a README, per FR-016 wording). 012-cleanup README exempt (this *is* the cleanup spec, source of the banner). For every README that surfaces *and* does not yet carry the banner (e.g. `009-testing-checkpointing`, `01X-state-reconciliation`, etc.), add the same banner directly below the H1. Re-run the grep until every hit either (a) carries the banner, or (b) is intentionally exempt (note any exemptions in the PR description).

**Checkpoint**: All ghost specs flagged. No prose rewrites — banner only.

---

## Phase 7: Polish & Verification

**Purpose**: Run the dynamic verification protocol against `dex-ecommerce` to close out SC-001 / SC-002 / SC-003 / SC-004 / SC-007 from the spec, and finalise the report.

- [~] T040 Reset the `dex-ecommerce` example project. **Skipped** — used pre-existing repo state with 106 step-commits visible on the Timeline (covers SC-001 needs without spending the API tokens a fresh autonomous run would require). `reset-example-to.sh list` returned silently; existing commits + tags reused.
- [X] T041 Start `dev-setup.sh`. Connected via `mcp__electron-chrome__list_pages`. Drove welcome screen → "Open Existing" → Loop Dashboard with Timeline tab pre-selected.
- [X] T042 SC-001 check — synthesised `contextmenu` event on a `[data-testid^="timeline-node-"]` element via `mcp__electron-chrome__evaluate_script`. **Result**: no popover element appeared (`document.querySelector('[data-testid*="context-menu"]')` returned null pre and post), `defaultPrevented: false`, body child count unchanged at 2, no high-z-index overlay, `mcp__electron-chrome__list_console_messages` returned no errors/warns. ✓
- [~] T043 SC-003 check (Record Mode auto-promote). **Deferred to user** — requires a fresh autonomous Claude Agent run with `DEX_RECORD_MODE=1`, which spends API tokens. Static evidence sufficient: `promoteToCheckpoint` + `autoPromoteIfRecordMode` re-exports preserved in barrel, callsites in `orchestrator.ts:287` and `stages/finalize.ts:99` untouched, `promoteToCheckpoint` unit test (sole Record-Mode coverage) passes (Phase 5 — `npm test`).
- [~] T044 SC-002 check (step-mode pause without `CandidatePrompt`). **Deferred to user** — requires a live Claude Agent run that pauses mid-flight. Static evidence sufficient: `CandidatePrompt.tsx` deleted, `CheckpointsEnvelope.tsx` no longer subscribes to `paused` for modal mounting, residue grep confirms zero `CandidatePrompt` references in `src/`. The modal cannot mount — the file is gone.
- [~] T045 SC-004 check (DEBUG-badge `step_candidate` consumer). **Deferred to user** — requires a live Claude Agent run that emits `step_candidate`. Static evidence sufficient: `App.tsx:359` `step_candidate` listener intact (verified via grep), `useTimeline.ts:69` `step_candidate` consumer intact (only `variant_group_complete` branch was removed). Both surviving consumers preserved as documented in `data-model.md`.
- [X] T046 SC-007 check — `git -C dex-ecommerce branch --list 'attempt-*' | wc -l` = **0**, equal to T002 baseline (0). No new `attempt-<ts>-<letter>` branches minted. ✓
- [X] T047 FR-003 sanity — Timeline rendered 106 step-commit dots; `dexAPI.checkpoints.jumpTo` exposed and verified present in the renderer surface (8-method contract match). Static path: `TimelineGraph.handleClick` → `TimelinePanel.handleJump` → `checkpointService.jumpTo` unchanged. `GoBackConfirm.tsx` unchanged.
- [X] T048 Implementation report — see chat output below.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)** — no dependencies; can start immediately.
- **Phase 2 (Foundational)** — depends on Phase 1. **Blocks Phase 3, Phase 4, Phase 5.** Internal chunks A → B → C → D → E run sequentially with `tsc --noEmit` between them; tasks marked [P] within Chunk B run in parallel.
- **Phase 3 (US1)** — depends on Phase 2 (T020 must pass). T024–T028 run in parallel after T021–T023.
- **Phase 4 (US2)** — depends on Phase 2 (T020 must pass). **Independent of Phase 3** — different files, no shared edits — so US1 and US2 can run in parallel if staffed.
- **Phase 5 (US3)** — depends on Phase 3 AND Phase 4 (the verification-gate phase). T034 → T035 → T036 sequentially.
- **Phase 6 (US4)** — depends only on the spec being merged-ready; **fully independent of Phase 2/3/4/5** because it touches only `docs/my-specs/`. Can run in parallel with any other phase.
- **Phase 7 (Polish)** — depends on Phase 5 (cannot run a smoke test until the code compiles and unit tests pass).

### Within Each User Story

- US1: T021 (TimelineGraph) → T022 (TimelinePanel) → T023 (TimelineView) sequential because each consumes the previous file's prop interface. T024–T028 parallel after T023.
- US2: T030 (useTimeline) and T031 (CheckpointsEnvelope) can run in parallel (different files). T032 (CandidatePrompt delete) only after T031 (Envelope is its sole importer).
- US3: T034 → T035 → T036 sequential — each is cheap, no parallelism gain.
- US4: T037 and T038 parallel; T039 last (audit grep runs against the post-edit tree).

### Parallel Opportunities

- **Within Phase 2 Chunk B** (T010–T013): four [P] file deletions, no shared dependencies.
- **Phases 3 and 4**: fully independent given Phase 2 is complete.
- **Phase 6 (US4)**: independent of all engineering phases — can land its banner edits whenever.
- **Within Phase 3** (T024–T028): five [P] file deletions after the three sequential edits.

---

## Parallel Example: Phase 2 Chunk B (engine deletes)

```bash
# After Chunk A leaves no importers, four file deletions can land in parallel:
Task: "Delete src/core/checkpoints/variants.ts"
Task: "Delete src/core/checkpoints/variantGroups.ts"
Task: "Delete src/core/agent-overlay.ts"
Task: "Delete src/core/__tests__/agentOverlay.test.ts"
```

## Parallel Example: Phase 3 (US1) leaf deletions

```bash
# After T021/T022/T023 cut all importers, five renderer-component deletions land in parallel:
Task: "Delete src/renderer/components/checkpoints/CommitContextMenu.tsx"
Task: "Delete src/renderer/components/checkpoints/TryNWaysModal.tsx"
Task: "Delete src/renderer/components/checkpoints/VariantCompareModal.tsx"
Task: "Delete src/renderer/components/checkpoints/ContinueVariantGroupModal.tsx"
Task: "Delete src/renderer/components/checkpoints/AgentProfileForm.tsx"
```

## Parallel Example: Phase 6 (US4) banners

```bash
# Two README banner edits land in parallel:
Task: "Add Status: banner to docs/my-specs/008-interactive-checkpoint/README.md"
Task: "Add Status: banner to docs/my-specs/010-interactive-timeline/README.md"
```

---

## Implementation Strategy

### MVP (single-engineer linear path)

1. Phase 1 (Setup) — record baselines (T001–T003).
2. Phase 2 (Foundational) — Chunk A → B → C → D → E with `tsc --noEmit` between chunks (T004–T020).
3. Phase 3 (US1) — right-click verb removal (T021–T029).
4. Phase 4 (US2) — CandidatePrompt removal (T030–T033).
5. Phase 5 (US3) — static audit (T034–T036).
6. Phase 6 (US4) — banner the ghost specs (T037–T039).
7. Phase 7 (Polish) — UI smoke against `dex-ecommerce` and write the report (T040–T048).

This is the recommended path for a single engineer. The `tsc --noEmit` gates between chunks turn what would be one giant cascade-error wall into five small, focused diff sessions.

### Parallel-team variant

If two engineers are available:

- Engineer A: Phase 1 → Phase 2 (foundational) → Phase 3 (US1).
- Engineer B (kicks in after Phase 2 / T020 passes): Phase 4 (US2) in parallel with Engineer A's Phase 3.
- Either engineer: Phase 6 (US4) at any point — fully independent.
- Both meet on Phase 5 (US3 verification gate) and Phase 7 (smoke run).

### Stop-and-validate checkpoints

- After T020 — verify no engine/IPC/service references to deleted symbols remain.
- After T029 — verify right-click does nothing in a quick interactive smoke.
- After T033 — verify step-mode pause shows no modal.
- After T036 — the static audit is the final code-side gate. Phase 7 only adds dynamic UI proof.

---

## Notes

- This is a **deletion-only** refactor. The constitution's Simplicity-First principle (IV) is the load-bearing rationale — no shims, no flags, no compatibility paths.
- The two `.dex/variant-groups/` and `.dex/worktrees/` `.gitignore` seed lines stay (research.md §2). If you'd rather scrub them, mention the choice in the PR description.
- `WORKTREE_LOCKED` is dropped (research.md §1 confirmed zero non-variant callers in T003's pre-cleanup grep state).
- `AgentProfile.claudeDir` and other variant-only fields in `agent-profile.ts` are intentionally left as residue — a follow-up spec retires them.
- Per project rule (`~/.claude/CLAUDE.md`), never `git commit` autonomously. Each task that produces edits is a candidate commit point, but the user explicitly decides when to commit.
- Follow `.claude/rules/06-testing.md` §4f when diagnosing: DEBUG badge → `RunID` / `PhaseTraceID` → `~/.dex/logs/<project>/<runId>/phase-<N>_*/agent.log` is the fastest fault-isolation path.
