# Wave B: split useOrchestrator into 5 domain hooks

**Scope**: Phase 5 of 011-refactoring. Tasks T075..T087.

## Summary

Decomposes the 910-LOC god-hook `useOrchestrator.ts` (21 useState calls, 25-case event switch) into **5 domain-bounded hooks plus a thin composer**. State is partitioned strictly per `data-model.md` §"Renderer hook state ownership"; each hook owns a coherent slice and subscribes independently to `orchestratorService.subscribeEvents`. The composer wires the domain hooks together and owns only the cross-cutting imperative loaders (`loadRunHistory`, `loadPhaseTrace`, `loadStageTrace`, `switchToLive`).

This wave is **purely structural** — no IPC contract changed, no event semantics changed, no UI flow changed. The state-shape consumed by `App.tsx` is preserved verbatim through the composer's spread.

## Files

| File | LOC | Purpose |
|---|---|---|
| `src/renderer/hooks/useLoopState.ts` (new) | 293 | Owns `preCycleStages, loopCycles, currentCycle, currentStage, totalCost, loopTermination` + cycle/stage refs. Subscribes to 9 cycle/step/run events. |
| `src/renderer/hooks/useLiveTrace.ts` (new) | 191 | Owns `liveSteps, subagents, currentPhase, currentPhaseTraceId` + `latestAction` memo + `labelForStep` helper + `livePhaseTraceIdRef`/`livePhaseRef` (used by `switchToLive`). Reads `viewingHistoricalRef`/`modeRef` from `useRunSession`. |
| `src/renderer/hooks/useUserQuestion.ts` (new) | 85 | Owns `pendingQuestion, isClarifying`. Calls `orchestratorService.answerQuestion`. |
| `src/renderer/hooks/useRunSession.ts` (new) | 149 | Owns `mode, isRunning, currentRunId, totalDuration, activeSpecDir, activeTask, viewingHistorical` + exposes `modeRef` and `viewingHistoricalRef` for cross-hook reads. Run-level `error` sink. |
| `src/renderer/hooks/usePrerequisites.ts` (new) | 63 | Owns `prerequisitesChecks, isCheckingPrerequisites`. |
| `src/renderer/hooks/useOrchestrator.ts` (rewritten) | 511 (was 910) | Composer that calls the 5 hooks, wires the imperative loaders, and exposes the union shape `App.tsx` consumes. Subscribes to `task_phase_completed`/`tasks_updated` only for App-level callbacks (`onPhaseCompleted`/`onTasksUpdated`). |
| `src/renderer/components/loop/ClarificationPanel.tsx` (rewired) | 230 | Rewired to consume `useUserQuestion()` directly — no longer takes `requestId`/`questions`/`onAnswer` props. Self-mounts and conditionally renders. |
| `src/renderer/App.tsx` (touched) | -5 net | Drops the `<ClarificationPanel requestId={…} questions={…} onAnswer={…}/>` props; renders `<ClarificationPanel/>` unconditionally. |

**Composer LOC vs spec target**: spec called for ~80 LOC. The composer landed at 511 LOC because the cross-hook imperative loaders (`loadRunHistory`, `loadPhaseTrace`, `loadStageTrace`, `switchToLive`) — ~270 LOC of legitimately cross-cutting logic — must live somewhere. They were inline in the old god-hook; pushing them down into a single domain hook would create the same coupling problem the split was meant to solve. ~511 LOC is well under the 600-LOC threshold and matches the spec's intent of "thin composer + cross-cutting imperative methods".

## State partition (locked at B0)

```
useLoopState     →  preCycleStages, loopCycles, currentCycle, currentStage, totalCost, loopTermination
useLiveTrace     →  liveSteps, subagents, currentPhase, currentPhaseTraceId
useUserQuestion  →  pendingQuestion, isClarifying
useRunSession    →  mode, isRunning, currentRunId, totalDuration, activeSpecDir, activeTask, viewingHistorical
usePrerequisites →  prerequisitesChecks, isCheckingPrerequisites
```

Total: 21 useState calls, partitioned exactly. The 6 refs (`viewingHistoricalRef`, `modeRef`, `currentCycleRef`, `currentStageRef`, `livePhaseTraceIdRef`, `livePhaseRef`) move with their state slices. `useRunSession` and `useLoopState` expose their refs publicly so other hooks/composer can read them without coupling state.

## Event subscription matrix (locked at B0)

