# 011 Refactoring — Phase 2: Simplify Dex for AI-Agent Modification

> **Status:** References to `variants.ts`, `spawnVariants`, and the "Keep this / Unmark kept / Try N ways from here" verbs in this spec are superseded by `012-cleanup` — those code paths and UI affordances have been removed. Record Mode auto-promote, Go-Back, and Jump-to-Checkpoint remain authoritative.

## Context

Dex is increasingly modified by AI agents — both external Claude Code instances working on Dex itself and the orchestrator's own subagents inspecting the code mid-run. The current shape fights that goal:

- `src/core/orchestrator.ts` is **2,313 lines** with a single `runLoop()` function spanning **~1,073 lines** (`orchestrator.ts:1232-2304`). This exceeds any agent's ability to hold the whole control flow in working context.
- `src/renderer/hooks/useOrchestrator.ts` is **907 lines** — a god hook managing **21** `useState` calls and a switch over **25 distinct `event.type` cases** (plus 5 more `AgentStep` subtypes labelled in helpers — 30 distinct event-shaped values total) covering loop state, live trace, subagents, prerequisites, session metadata, and user questions all at once.
- `src/renderer/App.tsx` is **720 lines**, mixing routing, state delegation, breadcrumb rendering, and IPC subscriptions.
- **14 files** (12 components + 2 hooks) reach into `window.dexAPI` directly; no service layer means changes to IPC shape ripple unpredictably across the renderer.
- Inline `style={{}}` patterns repeat across **57 files / ~546 occurrences** (no shared style tokens), so a single visual change touches dozens of files.

**Phase 1 + 2** (already merged on `lukas/refactoring` as commits `bbd3f0d` and `0d27e0d`) extracted `RunConfig` → `config.ts`, created `events.ts` for the orchestrator event union, modularized `preload.ts` into 6 namespaces, split `LoopDashboard` and `AgentStepItem`, and moved `readRecordMode` + `autoPromoteIfRecordMode` from `orchestrator.ts` into `checkpoints.ts`. The branch currently has no uncommitted code — only doc changes for this spec.

## Outcome

Any agent — internal or external — can open one file, understand its single responsibility, and modify it without learning the entire system. Concretely:

- No source file over **600 lines** *for files this refactor touches*. Three pre-existing files are explicitly **out of scope** with documented reasons (see §File-Size Exceptions below): `src/core/state.ts` (763 — `01X-state-reconciliation` lands on top, leave alone), `src/core/agent/ClaudeAgentRunner.ts` (699 — SDK adapter, defer to a dedicated spec), and `src/core/checkpoints.ts` *if and only if* the A0.5 split below is descoped. By default A0.5 splits checkpoints.ts so it ends Wave A under the limit.
- No function over **120 lines**.
- One module = one concept (prerequisites, clarification, main loop, gap-analysis decision, etc.).
- Renderer state split by domain (loop / trace / question), not lumped.
- Every IPC call goes through a typed service wrapper, not raw `window.dexAPI`.
- Each newly extracted module has a unit test pinning its contract.

### File-Size Exceptions

The Wave-A `awk '$1 > 600'` audit (Verification §V.7) is allowed to report these three files at the end of Wave A — and only these three. Any other file >600 LOC is a refactor failure. Rationale per file is logged in `docs/my-specs/011-refactoring/file-size-exceptions.md` (created in Pre-Wave) so future audits know which exceptions are intentional vs. drift.

**Scope.** Wave-by-wave refactor on `lukas/refactoring`, full surface area (core + renderer + IPC service layer), aggressive (allow IPC/hook contract changes if they make code clearly better), with unit tests on extracted modules (Path A — vitest+jsdom for renderer hooks, `node:test` for core). Each Wave (A, C-services, B, C-rest, D) merges to `main` as its own squashed PR — the resulting `git log` exposes inflection points instead of one wall-of-changes commit. The wave-gate verification in §Verification doubles as PR-readiness criteria. **Pre-Wave kickoff produces 5 spec-folder artefacts** (file-size-exceptions, golden-trace-pre-A, error-codes, event-order, module-map) — see §Critical Files Modified.

---

## Plan

Work proceeds in 4 waves on `lukas/refactoring`. Each wave ends with `npx tsc --noEmit`, `npm test`, and a smoke run via `./scripts/reset-example-to.sh clean` → start loop in dev. Commits are stamped `phase-2: <scope>` so the branch history remains readable.

### Wave A — Decompose `src/core/orchestrator.ts` (2,313 → ≤500 lines)

Split the monolith by phase, formalize implicit state machines, replace global mutable state with an explicit session.

**Sub-wave gates** — commit + smoke + golden-trace diff (see Verification §G) after each gate, so a single failed smoke isolates to a small diff:

- Gate 0: A0 + A0.5 (checkpoint API consolidation + checkpoints.ts split) — pure mechanical moves, no signature changes
- Gate 1: A1 + A2 (`OrchestrationContext` + prerequisites) — A1 isolated so the riskiest signature change has its own gate
- Gate 2: A3 + A4 (clarification + main loop)
- Gate 3: A5 + A6 + A7 (gap-analysis + finalize + lifecycle)
- Gate 4: A8 (trim coordinator)

**A8-prep (Path α vs β) must be decided *before Gate 0 starts*.** Path β changes `src/main/ipc/orchestrator.ts:19`, which is cross-cutting and would invalidate Gate 0's smoke baseline if picked late.

#### A0. Consolidate the checkpoint API in `src/core/checkpoints.ts`

Two helpers that the post-refactor stage modules will need are currently scattered:

- `commitCheckpoint` lives in `src/core/git.ts:32` (not `checkpoints.ts`).
- `readPauseAfterStage` lives as a private helper at `src/core/orchestrator.ts:511` (not exported).

