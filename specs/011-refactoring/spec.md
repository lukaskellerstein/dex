# Feature Specification: Refactor Dex for AI-Agent Modification (Phase 2)

**Feature Branch**: `011-refactoring`
**Created**: 2026-04-26
**Status**: Draft
**Input**: User description: "read /home/lukas/Projects/Github/lukaskellerstein/dex/docs/my-specs/011-refactoring/README.md"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Modify a single concept without reading the whole system (Priority: P1)

A developer (human or AI agent) needs to change how Dex performs prerequisite checks before a run, or how it parses a gap-analysis decision, or how the renderer reacts to a `clarification_question` event. Today they cannot — the orchestrator is one 2,313-line file with a 1,073-line `runLoop` function, the renderer hook is 907 lines with 21 `useState` calls and a 25-case event switch, and the entry-point component is 720 lines. Any of these alone exceeds the working context an AI agent can hold while reasoning about the change. The agent ends up reading the entire file, building a partial mental model, and making changes with low confidence.

After this refactor, the same change becomes: open one named file (e.g. `src/core/stages/prerequisites.ts`), read its top-of-file orientation comment naming what it does and depends on, modify, and run a colocated unit test that pins the contract.

**Why this priority**: This is the entire point of the refactor. Every other improvement is in service of this single outcome. Without it, AI agents will continue to need full-file reads and produce shallow changes.

**Independent Test**: Pick a single concept (e.g. "prerequisites check sequence"). A reviewer can verify the work by asking an AI agent to add one new prerequisite without giving it any pointer beyond the project root — if it locates the right file by name and modifies only that file, the story succeeds.

**Acceptance Scenarios**:

1. **Given** a fresh AI-agent session opening Dex, **When** asked to add a new prerequisite check, **Then** the agent finds `src/core/stages/prerequisites.ts`, reads ≤600 lines, and adds one declarative entry without touching any other core file.
2. **Given** the post-refactor codebase, **When** any source file in scope is measured, **Then** no file exceeds 600 lines and no function exceeds 120 lines (with the documented file-size exceptions list as the only allowed escapes).
3. **Given** a renderer change limited to "what happens when a clarification question arrives", **When** the change is made, **Then** it lives in `useUserQuestion.ts` only and does not touch loop state, trace state, or run-session hooks.

---

### User Story 2 - Ship the refactor in reviewable waves with regression safety (Priority: P1)

The refactor is large (8+ extracted core modules, 5 split renderer hooks, 6 services, 7 split components, plus tests). Shipping it as one giant PR is unreviewable and risks an undiscovered behaviour regression that surfaces only at the end. Lukas needs the work delivered as a sequence of wave-shaped PRs, each individually reviewable, each ending with a smoke run + golden-trace diff so regressions are caught at the wave boundary rather than three weeks later.

**Why this priority**: Behaviour preservation is the single hardest constraint of this refactor — `01X-state-reconciliation` and other downstream specs explicitly assume the current emit sequence and state-machine shape stay intact. Without per-wave verification, a behaviour drift introduced early is unfindable late.

**Independent Test**: Run any single wave's PR through its verification gate (typecheck + tests + clean smoke + checkpoint smoke + golden-trace diff). If all pass, the wave is mergeable on its own. If any fail, the wave's commits roll back without affecting other waves.

**Acceptance Scenarios**:

1. **Given** Wave A has merged to `main`, **When** Wave B and Wave C work resume on `lukas/refactoring`, **Then** the verification suite still passes on the merged Wave A baseline alone.
2. **Given** a sub-gate within Wave A introduces a regression caught by the golden-trace diff, **When** the gate is rolled back, **Then** earlier sub-gates of Wave A remain intact and the next attempt resumes from the rolled-back gate.
3. **Given** a wave has merged to `main`, **When** an issue surfaces post-merge, **Then** the wave's PR description provides the exact `git revert <merge-sha>` command and a smoke checklist that confirms the revert restores function.

---

