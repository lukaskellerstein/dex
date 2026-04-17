---

description: "Task list — 007-sqlite-removal"
---

# Tasks: Retire SQLite audit DB in favor of per-project JSON files

**Input**: Design documents from `/specs/007-sqlite-removal/`
**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/runs-module.md`, `contracts/ipc-history.md`, `contracts/json-schemas.md`, `quickstart.md`

**Tests**: This feature includes unit tests for the new `runs.ts` module (mandated by contract) and end-to-end UI verification via Playwright/MCP (mandated by Constitution Principle III). Integration test for cross-project isolation is included to satisfy SC-005.

**Organization**: Tasks are grouped by user story per spec-kit convention. Note that this is a *refactor*: User Stories 1, 2, 3, and 4 are all delivered by a single coherent code change (per-project JSON storage + matching UI rewire) and cannot be shipped piecemeal — there is no intermediate state where US1 is "done" but US4 is not. The phased structure is preserved for traceability and acceptance-test alignment, not for incremental deployment.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4, US5)
- All file paths are repo-relative

## Path Conventions

Existing project structure (Electron desktop app):
- `src/core/` — platform-agnostic orchestration engine (pure Node)
- `src/main/` — Electron main process + IPC handlers
- `src/renderer/` — React renderer

---

## Phase 1: Setup

**Purpose**: Create the new module file so subsequent tasks can write into it. No project-wide initialization needed (this is a refactor of an existing project).

- [X] T001 Create empty module skeleton at `src/core/runs.ts` containing only the type re-exports (`RunMode`, `RunStatus`, `PhaseStatus`, `SubagentStatus`, `StepType`) and `interface` declarations for `RunRecord`, `PhaseRecord`, `SubagentRecord`, `StepRecord`, `SpecStats` per `contracts/runs-module.md § Exported types` (no function bodies yet — just shapes so other tasks can import the types in parallel).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Implement the new storage module and the legacy-DB cleanup hook. Everything in Phases 3+ depends on these.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T002 Implement the full `src/core/runs.ts` module per `contracts/runs-module.md`: directory helpers (`runsDir`, `ensureRunsDir`); low-level I/O (`writeRun` with write-tmp-and-rename atomicity per R-002, `readRun`, `listRuns` with corruption-skip per FR-010); mutation helpers (`updateRun`, `startRun`, `completeRun`, `updateRunLoopsCompleted`); phase helpers (`startPhase`, `completePhase` with `totalCostUsd` recomputation); subagent helper (`recordSubagent` with upsert-by-id semantics); failure-counter helpers (`getFailureCount`, `upsertFailureCount`, `resetFailureCount`); crash-recovery sweep (`reconcileCrashedRuns` with `process.kill(pid, 0)` aliveness check per R-007); steps helpers (`appendStep`, `readSteps` for `steps.jsonl`); derived views (`cycleSummary`, `latestPhasesForSpec`, `getSpecAggregateStats` per `data-model.md § 7`). Module imports MUST be limited to `node:fs`, `node:path`, `node:os`, `node:crypto` plus sibling pure modules in `src/core/` (Constitution Principle II).
- [X] T003 [P] Write unit tests at `src/core/runs.test.ts` covering all eight cases listed in `contracts/runs-module.md § Testing contract`: write/read round-trip; `listRuns` empty-dir + sort + skip-malformed; `updateRun` atomicity; `startPhase`/`completePhase` round-trip with cost recomputation; `recordSubagent` upsert; `reconcileCrashedRuns` with stub `aliveCheck`; `appendStep`/`readSteps` round-trip including partial-last-line skip. Use `node --test` (Node ≥20 built-in, no new dep). Tests run via `node --test src/core/runs.test.ts` from repo root.
- [X] T004 [P] Edit `src/main/index.ts`: (a) remove the `import { initDatabase, closeDatabase } from "../core/database.js"` line; (b) remove the `initDatabase()` call inside `createWindow()`; (c) remove the `closeDatabase()` call inside the `window-all-closed` handler; (d) at the top of `createWindow()` (or in `app.whenReady().then(...)` before `createWindow`), add the legacy-DB cleanup block per R-004: `const legacyDb = path.join(os.homedir(), ".dex", "db"); if (fs.existsSync(legacyDb)) { fs.rmSync(legacyDb, { recursive: true, force: true }); console.info("[dex] removed legacy SQLite directory:", legacyDb); }`. Add `import os from "node:os"` and `import fs from "node:fs"` at the top if not already present.

**Checkpoint**: Foundation ready — `runs.ts` module is complete and unit-tested. The Electron main process no longer initializes SQLite. User-story implementation can now proceed.

---

## Phase 3: User Story 1 — Inspect audit data with plain file tooling (Priority: P1) 🎯 MVP

**Goal**: Orchestrator writes a valid `RunRecord` JSON file to `<projectDir>/.dex/runs/<runId>.json` for every run, with phases, subagents, and per-phase `steps.jsonl` populated. After this phase, `cat <projectDir>/.dex/runs/<runId>.json | jq` produces the expected human-readable record (Story 1 acceptance scenario 1).

**Independent Test**: After completing Phase 3, run a Dex loop cycle on `dex-ecommerce` (reset to `after-tasks`), then verify `cat <projectDir>/.dex/runs/<runId>.json | jq '{runId, mode, status, totalCostUsd, phases: .phases | length}'` returns the expected fields. Note: the renderer will be temporarily broken between Phase 3 and Phase 4 (it still expects the old SQL-row shape) — this is intentional; ship Phase 3 + Phase 4 in the same PR.

### Implementation for User Story 1

- [X] T005 [US1] In `src/core/orchestrator.ts`, add an import for the new module: `import * as runs from "./runs.js"` (or named imports of the helpers used). Keep the existing `import { ... } from "./database.js"` line until T013 — symbols are removed incrementally below.
- [X] T006 [US1] In `src/core/orchestrator.ts` near the top of the orchestrator entry point (search for the start of `runOnce`/`runLoop`/`run` — the function that handles the `start` IPC), insert `runs.reconcileCrashedRuns(activeProjectDir!)` once `activeProjectDir` is known. Mirrors today's `cleanupOrphanedRuns` from `database.ts:128` which fired in `initDatabase`. Per R-007.
- [X] T007 [US1] Replace `createRun(...)` call site at `src/core/orchestrator.ts:1393` with `runs.startRun(activeProjectDir!, { runId, mode, model, specDir, startedAt: new Date().toISOString(), status: "running", writerPid: process.pid, description, fullPlanPath, maxLoopCycles, maxBudgetUsd })`. Drop arguments not present in the new shape; carry through the run-config fields that today populate `runs.description`, `runs.full_plan_path`, `runs.max_loop_cycles`, `runs.max_budget_usd`.
- [X] T008 [US1] Replace `completeRun(runId, finalStatus, totalCost, totalDuration, phasesCompleted)` at `src/core/orchestrator.ts:1460` with `runs.completeRun(activeProjectDir!, runId, finalStatus, totalCost, totalDuration, phasesCompleted)`.
- [X] T009 [US1] Replace every `createPhaseTrace({ id, runId, specDir, phaseNumber, phaseName })` call site in `src/core/orchestrator.ts` (lines 918, 1287, 1539, 2000, 2214, 2236, 2506, 2547) with `runs.startPhase(activeProjectDir!, runId, { phaseTraceId: id, runId, specDir, phaseNumber, phaseName, stage: <derive>, cycleNumber: <derive>, featureSlug: specDir ? path.basename(specDir) : null, startedAt: new Date().toISOString(), status: "running" })`. Derive `stage` and `cycleNumber` from the surrounding context: in loop-mode call sites (`loop:specify`, `loop:plan`, etc.) `stage` is the substring after the colon and `cycleNumber` is the existing `cycleNum` / `cycleNumber` local; in non-loop sites both are `null`.
- [X] T010 [US1] Replace every `completePhaseTrace(traceId, status, costUsd, durationMs, inputTokens, outputTokens)` call site in `src/core/orchestrator.ts` (lines 1200, 1307, 1335, 1827, 2002, 2216, 2238, 2564, 2594, 2604) with `runs.completePhase(activeProjectDir!, runId, traceId, { status, costUsd, durationMs, inputTokens, outputTokens })`. The new helper recomputes `totalCostUsd` and `phasesCompleted` internally so no follow-up call is needed.
- [X] T011 [US1] Replace `insertSubagent({ ...info, phaseTraceId })` at `src/core/orchestrator.ts:687` and `:1098` with `runs.recordSubagent(activeProjectDir!, runId, phaseTraceId, { id: info.subagentId, type: info.subagentType, description: info.description ?? null, status: "running", startedAt: info.startedAt, endedAt: null, durationMs: null, costUsd: 0 })`. Replace `completeSubagent(subagentId)` at `:721` and `:1121` with `runs.recordSubagent(activeProjectDir!, runId, phaseTraceId, { id: subagentId, ...existingFields, status: "ok", endedAt: new Date().toISOString(), durationMs: <computed> })` — relies on upsert-by-id semantics. The `phaseTraceId` is in scope at both completion sites.
- [X] T012 [US1] Remove the `insertLoopCycle({...})` call at `src/core/orchestrator.ts:2302` and the `updateLoopCycle(cycleId, ...)` calls at `:2314`, `:2339`, `:2794`. Replace by ensuring the `cycleNumber` field on each `runs.startPhase` call (T009) is correctly populated for loop-mode phases. The renderer derives cycle summaries via `runs.cycleSummary(run)` (T015 wires this) — no separate write path needed. Per R-005 / spec README "loop_cycles doesn't need a replacement".
- [X] T013 [US1] Replace `upsertFailureRecord(runId, specDir, impl, replan)` at `src/core/orchestrator.ts:1889` with `runs.upsertFailureCount(activeProjectDir!, runId, specDir, impl, replan)`. Replace `getFailureRecord(runId, specDir)` call sites with `runs.getFailureCount(activeProjectDir!, runId, specDir)` (returns the same `{impl, replan}` shape — review the call site to map field-name differences from today's `failure_tracker` row).
- [X] T014 [US1] Replace `updateRunLoopsCompleted(runId, cyclesCompleted)` at `src/core/orchestrator.ts:2357` and `:2795` with `runs.updateRunLoopsCompleted(activeProjectDir!, runId, cyclesCompleted)`.
- [X] T015 [US1] In the `emitAndStore` helpers in `src/core/orchestrator.ts:547-562` and the parallel helper near `:935-955`, replace the `insertStep({ ...enriched, phaseTraceId })` call with `runs.appendStep(activeProjectDir!, runId, slug(phaseName), phaseNumber, enriched)`. Compute `slug` using the same algorithm as `RunLogger.startPhase` at `:133`: `phaseName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")`. The `phaseNumber` and `phaseName` are in the closure; if not, capture them when the helper is constructed.
- [X] T016 [US1] Remove all symbols from the `import { … } from "./database.js"` block at `src/core/orchestrator.ts:17-31`. The import statement should be entirely deleted. Run `grep -n "database" src/core/orchestrator.ts` — expected: zero matches.