Move both into `src/core/checkpoints.ts` and export them. After A0, every later extracted module (`finalize.ts`, `phase-lifecycle.ts`, `main-loop.ts`) imports the full checkpoint API from one place — and A6's `finalize.ts` no longer has a circular dep back into `orchestrator.ts` for `readPauseAfterStage`. ~30 LOC for `commitCheckpoint` (mechanical, ~6 import sites) + ~10 LOC for `readPauseAfterStage` (one call site at `orchestrator.ts:488`).

Also re-export the consolidated surface as a single `checkpoints` namespace object so callers can `import { checkpoints } from "core/checkpoints"` and access `checkpoints.commit(...)`, `checkpoints.promote(...)`, `checkpoints.jumpTo(...)`, etc. This single import is trivially mockable from `finalize.test.ts` / `phase-lifecycle.test.ts` and removes the temptation to re-introduce ad-hoc imports.

#### A0.5. Split `src/core/checkpoints.ts` (1,071 → ≤500 each)

After A0 lands, `checkpoints.ts` is **~1,110 LOC** (already 1,071 + ~40 from A0). It cleaves naturally along boundaries that are already in the file:

```text
src/core/checkpoints/
├── index.ts            ~120 — re-exports the `checkpoints` namespace assembled from below
├── tags.ts             ~200 — checkpointTagFor / captureBranchName / attemptBranchName / labelFor / parseCheckpointTag (current 13–112)
├── jumpTo.ts           ~190 — jumpTo + maybePruneEmptySelected + unselect / unmarkCheckpoint (current 245–488)
├── recordMode.ts       ~80  — readRecordMode / autoPromoteIfRecordMode / promoteToCheckpoint / syncStateFromHead (current 133–243)
├── variants.ts         ~140 — VariantSpawnRequest / spawnVariants / cleanupVariantWorktree (current 489–612)
├── timeline.ts         ~290 — listTimeline + types (current 613–989)
├── variantGroups.ts    ~90  — variant-group file IO (current 991–1071)
└── commit.ts           ~50  — commitCheckpoint + readPauseAfterStage (moved in by A0)
```

`src/core/checkpoints.ts` becomes a 30-line re-export shim so existing import sites (and the `checkpoints` namespace from A0) keep working unchanged. **Test:** existing `checkpoints.test.ts` (450 LOC, colocated) keeps passing without modification — that is the gate.

#### A1. Introduce `OrchestrationContext` session object

Replace module-level `abortController` (line 98), `activeProjectDir` (99), `releaseLock` (100), `currentRunner` (107), `currentRunState` (135) — currently scattered across `src/core/orchestrator.ts:98-135` — with one passed-down value:

```ts
// src/core/context.ts (new)
export interface OrchestrationContext {
  abort: AbortController;
  runner: AgentRunner;
  state: RunState;
  projectDir: string;
  releaseLock: () => Promise<void>;
  emit: EmitFn;
  rlog: RunLogger;
}
```

All extracted phase functions receive `ctx: OrchestrationContext` instead of reaching into module globals. The IPC layer (`src/main/ipc/orchestrator.ts`) keeps a thin singleton holder so `stopRun` can still abort from outside.

**Also threaded through `ctx`: the pending-question handle.** `submitUserAnswer` is exported at `orchestrator.ts:13` and resolves a module-level pending-promise that the clarification flow awaits — structurally the same singleton-shape as `abortController`. A1 either pulls the pending-promise reference into `ctx` (preferred — keeps clarification.ts pure) or explicitly leaves it as a second IPC-layer singleton paired with `submitUserAnswer`. Pick before A1 starts and document the choice in `src/core/context.ts`.

**Honest scope note:** the `abortController` + `releaseLock` pair (and possibly the pending-question handle) survives as a process-level singleton in the IPC layer — necessary because `stopRun` / `submitUserAnswer` are invoked from different IPC handlers than the one running `runLoop`. The win is downstream testability (every phase function is now pure-input → pure-output around `ctx`); the loss is "module-globals eliminated" overstates it. Document the residual singletons inline in `src/main/ipc/orchestrator.ts`.

#### A2. Extract `src/core/stages/prerequisites.ts`

Moves `runPrerequisites()` (currently `orchestrator.ts:904-1231`, **~328 lines**) plus the 5 individual checks (`claude_cli`, `specify_cli`, `git_init`, `github_repo`, `speckit_init`) into a data-driven structure:

```ts
// src/core/stages/prerequisites.ts (new)
interface PrerequisiteSpec {
  name: PrerequisiteCheckName;
  run: (ctx: OrchestrationContext) => Promise<void>;
  fix?: (ctx: OrchestrationContext) => Promise<void>;
}
const SPECS: PrerequisiteSpec[] = [...];
export async function runPrerequisites(ctx: OrchestrationContext): Promise<void>;
```

Each check becomes one declarative entry; the loop is 20 lines instead of 328. **Test:** `prerequisites.test.ts` — mock executors, verify emit sequence and failure-then-fix paths.

#### A3. Extract `src/core/stages/clarification.ts`

The clarification phase inside `runLoop` (`orchestrator.ts:1417-1513`) runs 4 sub-steps (product clarification 1424–1438, technical clarification 1440–1455, synthesis 1457–1486, constitution 1490–1505). Move to its own module:

```ts
export async function runClarificationPhase(
  ctx: OrchestrationContext,
  options: { skipInteractive: boolean },
): Promise<{ fullPlanPath: string; cumulativeCost: number }>;
```

**Pending-promise plumbing (resolved in A1).** Clarification is interactive — it `await`s a promise resolved by IPC `submitUserAnswer`. A1 already decided whether the pending-promise handle lives on `ctx` or stays as an IPC-layer singleton paired with `submitUserAnswer`. A3 just consumes that decision; the function signature does not need to change.

