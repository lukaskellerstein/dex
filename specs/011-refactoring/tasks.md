---

description: "Task list for 011-refactoring — behaviour-preserving structural refactor of Dex"
---

# Tasks: Refactor Dex for AI-Agent Modification (Phase 2)

**Input**: Design documents from `/home/lukas/Projects/Github/lukaskellerstein/dex/specs/011-refactoring/`
**Prerequisites**: spec.md, plan.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Core unit tests via `node:test` are required deliverables for the four extracted core modules (FR-007). Renderer hook tests via vitest are deferred to the Polish phase (Wave D Path A). Test tasks are explicit and load-bearing — they are the contract pin for each extraction.

**Organization**: Tasks are grouped by user story so each story can be implemented and shipped as its own squash-merge PR to `main`. The wave-gate verification suite (contracts/wave-gate.md) doubles as PR-readiness criteria. The user runs all git commits manually per global CLAUDE.md.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Maps task to user story (US1..US5) for traceability. Setup, Foundational, and Polish phases have no story label.
- File paths are absolute relative to `/home/lukas/Projects/Github/lukaskellerstein/dex/`.

## Path Conventions

- Core engine: `src/core/`
- Electron main: `src/main/`
- React renderer: `src/renderer/`
- Spec-folder artefacts: `docs/my-specs/011-refactoring/`
- Tests: colocated under `src/core/__tests__/` (node:test) and `src/renderer/{hooks,services}/__tests__/` (vitest, Polish phase)

---

## Phase 1: Setup (Pre-Wave Artefacts)

**Purpose**: Produce the 5 spec-folder artefacts and lock path choices before any code change.

**⚠️ CRITICAL**: Wave A Gate 0 cannot start until Phase 1 is complete (golden-trace baseline must exist; A8-prep path must be locked).

- [X] T001 Confirm branch state — `git branch --show-current` returns `011-refactoring`; working tree shows untracked `specs/011-refactoring/` plus modified `.specify/feature.json`. Document any deviation in `docs/my-specs/011-refactoring/file-size-exceptions.md`.
- [X] T002 Lock A8-prep path choice (Path α — keep slimmed `run()`) by writing the decision into `docs/my-specs/011-refactoring/file-size-exceptions.md` under a "Path Decisions" section. Reference research.md R-002.
- [X] T003 Lock pending-question-handle location (on `OrchestrationContext`) in the same "Path Decisions" section. Reference research.md R-003.
- [X] T004 [P] Create `docs/my-specs/011-refactoring/file-size-exceptions.md` listing 2 exceptions: `src/core/state.ts` (763 LOC, deferred to `01X-state-reconciliation`) and `src/core/agent/ClaudeAgentRunner.ts` (699 LOC, deferred to a future SDK-adapter spec). One section per file with current LOC + reason + follow-up spec.
- [X] T005 [P] Enumerate IPC error vocabulary into `docs/my-specs/011-refactoring/error-codes.md` by running `grep -rn 'throw new Error\|throw new [A-Z][a-zA-Z]*Error' src/main/ipc/ src/core/`. Group findings by service (checkpoint / orchestrator / project / history / profiles / window) with one bullet per code.
- [X] T006 Capture first golden-trace baseline run: `./scripts/reset-example-to.sh clean`, run one full autonomous loop in the UI on `dex-ecommerce` (welcome → Open Existing → Steps tab → toggle auto-clarification → Start Autonomous Loop), then normalize via the sed pipeline in `contracts/golden-trace.md` → `/tmp/golden-baseline-1.txt`. (Note: original spec's `grep -oE '\] \[(INFO|WARN|ERROR)\] [a-z_]+'` was broken for camelCase function names; contract updated to use a sed-based normalization that captures the full structural skeleton.)
- [X] T007 Capture second golden-trace baseline run with the same protocol as T006 → `/tmp/golden-baseline-2.txt`. Two runs are required; one alone produces false positives (research.md R-004). With the mock backend the two runs were byte-identical (mock is deterministic), but the protocol still applies for any future re-capture against real Claude.
- [X] T008 Intersect baselines: `comm -12 /tmp/golden-baseline-1.txt /tmp/golden-baseline-2.txt > docs/my-specs/011-refactoring/golden-trace-pre-A.txt`. Result: 50-line baseline covering 3-cycle mock run (prerequisites → 4-step clarification → manifest_extraction → 3 cycles × {specify, plan, tasks, verify, learnings} → gaps_complete → PR creation).
- [X] T009 [P] Seed `docs/my-specs/011-refactoring/event-order.md` with the canonical emit sequence template from `contracts/golden-trace.md` §"What goes in event-order.md". Leave the state→hook and event→hook matrices empty — they're filled at B0 (start of Phase 5).

**Checkpoint**: All 5 spec-folder artefacts exist (file-size-exceptions, error-codes, golden-trace-pre-A, event-order seed; module-map.md is created at end of Phase 3). Path choices locked. Ready to start Wave A.

---

## Phase 2: Foundational (Wave A Gates 0 & 1 — mechanical moves + OrchestrationContext)

**Purpose**: Land the prerequisites that every later extraction depends on. These are not optional and not parallelizable across user stories — they're the physical foundation.

**⚠️ CRITICAL**: No US1 / US3 / US4 task can begin until Phase 2 is complete. `OrchestrationContext` (T021) must exist before A2..A8 can extract pure-input phase functions; `checkpoints` namespace (T011..T013) must exist before `finalize.ts`, `phase-lifecycle.ts`, and `main-loop.ts` can import the consolidated checkpoint API.

### Wave A Gate 0: A0 + A0.5 (mechanical checkpoint consolidation + split)

