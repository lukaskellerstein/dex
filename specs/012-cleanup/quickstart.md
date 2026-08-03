# Quickstart: Verifying the 012-cleanup change

**Audience**: the implementer (or reviewer) running the verification protocol after the cleanup lands.
**Branch**: `012-cleanup`.
**Reference**: `.claude/rules/06-testing.md` §4c (test recipe), §4f (diagnostics).

This quickstart maps each spec success criterion to the exact command, click, or grep that proves it. Run them top-to-bottom. Failure at any step is the fix-and-retest signal — don't move on.

## 0. Prerequisites

- `dex-ecommerce` example project at `/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce` (per `.claude/rules/06-testing.md` §4c).
- `dev-setup.sh` is **not** running yet. The smoke run starts it explicitly.
- Working tree is on branch `012-cleanup` with the cleanup edits in place.

## 1. Static checks (after each chunk + at the end)

| Step | Command | Pass criterion |
|------|---------|---------------|
| 1.1 | `npx tsc --noEmit` | Zero errors. Run after **each** of the five chunks (engine → IPC + preload → renderer service → renderer components → tests), not only at the end. |
| 1.2 | `npm test` | All Vitest suites green. In particular: `src/core/__tests__/checkpoints.test.ts` and `src/renderer/services/__tests__/checkpointService.test.ts`. |
| 1.3 | `npm test src/renderer/services/__tests__/checkpointService.test.ts` | The "exposes the documented method set" assertion lists exactly the 9 surviving methods (`listTimeline`, `checkIsRepo`, `checkIdentity`, `initRepo`, `setIdentity`, `unselect`, `jumpTo`, `syncStateFromHead`, plus the existing `checkIsRepo` variant). |

> Maps to **SC-006** + **FR-017**.

## 2. Symbol-residue grep

```bash
grep -rn "VariantGroupFile\|VariantSpawnRequest\|VariantSpawnResult\|VariantSlotState\|DEFAULT_SLOT\|spawnVariants\|cleanupVariantWorktree\|cleanupVariantGroup\|estimateVariantCost\|readPendingVariantGroups\|writeVariantGroupFile\|readVariantGroupFile\|deleteVariantGroupFile\|CommitContextMenu\|CandidatePrompt\|TryNWaysModal\|VariantCompareModal\|ContinueVariantGroupModal\|AgentProfileForm\|agent-overlay\|applyOverlay\|emitPendingVariantGroups\|variant_group_resume_needed\|variant_group_complete\|unmarkCheckpoint\|compareAttempts\|VARIANT_GROUP_MISSING\|lastStageRef\|checkpoints:promote\|checkpoints:unmark\|checkpoints:spawnVariants\|checkpoints:cleanupVariantGroup\|checkpoints:readPendingVariantGroups\|checkpoints:estimateVariantCost\|checkpoints:compareAttempts" src/
```

Pass criterion: zero hits inside `src/`. (`WORKTREE_LOCKED` and `claudeDir` deliberately excluded — see research.md §1 and Decision 3.)

> Maps to **SC-005**.

## 3. Documentation banners

```bash
grep -l "Try N ways\|Keep this\|spawnVariants\|VariantGroupFile\|Unmark kept" docs/my-specs/
```

Pass criterion:

- The two known READMEs (`docs/my-specs/008-interactive-checkpoint/README.md`, `docs/my-specs/010-interactive-timeline/README.md`) appear in the output.
- Each appears with a `> **Status:** ...` banner directly under the H1.
- Any additional README that surfaces also has the banner.

> Maps to **SC-008** + **FR-016**.

## 4. UI smoke run against `dex-ecommerce`

### 4.1 Reset the example project

```bash
./scripts/reset-example-to.sh clean
```

Pass criterion: `cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce && ls` shows only `GOAL.md` and `.git/`.

### 4.2 Snapshot baseline `attempt-*` branch count

```bash
git -C /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce branch --list 'attempt-*' | wc -l
```

Record this number — call it `BASELINE_ATTEMPT_COUNT`.

### 4.3 Start `dev-setup.sh`

Verify the dev server is reachable via `mcp__electron-chrome__list_pages`. If it errors, `dev-setup.sh` is not running.

### 4.4 Drive the welcome screen and start a run

Per `.claude/rules/06-testing.md` §4c step 3:

