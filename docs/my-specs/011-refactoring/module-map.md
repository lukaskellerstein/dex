# Module Map — `src/core/` post-Wave-A decomposition

**Created**: 2026-04-27 (T047)
**Companion**: [`file-size-exceptions.md`](./file-size-exceptions.md), [`event-order.md`](./event-order.md)
**Spec**: [`specs/011-refactoring/spec.md`](../../../specs/011-refactoring/spec.md)

This is the canonical "where does X live now?" map after Wave A's decomposition. Every file lists its single concept (matches the orientation block's `What:` line) so an AI agent reading the tree from the bottom up can route to the right file in one read.

---

## Top-level orchestration

| File | LOC | Owns |
|---|---:|---|
| [`orchestrator.ts`](../../../src/core/orchestrator.ts) | 316 | Coordinator surface — `run()` dispatcher, `runLoop` body (createContext → prerequisites → clarification → manifest → mainLoop → record-mode tagging), and the named exports IPC + stage modules consume (`getRunState`, `getActiveContext`, `listSpecDirs`, `isSpecComplete`, `runStage`, `runPhase`, `runBuild`, `RunTaskState`, `buildPrompt`, `AbortError`, `submitUserAnswer`, `stopRun`). |
| [`run-lifecycle.ts`](../../../src/core/run-lifecycle.ts) | 266 | `initRun` (bootstrap: crash-recovery, branch resolution, runId/rlog, runs-table init, agent-runner resolution, state-lock acquisition, ctx construction) and `finalizeRun` (teardown: status persistence, lock release, PR creation, `run_completed` emit). Owns the `runtimeState` bag — the single mutable hold for the live run's bridge handles. |
| [`context.ts`](../../../src/core/context.ts) | 89 | `OrchestrationContext` interface + `RunState` shape + `createContext(deps)` builder. The single value threaded through every extracted phase function. |

## Per-stage runners (live in `stages/`)

| File | LOC | Owns |
|---|---:|---|
| [`stages/run-stage.ts`](../../../src/core/stages/run-stage.ts) | 122 | `runStage` — cycle-stage runner: agent-run audit entry, `step_started` emit, runner.runStep delegation, `step_completed` emit, post-stage `finalizeStageCheckpoint` hand-off. |
| [`stages/run-phase.ts`](../../../src/core/stages/run-phase.ts) | 173 | `runPhase` (build-mode phase runner), `RunTaskState` (TodoWrite + on-disk reconciliation), `buildPrompt` (slash-command prompt builder for build / plan modes). |
| [`stages/build.ts`](../../../src/core/stages/build.ts) | 153 | `runBuild` — iterates the requested spec dirs (one or many) and drives `runPhase` for every incomplete TaskPhase. |
| [`stages/main-loop.ts`](../../../src/core/stages/main-loop.ts) | 573 | `runMainLoop` — autonomous-loop cycle iterator + termination. Per cycle: gap-analysis decision → specify (NEXT_FEATURE) → plan/tasks (gated by decision) → delegate to `runImplementVerifyLearnings` → manifest update → cycle-level state persistence. Post-A4.5 shape: implement/verify/learnings extracted to `cycle-stages.ts`. |
| [`stages/cycle-stages.ts`](../../../src/core/stages/cycle-stages.ts) | 300 | `runImplementVerifyLearnings` — the cohesive implement (with phase loop + step trace) → verify (with structured-output + fix-retry) → learnings (with append) block of one cycle. Extracted in A4.5 from main-loop. Throws AbortError; caller's try/catch handles it. |
| [`stages/prerequisites.ts`](../../../src/core/stages/prerequisites.ts) | 386 | The 5 prerequisite checks (claude_cli, specify_cli, git_init, github_repo, speckit_init) before any spec-kit cycle. |
| [`stages/clarification.ts`](../../../src/core/stages/clarification.ts) | 164 | Phase A clarification — 4-step product → technical → synthesis → constitution flow producing `GOAL_clarified.md`. Skips entirely when prior specs + clarified plan exist. |
| [`stages/manifest-extraction.ts`](../../../src/core/stages/manifest-extraction.ts) | 88 | `ensureManifest` — one-time post-clarification feature-manifest extraction; emits `manifest_created` (or `manifest_drift_detected` on subsequent runs when `GOAL_clarified.md` has changed). |
| [`stages/finalize.ts`](../../../src/core/stages/finalize.ts) | 150 | `finalizeStageCheckpoint` wraps the per-stage post-execution sequence (updateState → commitCheckpoint → updatePhaseCheckpointInfo → step_candidate emit → autoPromoteIfRecordMode → readPauseAfterStage → optional pause). |