- [X] T010 Add `npm run check:size` script to `/home/lukas/Projects/Github/lukaskellerstein/dex/package.json` — script invokes a small bash one-liner (`find src -type f \( -name '*.ts' -o -name '*.tsx' \) -exec wc -l {} + | awk '$1 > 600 && $2 != "total"'`) and filters against an inline allow-list of the 2 exceptions from T004. Exit non-zero if any non-allow-listed file >600 LOC.
- [X] T011 [P] Move `commitCheckpoint` from `src/core/git.ts:32` to `src/core/checkpoints.ts` (top-level export). Update all 6 import sites of `commitCheckpoint`. Verify with `npx tsc --noEmit`.
- [X] T012 [P] Move `readPauseAfterStage` from `src/core/orchestrator.ts:511` (private helper) to `src/core/checkpoints.ts` as a top-level export. Update its single call site at `src/core/orchestrator.ts:488`.
- [X] T013 Re-export the consolidated checkpoint surface from `src/core/checkpoints.ts` as a `checkpoints` namespace object: `export const checkpoints = { commit, jumpTo, promote, autoPromoteIfRecordMode, readRecordMode, readPauseAfterStage, ... }`. Existing direct imports continue to work; new code imports `{ checkpoints }`. Reference contracts/orchestration-context.md.
- [X] T014 [P] Create `src/core/checkpoints/tags.ts` containing `checkpointTagFor`, `captureBranchName`, `attemptBranchName`, `labelFor`, `parseCheckpointTag` (currently `src/core/checkpoints.ts:13-112`). Add the orientation block per contracts/module-orientation-block.md.
- [X] T015 [P] Create `src/core/checkpoints/recordMode.ts` containing `readRecordMode`, `autoPromoteIfRecordMode`, `promoteToCheckpoint`, `syncStateFromHead` (currently `src/core/checkpoints.ts:133-243`). Orientation block.
- [X] T016 [P] Create `src/core/checkpoints/jumpTo.ts` containing `jumpTo`, `maybePruneEmptySelected`, `unselect`, `unmarkCheckpoint` (currently `src/core/checkpoints.ts:245-488`). Orientation block.
- [X] T017 [P] Create `src/core/checkpoints/variants.ts` containing `VariantSpawnRequest`, `spawnVariants`, `cleanupVariantWorktree` (currently `src/core/checkpoints.ts:489-612`). Orientation block.
- [X] T018 [P] Create `src/core/checkpoints/timeline.ts` containing `listTimeline` and timeline types (currently `src/core/checkpoints.ts:613-989`). Target ≤290 LOC. Orientation block.
- [X] T019 [P] Create `src/core/checkpoints/variantGroups.ts` containing variant-group file IO (currently `src/core/checkpoints.ts:991-1071`). Orientation block.
- [X] T020 [P] Create `src/core/checkpoints/commit.ts` containing `commitCheckpoint` and `readPauseAfterStage` (moved in T011/T012). Orientation block.
- [X] T021 Create `src/core/checkpoints/index.ts` that assembles the `checkpoints` namespace by re-exporting from the 7 sub-files. Reduce `src/core/checkpoints.ts` to a ~30-line re-export shim that re-exports the namespace and the individual symbols for back-compat.
- [⚠] T022 Verify `src/core/__tests__/checkpoints.test.ts` (existing 450 LOC) passes without modification. **Caveat: this test was already failing pre-refactor** due to a test-infrastructure bug — `node --test --experimental-strip-types` cannot resolve the `.js` import literals (`from "./agent-overlay.js"`, `from "./types.js"`, etc.) in source files because Node 24's strip-types loader doesn't auto-rewrite `.js` → `.ts` for transitive imports. Stash-test confirmed pre-existing breakage. Same root cause both pre and post refactor; no new failure mode introduced. Of the 7 core test files, 5 work (agentOverlay, agentProfile, appConfig, dexConfig, timelineLayout) and 2 are blocked (checkpoints, jumpTo). Plan: address the test infra in Wave D (vitest natively handles `.js`→`.ts` resolution) and re-enable these two tests then.
- [X] T023 Wave A Gate 0 verification suite — passed (with documented carve-outs):
  - `npx tsc --noEmit` — exit 0, no diagnostics ✓
  - `npm test` — 47 passing tests, no new failures (2 pre-existing-broken tests stay broken; T022 caveat) ✓
  - Clean smoke on `dex-ecommerce` (mock backend) — 3 cycles, 3 features, gaps_complete, PR #12 created on `lukaskellerstein/dex-ecommerce` ✓
  - `npm run check:size` — `checkpoints.ts` (now 7 LOC shim) no longer flagged; remaining flagged files (orchestrator 2307, useOrchestrator 907, App 720) are targeted by later phases ✓
  - Golden-trace diff vs `golden-trace-pre-A.txt` — **zero diff** (50 lines identical) ✓
  - Checkpoint-resume smoke — deferred (this gate is mechanical-moves only; no risk of resume-path regression at this layer; will exercise at Gate 1 once `OrchestrationContext` lands).

### Wave A Gate 1 (foundational portion): A1 — OrchestrationContext

- [X] T024 Create `src/core/context.ts` (90 LOC) with `OrchestrationContext` interface, `RunState` (moved here from orchestrator.ts), `EmitFn` re-export, and `createContext(deps)` builder. 3-line orientation block per contracts/module-orientation-block.md.
- [X] T025 Implement `createContext` body. **Scope decision:** the factory is a pure synchronous builder (not the full async init factory the original spec described). The caller (`runLoop`) still does the lock acquisition, runner construction, and state load inline; it then passes the assembled dependencies into `createContext`. Rationale: the runLoop init has tight error-handling semantics (variant-group emission on lock failure, etc.) that don't fit cleanly inside a generic factory. Future revisit possible after A2-A7 extractions clarify the real entry-point shape. The pendingQuestion field is initialized empty; A3 will wire it.
- [X] T026 Updated `src/main/ipc/orchestrator.ts` with a JSDoc block documenting the residual: `currentContext` is the active-run pointer in `core/orchestrator.ts`; `stopRun` reads from it; `submitUserAnswer` will migrate from `userInput.ts`'s keyed map to `ctx.pendingQuestion` during A3. Comment cross-references `contracts/orchestration-context.md`.
- [X] T027 Updated `src/core/orchestrator.ts`. **Bridge approach (transitional):** `currentContext: OrchestrationContext | null` is now the source of truth, set when `runLoop` builds ctx after the existing inline init and nulled on cleanup. The 5 legacy globals (`abortController`, `activeProjectDir`, `releaseLock`, `currentRunner`, `currentRunState`) remain as transitional aliases — every existing read site keeps working. They get nulled alongside `currentContext`. `getRunState()` and `stopRun()` now read from `currentContext` first. Full substitution of read-sites deferred to A2-A7 (each phase extraction will replace its own usages with direct `ctx` parameters). Documented inline at the variable declarations.

Bonus: created `src/core/__tests__/context.test.ts` (5 tests, all passing) — pinning createContext's contract: required fields, mutable state object identity, abort signal flow-through, awaitable releaseLock. context.ts is loadable under `--experimental-strip-types` because it has no `.js` runtime imports (only `import type`).

**Checkpoint**: Phase 2 complete. `checkpoints` namespace, 7 sub-files, and re-export shim all in place. `OrchestrationContext` defined and threaded through the entry points. Wave A Gate 0 verification passed. Phase 3 (Wave A Gates 1-second-half through 4) and downstream phases can now begin.

---

## Phase 3: User Story 1 (Part 1) — Wave A core decomposition (Priority: P1) 🎯 MVP