### User Story 3 - Change one IPC call without touching 14 files (Priority: P2)

Today, 14 files (12 components + 2 hooks) reach into `window.dexAPI` directly. Renaming an IPC method, changing a payload shape, or adding a typed error code requires editing every consumer. After the refactor, every IPC call routes through a typed service wrapper (`checkpointService`, `orchestratorService`, etc.), so the same change touches one service file plus its callers — and the call sites themselves see only typed function signatures, not raw `window.dexAPI` reach-ins.

**Why this priority**: This is a scoped, high-leverage win that also unblocks Wave B — split renderer hooks should consume services from day one rather than be rewritten twice.

**Independent Test**: Pick any IPC call (e.g. `window.dexAPI.checkpoints.jumpTo`). Verify that after the refactor, only one file (`checkpointService.ts`) holds the `window.dexAPI` reference, and all consumers import from the service. A grep for `window\.dexAPI` outside `src/renderer/services/` returns zero matches.

**Acceptance Scenarios**:

1. **Given** the post-Wave-C codebase, **When** searching for `window.dexAPI` outside `src/renderer/services/`, **Then** no matches are found.
2. **Given** a service throws a typed error code (e.g. `CheckpointError` with `code: 'NOT_FOUND'`), **When** a consumer wants to handle that case, **Then** the code is discoverable from the service's type signature, not by tracing back to `src/main/ipc/`.

---

### User Story 4 - Split renderer state by domain so changes don't ripple (Priority: P2)

The single `useOrchestrator` god hook concentrates 21 state variables, 25+ event subscriptions, and 4 distinct concerns (loop state, live trace, user question, run session, prerequisites) into one file. Touching one concern means re-reading the others. After the split, each concern owns one hook with one slice of state and one slice of events, plus a thin composer that re-exports the union shape so existing components keep working unchanged during migration.

**Why this priority**: This is the renderer-side analogue of User Story 1, but it's P2 because the core decomposition is the riskier and higher-value half — getting that right is what unlocks the orchestrator's testability.

**Independent Test**: Pick one event type (e.g. `clarification_question`). Verify that exactly one hook subscribes to it post-refactor, and that the corresponding state lives in the same hook. The state→hook and event→hook matrices in `event-order.md` cover all 21 states and all 25 event types.

**Acceptance Scenarios**:

1. **Given** the post-Wave-B codebase, **When** opening any of the five renderer hooks, **Then** each hook's state declarations and event subscriptions match the matrix in `docs/my-specs/011-refactoring/event-order.md`.
2. **Given** a phase-scoped error event arrives (e.g. tagged `phase: "prerequisites"`), **When** the discriminator routing is in effect, **Then** the corresponding hook handles it; **And given** an error event has no matching active hook, **Then** the composer's fatal-error sink catches it.

---

### User Story 5 - Stop file-size drift after the refactor lands (Priority: P3)

Without an enforced size check, a future feature drops a 700-line file in `src/core/` and the next refactor starts from the same place. A simple script pinned in `package.json` (`npm run check:size`) fails locally and in CI when a file exceeds 600 LOC, with an allow-list for the documented exceptions. The 5-minute setup amortizes over the project's lifetime.

**Why this priority**: Defensive, low-effort, and protects the gains. P3 because the immediate refactor benefit lands without it; the script just keeps the benefit from rotting.

**Independent Test**: After Wave A, intentionally create a 700-line file and run `npm run check:size`. The script must exit non-zero and name the file. Removing the file restores a clean exit.

**Acceptance Scenarios**:

1. **Given** Wave A has shipped, **When** `npm run check:size` runs, **Then** it exits clean — the only files >600 LOC are the documented exceptions in the allow-list.
2. **Given** a future PR introduces a new file >600 LOC, **When** the script runs in CI, **Then** the PR fails with a message naming the file and pointing at `file-size-exceptions.md`.

---

### Edge Cases

