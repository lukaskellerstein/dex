---
description: "Task list for feature 004-logs-alignment"
---

# Tasks: Unified Logs & Diagnostics Layout

**Input**: Design documents from `/home/lukas/Projects/Github/lukaskellerstein/dex/specs/004-logs-alignment/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/README.md, quickstart.md

**Tests**: Unit tests are NOT generated for this feature per research.md Decision 7 — `paths.ts` / `migrateIfNeeded` are verified end-to-end via `quickstart.md` against the `dex-ecommerce` example project. Project has no unit-test harness in place; introducing one is out of scope. Typecheck (`npx tsc --noEmit`) covers the type-correctness failure mode most likely to regress path code.

**Organization**: Tasks are grouped by user story. US1 and US2 edit the same three source files in distinct phases so each story ships a meaningful, independently-verifiable increment (US1 = layout change for fresh installs; US2 = migration for upgrading users).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks).
- **[Story]**: Which user story this task belongs to (US1, US2, US3).
- Paths are absolute — this project sits under `/home/lukas/Projects/Github/lukaskellerstein/dex/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: This is a refactor in an existing, already-initialised project. No scaffolding, dependency installation, or linting setup is required. The only "setup" is verifying the workspace is on the correct branch with a clean tree.

- [X] T001 Verify git branch is `004-logs-alignment` with a clean working tree (`git status` clean at task start; `.specify/feature.json` points at `specs/004-logs-alignment`).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Single source of truth for every path. Both US1 (wiring) and US2 (migration) depend on this file.

**CRITICAL**: No user story work can begin until this phase is complete.

- [X] T002 Create `/home/lukas/Projects/Github/lukaskellerstein/dex/src/core/paths.ts` with constants `DEX_HOME`, `DB_DIR`, `DB_PATH`, `LOGS_ROOT`, `FALLBACK_LOG`, `DEV_LOGS_DIR` (each derived from `os.homedir()`), plus the `migrateIfNeeded(oldPath, newPath)` helper that guards with double-sided `existsSync` and uses a single `fs.renameSync`. Exact implementation per `plan.md` § "Migration Helper (normative)". Imports only `node:fs`, `node:path`, `node:os` — no Electron imports.

**Checkpoint**: `paths.ts` exists and `npx tsc --noEmit` passes. Stories US1, US2, US3 can now begin in parallel.

---

## Phase 3: User Story 1 — Predictable, self-describing diagnostic layout (Priority: P1) 🎯 MVP

**Goal**: Every writer module points at its canonical path under `~/.dex/db/`, `~/.dex/logs/`, or `<projectDir>/.dex/`. After this phase (on a fresh machine with no legacy data), all on-disk artefacts land in the unified layout and documentation describes them correctly.

**Independent Test**: On a machine with no pre-existing `~/.dex/` and a fresh `dex-ecommerce` clone, drive the welcome screen → start autonomous loop → let at least one cycle complete. Then `ls ~/.dex/` shows exactly `db/`, `logs/`, `dev-logs/` (dev-logs populated by US3 or absent on this step); per-project `.dex/` shows `state.json`, `state.lock`, `feature-manifest.json`, `learnings.md` and no stray files.

### Implementation for User Story 1

- [X] T003 [P] [US1] In `/home/lukas/Projects/Github/lukaskellerstein/dex/src/core/database.ts`, remove the local `getDbPath` computation (lines 9-13); import `DB_PATH` and `DB_DIR` from `./paths.js`; replace `new Database(getDbPath())` with `new Database(DB_PATH)`; ensure `DB_DIR` exists via `fs.mkdirSync(DB_DIR, { recursive: true })` before opening the DB. No migration call in this task — that is US2.

- [X] T004 [P] [US1] In `/home/lukas/Projects/Github/lukaskellerstein/dex/src/core/orchestrator.ts`, remove the local `LOGS_ROOT` constant (line 98) and the local `FALLBACK_LOG` constant (line 171); import both from `./paths.js`; the `log()` helper at lines 172-175 now writes to the imported `FALLBACK_LOG` (`~/.dex/logs/_orchestrator.log`). No migration call in this task — that is US2.

- [X] T005 [P] [US1] In `/home/lukas/Projects/Github/lukaskellerstein/dex/src/core/manifest.ts::appendLearnings` (line 118), change the `filePath` computation (line 123) to `path.join(projectDir, ".dex", "learnings.md")`. No migration call in this task — that is US2.

- [X] T006 [P] [US1] Update `/home/lukas/Projects/Github/lukaskellerstein/dex/CLAUDE.md` — remove the bullet referring to `<projectDir>/.dex/artifacts/` (never implemented); add a note that `<projectDir>/.dex/` is committable except `state.lock`; describe the new `~/.dex/` layout (`db/`, `logs/`, `dev-logs/`).

