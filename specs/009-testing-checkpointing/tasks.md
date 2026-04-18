---
description: "Task list for 009-testing-checkpointing"
---

# Tasks: Testing Checkpointing via Mock Agent

**Input**: Design documents from `/specs/009-testing-checkpointing/`
**Prerequisites**: `plan.md` (✔), `spec.md` (✔), `research.md` (✔), `data-model.md` (✔), `contracts/` (✔), `quickstart.md` (✔)

**Tests**: Included. Vitest tests are called out by the constitution (Principle III — Test Before Report) and by the quickstart DoD. Unit tests gate every runner implementation (see `contracts/AgentRunner.md` "Testing contract"); E2E tasks validate behavior against the live `dex-ecommerce` project.

**Organization**: Tasks are grouped by user story. Phase 2 (Foundational) delivers US2 as a byproduct — US2's user-facing promise ("swap backends without touching orchestrator code") is satisfied the moment the interface + registry + ClaudeAgentRunner extraction land. Subsequent US1 / US3 / US4 / US5 phases each add the mock-backend production code + focused verification for one quality facet.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete work)
- **[Story]**: Which user story this task serves — `[US1]`, `[US3]`, `[US4]`, `[US5]`. Setup + Foundational + Polish have no story label.
- File paths are absolute-from-repo-root.

## Path Conventions

