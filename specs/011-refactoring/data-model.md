# Data Model: Refactor Dex for AI-Agent Modification (Phase 2)

**Date**: 2026-04-27 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

This refactor introduces no new persistent storage and changes no on-disk schema. The "data model" here is the set of in-memory shapes (TypeScript types) that emerge from the decomposition — the contracts the wave gates assert against.

---

## OrchestrationContext

**Where**: `src/core/context.ts` (NEW, A1).

**What**: The session value threaded into every extracted phase function. Replaces five module-level globals at `src/core/orchestrator.ts:98-135` plus the pending-question handle at `:13`.

**Shape**:

```ts
export interface OrchestrationContext {
  abort: AbortController;          // was orchestrator.ts:98 (module global)
  runner: AgentRunner;             // was orchestrator.ts:107
  state: RunState;                 // was orchestrator.ts:135
  projectDir: string;              // was orchestrator.ts:99 (activeProjectDir)
  releaseLock: () => Promise<void>;// was orchestrator.ts:100
  emit: EmitFn;                    // was passed individually
  rlog: RunLogger;                 // was passed individually
  pendingQuestion: {               // was a module-level promise pair (R-003)
    promise: Promise<string> | null;
    resolve: ((answer: string) => void) | null;
    requestId: string | null;
  };
}
```

**Lifecycle**:
1. `createContext(config, emit) → Promise<OrchestrationContext>` is called by `runLoop` / `runBuild` at the top.
2. Threaded through `runPrerequisites(ctx)`, `runClarificationPhase(ctx, opts)`, `runMainLoop(ctx, opts)`, `finalizeStageCheckpoint(ctx, ...)`, `applyGapAnalysisDecision(decision, ctx)`, etc.
3. The IPC layer (`src/main/ipc/orchestrator.ts`) maintains a singleton holder so `stopRun` (which arrives on a *different* IPC handler than the one running `runLoop`) can call `ctx.abort.abort()` and `submitUserAnswer` can resolve `ctx.pendingQuestion.resolve(answer)`. This residual is documented inline in the IPC layer.

**Validation rules**:
- `ctx.abort.signal.aborted === true` short-circuits every long-running operation (every `await` in stage modules either checks it or relies on a downstream `safeExec` that does).
- `ctx.runner` is non-null for the lifetime of the run.
- `ctx.pendingQuestion.{resolve, requestId}` are nulled after each clarification round-trip; only one outstanding question at a time.

**State transitions**: None — `ctx` is a value, not a state machine. The values it holds (e.g. `state`) have their own transitions defined in `src/core/state.ts`.

---

## PrerequisiteSpec

**Where**: `src/core/stages/prerequisites.ts` (NEW, A2).

**What**: A declarative entry per prerequisite check, replacing the 328-line `runPrerequisites` switchboard at `orchestrator.ts:904-1231`.

**Shape**:

```ts
interface PrerequisiteSpec {
  name: PrerequisiteCheckName;                     // existing union from src/core/types.ts:139
  run: (ctx: OrchestrationContext) => Promise<void>;
  fix?: (ctx: OrchestrationContext) => Promise<void>;
}

const SPECS: PrerequisiteSpec[] = [
  { name: "claude_cli",    run: ..., fix: ... },
  { name: "specify_cli",   run: ..., fix: ... },
  { name: "git_init",      run: ..., fix: ... },
  { name: "github_repo",   run: ..., fix: ... },
  { name: "speckit_init",  run: ..., fix: ... },
];
```

**Validation rules**:
- `name` must be one of the 5 values in `PrerequisiteCheckName`.
- `fix` is optional — checks that have no automatic remediation (e.g. user-action-required) omit it.

**State transitions**: Per check — `pending → running → ok` or `pending → running → failed → fixing → ok` (when `fix` succeeds) or `pending → running → failed` (terminal, surfaces as a user-actionable error). The 20-line `runPrerequisites` driver iterates `SPECS` and emits `prerequisites_started` / `prerequisites_check` / `prerequisites_completed` accordingly.

---

## GapAnalysisDecision

**Where**: Already exists at `src/core/types.ts:94-99`. A5 surfaces a real parser + applier in `src/core/gap-analysis.ts`.

