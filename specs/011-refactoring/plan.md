# Implementation Plan: Refactor Dex for AI-Agent Modification (Phase 2)

**Branch**: `011-refactoring` | **Date**: 2026-04-27 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/011-refactoring/spec.md`

## Summary

Behaviour-preserving structural refactor delivered as a sequence of squash-merged Wave PRs on `011-refactoring`:

1. **Pre-Wave** — produce 5 spec-folder artefacts (`file-size-exceptions.md`, `golden-trace-pre-A.txt` from intersection of two baseline runs, `error-codes.md` enumerated from `src/main/ipc/`, `event-order.md` template, `module-map.md` outline). Lock A8-prep Path α (keep slimmed `run()`) and pending-question handle on `OrchestrationContext`.
2. **Wave A** — decompose `src/core/orchestrator.ts` (2,313 → ≤500) and `src/core/checkpoints.ts` (1,071 → 7 sub-files + shim). Five sub-gates (G0..G4); each ends with `tsc` + `npm test` + clean smoke + checkpoint-resume smoke + golden-trace diff. Introduces `OrchestrationContext`, extracted stage modules (`prerequisites`, `clarification`, `main-loop`), `gap-analysis`, `finalize`, `phase-lifecycle`. `module-map.md` written at end. Core unit tests via `node:test` colocated.
3. **Wave C-services** — typed IPC service layer under `src/renderer/services/` (6 services, typed error codes). Migrate all 14 current `window.dexAPI` consumers (12 components + `useProject` + `useTimeline`). Land **before** Wave B so split hooks consume services from day one.
4. **Wave B** — split `useOrchestrator` (907 → composer + 5 domain hooks: `useLoopState`, `useLiveTrace`, `useUserQuestion`, `useRunSession`, `usePrerequisites`). State→hook + event→hook matrices live in `event-order.md` (B0). Composer-level fatal-error sink for unmatched phase-discriminated errors. `ClarificationPanel` rewired to consume `useUserQuestion` directly.
5. **Wave C-rest** — extract `AppBreadcrumbs` + `AppRouter` (App.tsx 720 → ~250). Split `ToolCard` (574 → dispatcher + 7 tool-cards), `LoopStartPanel` (523 → form + cost preview + `useLoopStartForm`), `StageList` / `AgentStepList` (logic extracted to `*.logic.ts`). Style tokens (`tokens.ts`) applied to the ~13 components rewritten in this wave only.
6. **Wave D** — test infrastructure (vitest + @testing-library/react + jsdom for renderer, `node:test` retained for core; two runners, two configs, one npm script that runs both). 5 renderer hook tests + `checkpointService` mock test.

Verification suite at every wave gate: `tsc` clean, `npm test` clean, full clean smoke on `dex-ecommerce`, resume smoke from a recent checkpoint, no new DevTools console errors, intact per-run log tree, file-size audit clean (Wave A onward), golden-trace diff within `event-order.md`-tolerable reorders.

The user runs all git commits manually per the global CLAUDE.md rule.

## Technical Context

**Language/Version**: TypeScript 5.6+ (strict mode), Node.js bundled with Electron 41 (Node 20 runtime).
**Primary Dependencies**: Unchanged production stack — `@anthropic-ai/claude-agent-sdk` ^0.1.45, `electron` ^41.2.1, `react` ^18.3.1, `gsap` ^3.12.5, `lucide-react` ^0.460.0, `d3-shape` + `d3-zoom`. **One dev-dep block added in Wave D**: `vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`. No other dependency change.
**Storage**: Unchanged — per-project `.dex/state.json`, `.dex/feature-manifest.json`, `.dex/learnings.md`, `.dex/runs/<runId>.json`; `~/.dex/logs/<project>/<runId>/` text log tree. Five new spec-folder artefacts under `docs/my-specs/011-refactoring/` (committed to git, shared via push).
**Testing**:
- `npx tsc --noEmit` — type safety, every gate.
- `node --test src/core/**/*.test.ts` — existing pattern; new core tests for `prerequisites`, `gap-analysis`, `finalize`, `phase-lifecycle` colocated.
- `npx vitest` — Wave-D additions; new renderer-hook tests + `checkpointService` mock test under `src/renderer/**/*.test.{ts,tsx}`.
- `electron-chrome` MCP (CDP 9333) — full clean smoke + checkpoint-resume smoke at every wave gate.
- Golden-trace diff against `golden-trace-pre-A.txt` (intersection of two baseline runs).
- `npm run check:size` — file-size audit (Wave-A required deliverable).
**Target Platform**: Electron desktop app (frameless window) — primary Linux, secondary macOS. Windows is not a release target.
**Project Type**: Desktop application (Electron main + React 18 renderer + platform-agnostic core).
**Performance Goals**: No new performance targets — refactor is structural. The implicit invariant is that the orchestrator's emit timing on the smoke run does not regress beyond the tolerable reorders enumerated in `event-order.md`.
**Constraints**:
- **Behaviour-preserving.** Event semantics, state-machine shape, synthetic `step_started`/`step_completed` from `emitSkippedStep`, `decision === "stopped"` → `status: "running"` mapping, the 5-second resume heuristic in `StageList`, and single-mode `reconcileState` all stay intact.
- **Public IPC shape preserved during migration.** `window.dexAPI` shape unchanged through end of Wave C; service layer is additive.
- **No git commits by the agent.** User triggers every commit per global CLAUDE.md.
- **Clean-context orchestration preserved** (Constitution I): each `query()` call still owns its own context; no extracted module introduces cross-call state.
- **Platform-agnostic core preserved** (Constitution II): no `electron` / `src/main/*` / `src/renderer/*` import inside `src/core/**`. Services live in renderer; the IPC handlers stay in main.
- **File size**: ≤600 LOC per file in scope; ≤120 LOC per function. Three documented exceptions: `src/core/state.ts` (763, deferred to `01X-state-reconciliation`), `src/core/agent/ClaudeAgentRunner.ts` (699, deferred to a future SDK-adapter spec). `src/core/checkpoints.ts` itself becomes a re-export shim and exits the exception list.
- **No new state-management library** (Redux/Zustand stay forbidden), **no CSS framework**, **no new prod deps**.
**Scale/Scope**:
- 8+ extracted core modules + 7 checkpoint sub-files; 5 split renderer hooks + 1 composer; 6 services; 7 split components; ~9 new test files.
- Approximately 60 source files touched, ~12 deleted/obsoleted, ~30 new.
- Five wave PRs against `main`, each independently reviewable, each with a post-merge `git revert <merge-sha>` command in its description.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

**I. Clean-Context Orchestration** — ✅ Pass.
The refactor neither adds nor removes any `query()` call. `OrchestrationContext` carries per-run *runtime* state (`abort`, `runner`, `state`, `projectDir`, `releaseLock`, `emit`, `rlog`, pending-question handle); it does not carry conversational state across phase boundaries. Each extracted stage function still spawns its own fresh `query()` via the runner. Hooks (PreToolUse, PostToolUse, SubagentStart, SubagentStop) remain the sole step-capture path and are unaffected.

**II. Platform-Agnostic Core** — ✅ Pass and strengthened.
- All new core modules (`src/core/context.ts`, `src/core/stages/*.ts`, `src/core/gap-analysis.ts`, `src/core/phase-lifecycle.ts`, `src/core/checkpoints/*`) use only `node:fs`, `node:path`, `node:crypto`, existing core helpers, and the runner abstraction. Zero `electron` / `src/main/*` / `src/renderer/*` imports.
- The new `src/renderer/services/` layer **enforces** Principle II: it is the only place `window.dexAPI` may be referenced post-Wave-C. A grep for `window\.dexAPI` outside `src/renderer/services/` returning zero matches is part of the wave gate (SC-009).
- The IPC layer (`src/main/ipc/orchestrator.ts`) under Path α retains its singleton holder for `abortController` + `releaseLock` + pending-question (necessary because `stopRun` / `submitUserAnswer` arrive on different IPC handlers than `runLoop`); this residual is documented inline rather than hidden.

**III. Test Before Report** — ✅ Pass and strengthened.
- Every newly extracted core module ships with a contract-pinning test (FR-007).
- Every wave gate (G0..G4 in Wave A, plus Waves B/C/D end-gates) runs the full verification suite — `tsc` + `npm test` + clean smoke + checkpoint-resume smoke + DevTools console clean + log tree intact + file-size audit + golden-trace diff.
- Resume smoke runs at every gate (more sensitive to event reorders than fresh runs — FR-015).
- The two-baseline golden-trace intersection is the safety net against race-y SDK-stream emit ordering producing false positives.

**IV. Simplicity First** — ✅ Pass.
- The refactor *is* the simplification: 2,313 → ≤500 LOC for the orchestrator, 1,073 → ≤120 LOC for `runLoop`, god-hook → 5 domain hooks, 14 `window.dexAPI` reach-ins → 6 services.
- Each extracted module has one concept. Each newly named function ≤120 LOC.
- No speculative abstractions: no profile editor, no CSS-in-JS, no Redux/Zustand, no new top-level directories beyond what the decomposition forces.
- `tokens.ts` is plain typed objects, not a CSS framework — and scoped to the ~13 files rewritten by C4–C6 (no opportunistic rewrites of the other ~44 inline-style files; those rot).
- The single residual complexity — IPC-layer singleton trio (`abortController` + `releaseLock` + pending-question) — is justified inline; module-globals "fully eliminated" would be overstated.

**V. Mandatory Workflow** — ✅ Pass.
- Understand: spec.md + this plan + the README at `docs/my-specs/011-refactoring/README.md`.
- Plan: this document.
- Implement: 5 squash-merged Wave PRs in the order locked by the spec's "Order of Execution" (Pre-Wave → Wave A G0..G4 → D-partial → C3 services → B0 → Wave B → C1+C2 → C4..C6 → C7 → D-rest).
- Test: per Principle III at every gate.
- Report: each Wave PR description includes the post-merge revert command + smoke checklist.

**Result**: All gates pass. Proceeding to Phase 0.

## Project Structure

### Documentation (this feature)

```text
specs/011-refactoring/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── orchestration-context.md
│   ├── service-layer.md
│   ├── wave-gate.md
│   ├── module-orientation-block.md
│   └── golden-trace.md
├── checklists/
│   └── requirements.md  # /speckit.specify checklist (already created)
├── spec.md              # /speckit.specify output (already created)
└── tasks.md             # Phase 2 output (/speckit.tasks command — not created here)
```

### Source Code (repository root)

The repo follows the standard Dex layout (Electron main + platform-agnostic core + React renderer). The refactor reshapes all three subtrees:

```text
src/
├── core/
│   ├── orchestrator.ts                       # SHRINK: 2,313 → ~400 (thin coordinator under Path α)
│   ├── context.ts                            # NEW: OrchestrationContext interface
│   ├── stages/
│   │   ├── prerequisites.ts                  # NEW: 5 declarative PrerequisiteSpec entries + 20-line loop
│   │   ├── clarification.ts                  # NEW: 4-step clarification phase
│   │   ├── main-loop.ts                      # NEW: cycle iterator + 4 named per-stage helpers + ~80-line dispatcher
│   │   └── finalize.ts                       # NEW: post-stage checkpoint ritual
│   ├── gap-analysis.ts                       # NEW: parseGapAnalysisDecision + applyGapAnalysisDecision
│   ├── phase-lifecycle.ts                    # NEW: recordPhaseStart / recordPhaseComplete / recordPhaseFailure
│   ├── checkpoints.ts                        # SHRINK: 1,071 → ~30-line re-export shim
│   ├── checkpoints/                          # NEW directory (A0.5)
│   │   ├── index.ts                          # ~120 — assembles `checkpoints` namespace
│   │   ├── tags.ts                           # ~200 — checkpointTagFor / parseCheckpointTag / labelFor
│   │   ├── jumpTo.ts                         # ~190 — jumpTo / maybePruneEmptySelected / unselect
│   │   ├── recordMode.ts                     # ~80  — readRecordMode / autoPromoteIfRecordMode
│   │   ├── variants.ts                       # ~140 — VariantSpawnRequest / spawnVariants
│   │   ├── timeline.ts                       # ~290 — listTimeline + types
│   │   ├── variantGroups.ts                  # ~90  — variant-group file IO
│   │   └── commit.ts                         # ~50  — commitCheckpoint + readPauseAfterStage (moved by A0)
│   ├── git.ts                                # SHRINK: commitCheckpoint moves to checkpoints/commit.ts (A0)
│   ├── runs.ts                               # UNCHANGED — phase-lifecycle.ts wraps its writers
│   ├── state.ts                              # UNCHANGED — file-size exception (763)
│   ├── agent/
│   │   └── ClaudeAgentRunner.ts              # UNCHANGED — file-size exception (699)
│   └── __tests__/
│       ├── prerequisites.test.ts             # NEW: emit sequence, fix path, fail path
│       ├── gap-analysis.test.ts              # NEW: golden parse for each branch + malformed input
│       ├── finalize.test.ts                  # NEW: checkpoint sequence with mock git
│       └── phase-lifecycle.test.ts           # NEW: runs.startAgentRun + emit + rlog ordering
│
├── main/
│   └── ipc/
│       └── orchestrator.ts                   # KEEP residual singleton; document inline (Path α)
│
└── renderer/
    ├── App.tsx                               # SHRINK: 720 → ~250
    ├── AppRouter.tsx                         # NEW (C2): view-switching JSX
    ├── components/
    │   ├── AppBreadcrumbs.tsx                # NEW (C1): breadcrumb rendering
    │   ├── ClarificationPanel.tsx            # REWIRE (B3): consumes useUserQuestion directly
    │   ├── agent-trace/
    │   │   ├── ToolCard.tsx                  # SHRINK: 574 → ~100 (dispatcher only)
    │   │   ├── tool-cards/
    │   │   │   ├── BashCard.tsx              # NEW
    │   │   │   ├── ReadCard.tsx              # NEW
    │   │   │   ├── WriteCard.tsx             # NEW
    │   │   │   ├── EditCard.tsx              # NEW
    │   │   │   ├── GrepCard.tsx              # NEW
    │   │   │   ├── TaskCard.tsx              # NEW
    │   │   │   └── GenericCard.tsx           # NEW (fallback)
    │   │   └── AgentStepList.tsx             # SHRINK: 487 → ~200 + AgentStepList.logic.ts
    │   └── loop/
    │       ├── LoopStartPanel.tsx            # SHRINK: 523 → ~200
    │       ├── LoopStartForm.tsx             # NEW (C5)
    │       ├── LoopCostPreview.tsx           # NEW (C5)
    │       └── StageList.tsx                 # SHRINK: 491 → ~200 + StageList.logic.ts
    ├── hooks/
    │   ├── useOrchestrator.ts                # SHRINK: 907 → ~80 (composer)
    │   ├── useLoopState.ts                   # NEW (B1)
    │   ├── useLiveTrace.ts                   # NEW (B2)
    │   ├── useUserQuestion.ts                # NEW (B3)
    │   ├── useRunSession.ts                  # NEW (B3.5)
    │   ├── usePrerequisites.ts               # NEW (B3.6)
    │   ├── useLoopStartForm.ts               # NEW (C5)
    │   └── __tests__/
    │       ├── useLoopState.test.tsx         # NEW (Wave D Path A)
    │       ├── useLiveTrace.test.tsx         # NEW
    │       ├── useUserQuestion.test.tsx      # NEW
    │       └── useRunSession.test.tsx        # NEW
    ├── services/                             # NEW directory (C3)
    │   ├── checkpointService.ts              # NEW
    │   ├── orchestratorService.ts            # NEW
    │   ├── projectService.ts                 # NEW
    │   ├── historyService.ts                 # NEW
    │   ├── profilesService.ts                # NEW
    │   ├── windowService.ts                  # NEW
    │   └── __tests__/
    │       └── checkpointService.test.ts     # NEW (Wave D Path A)
    └── styles/
        └── tokens.ts                         # NEW (C7): typed style fragment objects
```

**Structure Decision**: Standard Dex layout. The decomposition introduces two new core subdirectories (`src/core/stages/` and `src/core/checkpoints/`) because each holds a coherent multi-file family with a shared lifecycle (stages all consume `OrchestrationContext`; checkpoints all share the `tags` taxonomy). Services and tool-cards land in their own renderer subdirectories for the same reason. No new top-level directories.

## Complexity Tracking

> No constitution violations to justify.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| (none) | | |

Two intentional residuals — both already documented in spec / constitution alignment, listed here for traceability rather than as exceptions:

- **IPC-layer singleton trio** (`abortController` + `releaseLock` + pending-question handle) survives in `src/main/ipc/orchestrator.ts`. This is *not* a Constitution violation because it lives in the IPC layer, not in core; it is the boundary between IPC handlers (`stopRun`, `submitUserAnswer` arrive on different handlers than the one running `runLoop`). Documented inline.
- **Two file-size exceptions** (`src/core/state.ts` 763, `src/core/agent/ClaudeAgentRunner.ts` 699). Justified in `file-size-exceptions.md` (Pre-Wave). `state.ts` waits for `01X-state-reconciliation`; `ClaudeAgentRunner.ts` waits for a dedicated SDK-adapter spec.
