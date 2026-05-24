---

description: "Task list for 014 — Branch Management (Delete + Promote-to-Main with AI-resolved conflicts)"
---

# Tasks: Branch Management — Delete and Promote-to-Main with AI-Resolved Conflicts

**Input**: Design documents from `/home/lukas/Projects/Github/lukaskellerstein/dex/specs/014-branch-management/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ipc-deleteBranch.md, contracts/ipc-mergeToMain.md, contracts/runOneShot.md, contracts/conflict-resolver-events.md, quickstart.md
**Tests**: Required. The source design doc names three test files (`branchOps.test.ts`, `conflictResolver.test.ts`, `runOneShot.test.ts`) and Constitution III (Test Before Report) makes verification non-optional. Tests are interleaved into the per-story phases below, scheduled to land alongside (not strictly before) the implementation they cover.

**Organization**: Tasks are grouped by user story so each story is independently completable. The MVP is **US1 + US2** (delete + clean-merge promote) — those alone restore the timeline as a self-contained surface for the common case. **US3 + US4** ship AI conflict resolution and its failure-escape modal as a second slice.

**Format**: `- [ ] [TaskID] [P?] [Story?] Description with file path`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Verify the working tree is on the right branch and the dev environment is healthy. No new project structure is introduced — this feature lives entirely inside the existing `src/{core,main,renderer}` tree.

- [x] T001 Verify the current branch is `014-branch-management` and `dev-setup.sh` is running (`~/.dex/dev-logs/electron.log` exists; `mcp__electron-chrome__list_pages` returns at least one page). If not, fix before proceeding.
- [x] T002 Reset the example project to a known checkpoint for first-time integration testing: `./scripts/reset-example-to.sh cycle-2-after-tasks` (run from repo root). Confirm `/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce` is on a fresh `attempt-<ts>` branch and `git log` shows the checkpoint history.

**Checkpoint**: Dev tooling is live and the example project is in a deterministic state. No code has been written yet.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Create the single shared module every story's UI imports.

**⚠️ CRITICAL**: Every UI story (US1–US4) imports from `branchOps/copy.ts`. Build it first so per-story modal tasks can run truly in parallel.

- [x] T003 [P] Create `src/renderer/components/checkpoints/branchOps/copy.ts` with the full string table from spec.md "Voice and copy" plus FR-028's allowlist annotations. Export named constants per concept: `DELETE_TOOLTIP`, `LOST_WORK_TITLE`, `PROMOTE_MENU_ITEM`, `PROMOTE_CONFIRM_TITLE`, `MERGE_IN_PROGRESS`, `RESOLVER_PROGRESS_TITLE`, `RESOLVER_PROGRESS_ITERATION`, `RESOLVER_SUCCESS_TOAST`, `RESOLVER_FAILURE_TITLE`, `POST_MERGE_TOAST`, `NON_CONTENT_CONFLICT_MESSAGE`, plus the three failure-modal labels (`ACCEPT_AI_RESULT`, `ROLLBACK_MERGE`, `OPEN_IN_EDITOR`). Inline `// allowed: failure-modal label` comments on the three legacy-jargon strings the spec explicitly permits. No JSX, no React imports — pure constants module so it can be grep-tested in CI.

**Checkpoint**: Copy table is the single source of truth. User stories can begin in parallel from here.

---

## Phase 3: User Story 1 — Remove a saved version (Priority: P1) 🎯 MVP-A

**Goal**: Add a one-click delete control on every Dex-owned timeline badge (`dex/*` + `selected-*`). Subsume the existing `unselect` surface. Honor mid-run safety, lost-work warning, HEAD-on-target switch-to-main.

**Independent Test**: Following quickstart Recipes 1A–1E end-to-end on `dex-ecommerce`, every recipe passes. Specifically: clean delete works, lost-work modal lists the right steps with short SHAs, mid-run delete is refused, no delete control renders on `main`/`master`/user branches.

### Implementation for User Story 1

