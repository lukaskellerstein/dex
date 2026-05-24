# Implementation Plan: 014 — Branch Management (Delete + Promote-to-Main with AI-resolved conflicts)

**Branch**: `014-branch-management` | **Date**: 2026-05-03 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification at `/home/lukas/Projects/Github/lukaskellerstein/dex/specs/014-branch-management/spec.md`
**Source design doc**: `/home/lukas/Projects/Github/lukaskellerstein/dex/docs/my-specs/014-branch-management/README.md` (carries the full file-by-file plan; this document is the spec-kit-shaped distillation).

## Summary

Add two missing primitives to the interactive Timeline so the user can manage saved versions without ever opening a terminal:

1. **Remove a saved version** — generalise the existing `selected-*`-only ✕ button into a uniform delete control on every Dex-owned badge (`dex/*` + `selected-*`), routed to a new `deleteBranch` IPC. The existing `unselect` surface (IPC + core fn + handler) is removed; `deleteBranch` subsumes it. HEAD-on-target switches to `main` (fallback `master`); branches with unique commits trigger a "These steps will be lost" confirmation; an active run on the target refuses the delete.
2. **Make this the new main** — right-click a Dex-owned badge → context menu with "Make this the new main". Always uses `git merge --no-ff` so the fork-and-rejoin survives in the timeline. On clean merge: commit, switch HEAD, delete source, toast. On conflict: hand off to a new conflict-resolver harness that drives an AI agent through unmerged paths one file at a time, runs the project's verify command, then commits or routes to a three-button failure modal. No new tag is created (regression: drop the `checkpoint/promoted-*` idea from earlier drafts).

The core engine gains a third `AgentRunner` method — `runOneShot(ctx)` — for free-form ad-hoc agent invocations that fit neither cycle steps nor task phases. This is generic infrastructure: the conflict resolver is its first caller; future "small AI gestures" (one-off rewrites, naming suggestions, etc.) reuse it.

User-visible copy lives in a single `branchOps/copy.ts` module so the constitutional "no git jargon" rule is enforceable by grep.

## Technical Context

**Language/Version**: TypeScript 5.6+ (strict mode), Node.js bundled with Electron 41 (Node 20 runtime).
**Primary Dependencies**: Unchanged production stack — `@anthropic-ai/claude-agent-sdk` ^0.1.45 (used by `ClaudeAgentRunner.runOneShot`), `electron` ^41.2.1, `react` ^18.3.1, `gsap` ^3.12.5, `lucide-react` ^0.460.0, `d3-shape`, `d3-zoom`. Dev: `vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom` already present. **No new dependencies.** All git invocations reuse `safeExec`/`gitExec` from `src/core/checkpoints/_helpers.ts`.
**Storage**: Filesystem only. New optional config block `conflictResolver` in `<projectDir>/.dex/dex-config.json` (gitignored). No new audit-trail records, no new state.json fields. Resolver progress streams over the existing `orchestrator:event` channel; nothing persists between resolver runs.
**Testing**: Core tests via `node --test --experimental-strip-types` (existing harness for `src/core/__tests__/`); renderer/UI logic via `vitest run` (existing); end-to-end UI verification via `electron-chrome` MCP at CDP port 9333 against the `dex-ecommerce` example project, with `scripts/reset-example-to.sh <checkpoint>` between runs. Resolver iteration logic is fully unit-testable through `MockAgentRunner` with scripted `oneShotResponses` — no live Claude calls in CI.
**Target Platform**: Linux/macOS desktop (Electron 41). No web build, no mobile.
**Project Type**: Existing Electron desktop app — single project, fixed layout (`src/main/`, `src/core/`, `src/renderer/`). No new top-level structure.
**Performance Goals**: Delete + clean-promote both complete inside 2s p95 on the existing example project (one shell+git checkout + one branch delete + one timeline refresh). Resolver per-file iteration latency is bounded by SDK round-trip (~5–30s typical for `claude-opus-4-7`); per-promotion total is bounded by `costCapUsd` (default $0.50) and `maxIterations` (default 5).
**Constraints**:
  - **Constitutional**: `src/core/` MUST remain free of `electron` / `src/main/` / `src/renderer/` imports — every new core module honours this. The conflict-resolver harness is a pure function over `AgentRunner` and `safeExec`/`gitExec`; it emits via the injected `EmitFn` rather than touching IPC directly.
  - **No git jargon in user-visible strings**: enforced via spec FR-028; copy is centralised in `src/renderer/components/checkpoints/branchOps/copy.ts`. A grep test in CI ensures the forbidden words don't leak into user-visible code paths.
  - **Mid-run safety**: every destructive op acquires `withLock(projectDir, ...)` and refuses when `state.json.status === "running"` for the target branch.
  - **Rollback completeness**: any failed promotion (resolver cancel, max-iter, cost cap, verify fail with rollback) MUST leave the working tree, primary, and source branches indistinguishable from the pre-attempt state. `git merge --abort` is the canonical rollback; the resolver never moves files outside the merge boundary.