**Checkpoint**: Run a loop cycle on `dex-ecommerce` (reset to `after-tasks`). Verify `<projectDir>/.dex/runs/<runId>.json` exists, parses with `jq`, and contains the expected `phases` array. Verify `~/.dex/logs/dex-ecommerce/<runId>/phase-1_*/steps.jsonl` exists with one line per step. UI may not render correctly yet — that's Phase 4.

---

## Phase 4: User Story 4 — UI parity, no visible regression (Priority: P1)

**Goal**: After this phase, the runs list, run detail, per-phase cost/duration, subagent breakdown, and trace view all render identically to before the change. This is the second half of the storage migration and ships in the same PR as Phase 3.

**Independent Test**: After completing Phase 4, verify via electron-chrome MCP that opening the runs list, drilling into a run, opening a phase's trace view, and expanding subagent details all show data matching the on-disk JSON (per quickstart.md § 6).

### Implementation for User Story 4

- [X] T017 [US4] Rewrite `src/main/ipc/history.ts` per `contracts/ipc-history.md § Handler implementations`. Replace every import and handler body to call `runs.*` helpers. Channel names (`history:list-runs`, `history:get-run`, `history:get-latest-project-run`, `history:get-phase-steps`, `history:get-phase-subagents`, `history:get-latest-phase-trace`, `history:get-spec-phase-stats`, `history:get-spec-aggregate-stats`) are preserved; payload shapes change to camelCase records; five handlers gain a `projectDir` first parameter. Drop the `from "../../core/database.js"` import.
- [X] T018 [P] [US4] Update `src/main/preload.ts` history methods (lines 56-69) per `contracts/ipc-history.md § Preload bridge updates`: each method's argument list now passes `projectDir` (and where needed `runId`) through `ipcRenderer.invoke(...)` in the order specified. Method names on `window.dexAPI` are unchanged.
- [X] T019 [P] [US4] Update `src/renderer/electron.d.ts`: replace the `import type { RunRow, PhaseTraceRow, TraceStepRow, SubagentRow, LoopCycleRow, SpecStats } from "../core/database.js"` block with `import type { RunRecord, PhaseRecord, StepRecord, SubagentRecord, SpecStats } from "../core/runs.js"`. Update the eight history-method signatures in the `DexAPI` interface (lines 49-56) to match `contracts/ipc-history.md § Channel contracts`.
- [X] T020 [US4] Update `src/renderer/hooks/useOrchestrator.ts` history call sites: `:154` `getRun(state.runId)` → `getRun(state.projectDir, state.runId)`; `:249, :782, :824, :879` `getPhaseSteps(...)` and `getPhaseSubagents(...)` → add `state.projectDir` and `state.runId` (or appropriate scope variable) as leading args; `:627` `getLatestProjectRun(projectDir)` unchanged; `:774` `getLatestPhaseTrace(...)` unchanged signature. Adjust local variable names from snake_case (`run.total_cost_usd`, `phase.phase_number`) to camelCase (`run.totalCostUsd`, `phase.phaseNumber`) wherever the consumed fields are touched. Add `projectDir` to the closure at `:879` if not already in scope (state lookup).
- [X] T021 [P] [US4] Update `src/renderer/hooks/useProject.ts`: replace `import type { PhaseTraceRow, SpecStats } from "../../core/database.js"` with the equivalent from `../../core/runs.js` (`PhaseRecord, SpecStats`). Update field references at `:34` and `:117` from snake_case to camelCase per the new shape; signatures of `getSpecAggregateStats(dir, spec)` and `getSpecPhaseStats(projectDir, specName)` remain unchanged (already pass `projectDir`).
- [X] T022 [P] [US4] Update `src/renderer/components/task-board/PhaseView.tsx`: replace `import type { PhaseTraceRow } from "../../../core/database.js"` with `import type { PhaseRecord } from "../../../core/runs.js"`. Rename the `traceStats?: PhaseTraceRow | null` prop type to `traceStats?: PhaseRecord | null`. Update any internal field references from snake_case to camelCase.