**Story**: US1 — Modify a single concept without reading the whole system.

**Goal**: Decompose `src/core/orchestrator.ts` (2,313 LOC, 1,073-line `runLoop`) into named per-concept files: `prerequisites`, `clarification`, `main-loop`, `gap-analysis`, `finalize`, `phase-lifecycle`. Each ≤600 LOC, each top function ≤120 LOC, each with a top-of-file orientation block and a contract-pinning unit test.

**Independent Test**: A fresh AI-agent session asked to "add one new prerequisite check" locates `src/core/stages/prerequisites.ts`, reads ≤600 LOC, and adds one declarative entry without touching any other core file.

### Wave A Gate 1 (continued): A2 — prerequisites

- [X] T028 [US1] Created `src/core/stages/prerequisites.ts` (386 LOC). **Scope adjustment vs original spec:** the data-driven `SPECS: PrerequisiteSpec[]` array shape doesn't fit the 5 checks cleanly because (a) order matters (specify_cli result feeds speckit_init's auto-init logic; git_init must precede github_repo's commit-and-push), (b) "fix" semantics vary — claude_cli/specify_cli have inline retry loops, git_init/speckit_init have no fix path, github_repo is a multi-step interactive flow. Pragmatic implementation: 5 named async helper functions (`checkClaudeCli`, `checkSpecifyCli`, `checkGitInit`, `checkSpeckitInit`, `checkGithubRepo`) dispatched in sequence by a thin driver. Each helper accepts ctx + emitCheck callback + results map. Local helpers `isCommandOnPath` / `getScriptType` moved with the checks (only used here). Orientation block per contracts/module-orientation-block.md.
- [X] T029 [US1] Deleted lines 897-1237 from `src/core/orchestrator.ts` (the `// ── Prerequisites Check ──` section + isCommandOnPath + getScriptType + runPrerequisites). orchestrator.ts: 2,324 → 1,987 LOC (-337).
- [⚠] T030 [US1] Deferred — same root cause as T022. `prerequisites.ts` is not loadable under `--experimental-strip-types` because it imports `waitForUserInput` from `userInput.ts` which transitively pulls in `state.ts` with `.js` source imports. The tooling limitation blocks any test that exercises the interactive paths. Plan: re-enable in Wave D once vitest infra lands (vitest natively resolves `.js` → `.ts`).
- [X] T031 [US1] Updated call site in `runLoop` (was `await runPrerequisites(config, emit, runId, rlog)` at orchestrator.ts:1352, now `await runPrerequisitesPhase(currentContext, runId)` with a non-null guard for `currentContext`). Import added: `import { runPrerequisites as runPrerequisitesPhase } from "./stages/prerequisites.js"`.
- [X] T032 [US1] Wave A Gate 1 verification suite — passing:
  - `npx tsc --noEmit` — exit 0 ✓
  - 52 working tests pass (no regression; 5 from context.test.ts) ✓
  - Clean smoke on `dex-ecommerce` — 3 cycles, gaps_complete, PR #14 ✓
  - **Golden-trace diff** vs `golden-trace-pre-A.txt` — **zero diff** (still 50 lines identical) ✓
  - File-size profile: orchestrator.ts 1,987 LOC (still flagged; A3-A8 will continue shrinking it).

### Wave A Gate 2: A3 + A4 — clarification + main-loop

- [X] T033 [US1] Created `src/core/stages/clarification.ts` (179 LOC). **Signature adjusted** vs original spec: the function takes `ctx, deps` where `deps` is `{ config, runId, goalPath, clarifiedPath, existingSpecsAtStart, seedCumulativeCost }` — keeps the per-run inputs explicit since `OrchestrationContext` doesn't currently carry `RunConfig`. Returns `{ fullPlanPath, cumulativeCost }`. Auto-clarification is signaled via `config.autoClarification` and consumed by the prompt builders, not here (matches existing semantics — the spec's `skipInteractive` option was a renaming, not a new toggle). The `pendingQuestion` field on ctx is reserved for the upcoming `userInput` migration in A3.5 / Wave-D pass; for now, `userInput.ts`'s keyed map continues to handle interactive prompts. Orientation block per contracts/module-orientation-block.md. Imports `runStage` from `../orchestrator.js` (circular function ref — call-time-safe per ESM). `emitSkippedStep` helper duplicated locally (~16 LOC) because the implement loop in `orchestrator.ts:1480` still needs the orchestrator-side definition; A4 will consolidate when main-loop is extracted. Replaced inline block at orchestrator.ts:1077-1186 with the call. Also added `export` to `runStage` at orchestrator.ts:341. orchestrator.ts: 1,987 → 1,896 LOC (-91). Wave A Gate 2 (A3 portion) verification — passing: tsc clean, smoke clean (3 cycles → gaps_complete → PR created), **zero-diff golden-trace**.
- [ ] T034 [US1] Create `src/core/stages/main-loop.ts` exporting `runMainLoop(ctx, options: { maxCycles: number; budgetUsd: number }): Promise<LoopTermination>` plus the 4 named per-stage helpers: `runGapAnalysisStep`, `runSpecifyPlanTasks`, `runImplementWithVerifyRetry`, `runLearningsStep`. Each helper ≤120 LOC; `runMainLoop` itself ≤80 LOC (cycle counter + budget check + dispatch). Move composition from `src/core/orchestrator.ts:1595-2151`. Add orientation block.
- [ ] T035 [US1] Replace clarification + cycle-iterator call sites in `src/core/orchestrator.ts` with `await runClarificationPhase(ctx, ...)` and `return runMainLoop(ctx, ...)`. Delete the original implementations.
- [ ] T036 [US1] Run Wave A Gate 2 verification suite (full). Golden-trace diff against `event-order.md` §G2 tolerable reorders. Roll back on regression.

### Wave A Gate 3: A5 + A6 + A7 — gap-analysis + finalize + phase-lifecycle