- **Wave-internal regression caught between sub-gates** → roll back the gate's commits on `lukas/refactoring` and reattempt; no need to revert merged waves.
- **Post-merge regression caught after a wave is on `main`** → revert PR on `main` using the command in the wave's PR description; do not branch-rebase.
- **More than the documented number of file-size exceptions needed** → refactor failure; either reduce file size or expand the exceptions document with explicit justification (which itself requires user approval).
- **An IPC consumer skipped during Wave C migration** → all 14 `window.dexAPI` consumers must migrate in Wave C; a leftover raw reach-in is a Wave-C failure, not "we'll get to it later".
- **An `error` event emitted with a phase that doesn't match any active hook's discriminator** → the composer's top-level fatal-error sink catches it.
- **The clarification interactive flow's pending-promise handle still needs to live somewhere** → the `OrchestrationContext` design must place it on `ctx` (preferred) or as an explicit IPC-layer singleton paired with `submitUserAnswer`. "Module-globals fully eliminated" is overstated; the residual singleton (`abortController` + `releaseLock` + the pending-promise handle) is documented inline at the IPC layer.
- **A8-prep path choice changes the IPC layer** → must be decided before Gate 0 starts; picking it late invalidates Gate 0's smoke baseline.
- **The golden-trace baseline flakes on a single run** → two baselines are intersected to filter race-y emit ordering between SDK stream events and orchestrator emits; only events present in both are part of the canonical baseline.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: After the refactor, no source file modified by the refactor SHALL exceed 600 lines, except the documented exceptions (`src/core/state.ts`, `src/core/agent/ClaudeAgentRunner.ts`).
- **FR-002**: After the refactor, no function in any modified file SHALL exceed 120 lines.
- **FR-003**: Each newly extracted module SHALL expose exactly one concept (e.g. prerequisites, clarification, gap-analysis decision, finalize, phase-lifecycle, main-loop) and the file name SHALL match the concept.
- **FR-004**: The renderer's orchestrator-state ownership SHALL be partitioned across five domain-bounded hooks (loop state, live trace, user question, run session, prerequisites) plus one thin composer that re-exports the union shape.
- **FR-005**: Every IPC invocation from the renderer SHALL route through one of six typed service wrappers; no component or hook outside `src/renderer/services/` SHALL reference `window.dexAPI` directly.
- **FR-006**: Each typed service SHALL export typed errors (e.g. `CheckpointError` with a discriminated `code` field) drawn from the IPC error vocabulary enumerated in `error-codes.md`.
- **FR-007**: Each newly extracted core module SHALL ship with a unit test that pins its contract; renderer hooks ship with hook-level tests under the chosen test infrastructure (`vitest` + `@testing-library/react` + `jsdom`).
- **FR-008**: The refactor SHALL NOT change observable orchestrator behaviour — event semantics, state-machine shape, the synthetic `step_started`/`step_completed` pair from `emitSkippedStep`, the `decision === "stopped"` → `status: "running"` mapping, the 5-second resume heuristic in `StageList`, and the single-mode `reconcileState` all stay intact.
- **FR-009**: After Wave A, an automated check (`npm run check:size`) SHALL fail when any file >600 LOC is introduced, with the documented exceptions on an explicit allow-list.
- **FR-010**: Each newly extracted module SHALL begin with a 3–5 line orientation comment naming (a) what the module does, (b) what it deliberately does not do, (c) what it depends on.
- **FR-011**: The refactor SHALL preserve the public `window.dexAPI` shape during migration; service-layer adoption is additive, with components migrating one at a time within Wave C and all 14 current consumers migrated by end of Wave C.
- **FR-012**: After each Wave-A sub-gate (G0–G4), a golden-trace regression check SHALL diff the post-gate INFO|WARN|ERROR emit set against the pre-A baseline (intersection of two baseline runs); diffs are only acceptable if listed as tolerable reorders in `event-order.md`.
- **FR-013**: A `module-map.md` SHALL list every file in `src/core/` post-decomposition with a one-line responsibility per file, produced at end of Wave A.
- **FR-014**: Five spec-folder artefacts SHALL be produced at the named milestones — `file-size-exceptions.md` (Pre-Wave), `golden-trace-pre-A.txt` (Pre-Wave, intersection of two baseline runs), `error-codes.md` (Pre-Wave / C3 prerequisite), `event-order.md` (B0), `module-map.md` (end of Wave A).
- **FR-015**: At the end of every Wave-A sub-gate and at the end of Waves B/C/D, the verification suite SHALL pass: `npx tsc --noEmit` clean, `npm test` clean (including new tests), full clean smoke run on `dex-ecommerce`, resume smoke run from a recent checkpoint, no new errors in the renderer DevTools console, intact per-run log tree at `~/.dex/logs/<project>/<runId>/`, and a golden-trace diff within tolerable reorders.
- **FR-016**: The orchestrator's session state (`abortController`, `runner`, `state`, `projectDir`, `releaseLock`, `emit`, `rlog`, and the pending-question handle) SHALL be threaded through an `OrchestrationContext` value passed to extracted phase functions; residual process-level singletons at the IPC layer (the IPC handlers that call `stopRun` / `submitUserAnswer` from outside `runLoop`) SHALL be documented inline.
- **FR-017**: `src/core/checkpoints.ts` SHALL be split into seven sub-files under `src/core/checkpoints/` (tags, jumpTo, recordMode, variants, timeline, variantGroups, commit) with `src/core/checkpoints.ts` becoming a re-export shim; the existing `checkpoints.test.ts` SHALL pass without modification.
- **FR-018**: All 25 event-type cases of the existing `useOrchestrator` switch and all 21 `useState` calls SHALL be assigned to one and only one of the five new hooks per the matrices in `event-order.md`; phase-scoped `error` events SHALL route to the relevant hook by phase discriminator, with a composer-level fatal-error sink catching unmatched events.
- **FR-019**: Each wave (A, C-services, B, C-rest, D) SHALL ship as its own squash-merged PR to `main`; each PR description SHALL include the post-merge revert command and a smoke checklist that confirms the revert restores function.
- **FR-020**: The user — not the agent — SHALL trigger every git commit; the agent SHALL NOT auto-commit during the refactor.