**Emit signatures imported from `events.ts`.** `clarification.ts` (and every other `stages/*.ts`) imports its emit shape from the Phase-1 `events.ts` union, not by re-declaring `EmitFn` locally. Same applies to A2/A4/A5/A6/A7.

#### A4. Extract `src/core/stages/main-loop.ts`

The actual cycle iterator becomes its own file. Composition:
- Gap-analysis decision block: `orchestrator.ts:1595-1711`
- specify → plan → tasks dispatcher: `orchestrator.ts:1789-1896`
- implement (with phase loop): `orchestrator.ts:1900-2047`
- verify + fix retry loop: `orchestrator.ts:2055-2128`
- learnings: `orchestrator.ts:2132-2151`

~560 lines total. **Critical:** ~560 lines as one function violates the 120-line/function rule in §Outcome. A4 must pre-decompose into named per-stage helpers in the same module:

```ts
// src/core/stages/main-loop.ts
async function runGapAnalysisStep(ctx, cycleN): Promise<GapAnalysisDecision>;
async function runSpecifyPlanTasks(ctx, decision): Promise<{ specDir: string }>;
async function runImplementWithVerifyRetry(ctx, specDir): Promise<ImplementOutcome>;
async function runLearningsStep(ctx, cycleN): Promise<void>;

export async function runMainLoop(
  ctx: OrchestrationContext,
  options: { maxCycles: number; budgetUsd: number },
): Promise<LoopTermination>;  // ~80 lines: cycle counter + budget check + dispatch to the four helpers above
```

Each helper ≤120 lines. `runMainLoop` itself stays under 120. The file lands at ~500–550 LOC with five well-named functions instead of one 540-line `runMainLoop`.

#### A5. Extract `src/core/gap-analysis.ts`

The implicit gap-analysis decision tree (`NEXT_FEATURE` / `RESUME_FEATURE` / `REPLAN_FEATURE` / `RESUME_AT_STEP` / `GAPS_COMPLETE`) is currently parsed ad-hoc. The `GapAnalysisDecision` type already exists in `src/core/types.ts:94-99` — surface a real parser + applier:

```ts
export function parseGapAnalysisDecision(agentOutput: string): GapAnalysisDecision;
export async function applyGapAnalysisDecision(
  decision: GapAnalysisDecision,
  ctx: OrchestrationContext,
): Promise<{ nextSpecDir?: string; nextStep?: StepType }>;
```

**Test:** `gap-analysis.test.ts` — golden inputs for each decision branch, plus malformed-input guards.

#### A6. Extract `src/core/stages/finalize.ts`

The post-stage checkpoint ritual inside `runStage()` (the function spans `orchestrator.ts:345-509`; the ritual is the ~60 lines at `:442-501`, repeated semantics interleaved with emits) becomes:

```ts
export async function finalizeStageCheckpoint(
  ctx: OrchestrationContext,
  stage: StepType,
  outcome: StageOutcome,
): Promise<{ shouldPause: boolean }>;
```

This wraps the `updateState → commitCheckpoint → updatePhaseCheckpointInfo → autoPromoteIfRecordMode → readPauseAfterStage` sequence. After **A0**, all four imports come from `src/core/checkpoints.ts`. (`updatePhaseCheckpointInfo` is currently `orchestrator.ts:520-537` and moves into `finalize.ts` here.)

#### A7. Extract `src/core/phase-lifecycle.ts`

The lifecycle pattern `runs.startAgentRun() → emit("phase_started") → rlog.agentRun() → … → runs.completeAgentRun() / runs.appendAgentStep()` wraps **8 phase boundaries** today — `runs.startAgentRun()` is invoked at lines 362, 589, 915, 1388, 1613, 1646, 1919, 1965. Each boundary additionally emits its own `completeAgentRun` and one or more `appendAgentStep` calls (~16 explicit JSON-mutation call sites in total when start + complete + step are counted), spread across the same 8 phases. The `runs.recordDB` reference from earlier drafts is stale — SQLite was removed in 007 and audit data now lives in per-project JSON (`<projectDir>/.dex/runs/<runId>.json`); the new helpers wrap the JSON writers, not a DB.

Collapse the 8 boundaries (and their ~16 mutation sites) to:

```ts
export async function recordPhaseStart(ctx, phase): Promise<PhaseTraceId>;
export async function recordPhaseComplete(ctx, phaseTraceId, outcome): Promise<void>;
export async function recordPhaseFailure(ctx, phaseTraceId, error): Promise<void>;
```

Keep the `runs` namespace (`startAgentRun` / `completeAgentRun` / `appendAgentStep`) as the lower layer — `phase-lifecycle.ts` only adds the emit + rlog choreography on top.

#### A8-prep. Decide the public entry-point shape (before Gate 0 starts)

`src/main/ipc/orchestrator.ts:3` currently imports `run` (the 217-line dispatcher at `orchestrator.ts:671-887`), not `runLoop` / `runBuild`. `run()` calls `runLoop()` (line 808) and `runBuild()` (line 815) internally — it's the live entry point. A4's main-loop extraction shape depends on whether `run()` survives.

**Decide before Gate 0** (not Gate 2 as previously stated). Path β changes the IPC handler in `src/main/ipc/orchestrator.ts:19`, which is cross-cutting — picking it late invalidates Gate 0's smoke baseline. Pick one of:

- **Path α — Keep `run()`, slim it.** It stays as the public entry; its body shrinks to a ~30-line dispatcher (mode resolution → `createContext` → `runLoop` | `runBuild`). IPC is unchanged. Cleanest for callers, mildly less aggressive on the file-shrink target.
- **Path β — Delete `run()`, update IPC.** Renderer-side IPC handlers in `src/main/ipc/orchestrator.ts:19` switch to calling `runLoop` / `runBuild` directly with mode resolution moved into the IPC layer. Slightly larger blast radius (one IPC handler change) but the coordinator file gets a single clearly-named entry per mode.