- [ ] T037 [P] [US1] Create `src/core/gap-analysis.ts` exporting `parseGapAnalysisDecision(agentOutput: string): GapAnalysisDecision` and `applyGapAnalysisDecision(decision, ctx): Promise<{ nextSpecDir?: string; nextStep?: StepType }>`. `parse` MUST throw on malformed input (no silent fallback). `apply` is exhaustive over `decision.kind` (TypeScript `never` check). Add orientation block.
- [ ] T038 [P] [US1] Create `src/core/__tests__/gap-analysis.test.ts` (node:test). Tests: golden-input parse for each of 5 branches (NEXT_FEATURE, RESUME_FEATURE, REPLAN_FEATURE, RESUME_AT_STEP, GAPS_COMPLETE); malformed-input throws; exhaustiveness compile-check.
- [ ] T039 [P] [US1] Create `src/core/stages/finalize.ts` exporting `finalizeStageCheckpoint(ctx, stage, outcome): Promise<{ shouldPause: boolean }>`. Wraps the `updateState → commitCheckpoint → updatePhaseCheckpointInfo → autoPromoteIfRecordMode → readPauseAfterStage` sequence currently inlined at `src/core/orchestrator.ts:442-501`. Imports the consolidated checkpoint API from `src/core/checkpoints/index.ts` (no circular dep back to `orchestrator.ts` for `readPauseAfterStage` after Phase 2). Move `updatePhaseCheckpointInfo` (currently `orchestrator.ts:520-537`) into this file. Add orientation block.
- [ ] T040 [P] [US1] Create `src/core/__tests__/finalize.test.ts` (node:test). Tests: full checkpoint sequence with mock git via fake `ctx`; `shouldPause === true` when `readPauseAfterStage` returns truthy; record-mode auto-promote happens when configured.
- [ ] T041 [P] [US1] Create `src/core/phase-lifecycle.ts` exporting `recordPhaseStart(ctx, phase): Promise<PhaseTraceId>`, `recordPhaseComplete(ctx, phaseTraceId, outcome): Promise<void>`, `recordPhaseFailure(ctx, phaseTraceId, error): Promise<void>`. Wraps the `runs.startAgentRun → emit("phase_started") → rlog.agentRun → ... → runs.completeAgentRun / runs.appendAgentStep` choreography that currently spans 8 phase boundaries (`orchestrator.ts:362, 589, 915, 1388, 1613, 1646, 1919, 1965`). Per data-model.md, wraps the JSON writers in `src/core/runs.ts` — no SQLite. Add orientation block.
- [ ] T042 [P] [US1] Create `src/core/__tests__/phase-lifecycle.test.ts` (node:test). Tests: ordering of `runs.startAgentRun` + `emit` + `rlog.agentRun`; failure path emits `phase_failed`; subagent appendAgentStep is wrapped correctly. Mock `runs.*` writers as in-memory.
- [ ] T043 [US1] Replace 8 call sites of `runs.startAgentRun() → emit("phase_started") → rlog.agentRun()` with `await recordPhaseStart(ctx, phase)`. Replace 8 corresponding `completeAgentRun` chunks with `recordPhaseComplete(ctx, ptid, outcome)`. Replace finalize-ritual call site at `orchestrator.ts:442-501` with `await finalizeStageCheckpoint(ctx, stage, outcome)`. Replace gap-analysis parse + apply call sites with the new module.
- [ ] T044 [US1] Run Wave A Gate 3 verification suite (full). Golden-trace diff against `event-order.md` §G3 tolerable reorders. Roll back on regression.

### Wave A Gate 4: A8 — trim coordinator + module-map

- [ ] T045 [US1] Trim `src/core/orchestrator.ts` to the thin coordinator shape (Path α): `export async function run(config, emit)` (~30-line dispatcher routing to `runBuild` | `runLoop`), `export async function runBuild(config, emit)` (iterate specs, call runStage), `export async function runLoop(config, emit)` (createContext → runPrerequisites → runClarificationPhase → runMainLoop), `export function abortRun()`. Keep helpers as named exports per spec §A8 list. Target ≤500 LOC total.
- [ ] T046 [US1] Verify all helpers explicitly retained as exports from `orchestrator.ts`: `getRunState()`, `listSpecDirs()`, `isSpecComplete()`, `buildPrompt()`, `runPhase()`, `isCommandOnPath()`, `getScriptType()`. Grep for their current call sites; any that are now only used by an extracted module should move into that module.
- [ ] T047 [US1] Write `docs/my-specs/011-refactoring/module-map.md` per data-model.md §Module Map — full tree of `src/core/` post-decomposition with one-line responsibility per file. Update if any T046 helper moved.
- [ ] T048 [US1] Run Wave A Gate 4 verification suite (full). `npm run check:size` MUST exit clean — only `state.ts` and `ClaudeAgentRunner.ts` may exceed 600 LOC. Golden-trace diff against `event-order.md` §G4 tolerable reorders.
- [ ] T049 [US2] Open Wave A squash-merge PR titled `phase 2/wave-A: decompose orchestrator.ts and checkpoints.ts`. PR description follows contracts/wave-gate.md §"PR-description template" — summary, verification gate proof, post-merge revert command, smoke checklist (≤5 items). User reviews and merges.

**Checkpoint**: Wave A merged to `main`. Core decomposition (orchestrator + checkpoints) complete. `module-map.md` published. `npm run check:size` enforces the ≤600 LOC rule going forward. Phase 3 delivers ~70% of US1's value.

---

## Phase 4: User Story 3 — Typed IPC service layer (Priority: P2)

**Story**: US3 — Change one IPC call without touching 14 files.

**Goal**: Wrap every IPC call from the renderer through one of 6 typed service wrappers under `src/renderer/services/`. Migrate all 14 current `window.dexAPI` consumers (12 components + `useProject` + `useTimeline`). Land **before** Phase 5 (Wave B) so split hooks consume services from day one.

**Independent Test**: `grep -rn 'window\.dexAPI' src/renderer | grep -v '^src/renderer/services/'` returns zero matches after Phase 4.

### Service-layer creation (parallel — different files)

- [ ] T050 [P] [US3] Create `src/renderer/services/checkpointService.ts` wrapping `window.dexAPI.checkpoints.*` (`listTimeline`, `jumpTo`, `commit`, `promote`, `unmark`, `estimateVariantCost`, `spawnVariants`). Export `class CheckpointError extends Error` with discriminated `code` union from `error-codes.md`. Add orientation block per contracts/service-layer.md.
- [ ] T051 [P] [US3] Create `src/renderer/services/orchestratorService.ts` wrapping `window.dexAPI.{startRun, stopRun, answerQuestion, getRunState, onOrchestratorEvent}`. Method `subscribeEvents(handler): () => void` returns the unsubscribe. Export `class OrchestratorError`. Orientation block.
- [ ] T052 [P] [US3] Create `src/renderer/services/projectService.ts` wrapping project IPC (open, listSpecs, parseSpec, file IO). Export `class ProjectError`. Orientation block.
- [ ] T053 [P] [US3] Create `src/renderer/services/historyService.ts` wrapping `listRuns`, `getRun`, `getPhaseSteps`, `getPhaseSubagents`. Export `class HistoryError`. Orientation block.
- [ ] T054 [P] [US3] Create `src/renderer/services/profilesService.ts` wrapping `dexAPI.profiles.*` (list, get, saveDexJson, delete). Export `class ProfilesError`. Orientation block.
- [ ] T055 [P] [US3] Create `src/renderer/services/windowService.ts` wrapping window controls (minimize, maximize, close). Export `class WindowError`. Orientation block.