- [x] T004 [US1] Create `src/core/checkpoints/branchOps.ts` with `deleteBranch(projectDir, branchName, opts?)` per `contracts/ipc-deleteBranch.md`. Includes the deletable-set check (`dex/*` + `selected-*`), HEAD-on-target detection + switch to `main` (fallback `master`, else return `no_primary_to_switch_to`), lost-work commit enumeration via `git log <branch> --not --branches=main --branches=master --branches='dex/*' --branches='selected-*'`, mapping each SHA to a `LostStep` (parse `[checkpoint:<stage>:<cycle>]` trailer; fall back to truncated commit subject), `confirmedLoss` opt-out path, mid-run `state.json` read for `branch_in_active_run`. Use `gitExec`/`safeExec` from `_helpers.ts`. Returns the discriminated `DeleteBranchResult` from data-model.md.
- [x] T005 [US1] Delete `unselect()` function and its export from `src/core/checkpoints/jumpTo.ts` (lines 7–56, including the import comment). Keep `maybePruneEmptySelected` and `jumpTo` untouched. Update the file header comment to remove the "(unselect)" mention.
- [x] T006 [US1] In `src/core/checkpoints/index.ts`, drop the `unselect` re-export and add `deleteBranch` (both flat and via the `checkpoints` namespace). Verify the namespace export still compiles.
- [x] T007 [US1] In `src/main/ipc/checkpoints.ts`: remove the `checkpoints:unselect` handler (lines 108–112), add a `checkpoints:deleteBranch` handler that wraps `deleteBranch(...)` in `withLock(projectDir, ...)`, takes `(projectDir, branchName, opts?)` from the renderer, and returns the raw result.
- [x] T008 [US1] In `src/main/preload-modules/checkpoints-api.ts`: drop the `unselect` IPC bridge (line 11), add `deleteBranch: (projectDir, branchName, opts?) => ipcRenderer.invoke("checkpoints:deleteBranch", projectDir, branchName, opts)`.
- [x] T009 [US1] In `src/renderer/electron.d.ts`: remove the `unselect` method type, add `deleteBranch(projectDir: string, branchName: string, opts?: { confirmedLoss?: boolean }): Promise<DeleteBranchResult>` plus the imported `DeleteBranchResult` and `LostStep` types.
- [x] T010 [P] [US1] Create `src/renderer/components/checkpoints/DeleteBranchConfirm.tsx` — modal that takes `lostSteps: LostStep[]` and `onConfirm`/`onCancel` callbacks. Uses the existing `<Modal>` primitive and pulls strings from `branchOps/copy.ts` (`LOST_WORK_TITLE`, etc.). Skip rendering when `lostSteps.length === 0` (caller decides to short-circuit).
- [x] T011 [US1] In `src/renderer/components/checkpoints/TimelineGraph.tsx`: rename the `onUnselect` prop to `onDeleteBranch`; render the ✕ control on every `dex/*` and `selected-*` badge (not just `selected-*`); change the testid pattern from `unselect-<branch>` to `delete-branch-<branch>`; the tooltip reads `DELETE_TOOLTIP` from copy.ts. Hide the control entirely on `main`, `master`, and any branch outside the deletable set (defense-in-depth — the IPC also rejects).
- [x] T012 [US1] In `src/renderer/components/checkpoints/TimelinePanel.tsx`: replace the unselect call site with `window.dexAPI.deleteBranch(...)`. On a `would_lose_work` result, render `<DeleteBranchConfirm>`, then re-call with `opts.confirmedLoss: true` on confirm. On `branch_in_active_run`, surface the friendly message from copy.ts via the existing toast/banner mechanism. After every successful deletion, refresh the timeline via the existing `checkpoints:listTimeline` IPC.
- [x] T013 [P] [US1] Create `src/core/__tests__/branchOps.test.ts` with `node:test` (matches the existing `test:core` runner). Cover: deletable-set rejection (`main`, `master`, user branches), HEAD-on-target switches to `main`, HEAD-on-target falls back to `master` when `main` absent, `no_primary_to_switch_to` when both absent, lost-work detection produces `LostStep[]` with correct labels and short SHAs, `confirmedLoss: true` skips the lost-work check, `branch_in_active_run` returns when `state.json.status === "running"` and `currentBranch === target`. Use temporary git repos in `os.tmpdir()` (pattern matches existing `jumpTo.test.ts`).
- [x] T014 [US1] Run quickstart Recipes 1A–1E end-to-end via `mcp__electron-chrome__*`. Capture pass/fail per recipe in the implementation PR description. If anything fails, fix before marking the phase complete.

