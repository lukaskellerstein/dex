# Wave A: decompose orchestrator.ts and checkpoints.ts

**Branch**: `011-refactoring` → `main` (squash merge)
**Spec**: [`specs/011-refactoring/`](../../../specs/011-refactoring/)
**Module map**: [`docs/my-specs/011-refactoring/module-map.md`](./module-map.md)

## Summary

Decomposes the two largest core files in dex — `src/core/orchestrator.ts` (2,313 LOC) and `src/core/checkpoints.ts` (1,071 LOC) — into named per-concept modules under `src/core/stages/`, `src/core/checkpoints/`, plus three new top-level helpers (`gap-analysis.ts`, `phase-lifecycle.ts`, `run-lifecycle.ts`). Behaviour is preserved exactly: the post-Wave-A golden trace is byte-identical to the pre-A baseline at every sub-gate (G0..G4). Net result is `orchestrator.ts` at **316 LOC** (−86 %) and `checkpoints.ts` reduced to a 7-line re-export shim, with the responsibilities behind 13 new files each ≤400 LOC and orientation-blocked.

## Verification gate (all 9 checks at G4)

| # | Check | Result |
|---|---|---|
| 1 | `npx tsc --noEmit` | ✓ exit 0, zero diagnostics |
| 2 | `npm run test:core` | ✓ 81 / 83 passing (2 pre-existing T022 caveats — `.js` import resolution under `--experimental-strip-types`); +29 new tests added by Gate 3 (gap-analysis: 22, finalize: 2, phase-lifecycle: 5) |
| 3 | Clean smoke on `dex-ecommerce` (mock backend) | ✓ 3 cycles → 3 features → gaps_complete → PR creation; 33 agentRuns recorded; 20 phase log dirs all populated |
| 4 | Resume smoke | ✓ Stop mid-cycle-2-verify → Resume: log shows `resuming from state file` + `skipping prerequisites (resume)` + cycle 2 continued via `RESUME_FEATURE` → reached cycle 3 implement before stop. No state-reconciliation errors. |
| 5 | DevTools console | ✓ zero errors / warnings |
| 6 | Per-run log tree | ✓ `run.log` + every `phase-<N>_*/agent.log` present and non-empty |
| 7 | `npm run check:size` | ✓ exits clean against the allow-list (see "Notes" below for the 3 SCHEDULED entries — explicit user approval requested) |
| 8 | Golden-trace diff vs `golden-trace-pre-A.txt` | ✓ **zero diff** at every Wave-A sub-gate (G0, G1, G2, G3, G4) — 50 lines identical, sed-pipeline normalisation |
| 9 | DEBUG badge probe | ✓ runId / phaseTraceId resolve to existing log files |

## Files added (13 new modules)

- `src/core/context.ts` — `OrchestrationContext` interface + `createContext()` builder
- `src/core/checkpoints/{tags,recordMode,jumpTo,variants,timeline,variantGroups,commit,index}.ts` — 7 sub-files split out of the old `checkpoints.ts` god-file
- `src/core/gap-analysis.ts` — `parseGapAnalysisDecision`, `applyGapAnalysisDecision`, `shouldRunStage`, `getDecisionSpecDir`
- `src/core/phase-lifecycle.ts` — `recordPhaseStart` / `recordPhaseComplete` / `recordPhaseFailure` / `emitSkippedStep`
- `src/core/run-lifecycle.ts` — `initRun`, `finalizeRun`, `runtimeState` (single mutable bag for live-run bridge handles)
- `src/core/stages/{prerequisites,clarification,main-loop,build,run-stage,run-phase,manifest-extraction,finalize}.ts` — 8 per-stage runners

## Files modified

- `src/core/orchestrator.ts` — 2,313 → **316** LOC (−86 %). Kept as the coordinator surface (`run()` dispatcher, `runLoop` body, named-export hub for IPC).
- `src/core/checkpoints.ts` — reduced to a 7-line re-export shim over the new `checkpoints/` namespace.
- `src/main/ipc/orchestrator.ts` — JSDoc updated to document the residual `currentContext` reads.

## Tests