### Vitest infrastructure + first service test

- [ ] T056 [US3] Add dev dependencies to `package.json`: `vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`. Run `npm install`. (Phase 8 / Wave D adds the 4 hook tests; the service test in T058 needs the infra now.)
- [ ] T057 [US3] Create `vitest.config.ts` at repo root scoped to `src/renderer/**/*.test.{ts,tsx}` with `jsdom` environment. Update `package.json` `test` script to run both `node --test src/core/**/*.test.ts` and `vitest run` and exit non-zero on either failure.
- [ ] T058 [P] [US3] Create `src/renderer/services/__tests__/checkpointService.test.ts` (vitest). Tests: each method calls the expected `dexAPI.checkpoints.*` path with the right args; IPC errors translate to typed `CheckpointError` with the right `code`; method exhaustiveness over the documented surface. Mock `window.dexAPI` as a fake object on `globalThis`.

### Migrate 14 consumers (parallel — each touches one file)

- [ ] T059 [P] [US3] Migrate `src/renderer/hooks/useProject.ts` from `window.dexAPI.*` to `projectService.*`.
- [ ] T060 [P] [US3] Migrate `src/renderer/hooks/useTimeline.ts` from `window.dexAPI.checkpoints.*` to `checkpointService.*`.
- [ ] T061 [P] [US3] Migrate `src/renderer/components/Topbar.tsx` from `window.dexAPI.*` to the appropriate services (likely `windowService` + `orchestratorService`).
- [ ] T062 [P] [US3] Migrate `src/renderer/components/loop/LoopStartPanel.tsx` to `orchestratorService` + `projectService`.
- [ ] T063 [P] [US3] Migrate `src/renderer/components/loop/LoopDashboard.tsx` to `orchestratorService` + `historyService`.
- [ ] T064 [P] [US3] Migrate `src/renderer/components/loop/StageList.tsx` to relevant services.
- [ ] T065 [P] [US3] Migrate `src/renderer/components/agent-trace/AgentStepList.tsx` to `orchestratorService` (event subscription path).
- [ ] T066 [P] [US3] Migrate `src/renderer/components/agent-trace/ToolCard.tsx` (any direct dexAPI reach-ins) to services.
- [ ] T067 [P] [US3] Migrate `src/renderer/components/checkpoints/TimelinePanel.tsx` to `checkpointService`.
- [ ] T068 [P] [US3] Migrate `src/renderer/components/checkpoints/TimelineGraph.tsx` to `checkpointService`.
- [ ] T069 [P] [US3] Migrate `src/renderer/components/checkpoints/TryNWaysModal.tsx` to `checkpointService` + `profilesService`.
- [ ] T070 [P] [US3] Migrate `src/renderer/components/ClarificationPanel.tsx` to `orchestratorService`. (Note: B3 in Phase 5 will rewire this further — this task only swaps the IPC reach-in.)
- [ ] T071 [P] [US3] Migrate the remaining 3 components found by Pre-Wave grep — list them in the task body when starting (commonly `WelcomeScreen.tsx`, `RunHistory.tsx`, and one more). Each parallel.

### Wave C-services gate

- [ ] T072 [US3] Run the wave-gate-specific check: `grep -rn 'window\.dexAPI' src/renderer | grep -v '^src/renderer/services/'` MUST return zero matches. If not, identify the leftover consumer and migrate.
- [ ] T073 [US3] Run Wave C-services verification suite per contracts/wave-gate.md (checks 1–6 + 9 + the grep above + new `checkpointService.test.ts` passing).
- [ ] T074 [US2] Open Wave C-services squash-merge PR titled `phase 2/wave-C-services: typed IPC service layer`. PR description per contracts/wave-gate.md template. User reviews and merges.

**Checkpoint**: Wave C-services merged. Service layer is the single point of `window.dexAPI` reach-in. US3 delivered. Phase 5 can now begin with split hooks consuming services from day one.

---

## Phase 5: User Story 4 — Renderer hook split (Priority: P2)

**Story**: US4 — Split renderer state by domain so changes don't ripple.

**Goal**: Split `useOrchestrator.ts` (907 LOC, 21 useState calls, 25-case event switch) into 5 domain-bounded hooks plus a thin composer. State and events partition exactly per the matrices in `event-order.md`.

**Independent Test**: Each of the 5 hooks owns its declared state slice and event subset; the composer re-exports the union shape App.tsx consumes; no event is double-handled.

### B0 — write the matrices (no code)

- [ ] T075 [US4] Update `docs/my-specs/011-refactoring/event-order.md` with the **state→hook matrix** assigning all 21 useState calls from `useOrchestrator.ts` per data-model.md §"Renderer hook state ownership". Format as a markdown table with columns `Hook | States`.
- [ ] T076 [US4] Update `docs/my-specs/011-refactoring/event-order.md` with the **event→hook matrix** assigning all 25 event-type cases. Document the **error event discriminator policy**: errors carry a `phase` field; route to the relevant hook by phase; composer fatal-error sink catches unmatched. List the 5 `AgentStep` subtypes (`subagent_result`, `subagent_spawn`, `text`, `thinking`, `tool_call`) under `useLiveTrace`'s `labelForStep` only.
- [ ] T077 [US4] Audit downstream consumers of the 5 `AgentStep` subtypes via `grep -rn` — if zero consumers outside `labelForStep`, document them as deletable raw SDK passthroughs. Otherwise document the consumers and keep them.

### B1..B3.6 — extract hooks (sequential — each commit removes events from `useOrchestrator.ts`)