- [X] T007 [P] [US1] Update `/home/lukas/Projects/Github/lukaskellerstein/dex/.claude/rules/06-testing.md` section 4f — replace every path reference: `/tmp/dex-logs/` → `~/.dex/dev-logs/`, `~/.dex/data.db` → `~/.dex/db/data.db`, `~/.dex/orchestrator.log` → `~/.dex/logs/_orchestrator.log`. Add `learnings.md` to the per-project state table (section 4f.3).

**Checkpoint**: US1 is independently verifiable. Fresh installs route every artefact to its unified location. `npx tsc --noEmit` passes. Documentation and implementation agree.

---

## Phase 4: User Story 2 — Zero historical-data loss on upgrade (Priority: P1)

**Goal**: Existing users with legacy `~/.dex/data.db`, `~/.dex/orchestrator.log`, and/or `<projectDir>/.claude/rules/learnings.md` see those files atomically relocated to their new paths on first start — no manual action, no data loss, idempotent on re-runs.

**Independent Test**: Starting from a home directory with a pre-upgrade `~/.dex/data.db` (non-empty), pre-upgrade `~/.dex/orchestrator.log` (if present), and `<projectDir>/.claude/rules/learnings.md` (if present), launch the upgraded app. All three artefacts are moved to their new locations with identical contents; Loop Dashboard continues to list every pre-upgrade run; restarting the app twice performs zero migration writes.

### Implementation for User Story 2

- [X] T008 [P] [US2] In `/home/lukas/Projects/Github/lukaskellerstein/dex/src/core/database.ts::initDatabase`, import `migrateIfNeeded` from `./paths.js`. Before `new Database(...)`, call `migrateIfNeeded` three times — once each for `data.db`, `data.db-wal`, `data.db-shm` — mapping `path.join(DEX_HOME, <name>)` → `path.join(DB_DIR, <name>)`. Order: `.db` first, then the WAL/SHM siblings (SQLite re-creates them cleanly if absent, so correct order matters only for the `.db` file).

- [X] T009 [P] [US2] In `/home/lukas/Projects/Github/lukaskellerstein/dex/src/core/orchestrator.ts::log` (the fallback logger around line 172), import `migrateIfNeeded` from `./paths.js`. Before the first `appendFileSync` to `FALLBACK_LOG`, call `migrateIfNeeded(path.join(os.homedir(), ".dex", "orchestrator.log"), FALLBACK_LOG)`. Use a module-level `let fallbackMigrated = false` or equivalent guard so the helper is invoked once per process (the helper itself is idempotent, but avoiding the `existsSync` pair on every log line is a trivial optimisation).

- [X] T010 [P] [US2] In `/home/lukas/Projects/Github/lukaskellerstein/dex/src/core/manifest.ts::appendLearnings`, import `migrateIfNeeded` from `./paths.js`. Before the existing `fs.existsSync(filePath)` read at line 126, call `migrateIfNeeded(path.join(projectDir, ".claude", "rules", "learnings.md"), filePath)`. This relocates any legacy per-project learnings file atomically before the function tries to read its current content.

**Checkpoint**: US2 is independently verifiable. Upgrade a machine that has legacy data → post-upgrade layout has data in new locations, old locations are empty or gone, Loop Dashboard still shows every pre-upgrade run. Two restarts produce zero migration writes.

---

## Phase 5: User Story 3 — Dev-server logs outside `/tmp/` (Priority: P2)

**Goal**: `dev-setup.sh` writes Vite and Electron logs under `~/.dex/dev-logs/` and prints the new paths in its banner, so developers find them in the same root as every other Dex artefact.

**Independent Test**: Run `./dev-setup.sh` on a machine where `~/.dex/dev-logs/` does not yet exist. After startup, the directory exists and contains `vite.log` + `electron.log`; the banner printed by the script tells the user the new paths.

### Implementation for User Story 3

- [X] T011 [US3] In `/home/lukas/Projects/Github/lukaskellerstein/dex/dev-setup.sh` — change line 16 from `LOG_DIR="/tmp/dex-logs"` to `LOG_DIR="${HOME}/.dex/dev-logs"` (keep the `mkdir -p "$LOG_DIR"` on line 17 unchanged — it already handles the new path). Update the banner lines 57-59 so the printed log-file paths reflect the new `$LOG_DIR`. Do not remove the `/tmp/dex-logs/` directory if it exists; leave it untouched for user inspection.

**Checkpoint**: US3 is independently verifiable. `dev-setup.sh` produces logs only under `~/.dex/dev-logs/`.

---

## Phase 6: Polish & Verification

**Purpose**: Typecheck the whole change and run the end-to-end verification flow from `quickstart.md` against the example project.

