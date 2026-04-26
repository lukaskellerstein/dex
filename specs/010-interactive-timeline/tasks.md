---

description: "Task list for 010-interactive-timeline implementation"
---

# Tasks: Interactive Timeline — Click-to-Jump Canvas + Variant Agent Profiles

**Input**: Design documents from `/specs/010-interactive-timeline/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md

**Tests**: Tests are required for this feature — the spec's DoD (step 10) and the File table list four core test files (one extended, three new). Test tasks below follow TDD-where-pure-functions-allow: tests come first for new modules (`agent-profile.ts`, `agent-overlay.ts`, `jumpTo` core fn), and are updated alongside the rewrite for `timelineLayout`.

**Organization**: Grouped by user story (US1–US4) so each story can be implemented and validated independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Different file, no dependency on incomplete tasks → safe to run in parallel
- **[Story]**: Maps task to user story (US1, US2, US3, US4)
- All paths are absolute or repo-root-relative under `/home/lukas/Projects/Github/lukaskellerstein/dex/`

## Path Conventions

Standard Dex layout:
- `src/core/` — platform-agnostic engine (no Electron imports)
- `src/main/` — Electron main process + IPC handlers
- `src/renderer/` — React 18 renderer

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Sanity baseline before any 010 work lands.

- [X] T001 Verify clean baseline on the `010-interactive-timeline` branch — run `npx tsc --noEmit` from repo root and `npx tsx --test src/core/__tests__/runs.test.ts` (or the existing core test entry point) and confirm both pass before any new code is written. No new dependencies are added by this feature; do not modify `package.json`.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The data shape everything else depends on. Adds `commits[]` and `selectedPath[]` to `TimelineSnapshot` so US1's canvas, US2's Steps projection, US3's context menu, and US4's modal anchoring can all consume the same payload.

**⚠️ CRITICAL**: No US1–US4 task may begin until this phase is complete and `npx tsc --noEmit` passes.

- [X] T002 [P] Add `TimelineCommit` interface to `src/core/checkpoints.ts` per data-model.md §1 — fields: `sha`, `shortSha`, `branch`, `parentSha`, `step`, `cycleNumber`, `subject`, `timestamp`, `hasCheckpointTag`. Export it.
- [X] T003 Extend `TimelineSnapshot` interface in `src/core/checkpoints.ts` with `commits: TimelineCommit[]` and `selectedPath: string[]` (depends on T002).
- [X] T004 Implement `commits[]` population in `listTimeline()` in `src/core/checkpoints.ts`: enumerate every branch via `git for-each-ref refs/heads/`, run `git log <branch> --reverse --format='%H%x09%P%x09%s%x09%cI'` per branch, filter by step-commit subject pattern, parse `step` + `cycleNumber` from subject, mark `hasCheckpointTag` against the existing `checkpoints[].sha` set, deduplicate across branches by SHA, and sort ascending by `timestamp` (oldest-first iteration breaks ties for same-second commits) (depends on T003).
- [X] T005 Implement `selectedPath[]` population in `listTimeline()` in `src/core/checkpoints.ts`: run `git log --first-parent <headSha> --format='%H%x09%s'`, keep SHAs whose subject matches the step-commit pattern, return oldest-first (depends on T004).
- [X] T006 Update `checkpoints:listTimeline` IPC error fallback in `src/main/ipc/checkpoints.ts:82–96` to include `commits: []` and `selectedPath: []` so the renderer never sees `undefined` (depends on T003).
- [X] T007 [P] Update `src/renderer/electron.d.ts` to type `TimelineSnapshot.commits` and `TimelineSnapshot.selectedPath` — satisfied transitively (the file already imports `TimelineSnapshot` from `core/checkpoints.js`, so the new fields surface automatically).
- [X] T008 Extend tests with fixtures asserting (a) `commits[]` ordering by timestamp, (b) `selectedPath` derivation under linear and forked topologies, (c) WIP commits skipped from `commits[]`, (d) `hasCheckpointTag` flips after promote, (e) `commits[]` and `selectedPath` are arrays in the simple seeded case. Five new tests landed in `src/core/__tests__/checkpoints.test.ts` (rather than `timelineLayout.test.ts`, because these are producer-side `listTimeline` tests, not renderer layout tests).
- [X] T009 Run `npx tsc --noEmit` from repo root — clean. Run `npx tsx --test src/core/__tests__/checkpoints.test.ts` — 22/22 pass. Run `npx tsx --test src/core/__tests__/timelineLayout.test.ts` — 7/7 still pass (no regression).

**Checkpoint**: `TimelineSnapshot` carries the new fields end-to-end. US1, US2, US3, US4 may now begin in parallel.

---

## Phase 3: User Story 1 - Click-to-jump Timeline canvas (Priority: P1) 🎯 MVP

**Goal**: The Timeline panel is a real branching DAG where every step-commit is a labelled, clickable node. Left-click performs the right git op (no-op / checkout / fork). The right-side detail panel and the bottom past-attempts list are gone.

**Independent Test**: After Phase 2 + this phase ship, run quickstart.md steps 4–7 against `dex-ecommerce`. The Timeline shows branch columns with step-commit chains and edges, hover tooltips work, mid-branch click forks an `attempt-*` branch, branch-tip click checks out, dirty-tree click opens `<GoBackConfirm>`. Steps tab not yet projecting (still on raw orchestrator state) — this is OK; US2 wires that.

### Tests for User Story 1 (write before implementation)

- [X] T010 [P] [US1] Write `src/core/__tests__/jumpTo.test.ts` covering all branches of the decision tree per contracts/ipc-checkpoints-jumpTo.md: HEAD no-op, dirty-tree refusal (without `force`), unique-branch-tip → `action: "checkout"`, tip of multiple branches → `action: "fork"`, mid-branch ancestor → `action: "fork"`, not-found SHA → `error: "not_found"`, plus dirty+force=save and dirty+force=discard. 8 tests total. Confirmed RED before T012 landed (TDD).

### Implementation for User Story 1

- [X] T011 [US1] Add `JumpToResult` discriminated union to `src/core/checkpoints.ts`. Six variants per data-model.md §3.
- [X] T012 [US1] Implement `jumpTo(projectDir, targetSha, options?, rlog?)` in `src/core/checkpoints.ts`. Decision tree: noop on HEAD == target → not_found if SHA unresolvable → dirty_working_tree refusal (no force) → save/discard with force → unique branch-tip checkout via `git for-each-ref --points-at` → otherwise fork attempt branch.
- [X] T013 [US1] Run `npx tsx --test src/core/__tests__/jumpTo.test.ts` — all 8 tests pass (1 expected stderr line from the `not_found` git probe).
- [X] T014 [US1] Register `checkpoints:jumpTo` IPC handler in `src/main/ipc/checkpoints.ts` — lock-wrapped, forwards `options.force` through. Returns `JumpToResult | { ok: false; error: "locked_by_other_instance" }`.
- [X] T015 [US1] Expose `checkpoints.jumpTo` on `window.dexAPI` via `src/main/preload.ts`.
- [X] T016 [US1] Type `checkpoints.jumpTo` and import `JumpToResult` in `src/renderer/electron.d.ts`.
- [X] T017 [US1] Rewrite `src/renderer/components/checkpoints/timelineLayout.ts` end-to-end around branch columns + step-commit chain + reachability. New types: `ColorState`, simplified `TimelineNode` (`start | step-commit`), `LaidOutNode`/`LaidOutEdge`/`BranchColumn`/`LayoutOutput`. Anchor column is `startingPoint.branch` at index 0; remaining branches sorted by their first-commit timestamp. Edges: `within-column`, `branch-off`, `to-starting-point`.
- [X] T018 [US1] Replaced `src/core/__tests__/timelineLayout.test.ts` with 8 new fixtures: empty, anchor-only, linear, branch-off, variant fan-out, color states (selected/kept/both/default), anchor-column ordering, bounding box scaling. All pass.
- [X] T019 [US1] Rewrote `src/renderer/components/checkpoints/TimelineGraph.tsx` — branch column headers, three-color rendering (red ring + blue fill for `selected+kept`, etc.), left-click → `onJumpTo(sha)`, right-click → `onContextMenu(commit, position)` (US3 will wire), hover tooltip with full subject + branch + timestamp. Preserved `d3-zoom` pan/zoom and `d3-shape` `linkVertical` edge geometry.
- [X] T020 [US1] Simplified `src/renderer/components/checkpoints/TimelinePanel.tsx` — dropped `<NodeDetailPanel>` and `<PastAttemptsList>`, full-width graph, dirty-tree handling now uses `<GoBackConfirm>` against the target SHA (not a tag), `onTryNWaysAt(commit)` prop accepts the right-click commit (US3 hook).
- [X] T021 [US1] Trimmed `src/renderer/components/checkpoints/TimelineView.tsx` — dropped the now-unreachable `TryNWaysModal` and `AttemptCompareModal` wiring (their triggers lived on `<NodeDetailPanel>`). The modals' files remain on disk but are not imported here in v1; US3 re-wires `TryNWaysModal` via the right-click context menu, and US4 rebuilds its body. `AttemptCompareModal` stays unwired pending a future spec.
- [X] T022 [P] [US1] Deleted `src/renderer/components/checkpoints/NodeDetailPanel.tsx`. No surviving imports in `src/`.
- [X] T023 [P] [US1] Deleted `src/renderer/components/checkpoints/PastAttemptsList.tsx`. No surviving imports in `src/` (also confirmed `SelectedNode` type is no longer referenced anywhere).
- [X] T024 [US1] Manual UI verification via electron-chrome MCP — drove `dev-setup.sh` myself, opened `dex-ecommerce`, verified live: (a) Timeline canvas renders 138 step-commits across 5 branch columns from prior production history; (b) mid-branch click on `1c59911` → fork to fresh `attempt-<ts>` branch + branch-off edge correctly drawn; (c) tip-of-branch click on `0a8ceaf` → checkout `lukas/full-dex`; (d) dirty `GOAL.md` → `<GoBackConfirm>` modal opens with the file listed → Discard → retries with force, restores GOAL.md cleanly, jumps to target. **Two production bugs caught and fixed in flight**: (1) `useTimeline.ts` initial `EMPTY` state was missing `commits: []` / `selectedPath: []` — caused renderer crash before first IPC fetch; (2) `jumpTo` originally used `isWorkingTreeDirty` which flags untracked noise (`.dex/state.lock`) — replaced with a tracked-only check (`git status --porcelain --untracked-files=no`) per spec FR-011 wording. After fixes, all 8 jumpTo unit tests still green and live verification passes.

**Checkpoint**: User Story 1 is fully functional and independently testable. The Timeline canvas is rebuilt; click-to-jump works; old side panels are gone.

---

## Phase 4: User Story 2 - Steps tab projects from Timeline selection (Priority: P2)

**Goal**: The Steps tab renders status from `selectedPath` instead of raw orchestrator state. Switching Timeline nodes redraws Steps automatically. The `pause-pending` indicator (orange pause-circle) appears on the next unstarted row when `state.status === "paused"`.

**Independent Test**: After Phase 2 + this phase ship, run quickstart.md step 13 against `dex-ecommerce`. Pause an autonomous run mid-cycle; confirm Steps shows completed stages as `done`, current as `paused`, next as `pause-pending`. Click an earlier Timeline node; Steps shrinks to reflect the shorter path.

### Implementation for User Story 2

- [X] T025 [US2] Modified `src/renderer/components/loop/StageList.tsx` — `deriveStageStatus` now takes `pathStages: ReadonlySet<StepType>` and `pausePendingStage: StepType | null`. The selectedPath overlay returns `completed` when the orchestrator has no record but the active path's commit history says the stage ran (covers the navigation case where useOrchestrator is pinned to a different run). New `pause-pending` status with a dashed-orange `<PauseCircle>` icon and "next on resume" tag. Plumbs into the existing rich derivation (cost/duration, sub-phases, skipped, failed) without regressing those.
- [X] T026 [US2] Skipped surgery on `src/renderer/components/loop/ProcessStepper.tsx` — its existing `deriveActivePhase` already accounts for completed pre-cycle stages and cycles, so once `pathStages` overlay propagates "completed" into per-cycle StageList rows, the macro-phase derivation upstream re-evaluates correctly. No code change needed.
- [X] T027 [US2] Wired `useTimeline` directly inside `LoopDashboard` (not via prop) so the snapshot's `selectedPath` + `commits` drive a `pathStagesByCycle: Map<cycleNumber, Set<StepType>>` memo. That map flows through `<LoopPhaseView>` → `<CycleTimeline>` → `<CycleTimelineItem>` → `<StageList pathStages>`. Two `useTimeline` instances now exist (TimelinePanel + LoopDashboard), each polling every 30s; the IPC backend keeps them consistent.
- [ ] T028 [US2] Manual UI verification via electron-chrome MCP — **partially deferred**: code paths are in place and `tsc --noEmit` clean + 40/40 core tests pass; Timeline tab still renders unchanged after the new `useTimeline` consumer in `LoopDashboard`. Visual verification of `pause-pending` requires an actually-paused autonomous run, which dex-ecommerce currently has none of (no `.dex/runs/` records). The user can verify the orange "next on resume" indicator the next time they pause a real run.

**Checkpoint**: Steps tab is a pure projection of `selectedPath` plus orchestrator state. Timeline navigation drives Steps automatically.

---

## Phase 5: User Story 3 - Right-click context menu (Priority: P2)

**Goal**: Less-frequent verbs (Keep this / Unmark kept / Try N ways from here) move from the side panel to a right-click context menu on the Timeline. Single-click stays on jump-to. The menu is the only way to mutate kept-state from the canvas.

**Independent Test**: After Phase 2 + this phase, run quickstart.md step 8. Right-click a step-commit; menu shows Keep + Try N ways. Click Keep; tag created, red ring appears. Right-click same node; menu now shows Unmark + Try N ways. Click Unmark; tag gone, red ring removed.

### Implementation for User Story 3

- [X] T029 [US3] Created `src/renderer/components/checkpoints/CommitContextMenu.tsx` — fixed-position menu with conditional Keep/Unmark + always-on "Try N ways from here". Closes on outside click (deferred listener attach so the right-click that opens it doesn't immediately close it) and Escape. Position clamps to viewport. Lucide `<Bookmark>`, `<BookmarkMinus>`, `<GitBranch>` icons.
- [X] T030 [US3] Right-click handler in `<TimelineGraph>` was already wired in US1 via `onContextMenu(commit, position)`. `<TimelinePanel>` now subscribes via local `menu` state and renders `<CommitContextMenu>` when set.
- [X] T031 [US3] **Keep this** wired to `window.dexAPI.checkpoints.promote(projectDir, tagFor(step, cycle), sha)` using a renderer-local `tagFor` helper that mirrors `core.checkpointTagFor`. **Unmark kept** wired to a NEW IPC `checkpoints:unmark` (lock-wrapped) backed by a new core fn `unmarkCheckpoint(projectDir, sha)` — finds every canonical step tag at the SHA (`parseCheckpointTag` filter), deletes them, leaves `checkpoint/done-*` and any other system tags alone. Two new regression tests in `checkpoints.test.ts`.
- [X] T032 [US3] **Try N ways from here** wired through `TimelinePanel.onTryNWaysAt` → `TimelineView`. The handler auto-promotes the commit (silently creating `checkpoint/cycle-N-after-<step>` if not already kept) so the existing 008 `TryNWaysModal` (which still expects a tag) can open with a valid `fromCheckpoint`. US4 rebuilds the modal to accept a SHA directly and drops this stitch.
- [X] T033 [US3] Manual UI verification — Right-click on `959934d` (specify, cycle 1) opened menu with Keep + TryNWays. Click Keep → `checkpoint/cycle-1-after-specify` tag created → red ring rendered on canvas. Right-click same node → menu now shows Unmark + TryNWays (no Keep). Click Unmark → tag deleted → red ring removed. Click Try N ways → auto-promoted, modal opened with `next step: plan` correctly derived. All five US3 acceptance scenarios pass live.

**Checkpoint**: Right-click produces the context menu; Keep / Unmark / Try N ways verbs work; left-click navigation (US1) is unaffected.

---

## Phase 6: User Story 4 - Per-variant Agent Profiles (Priority: P2)

**Goal**: Agent Profiles are folders on disk under `<projectDir>/.dex/agents/<name>/`. The Try-N-ways modal lets users pick a profile per variant. On worktree-friendly stages, the profile's `.claude/` is overlaid into the variant's worktree before the runner spawns. On sequential stages, only the Dex-side knobs (model / systemPromptAppend / allowedTools) apply, and the modal warns the user.

**Independent Test**: After Phase 2 + this phase, run quickstart.md steps 9–12 against `dex-ecommerce` with the three seeded profiles (`conservative`, `standard`, `innovative`). Confirm three attempt branches spawn, each in its own worktree, with the profile's `.claude/` content overlaid (or project default for `standard`). Project root's `.claude/` remains byte-for-byte unchanged (SC-007).

### Tests for User Story 4 (write before implementation)

- [X] T034 [P] [US4] Wrote `src/core/__tests__/agentProfile.test.ts` — 17 tests covering parser, validator, listProfiles, loadProfile, saveDexJson. Confirmed RED before T036/T037 landed.
- [X] T035 [P] [US4] Wrote `src/core/__tests__/agentOverlay.test.ts` — 7 tests covering top-level copy, replace-not-merge, no-op for missing `.claude/` and `null` profile, SC-007 hash invariant, recursive nested copy, throws on missing worktree. Confirmed RED.

### Implementation for User Story 4 — Core

- [X] T036 [US4] Created `src/core/agent-profile.ts` exporting:
  - `AgentProfile` discriminated union (`ClaudeProfile | CodexProfile | CopilotProfile`) per data-model.md §4.
  - `dex.json` parser/validator (with the validation rules from research.md R-9 — yields `{kind: "ok", profile, overlaySummary} | {kind: "warn", folder, agentDir, reason}`).
  - `listProfiles(projectDir): ProfileEntry[]` — enumerates `<projectDir>/.dex/agents/`, sorted alphabetically, skips dot-folders, returns `[]` on missing dir.
  - `loadProfile(projectDir, name): AgentProfile | null` — single-folder convenience wrapper.
  - `saveDexJson(projectDir, name, dexJson): {ok: true} | {ok: false, error: string}` — atomic write per contracts/ipc-profiles.md (write to `.tmp` then `fs.renameSync`).
  - `OverlaySummary` builder (`buildOverlaySummary(agentDir): OverlaySummary`).
  - Persona-preset table (`PERSONA_PRESETS: { name: string; systemPromptAppend: string }[]`) — Conservative / Standard / Innovative entries, used by the modal as quick-fill buttons.
  Use `node:fs`, `node:path` only. No Electron, no main, no renderer imports. Depends on T002–T005 (Phase 2 foundational types).
- [X] T037 [US4] Created `src/core/agent-overlay.ts` exporting `applyOverlay(worktreePath, profile)` — `fs.readdirSync` the profile's runner-native subdir (`.claude/` for `claude-sdk`), `fs.cpSync` each top-level entry into `<worktreePath>/<subdir>/` with `recursive: true, force: true`. No-op when profile is `null`, has no runner-native subdir, or worktree path doesn't exist. Project root never touched.
- [X] T038 [US4] All 24 new tests pass on first run after T036 + T037 land.

### Implementation for User Story 4 — Spawn integration

- [X] T039 [US4] Extended `VariantSpawnRequest` with `profiles?: Array<{letter, profile: AgentProfile | null}>` in `src/core/checkpoints.ts`. Sparse-tolerant — missing letters default to null.
- [X] T040 [US4] `spawnVariants()` now early-rejects Codex/Copilot profiles with `"runner not implemented"`, then per parallel variant calls `applyOverlay(<absWorktreePath>, profile)` after `git worktree add`. Added `import path from "node:path"` and the agent-profile / agent-overlay imports.
- [X] T041 [US4] Extended `VariantGroupFile.variants[]` with optional `profile: { name, agentDir } | null`. The `checkpoints:spawnVariants` IPC handler populates it from `request.profiles`. Optional on read for backwards compatibility with pre-010 variant groups.

### Implementation for User Story 4 — Runner integration

- [X] T042 [US4] Modified `src/core/agent/AgentRunner.ts` to add `profile?: ClaudeProfile` and `worktreePath?: string` on both `StepContext` and `TaskPhaseContext`. `ClaudeAgentRunner.runStep` and `runTaskPhase` now compute `effectiveModel = profile?.model ?? config.model`, `effectiveCwd = worktreePath ?? config.projectDir`, prepend a `[Profile: <name>] <append>` block to the user prompt when `systemPromptAppend` is set, and pass `profile.allowedTools` through to the SDK's `allowedTools` option when present. Default behavior unchanged when both fields are undefined.
- [X] T043 [US4] `tsc --noEmit` clean + 66/66 core tests pass after the runner extension.

### Implementation for User Story 4 — IPC

- [X] T044 [P] [US4] Created `src/main/ipc/profiles.ts` — `profiles:list` (no lock) + `profiles:saveDexJson` (lock-wrapped). Backed by `listProfiles` / `saveDexJson` from `src/core/agent-profile.ts`.
- [X] T045 [US4] Registered `registerProfilesHandlers()` in `src/main/index.ts` alongside the other handlers.
- [X] T046 [P] [US4] Exposed `profiles.list` / `profiles.saveDexJson` on `window.dexAPI` via `src/main/preload.ts`.
- [X] T047 [P] [US4] Typed both APIs in `src/renderer/electron.d.ts`, importing `ProfileEntry` and `DexJsonShape` from `core/agent-profile.js`.

### Implementation for User Story 4 — UI

- [X] T048 [US4] Created `src/renderer/components/checkpoints/AgentProfileForm.tsx` — per-slot form with profile dropdown (ok pickable, warn folders shown beneath with reasons), model select (claude-opus/sonnet/haiku, plus passthrough for whatever the dex.json declares), three persona quick-fill buttons (Conservative / Standard / Innovative), free-form persona textarea, overlay-content chip ("2 skills · 1 subagent" / "CLAUDE.md" / "(no .claude/ overlay)"), "Save changes to profile" button. `disabledExceptDropdown` honored for Apply-same B/C…
- [X] T049 [US4] Rewrote the body of `src/renderer/components/checkpoints/TryNWaysModal.tsx`. Header has variant count (2–5) + "Apply same profile to all" toggle. Renders `<AgentProfileForm>` per visible slot (A, B, C, …). Sequential-stage warning banner shown when `nextStage` ∉ `{gap_analysis, specify, plan, tasks, learnings}` (using a renderer-local `PARALLELIZABLE_STEPS` set rather than calling into core, to keep the renderer's bundle small). Empty-profiles stub when no `kind: "ok"` entries exist. Cost-estimate footer preserved from the 008 modal. Save-back wired to `profiles:saveDexJson` IPC and refreshes the entries on success.
- [X] T050 [US4] Modal's "Run N variants" button assembles `request.profiles` from the per-slot state — `selectedName === null` → `null` (project default); otherwise builds a transient `ClaudeProfile` whose `agentDir` is `<projectDir>/.dex/agents/<name>`. `TimelineView.handleConfirmSpawn` builds + sends through the existing `checkpoints:spawnVariants` IPC.
- [X] T051 [US4] Manual UI verification — drove `dev-setup.sh`, opened `dex-ecommerce` with 3 seeded profiles (`conservative` Opus + CLAUDE.md, `standard` Sonnet no overlay, `innovative` Haiku + custom subagent). Right-clicked `959934d` (specify, cycle 1) → Try N ways. Modal opened with `next step: plan`. Selected A=conservative, B=standard, C=innovative — each row populated correctly from its `dex.json`. Clicked "Run 3 variants". **Verified live**: 3 attempt branches (`attempt-<ts>-{a,b,c}`), 3 worktrees, A's `.claude/CLAUDE.md` overlaid, B has no `.claude/` (correctly skipped), C's `.claude/agents/code-reviewer.md` overlaid. Variant-group state carries `profile.name` + `profile.agentDir` per variant. SC-007 trivially holds (project root has no `.claude/` to mutate; unit test covers the with-`.claude/` case). Right-clicked a `tasks` step-commit → modal showed orange sequential-stage warning banner. Hid `.dex/agents/` → modal showed empty-profiles stub. All 8 US4 acceptance scenarios pass live.

**Checkpoint**: All four user stories are independently functional. The full feature is integrated.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Final validation across all stories.

- [X] T052 `npx tsc --noEmit` from repo root — clean across all 010 work.
- [X] T053 Full core test suite — `timelineLayout` (8) + `jumpTo` (10) + `checkpoints` (24) + `agentProfile` (17) + `agentOverlay` (7) = **66 / 66 pass**.
- [X] T054 Quickstart steps 4–12 driven live during US1, US3, and US4 verification (canvas + click-to-jump + dirty modal + Keep/Unmark + Try-N-ways with 3 profiles + sequential warning + empty stub). Steps 0 (reset to clean) + 13 (pause + resume + orange `pause-pending`) deferred — visual verification of `pause-pending` requires an actually-paused autonomous run, which is a token spend the user controls.
- [X] T055 [P] SC-007 invariant: `dex-ecommerce` doesn't have a project-root `.claude/`, so the invariant trivially holds. The unit test in `agentOverlay.test.ts` covers the with-`.claude/` case using SHA-256 hashing.
- [ ] T056 [P] Smoke test of `pause-pending` deferred — same reason as T054 step 13.
- [X] T057 Branch hygiene — after each round of testing the user authorized the dex-ecommerce reset (`git checkout main` + `git branch -D` + `git worktree remove --force` + `git tag -d`). Final state of dex-ecommerce: on `main` @ `9e340e6`, 3 profile folders preserved under `.dex/agents/`, no attempt branches, no worktrees, no checkpoint tags from this session.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately.
- **Foundational (Phase 2)**: Depends on Setup. **Blocks all user stories.**
- **User Stories (Phase 3–6)**: All depend on Foundational completion.
  - US1 → US2 → US3 → US4 in priority order, **OR** all four in parallel if multiple developers are available.
  - US1 is the MVP — ship-able alone after Phase 2 + Phase 3.
- **Polish (Phase 7)**: Depends on all user stories shipped.

### Cross-task dependencies inside a story

- **Phase 2**: T002 → T003 → T004 → T005 → T008 (T006 + T007 + T009 may run in parallel with T008 once T003 lands).
- **US1 (Phase 3)**: T010 [P] writes the test FIRST. T011 → T012 → T013 → T014 → T015 → T016 (sequential — IPC chain). T017 needs T002–T005. T018 needs T017. T019 needs T016 + T017. T020 → T021 → T022/T023 [P]. T024 last.
- **US2 (Phase 4)**: T025 [P] T026 [P] (different files), then T027 (LoopDashboard wiring), then T028.
- **US3 (Phase 5)**: T029 first (component file), then T030, T031, T032 (different concerns inside `TimelineGraph` and CommitContextMenu props), then T033 last.
- **US4 (Phase 6)**: T034 [P] T035 [P] (tests, different files) → T036 (agent-profile core) → T037 (agent-overlay, depends T036) → T038 (run tests). Then spawn integration: T039 → T040 → T041. Then runner: T042 → T043. Then IPC: T044 [P] T046 [P] T047 [P], gated by T036; T045 needs T044. Then UI: T048 → T049 → T050 → T051.

### Inter-story dependencies

- **US1, US2, US3 are independent** of each other. Any one can ship after Phase 2.
- **US4 is independent** of US1/US2 in terms of code paths, but its UI verification (quickstart steps 9–12) depends on US3's right-click menu existing to invoke the modal in the first place. If US4 is built before US3, use the existing 008 entry point (the LoopDashboard's "Try N ways" button if present) for verification.

### Within Each User Story

- Tests (where listed before implementation) are TDD-style for new pure functions: write, watch fail, implement, watch pass.
- Models / types before services / functions.
- Core fns before IPC handlers before preload bindings before renderer consumption.
- Each user story's phase ends with a manual UI verification task that exercises the spec's acceptance scenarios.

### Parallel Opportunities

- **Phase 2**: T002 + T007 [P] (different files, T007 is just type-doc); T008 + T009 once T002–T005 land.
- **US1**: T010 [P] in parallel with T011 (test file vs. impl file). T022 [P] + T023 [P] (deletes of two different files).
- **US4**: T034 [P] + T035 [P] (two test files). T044 [P] + T046 [P] + T047 [P] (different files: ipc/profiles.ts, preload.ts, electron.d.ts). All four user stories themselves can be paralleled across developers if Phase 2 is done.
- **Phase 7**: T055 [P] + T056 [P] (independent verifications).

---

## Parallel Example: Foundational Phase

```text
After T002 lands:
  Task: "T003 Extend TimelineSnapshot with commits + selectedPath in src/core/checkpoints.ts"
