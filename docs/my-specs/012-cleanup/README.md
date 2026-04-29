# 012 — Cleanup: Remove "Keep this", "Unmark kept", "Try N ways from here", and Step Candidate prompt

## Context

Three right-click verbs on the Timeline canvas — **Keep this**, **Unmark kept**, **Try N ways from here** — and the related **Step Candidate** prompt modal are being retired. The user-facing UX value isn't worth their cost in code surface area: the variant-groups feature (worktrees, attempt branches, compare/resume modals) is sprawling, and the "Keep / Unmark" verbs duplicate behaviour that Record Mode already handles automatically.

After this change:
- The Timeline tab keeps its core affordances: render commits/branches, jump-to-checkpoint, drop-from-selected-path, branch focus, the Record-mode badge, and the Go-Back confirmation flow.
- Record Mode auto-promote stays untouched — `promoteToCheckpoint` survives in the engine but loses its IPC entry point.
- Step-mode pauses still happen, but the user resumes via the existing **Resume** button on the Loop Dashboard rather than an in-flow `CandidatePrompt` modal.
- The `step_candidate` event keeps firing. Two listeners survive: `useTimeline.ts:69` (refresh trigger for timeline markers) and `App.tsx:332` (DEBUG-badge payload). The `CheckpointsEnvelope` listener is gone.

Non-goals: no behavioural changes to Record Mode, Go-Back, Jump-to-Checkpoint, or the broader agent-profile system (`agent-profile.ts`, `profilesService`, `ipc/profiles`, `AgentRunner` profile threading).

## Files to delete

### Variant-groups feature (full tear-out)
- `src/core/checkpoints/variants.ts`
- `src/core/checkpoints/variantGroups.ts`
- `src/core/agent-overlay.ts` — only consumer is `variants.ts`
- `src/core/__tests__/agentOverlay.test.ts`
- `src/renderer/components/checkpoints/TryNWaysModal.tsx`
- `src/renderer/components/checkpoints/VariantCompareModal.tsx`
- `src/renderer/components/checkpoints/ContinueVariantGroupModal.tsx`
- `src/renderer/components/checkpoints/AgentProfileForm.tsx`

### Right-click menu
- `src/renderer/components/checkpoints/CommitContextMenu.tsx`

### Step-Candidate prompt
- `src/renderer/components/checkpoints/CandidatePrompt.tsx`

## Files to edit

### Engine

**`src/core/checkpoints/index.ts`** — drop the named exports `spawnVariants`, `cleanupVariantWorktree`, `VariantSpawnRequest`, `VariantSpawnResult`, `writeVariantGroupFile`, `readVariantGroupFile`, `deleteVariantGroupFile`, `readPendingVariantGroups`, `VariantGroupFile`, and `unmarkCheckpoint`. Drop the matching keys from the legacy default-object (`spawnVariants`, `cleanupVariantWorktree`, `unmark`, `readVariantGroupFile`, `writeVariantGroupFile`, `deleteVariantGroupFile`, `readPendingVariantGroups` — at lines 86–147). Keep `promoteToCheckpoint` + `autoPromoteIfRecordMode` re-exports (Record Mode needs them). Note: `applyOverlay` is **not** in the barrel — only deleting `agent-overlay.ts` is required.

**`src/core/checkpoints/jumpTo.ts`** — remove the `unmarkCheckpoint` function (lines 66–89). It's only reached via the `checkpoints:unmark` IPC, which is going away. The "unselect" path stays.

**`src/core/run-lifecycle.ts`** — remove `emitPendingVariantGroups` (lines 261–278) and its two call sites (lines 140, 153). Variant groups can no longer be created, so resume-needed emission is dead.

**`src/core/events.ts`** — remove `variant_group_resume_needed` and `variant_group_complete` from the union (lines 111–122). `step_candidate` stays — `useTimeline.ts:69` consumes it for markers and `App.tsx:332` consumes it for the DEBUG-badge payload.