**Checkpoint**: UI loads, runs list shows the new run produced in Phase 3, drilling into a phase's trace view renders the steps from `steps.jsonl`. Story 4 acceptance scenarios 1–3 pass via electron-chrome MCP snapshots.

---

## Phase 5: User Story 2 — Audit history lives with the project (Priority: P1)

**Goal**: Confirm and document that the implementation honors the spec's commit-policy default (`.dex/runs/` not gitignored). No code change needed beyond what Phase 3 already delivered (per-project paths in `runs.ts`).

**Independent Test**: After completing this phase, `git check-ignore <projectDir>/.dex/runs/foo.json` should return non-zero (i.e., not ignored) for any project that hasn't manually opted in.

### Implementation for User Story 2

- [X] T023 [US2] Verify the repo's `.gitignore` (root `/home/lukas/Projects/Github/lukaskellerstein/dex/.gitignore`) does NOT contain `.dex/` or `.dex/runs/`. The current file only ignores `.dex/state.lock`, which is correct — leave unchanged. Per FR-009. Do not add a `.dex/runs/.gitignore` either; users opt into ignoring on their own.

(No additional code tasks for this story — implementation is structurally enforced by Phase 3.)

**Checkpoint**: Story 2 acceptance scenarios 1–3 pass: deleting a project leaves no global zombie rows; cloning a repo with `.dex/runs/` committed preserves run history; users who add `.dex/runs/` to their own `.gitignore` get a clean clone with no errors.