After T003 lands:
  Task: "T006 Update IPC error fallback in src/main/ipc/checkpoints.ts"  (parallel branch A)
  Task: "T007 [P] Update electron.d.ts typings"                            (parallel branch B)
After T005 lands:
  Task: "T008 Extend timelineLayout.test.ts fixtures"
```

## Parallel Example: User Story 4 — Tests First

```bash
# Both tests can run concurrently against the (failing) absence of the modules:
Task: "T034 [P] [US4] Write src/core/__tests__/agentProfile.test.ts"
Task: "T035 [P] [US4] Write src/core/__tests__/agentOverlay.test.ts"
```

## Parallel Example: User Story 4 — IPC fan-out

```bash
# After T036 + T044 land, the preload + types + form work three different files:
Task: "T046 [P] [US4] Expose profiles.list / saveDexJson in src/main/preload.ts"
Task: "T047 [P] [US4] Type the new APIs in src/renderer/electron.d.ts"
Task: "T048 [US4] Create src/renderer/components/checkpoints/AgentProfileForm.tsx"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Complete Phase 1: Setup (T001).
2. Complete Phase 2: Foundational (T002–T009) — `TimelineSnapshot.commits` + `selectedPath` end-to-end.
3. Complete Phase 3: User Story 1 (T010–T024) — Timeline canvas rebuilt; click-to-jump works; old side panels deleted.
4. **STOP and VALIDATE**: Run quickstart.md steps 4–7. The Timeline is usable; Steps tab still on raw orchestrator state but functionally OK.
5. Demo or ship if the visible Steps misalignment is acceptable for an interim release.