Either is fine. Decide and write the choice into the plan; A4 then targets the chosen shape.

#### A8. `orchestrator.ts` becomes a thin coordinator

Final shape (~400 lines), assuming Path α:

```ts
// src/core/orchestrator.ts
export async function run(config, emit) { /* dispatch to runBuild | runLoop, ~30 lines */ }
export async function runBuild(config, emit) { /* iterate specs, call runStage */ }
export async function runLoop(config, emit) {
  const ctx = await createContext(config, emit);
  await runPrerequisites(ctx);
  await runClarificationPhase(ctx, ...);
  return runMainLoop(ctx, ...);
}
export function abortRun() { ... }
```

(Under Path β, drop the `run` export and update `src/main/ipc/orchestrator.ts` accordingly.)

**Helpers to keep as named exports of the coordinator** (currently in `orchestrator.ts`): `getRunState()` (141), `listSpecDirs()` (154), `isSpecComplete()` (174), `buildPrompt()` (276), `runPhase()` (309), `isCommandOnPath()` (890), `getScriptType()` (900). Flag any that should move into a stage module during A8 — most stay.

### Wave B — Decompose `src/renderer/hooks/useOrchestrator.ts` (907 → 4 hooks + composer)

Split by domain. Each hook owns one slice of state and one slice of event subscriptions.

#### B0. State + event mapping matrix (do first, no code yet)

`useOrchestrator.ts` currently owns **21 `useState` calls** and switches over **25 distinct `event.type` cases** (plus 5 more `AgentStep` subtypes used in label helpers — 30 distinct event-shaped values total). Before splitting, produce **three committed artefacts** in this spec folder:

1. **State→hook matrix** (below).
2. **Event→hook matrix** (below).
3. **`event-order.md`** — canonical emit sequence per stage (run_started → prerequisites_*→ clarification_* → loop_cycle_started → task_phase_*→ step_* → … → loop_terminated → run_completed). Without this, the golden-trace check's "tolerable reorder" exemption is undefined. ~30 lines; live-capture from one baseline run.

**State → owning hook (all 21 must be assigned):**

| Hook | States |
|---|---|
| `useLoopState` | `preCycleStages`, `loopCycles`, `currentCycle`, `currentStage`, `totalCost`, `loopTermination` |
| `useLiveTrace` | `liveSteps`, `subagents`, `currentPhase`, `currentPhaseTraceId` |
| `useUserQuestion` | `pendingQuestion`, `isClarifying` |
| **`useRunSession` (new, B3.5)** | `mode`, `isRunning`, `currentRunId`, `totalDuration`, `activeSpecDir`, `activeTask`, `viewingHistorical` |
| **`usePrerequisites` (new, B3.6)** | `prerequisitesChecks`, `isCheckingPrerequisites` |

The original 3-hook split left **8 of 21 states orphaned** — refusing to name them turns the composer into a junk drawer. Two extra small hooks fix it.

