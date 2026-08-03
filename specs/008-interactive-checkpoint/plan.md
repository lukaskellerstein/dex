# Implementation Plan: Interactive Checkpoint — Branch, Version, and Retry Without Git

**Branch**: `008-interactive-checkpoint` | **Date**: 2026-04-17 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/008-interactive-checkpoint/spec.md`

## Summary

Add a time-travel tree over Dex's pipeline. Every completed stage auto-captures a **checkpoint** (annotated git tag on a parse-friendly commit). Users rewind with **Go back**, rerun with **Try again**, fan out with **Try N ways**, and promote with **Keep this** — four verbs that hide git entirely. A new pure-Node module `src/core/checkpoints.ts` owns naming, promotion, go-back, dirty-tree detection, and variant spawning (with `git worktree` for spec-only stages). A **custom D3 + React-owned SVG** timeline renderer visualises the tree; React owns the DOM for click/hover handlers, `d3-zoom`/`d3-shape` own pan-zoom and edge math, layout is a pure function. Variant groups persist to `<projectDir>/.dex/variant-groups/<group-id>.json` so a crash or quit during fan-out recovers cleanly on reopen. Ten abstraction-leak scenarios (dirty tree, missing identity, not a repo, detached state, external git ops, missing refs, promotion failure, concurrent instances, cloned project, `git clean` scope) each have a dedicated fallback. Ships atop feature 007 (per-project JSON audit) so candidate SHAs and checkpoint tags populate existing phase records with no dual-write.

## Technical Context

**Language/Version**: TypeScript 5.6+ (strict mode), Node.js bundled with Electron 41 (Node 20 runtime).

**Primary Dependencies**:
- **Unchanged** — `@anthropic-ai/claude-agent-sdk` ^0.1.45, `electron` ^41.2.1, `react` ^18.3.1, `gsap` ^3.12.5, `lucide-react` ^0.460.0.
- **Added (new)** — `d3-zoom`, `d3-selection`, `d3-shape` (~12 kB gz total). No full `d3` mega-bundle. No graph-viz library (`@gitgraph/react` is archived; React Flow's Pro-upgrade pull is a long-term risk for a pillar feature).
- **System** — `git` ≥ 2.20 (required for `git worktree` semantics introduced in 2.5 and hardened through 2.20+). Implementation uses `node:fs`, `node:path`, `node:os`, `node:crypto`, `child_process.execSync` via the existing `src/core/git.ts` wrapper.

**Storage**:
- **History layer (authoritative, shared via `git push`)** — git refs:
  - `checkpoint/<name>` annotated tags (e.g. `checkpoint/cycle-1-after-plan`)
  - `attempt-<timestamp>[-<letter>]` branches
  - `capture/<date>-<runId-slice>` canonical anchor branches
- **Cache layer (local, gitignored)**:
  - `<projectDir>/.dex/state.json` (existing, now gitignored post-P3)
  - `<projectDir>/.dex/variant-groups/<group-id>.json` (new — variant orchestration state)
  - `<projectDir>/.dex/worktrees/<branch>/` (new — git worktree dirs for parallel variants; short-lived, cleaned on Keep/Discard)
- **Audit layer (from 007)**:
  - `<projectDir>/.dex/runs/<runId>.json` — gains `checkpointTag` + `candidateSha` per phase record
  - `~/.dex/logs/<project>/<runId>/` — unchanged
- **Committed per-project state** — `<projectDir>/.dex/feature-manifest.json` (unchanged), `<projectDir>/.dex/learnings.md` (unchanged).

**Testing**:
- `npx tsc --noEmit` — typecheck gate on every PR.
- `node --test src/core/__tests__/checkpoints.test.ts` — pure-Node unit tests for naming round-trips, `promoteToCheckpoint` idempotency, `startAttemptFrom` dirty-tree / gitignored-file preservation, `spawnVariants` partial-failure rollback, `isParallelizable` table. Uses tmpdir git repos.
- `node --test src/renderer/components/checkpoints/__tests__/timelineLayout.test.ts` — snapshot tests for the pure layout function on fixture `TimelineSnapshot`s (including multi-variant fan-out).
- `electron-chrome` MCP (CDP port 9333) — end-to-end UI verification against `dex-ecommerce` at `checkpoint/cycle-1-after-plan` (post-S2) using `reset-example-to.sh`.
- Property-based tests on `labelFor` / `checkpointTagFor`: for every `(stage, cycleNumber ∈ {0, 1, 7})` product, outputs are distinct and round-trip through the parsing regex.

**Target Platform**: Electron desktop (Linux primary, macOS/Windows supported). Frameless `BrowserWindow` + Vite renderer. `git` in `$PATH` is a hard prerequisite; missing-git is handled as an abstraction-leak edge case (FR-036).

**Project Type**: Desktop app — Electron main (`src/main/`) + pure-Node orchestration core (`src/core/`) + React renderer (`src/renderer/`). No backend service. Two new CLI scripts (`dex/scripts/promote-checkpoint.sh`, rewritten `dex/scripts/reset-example-to.sh`) ship alongside the app.

**Performance Goals**:
- **Timeline graph**: Smooth pan/zoom (60 fps target) up to 200 nodes. At 500+ nodes (~many-attempts-accumulated edge), no UI lock-up; if profiling shows cost, virtualize off-screen nodes. Layout is already a pure fn so virtualization is cheap to add later.
- **Parallel variants**: 3-way fan-out of a spec-only stage completes in ≤ 1.5× single-variant wall time (SC-005). The 0.5× budget covers worktree-add (~100 ms each), process spawn, and result collection.
- **Variant cost estimate**: returns in < 10 ms — reads at most 20 recent runs from `<projectDir>/.dex/runs/*.json` and slices the top 5 matching phase costs.
- **`listTimeline`**: ≤ 50 ms for ≤ 200 git refs (tags + branches) plus one `git log --all --grep='^\[checkpoint:'` pass. Cached in the renderer's `useTimeline` hook with 30 s poll + window-focus invalidation.
- **`commitCheckpoint`**: unchanged from today's behaviour plus two trivial edits (structured message, `--allow-empty`). < 200 ms.

**Constraints**:
- **Single-writer per project**: all checkpoint-mutating IPC acquires `<projectDir>/.dex/state.lock` (extended from orchestrator-only today). Second Dex instance on the same project renders timeline read-only.
- **git underneath, never surfaced**: no primary UI affordance names a branch, tag, SHA, or uses the word "detached". Error paths fall back to friendly modals; raw errors live in `electron.log`.
- **`git clean -fd` (never `-fdx`)** on Go back — preserves gitignored files (`.env`, build output, editor state, `.dex/state.lock`).
- **Zero new modals in default flow** (SC-001). Record mode off by default. Timeline panel collapsed by default.
- **No new runtime dependencies** beyond the three tiny d3 packages. No pulling the full `d3` mega-bundle.
- **Dev-phase, no migration** (Assumption in spec). Legacy `fixture/*` branches on `dex-ecommerce` are deleted, not converted.
- **Prerequisite**: feature 007 has shipped. This spec writes `candidateSha` / `checkpointTag` into `<projectDir>/.dex/runs/<runId>.json` records, not into any SQLite table.

**Scale/Scope**:
- Typical project: one feature per cycle × ~11 stages per cycle × multiple cycles per run ≈ 20–40 checkpoint tags per completed run. Attempt branches accumulate during usage; 30-day auto-prune keeps count bounded.
- Variant fan-out: v1 supports 2–5 variants per group, one stage per group. Typical usage: 3 variants of `plan` or `tasks`.
- Approximate code scope (delta):
  - **New** — `src/core/checkpoints.ts` (~350 lines), `src/core/__tests__/checkpoints.test.ts` (~250 lines), `src/main/ipc/checkpoints.ts` (~250 lines), `src/renderer/components/checkpoints/*` (~1,200 lines across ~12 files), `dex/scripts/promote-checkpoint.sh` + `promote.mjs` + `go-back.mjs` (~100 lines).
  - **Edited** — `src/core/types.ts`, `src/core/state.ts`, `src/core/git.ts`, `src/core/orchestrator.ts`, `src/main/preload.ts`, `src/main/index.ts`, `src/renderer/App.tsx`, `src/renderer/components/LoopDashboard.tsx`, `src/renderer/components/Topbar.tsx`, `src/renderer/hooks/useDebugPayload.ts`, `dex/scripts/reset-example-to.sh`, `dex/scripts/prune-example-branches.sh`.
  - **Docs** — `.claude/rules/06-testing.md` § 4c, `CLAUDE.md`, root `README.md`, `docs/my-specs/005-testing-improvements/README.md` (superseded banner).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

**I. Clean-Context Orchestration** — No change to agent-spawn semantics. Each stage still runs in its own `query()` call; checkpoint capture is out-of-band (a `commitCheckpoint` followed by tag-write on the host process). For variants, each of the N parallel orchestrator processes spawns its own fresh agents — contexts remain isolated per worktree. ✅ Pass.

**II. Platform-Agnostic Core** — `src/core/checkpoints.ts` uses only `node:fs`, `node:path`, `node:os`, `node:crypto`, and the existing `src/core/git.ts` `execSync` wrapper. No electron imports. IPC handlers live in `src/main/ipc/checkpoints.ts`, which acquires `acquireStateLock` and calls into the core module. The D3 renderer is renderer-only (`src/renderer/components/checkpoints/`) and cannot see core internals. ✅ Pass.

**III. Test Before Report** — DoD checklist in `quickstart.md`. Verification combines: typecheck (`npx tsc --noEmit`); `node --test` for `checkpoints.ts` (round-trip + tmpdir integration) and `timelineLayout.ts` (snapshot); MCP end-to-end against `dex-ecommerce` using `reset-example-to.sh` with three targets (`clean`, `checkpoint/cycle-1-after-tasks`, `checkpoint/done-*`); and property-based tests on naming round-trips. The verification matrix in the companion `docs/my-specs/008-interactive-checkpoint/plan.md` lists every slice's observable outcome. ✅ Pass.

**IV. Simplicity First** — The feature reduces conceptual load: a single `labelFor(stage, cycleNumber, featureSlug?)` is the single source of truth for user-visible labels, and `isParallelizable(stage)` is the single policy for worktree-vs-sequential execution. No speculative abstractions: no "pluggable VCS backend", no "graph library plugin system" — custom D3 renderer is ~400 LOC, replacing a dependency with an archived/commercialised gravity profile. No backwards-compat shims (`DexState.branchName` removed outright in P1; `fixture/*` branches deleted in P8, not migrated). ✅ Pass.

**V. Mandatory Workflow** — Spec approved via `/speckit.specify`; plan reviewed here before `/speckit.tasks`; tasks reviewed before implementation; every slice (S0–S12) lands in its own PR with typecheck + DoD verification. ✅ Pass.

**Result**: All gates pass. No violations to track. Proceeding to Phase 0.

## Project Structure

### Documentation (this feature)

```text
specs/008-interactive-checkpoint/
├── plan.md              # This file (/speckit.plan output)
├── spec.md              # Feature specification (/speckit.specify output)
├── research.md          # Phase 0 — architectural decisions (renderer choice, worktree parallelism,
│                        #           storage layering, stage categorisation, naming schema)
├── data-model.md        # Phase 1 — entities, state transitions, DexState changes
├── quickstart.md        # Phase 1 — DoD checklist + manual verification walkthrough
├── contracts/
│   ├── checkpoints-module.md    # src/core/checkpoints.ts public surface (TS signatures + semantics)
│   ├── ipc-checkpoints.md       # window.dexAPI.checkpoints.* IPC channels + payload shapes
│   ├── events.md                # stage_candidate / checkpoint_promoted / variant_group_complete
│   │                            # OrchestratorEvent additions
│   └── json-schemas.md          # variant-groups/<id>.json + commit message format
├── checklists/
│   └── requirements.md  # Spec quality checklist (/speckit.specify output)
└── tasks.md             # Phase 2 output (NOT created by /speckit.plan — see /speckit.tasks)
```

### Source Code (repository root)

```text
src/
├── core/                                 # Platform-agnostic orchestration engine (pure Node)
│   ├── checkpoints.ts                    # NEW — naming, promotion, go-back, dirty check, spawnVariants
│   ├── __tests__/
│   │   └── checkpoints.test.ts           # NEW — tmpdir integration + property round-trips
│   ├── orchestrator.ts                   # EDITED — emit stage_candidate, write checkpointTag/candidateSha
│   │                                     #           into runs JSON; branch on stepMode; record-mode
│   │                                     #           auto-promote; runVariants driver (S10)
│   ├── state.ts                          # EDITED — drop branchName (P1); rename checkpoint→lastCommit (P2);
│   │                                     #           pauseReason (P4); reconcileState authoritative mode
│   ├── git.ts                            # EDITED — commitCheckpoint structured message + --allow-empty (P5,P6)
│   ├── runs.ts                           # EDITED — PhaseRecord gains checkpointTag + candidateSha fields
│   ├── types.ts                          # EDITED — RunConfig.stepMode, OrchestratorEvent union additions
│   └── (parser/manifest/prompts)         # unchanged
├── main/
│   ├── index.ts                          # EDITED — register checkpoints IPC on app.ready
│   ├── preload.ts                        # EDITED — expose window.dexAPI.checkpoints.*
│   └── ipc/
│       ├── checkpoints.ts                # NEW — listTimeline, promote, goBack, spawnVariants,
│       │                                 #         compareAttempts, writeVariantGroup,
│       │                                 #         readPendingVariantGroups, cleanupVariantGroup,
│       │                                 #         estimateVariantCost, checkIdentity, setIdentity,
│       │                                 #         checkIsRepo, initRepo, setRecordMode, setPauseAfterStage
│       ├── orchestrator.ts               # unchanged
│       ├── history.ts                    # unchanged
│       └── project.ts                    # unchanged
└── renderer/
    ├── electron.d.ts                     # EDITED — dexAPI.checkpoints typings
    ├── App.tsx                           # EDITED — mount IdentityPrompt + InitRepoPrompt at project open
    ├── hooks/
    │   ├── useDebugPayload.ts            # EDITED — add CurrentAttemptBranch / LastCheckpointTag / CandidateSha
    │   └── useOrchestrator.ts            # EDITED — handle stage_candidate / variant_group_complete events
    └── components/
        ├── LoopDashboard.tsx             # EDITED — mount TimelinePanel + Pause-after-stage + Record toggles
        ├── Topbar.tsx                    # EDITED — mount RecBadge
        └── checkpoints/                  # NEW (directory)
            ├── TimelinePanel.tsx         # TimelineGraph + NodeDetailPanel + PastAttemptsList
            ├── TimelineGraph.tsx         # React SVG + d3-zoom wrapper
            ├── timelineLayout.ts         # Pure layout fn: TimelineSnapshot → {nodes,edges,width,height}
            ├── __tests__/
            │   └── timelineLayout.test.ts   # Snapshot tests (multi-variant fan-out etc.)
            ├── NodeCircle.tsx            # One commit/checkpoint/attempt node (SVG)
            ├── EdgePath.tsx              # Curved SVG path via d3-shape.linkVertical
            ├── NodeDetailPanel.tsx       # Right-side detail: stage summary + action buttons
            ├── PastAttemptsList.tsx      # Collapsible searchable list below graph
            ├── RecBadge.tsx              # Topbar REC badge when ui.recordMode
            ├── GoBackConfirm.tsx         # Dirty-tree Save/Discard/Cancel modal
            ├── IdentityPrompt.tsx        # git config user.name/email prompt
            ├── InitRepoPrompt.tsx        # Offer `git init` when .git absent
            ├── CandidatePrompt.tsx       # Keep/Try again/Try N ways prompt after step-mode pause
            ├── VariantCompareModal.tsx   # N-pane side-by-side compare after variant_group_complete
            ├── AttemptCompareModal.tsx   # Manual compare (stage-aware diff)
            ├── StageSummary.tsx          # Per-stage renderer (switch by stage type)
            └── hooks/
                ├── useTimeline.ts        # Calls listTimeline, polls 30s + focus invalidation
                ├── useRecordMode.ts      # Reads/writes ui.recordMode
                └── useDirtyCheck.ts      # Wraps isWorkingTreeDirty IPC

dex/
└── scripts/
    ├── promote-checkpoint.sh             # NEW — thin wrapper → promote.mjs
    ├── promote.mjs                       # NEW — calls promoteToCheckpoint; exit 0/1
    ├── reset-example-to.sh               # REWRITTEN — tag-aware replay (list / clean / checkpoint/<name>)
    ├── go-back.mjs                       # NEW — called by reset-example-to.sh for named checkpoints
    └── prune-example-branches.sh         # EDITED — extend to sweep attempt-* older than 30 days

.github/
└── workflows/
    └── refresh-checkpoints.yml           # NEW — weekly DEX_RECORD_MODE=1 run + push --tags

docs/
├── my-specs/
│   ├── 005-testing-improvements/README.md   # EDITED — superseded-by banner
│   └── 008-interactive-checkpoint/          # Source design + companion plan (already committed)
.claude/
└── rules/
    └── 06-testing.md                     # EDITED — § 4c rewritten to checkpoint system

CLAUDE.md                                 # EDITED — dependency list + on-disk layout addendum
README.md                                 # EDITED — headline "Checkpoints" section

package.json                              # EDITED — add d3-zoom, d3-selection, d3-shape
package-lock.json                         # EDITED — regenerated by npm install
```

**Structure Decision**: No new top-level directory. The feature splits cleanly along the established `core` / `main/ipc` / `renderer` boundary (Constitution Principle II). Renderer UI is collected under `src/renderer/components/checkpoints/` as a single sub-tree for discoverability and so it can be deleted or reorganised later without touching unrelated renderer code. Two new CLI scripts live in `dex/scripts/` alongside existing dev tools. One new GitHub Actions workflow captures the "nightly baseline refresh" use-case for record mode.

## Complexity Tracking

*No constitution violations. Table intentionally empty.*

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| *(none)*  | *(none)*   | *(none)*                             |

### Noted design decisions requiring extra care (not constitution violations)

These are called out because they add concentration of complexity but each has a documented rationale in `research.md`:

1. **Custom D3 + React-owned SVG renderer** instead of a library — ~400 LOC of our own code. Chosen over `@gitgraph/react` (archived) and React Flow (Pro-upgrade risk). Mitigation: pure layout fn, snapshot-tested, bounded API surface.
2. **`git worktree` parallelism for spec-only stages** — two code paths (parallel / sequential) selected by `isParallelizable(stage)`. Mitigation: single predicate, centralised; sequential path is the boring default and parallel failures roll back cleanly.
3. **Resume-mid-variant state file** — new on-disk JSON schema (`.dex/variant-groups/<id>.json`). Mitigation: schema owned entirely by this feature; file lifecycle is bounded (deleted on Keep/Discard); spec mandates clean recovery (FR-026).
