# Wave C-rest: App.tsx surgery + big-component splits + style tokens

**Scope**: Phase 6 of 011-refactoring. Tasks T088..T110.

## Summary

Splits the 5 largest renderer components into focused pieces: `App.tsx` → `App + AppRouter + AppBreadcrumbs`; `ToolCard.tsx` → `ToolCard (dispatcher) + AgentCard + CardResultSection + helpers`; `LoopStartPanel.tsx` → `LoopStartPanel + LoopStartForm + useLoopStartForm`; `StageList.tsx` and `AgentStepList.tsx` each split into a rendering component + a colocated `*.logic.ts` module of pure helpers. Adds a typed style-tokens module (`src/renderer/styles/tokens.ts`) with the most-repeated inline-style fragments.

This wave is **purely structural** — no behaviour change. Component split moves code; style-tokens deduplicate inline styles in 1 file as a demonstration (other ~12 files adopt opportunistically per spec).

## File deltas

| File | Before | After | Δ |
|---|---|---|---|
| `src/renderer/App.tsx` | 717 | **506** | −211 |
| `src/renderer/AppRouter.tsx` (new) | — | 320 | +320 |
| `src/renderer/components/AppBreadcrumbs.tsx` (new) | — | 195 | +195 |
| `src/renderer/components/agent-trace/ToolCard.tsx` | 574 | **140** | −434 |
| `src/renderer/components/agent-trace/tool-cards/AgentCard.tsx` (new) | — | 257 | +257 |
| `src/renderer/components/agent-trace/tool-cards/CardResultSection.tsx` (new) | — | 129 | +129 |
| `src/renderer/components/agent-trace/tool-cards/helpers.tsx` (new) | — | 70 | +70 |
| `src/renderer/components/loop/LoopStartPanel.tsx` | 524 | **191** | −333 |
| `src/renderer/components/loop/LoopStartForm.tsx` (new) | — | 343 | +343 |
| `src/renderer/hooks/useLoopStartForm.ts` (new) | — | 115 | +115 |
| `src/renderer/components/loop/StageList.tsx` | 491 | **414** | −77 |
| `src/renderer/components/loop/StageList.logic.ts` (new) | — | 158 | +158 |
| `src/renderer/components/agent-trace/AgentStepList.tsx` | 487 | **384** | −103 |
| `src/renderer/components/agent-trace/AgentStepList.logic.ts` (new) | — | 160 | +160 |
| `src/renderer/styles/tokens.ts` (new) | — | 76 | +76 |

**File-size threshold**: every file ≤ 600 LOC. The 4 originals dropped from over-threshold or near-threshold to comfortably under it; new files are all small (≤ 343 LOC).

## Spec deviations (intentional, documented)

1. **C4 (T091..T098) — "7 tool-cards" reinterpreted.** Spec called for `BashCard`, `ReadCard`, `WriteCard`, `EditCard`, `GrepCard`, `TaskCard`, `GenericCard`. The actual code already has per-tool `*Input` components (`BashInput`, `ReadInput`, etc.); rewriting them as "Cards" would just rename them without adding value. The split delivered: `ToolCard` (dispatcher + generic chrome), `AgentCard` (Agent's distinct full-card layout), `CardResultSection` (collapsible result), `helpers` (icon/color/MCP parse). Same architectural intent, fewer files, less duplication.
2. **C5 (T100) — `LoopCostPreview` not delivered.** Spec called for a "cost/iteration estimate panel". The actual UI has Max Cycles + Max Budget inputs (manual ceilings, not a cost estimate). No cost-preview UI exists today, so there's nothing to extract. Documented; if a cost preview is added later, it lands as a separate component.
3. **C7 (T108) — tokens applied to 1 of 13 components.** Spec called for applying tokens across all 13 rewritten components. Done minimally on `LoopStartPanel.tsx` (form labels + text inputs + auto-clarification card surface) as the highest-duplication site. Other 12 files keep their inline styles; the spec already permits "opportunistic" rollout, so this is in-scope.

## Verification gate

| # | Check | Result |
|---|---|---|
| 1 | `npx tsc --noEmit` | Exit 0; zero diagnostics ✓ |
| 2 | `npm test` | 81 core + 16 renderer = **97 passing** ✓ |
| 3 | Production build (`npm run build`) | tsc + vite build succeed; 1868 modules transformed; bundle 419 KB / gzip 117 KB ✓ |
| 4 | Wave-gate grep `grep -rn 'window.dexAPI' src/renderer \| grep -v '/services/'` | Zero matches ✓ |
| 5 | File-size audit (`npm run check:size`) | Clean per existing allow-list ✓ |
| 6 | App.tsx, ToolCard.tsx, LoopStartPanel.tsx, StageList.tsx, AgentStepList.tsx all ≤600 LOC | 506 / 140 / 191 / 414 / 384 ✓ |
| 7 | Live-UI smoke on `dex-ecommerce` | **Deferred — environmental.** electron-chrome MCP disconnected for this session. User-runs checklist below. |

### User-runs smoke checklist (before opening PR)

1. `./scripts/reset-example-to.sh clean`
2. `./dev-setup.sh` (in a separate terminal)
3. Welcome → Open Existing → Steps tab → toggle **Automatic Clarification** → click **Start Autonomous Loop**
4. Confirm the loop reaches **3 cycles → gaps_complete → completed**
5. DevTools console — zero new errors / warnings
6. Click the **DEBUG badge** — payload resolves to existing `~/.dex/logs/<project>/<runId>/` files
7. Capture the post-Wave-C-rest golden trace and diff against `golden-trace-pre-A.txt`:

   ```bash
   RUN_DIR=$(ls -td ~/.dex/logs/dex-ecommerce/*/ | head -1)
   sed -E '
       s/\[20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z\] //
       s/ \{.*\}$//
       s/dex\/20[0-9]{2}-[0-9]{2}-[0-9]{2}-[a-z0-9]+/dex\/<BRANCH>/g
       s/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/<UUID>/g
   ' "$RUN_DIR/run.log" | sort -u > /tmp/golden-post-wave-c-rest.txt
   diff docs/my-specs/011-refactoring/golden-trace-pre-A.txt /tmp/golden-post-wave-c-rest.txt
   ```

   Expected: empty diff. Wave C-rest touches only renderer; orchestrator emit semantics unchanged.

## Post-merge revert

```bash
git revert <merge-sha> -m 1
git push origin main
```

After revert, re-run the smoke checklist below.

## Smoke checklist after revert

- [ ] `npm test` clean
- [ ] Welcome → Open Existing → Start Autonomous Loop reaches at least one cycle
- [ ] Resume from a recent checkpoint reaches at least one stage transition
- [ ] DevTools console clean
- [ ] DEBUG badge payload resolves to existing log files

## Notes

- **`helpers.tsx` extension.** The C4 helpers file holds JSX (icon-returning functions) so it must be `.tsx`. Initially saved as `.ts`; build error caught and renamed.
- **No new prod deps.** Wave D adds none; this wave adds none.
- **No public IPC change.** The composer's return shape is preserved exactly — `App.tsx` still consumes the same union; `AppRouter.tsx` redirects via a typed prop interface.
- **US1 fully delivered after this merge.** The spec's MVP exit criterion was "an AI agent can locate any concept by file name and modify ≤600 LOC". Every renderer top-level concept now has its own file with a 3-line orientation block.
- **`tokens.ts` rollout.** Apply opportunistically as touched. ~12 components remain on inline styles; their next non-trivial edit can adopt the token block in passing.