## Cross-cutting helpers

| File | LOC | Owns |
|---|---:|---|
| [`gap-analysis.ts`](../../../src/core/gap-analysis.ts) | 138 | Decision parsing + dispatch helpers — `parseGapAnalysisDecision`, `applyGapAnalysisDecision`, `shouldRunStage`, `getDecisionSpecDir`. Pure functions over `GapAnalysisDecision`. |
| [`phase-lifecycle.ts`](../../../src/core/phase-lifecycle.ts) | 193 | `recordPhaseStart` / `recordPhaseComplete` / `recordPhaseFailure` (audit + RunLogger boilerplate wrappers) + `emitSkippedStep` (synthetic skipped-step lifecycle, consolidates duplicate closures). |

## Checkpoints (history layer)

| File | LOC | Owns |
|---|---:|---|
| [`checkpoints.ts`](../../../src/core/checkpoints.ts) | 7 | Re-export shim — keeps existing `from "./checkpoints.js"` imports working after the A0.5 split. |
| [`checkpoints/index.ts`](../../../src/core/checkpoints/index.ts) | — | Assembles the `checkpoints` namespace by re-exporting from the 7 sub-files. |
| [`checkpoints/tags.ts`](../../../src/core/checkpoints/tags.ts) | — | Tag/branch naming — `checkpointTagFor`, `captureBranchName`, `attemptBranchName`, `labelFor`, `parseCheckpointTag`. |
| [`checkpoints/commit.ts`](../../../src/core/checkpoints/commit.ts) | — | `commitCheckpoint` (the per-stage commit emitter) + `readPauseAfterStage`. |
| [`checkpoints/recordMode.ts`](../../../src/core/checkpoints/recordMode.ts) | — | `readRecordMode`, `autoPromoteIfRecordMode`, `promoteToCheckpoint`, `syncStateFromHead`. |
| [`checkpoints/jumpTo.ts`](../../../src/core/checkpoints/jumpTo.ts) | — | `jumpTo`, `maybePruneEmptySelected`, `unselect`, `unmarkCheckpoint`. |
| [`checkpoints/variants.ts`](../../../src/core/checkpoints/variants.ts) | — | `VariantSpawnRequest`, `spawnVariants`, `cleanupVariantWorktree`. |
| [`checkpoints/timeline.ts`](../../../src/core/checkpoints/timeline.ts) | — | `listTimeline` and timeline types. |
| [`checkpoints/variantGroups.ts`](../../../src/core/checkpoints/variantGroups.ts) | — | Variant-group file IO. |

## State / audit / IO

| File | LOC | Owns |
|---|---:|---|
| [`state.ts`](../../../src/core/state.ts) | 763 | `<projectDir>/.dex/state.json` IO: `loadState`, `saveState`, `updateState`, `clearState`, `acquireStateLock`, `detectStaleState`, `resolveWorkingTreeConflict`, `reconcileState`, `STEP_ORDER`. **Allow-listed** (perpetual exception) — slated for `01X-state-reconciliation`. |
| [`runs.ts`](../../../src/core/runs.ts) | — | Per-project `<projectDir>/.dex/runs/<runId>.json` audit: `startRun`, `startAgentRun`, `completeAgentRun`, `appendAgentStep`, `updateRun`, `reconcileCrashedRuns`, etc. |
| [`manifest.ts`](../../../src/core/manifest.ts) | — | Feature manifest IO + helpers: `loadManifest`, `saveManifest`, `getActiveFeature`, `getNextFeature`, `updateFeatureStatus`, `updateFeatureSpecDir`, `appendLearnings`, `checkSourceDrift`. |
| [`parser.ts`](../../../src/core/parser.ts) | — | `tasks.md` parsing: `parseTasksFile`, `deriveTaskPhaseStatus`, `extractTaskIds`, `discoverNewSpecDir`. |
| [`git.ts`](../../../src/core/git.ts) | — | Git helpers: `getCurrentBranch`, `createBranch`, `createPullRequest`, `getHeadSha`. |
| [`paths.ts`](../../../src/core/paths.ts) | — | Path constants — `LOGS_ROOT`, etc. |
| [`log.ts`](../../../src/core/log.ts) | — | `RunLogger` class + `fallbackLog`. |
| [`prompts.ts`](../../../src/core/prompts.ts) | — | All prompt builders + structured-output schemas. |
| [`userInput.ts`](../../../src/core/userInput.ts) | — | `submitUserAnswer` IPC handler + `waitForUserInput` clarification helper. |
| [`types.ts`](../../../src/core/types.ts) | — | Shared types — `RunConfig`, `EmitFn`, `TaskPhase`, `Task`, `StepType`, `GapAnalysisDecision`, `LoopTermination`, `TerminationReason`, `FailureRecord`, `PrerequisiteCheck`, `PrerequisiteCheckName`. |
| [`events.ts`](../../../src/core/events.ts) | — | `OrchestratorEvent` union (event-bus contract). |
| [`config.ts`](../../../src/core/config.ts) | — | `RunConfig` defaults + validation. |
| [`appConfig.ts`](../../../src/core/appConfig.ts) | — | `~/.dex/` global app config. |
| [`dexConfig.ts`](../../../src/core/dexConfig.ts) | — | `<projectDir>/.dex/dex-config.json` — agent backend selection (`claude` / `mock`). |