### Key Entities

- **Refactor Wave**: A sequenced delivery boundary (A, C-services, B, C-rest, D). Each wave has its own verification gate and ships as its own squash-merged PR.
- **Sub-Gate** (Wave A only): A wave-internal commit boundary (G0..G4) ending with smoke + golden-trace diff so a failed smoke isolates to a small diff.
- **Module**: A single-concept source file; named after the concept; carries a top-of-file orientation comment.
- **Service**: A typed IPC wrapper exporting async functions and typed errors; the only place `window.dexAPI` is referenced.
- **Hook**: A domain-bounded renderer state container owning one slice of state and one slice of event subscriptions.
- **File-Size Exception**: A pre-existing source file allowed to exceed 600 LOC, listed with rationale in `file-size-exceptions.md`.
- **Golden Trace**: The canonical INFO|WARN|ERROR emit sequence per stage, captured pre-Wave-A as the intersection of two baseline runs, used as the regression-check anchor at each sub-gate.
- **Orchestration Context**: A session value threading the per-run mutable state (`abortController`, `runner`, `state`, `projectDir`, `releaseLock`, `emit`, `rlog`, pending-question handle) through extracted phase functions.
- **Wave-Verification Gate**: The composite check (`tsc` + `npm test` + clean smoke + checkpoint-resume smoke + DevTools console clean + log tree intact + file-size audit + golden-trace diff) that doubles as PR-readiness criteria.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An AI agent given the project root and a single-concept change request (e.g. "add a prerequisite for X") locates the right file by name and modifies only that file in ≥9 of 10 trials.
- **SC-002**: After the refactor, the largest in-scope file is ≤600 lines (down from 2,313 in `orchestrator.ts`) and the largest function in scope is ≤120 lines (down from ~1,073 in `runLoop`).
- **SC-003**: A single change to an IPC call shape touches at most 1 file (the typed service wrapper), down from up to 14 today.
- **SC-004**: An end-to-end clean smoke run on the `dex-ecommerce` example project succeeds at every wave gate (welcome → Open Existing → autonomous loop with auto-clarification → prerequisites complete → clarification produces a plan → at least one cycle through specify → plan → tasks → implement → learnings → checkpoint creation visible in `git log --grep='^\[checkpoint:'`).
- **SC-005**: A resume smoke run after `./scripts/reset-example-to.sh <recent-checkpoint>` succeeds at every wave gate.
- **SC-006**: After Wave A, `npm run check:size` exits clean except for the explicitly allow-listed exceptions; introducing an unauthorized 700-line file flips the exit non-zero with the file named in the output.
- **SC-007**: At least 4 newly extracted core modules (`prerequisites`, `gap-analysis`, `finalize`, `phase-lifecycle`) and at least 4 newly extracted renderer hooks (`useLoopState`, `useLiveTrace`, `useUserQuestion`, `useRunSession`) carry contract-level unit tests after Wave D.
- **SC-008**: After each Wave-A sub-gate, the golden-trace diff against `golden-trace-pre-A.txt` is empty or contains only reorders explicitly enumerated in `event-order.md`.
- **SC-009**: A grep for `window\.dexAPI` outside `src/renderer/services/` returns zero matches after Wave C.
- **SC-010**: A reviewer can read any one of the wave PR descriptions standalone (without the spec) and run the post-merge revert command if needed; the smoke checklist in the PR confirms the revert restores function.
- **SC-011**: The renderer DevTools console shows no new errors after any wave gate (`mcp__electron-chrome__list_console_messages`).
- **SC-012**: A new contributor onboarding to `src/core/` after Wave A locates the file responsible for any of the seven major concepts (prerequisites, clarification, main-loop, gap-analysis, finalize, phase-lifecycle, checkpoints) using `module-map.md` alone within 1 minute.