**Event → owning hook (all 25 switch cases must be assigned; the 5 AgentStep subtypes stay in `useLiveTrace`'s label helper)**: audit the switch in `useOrchestrator.ts` (`onOrchestratorEvent`) — `loop_cycle_started`, `loop_cycle_completed`, `loop_terminated`, `task_phase_started`, `task_phase_completed`, `step_started`, `step_completed`, `agent_step`, `subagent_started`, `subagent_completed`, `clarification_started`, `clarification_question`, `clarification_completed`, `prerequisites_started`, `prerequisites_check`, `prerequisites_completed`, `user_input_request`, `user_input_response`, `run_started`, `run_completed`, `spec_started`, `spec_completed`, `state_reconciled`, `tasks_updated`, `error`. The 5 `AgentStep`-shaped labels (`subagent_result`, `subagent_spawn`, `text`, `thinking`, `tool_call`) live in `labelForStep` only — verify zero downstream consumers before re-wiring; they may be deletable raw SDK passthroughs.

**`error` event fan-out (fix vs the original "useRunSession owns error" plan).** Errors can originate during prerequisites, clarification, trace, or the loop. Putting `error` in one hook silently drops handling in the other three. Resolution: each hook handles its own error subset by tagging — the orchestrator already emits errors with a `phase` discriminator. The composer (B4) keeps a top-level "fatal error" sink for events whose phase doesn't match any active hook. Document the discriminator → hook mapping in the `event-order.md` doc.

#### B1. `useLoopState.ts` (~250 lines)

Owns: `preCycleStages`, `loopCycles`, `currentCycle`, `currentStage`, `totalCost`, `loopTermination`. Subscribes to: `loop_cycle_started`, `loop_cycle_completed`, `loop_terminated`, `task_phase_started`, `task_phase_completed`, `spec_started`, `spec_completed`. Uses existing `buildLoopStateFromRun` (already pure, `src/renderer/hooks/buildLoopStateFromRun.ts`).

#### B2. `useLiveTrace.ts` (~250 lines)

Owns: `liveSteps`, `subagents`, `currentPhase`, `currentPhaseTraceId`. Subscribes to: `step_started`, `step_completed`, `agent_step`, `subagent_started`, `subagent_completed`, `subagent_result`. Encapsulates the "trace timeline" concern that the AgentTrace view needs.

#### B3. `useUserQuestion.ts` (~150 lines)

Owns: `pendingQuestion`, `isClarifying`. Subscribes to: `clarification_started`, `clarification_question`, `clarification_completed`, `user_input_request`, `user_input_response`. Calls `window.dexAPI.answerQuestion()` (via `orchestratorService` after C3 lands).

**Also rewires `ClarificationPanel.tsx`** (231 lines, currently prop-driven `{questions, onAnswer, requestId}`) to consume `useUserQuestion()` directly. Without this, B3 only adds a hook nobody uses.

#### B3.5. `useRunSession.ts` (~100 lines)

Owns: `mode`, `isRunning`, `currentRunId`, `totalDuration`, `activeSpecDir`, `activeTask`, `viewingHistorical`. Subscribes to: `run_started`, `run_completed`, `state_reconciled`, plus run-level start/stop signals from the orchestratorService. **Run-level `error` only** — phase-scoped errors flow to the relevant hook per the discriminator policy in §B0.

#### B3.6. `usePrerequisites.ts` (~80 lines)

Owns: `prerequisitesChecks`, `isCheckingPrerequisites`. Subscribes to: `prerequisites_started`, `prerequisites_check`, `prerequisites_completed`.

#### B4. `useOrchestrator.ts` becomes a composer (~80 lines)

Composes the five hooks above and re-exports the union shape that App.tsx currently consumes. Existing component imports keep working unchanged. Long-term, components migrate to consuming the granular hooks directly.

**Tests:** see Wave D — testing strategy depends on whether vitest+jsdom infra is added (decision required upfront, see D-decision below).

### Wave C — Renderer surgery (App.tsx, IPC service layer, big components)

#### C1. Extract `src/renderer/components/AppBreadcrumbs.tsx` (~140 lines pulled from `App.tsx:392-532`)

The breadcrumb rendering with phase/cycle label resolution moves to its own component. App.tsx keeps the prop wiring.

#### C2. Extract `src/renderer/AppRouter.tsx` (~150 lines)

The view-switching JSX in `App.tsx:357-644` (overview / tasks / trace / subagent-detail / loop-start / loop-dashboard) becomes a proper switch component. Drops App.tsx to ~250 lines.

#### C3. Extract `src/renderer/services/` — typed IPC wrappers

`window.dexAPI` is assembled in `src/main/preload.ts` from **4 flat-merged groups** (`projectApi`, `orchestratorApi`, `historyApi`, `windowApi` — all spread into the top-level object) **+ 2 nested namespaces** (`checkpoints`, `profiles`). Functionally 6 API groups, but only 2 of them are reachable as `dexAPI.<namespace>.*` — the other 4 are flat (`dexAPI.startRun(...)`, `dexAPI.openProject(...)`, etc.). The service layer normalizes this: all 6 services use the typed-object shape regardless of how preload exposes the call. **14 files** reach into `window.dexAPI` directly today (12 components + `useProject.ts` + `useTimeline.ts`) — services must be importable from hooks too, not just components.

```text
src/renderer/services/
├── checkpointService.ts    — wraps window.dexAPI.checkpoints.*
├── orchestratorService.ts  — wraps startRun, stopRun, answerQuestion, getRunState, onOrchestratorEvent
├── projectService.ts       — wraps openProject, listSpecs, parseSpec, file IO
├── historyService.ts       — wraps listRuns, getRun, getPhaseSteps, getPhaseSubagents
├── profilesService.ts      — wraps profile CRUD (the `profiles` namespace)
└── windowService.ts        — wraps window controls (minimize/maximize/close)
```

Each service is a flat object of typed async functions **plus exported typed errors** (`class CheckpointError extends Error { code: 'NOT_FOUND' | 'BUSY' | 'GIT_DIRTY' | ... }` etc.) — trivial to add during extraction, hard to retrofit later. Components and hooks import `import { checkpointService } from "@/services/checkpointService"` instead of reaching into `window.dexAPI`. This is the surface that `dev-tools-plugin:dead-code` will run against to verify nothing escapes.

**C3 prerequisite — error vocabulary enumeration (required, not optional).** Before C3 starts, run `grep -rn 'throw new Error\|throw new [A-Z][a-zA-Z]*Error' src/main/ipc/ src/core/` and write the full code list per service to `docs/my-specs/011-refactoring/error-codes.md`. Each `*Service.ts` then captures every code on first try instead of growing one-at-a-time as components migrate. ~15 minutes; saves a half-typed surface.

**Order:** C3 lands **before Wave B** so split hooks (`useLoopState`, `useLiveTrace`, `useUserQuestion`, `useRunSession`, `usePrerequisites`) consume services from day one — and `useProject.ts` / `useTimeline.ts` migrate in the same pass. See "Order of Execution" below. **All 14 dexAPI consumers** (12 components + 2 hooks per the Context section) migrate to services in C3 — no half-migration leaks.

#### C4. Split `ToolCard.tsx` (574 → ~100 lines + per-tool renderers)

```text
src/renderer/components/agent-trace/tool-cards/
├── ToolCard.tsx        — dispatch only, ~100 lines
├── BashCard.tsx
├── ReadCard.tsx
├── WriteCard.tsx
├── EditCard.tsx
├── GrepCard.tsx
├── TaskCard.tsx
└── GenericCard.tsx     — fallback for unknown tools
```

A registry map (`Record<ToolName, ComponentType>`) drives dispatch. Adding a new tool = one new file.

#### C5. Split `LoopStartPanel.tsx` (523 → ~200 lines + 2 children)

Extract:
- `LoopStartForm.tsx` — config form, wraps existing markdown editor.
- `LoopCostPreview.tsx` — cost/iteration estimate panel.

Move form state to `useLoopStartForm.ts` hook so the parent stays presentational.

#### C6. Split `StageList.tsx` (491) and `AgentStepList.tsx` (487)

Extract grouping/filtering logic into pure helper modules colocated as `*.logic.ts`. Components become rendering-only.

#### C7. Style tokens — eliminate inline-style duplication

Add `src/renderer/styles/tokens.ts` exporting common style fragments as typed objects:

```ts
export const muted = { color: "var(--foreground-muted)" } as const;
export const linkLike = { color: "var(--foreground-muted)", cursor: "pointer", transition: "color 0.15s" } as const;
export const cardSurface = { background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: "var(--radius)" } as const;
```

No new CSS framework — just typed constants imported where inline-styles repeat. **Scope this wave to the components produced by C4–C6** (the ToolCard dispatcher + 7 per-tool cards from C4, LoopStartPanel + LoopStartForm + LoopCostPreview from C5, StageList + AgentStepList + their `*.logic.ts` from C6 — ~13 files total) — those are the highest-occurrence inline-style sites and we're rewriting them anyway. The remaining ~44 files adopt tokens opportunistically as they're touched. No tracker file — they rot.

### Wave D — Tests + verification

**D-decision (resolve before any test code is written): Path A.** The project uses `node:test` + `assert` (10 colocated tests in `src/core/`). There are zero renderer tests today and `@testing-library/react` does not interoperate with `node:test` — it expects vitest or jest with jsdom. Two paths exist; Path A is required because `useLoopState` and `useLiveTrace` carry non-trivial reducer logic over 25+ events — without unit tests, every Wave-B regression is caught only by manual smoke. Two test runners is mild friction; zero hook tests on a 5-hook split is a real risk.

- **Path A (chosen):** add `vitest` + `@testing-library/react` + `jsdom` as dev-deps for renderer-only tests. Keep `node:test` for `src/core/` (mature pattern, fast). New `vitest.config.ts` scopes to `src/renderer/**/*.test.{ts,tsx}`. Real new infra — not "one acceptable dev dep". Budget ~half a day for setup.
- **Path B (rejected):** drop renderer hook tests entirely. Listed only to make the trade-off explicit.

**Test placement:** keep colocated under `src/` (matches current 10 tests). The `tests/` folder mentioned in CLAUDE.md is empty/aspirational; do not split tests across two roots.

**Core tests** (always — `node:test`, no decision needed):

| Module | Test | Notes |
|---|---|---|
| `src/core/stages/prerequisites.ts` | `prerequisites.test.ts` | emit sequence, fix path, fail path |
| `src/core/gap-analysis.ts` | `gap-analysis.test.ts` | golden parse for each branch + malformed input |
| `src/core/stages/finalize.ts` | `finalize.test.ts` | checkpoint sequence with mock git |
| `src/core/phase-lifecycle.ts` | `phase-lifecycle.test.ts` | runs.startAgentRun + emit + rlog ordering (no DB — JSON files only) |

**Renderer tests** (Path A — required):

| Module | Test |
|---|---|
| `src/renderer/hooks/useLoopState.ts` | `useLoopState.test.tsx` |
| `src/renderer/hooks/useLiveTrace.ts` | `useLiveTrace.test.tsx` |
| `src/renderer/hooks/useUserQuestion.ts` | `useUserQuestion.test.tsx` |
| `src/renderer/hooks/useRunSession.ts` | `useRunSession.test.tsx` |
| `src/renderer/services/checkpointService.ts` | `checkpointService.test.ts` — IPC mock |

Reuse the existing `MockAgentRunner` (`src/core/agent/MockAgentRunner.ts`) for orchestrator-level tests where useful.

### Required deliverables (formerly "stretch", now in scope)

These directly advance the stated goal of "any agent can open one file and modify it without learning the entire system" and are cheap enough to absorb in their host wave:

1. **`npm run check:size` script — Wave A exit gate.** Today's `find … wc -l … awk '$1 > 600'` is a one-shot. Pin it as `package.json` script (or a small ESLint rule) so the next 700-line file fails locally/CI, not just a manual audit. **Promoted from stretch:** without this, file-size discipline rots within months. Allow-list the three exceptions from §File-Size Exceptions.
2. **Top-of-file orientation block.** Every newly extracted module gets a 3–5 line JSDoc at the top: *what this module does, what it deliberately doesn't, what it depends on*. Costs ~5 minutes per module during extraction.
3. **`docs/my-specs/011-refactoring/module-map.md` — required at end of Wave A.** A tree of `src/core/` post-decomposition with a one-line description per file. Costs 30 minutes; makes the next agent's onboarding dramatically faster. **Promoted from stretch:** this is the single most direct artefact of the refactor's stated objective.

(The previous "stretch goal #4 — C3 typed-error enumeration" is now a hard prerequisite of C3, see Wave C above.)

---

## Critical Files Modified

**Decomposed (will shrink dramatically):**

| File | Before | After |
|---|---|---|
| `src/core/orchestrator.ts` | 2,313 | ~400 |
| `src/core/checkpoints.ts` | 1,071 (→ ~1,110 after A0) | ~30 (re-export shim) + 7 sub-files each ≤290 |
| `src/renderer/hooks/useOrchestrator.ts` | 907 | ~80 (composer) |
| `src/renderer/App.tsx` | 720 | ~250 |
| `src/renderer/components/agent-trace/ToolCard.tsx` | 574 | ~100 |
| `src/renderer/components/loop/LoopStartPanel.tsx` | 523 | ~200 |
| `src/renderer/components/loop/StageList.tsx` | 491 | ~200 + logic file |
| `src/renderer/components/agent-trace/AgentStepList.tsx` | 487 | ~200 + logic file |

**Out of scope (file-size exceptions, see §File-Size Exceptions):**

| File | Size | Reason |
|---|---|---|
| `src/core/state.ts` | 763 | `01X-state-reconciliation` lands on top — preserve current behaviour, no refactor |
| `src/core/agent/ClaudeAgentRunner.ts` | 699 | SDK adapter; defer to a dedicated future spec |

**New (each ≤300 lines unless noted):**

- `src/core/context.ts`
- `src/core/checkpoints/{tags,jumpTo,recordMode,variants,timeline,variantGroups,commit}.ts` (A0.5 — `timeline.ts` ≤290)
- `src/core/checkpoints/index.ts` (re-exports the `checkpoints` namespace)
- `src/core/stages/prerequisites.ts`
- `src/core/stages/clarification.ts`
- `src/core/stages/main-loop.ts` (≤550, contains 4 named helpers each ≤120 + an ~80-line dispatcher)
- `src/core/stages/finalize.ts`
- `src/core/gap-analysis.ts`
- `src/core/phase-lifecycle.ts`
- `src/renderer/hooks/useLoopState.ts`
- `src/renderer/hooks/useLiveTrace.ts`
- `src/renderer/hooks/useUserQuestion.ts`
- `src/renderer/hooks/useRunSession.ts`
- `src/renderer/hooks/usePrerequisites.ts`
- `src/renderer/services/{checkpointService,orchestratorService,projectService,historyService,profilesService,windowService}.ts`
- `src/renderer/components/AppBreadcrumbs.tsx`
- `src/renderer/AppRouter.tsx`
- `src/renderer/components/agent-trace/tool-cards/{Bash,Read,Write,Edit,Grep,Task,Generic}Card.tsx`
- `src/renderer/components/loop/LoopStartForm.tsx`
- `src/renderer/components/loop/LoopCostPreview.tsx`
- `src/renderer/styles/tokens.ts`

**Spec-folder artefacts produced during the refactor:**

- `docs/my-specs/011-refactoring/file-size-exceptions.md` (Pre-Wave)
- `docs/my-specs/011-refactoring/golden-trace-pre-A.txt` (Pre-Wave; intersection of two baseline runs)
- `docs/my-specs/011-refactoring/error-codes.md` (Pre-Wave / C3 prerequisite)
- `docs/my-specs/011-refactoring/event-order.md` (B0)
- `docs/my-specs/011-refactoring/module-map.md` (end of Wave A)

**Existing utilities reused (do not reinvent):**

- `src/core/checkpoints.ts` — `autoPromoteIfRecordMode` (170–185), `readRecordMode` (154–161). After **A0** also gains `commitCheckpoint` (from `git.ts:32`) and `readPauseAfterStage` (from `orchestrator.ts:511`).
- `src/core/git.ts:32` — `commitCheckpoint` (current home; moves in A0)
- `src/core/orchestrator.ts:511` — `readPauseAfterStage` (private helper today; exported from `checkpoints.ts` after A0)
- `src/core/state.ts` — `updateState` (219–227), `reconcileState` (704+), `detectStaleState` (314–346)
- `src/core/runs.ts` — `startAgentRun` (257–271), `completeAgentRun` (273–297), `recordSubagent` (299–319), `appendAgentStep` (419–429). **No `runs.recordDB`** — SQLite was retired in 007; audit data is per-project JSON at `<projectDir>/.dex/runs/<runId>.json`.
- `src/core/log.ts` — `RunLogger`
- `src/core/agent/MockAgentRunner.ts` — for tests
- `src/core/types.ts` — `Phase`, `StepType`, `GapAnalysisDecision` (94–99), `LoopTermination` (113–120), `PrerequisiteCheck` (142–146), `PrerequisiteCheckName` (139)
- `src/renderer/hooks/buildLoopStateFromRun.ts` — pure transform (116 lines), reused by `useLoopState`

---

## Constraints & Anti-Patterns to Respect

- **No new state-management library** — keep React local state + custom hooks. (Project rule: no Redux/Zustand.)
- **No CSS framework** — Catppuccin custom-properties stay. `tokens.ts` is plain typed objects, not CSS-in-JS.
- **No new prod dependencies.** Renderer test infra (`vitest` + `@testing-library/react` + `jsdom`) is the only acceptable dev-dep block, and only if Wave D Path A is chosen.
- **Preserve `window.dexAPI` shape** during the refactor so existing components keep working. Service layer is additive — components migrate one at a time.
- **Preserve event semantics & state-machine shape.** This refactor is structural only — no behaviour changes. `docs/my-specs/01X-state-reconciliation/` is a separate, *future* effort that will land on top of the post-refactor code; it depends on the current behaviour staying intact: synthetic `step_started`/`step_completed` pair from `emitSkippedStep` (`orchestrator.ts:1820-1833`), the `decision === "stopped"` → `status: "running"` mapping (`useOrchestrator.ts:553`), the 5 s heuristic in `StageList.tsx:104`, and the single-mode `reconcileState`. Resist "while we're here" cleanups in those regions.
- **Do not commit to git** — user runs commits per global CLAUDE.md rule.

---

## Verification (Definition of Done)

End-to-end smoke at every Wave-A sub-gate (G0–G4 in Wave A) and at the end of Waves B/C/D:

1. `npx tsc --noEmit` — clean.
2. `npm test` — all tests pass, including new ones.
3. `./scripts/reset-example-to.sh clean` followed by full loop run on `dex-ecommerce`:
   - Welcome screen → Open Existing → Start Autonomous Loop with auto-clarification.
   - Verify prerequisites complete, clarification produces a plan, at least one cycle goes through specify → plan → tasks → implement → learnings.
   - Verify checkpoints are created (`git log --all --grep='^\[checkpoint:' --oneline` in `dex-ecommerce`).
   - Verify the DEBUG badge in the UI shows valid `RunID` / `PhaseTraceID`.
4. `./scripts/reset-example-to.sh <recent-checkpoint>` followed by Resume — confirm the resume path still works after `runLoop` decomposition. (Resume is more sensitive to event reorders than fresh runs — do this every gate, not just at the end.)
5. Renderer DevTools console (`mcp__electron-chrome__list_console_messages`) — no new errors.
6. Per-run logs at `~/.dex/logs/<project>/<runId>/` — phase tree intact.
7. File-size audit: `npm run check:size` (Wave A required deliverable #1) — should be empty by end of Wave A *except for the three files listed in §File-Size Exceptions*. The script's allow-list captures exactly those three; any new file >600 LOC is a refactor failure.
8. **Golden-trace regression check (G — required before Wave A starts):**

   Capture **two** baselines and intersect them — a single run flakes on race-y emit ordering between SDK stream events and orchestrator emits, producing false positives. Capture INFO|WARN|ERROR (resume-path regressions surface at WARN/ERROR; INFO-only would miss them):

   ```bash
   # Baseline (before A0) — capture twice, intersect to filter jitter:
   for i in 1 2; do
     ./scripts/reset-example-to.sh clean   # then run one full loop in the UI
     RUN_ID=$(ls -t ~/.dex/logs/dex-ecommerce/ | head -1)
     grep -oE '\] \[(INFO|WARN|ERROR)\] [a-z_]+' ~/.dex/logs/dex-ecommerce/$RUN_ID/run.log \
       > /tmp/golden-baseline-$i.txt
   done
   comm -12 <(sort -u /tmp/golden-baseline-1.txt) <(sort -u /tmp/golden-baseline-2.txt) \
     > docs/my-specs/011-refactoring/golden-trace-pre-A.txt

   # After each Wave-A sub-gate:
   ./scripts/reset-example-to.sh clean   # then run one full loop in the UI
   RUN_ID=$(ls -t ~/.dex/logs/dex-ecommerce/ | head -1)
   grep -oE '\] \[(INFO|WARN|ERROR)\] [a-z_]+' ~/.dex/logs/dex-ecommerce/$RUN_ID/run.log \
     | sort -u > /tmp/golden-post.txt
   diff docs/my-specs/011-refactoring/golden-trace-pre-A.txt /tmp/golden-post.txt
   ```

   Treat the diff against the rules in `event-order.md` (B0): reorders explicitly listed there are tolerable; anything else is a regression. Tolerable diffs (timestamp jitter, run IDs) won't appear because `grep -oE` strips them; semantic diffs will.

If any sub-gate breaks resume, checkpointing, or the golden trace beyond what `event-order.md` permits, roll back that gate's commits before moving on.

**Post-merge rollback policy.** Once a Wave squash-merges to `main`, "roll back" means a revert PR on `main` — not a branch-local rebase. Each Wave's PR description must include the exact `git revert <merge-sha>` command and the smoke checklist to confirm the revert restores function. Wave-internal rollback (between sub-gates, before merge) stays branch-local on `lukas/refactoring`.

---

## Order of Execution

Strictly sequential. Note that **C3 (services) lands before Wave B** — split hooks consume services from day one rather than being rewritten twice.

1. **Pre-Wave** — pick A8-prep path (α or β); write `file-size-exceptions.md`; capture two-baseline golden-trace baseline (Verification §8); enumerate IPC error vocabulary into `error-codes.md` (C3 prerequisite, but capturing it now keeps the C3 wave clean).
2. **Wave A** (core decomposition):
   - **Gate 0**: A0 (move `commitCheckpoint` + `readPauseAfterStage`, expose `checkpoints` namespace) → A0.5 (split `checkpoints.ts` into the 7 sub-files) → smoke + golden-diff. *Pure mechanical moves.*
   - **Gate 1**: A1 (`OrchestrationContext` + pending-promise decision) → A2 (prerequisites) → smoke + golden-diff. *A1 isolated so the riskiest signature change has its own gate.*
   - **Gate 2**: A3 (clarification) → A4 (main loop, pre-decomposed into 4 helpers + 80-line dispatcher) → smoke + golden-diff.
   - **Gate 3**: A5 (gap-analysis) → A6 (finalize) → A7 (phase-lifecycle) → smoke + golden-diff.
   - **Gate 4**: A8 (trim coordinator + triage `run()` and helpers) + write `module-map.md` + add `npm run check:size` script → smoke + golden-diff + file-size audit clean.
3. **D-partial** — core tests (`prerequisites`, `gap-analysis`, `finalize`, `phase-lifecycle`) — write alongside the gates that introduce each module, not after.
4. **C3** (service layer + typed errors using the pre-enumerated `error-codes.md`, including `useProject` / `useTimeline` migration). All 14 dexAPI consumers migrate in this wave — no leftover raw `window.dexAPI` reads.
5. **B0** — write the state→hook + event→hook matrices + `event-order.md` (no code).
6. **Wave B** (B1 → B2 → B3 + ClarificationPanel rewire → B3.5 → B3.6 → B4 composer) — each new hook lands with the events it owns removed from the old composer in the same commit, so events are never double-handled. `error` discriminator policy from §B0 is honored.
7. **C1 + C2** — `AppBreadcrumbs` + `AppRouter` (App.tsx → ~250 lines).
8. **C4–C6** — split big components (`ToolCard`, `LoopStartPanel`, `StageList`, `AgentStepList`).
9. **C7** — style tokens applied to the ~13 components produced by C4–C6 only.
10. **D-rest** — renderer hook tests (Path A — vitest+@testing-library/react+jsdom infra setup, then the 5 hook test files).

Final state on `main`: a series of squashed merge commits, one per Wave, each titled `phase 2/<wave>: <scope>` (e.g. `phase 2/wave-A: decompose orchestrator.ts`, `phase 2/wave-C-services: typed IPC service layer`, `phase 2/wave-B: split useOrchestrator`, etc.). `lukas/refactoring` is force-deleted after the last wave merges. Each PR is reviewable on its own — Wave A is core-only, Wave B is renderer-hooks-only, etc. — and the wave gates in §Verification double as PR-merge criteria. Each PR description must include the post-merge revert command per §V.8 rollback policy.