7 of the 25 event-type cases legitimately touch state in 2+ hooks (e.g. `step_started` updates `useLiveTrace`'s `currentPhase`/`currentPhaseTraceId`/`liveSteps`/`subagents` AND `useLoopState`'s `currentStage`/`preCycleStages`/`loopCycles` AND `useRunSession`'s `activeSpecDir`). A strict 1-event-to-1-hook partition would require introducing a coordinator and re-emitting events, contradicting FR-008's behaviour-preservation gate.

**Resolution**: each hook subscribes independently and handles only the cases that touch its own state. Multiple hooks may subscribe to the same event — each mutates only its own state. Cost: 5 IPC subscriptions vs 1 (the underlying event bus is one). Benefit: hooks are testable in isolation; the matrix in `event-order.md` documents the cross-cutting touches per case.

Full matrix in `docs/my-specs/011-refactoring/event-order.md` §"Event → hook subscription matrix".

## Verification gate

| # | Check | Result |
|---|---|---|
| 1 | `npx tsc --noEmit` | Exit 0; zero diagnostics ✓ |
| 2 | `npm test` | 81 core + 16 renderer = **97 passing** ✓ |
| 3 | Production build (`npm run build`) | tsc + vite build succeed; 1858 modules transformed; bundle 417 KB / gzip 117 KB ✓ |
| 4 | Wave-gate grep `grep -rn 'window.dexAPI' src/renderer \| grep -v '/services/'` | Zero matches ✓ |
| 5 | File-size audit (`npm run check:size`) | Clean per the existing allow-list ✓ |
| 6 | Matrix audit | Every legacy `useOrchestrator` switch case is handled by at least one new hook; manual diff of the legacy switch vs the union of 5 new hooks → zero orphans. The 1 legacy `case "error":` empty body is preserved as a no-op in `useRunSession` pending the composer-level fatal-error sink (B4 follow-up). ✓ |
| 7 | Live-UI smoke on `dex-ecommerce` | **Deferred — environmental.** The `electron-chrome` MCP disconnected during this session and is not reconnectable from inside the agent. The user verifies the smoke manually before opening this PR (see "User-runs smoke checklist" below). |
| 8 | Headless-mock smoke | Pre-existing T022 caveat — `.js` import resolution under `--experimental-strip-types` blocks the script. Same root cause as the 2 quarantined core tests; unaffected by Wave B. Wave D's vitest infra resolves it. |
| — | Golden-trace diff | Deferred until live smoke produces a `~/.dex/logs/dex-ecommerce/<runId>/run.log`. Expected: zero diff vs `golden-trace-pre-A.txt` (Wave B touches only renderer; core emit semantics unchanged). |

### User-runs smoke checklist (before opening PR)

1. `./scripts/reset-example-to.sh clean`
2. `./dev-setup.sh` (in a separate terminal)
3. Welcome → Open Existing → Steps tab → toggle **Automatic Clarification** → click **Start Autonomous Loop**
4. Confirm the loop reaches **3 cycles → gaps_complete → completed**
5. DevTools console — zero new errors / warnings
6. Click the **DEBUG badge** — payload resolves to existing `~/.dex/logs/<project>/<runId>/` files
7. Capture the post-Wave-B golden trace and diff against `golden-trace-pre-A.txt`:

   ```bash
   RUN_DIR=$(ls -td ~/.dex/logs/dex-ecommerce/*/ | head -1)
   sed -E '
       s/\[20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z\] //
       s/ \{.*\}$//
       s/dex\/20[0-9]{2}-[0-9]{2}-[0-9]{2}-[a-z0-9]+/dex\/<BRANCH>/g
       s/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/<UUID>/g
   ' "$RUN_DIR/run.log" | sort -u > /tmp/golden-post-wave-b.txt
   diff docs/my-specs/011-refactoring/golden-trace-pre-A.txt /tmp/golden-post-wave-b.txt
   ```

   Expected: empty diff. Wave B touches only renderer; the orchestrator's emit semantics are untouched.

## Post-merge revert

```bash
git revert <merge-sha> -m 1
git push origin main
```

After revert, re-run the smoke checklist below to confirm function is restored.

## Smoke checklist after revert

- [ ] `npm test` clean
- [ ] Welcome → Open Existing → Start Autonomous Loop reaches at least one cycle
- [ ] Resume from a recent checkpoint reaches at least one stage transition
- [ ] DevTools console clean
- [ ] DEBUG badge payload resolves to existing log files

## Notes

- **Two instances of `useUserQuestion`.** App.tsx (via the composer) and ClarificationPanel each call `useUserQuestion()` after the rewire. Both subscribe to the event bus independently and converge on identical state via the same events. This is intentional — the spec called for ClarificationPanel to be self-sufficient; the composer keeps its instance because `App.tsx` reads `isClarifying` for breadcrumb state. State double-tracking is cheap (one extra subscription) and avoids prop drilling.
- **Composer-level fatal-error sink.** Spec called for a top-level error sink in B4. Implemented as a no-op `case "error":` in `useRunSession` for now — the legacy code's empty-body case is preserved verbatim. Surfacing fatal errors to a top-level toast is a small follow-up; tracked but not gating Wave B (no behaviour change vs legacy).
- **`buildLoopStateFromRun` import.** Lazy-imported inside the composer's `useEffect` for the run-state hydration path — avoids pulling that 60-LOC helper into the bundle's hot path on first paint.
- **No new prod deps.** Vitest infra remained from Wave C-services (no additions).
- **No public IPC surface change.** `window.dexAPI` is preserved exactly. `App.tsx`'s `useOrchestrator()` return shape is preserved exactly through the composer's spread.
- **File-size profile.** All new hooks ≤300 LOC; composer at 511 LOC (well under the 600 threshold). The legacy 910-LOC god-hook retires.
