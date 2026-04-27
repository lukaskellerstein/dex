# Quickstart: Refactor Dex for AI-Agent Modification (Phase 2)

**Branch**: `011-refactoring`
**Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Research**: [research.md](./research.md)

This is the operator's checklist for kicking off and running each wave of the refactor. It assumes you have read `spec.md` and `plan.md` and accept the assumptions captured there.

---

## Pre-flight (do once, before Wave A)

### 1. Confirm branch and working tree

```bash
git branch --show-current        # → 011-refactoring
git status                       # spec.md / plan.md / research.md / data-model.md / contracts/ / quickstart.md should be present
```

### 2. Confirm dev environment is live

`./scripts/dev-setup.sh` running in another terminal — Vite + Electron + electron-chrome MCP. Sanity:

```bash
ls ~/.dex/dev-logs/                    # vite.log + electron.log
mcp__electron-chrome__list_pages       # must succeed; returns the Dex window
```

If it fails, fix the dev environment before continuing.

### 3. Produce the 5 spec-folder artefacts

These live under `docs/my-specs/011-refactoring/` (committed to git, shared via push). All five are produced **before Gate 0 starts**.

#### 3a. `file-size-exceptions.md`

```markdown
# File-Size Exceptions — 011-refactoring

## src/core/state.ts  — 763 LOC
Reason: 01X-state-reconciliation lands on top of this refactor and rewrites this file. Refactoring it now would create merge conflicts with that planned work.
Follow-up spec: 01X-state-reconciliation

## src/core/agent/ClaudeAgentRunner.ts  — 699 LOC
Reason: SDK adapter; defer to a dedicated future spec for adapter-shape work.
Follow-up spec: TBD (post-011)
```

#### 3b. `error-codes.md` (C3 prerequisite)

```bash
grep -rn 'throw new Error\|throw new [A-Z][a-zA-Z]*Error' src/main/ipc/ src/core/ \
  > /tmp/error-codes-raw.txt
# Then group by service and write to docs/my-specs/011-refactoring/error-codes.md
# Format: one section per service, one bullet per code with a one-line reason.
```

#### 3c. `golden-trace-pre-A.txt`

See [contracts/golden-trace.md](./contracts/golden-trace.md) — full capture protocol with two baselines + intersection.

#### 3d. `event-order.md` (canonical emit sequence template; matrices filled in B0)

Seed with the sequence from `contracts/golden-trace.md` §"What goes in event-order.md". Matrices for state→hook and event→hook are filled at B0 (start of Wave B), not now.

#### 3e. `module-map.md` (placeholder; filled at end of Wave A)

Stub it now with the post-Wave-A target tree from `data-model.md` §Module Map. Update at G4.

### 4. Lock A8-prep choice

Per [research.md](./research.md) R-002 — **Path α** (keep `run()` as a slimmed dispatcher; IPC unchanged). If you want Path β, document it in `file-size-exceptions.md` (or a sibling note) **before Gate 0 starts**. Do not pick mid-wave.

---

## Wave A — Decompose orchestrator.ts and checkpoints.ts

Each sub-gate ends with the wave-gate verification suite from [contracts/wave-gate.md](./contracts/wave-gate.md).

### Gate 0 — A0 + A0.5 (mechanical moves)

```bash
# A0 — move commitCheckpoint from src/core/git.ts:32 to src/core/checkpoints.ts (then later to checkpoints/commit.ts)
# A0 — move readPauseAfterStage from src/core/orchestrator.ts:511 to src/core/checkpoints.ts
# A0 — re-export them as the `checkpoints` namespace
# A0.5 — split src/core/checkpoints.ts into 7 sub-files under src/core/checkpoints/

npx tsc --noEmit
node --test src/core/__tests__/checkpoints.test.ts   # must pass without modification
# Run the full wave-gate verification suite (see contracts/wave-gate.md)
```