**`src/core/checkpoints/recordMode.ts`** — no change. `promoteToCheckpoint` and `autoPromoteIfRecordMode` keep working; they're called from `src/core/orchestrator.ts:287` and `src/core/stages/finalize.ts:99` respectively.

### IPC + preload

**`src/main/ipc/checkpoints.ts`** — remove handlers + imports for:
- `checkpoints:estimateVariantCost` (lines 121–153)
- `checkpoints:readPendingVariantGroups` (lines 155–157)
- `checkpoints:promote` (lines 161–165)
- `checkpoints:unmark` (lines 167–171)
- `checkpoints:spawnVariants` (lines 196–231)
- `checkpoints:cleanupVariantGroup` (lines 233–266)
- `checkpoints:compareAttempts` (line 331) — its only renderer caller is `VariantCompareModal`, which is being deleted.

**`src/main/preload-modules/checkpoints-api.ts`** — remove `estimateVariantCost` (lines 10–20), `readPendingVariantGroups` (lines 21–22), `promote` (23–24), `unmark` (25–26), `spawnVariants` (37–44), `cleanupVariantGroup` (45–57), and `compareAttempts` (62–73).

**`src/renderer/electron.d.ts`** — drop the matching method signatures from the `dexAPI.checkpoints` shape: `estimateVariantCost`, `readPendingVariantGroups`, `promote`, `unmark`, `spawnVariants`, `cleanupVariantGroup`, `compareAttempts`. Note: the file's `ProfileEntry` / `DexJsonShape` imports from `agent-profile.js` are used by the unrelated `profiles` IPC shape — leave those imports in place.

### Renderer service

**`src/renderer/services/checkpointService.ts`** — remove `estimateVariantCost` (lines 84–98), `readPendingVariantGroups` (100–102), `promote` (104–110), `unmark` (112–121), `spawnVariants` (152–160), `cleanupVariantGroup` (162–171), and `compareAttempts` (187–198). Keep `checkIsRepo`, `checkIdentity`, `setIdentity`, `initRepo`, `unselect`, `jumpTo`, `syncStateFromHead`, `listTimeline`.

**`src/renderer/services/__tests__/checkpointService.test.ts`** — drop the test cases covering removed methods: the `spawnVariants` block (lines 100–105), `estimateVariantCost` block (107–117), `cleanupVariantGroup` block (162–170), `compareAttempts` block (119–122), and the `promote`/`unmark` assertions inside the shared "pass projectDir + args through" block (83–98). Update the "exposes the documented method set" assertion (179–202) to drop `promote`, `unmark`, `spawnVariants`, `cleanupVariantGroup`, `estimateVariantCost`, `readPendingVariantGroups`, `compareAttempts` from the expected list, and from the mock fixture (lines 23, 42).

### Renderer components

**`src/renderer/components/checkpoints/CheckpointsEnvelope.tsx`** — gut the variant-groups + step-candidate plumbing:
- Drop imports of `CandidatePrompt`, `VariantCompareModal`, `ContinueVariantGroupModal`, `VariantGroupFile`.
- Remove the `candidate`, `variantCompare`, `variantResume`, `lastStageRef` state + the `step_candidate`, `paused`, `variant_group_complete`, `variant_group_resume_needed` cases from the orchestrator-event subscription (lines ~38–130).
- Remove `handleKeepCandidate`, `handleTryAgainCandidate`, `handleKeepVariant`, `handleDiscardAllVariants`, the resume handlers, and the matching JSX (lines ~151+).
- Drop the `readPendingVariantGroups` poll on project-open (lines ~57–61).
- Net result: `CheckpointsEnvelope` is just the InitRepo + Identity prompt orchestrator.