**Scale/Scope**: Single project per orchestrator process. Timeline shows ≤ ~50 saved versions in practice (a typical `dex-ecommerce` session has 5–15). Resolver expected to run on 1–10 conflicting files per promotion; the `costCapUsd` ceiling is the real scale guard. ≈ 16 files touched, 4 deleted (the `unselect` surface), 12 new (incl. spec docs already present).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Compliance | Evidence |
|---|---|---|
| **I. Clean-Context Orchestration** | ✅ Pass | The conflict resolver invokes a fresh `runOneShot` per iteration — no SDK conversational state carries between iterations. The system prompt + per-file user prompt are rebuilt each call from on-disk artefacts (file contents, recent commit subjects, `GOAL.md`). No long-lived agent process. |
| **II. Platform-Agnostic Core** | ✅ Pass | `src/core/checkpoints/branchOps.ts` and `src/core/conflict-resolver.ts` import only from `node:child_process`, `node:fs`, `_helpers.ts`, `tags.ts`, and the agent layer. Zero electron/main/renderer imports. The resolver receives `EmitFn` from the caller; it does not know about IPC. Verified by `npm run check:size` + an explicit "no electron import in core" assertion in the existing test setup. |
| **III. Test Before Report** | ✅ Pass | Each phase of the implementation order ends with a verification gate (see [tasks](./tasks.md) when produced). Resolver harness has 7+ unit tests via `MockAgentRunner` (scripted `oneShotResponses`); IPC handlers have integration tests; UI has MCP screenshots at every modal. The DoD checklist in the spec source doc lists 16 explicit verifications. |
| **IV. Simplicity First** | ✅ Pass | One new core file (`branchOps.ts`), one new resolver module, one new IPC method per primitive, one new copy module. The resolver is a single pure function over an existing interface, not a class hierarchy. The new `runOneShot` extends `AgentRunner` by one method — the smallest surface that lets the resolver share `MockAgentRunner` infrastructure. The `unselect` surface is deleted outright (no shim) — see Complexity Tracking for the explicit "no compat shim" justification. |
| **V. Mandatory Workflow** | ✅ Pass | Spec → plan → tasks → implement loop is exactly the spec-kit flow. Each implementation slice in the README ends with a verification gate (visual MCP check or `tsc --noEmit` + tests). |