**Shape** (existing):

```ts
type GapAnalysisDecision =
  | { kind: "NEXT_FEATURE";   reason: string }
  | { kind: "RESUME_FEATURE"; specDir: string; reason: string }
  | { kind: "REPLAN_FEATURE"; specDir: string; reason: string }
  | { kind: "RESUME_AT_STEP"; specDir: string; step: StepType; reason: string }
  | { kind: "GAPS_COMPLETE";  reason: string };
```

**New API** (A5):

```ts
export function parseGapAnalysisDecision(agentOutput: string): GapAnalysisDecision;
export async function applyGapAnalysisDecision(
  decision: GapAnalysisDecision,
  ctx: OrchestrationContext,
): Promise<{ nextSpecDir?: string; nextStep?: StepType }>;
```

**Validation rules**:
- `parseGapAnalysisDecision` MUST throw on malformed input (no silent fallback to `NEXT_FEATURE`). Test `gap-analysis.test.ts` pins this.
- `applyGapAnalysisDecision` is exhaustive over `decision.kind` — TypeScript's `never` check enforces every branch is handled.

**State transitions**: Decisions are immutable values; the *application* of a decision drives `ctx.state` transitions (defined in `state.ts`, untouched by this refactor).

---

## Service-typed errors

**Where**: One per service under `src/renderer/services/`.

**Pattern**:

```ts
export class CheckpointError extends Error {
  readonly code:
    | "NOT_FOUND"
    | "BUSY"
    | "GIT_DIRTY"
    | "INVALID_TAG"
    | "WORKTREE_LOCKED"
    | ...;          // exhaustive list from error-codes.md
  constructor(code: CheckpointError["code"], message: string) {
    super(message);
    this.name = "CheckpointError";
    this.code = code;
  }
}
```

Same pattern for `OrchestratorError`, `ProjectError`, `HistoryError`, `ProfilesError`, `WindowError`. The `code` union for each is enumerated from `src/main/ipc/` + `src/core/` via `grep -rn 'throw new Error'` in Pre-Wave and committed as `error-codes.md`.

**Validation rules**:
- Every service function's typed error is part of the exported surface (consumers can `import { CheckpointError } from "@/services/checkpointService"`).
- `switch (err.code)` in callers triggers exhaustiveness checking — adding a new code without updating callers is a TypeScript error, not a runtime surprise.

**State transitions**: None.

---

## Renderer hook state ownership

**Where**: `src/renderer/hooks/{useLoopState, useLiveTrace, useUserQuestion, useRunSession, usePrerequisites}.ts` (B1..B3.6).

**State assignment** (all 21 `useState` calls from the existing `useOrchestrator` partition into exactly one hook):

| Hook | State variables |
|---|---|
| `useLoopState` | `preCycleStages`, `loopCycles`, `currentCycle`, `currentStage`, `totalCost`, `loopTermination` |
| `useLiveTrace` | `liveSteps`, `subagents`, `currentPhase`, `currentPhaseTraceId` |
| `useUserQuestion` | `pendingQuestion`, `isClarifying` |
| `useRunSession` | `mode`, `isRunning`, `currentRunId`, `totalDuration`, `activeSpecDir`, `activeTask`, `viewingHistorical` |
| `usePrerequisites` | `prerequisitesChecks`, `isCheckingPrerequisites` |

**Event subscriptions** (all 25 cases of the existing `event.type` switch partition):

| Hook | Events |
|---|---|
| `useLoopState` | `loop_cycle_started`, `loop_cycle_completed`, `loop_terminated`, `task_phase_started`, `task_phase_completed`, `spec_started`, `spec_completed` |
| `useLiveTrace` | `step_started`, `step_completed`, `agent_step`, `subagent_started`, `subagent_completed`, `subagent_result` |
| `useUserQuestion` | `clarification_started`, `clarification_question`, `clarification_completed`, `user_input_request`, `user_input_response` |
| `useRunSession` | `run_started`, `run_completed`, `state_reconciled`, plus run-level `error` (phase-discriminator policy) |
| `usePrerequisites` | `prerequisites_started`, `prerequisites_check`, `prerequisites_completed` |