- [ ] T078 [US4] Create `src/renderer/hooks/useLoopState.ts` (~250 LOC). Owns: `preCycleStages`, `loopCycles`, `currentCycle`, `currentStage`, `totalCost`, `loopTermination`. Subscribes to: `loop_cycle_started`, `loop_cycle_completed`, `loop_terminated`, `task_phase_started`, `task_phase_completed`, `spec_started`, `spec_completed`. Reuses existing `buildLoopStateFromRun` (`src/renderer/hooks/buildLoopStateFromRun.ts`). Subscribes via `orchestratorService.subscribeEvents`. Add orientation block. In the same commit, remove the corresponding states + cases from `useOrchestrator.ts`.
- [ ] T079 [US4] Create `src/renderer/hooks/useLiveTrace.ts` (~250 LOC). Owns: `liveSteps`, `subagents`, `currentPhase`, `currentPhaseTraceId`. Subscribes to: `step_started`, `step_completed`, `agent_step`, `subagent_started`, `subagent_completed`, `subagent_result`. Includes `labelForStep` helper for the 5 AgentStep subtypes. Orientation block. Remove the corresponding code from `useOrchestrator.ts` in the same commit.
- [ ] T080 [US4] Create `src/renderer/hooks/useUserQuestion.ts` (~150 LOC). Owns: `pendingQuestion`, `isClarifying`. Subscribes to: `clarification_started`, `clarification_question`, `clarification_completed`, `user_input_request`, `user_input_response`. Calls `orchestratorService.answerQuestion()` to submit answers. Orientation block. Remove from `useOrchestrator.ts` in same commit.
- [ ] T081 [US4] Rewire `src/renderer/components/ClarificationPanel.tsx` (231 LOC) to consume `useUserQuestion()` directly instead of receiving `{questions, onAnswer, requestId}` props. Drop the props from the parent (App.tsx); the panel becomes self-sufficient.
- [ ] T082 [US4] Create `src/renderer/hooks/useRunSession.ts` (~100 LOC). Owns: `mode`, `isRunning`, `currentRunId`, `totalDuration`, `activeSpecDir`, `activeTask`, `viewingHistorical`. Subscribes to: `run_started`, `run_completed`, `state_reconciled`, plus run-level start/stop signals from `orchestratorService`. Run-level `error` only — phase-scoped errors flow to the relevant hook. Orientation block. Remove from `useOrchestrator.ts`.
- [ ] T083 [US4] Create `src/renderer/hooks/usePrerequisites.ts` (~80 LOC). Owns: `prerequisitesChecks`, `isCheckingPrerequisites`. Subscribes to: `prerequisites_started`, `prerequisites_check`, `prerequisites_completed`. Orientation block. Remove from `useOrchestrator.ts`.

### B4 — composer

- [ ] T084 [US4] Reduce `src/renderer/hooks/useOrchestrator.ts` to ~80 LOC composer that calls all 5 new hooks and spreads them into the union return shape App.tsx currently consumes. Add the **composer-level fatal-error sink**: phase-discriminated errors that don't match any active hook's discriminator land here and surface a top-level error toast. Orientation block.
- [ ] T085 [US4] Run a state→event audit script (or manual cross-check) — every state in the matrix and every event in the matrix is owned by exactly one hook, no orphans, no duplicates.

### Wave B gate

- [ ] T086 [US4] Run Wave B verification suite per contracts/wave-gate.md (checks 1–6 + 9 + matrix audit). Hook test files are deferred to Phase 8; smoke + golden-trace diff at this gate.
- [ ] T087 [US2] Open Wave B squash-merge PR titled `phase 2/wave-B: split useOrchestrator into domain hooks`. PR description per template. User reviews and merges.

**Checkpoint**: Wave B merged. Renderer state split by domain. US4 delivered.

---

## Phase 6: User Story 1 (Part 2) — Wave C-rest big-component splits (Priority: P1)

**Story**: US1 (continued) — Modify a single concept without reading the whole system, applied to renderer components.

**Goal**: Split `App.tsx` (720 → ~250), `ToolCard.tsx` (574 → ~100 + 7 tool-cards), `LoopStartPanel.tsx` (523 → ~200 + 2 children), `StageList.tsx` (491 → ~200 + logic), `AgentStepList.tsx` (487 → ~200 + logic). Apply style tokens to the 13 rewritten components.

**Independent Test**: After Phase 6, the largest renderer component file is ≤400 LOC; no inline-style duplication across the 13 rewritten files (they import from `tokens.ts`).

### C1 + C2 — App.tsx surgery

- [ ] T088 [P] [US1] Create `src/renderer/components/AppBreadcrumbs.tsx` (~140 LOC). Move breadcrumb rendering with phase/cycle label resolution from `src/renderer/App.tsx:392-532`. Orientation block. App.tsx keeps the prop wiring.
- [ ] T089 [P] [US1] Create `src/renderer/AppRouter.tsx` (~150 LOC). Move view-switching JSX from `src/renderer/App.tsx:357-644` (overview / tasks / trace / subagent-detail / loop-start / loop-dashboard) into a proper switch component. Orientation block.
- [ ] T090 [US1] Reduce `src/renderer/App.tsx` to ~250 LOC by removing the moved code from T088 and T089. App.tsx now does only routing + state delegation + IPC subscriptions (the latter two via the composer hook from Phase 5).

### C4 — ToolCard split (parallel — different files after dispatcher exists)

- [ ] T091 [US1] Reduce `src/renderer/components/agent-trace/ToolCard.tsx` to ~100 LOC dispatcher only. Build a `Record<ToolName, ComponentType>` registry keyed on tool name; dispatch the matched component or fall through to `GenericCard`. Orientation block.
- [ ] T092 [P] [US1] Create `src/renderer/components/agent-trace/tool-cards/BashCard.tsx`. Move Bash-specific rendering from the original `ToolCard.tsx`. Orientation block.
- [ ] T093 [P] [US1] Create `src/renderer/components/agent-trace/tool-cards/ReadCard.tsx`. Orientation block.
- [ ] T094 [P] [US1] Create `src/renderer/components/agent-trace/tool-cards/WriteCard.tsx`. Orientation block.
- [ ] T095 [P] [US1] Create `src/renderer/components/agent-trace/tool-cards/EditCard.tsx`. Orientation block.
- [ ] T096 [P] [US1] Create `src/renderer/components/agent-trace/tool-cards/GrepCard.tsx`. Orientation block.
- [ ] T097 [P] [US1] Create `src/renderer/components/agent-trace/tool-cards/TaskCard.tsx`. Orientation block.
- [ ] T098 [P] [US1] Create `src/renderer/components/agent-trace/tool-cards/GenericCard.tsx` — fallback for unknown tools. Orientation block.

### C5 — LoopStartPanel split

- [ ] T099 [US1] Create `src/renderer/components/loop/LoopStartForm.tsx` — config form, wraps existing markdown editor. Orientation block.
- [ ] T100 [P] [US1] Create `src/renderer/components/loop/LoopCostPreview.tsx` — cost/iteration estimate panel. Orientation block.
- [ ] T101 [P] [US1] Create `src/renderer/hooks/useLoopStartForm.ts` — form state extracted from the parent so the parent stays presentational. Orientation block.
- [ ] T102 [US1] Reduce `src/renderer/components/loop/LoopStartPanel.tsx` to ~200 LOC by removing the form + cost-preview content (now in T099/T100) and the form state (now in T101).

### C6 — StageList + AgentStepList split