**`src/renderer/components/checkpoints/TimelinePanel.tsx`** — remove right-click wiring:
- Drop `CommitContextMenu` import.
- Drop `handleKeep` (lines ~97–109), `handleUnkeep` (lines ~111–122), `handleTryNWays` (lines ~124–129), the `menu`/`setMenu` state, and the `<CommitContextMenu …>` block (lines ~196–206).
- Stop passing `onContextMenu` into `<TimelineGraph …>` (line ~188).
- Drop the `onTryNWaysAt` prop from this component's `Props` interface and from any parent that passes it.

**`src/renderer/components/checkpoints/TimelineGraph.tsx`** — drop the `onContextMenu` prop, the right-click event listener on commit nodes, and any associated cursor styling. Leave hover/click/jump behaviour intact.

**`src/renderer/components/checkpoints/TimelineView.tsx`** — remove `handleTryNWaysAt`, `handleConfirmSpawn`, the `TryNWaysModal` mount + state, the `ClaudeProfile` import (line 7), the `VariantSlotState` import from `./AgentProfileForm` (line 4 — `AgentProfileForm` is being deleted, so this import will dangle), the `handleConfirmSpawn` body (lines 58–108), and the `onTryNWaysAt` prop forwarded to `TimelinePanel` (line 138). Drop the `<TryNWaysModal>` JSX mount (lines 142–150).

### Tests

**`src/core/__tests__/checkpoints.test.ts`** — delete five test blocks:
- `spawnVariants: parallel stage creates worktrees` (line 154)
- `spawnVariants: sequential stage creates branches only` (line 179)
- `unmarkCheckpoint: deletes canonical step tags at sha, leaves others alone` (line 310)
- `unmarkCheckpoint: no canonical tags → no-op success` (line 380)
- `variant group file: write → read → delete round-trip` (line 415)

**Keep** `promoteToCheckpoint: happy path + idempotent + bad SHA` (line 131). It is the **only** unit-level coverage of Record Mode's git-tag operation — no `recordMode.test.ts` exists, and `finalize.test.ts` carries only type-shape pins (the behaviour blocks at lines 76–101 are commented out, awaiting Wave-D vitest infra). Removing it would leave Record Mode with zero unit coverage.

Re-check `src/core/__tests__/finalize.test.ts` still passes after pruning.

### Documentation updates

Two existing spec READMEs describe the removed UI as authoritative. After this cleanup they become ghost specs. Append a one-line banner at the top of each:

**`docs/my-specs/008-interactive-checkpoint/README.md`** — add `> **Status:** The "Keep this", "Unmark kept", "Try N ways from here", and Step Candidate prompt sections of this spec are superseded by `012-cleanup`. Record Mode auto-promote, Go-Back, and Jump-to-Checkpoint remain authoritative.` directly below the H1.

**`docs/my-specs/010-interactive-timeline/README.md`** — add the same banner directly below the H1.

Full edits to strike the removed verbs from the prose are out of scope — the banner is enough to prevent confusion.

## What stays

- `src/core/checkpoints/recordMode.ts` (`promoteToCheckpoint` + `autoPromoteIfRecordMode`).
- `src/core/checkpoints/jumpTo.ts` `jumpToCheckpoint` and `unselect` paths.
- `src/core/checkpoints/timeline.ts`, `commit.ts`, `_helpers.ts`, `tags.ts` — unchanged.
- `src/renderer/components/checkpoints/RecBadge.tsx` + Topbar wiring.
- `src/renderer/components/checkpoints/GoBackConfirm.tsx` — independent.
- The whole agent-profile system (`agent-profile.ts`, `profilesService.ts`, `ipc/profiles.ts`, `preload-modules/profiles-api.ts`, profile threading in `AgentRunner`) — used outside variants.
- The `step_candidate` event — emitted from `stages/finalize.ts:89`. Consumed by `useTimeline.ts:69` (timeline marker refresh) and `App.tsx:332` (DEBUG-badge payload — `candidateSha`, `attemptBranch`, `lastCheckpointTag`). Both stay.