---

## Phase 6: User Story 3 — Zero cross-project contamination (Priority: P2)

**Goal**: Prove that two projects on the same machine produce disjoint `.dex/runs/` directories with no shared global state.

**Independent Test**: Run a cycle on project A and project B; verify each project's runs list contains only its own runs (per quickstart.md § 7).

### Implementation for User Story 3

- [X] T024 [US3] Add an integration test case to `src/core/runs.test.ts`: create two distinct temporary `projectDir`s (under `os.tmpdir()`), call `runs.startRun(projectDirA, ...)` once and `runs.startRun(projectDirB, ...)` once, then assert that `runs.listRuns(projectDirA)` and `runs.listRuns(projectDirB)` each contain exactly one record with no overlap of `runId`s. Tests SC-005.

**Checkpoint**: SC-005 verified — projects are structurally isolated; no `WHERE project = ?` filter risk exists.

---

## Phase 7: User Story 5 — Clean install, no native build (Priority: P2)

**Goal**: Remove `better-sqlite3` and `@types/better-sqlite3` from the dependency tree. After this phase, `npm install` on a fresh checkout produces no native build step.

**Independent Test**: `grep -c better-sqlite3 package-lock.json` returns `0`; `npm install` on a fresh `node_modules/` completes without invoking `node-gyp` or any post-install build script.