1. `mcp__electron-chrome__take_snapshot` to resolve uids.
2. `mcp__electron-chrome__fill` `welcome-path` → `/home/lukas/Projects/Github/lukaskellerstein`.
3. `mcp__electron-chrome__fill` `welcome-name` → `dex-ecommerce`.
4. Click `welcome-submit` (label should read `Open Existing`).
5. On the Loop Dashboard: toggle "Automatic Clarification" on, click "Start Autonomous Loop".

Wait for the run to enter the `tasks` stage or later (step-commits visible on the Timeline).

### 4.5 SC-001 — Right-click does nothing

1. Open the Timeline tab.
2. `mcp__electron-chrome__take_snapshot` — record uid of any step-commit dot.
3. Trigger a right-click on a commit dot via `mcp__electron-chrome__evaluate_script` (synthesize a `contextmenu` event):

   ```js
   () => {
     const dot = document.querySelector('[data-testid^="timeline-commit-"]');
     dot.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
   }
   ```

4. `mcp__electron-chrome__take_snapshot` — assert no popover/menu element is present.
5. `mcp__electron-chrome__list_console_messages` — assert no error logged from this action.

Pass criterion: no menu, no error.

> Maps to **SC-001**.

### 4.6 SC-003 — Record-Mode auto-promote still works

1. Stop the current run.
2. Restart with `DEX_RECORD_MODE=1` set (re-launch `dev-setup.sh` with the env var, then start a new run).
3. Let at least one stage complete.
4. `git -C /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce tag --list 'checkpoint/*'`

Pass criterion: at least one `checkpoint/<stage>` tag is listed and the Record-mode badge was visible during the run.

> Maps to **SC-003** + **FR-004**.

### 4.7 SC-002 — Step-mode pause + Resume button (no modal)

1. Edit `<dex-ecommerce>/.dex/state.json` to set `ui.pauseAfterStage = true`.
2. Trigger a stage. The orchestrator should pause.
3. `mcp__electron-chrome__take_snapshot` — assert no `CandidatePrompt` modal element is present.
4. The Loop Dashboard Resume button is enabled — `mcp__electron-chrome__click` it.
5. Confirm the run continues to the next stage.

Pass criterion: no modal, Resume succeeded.

> Maps to **SC-002** + **FR-002**.

### 4.8 SC-004 — DEBUG badge payload retains `candidateSha` / `lastCheckpointTag`

1. After a stage with `step_candidate` has completed, locate the **DEBUG badge** (Loop Dashboard header or trace breadcrumb bar).
2. `mcp__electron-chrome__evaluate_script` to read the payload directly (do **not** rely on clipboard read via MCP — flaky):

   ```js
   async () => {
     const state = await window.dexAPI.getRunState();
     return {
       candidateSha: state.candidateSha,
       lastCheckpointTag: state.lastCheckpointTag,
     };
   }
   ```

Pass criterion: both `candidateSha` and `lastCheckpointTag` are non-null.

> Maps to **SC-004** + **FR-005**.

### 4.9 SC-007 — No new `attempt-*` branches

```bash
git -C /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce branch --list 'attempt-*' | wc -l
```

Pass criterion: this number equals `BASELINE_ATTEMPT_COUNT` from step 4.2. (The smoke run must not have minted any new ones. `capture/*` branches from Record Mode are out of scope for this count.)

> Maps to **SC-007**.

### 4.10 Sanity — Jump-to-Checkpoint and Go-Back still work

1. Left-click a commit tagged `checkpoint/*` on the Timeline.
2. If the working tree is dirty, the Go-Back confirmation modal must fire. Pick "Save" or "Discard" — both must complete cleanly.
3. After the jump, `git -C <project> log --oneline -1` shows the expected commit.

Pass criterion: jump succeeds; Go-Back confirmation appeared if dirty.

> Maps to **FR-003**.

## 5. Final hygiene

```bash
git -C /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce branch --list 'dex/*' --list 'attempt-*' | head -10
./scripts/prune-example-branches.sh   # only when ready — deletes >7d dex/* and >30d attempt/* branches
```

This is courtesy hygiene only — not required for the spec to pass, but keeps the example repo from accumulating cruft between smoke runs.

## Diagnostics if something fails

Per `.claude/rules/06-testing.md` §4f.6: click the **DEBUG badge** in the running app, copy `RunID` and `PhaseTraceID`, then open `~/.dex/logs/<project>/<runId>/phase-<N>_*/agent.log` for the relevant phase. That is the fastest path from "the UI looks wrong" to the answer.

For renderer-side errors (React render exceptions, unhandled promise rejections in hooks), use `mcp__electron-chrome__list_console_messages` — those don't surface in `~/.dex/dev-logs/electron.log`.