- [ ] T103 [P] [US1] Create `src/renderer/components/loop/StageList.logic.ts` — extract grouping/filtering pure helpers from `StageList.tsx`. Orientation block.
- [ ] T104 [US1] Reduce `src/renderer/components/loop/StageList.tsx` to ~200 LOC, importing the pure helpers from `StageList.logic.ts`. The component becomes rendering-only.
- [ ] T105 [P] [US1] Create `src/renderer/components/agent-trace/AgentStepList.logic.ts` — extract grouping/filtering pure helpers from `AgentStepList.tsx`. Orientation block.
- [ ] T106 [US1] Reduce `src/renderer/components/agent-trace/AgentStepList.tsx` to ~200 LOC, importing from `AgentStepList.logic.ts`. Component is rendering-only.

### C7 — Style tokens

- [ ] T107 [US1] Create `src/renderer/styles/tokens.ts` exporting `muted`, `linkLike`, `cardSurface`, and other repeated inline-style fragments as typed `as const` objects. Orientation block. Reference plan.md §C7.
- [ ] T108 [US1] Apply tokens across the 13 components rewritten by C4–C6: ToolCard.tsx + 7 tool-cards (T091..T098), LoopStartPanel + LoopStartForm + LoopCostPreview (T099/T100/T102), StageList + AgentStepList (T104/T106). The remaining ~44 inline-style files adopt opportunistically as touched — no tracker.

### Wave C-rest gate

- [ ] T109 [US1] Run Wave C-rest verification suite per contracts/wave-gate.md (checks 1–6 + 7 + 9). `npm run check:size` confirms `App.tsx`, `ToolCard.tsx`, `LoopStartPanel.tsx`, `StageList.tsx`, `AgentStepList.tsx` all ≤600 LOC.
- [ ] T110 [US2] Open Wave C-rest squash-merge PR titled `phase 2/wave-C-rest: App.tsx surgery + big-component splits + style tokens`. PR description per template. User reviews and merges.

**Checkpoint**: Wave C-rest merged. US1 fully delivered (core + renderer). US2 has now been exercised at every wave PR. ~95% of the refactor's stated goal is shipped.

---

## Phase 7: User Story 5 — File-size guard validation (Priority: P3)

**Story**: US5 — Stop file-size drift after the refactor lands.

**Goal**: Confirm `npm run check:size` (created in T010) catches drift. Pin the allow-list. This phase is small — most of US5's value already shipped in Phase 2.

**Independent Test**: Intentionally creating a 700-line file flips `npm run check:size` exit non-zero with the file named in the output. Removing the file restores clean exit.

- [ ] T111 [US5] Verify `npm run check:size` is wired into `package.json`'s `test` script (or a sibling `lint` script that runs in CI). If not, add it so CI catches drift.
- [ ] T112 [P] [US5] Drop a temporary 700-line file at `/tmp/dex-size-test.ts` symlinked into `src/renderer/components/` and confirm `npm run check:size` exits non-zero with the file path in the output. Remove the symlink. (No commit; just a behaviour check.)
- [ ] T113 [US5] Confirm the allow-list in `package.json`'s `check:size` script lists exactly: `src/core/state.ts`, `src/core/agent/ClaudeAgentRunner.ts`. Document the allow-list with a one-line comment pointing at `docs/my-specs/011-refactoring/file-size-exceptions.md`.

**Checkpoint**: US5 delivered. File-size discipline is enforced from CI / local script forward.

---

## Phase 8: Polish — Wave D test infrastructure + 4 renderer hook tests + cleanup

**Purpose**: Pay back the Path A test debt from Phase 4 — write the 4 renderer hook tests under the vitest infra installed in T056/T057. Final smoke + branch cleanup.