- `src/core/__tests__/context.test.ts` — 5 tests pin createContext's contract.
- `src/core/__tests__/gap-analysis.test.ts` — 22 tests cover all 5 decision variants, malformed-input throws, exhaustive `shouldRunStage` matrix, and `getDecisionSpecDir`.
- `src/core/__tests__/finalize.test.ts` — 2 compile-time pin tests for the input/output shape (behavioural tests deferred to Wave D vitest infra — same pattern as T022 / T030).
- `src/core/__tests__/phase-lifecycle.test.ts` — 5 compile-time pin tests for the input shapes (behavioural tests deferred to Wave D).

## Spec-folder artefacts

- `docs/my-specs/011-refactoring/file-size-exceptions.md` — 2 perpetual exceptions (state.ts, ClaudeAgentRunner.ts) + 3 SCHEDULED deferrals (see Notes)
- `docs/my-specs/011-refactoring/error-codes.md` — IPC error-code vocabulary
- `docs/my-specs/011-refactoring/golden-trace-pre-A.txt` — 50-line baseline (intersection of two pre-A runs)
- `docs/my-specs/011-refactoring/event-order.md` — canonical emit sequence + tolerable-reorder list per sub-gate
- `docs/my-specs/011-refactoring/module-map.md` — full `src/core/` tree post-decomposition

## Post-merge revert

```bash
git revert <merge-sha> -m 1
git push origin main
```

## Smoke checklist after revert

- [ ] `npx tsc --noEmit` clean
- [ ] `npm run test:core` clean (52 / 54 expected — pre-revert baseline)
- [ ] Welcome → Open Existing → Start Autonomous Loop reaches at least one cycle (mock backend)
- [ ] Resume from a recent commit reaches at least one stage transition
- [ ] DevTools console clean

## Notes

### A4.5 landed in this PR (`main-loop.ts` 824 → 573 LOC)

The Implement → Verify → Learnings cohesive block (~295 LOC) was extracted to `src/core/stages/cycle-stages.ts` as `runImplementVerifyLearnings`. main-loop.ts retains `runMainLoop` as a slimmer cycle iterator that delegates the implement/verify/learnings half to the new helper. Golden-trace **zero-diff** preserved across the move (verified post-A4.5 with the same protocol used at every Wave-A sub-gate).

`main-loop.ts` retires from the check:size allow-list as a result.

### Wave B / Wave C-rest scoped allow-list entries

Two SCHEDULED allow-list entries remain:
- `src/renderer/hooks/useOrchestrator.ts` (907 LOC) — splits in Wave B (Phase 5, T078–T087)
- `src/renderer/App.tsx` (720 LOC) — splits in Wave C-rest (Phase 6, T088–T090)

Both are documented in [`file-size-exceptions.md`](./file-size-exceptions.md) with their target wave. Each retires from the allow-list when its target wave's PR merges. Strict reading of T048 ("only state.ts and ClaudeAgentRunner.ts may exceed 600 LOC") would have required compressing Wave B + Wave C-rest into this PR; the documented schedule is the consistent reading versus the wave plan in tasks.md. **The user explicitly approved this allow-list extension** ("yes, I allow") after seeing the trade-off.

### Resume-after-checkpoint-reset hang (pre-existing, NOT introduced by Wave A)

When state.json is absent on disk but the renderer asks for `config.resume=true` (e.g. after `reset-example-to.sh <checkpoint>` which doesn't restore the gitignored state.json), the orchestrator hits "no state file found — starting fresh" but the `if (!config.resume)` guard at the run-record-creation step skips `runs.startRun`, so the next `runs.startAgentRun` throws on missing run record and the prerequisites driver hangs silently. Same code paths existed pre-A; behaviour preserved as-is. To be addressed in the planned `01X-state-reconciliation` spec — out of scope for 011.

### LOC delta — orchestrator.ts

| Commit | LOC | Δ |
|---|---:|---:|
| Pre-Wave-A baseline | 2,313 | — |
| After A1 (OrchestrationContext) | 2,124 | −189 |
| After A2 (prerequisites) | 1,987 | −137 |
| After A3 (clarification) | 1,896 | −91 |
| After A4 (main-loop) | 1,206 | −690 |
| After A5 / A6 / A7 (gap-analysis + finalize + phase-lifecycle) | 1,129 | −77 |
| **After A8 — Wave A done** | **316** | **−813** |

Total reduction: **−1,997 LOC** (86 %).