**`error` event routing**: errors carry a `phase` discriminator. Each hook handles its own subset (`prerequisites` errors → `usePrerequisites`, `clarification` errors → `useUserQuestion`, etc.). The composer (B4) keeps a top-level fatal-error sink for unmatched errors.

**The 5 `AgentStep` subtypes** (`subagent_result`, `subagent_spawn`, `text`, `thinking`, `tool_call`) live in `useLiveTrace`'s `labelForStep` helper only. Verify zero downstream consumers before the rewire — they may be deletable raw SDK passthroughs.

**Composer shape** (B4):

```ts
export function useOrchestrator() {
  const session = useRunSession();
  const prereq = usePrerequisites();
  const question = useUserQuestion();
  const loop = useLoopState();
  const trace = useLiveTrace();
  return { ...session, ...prereq, ...question, ...loop, ...trace };
}
```

The spread order matters only if hooks have name collisions — they don't, by construction (the matrix above partitions all 21 states).

---

## Refactor Wave (process entity)

**What**: A sequenced delivery boundary. Five waves: `A`, `C-services`, `B`, `C-rest`, `D`.

**Attributes**:
- `name`: one of the five values above.
- `subGates`: ordered list (Wave A only — G0 through G4).
- `prShape`: squash-merge to `main`.
- `verificationGate`: the composite check listed in spec FR-015.
- `revertCommand`: `git revert <merge-sha>` — recorded in the PR description.
- `smokeChecklist`: ≤5 items confirming a revert restores function.

**State transitions**: `not-started → in-progress → ready-for-review → merged` (or `→ rolled-back` from any post-merge state via revert PR).

**Validation rules**:
- Wave order is strict: A before C-services before B before C-rest before D. Violating the order voids R-005's rationale.
- Each wave's verification gate must pass before the wave's PR opens for review (gate doubles as PR-readiness).

---

## Sub-Gate (process entity, Wave A only)

**What**: A wave-internal commit boundary inside Wave A. Five sub-gates: `G0` (A0 + A0.5), `G1` (A1 + A2), `G2` (A3 + A4), `G3` (A5 + A6 + A7), `G4` (A8).

**Attributes**:
- `id`: G0..G4.
- `tasks`: list of A-numbered tasks landing in this gate.
- `endCheck`: `tsc` + `npm test` + clean smoke + checkpoint-resume smoke + golden-trace diff.
- `rollbackTarget`: the prior gate's commit SHA on `011-refactoring`.

**State transitions**: `not-started → in-progress → passed` (or `→ rolled-back` via `git reset` to `rollbackTarget` on the working branch — pre-merge only; post-merge rollback is wave-level via revert PR).

**Validation rules**:
- A failed `endCheck` blocks the next sub-gate. No skipping.
- Wave-internal rollback never reaches into another wave (which by definition is already merged).

---

## File-Size Exception (process entity)

**What**: A pre-existing source file allowed to exceed 600 LOC after the refactor.

**Where listed**: `docs/my-specs/011-refactoring/file-size-exceptions.md` (Pre-Wave artefact).

**Shape per entry**:

```text
## src/core/state.ts
- Current size: 763 LOC
- Reason: 01X-state-reconciliation lands on top of this refactor and rewrites this file.
  Refactoring it now would create merge conflicts with that planned work.
- Follow-up spec: 01X-state-reconciliation
```

**Validation rules**:
- Two entries today. Adding a third requires explicit user approval — it's a slippery slope.
- The `npm run check:size` script reads this allow-list verbatim. Drift between the script and the doc is a refactor failure.

---

## Golden Trace (process entity)

**What**: The canonical INFO|WARN|ERROR emit sequence per stage of a clean smoke run, used as the regression-check anchor at every Wave-A sub-gate.

**Where**: `docs/my-specs/011-refactoring/golden-trace-pre-A.txt` (Pre-Wave artefact).