### Incremental Delivery (recommended)

1. Setup + Foundational → Foundation ready.
2. Add US1 → MVP (Timeline canvas usable).
3. Add US2 → Steps and Timeline agree.
4. Add US3 → Right-click verbs.
5. Add US4 → Per-variant agent profiles.
6. Each addition is independently testable; the manual-verification task at the end of each phase IS the deploy gate.

### Parallel Team Strategy

- Developer A: US1 (canvas + jumpTo) — heaviest, owns `TimelineGraph` + `timelineLayout`.
- Developer B: US2 (Steps projection) + US3 (right-click) — both small, both renderer-only.
- Developer C: US4 (Agent Profiles) — can start in parallel; the spawn-integration and runner-integration touch core files that don't conflict with US1's canvas work.
- All converge in Phase 7 polish.

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks.
- [Story] label maps each task to its user story for traceability.
- Each user story is independently completable and testable; cross-story integration is not a hard prerequisite.
- For new pure-function modules (`agent-profile.ts`, `agent-overlay.ts`, `jumpTo`), tests come first per the project's TDD discipline.
- For UI rewrites (`TimelineGraph`, `TryNWaysModal`), the manual MCP verification task at the end of each phase IS the test — assertions against the spec's acceptance scenarios.
- No `git commit` is performed automatically by these tasks. The user runs the `/speckit.git.commit` hook (or commits manually) when ready.
- Do not modify `package.json` — this feature adds zero dependencies.
- Stop at any per-phase Checkpoint to validate independently before proceeding.
- Avoid: vague tasks, same-file conflicts marked [P], cross-story dependencies that break independence, speculative refactors.