## Reused functions (no new code)

This is a deletion-only change; no new functions or abstractions. The remaining code paths (`promoteToCheckpoint`, `autoPromoteIfRecordMode`, `jumpToCheckpoint`, `unselect`, the timeline rendering hooks) are already exercised and unchanged.

## On-disk migration notes

- `.dex/variant-groups/<groupId>.json` files in existing user projects are now orphaned. They are gitignored, so silently leaving them is harmless; users can `rm -rf .dex/variant-groups .dex/worktrees` themselves. **Do not auto-delete** — too risky on first launch.
- `attempt-<timestamp>-<letter>` branches stay until `scripts/prune-example-branches.sh` runs (already prunes them after 30 days).
- Existing `checkpoint/*` tags created via "Keep this" stay valid — Record Mode already creates the same tag shape, and `jumpToCheckpoint` continues to honour them.
- `scripts/promote-checkpoint.sh` keeps working — it shells out to `git tag -f` directly, doesn't go through the IPC path.

## Verification

1. `npx tsc --noEmit` — must pass with zero errors. This catches stragglers (e.g. forgotten `onTryNWaysAt` prop in a parent, a leftover `VariantGroupFile` import).
2. `npm test` — full Vitest run. The pruned test files should still pass; finalize/checkpoints suites must stay green.
3. `npm test src/renderer/services/__tests__/checkpointService.test.ts` — the only renderer-side test today. The "exposes the documented method set" assertion must reflect the shrunk method list.
4. UI smoke test against `dex-ecommerce` (per `.claude/rules/06-testing.md` §4c):
   - `./scripts/reset-example-to.sh clean`
   - Start `dev-setup.sh`, open the project, kick off a run.
   - Open the Timeline tab. Right-click a step-commit dot → no context menu appears (verify via `mcp__electron-chrome__list_console_messages` for no errors and a snapshot showing no popover).
   - Confirm jump-to-checkpoint (left-click on a kept commit) still works.
   - Confirm Go-Back confirmation modal still fires when jumping with dirty files.
   - With `DEX_RECORD_MODE=1`, run a few stages and verify `git tag --list 'checkpoint/*'` shows the auto-promoted tags — Record Mode is unbroken.
   - Toggle step-mode in `.dex/state.json` (`ui.pauseAfterStage = true`), run a stage. The orchestrator should pause (Resume button on Loop Dashboard becomes available). The `CandidatePrompt` modal must NOT appear. Click Resume — orchestrator continues.
   - Click the **DEBUG badge** on the Loop Dashboard. Confirm the payload still shows non-null `lastCheckpointTag` and `candidateSha`. This proves `App.tsx:332` (the surviving `step_candidate` consumer) is intact.
5. `grep -rn "VariantGroupFile\|VariantSpawnRequest\|VariantSpawnResult\|VariantSlotState\|DEFAULT_SLOT\|spawnVariants\|cleanupVariantWorktree\|cleanupVariantGroup\|estimateVariantCost\|readPendingVariantGroups\|writeVariantGroupFile\|readVariantGroupFile\|deleteVariantGroupFile\|CommitContextMenu\|CandidatePrompt\|TryNWaysModal\|VariantCompareModal\|ContinueVariantGroupModal\|AgentProfileForm\|agent-overlay\|applyOverlay\|emitPendingVariantGroups\|variant_group_resume_needed\|variant_group_complete\|unmarkCheckpoint\|compareAttempts\|checkpoints:promote\|checkpoints:unmark\|checkpoints:spawnVariants\|checkpoints:cleanupVariantGroup\|checkpoints:readPendingVariantGroups\|checkpoints:estimateVariantCost\|checkpoints:compareAttempts" src/` should return zero hits after the change.
6. Run `npx tsc --noEmit` after each chunk (engine → IPC + preload → renderer service → renderer components → tests) rather than only at the end. Catches barrel-export typos and dangling imports earlier.