**Gate result**: ✅ All five principles pass without exception. No entries in [Complexity Tracking](#complexity-tracking) below.

**Post-Phase-1 re-check**: Re-run after data-model.md and contracts/ are written; expected outcome: still ✅ — the design surfaces stay constitutional because the only new core module is a pure function and the only new SDK call is wrapped by `runOneShot` which is itself trivially mockable.

## Project Structure

### Documentation (this feature)

```text
specs/014-branch-management/
├── plan.md                      # This file
├── research.md                  # Phase 0 — resolves the small set of NEEDS CLARIFICATION items
├── data-model.md                # Phase 1 — concrete TS shapes for branchOps + resolver
├── quickstart.md                # Phase 1 — end-to-end smoke walkthrough on dex-ecommerce
├── contracts/
│   ├── ipc-deleteBranch.md      # IPC contract for checkpoints:deleteBranch
│   ├── ipc-mergeToMain.md       # IPC contract for checkpoints:mergeToMain
│   ├── runOneShot.md            # AgentRunner.runOneShot interface contract
│   └── conflict-resolver-events.md  # Event-stream contract for resolver progress
├── checklists/
│   └── requirements.md          # Already produced by /speckit.specify
└── tasks.md                     # Phase 2 — produced by /speckit.tasks (NOT this command)
```

### Source Code (repository root)

The Dex codebase is a single fixed-layout TypeScript project. This feature touches three trees:

```text
src/
├── core/                                    # Platform-agnostic orchestrator engine (no electron imports)
│   ├── agent/
│   │   ├── AgentRunner.ts                   # MOD: add runOneShot to interface + types
│   │   ├── ClaudeAgentRunner.ts             # MOD: implement runOneShot via SDK query()
│   │   ├── MockAgentRunner.ts               # MOD: implement runOneShot honouring oneShotResponses
│   │   ├── MockConfig.ts                    # MOD: add oneShotResponses to mock-config schema
│   │   └── __tests__/
│   │       └── runOneShot.test.ts           # NEW: mock + (light) Claude shape verification
│   ├── checkpoints/
│   │   ├── branchOps.ts                     # NEW: deleteBranch + mergeToMain core logic
│   │   ├── jumpTo.ts                        # MOD: drop unselect (subsumed by deleteBranch)
│   │   ├── index.ts                         # MOD: re-export deleteBranch + mergeToMain; drop unselect
│   │   ├── _helpers.ts                      # UNCHANGED: gitExec/safeExec reused
│   │   └── tags.ts                          # UNCHANGED: selectedBranchName still used by jumpTo
│   ├── conflict-resolver.ts                 # NEW: resolveConflicts harness over runOneShot
│   └── __tests__/
│       ├── branchOps.test.ts                # NEW: delete + clean-merge + safety guards
│       └── conflictResolver.test.ts         # NEW: scripted resolver scenarios via MockAgentRunner
├── main/
│   ├── ipc/
│   │   └── checkpoints.ts                   # MOD: drop checkpoints:unselect; add deleteBranch + mergeToMain handlers; forward conflict-resolver:* events
│   ├── preload-modules/
│   │   └── checkpoints-api.ts               # MOD: drop unselect; add deleteBranch + mergeToMain
│   └── …
└── renderer/
    ├── electron.d.ts                        # MOD: window.dexAPI surface — drop unselect; add deleteBranch + mergeToMain
    └── components/
        └── checkpoints/
            ├── TimelineGraph.tsx            # MOD: generalise ✕ to all dex/* + selected-*; add right-click handler
            ├── TimelinePanel.tsx            # MOD: own the new modals; wire IPC; subscribe to conflict-resolver:*
            ├── BranchContextMenu.tsx        # NEW: right-click floating menu (single item v1)
            ├── DeleteBranchConfirm.tsx      # NEW: lost-work warning modal
            ├── PromoteConfirm.tsx           # NEW: diff-summary confirmation modal
            ├── ConflictResolverProgress.tsx # NEW: live progress modal (subscribes to resolver events)
            ├── ResolverFailureModal.tsx     # NEW: three-button escape modal
            └── branchOps/
                └── copy.ts                  # NEW: single source of truth for user-visible strings
```

**Structure Decision**: Stay inside the existing `src/{core,main,renderer}` layout. No new top-level dirs, no new packages. Two reasons: (a) the constitutional "Platform-Agnostic Core" already gives us the seam between pure logic and Electron-bound integration, and (b) every artefact this feature adds maps cleanly onto an existing slot in that seam. Putting `conflict-resolver.ts` directly under `src/core/` (not under `checkpoints/`) signals that it's not a checkpoint primitive — it's a generic harness that happens to be invoked from the merge flow.

## Complexity Tracking

> No constitutional violations. Table left empty intentionally.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| _(none)_  | _(n/a)_    | _(n/a)_                              |

### Notable design decisions that aren't violations but deserve a paper trail

1. **Drop `unselect` outright instead of shimming.** The IPC has no callers outside the renderer; the renderer is updated in the same change set. A backwards-compatibility shim would be dead code on day one — Constitution IV (Simplicity First) calls explicitly for "no backwards-compatibility shims when you can just change the code".
2. **No new tag on promote.** Earlier drafts considered `checkpoint/promoted-*` per promotion. Rejected: the merge commit's subject (`dex: promoted <source> to main`) plus the timeline's fork-and-rejoin shape already encode "this was promoted, from where, when". An extra tag is visual noise — DoD #6 explicitly verifies the absence as a regression check.
3. **`runOneShot` on the AgentRunner interface, not a separate type.** The conflict resolver could spawn `query()` directly, but routing through `AgentRunner` lets `MockAgentRunner` script its behaviour for tests. That's the cheapest path to fully-deterministic resolver tests; the alternative (a parallel mock surface only the resolver uses) duplicates infrastructure for one caller.
4. **Cost cap is the only runaway-spend guard.** The README also discusses `maxIterations` and `maxTurnsPerIteration`, but only `costCapUsd` directly bounds dollar exposure. Iterations and turns are convenience caps for "give up when stuck"; the cost cap is the safety floor and is what SC-008 measures.

## Phase 0: Outline & Research

Most "unknowns" in this feature were already resolved by the source design doc; the small remainder is captured in `research.md`. Topics:

- How to detect conflict types the resolver cannot handle (rename/delete, binary, submodule) before invoking the agent (so the abort-and-message path fires cleanly).
- How to compute the diff summary (file count, +/- counts, top 5 paths) cheaply for the promote-confirm modal.
- The minimal allowed-tools set the resolver agent needs (`Read`, `Edit`) and why broader access is rejected.
- The resolver's per-file prompt template: what context goes in, what's truncated, what's omitted.
- The verify-command discipline: how `null` (skip) interacts with FR-018 and the failure modal copy.

See [research.md](./research.md) for decisions, rationale, and rejected alternatives.

## Phase 1: Design & Contracts

**Prerequisites**: `research.md` complete (✅).

Outputs:

- **[data-model.md](./data-model.md)** — TypeScript shapes for `DeleteBranchOpts`, `DeleteBranchResult`, `MergeToMainOpts`, `MergeToMainResult`, `OneShotContext`, `OneShotResult`, `ResolverContext`, `ResolverResult`, the resolver's discriminated-union failure tag, and the DexConfig `conflictResolver` block. Plus state transitions for the resolver state machine (per-iteration, per-file).
- **[contracts/ipc-deleteBranch.md](./contracts/ipc-deleteBranch.md)** — IPC channel `checkpoints:deleteBranch`, request/response shape, error codes, lock semantics, mid-run-refusal contract, the at-risk-step listing format.
- **[contracts/ipc-mergeToMain.md](./contracts/ipc-mergeToMain.md)** — IPC channel `checkpoints:mergeToMain`, request/response shape, the in-flight progress event sequence (resolver progress is forwarded over `orchestrator:event`), abort behaviour, post-merge actions.
- **[contracts/runOneShot.md](./contracts/runOneShot.md)** — `AgentRunner.runOneShot` interface contract: `OneShotContext` invariants (must specify `cwd`, `prompt`, optional `allowedTools`, optional `systemPromptOverride`, optional `maxTurns`); `OneShotResult` invariants (cost ≥ 0, `finishedNormally` is the abort/error oracle, `finalText` is the agent's last assistant message); MockAgentRunner contract with `oneShotResponses`.
- **[contracts/conflict-resolver-events.md](./contracts/conflict-resolver-events.md)** — Event-stream contract for `conflict-resolver:*` events forwarded over the existing `orchestrator:event` channel: `file-start`, `file-done`, `iteration`, `done`. Field shapes; ordering guarantees; ordering vs. abort.
- **[quickstart.md](./quickstart.md)** — end-to-end manual walkthrough hitting every DoD scenario on the `dex-ecommerce` example project. Maps each spec acceptance scenario to a concrete test recipe (reset script invocation, MCP commands, expected post-conditions).
- **Agent context update** — runs `.specify/scripts/bash/update-agent-context.sh claude` so `CLAUDE.md`'s "Active Technologies" line reflects the no-new-dependency reality and adds 014's storage entries.

**Re-evaluate Constitution Check after design**: see [Constitution Check](#constitution-check) above for the post-design re-check expectation. The expectation will be confirmed once research.md, data-model.md, and contracts/* are reviewed against principles I–V; if any contract requires importing electron from core (it does not by design), the gate fails and the contract is reshaped.