## Assumptions

- **Behaviour-preserving refactor.** This work is structural only. Correctness fixes (e.g. `01X-state-reconciliation`, the synthetic `step_started`/`step_completed` pair, the 5-second resume heuristic) are deliberately out of scope and will land on dedicated specs after this refactor merges.
- **Audit data lives in per-project JSON.** SQLite was retired in 007; `phase-lifecycle.ts` wraps the JSON writers, not a database. Any reference to `runs.recordDB` from earlier drafts is stale.
- **Test infrastructure choice — Path A (vitest + @testing-library/react + jsdom for renderer, `node:test` for core).** Two test runners is mild friction; zero hook tests on a 5-hook split is a real risk.
- **A8-prep choice — Path α by default** (keep `run()` as a slimmed ~30-line dispatcher; IPC unchanged). Path β (delete `run()`, update IPC) is acceptable if explicitly chosen during Pre-Wave; the choice is locked before Gate 0 starts.
- **Pending-question handle lives on `OrchestrationContext`** (preferred per A1 design) so `clarification.ts` stays pure.
- **`dex-ecommerce` is the canonical smoke target.** Reset via the authorized scripts only (`./scripts/reset-example-to.sh`, `./scripts/prune-example-branches.sh`, `./scripts/promote-checkpoint.sh`).
- **`lukas/refactoring` is the working branch.** Each wave squash-merges to `main` as a separate PR; the branch is force-deleted after the last wave merges.
- **The user runs git commits manually.** Per the global CLAUDE.md rule, the agent never commits unless explicitly asked.
- **Style tokens are scoped to components rewritten by C4–C6 only** (~13 files); the remaining ~44 files adopt tokens opportunistically as touched. No tracker — those rot.
- **The five spec-folder artefacts are checked into the repo** under `docs/my-specs/011-refactoring/` so future audits and the next refactor wave can rely on them.
- **No new prod dependencies; the Wave-D test dev-deps are the only acceptable additions.**