### Gate 1 — A1 + A2 (OrchestrationContext + prerequisites)

```bash
# A1 — create src/core/context.ts; thread `ctx` through extracted phase boundaries
# A2 — extract src/core/stages/prerequisites.ts (declarative SPECS + 20-line driver)
# Write src/core/__tests__/prerequisites.test.ts (D-partial)

npx tsc --noEmit
npm test
# Wave-gate verification suite
```

### Gate 2 — A3 + A4 (clarification + main loop)

```bash
# A3 — extract src/core/stages/clarification.ts
# A4 — extract src/core/stages/main-loop.ts (with 4 named per-stage helpers + ~80-line dispatcher)

# Wave-gate verification suite
```

### Gate 3 — A5 + A6 + A7 (gap-analysis + finalize + lifecycle)

```bash
# A5 — extract src/core/gap-analysis.ts; write gap-analysis.test.ts
# A6 — extract src/core/stages/finalize.ts; write finalize.test.ts
# A7 — extract src/core/phase-lifecycle.ts; write phase-lifecycle.test.ts

# Wave-gate verification suite
```

### Gate 4 — A8 (trim coordinator)

```bash
# A8 — orchestrator.ts becomes a thin coordinator (~400 LOC under Path α)
# Write docs/my-specs/011-refactoring/module-map.md (final)
# Add `npm run check:size` script to package.json with allow-list

# Wave-gate verification suite — including #7 file-size audit (must pass)
```

### Wave A PR

Open the squash-merge PR from `011-refactoring` to `main` titled `phase 2/wave-A: decompose orchestrator.ts and checkpoints.ts`. PR description follows the template in [contracts/wave-gate.md](./contracts/wave-gate.md) §"PR-description template".

User reviews and merges. Then continue.

---

## Wave C-services — Typed IPC service layer

Lands **before Wave B** so split hooks consume services from day one.

```bash
# C3 — create src/renderer/services/{checkpoint,orchestrator,project,history,profiles,window}Service.ts
# C3 — migrate all 14 current consumers (12 components + useProject + useTimeline)
# Write src/renderer/services/__tests__/checkpointService.test.ts (full Wave D path A — vitest infra goes in here too if not yet)

# Service-layer-specific check:
grep -rn 'window\.dexAPI' src/renderer | grep -v '^src/renderer/services/'
# → must return zero matches

# Wave-gate verification suite (1–6 + 9, plus the grep above)
```

**Note on Wave D infrastructure**: vitest + @testing-library/react + jsdom dev-deps must be installed before `checkpointService.test.ts` runs. Either install them in Wave C-services (and write the renderer config) or defer test files to Wave D. Recommended: install dev-deps now, write the one service test, defer hook tests to Wave D-rest.

PR: `phase 2/wave-C-services: typed IPC service layer`. Merge before starting Wave B.

---

## Wave B — Split useOrchestrator

### B0 — write the matrices (no code yet)

Update `docs/my-specs/011-refactoring/event-order.md` with:
1. State → hook matrix (all 21 useState calls assigned).
2. Event → hook matrix (all 25 switch cases assigned).
3. The 5 `AgentStep` subtypes (`subagent_result`, `subagent_spawn`, `text`, `thinking`, `tool_call`) — verify zero downstream consumers in `useLiveTrace`'s `labelForStep`.

### B1..B3.6 — extract hooks one at a time

Each new hook lands with the events it owns *removed from `useOrchestrator` in the same commit*, so events are never double-handled.

```bash
# B1 — useLoopState.ts (~250 LOC)
# B2 — useLiveTrace.ts (~250 LOC)
# B3 — useUserQuestion.ts (~150 LOC) + rewire ClarificationPanel.tsx to consume it directly
# B3.5 — useRunSession.ts (~100 LOC) — owns run-level error only; phase-scoped errors flow elsewhere per discriminator
# B3.6 — usePrerequisites.ts (~80 LOC)
```

### B4 — composer