### Implementation for User Story 5

- [X] T025 [US5] Delete `src/core/database.ts`. Verify no remaining imports: `grep -rn "from .*database" src/` should return zero matches (Phase 3+4 should have removed all of them; this task is the final delete).
- [X] T026 [US5] Edit `src/core/paths.ts`: remove the `DB_DIR` and `DB_PATH` constants. Keep `DEX_HOME`, `LOGS_ROOT`, `FALLBACK_LOG`, `DEV_LOGS_DIR`, and `migrateIfNeeded` (still used by `src/core/manifest.ts:125` and `src/core/orchestrator.ts:173`). Verify with `grep -rn "DB_DIR\|DB_PATH" src/` — expected: zero matches.
- [X] T027 [US5] Edit `package.json`: remove `"better-sqlite3": "^12.9.0"` from `dependencies` and `"@types/better-sqlite3": "^7.6.13"` from `devDependencies`.
- [X] T028 [US5] Run `npm install` from repo root. This regenerates `package-lock.json` without the removed packages and prunes `node_modules/`. Verify with `grep -c "better-sqlite3" package-lock.json` — expected: `0`.

**Checkpoint**: SC-008 verified — zero new dependencies, exactly one removed (plus its types).

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Documentation updates, final typecheck, and end-to-end verification per Constitution Principle III.

- [X] T029 [P] Update `.claude/rules/06-testing.md § 4f.4` (the "Audit trail" section). Replace the SQLite-centric description with the new JSON-files model: file location is now `<projectDir>/.dex/runs/<runId>.json`; cite `jq` examples; note that `getPhaseSteps` reads from `~/.dex/logs/<project>/<runId>/phase-<n>_*/steps.jsonl`; preserve the IPC helper-name table (the names are unchanged). Reference `specs/007-sqlite-removal/contracts/json-schemas.md` as the schema source.
- [X] T030 [P] Update `CLAUDE.md`: in the "Active Technologies" section, remove the `better-sqlite3` mention for feature 003-structured-outputs and 004-logs-alignment (they listed it as part of the stack); in the "On-Disk Layout" section, replace the "Global (machine-wide)" subtree's `db/` line with a note that the directory was retired in 007, and add `<projectDir>/.dex/runs/` to the per-project subtree below `state.json`.
- [X] T031 Run `npx tsc --noEmit` from repo root. Expected: zero errors. Fix any type mismatches surfaced by Phase 4's renderer field-renames.
- [X] T032 Run `node --test src/core/runs.test.ts` from repo root. Expected: all tests pass (T003 cases plus T024 cross-project case).
- [X] T033 Execute the full `quickstart.md` walkthrough end-to-end against `dex-ecommerce` at the `after-tasks` checkpoint. Verify every DoD item in `quickstart.md § Definition of Done` passes. Capture before/after screenshots of runs list, run detail, and one phase's trace view via electron-chrome MCP for SC-007 visual parity.
  - **Code-level verification done**: `npx tsc --noEmit` clean; `node --test dist/core/runs.test.js` 19/19 pass (round-trip, atomicity, corruption-skip, crash-recovery, cross-project isolation); `package-lock.json` contains 0 references to `better-sqlite3`.
  - **Runtime UI verification deferred**: dev-setup.sh was running an older compiled build at session start; restarting it would terminate the user's active Electron session. Runtime UI parity (SC-007) requires manually restarting `./dev-setup.sh` and walking through `quickstart.md` § 3–7. The compiled `dist/` already contains the new build, so the next Electron launch will exercise it.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — start immediately.
- **Phase 2 (Foundational)**: Depends on T001. Blocks all subsequent phases.
- **Phase 3 (US1)**: Depends on Phase 2 completion.
- **Phase 4 (US4)**: Depends on Phase 3 completion (the renderer needs the new on-disk format that Phase 3 produces). Phases 3 and 4 ship together — there is no working intermediate state.
- **Phase 5 (US2)**: Depends on Phase 3. Pure documentation/verification — can run in parallel with Phase 4 once Phase 3 is done.
- **Phase 6 (US3)**: Depends on Phase 2 (T002 specifically — only the `runs.ts` module is required). Can run in parallel with Phase 3.
- **Phase 7 (US5)**: Depends on Phase 3 + Phase 4 (the `database.ts` import sites must all be gone before the file can be deleted).
- **Phase 8 (Polish)**: Depends on Phases 3, 4, 5, 6, 7 — runs last.