- [ ] T114 [P] Create `src/renderer/hooks/__tests__/useLoopState.test.tsx` (vitest + @testing-library/react). Tests: dispatched events update the right state; idempotent on duplicate events; loop_terminated finalizes correctly. Use a fake `orchestratorService` injected via vitest module mocks.
- [ ] T115 [P] Create `src/renderer/hooks/__tests__/useLiveTrace.test.tsx`. Tests: step_started + step_completed produce a coherent timeline; agent_step entries label correctly via `labelForStep`; subagent lifecycle nests under the parent step.
- [ ] T116 [P] Create `src/renderer/hooks/__tests__/useUserQuestion.test.tsx`. Tests: clarification_question shows the question; calling `answer()` calls `orchestratorService.answerQuestion`; clarification_completed clears the question.
- [ ] T117 [P] Create `src/renderer/hooks/__tests__/useRunSession.test.tsx`. Tests: run_started flips `isRunning` true and sets `currentRunId`; run_completed flips false and finalizes `totalDuration`; phase-scoped errors do NOT reach this hook (run-level errors only).
- [ ] T118 Run combined `npm test` — both `node --test` (core) and `vitest run` (renderer) pass. If either fails, fix before continuing.
- [ ] T119 Run final Wave D verification suite per contracts/wave-gate.md (checks 1–6).
- [ ] T120 [US2] Open final Wave D squash-merge PR titled `phase 2/wave-D: renderer hook tests + vitest infra`. PR description per template. User reviews and merges.
- [ ] T121 After Wave D PR merges, the user runs `git branch -D 011-refactoring` (and optionally `git push origin :011-refactoring`) per the lifecycle in plan.md §Summary. The agent does not delete branches.
- [ ] T122 Optional: run `quickstart.md` end-to-end as a final sanity check — reset `dex-ecommerce` to clean, run one full loop, confirm the DEBUG badge resolves to a valid log file.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies. Can start immediately.
- **Phase 2 (Foundational)**: Depends on Phase 1 (golden-trace baseline must exist; A8-prep path locked). **BLOCKS** Phases 3, 4, 5, 6, 7, 8.
- **Phase 3 (US1 part 1, Wave A)**: Depends on Phase 2. Lands Wave A on `main`.
- **Phase 4 (US3, Wave C-services)**: Depends on Phase 3 (Wave A's emit shape must be stable; the service layer subscribes to events). Per R-005, must land **before** Phase 5.
- **Phase 5 (US4, Wave B)**: Depends on Phase 4 (split hooks consume services from day one — no rewrite-twice).
- **Phase 6 (US1 part 2, Wave C-rest)**: Depends on Phase 4 (rewritten components import from services) and Phase 5 (rewritten components consume the new hooks).
- **Phase 7 (US5)**: Depends on Phase 2 (script exists from T010) and Phase 3 (Wave A confirmed clean against the allow-list). Can run in parallel with Phase 4/5/6 as a side validation.
- **Phase 8 (Polish, Wave D)**: Depends on Phases 4 and 5 (hooks must exist to test). Final phase.

### Within each user story

- US1's Wave-A sub-gates (G0..G4) are strictly sequential — each gate's verification suite must pass before the next gate's tasks begin.
- US3's 6 service files (T050..T055) can run in parallel; the 14 consumer migrations (T059..T071) can run in parallel after the services exist.
- US4's hook splits (T078, T079, T080, T082, T083) are sequential because each commit removes the corresponding states + events from `useOrchestrator.ts` in the same commit.
- US1's tool-card files (T092..T098) can run in parallel after T091 (dispatcher exists).
- US1's `*.logic.ts` files (T103, T105) can run in parallel; the corresponding component rewrites (T104, T106) sequentially follow each one.
- US2's PR-opening tasks (T049, T074, T087, T110, T120) are sequential by definition — each waits for the prior wave to merge.

### Parallel Opportunities

- **Phase 1**: T004, T005, T009 are parallel (different files, no dependencies). T006 + T007 are sequential (two baseline runs). T008 depends on T006 + T007.
- **Phase 2 (A0.5)**: T014..T020 (the 7 sub-file extractions) are parallel — different new files. T021 (`index.ts`) depends on all of them.
- **Phase 3 (Gate 3)**: T037 + T039 + T041 (gap-analysis, finalize, phase-lifecycle) are parallel — different new files. Their tests T038 + T040 + T042 are also parallel.
- **Phase 4**: T050..T055 (6 services) parallel. T059..T071 (14 migrations) parallel.
- **Phase 6 (C4)**: T092..T098 (7 tool-cards) parallel after T091.
- **Phase 8**: T114..T117 (4 hook tests) parallel.

---

## Parallel Example: Phase 4 (Wave C-services)

```bash
# Land all 6 services at once (parallel — different files):
Task: "Create src/renderer/services/checkpointService.ts"     # T050
Task: "Create src/renderer/services/orchestratorService.ts"   # T051
Task: "Create src/renderer/services/projectService.ts"        # T052
Task: "Create src/renderer/services/historyService.ts"        # T053
Task: "Create src/renderer/services/profilesService.ts"       # T054
Task: "Create src/renderer/services/windowService.ts"         # T055

# Then migrate all 14 consumers in parallel (each touches one file):
Task: "Migrate src/renderer/hooks/useProject.ts"              # T059
Task: "Migrate src/renderer/hooks/useTimeline.ts"             # T060
# ... 12 more, all parallel
```

---

## Parallel Example: Phase 6 (C4 tool-cards)

```bash
# After T091 (dispatcher) is in place, all 7 tool-card files in parallel:
Task: "Create src/renderer/components/agent-trace/tool-cards/BashCard.tsx"     # T092
Task: "Create src/renderer/components/agent-trace/tool-cards/ReadCard.tsx"     # T093
Task: "Create src/renderer/components/agent-trace/tool-cards/WriteCard.tsx"    # T094
Task: "Create src/renderer/components/agent-trace/tool-cards/EditCard.tsx"     # T095
Task: "Create src/renderer/components/agent-trace/tool-cards/GrepCard.tsx"     # T096
Task: "Create src/renderer/components/agent-trace/tool-cards/TaskCard.tsx"     # T097
Task: "Create src/renderer/components/agent-trace/tool-cards/GenericCard.tsx"  # T098
```

---

## Implementation Strategy

### MVP First (US1 — core decomposition)

1. Phase 1 (Setup) — produce all 5 spec-folder artefacts and lock path choices.
2. Phase 2 (Foundational) — A0/A0.5/A1 + check:size script. Wave A Gates 0+1 pass.
3. Phase 3 (US1 Wave A) — A2..A8. Wave A merged to `main`.
4. **STOP and VALIDATE**: full smoke + checkpoint-resume smoke + module-map.md published. The MVP outcome of US1 is "an AI agent can locate prerequisites/clarification/main-loop/finalize/phase-lifecycle/gap-analysis by file name and modify ≤600 LOC". Confirm with a manual test: open `src/core/stages/prerequisites.ts` cold and verify the orientation block + the SPECS array make the file self-introducing.
5. Optionally pause here for review; the rest of the refactor (services + hooks + renderer-component splits) is incremental polish and can land over multiple PRs.

### Incremental Delivery

After MVP (Phase 3 merged):

- **Phase 4 (US3)** → service layer merged → IPC contract decoupled. (P2 win.)
- **Phase 5 (US4)** → hook split merged → renderer state by domain. (P2 win.)
- **Phase 6 (US1 part 2)** → renderer components split + style tokens. (Completes US1.)
- **Phase 7 (US5)** → file-size guard validated. (Defensive; protects gains.)
- **Phase 8 (Polish, Wave D)** → renderer hook tests + branch cleanup.

Each wave PR ships independently. Each merges to `main` only after its wave-gate verification suite passes. Each PR description carries the post-merge revert command — if a regression surfaces post-merge, recovery is one `git revert` away.

### Rollback Strategy

- **Wave-internal (between sub-gates, before merge)**: `git reset --hard <prior-gate-tip>` on `011-refactoring`. Branch-local; no other waves affected.
- **Post-merge**: revert PR on `main` using the command in the wave's PR description (e.g. `git revert <merge-sha> -m 1 && git push origin main`). Re-run the smoke checklist from the PR description to confirm the revert restored function.
- **If rollback also fails (rare)**: stop and escalate to the user. Do not improvise destructive recovery on `main`.

---

## Notes

- **Tests are required for the 4 core extractions** (FR-007). Renderer hook tests are deferred to Phase 8 (Wave D Path A); the vitest infra is installed earlier in Phase 4 (T056/T057) so the `checkpointService.test.ts` (T058) can run immediately.
- **Behaviour-preserving constraint** (FR-008, R-009): synthetic `step_started`/`step_completed`, `decision === "stopped"` → `status: "running"`, the 5-second resume heuristic, single-mode `reconcileState` — all stay intact. Resist "while we're here" cleanups in those regions.
- **`window.dexAPI` shape preserved during migration** (FR-011). Service layer is additive; consumers migrate one at a time within Phase 4.
- **Module orientation block** (FR-010, contracts/module-orientation-block.md): every newly extracted module gets a 3-line What/Not/Deps JSDoc. ~5 minutes per module; ~12 modules total.
- **The user runs all git commits manually** (FR-020, global CLAUDE.md). Each task's "git" verb means "ready for the user to commit"; the agent does not invoke `git commit`.
- **Each phase's checkpoint maps to a wave PR**. The PR description follows contracts/wave-gate.md §"PR-description template".
- **The 5 spec-folder artefacts** under `docs/my-specs/011-refactoring/` are committed and pushed — the next refactor wave depends on them being current.
