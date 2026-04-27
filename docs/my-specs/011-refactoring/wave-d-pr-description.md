# Wave D: renderer hook tests + final validation

**Scope**: Phase 8 of 011-refactoring. Tasks T114..T122. Closes the 011-refactoring branch.

## Summary

Pays back the Path A test debt from Wave B by adding 4 vitest hook tests under `src/renderer/hooks/__tests__/` (useLoopState, useLiveTrace, useUserQuestion, useRunSession). Each test mocks `orchestratorService.subscribeEvents` to capture the dispatcher and exercises the hook with synthetic events. Brings renderer test coverage from 16 → **45 tests** (81 core + 45 renderer = 126 total).

This wave is **purely additive** — no source change in `src/`; only new test files. No behaviour change.

## Files

| File | LOC | Tests |
|---|---|---|
| `src/renderer/hooks/__tests__/useLoopState.test.tsx` (new) | 148 | 8 |
| `src/renderer/hooks/__tests__/useLiveTrace.test.tsx` (new) | 156 | 9 (incl. 3 for `labelForStep`) |
| `src/renderer/hooks/__tests__/useUserQuestion.test.tsx` (new) | 95 | 5 |
| `src/renderer/hooks/__tests__/useRunSession.test.tsx` (new) | 130 | 7 |

**Test patterns covered**:

- **useLoopState**: initial state, run_started clears, loop_cycle_started inserts, loop_cycle_completed `decision === "stopped" → status: "running"` (legacy contract — load-bearing), step_started inserts pre-cycle stages, step_completed updates stage + accumulates totalCost, loop_terminated user_abort ignored, gaps_complete sets termination.
- **useLiveTrace**: initial state, agent_step append (live + viewingHistorical-gated), step_started reset + currentPhase setter (loop:<step> name), subagent lifecycle, run_completed clears, `labelForStep` contracts for tool_call / subagent_spawn / unknown types.
- **useUserQuestion**: initial state, clarification_started/completed flip isClarifying, user_input_request/response store/clear pendingQuestion, answerQuestion calls service AND clears state, run_started clears both.
- **useRunSession**: initial state, run_started flips isRunning + sets runId/specDir/mode + clears viewingHistorical/totalDuration, run_completed flips false + freezes totalDuration, step_completed + task_phase_completed accumulate totalDuration, tasks_updated extracts in-progress task, setViewingHistorical flips state + ref, phase-scoped errors NOT routed (run-level only — no-op preserved).

## Mocking strategy

Each test file uses `vi.mock("../../services/orchestratorService.js", ...)` to capture the subscribed handler in a module-scoped variable. The test then calls `emit(event)` to trigger the handler synchronously inside `act()`, which flushes React state updates. This pattern keeps tests fast (single-pass, no waiting) and mirrors the production event-bus contract.

The `orchestratorService.answerQuestion` mock in `useUserQuestion.test.tsx` is a `vi.fn()` so we can assert it was called with the right args.

## Verification gate

| # | Check | Result |
|---|---|---|
| 1 | `npx tsc --noEmit` | Exit 0; zero diagnostics ✓ |
| 2 | `npm test` | 81 core + 45 renderer = **126 passing**; chained `check:size` clean ✓ |
| 3 | Production build | (no source change since Wave C-rest's clean build) ✓ |
| 4 | Wave-gate grep | Zero matches outside `services/` ✓ |
| 5 | File-size audit | Clean per allow-list (only `state.ts` + `ClaudeAgentRunner.ts`) ✓ |

## Closing the 011-refactoring branch

After Wave D PR merges to `main`:

```bash
git checkout main
git pull
git branch -D 011-refactoring
git push origin :011-refactoring  # delete remote branch (optional)
```

Per spec section "Implementation Strategy → Lifecycle", branch deletion is the user's call — the agent does not delete branches.

## Outcome — what landed across the 5 wave PRs

| Wave | LOC delta | New files | Spec coverage |
|---|---|---|---|
| **Wave A** | orchestrator 2,313 → 316 (−86%); checkpoints 1,071 → 7-line shim + 7 sub-files | `OrchestrationContext`, 4 stage modules, gap-analysis, finalize, phase-lifecycle, 7 checkpoint sub-files, 4 core tests | US1 (core decomposition), `module-map.md` |
| **Wave C-services** | 14 consumers migrated; 0 `window.dexAPI` outside services/ | 6 services + `CheckpointError` test, vitest infra | US3 (typed IPC services) |
| **Wave B** | useOrchestrator 910 → 511 (−44%) | 5 domain hooks + ClarificationPanel rewire | US4 (renderer state by domain) |
| **Wave C-rest** | App 717 → 506; ToolCard 574 → 140; LoopStartPanel 524 → 191; StageList 491 → 414; AgentStepList 487 → 384 | AppRouter, AppBreadcrumbs, AgentCard, CardResultSection, helpers, LoopStartForm, useLoopStartForm, StageList.logic, AgentStepList.logic, tokens | US1 (renderer decomposition), US2 (per-wave PRs) |
| **Wave D** | (additive only) | 4 hook tests | Test debt paid; SC-009 satisfied |

**Test coverage**: 0 → 126 (81 core + 45 renderer).
**Files ≤ 600 LOC**: every `src/` file except the 2 perpetual exceptions (`state.ts`, `ClaudeAgentRunner.ts`).
**`grep -rn 'window\.dexAPI' src/renderer | grep -v '/services/'`**: 0 matches.

## Post-merge revert

```bash
git revert <merge-sha> -m 1
git push origin main
```

After revert, re-run the smoke checklist below.

## Smoke checklist after revert

- [ ] `npm test` clean (will drop to 81 core + 16 renderer = 97 passing)
- [ ] Welcome → Open Existing → Start Autonomous Loop reaches at least one cycle
- [ ] Resume from a recent checkpoint reaches at least one stage transition
- [ ] DevTools console clean
- [ ] DEBUG badge payload resolves to existing log files

## Notes

- **Behavioural assertion strategy**: each test asserts on observable state (the hook's return value) rather than internal implementation details. The `decision === "stopped" → status: "running"` mapping is explicitly pinned to catch the legacy paused-renders-as-running contract.
- **No source changes in `src/`** — Wave D is test-only. Any source change here would invalidate the spec's "additive" framing and require a separate PR.
- **The 2 pre-existing T022 caveats** (`checkpoints.test.ts`, `jumpTo.test.ts`) remain quarantined under `npm run test:core:all`. Wave D's vitest doesn't help those — they're Node-test under `--experimental-strip-types`. A future migration could move them to vitest where `.js`→`.ts` resolution is native; out of scope for 011.