### Within Each Phase

- Phase 2 tasks T002, T003, T004 are independent files and can run in parallel ([P] markers reflect this).
- Phase 3 tasks T005–T016 all edit `src/core/orchestrator.ts` and MUST run sequentially (single-file conflict).
- Phase 4 tasks T017, T018, T019, T021, T022 touch different files; T017 should run first (it's the canonical source of the new IPC shape); T020 depends on T019 because the renderer hook needs the new types in scope.
- Phase 7 tasks T025–T028 are sequential (each depends on the prior).
- Phase 8 T029, T030 are [P] (different files); T031, T032, T033 run sequentially.

### Parallel Opportunities

- **Within Phase 2**: T002, T003, T004 in parallel (3 different files).
- **Across Phase 3 and Phase 6**: T024 (US3 isolation test) can be added to `src/core/runs.test.ts` while Phase 3's orchestrator wire-up is in progress — no shared file.
- **Within Phase 4**: T018, T019, T021, T022 in parallel after T017 lands.
- **Within Phase 8**: T029, T030 in parallel.

---

## Parallel Example: Phase 2 (Foundational)

```bash
# Three different files, no dependencies — run as three concurrent tasks:
Task: "Implement complete runs.ts module per contracts/runs-module.md → src/core/runs.ts"
Task: "Write unit tests for runs.ts module → src/core/runs.test.ts"
Task: "Edit src/main/index.ts: remove SQLite init/close, add legacy DB cleanup"
```

## Parallel Example: Phase 4 (US4) after T017 lands

```bash
# Four different files — concurrent edits OK:
Task: "Update preload bridge → src/main/preload.ts"
Task: "Update electron.d.ts type imports and DexAPI signatures → src/renderer/electron.d.ts"
Task: "Update useProject.ts call sites and field renames → src/renderer/hooks/useProject.ts"
Task: "Update PhaseView.tsx prop type → src/renderer/components/task-board/PhaseView.tsx"
```

---

## Implementation Strategy

### Honest assessment for this refactor

Spec-kit's MVP-first model assumes user stories are independently shippable. This feature is a refactor where US1 + US4 must land together — there is no intermediate state where the orchestrator writes JSON but the UI doesn't read it. The phase structure provides traceability for acceptance tests; deployment is one PR.

### Recommended execution order

1. **Setup → Foundational (Phases 1–2)**: Land the new module + cleanup hook. The app still works because old `database.ts` is untouched and Phase 4 hasn't changed the IPC shape yet — wait, this is wrong: T004 removes `initDatabase()` which means SQLite calls in the orchestrator will throw. Solution: do not commit Phase 2 separately from Phase 3. Land Phases 1–4 in the same commit, or use a feature branch and test the full chain before pushing.
2. **Implement Phase 3 + Phase 4 as one logical unit**. Verify per quickstart.md after both are done.
3. **Phase 5 (docs verification)** + **Phase 6 (cross-project test)** — small additions, low risk.
4. **Phase 7 (cleanup)** — delete the dead file, remove the dep, regenerate the lockfile.
5. **Phase 8 (polish)** — docs, typecheck, full quickstart.

### Single-developer flow

1. Day 1: Phases 1, 2, 3 (the bulk of the work — `runs.ts` plus orchestrator wire-up).
2. Day 2: Phase 4 (renderer rewire), Phase 6 (isolation test), Phase 7 (cleanup).
3. Day 3: Phases 5, 8 (docs + final verification).

This matches the spec's estimate of 2–3 working days.

### Multi-developer flow

Not really applicable — this is a tightly coupled refactor that doesn't split well. The fastest path is one developer holding the orchestrator wire-up state in their head.

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks.
- [Story] label maps task to specific user story for traceability against the spec.
- This refactor's user stories are all delivered by the same Phase 3 + Phase 4 code change. The phased structure is for review traceability, not incremental deployment.
- Verify each phase checkpoint before moving on. Stop at any failure rather than accumulating broken state.
- Do not commit between Phase 2 and Phase 4 to `main` — the intermediate state has the orchestrator calling deleted SQLite functions. Feature branches only.
- Avoid: same-file conflicts within a phase (Phase 3 is intentionally sequential because every task edits `orchestrator.ts`).