```bash
# useOrchestrator.ts becomes a ~80-line composer that re-exports the union shape App.tsx currently consumes.
# Add the composer-level fatal-error sink for events whose phase doesn't match any active hook.
```

Wave-gate verification suite. PR: `phase 2/wave-B: split useOrchestrator`.

---

## Wave C-rest — App.tsx surgery + big component splits

```bash
# C1 — extract src/renderer/components/AppBreadcrumbs.tsx (~140 LOC from App.tsx:392-532)
# C2 — extract src/renderer/AppRouter.tsx (~150 LOC from App.tsx:357-644)
# (App.tsx → ~250 LOC)

# C4 — split ToolCard.tsx → tool-cards/{Bash,Read,Write,Edit,Grep,Task,Generic}Card.tsx + dispatcher
# C5 — split LoopStartPanel.tsx → LoopStartForm.tsx + LoopCostPreview.tsx + useLoopStartForm.ts
# C6 — split StageList.tsx (491) and AgentStepList.tsx (487); extract pure logic to *.logic.ts

# C7 — add src/renderer/styles/tokens.ts; apply to the ~13 components rewritten by C4–C6 only
```

Wave-gate verification suite (1–6 + 7 + 9). PR: `phase 2/wave-C-rest: App.tsx + big-component splits`.

---

## Wave D — Tests + verification

```bash
# Install vitest + @testing-library/react + jsdom (if not done in C-services) and write vitest.config.ts
# Write the 4 renderer hook tests:
#   - useLoopState.test.tsx
#   - useLiveTrace.test.tsx
#   - useUserQuestion.test.tsx
#   - useRunSession.test.tsx

# Combined `npm test` script runs both `node --test` (core) and `vitest run` (renderer)
```

Wave-gate verification suite. PR: `phase 2/wave-D: renderer hook tests`. After merge: `git branch -D 011-refactoring`.

---

## When something fails a gate

**Wave-internal (before merge)**: `git reset --hard <prior-gate-tip>` on `011-refactoring`. The prior gate's commit SHA is the rollback target. Branch-local; no other waves affected.

**Post-merge**: revert PR on `main` using the command in the wave's PR description:
```bash
git revert <merge-sha> -m 1
git push origin main
```
Then re-run the smoke checklist from the PR description to confirm the revert restored function.

**If the rollback also fails**: stop and escalate to the user. Do not improvise destructive recovery on `main`.

---

## What you should never do during this refactor

- ❌ Commit to git yourself (user runs all commits per global CLAUDE.md).
- ❌ Touch the regions listed in spec §Constraints (synthetic `step_started`/`step_completed`, `decision === "stopped"` mapping, 5s heuristic, single-mode `reconcileState`). Those are deliberately preserved for `01X-state-reconciliation`.
- ❌ Add a state-management library, CSS framework, or new prod dependency.
- ❌ Half-migrate `window.dexAPI` consumers in Wave C — all 14 go in the same wave.
- ❌ Pick A8-prep path mid-wave. Lock it in Pre-Wave.
- ❌ Skip a sub-gate's verification suite. The whole point of sub-gates is small-diff isolation.
- ❌ Re-capture the golden-trace baseline mid-Wave-A. The intersection is the stable signal; replacing it during the wave defeats the regression check.

## References

- [spec.md](./spec.md) — what we're building and why.
- [plan.md](./plan.md) — technical decisions and project structure.
- [research.md](./research.md) — path choices with rationale.
- [data-model.md](./data-model.md) — types and process entities.
- [contracts/](./contracts/) — five contract docs (orchestration-context, service-layer, wave-gate, module-orientation-block, golden-trace).
- [docs/my-specs/011-refactoring/README.md](../../docs/my-specs/011-refactoring/README.md) — the original detailed plan this work flows from.
- `.claude/rules/06-testing.md` — `dex-ecommerce` smoke procedure, log layout, DEBUG badge.