## Agent backend (`agent/`)

| File | LOC | Owns |
|---|---:|---|
| [`agent/AgentRunner.ts`](../../../src/core/agent/AgentRunner.ts) | — | `AgentRunner` interface — `runStep`, `runTaskPhase` contracts. |
| [`agent/index.ts`](../../../src/core/agent/index.ts) | — | `createAgentRunner(name, config, projectDir)` factory. |
| [`agent/registry.ts`](../../../src/core/agent/registry.ts) | — | Backend name → constructor registry. |
| [`agent/ClaudeAgentRunner.ts`](../../../src/core/agent/ClaudeAgentRunner.ts) | 699 | Real backend wrapping `@anthropic-ai/claude-agent-sdk`. **Allow-listed** (perpetual exception) — slated for a TBD SDK-adapter spec. |
| [`agent/MockAgentRunner.ts`](../../../src/core/agent/MockAgentRunner.ts) | — | Deterministic test backend driven by `<projectDir>/.dex/mock-config.json`. |
| [`agent/MockConfig.ts`](../../../src/core/agent/MockConfig.ts) | — | Mock config schema + loader. |
| [`agent/steps.ts`](../../../src/core/agent/steps.ts) | — | Pure transformers: `MODEL_PRICING`, `estimateCost`, `makeStep`, `toToolCallStep`, `toToolResultStep`, `toSubagentInfo`, `stringifyResponse`. |
| [`agent-overlay.ts`](../../../src/core/agent-overlay.ts) | — | Agent overlay manager. |
| [`agent-profile.ts`](../../../src/core/agent-profile.ts) | — | Profile management — `listProfiles`, `saveDexJson`. |

---

## Scheduled-deferral targets (still >600 LOC)

Two files are flagged by `npm run check:size` today, allow-listed pending their target wave:

| File | LOC | Wave |
|---|---:|---|
| `src/renderer/hooks/useOrchestrator.ts` | 907 | Wave B (Phase 5) — split into 5 domain-bounded hooks + composer |
| `src/renderer/App.tsx` | 720 | Wave C-rest (Phase 6) — extract `AppBreadcrumbs.tsx` + `AppRouter.tsx` |

Each entry retires from the allow-list when its target wave's PR merges. See [`file-size-exceptions.md`](./file-size-exceptions.md) for the per-file rationale.

`main-loop.ts` retired from the allow-list in A4.5 (824 → 573 LOC after the implement/verify/learnings extraction to `cycle-stages.ts`).

---

## Wave A LOC delta — orchestrator.ts

| Commit | LOC | Δ |
|---|---:|---:|
| Pre-Wave-A baseline | 2,313 | — |
| After A1 (`OrchestrationContext` threading) | 2,124 | −189 |
| After A2 (prerequisites extracted) | 1,987 | −137 |
| After A3 (clarification extracted) | 1,896 | −91 |
| After A4 (main-loop extracted) | 1,206 | −690 |
| After A5/A6/A7 (gap-analysis + finalize + phase-lifecycle wired) | 1,129 | −77 |
| **After A8 (this commit) — Wave A done** | **316** | **−813** |

Total reduction: **−1,997 LOC** (86%).
