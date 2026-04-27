# Contract: Wave-Verification Gate

**When**: At the end of every Wave-A sub-gate (G0..G4) and at the end of Waves B / C-services / C-rest / D.
**Doubles as**: PR-readiness criteria for each wave's squash-merge PR.

## Required checks (composite)

A wave/sub-gate passes only if **all** of the following are clean:

| # | Check | Command | Pass criterion |
|---|---|---|---|
| 1 | Type safety | `npx tsc --noEmit` | Exit 0; zero diagnostics |
| 2 | Test suite | `npm test` | All tests pass, including newly added ones |
| 3 | Clean smoke | Run on `dex-ecommerce` after `./scripts/reset-example-to.sh clean` | Welcome → Open Existing → autonomous loop with auto-clarification → prerequisites complete → clarification produces a plan → at least one cycle through specify → plan → tasks → implement → learnings → checkpoint creation visible in `git log --grep='^\[checkpoint:' --oneline` |
| 4 | Resume smoke | Run on `dex-ecommerce` after `./scripts/reset-example-to.sh <recent-checkpoint>` | Resume button reaches at least one stage transition without a state-reconciliation error |
| 5 | DevTools console | `mcp__electron-chrome__list_console_messages` | No new errors compared to pre-gate baseline |
| 6 | Per-run log tree | Inspect `~/.dex/logs/<project>/<runId>/` | `run.log` + `phase-<N>_*/agent.log` present and non-empty for each phase |
| 7 | File-size audit (Wave A onward) | `npm run check:size` | Empty result except for the allow-listed exceptions in `file-size-exceptions.md` |
| 8 | Golden-trace diff (Wave A sub-gates) | `diff golden-trace-pre-A.txt /tmp/golden-post.txt` | Empty diff or only entries listed as tolerable reorders in `event-order.md` |
| 9 | DEBUG badge probe | Click DEBUG badge in UI; copy payload | `RunID` and `PhaseTraceID` are valid UUIDs and resolve to existing log files |

## Optional checks (do not gate, but worth running)

- `mcp__electron-chrome__take_screenshot` of the Loop Dashboard at peak — useful artefact for the PR description.
- `git log --all --grep='^\[checkpoint:' --oneline` — confirm the checkpoint tree is intact.

## Per-wave specifics

**Wave A — sub-gates G0..G4**: All 9 required checks at every sub-gate. Additionally, after G4 only: write `module-map.md` and add `npm run check:size` script to `package.json`.

**Wave C-services**: Required checks 1–6 + 9. Plus the service-layer-specific grep:

```bash
grep -rn 'window\.dexAPI' src/renderer | grep -v '^src/renderer/services/'
```

…must return zero matches.

**Wave B**: Required checks 1–6 + 9. Additionally, the `event-order.md` matrix audit: every state and every event in the existing `useOrchestrator` is assigned to exactly one of the new hooks (no orphans, no duplicates). Run the audit script (or grep + manual cross-check).

**Wave C-rest**: Required checks 1–6 + 9. Plus the file-size audit (#7) — confirms `App.tsx`, `ToolCard.tsx`, `LoopStartPanel.tsx`, `StageList.tsx`, `AgentStepList.tsx` are all ≤600 LOC.

**Wave D**: Required checks 1–6. The vitest-renderer config must run cleanly (`npx vitest run` exits 0). The combined `npm test` invocation runs both `node --test` and `vitest run` and exits 0.

## Rollback policy

**Wave-internal (between sub-gates, before merge)**: rollback via `git reset` to the prior gate's commit on `011-refactoring`. Branch-local; nobody else affected.

**Post-merge**: revert PR on `main` using the command listed in the wave's PR description:

```bash
git revert <merge-sha> -m 1
git push origin main
```

After revert, re-run the smoke checklist from the original PR description. If the smoke passes, function is restored.

## PR-description template

Every wave PR uses this template (≤300 words total):

```markdown
## Wave <id>: <scope>

**Summary** (1 paragraph): <what changed and why>

**Verification gate**: <list of checks 1–9 that ran clean; link to screenshots or run logs in /tmp>

**Post-merge revert**:
\`\`\`bash
git revert <merge-sha> -m 1
git push origin main
\`\`\`

**Smoke checklist after revert** (≤5 items):
- [ ] `npm test` clean
- [ ] Welcome → Open Existing → Start Autonomous Loop reaches at least one cycle
- [ ] Resume from a recent checkpoint reaches at least one stage transition
- [ ] DevTools console clean
- [ ] DEBUG badge payload resolves to existing log files

**Notes**: <any caveats, follow-up TODOs, or pointer to research.md decisions>
```

## Non-goals

- This contract does **not** define a CI pipeline. The verification suite is run locally by the engineer at each gate.
- This contract does **not** prescribe how to recover from a failed gate beyond the rollback policy above. If the rollback also fails (rare), escalate to user.

## References

- Spec FR-012, FR-015, FR-019.
- Research R-004 — golden-trace baseline strategy.
- Research R-010 — PR shape and rollback.
- `.claude/rules/06-testing.md` §4c — `dex-ecommerce` smoke procedure.
- `.claude/rules/06-testing.md` §4f.6 — DEBUG badge.