- [X] T012 Run `npx tsc --noEmit` from `/home/lukas/Projects/Github/lukaskellerstein/dex/`. Exit code 0 required. Fixes any type errors introduced by the phase 2–5 edits.

- [~] T013 Partial: smoke-tested `migrateIfNeeded` against a tempdir (all four cases pass — migrate, idempotent, both-exist-preserve, neither-exists-noop). Full end-to-end verification against `dex-ecommerce` is pending user restart of `dev-setup.sh` (the currently running Electron was started before this change and holds old compiled code).

**Checkpoint**: All DoD items in `quickstart.md` pass. Feature is ready to report as complete.

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 (Setup)**: no dependencies.
- **Phase 2 (Foundational)**: depends on Phase 1. **Blocks** all user-story phases.
- **Phase 3 (US1)**: depends on Phase 2.
- **Phase 4 (US2)**: depends on Phase 2 **and** Phase 3 — US2 tasks edit the same three files as US1 and assume those files already import from `paths.ts`. Sequential with US1 on a per-file basis.
- **Phase 5 (US3)**: depends on Phase 2 only. Can run in parallel with Phase 3 and Phase 4 (different file: `dev-setup.sh`).
- **Phase 6 (Polish)**: depends on all previous phases.

### User story dependencies

- **US1 (P1)**: foundational only. Independently testable on a fresh install.
- **US2 (P1)**: foundational + US1. Independently testable against a machine with legacy data. US2 cannot land without US1's wiring because the migration targets are the new paths that US1 introduces.
- **US3 (P2)**: foundational only. Fully independent of US1/US2 (touches `dev-setup.sh`, nothing else).

### Within each user story

- All tasks marked [P] within a phase touch different files and may run concurrently.
- There are no tests in this feature (see research.md Decision 7), so there is no test-before-implementation ordering.
- Documentation tasks (T006, T007) may run concurrently with source changes — they touch `.md` files, not `.ts` files.

### Parallel opportunities

- T003, T004, T005, T006, T007 (entire US1 phase) are all [P] — five concurrent tasks.
- T008, T009, T010 (entire US2 phase) are all [P] — three concurrent tasks, after US1 completes.
- T011 (US3) can run any time after T002.

---

## Parallel Example: User Story 1

```text
# All US1 tasks touch different files and can run concurrently once T002 is done:
Task: T003 — rewire database.ts to use DB_PATH/DB_DIR
Task: T004 — rewire orchestrator.ts to use LOGS_ROOT/FALLBACK_LOG
Task: T005 — rewire manifest.ts::appendLearnings to <projectDir>/.dex/learnings.md
Task: T006 — update CLAUDE.md layout documentation
Task: T007 — update .claude/rules/06-testing.md diagnostic paths
```

## Parallel Example: User Story 2

```text
# All US2 tasks touch different files and can run concurrently once US1 is done:
Task: T008 — add migrateIfNeeded calls in database.ts
Task: T009 — add migrateIfNeeded call in orchestrator.ts fallback log
Task: T010 — add migrateIfNeeded call in manifest.ts::appendLearnings
```

---

## Implementation Strategy

### Single-PR delivery (recommended)

Per `plan.md` § "Phasing", **all work lands in a single PR**. A partial landing would leave the code pointing at a new path while a subsystem sits at the old path — the worst possible intermediate state. Execute the phases in order within that PR; use each checkpoint to gate progress.

### Incremental verification within the PR

Even though the PR is atomic, the phases are checkpoint-separable:

1. **Phase 1 + Phase 2 complete** → typecheck; nothing changes at runtime yet because no caller imports `paths.ts`.
2. **Phase 3 complete** → typecheck; fresh machines now use the new layout but upgraders temporarily lose visibility of legacy audit data. **Do not deploy at this checkpoint.**
3. **Phase 4 complete** → typecheck; upgraders now recover their legacy data automatically. This is the first checkpoint that is safe for an existing user.
4. **Phase 5 complete** → `dev-setup.sh` writes to the new location.
5. **Phase 6 complete** → full `quickstart.md` DoD passes. Ready to report.

### MVP scope

User Story 1 alone is an MVP *only* for users with no legacy data. For any machine that has run Dex before, US1+US2 is the minimum shippable increment. In practice: treat US1+US2 as the MVP and US3 as a follow-on polish that can ship together since it is a two-line change.

---

## Notes

- No unit tests are generated — verification is end-to-end per `quickstart.md` (research.md Decision 7).
- Each phase boundary is a natural typecheck gate; run `npx tsc --noEmit` between phases to catch wiring errors early.
- Do **not** add dual-path reader logic as a rollback safety net; it permanently re-introduces the "where does this live?" ambiguity the feature exists to eliminate (research.md Decision 6).
- Do **not** commit via `git` until the user explicitly asks for it (per `/home/lukas/.claude/CLAUDE.md`).