**Checkpoint**: Delete works for all five recipes. The `unselect` surface is gone. Branch hygiene is restored without leaving the app.

---

## Phase 4: User Story 2 — Promote (clean merge) (Priority: P1) 🎯 MVP-B

**Goal**: Right-click a Dex-owned badge → "Make this the new main". Always uses `git merge --no-ff` to preserve fork-and-rejoin. Clean-merge path only — conflict path lives in US3.

**Independent Test**: Quickstart Recipes 2A–2D pass. Specifically: clean merge produces the right merge commit + topology + no `checkpoint/promoted-*` tag, mid-run promote is refused, dirty-tree-save flow integrates with `<GoBackConfirm>`, the context menu item is disabled on `main`/`master`/user branches.

### Implementation for User Story 2

- [x] T015 [US2] Extend `src/core/checkpoints/branchOps.ts` with `mergeToMain(projectDir, sourceBranch, opts?)` per `contracts/ipc-mergeToMain.md`. **Clean-merge path only** — leave the conflict-handoff `TODO` for US3. Implements: deletable-set check, mid-run check (refuses if running on `main` or `sourceBranch`), no-primary check, dirty-tree handling (returns `dirty_working_tree` when `force` undefined; runs autosave or discard via the same logic as `jumpTo`'s force), checkout main, `git merge --no-ff --no-commit <source>` execution, on clean (no `CONFLICT` lines from `git status --porcelain`) commit with subject `dex: promoted <source> to main` and no extra tag, post-merge actions (delete source branch with `git branch -D`, ensure HEAD on main).
- [x] T016 [US2] Add `checkpoints:mergeToMain` handler in `src/main/ipc/checkpoints.ts`. Wraps `mergeToMain(...)` in `withLock(projectDir, ...)`. Takes `(projectDir, sourceBranch, opts?)`.
- [x] T017 [US2] Add `mergeToMain` to `src/main/preload-modules/checkpoints-api.ts` (`(projectDir, sourceBranch, opts?) => ipcRenderer.invoke("checkpoints:mergeToMain", projectDir, sourceBranch, opts)`) and the matching method type to `src/renderer/electron.d.ts` plus the imported `MergeToMainResult` and `MergeToMainOpts` types.
- [x] T018 [P] [US2] Create `src/renderer/components/checkpoints/BranchContextMenu.tsx` — small floating menu opened by right-click on a badge. v1 has one item: "Make this the new main" (label from `copy.ts:PROMOTE_MENU_ITEM`). Disabled with tooltip when target branch is `main`, `master`, or outside the deletable set. Closes on outside-click and Escape.
- [x] T019 [P] [US2] Create `src/renderer/components/checkpoints/PromoteConfirm.tsx` — modal that takes `summary: { fileCount, added, removed, topPaths, expandedFullList }` and `onConfirm`/`onCancel` callbacks. Uses copy.ts strings. The "View all changes" expander lazy-loads the full path list (caller passes a `loadFullList()` async function — only called on expander open). Renders inside the existing `<Modal>` primitive.
- [x] T020 [US2] Add a "compute promote summary" helper alongside `mergeToMain` in `branchOps.ts` (named `computePromoteSummary(projectDir, sourceBranch)`). Calls `git diff --shortstat <main>...<source>` for counts and `git diff --name-only <main>...<source>` for paths (top 5 + lazy full list). Returns `{ fileCount, added, removed, topPaths, fullListLoader }`. Exposed as a separate IPC `checkpoints:promoteSummary` so the renderer pre-fetches it for the confirm modal without committing to the merge.
- [x] T021 [US2] In `src/renderer/components/checkpoints/TimelineGraph.tsx`: add a right-click handler to every badge that opens `<BranchContextMenu>` anchored to the badge's bounding rect. Pass the branch name + a callback (`onPromoteRequest`) up to `TimelinePanel`.
- [x] T022 [US2] In `src/renderer/components/checkpoints/TimelinePanel.tsx`: handle `onPromoteRequest` — call `checkpoints:promoteSummary`, render `<PromoteConfirm>` with the result, on confirm call `mergeToMain`. On `dirty_working_tree`, fall back to the existing `<GoBackConfirm>` (Save / Discard / Cancel) and re-call `mergeToMain` with `opts.force` matching the user's choice. On `branch_in_active_run` / `main_in_active_run` / `not_dex_owned` / `no_primary_branch`, surface the friendly message from copy.ts. On clean success, show the `POST_MERGE_TOAST`.
- [x] T023 [P] [US2] Extend `src/core/__tests__/branchOps.test.ts` with `mergeToMain` clean-merge cases: clean merge produces the expected merge commit (parent count = 2), source branch is deleted, HEAD lands on main, no new tag is created (regression), `branch_in_active_run` and `main_in_active_run` are honoured, `not_dex_owned` rejects user branches, `dirty_working_tree` returns when `force` undefined.
- [x] T024 [US2] Run quickstart Recipes 2A–2D end-to-end. Capture screenshots of `<BranchContextMenu>` and `<PromoteConfirm>` for the PR.

**Checkpoint**: Clean-merge promote works end-to-end. Together with US1, the timeline is now a self-contained surface for the common case. **MVP scope is complete here.**

---

## Phase 5: User Story 3 — AI conflict resolution (Priority: P2)

**Goal**: When `mergeToMain` detects content conflicts, hand off to a new `AgentRunner.runOneShot` invocation harness that resolves them file-by-file, runs the project's verify command, and finalizes the merge — with a live progress modal.

**Independent Test**: Quickstart Recipes 3A–3E pass. Resolver iterates per file, succeeds on routine cases (single + multi file), rolls back on cancel, aborts before invoking the agent on non-content conflicts, halts at the cost cap.

### Implementation for User Story 3

- [x] T025 [P] [US3] Add `runOneShot(ctx: OneShotContext): Promise<OneShotResult>` to the `AgentRunner` interface in `src/core/agent/AgentRunner.ts` plus the `OneShotContext` and `OneShotResult` types per `data-model.md §1` and `contracts/runOneShot.md`. Pure interface change — implementations come next.
- [x] T026 [P] [US3] Implement `runOneShot` in `src/core/agent/MockAgentRunner.ts` per `contracts/runOneShot.md`. Look up `ctx.prompt` against `MockConfig.oneShotResponses` (string-exact-match or regex). On match: honour `editFile.path`/`content` (write before returning), `delayMs` (`await setTimeout(...)`), and the result fields. On no match: return the documented permissive default (`finalText: "(mock default — no oneShotResponses entry matched)"`, `finishedNormally: true`).
- [x] T027 [P] [US3] Implement `runOneShot` in `src/core/agent/ClaudeAgentRunner.ts` per `contracts/runOneShot.md`. Thin wrapper over `query()` from `@anthropic-ai/claude-agent-sdk`: assemble the project's resolved system prompt + `systemPromptOverride`, pass `cwd`, `allowedTools`, `maxTurns ?? 1`, `abortSignal`. Consume the async iterator: capture `lastAssistantText` from `assistant` messages; capture cost / tokens / `durationMs` from the final `result` message; mark `finishedNormally = true`. On error/abort events, mark `finishedNormally = false` and rethrow if the abort came from `ctx.abortController`.
- [x] T028 [P] [US3] Extend `src/core/agent/MockConfig.ts` with the `oneShotResponses?: MockOneShotResponse[]` field per `contracts/runOneShot.md`. Add JSON-schema validation in the existing `parseMockConfig` flow.
- [x] T029 [P] [US3] Create `src/core/agent/__tests__/runOneShot.test.ts` (uses `node:test`). Test that `MockAgentRunner.runOneShot` matches scripted responses (string-exact, regex), applies `editFile` writes to the resolved cwd, honours `delayMs`, returns the documented default on unmatched prompts. Skip live `ClaudeAgentRunner` tests in CI (rely on the resolver tests for integration coverage).
- [x] T030 [US3] Extend `src/core/dexConfig.ts` with the `conflictResolver?: Partial<ConflictResolverConfig>` field, the `DEFAULT_CONFLICT_RESOLVER_CONFIG` constant per `data-model.md §4`, and validation (`maxIterations >= 1`, `maxTurnsPerIteration >= 1`, `costCapUsd >= 0`, `verifyCommand` string-or-null with empty-string normalised to null). Loader merges field-by-field over the defaults. Add tests in `src/core/__tests__/dexConfig.test.ts` covering each invalid value.
- [x] T031 [P] [US3] Create `src/core/conflict-resolver.ts` exporting `resolveConflicts(ctx: ResolverContext): Promise<ResolverResult>` per `data-model.md §3` and `contracts/conflict-resolver-events.md`. Iterates `conflictedPaths`: for each file, builds the per-file prompt per `research.md R4` (markers + last-5 commit subjects per side + truncated `GOAL.md`), calls `runner.runOneShot` with `allowedTools: ["Read", "Edit"]`, `cwd: projectDir`, `maxTurns: config.maxTurnsPerIteration`. After each call, re-reads the file and checks for residual `<<<<<<<`/`=======`/`>>>>>>>` markers; emits `file-done` accordingly. Tracks cumulative cost; halts before the next iteration if `costSoFar + estimate > costCapUsd`. After all files DONE, runs `config.verifyCommand` (skipped when `null`); on non-zero exit code, returns `{ ok: false, reason: "verify_failed", … }`. Emits the `conflict-resolver:*` events at the documented points.
- [x] T032 [P] [US3] Create `src/core/__tests__/conflictResolver.test.ts`. Scenarios: (a) clean single-file resolution, (b) clean multi-file resolution, (c) max-iterations exhausted, (d) cost-cap hit at iteration 2, (e) verify-command-fails path, (f) user-cancelled mid-iteration via `AbortController`, (g) `runOneShot` returns `finishedNormally: false` (agent gave up). Each scenario uses `MockAgentRunner` with scripted `oneShotResponses` and a temporary git repo with hand-crafted conflict markers.
- [x] T033 [US3] Wire `resolveConflicts` into `mergeToMain` in `src/core/checkpoints/branchOps.ts` (the conflict-detection branch left as `TODO` in T015). After `git merge --no-ff --no-commit`: if `git status --porcelain` shows unmerged paths, classify them (per `research.md R1`: XY-code dispatch + `git check-attr -a` binary check + `.gitmodules` submodule prefix check). On non-content conflict: run `git merge --abort` and return `{ ok: false, error: "non_content_conflict", kinds }`. Otherwise: instantiate the runner via the existing `AgentRunnerFactory`, build `ResolverContext`, call `resolveConflicts`. On success: stage all + commit with the canonical merge subject + run post-merge actions. On failure: leave the merge state in-progress (do not auto-abort) and return `{ ok: false, error: "resolver_failed", reason, partialMergeSha }` so the renderer's failure modal (US4) can offer accept/rollback.
- [x] T034 [US3] In `src/main/ipc/checkpoints.ts`: forward all `conflict-resolver:*` events from the harness's `EmitFn` to `webContents.send("orchestrator:event", evt)` for the duration of `mergeToMain`. Reuse the existing event-forwarding pattern used by other long-running IPCs.
- [x] T035 [P] [US3] Create `src/renderer/components/checkpoints/ConflictResolverProgress.tsx` per `contracts/conflict-resolver-events.md`. Subscribes to `orchestrator:event` via `window.dexAPI.onOrchestratorEvent`, filters `conflict-resolver:*`, reduces into `ResolverProgressState` (the documented shape). Renders iteration counter, current file (`Resolving disagreement #N of M…`), running cost, list of resolved files. Cancel button calls `window.dexAPI.abortResolverMerge(projectDir)`. Auto-closes on terminal `done` event with `ok: true`.
- [x] T036 [US3] In `src/renderer/components/checkpoints/TimelinePanel.tsx`: open `<ConflictResolverProgress>` automatically when `mergeToMain` is in flight and the first `conflict-resolver:*` event arrives. Close on terminal `done`. On `done` with `ok: true`: show the `RESOLVER_SUCCESS_TOAST` (with the resolved-file count). On `done` with `ok: false`: hand off to US4's `<ResolverFailureModal>` (until US4 lands, log a `console.warn` and fall back to a basic error banner).
- [x] T037 [US3] Run quickstart Recipes 3A–3E end-to-end. Capture progress modal screenshots; cross-reference resolver costs against `costCapUsd` in 3E.

**Checkpoint**: Conflict-bearing promotes complete fully in-app for the routine case. Failure path falls through to a temporary banner pending US4.

---

## Phase 6: User Story 4 — Failure escape paths (Priority: P3)

**Goal**: Three-button modal for when the resolver gave up. Wire the three follow-up IPCs (`acceptResolverResult`, `abortResolverMerge`, `openInEditor`).

**Independent Test**: Quickstart Recipes 4A–4D pass. Each button leaves the project in the documented state.

### Implementation for User Story 4

- [x] T038 [US4] Add `checkpoints:acceptResolverResult` handler in `src/main/ipc/checkpoints.ts`. Implementation: stages the working tree (`git add -A`), commits with subject `dex: promoted <source> to main` (source name comes from the in-flight merge's `MERGE_MSG` or a small piece of state the `mergeToMain` flow stashed before yielding), runs the post-merge actions (delete source, ensure HEAD on main), returns `{ ok: true, mergeSha }`. Wraps in `withLock`.
- [x] T039 [US4] Add `checkpoints:abortResolverMerge` handler in `src/main/ipc/checkpoints.ts`. Implementation: runs `git merge --abort`, returns `{ ok: true }`. Wraps in `withLock`. **Also called internally** by `mergeToMain` when a non-content conflict is detected (refactor T033 to call this same helper instead of duplicating `git merge --abort`).
- [x] T040 [US4] Add `checkpoints:openInEditor` handler in `src/main/ipc/checkpoints.ts`. Implementation: resolves `process.env.EDITOR`; on Linux falls back to `xdg-open`, on macOS to `open`. Spawns the editor with the conflicted file paths via `child_process.spawn` (detached, no stdio inheritance). Returns `{ ok: true }`. Does NOT call `git merge --abort` — the merge state is preserved so the user can re-call accept or abort after editing.
- [x] T041 [US4] In `src/main/preload-modules/checkpoints-api.ts` and `src/renderer/electron.d.ts`: add the three new methods (`acceptResolverResult(projectDir)`, `abortResolverMerge(projectDir)`, `openInEditor(projectDir, files)`).
- [x] T042 [P] [US4] Create `src/renderer/components/checkpoints/ResolverFailureModal.tsx`. Three buttons in the documented layout: "Accept what AI did" (primary), "Roll back the merge entirely" (secondary), "Open in editor" (small, bottom-right). Strings come from `copy.ts` (`ACCEPT_AI_RESULT`, `ROLLBACK_MERGE`, `OPEN_IN_EDITOR`). Takes `failedFiles: string[]` and three callbacks; calls the matching `window.dexAPI` IPC method on click.
- [x] T043 [US4] In `src/renderer/components/checkpoints/TimelinePanel.tsx`: replace the temporary "log + banner" fallback from T036 with `<ResolverFailureModal>`. On modal action: refresh the timeline, dismiss the modal, show the appropriate toast. After "Accept what AI did": show success toast (same as clean merge). After "Roll back the merge entirely": show neutral toast ("merge rolled back"). After "Open in editor": leave the modal open (the merge isn't resolved yet); user can re-trigger accept or rollback after editing.
- [x] T044 [US4] Run quickstart Recipes 4A–4D end-to-end. For 4A and 4D, modify `<projectDir>/.dex/dex-config.json` to set the relevant resolver caps before running; restore defaults afterwards.

**Checkpoint**: Every resolver failure mode lands the user in a coherent final state within one extra click. Feature is functionally complete.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Hygiene, type/test gates, documentation refresh.

- [x] T045 [P] Run the copy-hygiene grep from quickstart Recipe 5A. Confirm only the three explicitly-allowlisted strings in `copy.ts` contain forbidden words; everything else under `src/renderer/components/checkpoints/` is jargon-free. Fix any leak before closing the phase.
- [x] T046 [P] Run `npm run test:core && npm run test:renderer && npx tsc --noEmit && bash scripts/check-size.sh` (the full `npm test` chain). All green.
- [x] T047 Capture the visual catalog from quickstart Recipe 5C via `mcp__electron-chrome__take_screenshot`: ✕ tooltip, lost-work modal, promote diff modal, resolver progress, failure modal, post-merge timeline. Embed in the implementation PR description.
- [x] T048 Re-run `.specify/scripts/bash/update-agent-context.sh claude` to verify CLAUDE.md's "Active Technologies" line is still accurate after implementation; no manual edits between markers.
- [x] T049 Final end-to-end smoke: run quickstart Recipes 1A, 2A, 3A, 4A in sequence on a single fresh `dex-ecommerce` reset to confirm no regression between stories' state-management boundaries.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — runs first.
- **Phase 2 (Foundational)**: Depends on Phase 1. Blocks every UI task in Phases 3–6 (they all import `copy.ts`).
- **Phase 3 (US1)**: Depends on Phase 2. Independent of US2/US3/US4.
- **Phase 4 (US2)**: Depends on Phase 2. Independent of US1, but T015 extends `branchOps.ts` (created in T004), so US2 cannot start until T004 is done.
- **Phase 5 (US3)**: Depends on Phase 2 and Phase 4 (the conflict-handoff in T033 extends US2's `mergeToMain`). T030 (DexConfig extension) can start as soon as Phase 2 is done; T031 (resolver harness) depends on T025–T028 (`runOneShot` interface + impls).
- **Phase 6 (US4)**: Depends on Phase 5 (the failure modal opens on resolver-failed results from US3). T039 also reuses the abort helper introduced in T033, so T039 should land after T033.
- **Phase 7 (Polish)**: Depends on Phases 3–6 being complete.

### User Story Dependencies

- **US1**: Independent of all other stories. Can be merged and shipped alone.
- **US2**: Independent of US1 in concept (different IPC, different UI surface), but coexists in `branchOps.ts` and the same `TimelineGraph.tsx` / `TimelinePanel.tsx` files. Practical landing order: US1 → US2.
- **US3**: Builds on US2's conflict-detection branch. Cannot be tested before US2 ships clean-merge.
- **US4**: Wires the failure modal from US3's failure events into the three follow-up IPCs. Cannot be tested before US3 ships.

### Parallel Opportunities (within phases)

**Phase 2**: T003 alone — nothing else can run.

**Phase 3 (US1)**: After T004 lands, T010 (DeleteBranchConfirm modal) and T013 (tests) are file-disjoint and can run in parallel with T005–T009 (which are sequential by file dependency: jumpTo edit → checkpoints index → IPC handler → preload → electron.d.ts).

**Phase 4 (US2)**: After T015 lands, T018 (BranchContextMenu), T019 (PromoteConfirm), and T023 (test extension) can all run in parallel. T020 (compute summary helper) is in `branchOps.ts` so it serializes against T015 file-wise.

**Phase 5 (US3)**: T025–T029 are five distinct files (AgentRunner, MockAgentRunner, ClaudeAgentRunner, MockConfig, runOneShot.test.ts) — all five can run in parallel. T031 (conflict-resolver.ts) and T032 (conflictResolver.test.ts) can run in parallel with each other once T025–T028 land. T035 (ConflictResolverProgress) is independent of the core layer and can be built in parallel with T031–T032.

**Phase 6 (US4)**: T038/T039/T040 are three handlers in the same IPC file — sequential by file. T042 (ResolverFailureModal) is independent and runs in parallel.

**Phase 7 (Polish)**: T045 and T046 run in parallel.

---

## Parallel Example: User Story 3

```bash
# After Phase 2 completes, fan out the agent layer:
Task: "T025 — Add runOneShot to AgentRunner interface in src/core/agent/AgentRunner.ts"
Task: "T026 — Implement runOneShot in src/core/agent/MockAgentRunner.ts"
Task: "T027 — Implement runOneShot in src/core/agent/ClaudeAgentRunner.ts"
Task: "T028 — Extend MockConfig schema in src/core/agent/MockConfig.ts"
Task: "T029 — Create src/core/agent/__tests__/runOneShot.test.ts"

# Once those land:
Task: "T031 — Create src/core/conflict-resolver.ts (resolveConflicts harness)"
Task: "T032 — Create src/core/__tests__/conflictResolver.test.ts (scripted scenarios)"
Task: "T035 — Create src/renderer/components/checkpoints/ConflictResolverProgress.tsx"
```

---

## Implementation Strategy

### MVP (US1 + US2)

1. Phase 1 (T001–T002).
2. Phase 2 (T003).
3. Phase 3 — US1 (T004–T014). Validate via Recipes 1A–1E.
4. Phase 4 — US2 (T015–T024). Validate via Recipes 2A–2D.
5. **STOP**: at this point the user can delete saved versions and promote any version with no conflicts entirely from the timeline. This already satisfies the product pillar for the common case. Ship + demo.

### Conflict-Resolution Slice (US3 + US4)

6. Phase 5 — US3 (T025–T037). Validate via Recipes 3A–3E. The temporary fallback in T036 means resolver failures show a basic banner; that's acceptable for the slice's internal validation but blocks user-facing release until US4 lands.
7. Phase 6 — US4 (T038–T044). Validate via Recipes 4A–4D. Failure path is now coherent.
8. **STOP**: full feature shipped.

### Polish

9. Phase 7 (T045–T049). Run together as the PR-completion gate.

### Parallel Team Strategy

With multiple developers:

- **Dev A**: US1 (Phase 3) end-to-end.
- **Dev B**: US2 (Phase 4) — can start after T004 lands (file dependency on `branchOps.ts`); otherwise independent of A.
- **Dev C**: Pre-builds the agent layer (T025–T029) in parallel with US1+US2 — these touch `src/core/agent/` only.

After MVP ships:

- **Dev A**: US3 conflict-resolver harness (T030–T032).
- **Dev B**: US3 UI (T035–T036) and US4 (Phase 6) — can run in parallel with A's harness work because the resolver UI subscribes to events that A's harness will emit; the contract is fixed.

---

## Notes

- Every task lists at least one absolute file path. No task is implementation-ambiguous.
- `[P]` flags only tasks that touch a different file than every other task in the same phase **and** have no in-phase dependencies.
- Tests are interleaved per Constitution III; treat them as gates on the phase, not optional.
- The `unselect` deletion (T005–T008) is one logical operation across multiple files; land all four tasks in the same commit to avoid a transient broken-build window.
- Quickstart recipes are the canonical end-of-phase validation. If a recipe fails, fix before declaring the phase done — do not skip ahead.
- Constitution rules to keep in mind throughout: no `electron`/`src/main`/`src/renderer` imports inside `src/core/` (verified by `npm run check:size`); no git jargon in user-visible strings outside the three allowlisted entries in `copy.ts`; no commits without explicit user instruction.