**Capture protocol**:
1. Two clean smoke runs on `dex-ecommerce`: `./scripts/reset-example-to.sh clean` → start loop in dev → wait for one full cycle.
2. From each run, extract the stable token set: `grep -oE '\] \[(INFO|WARN|ERROR)\] [a-z_]+' run.log | sort -u`.
3. Intersect: `comm -12 <(sort -u baseline-1) <(sort -u baseline-2)`.
4. Persist intersection as `golden-trace-pre-A.txt`.

**Diff protocol** (every sub-gate):
1. Run the same scenario post-gate.
2. Extract the same way.
3. Diff against `golden-trace-pre-A.txt`.
4. Compare diff against `event-order.md`'s tolerable-reorder list.
5. Empty diff or only-tolerable entries → pass. Anything else → regression; roll back.

**Validation rules**: Stripping `\[<timestamp>\]`, `<runId>`, and trailing JSON via the regex is non-negotiable — those are noise sources, not signal.

---

## Module Map (process entity)

**What**: A tree of `src/core/` post-decomposition with one-line responsibility per file. Required deliverable at end of Wave A (FR-013).

**Where**: `docs/my-specs/011-refactoring/module-map.md`.

**Shape**:

```markdown
# Module Map — src/core/ (post-Wave-A)

src/core/
├── orchestrator.ts          — thin coordinator: dispatch run/runLoop/runBuild + abortRun
├── context.ts               — OrchestrationContext interface and createContext factory
├── stages/
│   ├── prerequisites.ts     — declarative PrerequisiteSpec list + 20-line driver
│   ├── clarification.ts     — 4-step interactive clarification phase
│   ├── main-loop.ts         — cycle iterator + 4 named per-stage helpers
│   └── finalize.ts          — post-stage checkpoint ritual
├── gap-analysis.ts          — parseGapAnalysisDecision + applyGapAnalysisDecision
├── phase-lifecycle.ts       — recordPhaseStart / recordPhaseComplete / recordPhaseFailure
├── checkpoints.ts           — re-export shim (back-compat)
├── checkpoints/
│   ├── index.ts             — assembles the `checkpoints` namespace
│   ├── tags.ts              — tag taxonomy (checkpointTagFor / parseCheckpointTag)
│   ├── jumpTo.ts            — jumpTo / maybePruneEmptySelected / unselect
│   ├── recordMode.ts        — readRecordMode / autoPromoteIfRecordMode
│   ├── variants.ts          — VariantSpawnRequest / spawnVariants
│   ├── timeline.ts          — listTimeline + types
│   ├── variantGroups.ts     — variant-group file IO
│   └── commit.ts            — commitCheckpoint + readPauseAfterStage
├── git.ts                   — low-level git invocation helpers
├── runs.ts                  — run-record JSON writers (untouched)
├── state.ts                 — RunState + reconcileState (file-size exception)
└── agent/
    └── ClaudeAgentRunner.ts — SDK adapter (file-size exception)
```

**Validation rules**:
- One line per file. Multi-paragraph entries are a smell — extract them into the module's own orientation block instead.
- Update on any future module add/remove. The next refactor wave depends on it being current.

---

## Summary

| Entity | Kind | Where | Lifecycle owner |
|---|---|---|---|
| `OrchestrationContext` | TypeScript interface | `src/core/context.ts` | A1 (Wave A Gate 1) |
| `PrerequisiteSpec` | TypeScript interface | `src/core/stages/prerequisites.ts` | A2 (Wave A Gate 1) |
| `GapAnalysisDecision` | TypeScript union (existing) | `src/core/types.ts` | A5 (Wave A Gate 3) |
| Service typed errors | Class hierarchy | `src/renderer/services/*` | C3 (services wave) |
| Renderer hook state ownership | Type partition | `src/renderer/hooks/*` | B1..B3.6 (Wave B) |
| Refactor Wave | Process entity | n/a (PRs on `main`) | Whole project |
| Sub-Gate | Process entity | branch `011-refactoring` | Wave A only |
| File-Size Exception | Doc entity | `file-size-exceptions.md` | Pre-Wave (locked) |
| Golden Trace | Doc entity | `golden-trace-pre-A.txt` | Pre-Wave (frozen baseline) |
| Module Map | Doc entity | `module-map.md` | End of Wave A |
