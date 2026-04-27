# Contract: Module orientation block

**Where**: Top of every newly extracted module under `src/core/stages/`, `src/core/checkpoints/`, `src/core/{context,gap-analysis,phase-lifecycle}.ts`, `src/renderer/services/`, `src/renderer/hooks/{useLoopState,useLiveTrace,useUserQuestion,useRunSession,usePrerequisites}.ts`, and the C4–C6 split components.
**Status**: Required for every newly extracted module (FR-010).

## Purpose

The orientation block is the very first thing an AI agent or human reader sees when opening the file. Its job is to answer in three lines: *what does this module own?* *what does it deliberately not own?* *what does it depend on?* — so the next read is targeted, not exploratory.

## Format

```ts
/**
 * What: <one sentence — the single concept this module owns>
 * Not: <one sentence — what this module deliberately does not do>
 * Deps: <one line — primary collaborators, comma-separated>
 */
```

Three lines. No fourth line of fluff. No paragraph-style description.

## Examples

```ts
// src/core/stages/prerequisites.ts
/**
 * What: Runs the 5 prerequisite checks (claude_cli, specify_cli, git_init, github_repo, speckit_init) before any spec-kit cycle.
 * Not: Does not decide which checks apply per mode — that lives in runLoop. Does not run inside Build mode.
 * Deps: OrchestrationContext, runs.startAgentRun, RunLogger.
 */
```

```ts
// src/core/gap-analysis.ts
/**
 * What: Parses the gap-analysis agent's output into a typed GapAnalysisDecision and applies the chosen branch.
 * Not: Does not call the gap-analysis agent itself — that's main-loop's responsibility. Does not mutate state outside ctx.
 * Deps: OrchestrationContext, GapAnalysisDecision (from types.ts), reconcileState (from state.ts).
 */
```

```ts
// src/renderer/hooks/useLoopState.ts
/**
 * What: Owns loop-cycle progression state — preCycleStages, loopCycles, currentCycle, currentStage, totalCost, loopTermination.
 * Not: Does not own live-step state, user-question state, or prerequisites — those live in their own hooks. Does not call IPC; subscribes to events only.
 * Deps: orchestratorService.subscribeEvents, buildLoopStateFromRun (existing pure transform).
 */
```

```ts
// src/renderer/services/checkpointService.ts
/**
 * What: Typed wrapper over window.dexAPI.checkpoints.* — listTimeline, jumpTo, commit, promote, etc., plus typed CheckpointError.
 * Not: Does not cache, retry, or transform results. Does not subscribe to events; that's orchestratorService.
 * Deps: window.dexAPI.checkpoints, error-codes.md vocabulary.
 */
```

## Invariants

1. **Three lines.** Not two, not four. The format constraint is the contract.
2. **The "Not" line is non-optional.** Even if the boundary feels obvious, it's not obvious to the next agent. State it.
3. **Deps lists primary collaborators only**, not every imported symbol. TypeScript's import block already lists those.
4. **First-person voice forbidden.** "What" / "Not" / "Deps" are the labels — no "This module..." or "We track...".
5. **Lives at the very top of the file**, above all imports. The reader's eye starts here.

## What goes in the "Not" line

This is the load-bearing line — it tells the next agent where the boundary is. Good "Not" lines name a sibling module that *does* hold the listed responsibility, so the reader knows where to look next.

Bad: "Not: Does not handle errors."
Good: "Not: Does not run inside Build mode (only Loop). Does not promote checkpoints — that's checkpoints/recordMode.ts."

## Validation

Reviewed manually at every wave gate. There is no automated check — the format is small enough that drift would be obvious in code review. If drift becomes a problem in practice, a one-line ESLint rule can be added later (out of scope here).

## Cost

~5 minutes per module during extraction. Approximately 12 modules × 5 min ≈ 60 min total across the refactor.

## References

- Spec FR-010.
- Research R-007 — format rationale and rejected alternatives.