Single-project layout (per `plan.md` Structure Decision).
- Production code: `src/core/agent/`, `src/core/dexConfig.ts`, edits to `src/core/orchestrator.ts`, `src/core/types.ts`.
- Tests: `src/core/agent/__tests__/`, `src/core/__tests__/` (colocated Vitest).
- Fixtures: `fixtures/mock-run/` at repo root.
- Example project (for E2E): `/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create directories and gitignore entries. No production code yet.

- [x] T001 Create directories `src/core/agent/` and `src/core/agent/__tests__/` in the Dex repo (placeholder `.gitkeep` files acceptable)
- [x] T002 [P] Create directory `fixtures/mock-run/` at Dex repo root (placeholder `.gitkeep` acceptable)
- [x] T003 [P] Add `.dex/dex-config.json` and `.dex/mock-config.json` to `/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce/.gitignore` (the broader `.dex/` block may already cover these — verify and add explicit entries for clarity)

**Checkpoint**: Tree scaffolded. Foundation phase can begin.

---

## Phase 2: Foundational (Blocking Prerequisites — delivers US2)

**Purpose**: Extract agent execution behind the `AgentRunner` contract and wire the orchestrator to a runner resolved via registry + selector config. This phase delivers User Story 2's capability ("swap backends without touching orchestrator code") by construction.

**⚠️ CRITICAL**: No mock-backend work can begin until this phase is complete AND the regression smoke run (T016) has passed.

- [x] T004 Create `src/core/agent/AgentRunner.ts` — `AgentRunner` interface with `runStage(ctx: StageContext): Promise<StageResult>` and `runPhase(ctx: PhaseContext): Promise<PhaseResult>` plus the `StageContext`, `StageResult`, `PhaseContext`, `PhaseResult`, `AgentRunnerFactory` types per `data-model.md` §3 and `contracts/AgentRunner.md`
- [x] T005 Modify `src/core/types.ts` to add the optional override field `agent?: string` to `RunConfig` (per `plan.md` Technical Context and research D12)
- [x] T006 [P] Create `src/core/agent/registry.ts` — module-level `AGENT_REGISTRY`, `registerAgent(name, factory)`, `createAgentRunner(name, runConfig, projectDir)`, `getRegisteredAgents()`, and `UnknownAgentError` class. Error message format per `contracts/registry.md`: `"Unknown agent: 'X'. Registered: claude, mock"`
- [x] T007 [P] Create `src/core/dexConfig.ts` — `DexConfig` interface, `loadDexConfig(projectDir) → DexConfig`, `DexConfigParseError`, `DexConfigInvalidError`. Absent file returns `{ agent: "claude" }` (spec FR-002). Schema per `contracts/dex-config.schema.json`
- [x] T008 Create `src/core/agent/ClaudeAgentRunner.ts` with an empty class implementing `AgentRunner` (stub `runStage` / `runPhase` throwing "not implemented" — real bodies arrive in T009/T010)
- [x] T009 Move the SDK message-loop body of `runStage` (`src/core/orchestrator.ts:895` through the end of that function — hooks, `canUseTool`, `outputFormat` parsing, structured-output validation, event emission) verbatim into `ClaudeAgentRunner.runStage`. Preserve every existing log line, every event shape, the `canUseTool` `AskUserQuestion` interception at line 985ff, the abort handling at :1149, and the structured-output retry loop at :1188ff
- [x] T010 Move the SDK message-loop body of `runPhase` (`src/core/orchestrator.ts:506` through the end of that function — `PreToolUse` / `PostToolUse` / `SubagentStart` / `SubagentStop` hooks at :581-880) verbatim into `ClaudeAgentRunner.runPhase`
- [x] T011 Create `src/core/agent/index.ts` — barrel that re-exports the interface and registry, plus module-init side effect calling `registerAgent("claude", (cfg, dir) => new ClaudeAgentRunner(cfg, dir))`. (The `mock` registration is added in Phase 3 task T030 so that this file only imports what already exists at this point.)
- [x] T012 Modify `src/core/orchestrator.ts` `run()` to resolve the runner at run start: `const dexCfg = loadDexConfig(projectDir); const agentName = config.agent ?? dexCfg.agent ?? "claude"; const runner = createAgentRunner(agentName, config, projectDir);`. Import the registry barrel from `./agent/index.js`
- [x] T013 Modify `src/core/orchestrator.ts` to delegate: replace the body of the inner call at `:970` with `await runner.runStage({ config, prompt, runId, cycleNumber, stage: stageType, specDir, phaseTraceId, outputFormat, abortController, emit, rlog })`, and similarly replace the inner call at `:566` with `await runner.runPhase({ config, prompt, runId, phase, phaseTraceId, specDir, abortController, emit, rlog })`. Delete the now-dead SDK invocation code from `orchestrator.ts`
- [x] T014 [P] Create Vitest suite `src/core/agent/__tests__/registry.test.ts` per `contracts/registry.md` "Testing contract" — register+instantiate, unknown-name error lists registered names, empty-name rejected, duplicate-registration-different-factory rejected, `getRegisteredAgents()` returns names
- [x] T015 [P] Create Vitest suite `src/core/__tests__/dexConfig.test.ts` — absent file → default, invalid JSON → `DexConfigParseError`, missing `agent` → `DexConfigInvalidError`, non-string `agent` → `DexConfigInvalidError`, valid file → parsed value
- [ ] T016 **Regression guard** (mandatory per research D13, spec SC-007) — run `npx tsc --noEmit` (zero errors) and do a real-agent smoke run on `/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce`: `./scripts/reset-example-to.sh clean`, set `.dex/dex-config.json` to `{ "agent": "claude" }`, start the autonomous loop via the UI, confirm the loop advances through `prerequisites → clarification_synthesis → manifest_extraction → gap_analysis → specify → plan → tasks → implement` with no errors and the same event shapes as pre-feature (spot-check `stage_started` / `stage_completed` payloads and at least one PreToolUse event in `~/.dex/logs/dex-ecommerce/<runId>/phase-*/agent.log`). If anything diverges — stop, diagnose in `ClaudeAgentRunner`, fix before moving on

**Checkpoint**: Foundation ready — **US2 is delivered**. The orchestrator is provider-agnostic, registry rejects unknown agents with listed alternatives (spec SC-003), and adding any future runner is a ~100-LOC change in a new file under `src/core/agent/` plus one line in `index.ts` (spec SC-002). Real-agent behavior is unchanged (spec SC-007). Mock-backend work can begin.

---

## Phase 3: User Story 1 — Exercise the checkpoint surface in seconds (Priority: P1) 🎯 MVP [US1]

**Goal**: A developer, having set `.dex/dex-config.json` to `{ "agent": "mock" }` and authored a three-cycle `mock-config.json`, starts the autonomous loop and watches a full multi-cycle run finish in under 60 seconds — producing the same checkpoint tags, attempt branches, and non-empty commits a real run would, and letting every checkpoint UX flow (Go Back, Try Again, Step Mode, Record Mode) work identically to real.

**Independent Test**: In the example project, select the mock backend, use the template `mock-config.json` from `quickstart.md`, start the loop. Verify: (a) loop terminates cleanly in under 60s; (b) checkpoint timeline shows one entry per stage per cycle; (c) clicking Go Back on a mid-cycle checkpoint creates a new attempt branch whose working tree matches that checkpoint's committed state.

### Fixtures for User Story 1 (all [P] — independent files)

- [x] T017 [P] [US1] Author `fixtures/mock-run/GOAL_clarified.md` — a real clarified-goal document (trim from `dex-ecommerce` GOAL.md or similar)
- [x] T018 [P] [US1] Author `fixtures/mock-run/CLAUDE.md` — a real project-instructions stub
- [x] T019 [P] [US1] Author `fixtures/mock-run/constitution.md` — a minimal viable constitution
- [x] T020 [P] [US1] Author `fixtures/mock-run/feature-manifest.json` — valid feature manifest conforming to `MANIFEST_SCHEMA`, listing three features with IDs `f-001`, `f-002`, `f-003` (their titles, descriptions, and statuses should reflect a sensible seed state; `f-001` and `f-002` as pending at run start)
- [x] T021 [P] [US1] Author `fixtures/mock-run/f1-spec.md`, `f1-plan.md`, `f1-tasks.md` — minimal but non-empty spec-kit artifacts for feature 1 (Authentication)
- [x] T022 [P] [US1] Author `fixtures/mock-run/f2-spec.md`, `f2-plan.md`, `f2-tasks.md` — minimal artifacts for feature 2 (Payments)
- [x] T023 [P] [US1] Author `fixtures/mock-run/f3-spec.md`, `f3-plan.md`, `f3-tasks.md` — minimal artifacts for feature 3 (Terminator — can be near-empty; the third cycle only exists to carry `GAPS_COMPLETE`)
- [x] T024 [P] [US1] Author `specs/009-testing-checkpointing/quickstart-assets/mock-config.example.json` — the full three-cycle template shown in `quickstart.md` §3, ready to copy into a developer's project

### MockConfig + MockAgentRunner implementation

- [x] T025 [US1] Create `src/core/agent/MockConfig.ts` — `MockConfig`, `PhaseEntry`, `DexLoopEntry`, `CycleEntry`, `StepDescriptor`, `WriteSpec`, `AppendSpec` types; error classes (`MockConfigParseError`, `MockConfigInvalidError`, `MockDisabledError`, `MockConfigMissingEntryError`, `MockFixtureMissingError`, `MockConfigInvalidPathError`); `loadMockConfig(projectDir)` that parses the file, validates per `contracts/mock-config.schema.json` (all required top-level keys present, cycles non-empty, each cycle has the seven required stages, each descriptor has a finite non-negative `delay`, writes entries have exactly one of `from`/`content`), and throws the appropriate typed error on any violation
- [x] T026 [US1] Create `src/core/agent/MockAgentRunner.ts` — class implementing `AgentRunner`. Constructor takes `(runConfig, projectDir)`, calls `loadMockConfig(projectDir)`, and throws `MockDisabledError` if `config.enabled === false`. Include a `PHASE_OF_STAGE: Record<LoopStageType, "prerequisites" | "clarification" | "dex_loop" | "completion">` lookup (per research D5) used by both `runStage` and `runPhase`
- [x] T027 [US1] Implement `MockAgentRunner.runStage`: resolve descriptor (for `dex_loop` phase use `cycles[ctx.cycleNumber - 1].stages[ctx.stage]`; else use `config[phase][ctx.stage]`); on miss throw `MockConfigMissingEntryError` with `{ phase, stage, cycleNumber?, featureId? }`; emit `stage_started` via `ctx.emit`; emit one synthetic `agent_step` with `type: "mock_stage"` and payload `{ stage, cycleNumber }` (use `makeStep` helper from orchestrator if exported, else inline the shape); `await new Promise(r => setTimeout(r, descriptor.delay))`; execute `writes` and `appends` (see T028); emit `stage_completed` with `costUsd: 0` and measured `durationMs`; return `{ cost: 0, durationMs, structuredOutput: descriptor.structured_output ?? null, sessionId: null }`
- [x] T028 [US1] Implement side-effect helpers inside `MockAgentRunner`: `resolvePath(template, ctx)` substitutes `{specDir}`, `{cycle}`, `{feature}` and throws `MockConfigInvalidPathError` on unknown tokens (message lists allowed tokens); `copyFixture(from, to)` resolves `from` against `fixtureDir` (default `<dexRepo>/fixtures/mock-run/`, resolved via `path.resolve` from the `dex-ecommerce` runtime), creates parent dirs with `fs.mkdirSync(..., { recursive: true })`, uses `fs.copyFileSync` and throws `MockFixtureMissingError` with the absolute resolved path on `ENOENT`; `writeLiteral(to, content)` mkdir+writeFile; `appendLine(to, line)` mkdir+append with trailing-newline hygiene (append `\n` if `line` doesn't end with one)
- [x] T029 [US1] Implement `MockAgentRunner.runPhase`: analogous to `runStage` but for the phase-level invocation shape. For phases currently handled this way (`prerequisites`), resolve descriptor from `config[phase][phase.name]` or similar — confirm the exact mapping against `orchestrator.ts:506-895` usage before wiring. Emit `phase_started` / `phase_completed` events matching the shape `ClaudeAgentRunner.runPhase` emits
- [x] T030 [US1] Register the mock runner in `src/core/agent/index.ts`: `registerAgent("mock", (cfg, dir) => new MockAgentRunner(cfg, dir))`. Verify via `getRegisteredAgents()` that both `claude` and `mock` are listed

### Happy-path tests

- [x] T031 [P] [US1] Create Vitest suite `src/core/agent/__tests__/MockConfig.test.ts` — loads a valid three-cycle config; rejects a config with `enabled: false` (but in the context of the *runner* wrapper — `loadMockConfig` parses it, the disabled check fires in the runner ctor; structure the test so both paths are covered); rejects a config missing `dex_loop.cycles`; rejects a cycle missing `gap_analysis`; rejects a `writes[]` entry with both `from` and `content`; rejects a `StepDescriptor` missing `delay`
- [ ] T032 [P] [US1] Create Vitest suite `src/core/agent/__tests__/MockAgentRunner.test.ts` — happy-path cases: (a) `runStage` emits `stage_started` then one `agent_step` then `stage_completed` (use a spy on `ctx.emit`, assert order and payload shape); (b) `runStage` honors the declared `delay` within ±50 ms; (c) `runStage` returns `structured_output` verbatim when the descriptor provides it; (d) runner does not import from `electron` / `src/main/` / `src/renderer/` (add a static `import.meta.url`-based assertion or rely on the existing `core.electron-free.test.ts`); (e) runner does not call `runs.startPhase` / `runs.completePhase` (mock the `runs` module, assert zero calls)

### End-to-end MVP validation

- [ ] T033 [US1] E2E happy path on `dex-ecommerce`: (1) `./scripts/reset-example-to.sh clean`; (2) write `/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce/.dex/dex-config.json` with `{ "agent": "mock" }`; (3) copy `specs/009-testing-checkpointing/quickstart-assets/mock-config.example.json` to `/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce/.dex/mock-config.json`; (4) drive the app via `electron-chrome` MCP (welcome → Open Existing → Automatic Clarification on → Start Autonomous Loop); (5) assert wall-clock from Start to loop termination < 60 s (spec SC-001, SC-009); (6) assert `git tag --list 'checkpoint/*'` shows tags for every stage in every cycle (spec SC-004); (7) assert via shell that `.dex/feature-manifest.json`, `.dex/learnings.md`, per-feature `specs/*/{spec,plan,tasks}.md`, and `src/mock/c*-f*.ts` all exist and are non-empty

**Checkpoint**: **US1 MVP delivered**. Mock backend produces a full, faithful, fast run end-to-end.

---

## Phase 4: User Story 3 — Fail loudly on script drift (Priority: P2) [US3]

**Goal**: Every drift condition — missing script entry, missing fixture, unknown substitution token, disabled mock, unknown agent selector — halts the run immediately with a coordinate-level diagnostic. No silent fakes (spec FR-010, FR-011, SC-003).

**Independent Test**: Delete one stage entry from a cycle; start the loop; verify the run halts at that stage and the error names the exact phase, cycle, feature, and stage. Repeat with a fixture file deleted (error names the resolved path), with `mock-config.enabled === false` (fails at startup), and with an unknown agent name (lists registered names).

**Note**: The error classes and throw-sites were implemented in Phase 3 (US1 cannot run without them). This phase adds explicit test coverage and negative-path E2E verification.

- [ ] T034 [US3] Add negative cases to `src/core/agent/__tests__/MockAgentRunner.test.ts`: (a) missing script entry → `MockConfigMissingEntryError` whose message contains `phase=`, `stage=`, `cycle=`, `feature=`; (b) missing fixture → `MockFixtureMissingError` whose message contains the resolved absolute path; (c) unknown substitution token `{bogus}` → `MockConfigInvalidPathError` whose message lists `{specDir}`, `{cycle}`, `{feature}` as allowed; (d) `new MockAgentRunner(cfgWithEnabledFalse, dir)` throws `MockDisabledError`
- [ ] T035 [US3] Add a case to `src/core/agent/__tests__/registry.test.ts` — `createAgentRunner("codex", ...)` before codex is registered throws `UnknownAgentError` whose message contains both `claude` and `mock` (exactly; use a regex assertion)
- [ ] T036 [US3] E2E negative — missing entry: reset `dex-ecommerce`, author valid dex-config + mock-config, then edit mock-config to delete `dex_loop.cycles[1].stages.implement`. Start the loop via MCP. Assert the loop halts at cycle-2 `implement` and the error in `~/.dex/logs/dex-ecommerce/<runId>/run.log` contains `MockConfigMissingEntryError`, `stage=implement`, `cycle=2`, `feature=f-002` (spec SC-003 — halt within one stage of the missing coordinate)
- [ ] T037 [US3] E2E negative — missing fixture: reset `dex-ecommerce`, author valid configs, then rename `fixtures/mock-run/f2-spec.md` to `f2-spec.md.bak`. Start the loop via MCP. Assert the loop halts at cycle-2 `specify` and the error in `run.log` contains `MockFixtureMissingError` and the absolute path `.../fixtures/mock-run/f2-spec.md`. Restore the fixture filename at the end of the test

**Checkpoint**: **US3 verified**. Every drift condition fails loudly with coordinate detail.

---

## Phase 5: User Story 4 — Real artifacts produced (Priority: P2) [US4]

**Goal**: The scripted backend produces real, faithful on-disk content. Every downstream stage that reads a file finds it. Every checkpoint commit captures a non-empty diff (spec FR-006, FR-007, SC-004).

**Independent Test**: After a mock run, inspect the project's filesystem — `.dex/feature-manifest.json`, `.dex/learnings.md`, per-feature spec/plan/tasks, per-cycle mock source files all exist with real content. Inspect the git history — every checkpoint commit shows a non-empty diff.

**Note**: The write/append/templating code was implemented in Phase 3 (T028, required by US1 to run at all). This phase adds explicit test coverage and E2E filesystem verification.

- [ ] T038 [US4] Add cases to `src/core/agent/__tests__/MockAgentRunner.test.ts`: (a) `writes[]` with `from` copies fixture bytes exactly (assert `fs.readFileSync` result equals the fixture content); (b) `writes[]` with `content` writes the literal string; (c) `appends[]` adds trailing `\n` when the line doesn't have one; (d) `appends[]` does NOT add a second `\n` when the line already ends in one; (e) path templating resolves `{specDir}`, `{cycle}`, `{feature}` correctly (use stub `StageContext` and assert the final absolute path); (f) parent directories are auto-created when writing to a deep path like `src/mock/c1-f-001.ts`
- [ ] T039 [US4] E2E filesystem assertions after the happy-path run from T033: check that `dex-ecommerce/.dex/feature-manifest.json` contains feature IDs `f-001`, `f-002`, `f-003`; `dex-ecommerce/.dex/learnings.md` has exactly 3 bulleted lines (one per implement cycle); every `dex-ecommerce/specs/*/spec.md`, `plan.md`, `tasks.md` has non-zero size; `dex-ecommerce/src/mock/c1-f-001.ts` and `c2-f-002.ts` exist and are non-empty
- [ ] T040 [US4] E2E git-history assertion: `git -C /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce log --all --grep='^\[checkpoint:' --stat`. Every checkpoint commit listed MUST show a non-empty diff line count (no "0 insertions(+), 0 deletions(-)"). Captures spec SC-004

**Checkpoint**: **US4 verified**. Mock-produced artifacts are faithful and checkpoint commits are real.

---

## Phase 6: User Story 5 — Explicit cycle enumeration (Priority: P3) [US5]

**Goal**: The loop length equals `cycles[].length`; termination is an explicit `GAPS_COMPLETE` signal on the last cycle; exhausting the list without that signal halts loudly (spec FR-009, SC-008).

**Independent Test**: Extend a three-cycle config to four cycles — loop runs four cycles. Remove the `GAPS_COMPLETE` signal — loop halts with "cycles exhausted" error. A developer unfamiliar with the orchestrator edits the config and the loop length changes accordingly, no code read required.

**Note**: Cycle-indexing (`cycles[ctx.cycleNumber - 1]`) was implemented in Phase 3 (T027, required by US1). This phase adds explicit tests for the indexing edge cases and the exhaustion failure mode.

- [ ] T041 [US5] Add cases to `src/core/agent/__tests__/MockAgentRunner.test.ts`: (a) `runStage` for `gap_analysis` with `ctx.cycleNumber = 1` reads `cycles[0]`, with `ctx.cycleNumber = 2` reads `cycles[1]`; (b) `runStage` with `ctx.cycleNumber = cycles.length + 1` throws `MockConfigMissingEntryError` whose message mentions "cycles exhausted" and lists the available cycle count
- [ ] T042 [US5] E2E — extend to 4 cycles: copy the quickstart mock-config, add a fourth cycle for feature `f-004` (author a minimal `fixtures/mock-run/f4-*.md` set too), move the `GAPS_COMPLETE` signal to cycle 4, update the feature-manifest fixture to include `f-004`. Reset project, start loop, verify exactly 4 cycles run (spec SC-008)
- [ ] T043 [US5] E2E — exhaustion failure: copy the quickstart mock-config, change the last cycle's `gap_analysis.structured_output.decision` from `GAPS_COMPLETE` to `NEXT_FEATURE` (so the orchestrator tries to advance past the list). Reset project, start loop, verify the loop halts at the start of cycle 4 with a `MockConfigMissingEntryError` or equivalent "cycles exhausted" diagnostic — not silent truncation and not an infinite loop

**Checkpoint**: **US5 verified**. Cycle enumeration is explicit, authorable, and fails loudly on drift.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Validate the checkpoint-UX flows end-to-end under the mock, measure the speedup vs real, and run the full DoD.

- [ ] T044 [P] UI flow validation — Go Back: on the run produced by T033, open the Loop Dashboard's checkpoint timeline (via `mcp__electron-chrome__take_snapshot` + `mcp__electron-chrome__click`), click Go Back on a mid-cycle checkpoint (e.g., cycle-2 `specify`). Assert an `attempt-*` branch is created (`git -C dex-ecommerce branch --list 'attempt-*'`) and the working tree matches that checkpoint's committed state (spec SC-006)
- [ ] T045 [P] UI flow validation — Step Mode: rerun the happy path with Step Mode toggle on. Assert the loop pauses after each stage (no automatic advance), and clicking Continue advances exactly one stage (spec SC-006)
- [ ] T046 [P] UI flow validation — Record Mode: rerun the happy path with Record Mode toggle on. Assert every candidate is auto-promoted and the `capture/*` branches/tags match the 008 Record Mode contract (spec SC-006)
- [ ] T047 Performance measurement — SC-009: run one real-agent stage (e.g., `specify` only) timed against the mock's full-run wall-clock from T033. Confirm mock full-run is at least 20× faster than one equivalent real stage. Record the numbers in a short note at the bottom of `specs/009-testing-checkpointing/quickstart.md` for future reference
- [x] T048 Final `npx tsc --noEmit` at Dex repo root — zero errors
- [ ] T049 Final `npm test` — all Vitest suites green (registry, dexConfig, MockConfig, MockAgentRunner)
- [ ] T050 Execute the full DoD checklist at `specs/009-testing-checkpointing/quickstart.md` §5 — check every item; if any fails, log a defect task and fix before reporting completion (constitution Principle III — Test Before Report)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — start immediately.
- **Phase 2 (Foundational)**: Depends on Phase 1. **Blocks every subsequent phase.** Delivers US2 as a byproduct; the `AgentRunner` contract + registry are the contract the rest of the work is written against.
- **Phase 3 (US1 MVP)**: Depends on Phase 2. Required by Phases 4, 5, 6 (those phases verify specific facets of what Phase 3 delivers).
- **Phase 4 (US3)**: Depends on Phase 3 — tests exercise error paths that exist in Phase 3 code.
- **Phase 5 (US4)**: Depends on Phase 3 — tests verify artifact fidelity produced by Phase 3 code.
- **Phase 6 (US5)**: Depends on Phase 3 — tests verify cycle-enumeration behavior implemented in Phase 3.
- **Phase 7 (Polish)**: Depends on Phases 3–6 for the UI flow and perf validation; task T048/T049/T050 are terminal.

### User Story Dependencies (non-standard shape)

Because US1 is the MVP and its implementation inherently includes the surface that US3/US4/US5 verify, those P2/P3 stories are **verification increments**, not implementation increments. They can run in parallel with each other once US1 is complete, but not before.

```
Phase 2 (Foundational, delivers US2)
          │
          ▼
Phase 3 (US1 MVP)
    │
    ├───► Phase 4 (US3 — loud errors)         ──┐
    ├───► Phase 5 (US4 — real artifacts)       ──┼──► Phase 7 (Polish)
    └───► Phase 6 (US5 — explicit enumeration) ──┘
```

### Within Each Phase

- Phase 1: all three tasks `[P]`-eligible (different filesystem targets).
- Phase 2: T004 → T005 → T006+T007 parallel → T008 → T009 → T010 → T011 → T012 → T013 → T014+T015 parallel → T016 final gate.
- Phase 3: fixtures (T017–T024) all parallel with one another and parallel with the implementation tasks after T025 starts (T025 → T026 → T027 → T028 → T029 → T030); tests (T031, T032) parallel after T030; E2E T033 after T030.
- Phases 4–6: each begins with the test-edit tasks (can run parallel to the e2e tasks of the same phase against separate tooling but in practice it's easier to sequence them — mark only genuinely parallel tasks with `[P]`).
- Phase 7: T044/T045/T046 are independent UI sessions, so `[P]` works; T047–T050 are sequential final gates.

### Parallel Opportunities

- **Phase 1**: T002, T003 parallel with T001.
- **Phase 2**: T006+T007 parallel. T014+T015 parallel.
- **Phase 3**: All eight fixture/asset tasks (T017–T024) parallel with one another once the fixtures directory exists (T002). Unit-test creation (T031+T032) parallel.
- **Phase 4**: T034 and T035 are in different files → parallel. E2E tasks T036/T037 can't run in parallel with each other (both drive the app) but can overlap with T034/T035.
- **Phase 5**: T038 and T039 parallel (different files). T040 is a shell-only assertion — parallel-eligible.
- **Phase 6**: T041 parallel with E2E T042/T043 (different surfaces).
- **Phase 7**: T044/T045/T046 parallel; terminal tasks T047–T050 sequential.

---

## Parallel Example: Phase 3 fixtures + example config

```bash
# Eight independent file authors — can be delegated in parallel:
Task: "Author fixtures/mock-run/GOAL_clarified.md"
Task: "Author fixtures/mock-run/CLAUDE.md"
Task: "Author fixtures/mock-run/constitution.md"
Task: "Author fixtures/mock-run/feature-manifest.json"
Task: "Author fixtures/mock-run/f1-spec.md, f1-plan.md, f1-tasks.md"
Task: "Author fixtures/mock-run/f2-spec.md, f2-plan.md, f2-tasks.md"
Task: "Author fixtures/mock-run/f3-spec.md, f3-plan.md, f3-tasks.md"
Task: "Author specs/009-testing-checkpointing/quickstart-assets/mock-config.example.json"
```

---

## Implementation Strategy

### MVP First (Setup + Foundational + User Story 1)

1. Complete Phase 1 (T001–T003) — minutes.
2. Complete Phase 2 (T004–T016) — the biggest chunk. The `runStage`/`runPhase` extraction (T009, T010) is the highest-risk item; **always run T016 before touching any mock code**. If T016 surfaces a regression on the real path, fix it in `ClaudeAgentRunner` — do not proceed to Phase 3.
3. Complete Phase 3 (T017–T033) — delivers the headline value.
4. **STOP and demo** — a developer can now exercise the 008 checkpoint surface in seconds at zero cost. That's the feature.

### Incremental Verification (US3, US4, US5)

Each subsequent phase adds a verification layer without changing the MVP's behavior:

- Phase 4 (US3): proves drift fails loudly. If you delete a stage entry, you learn immediately.
- Phase 5 (US4): proves artifacts are faithful. The mock run you saw in Phase 3 produces real downstream-readable files.
- Phase 6 (US5): proves cycle enumeration is explicit and safe. You can add a fourth cycle by editing JSON.

These phases can be done in parallel by different developers once Phase 3 is complete — they touch the same test file (`MockAgentRunner.test.ts`) but in different sections, and they drive independent E2E scenarios.

### Polish (Phase 7)

The polish phase is where we formally tick the DoD. If any item on `quickstart.md` §5 fails, the feature isn't done — return to the relevant story phase and fix before reporting.

---

## Notes

- **[P] hygiene**: No two `[P]` tasks in a phase touch the same file. Cross-phase file touches are fine because phases complete sequentially.
- **Constitution alignment**: Every phase satisfies a gate — Phase 2's T016 covers Principle III's "test before report" for the real path; Phase 7's T048–T050 covers it for the full feature; Phase 1–6 respect Principle II (no Electron imports under `src/core/`).
- **No git commits** during this work unless Lukas explicitly asks (global CLAUDE.md rule).
- **Verify-before-move-on**: T016 is the hard gate. If it fails, stop.
- **Avoid**: adding real-path behavior to the mock runner. The mock is deliberately sparse (one `agent_step` per stage). If a future change needs richer mock trace, that's a separate feature.
- **Avoid**: validating `structured_output` shapes inside the mock. The orchestrator's existing schema validation is the single source of truth (research D10).
