# Research: Refactor Dex for AI-Agent Modification (Phase 2)

**Date**: 2026-04-27 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

The spec resolves all open path choices in its Assumptions section. This document records the *why* behind each — both for the next agent picking the work up and as the audit trail for any later reversal.

---

## R-001 — Test infrastructure path (vitest+jsdom for renderer, node:test for core)

**Decision**: Path A. Add `vitest` + `@testing-library/react` + `@testing-library/jest-dom` + `jsdom` as dev-dependencies for renderer-only tests. Keep `node:test` for `src/core/`. Two test runners, two configs (`vitest.config.ts` for renderer, `node --test` for core), one combined `npm test` script.

**Rationale**:
- `useLoopState` and `useLiveTrace` carry non-trivial reducer logic over 25+ events. Without contract-level unit tests, every Wave-B regression is caught only by manual smoke. That's a real correctness risk on a refactor whose entire claim is "behaviour-preserving."
- `@testing-library/react` does not interoperate with `node:test` — it expects vitest or jest with jsdom.
- Two runners is mild friction (two configs, two `npm test` invocations chained); zero hook tests on a 5-hook split is a bigger problem.
- Existing 10 colocated `node:test` tests under `src/core/` continue to work unchanged. No migration cost.

**Alternatives considered**:
- **Path B — drop renderer hook tests entirely.** Rejected: leaves the higher-state-density half of the refactor untested.
- **Migrate everything to vitest.** Rejected: gratuitous rewrite of 10 working tests; no payoff. `node --test` is fast and matches Node 20 stdlib.
- **Use Playwright Component Testing.** Rejected: heavier; the verification suite already covers integration via `electron-chrome` MCP. Component tests would duplicate that.

**Cost estimate**: ~half a day for setup (`vitest.config.ts`, `tsconfig` inclusion, `package.json` script, jsdom polyfill if needed for `ResizeObserver`).

---

## R-002 — A8-prep path (keep `run()` slim vs. delete `run()`)

**Decision**: Path α. Keep `run()` as the public entry; shrink its body to a ~30-line dispatcher (`mode resolution → createContext → runLoop | runBuild`). IPC handler at `src/main/ipc/orchestrator.ts:19` is **unchanged**.

**Rationale**:
- Path α has the smaller blast radius. Under Path β, the IPC handler changes are cross-cutting and would invalidate Gate 0's smoke baseline if picked up late — meaning the path choice has to land in Pre-Wave anyway.
- The README explicitly says "Either is fine." Picking the smaller-blast option preserves more existing call sites and makes wave-internal rollbacks cleaner.
- A4's main-loop extraction shape is the same under both paths: extracted helpers receive `ctx`. Only the public façade differs.

**Alternatives considered**:
- **Path β — delete `run()`, update IPC.** Rejected by default but acceptable if the user explicitly chooses it during Pre-Wave. The argument for it is "single clearly-named entry per mode"; the argument against is the IPC handler change.

**Lock-in point**: Pre-Wave, before Gate 0 starts. Documented in `file-size-exceptions.md` alongside the path choice.

---

## R-003 — Pending-question handle location (`OrchestrationContext` vs. IPC singleton)

**Decision**: Place the pending-question promise handle on `OrchestrationContext` (preferred per A1 design). `clarification.ts` consumes `ctx.pendingQuestion` and stays a pure function over `ctx`.

**Rationale**:
- Keeps `clarification.ts` testable as a unit — the test instantiates a fake `ctx` and asserts the resolution path.
- Avoids the trap of leaving two singleton-shaped pieces of state at the IPC layer (`abortController` + pending-question). Reducing the residual from "trio" to "duo" (`abortController` + `releaseLock`) makes the inline documentation in `src/main/ipc/orchestrator.ts` shorter and clearer.
- The `submitUserAnswer` IPC handler still resolves the promise from outside — it does so by reading the handle from a shared singleton holder that *also* holds the `OrchestrationContext` for the active run. The handler stays in IPC; the handle's *home* is `ctx`.

**Alternatives considered**:
- **Keep pending-question as an IPC-layer singleton.** Rejected: makes `clarification.ts` impure and leaks IPC concerns into core.
- **Pass the handle as an argument to `runClarificationPhase`.** Rejected: forces every caller to know about a sub-step's plumbing; defeats the point of `ctx`.

**Side effect on Constitution check**: II strengthened — the residual at the IPC boundary is two values, not three.

---

## R-004 — Golden-trace baseline strategy

**Decision**: Capture **two** baseline runs and intersect them with `comm -12` to filter race-y SDK-stream/orchestrator-emit ordering. Filter to INFO|WARN|ERROR only (strip DEBUG noise). Strip timestamps, run IDs, and PIDs via `grep -oE '\] \[(INFO|WARN|ERROR)\] [a-z_]+'`. Persist as `docs/my-specs/011-refactoring/golden-trace-pre-A.txt`.

**Rationale**:
- A single baseline flakes. Empirically the orchestrator emits some events as the SDK stream resolves — depending on how the event loop schedules a microtask, two events can swap order between back-to-back runs of an identical scenario. Without intersection, every gate's diff is noise.
- INFO|WARN|ERROR is the right granularity. Resume-path regressions surface at WARN/ERROR; INFO-only would miss them. DEBUG is too noisy and includes step-level tool-call data that legitimately reorders frame-to-frame.
- The diff at each gate is read against `event-order.md` — reorders explicitly listed there are tolerable; anything else is a regression.

**Alternatives considered**:
- **Single-baseline diff with manual review.** Rejected: every gate becomes "is this race-y or real?" — review fatigue eats discipline.
- **Sequence-aware diff using a custom tool.** Rejected: 30 minutes of bash + `comm` solves the problem; building a tool is over-engineering.
- **Store the full ordered emit log.** Rejected: too brittle. The intersection of two runs is exactly the stable subset.

**Operational note**: After every Wave-A sub-gate, the post-gate run's emit set is captured the same way and diffed against `golden-trace-pre-A.txt`. The diff is empty when nothing semantic changed.

---

## R-005 — Order of execution (services before B, B before C-rest)

**Decision**: Pre-Wave → Wave A (G0..G4) → D-partial (core tests written alongside their gates) → **C3 services** → B0 (matrices) → Wave B (B1..B4) → C1+C2 → C4..C6 → C7 → D-rest (renderer hook tests + vitest infra).

**Rationale**:
- **Services before hooks** means split hooks consume services from day one rather than being rewritten twice. If hooks landed first, every hook would later need a second pass to migrate from `window.dexAPI` to the service. That second pass is the exact "while we're here" cleanup that produces drift.
- **All 14 dexAPI consumers migrate in C3** — including `useProject` and `useTimeline`. Half-migration leaks `window.dexAPI` references into the renderer, and the post-Wave-C grep gate catches it loud.
- **Core tests written alongside their gates (D-partial)** rather than at the end keeps each Wave-A gate's smoke + test coverage symmetric. Writing all tests at the end means a regression introduced at Gate 1 is caught only at Gate 4.
- **Wave A before everything else** — the renderer changes assume the orchestrator's emit shape is stable. Reshuffling that mid-renderer-work amplifies blast radius.

**Alternatives considered**:
- **B before C3.** Rejected: rewrite-twice problem above.
- **Big-bang single PR.** Rejected: unreviewable; no rollback granularity.
- **One test per file at the very end.** Rejected: catches regressions late.

---

## R-006 — Service-layer typed errors

**Decision**: Each service exports a discriminated-union error class. Example: `class CheckpointError extends Error { code: 'NOT_FOUND' | 'BUSY' | 'GIT_DIRTY' | 'INVALID_TAG' | 'WORKTREE_LOCKED' | ... }`. The full code list per service is enumerated **before** Wave C from `src/main/ipc/` and `src/core/` via `grep -rn 'throw new Error\|throw new [A-Z][a-zA-Z]*Error'`, persisted as `docs/my-specs/011-refactoring/error-codes.md`.

**Rationale**:
- Enumerating up-front means each `*Service.ts` captures every code on first try instead of growing one-at-a-time as components migrate. The grep takes ~15 minutes; retrofit later costs orders of magnitude more.
- Discriminated unions on `code` make exhaustiveness checking trivial in callers. `switch (err.code)` becomes a type-checked `never`-fallthrough.
- Components handle codes by name, not by `instanceof Error` + string matching — that's the visible win in user-of-IPC ergonomics.

**Alternatives considered**:
- **Plain `Error` with `message` strings.** Rejected: untyped, brittle, requires string parsing in callers.
- **One global `DexError` class.** Rejected: discriminator collisions; can't narrow per-service.
- **Throw the IPC handler's error directly.** Rejected: leaks IPC layer into renderer.

**Cross-reference**: `error-codes.md` is FR-014 artefact #3. `service-layer.md` contract documents the exact shape.

---

## R-007 — Module orientation block format

**Decision**: Every newly extracted module begins with a 3–5 line JSDoc block at the top — *not* a multi-paragraph file-level docstring. Format:

```ts
/**
 * What: <one sentence — the single concept this module owns>
 * Not: <one sentence — what this module deliberately does not do>
 * Deps: <one line — primary imports / collaborators>
 */
```

**Rationale**:
- Three lines fits in any agent's working context as the very first read of the file. Multi-paragraph docstrings rot.
- The "Not" line is the load-bearing one — it tells the next agent what this module *isn't responsible for*, which is the harder question. Without it, agents bleed scope into adjacent modules.
- "Deps" is one line, names primary collaborators only (e.g. `OrchestrationContext`, `runs`, `RunLogger`); not an exhaustive import list (TypeScript already has that).

**Cost**: ~5 minutes per module during extraction. ~12 modules × 5 min = ~60 min total.

**Alternatives considered**:
- **No file-level comment at all** (current convention in most files). Rejected: the entire point of the refactor is to make modules self-introducing.
- **Long README-style docstrings.** Rejected: rots; nobody reads them; against code-quality rules ("Comments explain why, not what; default to writing no comments").

The "Not" line is the exception that proves the rule — it explains *boundary*, which is non-obvious from the code alone.

---

## R-008 — File-size exception management

**Decision**: Maintain `docs/my-specs/011-refactoring/file-size-exceptions.md` listing the two pre-existing files that may exceed 600 LOC after the refactor (`src/core/state.ts`, `src/core/agent/ClaudeAgentRunner.ts`) with rationale per file. Wire `npm run check:size` against an explicit allow-list; the script fails loudly when an unauthorized file >600 LOC is introduced.

**Rationale**:
- Without the document, the next refactor wave can't tell "intentional exception" apart from "drift we forgot about." Two months from now a third file at 650 LOC sneaks in and the audit becomes useless.
- The script IS the enforcement mechanism. A `find … awk '$1 > 600'` audit run by hand once is a checkbox; pinned in `package.json` it's a regression test.
- Two exceptions, both with named follow-up specs (`01X-state-reconciliation`, future SDK-adapter), is small enough to memorize. Three would already be too many.

**Alternatives considered**:
- **No allow-list — all files ≤600 LOC, no exceptions.** Rejected: forces preemptive split of `state.ts` which `01X-state-reconciliation` is about to rewrite anyway. Wasteful.
- **Allow-list as a comment in the script.** Rejected: harder to find, no rationale field, no follow-up reference.
- **ESLint rule.** Rejected: heavier; one shell script does the same job.

---

## R-009 — Behaviour preservation as a hard constraint

**Decision**: This refactor is structural only. Several known correctness oddities remain intact and **must not be cleaned up** during this work:
- Synthetic `step_started` / `step_completed` pair from `emitSkippedStep` (`orchestrator.ts:1820-1833`).
- The `decision === "stopped"` → `status: "running"` mapping in `useOrchestrator.ts:553`.
- The 5-second resume heuristic in `StageList.tsx:104`.
- The single-mode `reconcileState` (no per-mode dispatch yet).

**Rationale**:
- `01X-state-reconciliation` is a separate, future spec that depends on the *current* behaviour staying intact. If this refactor cleans those up, `01X-state-reconciliation` no longer applies cleanly.
- "While we're here" cleanups are the highest-risk class of change in a behaviour-preserving refactor. They look small individually and pile up across waves until the golden-trace diff explodes at Gate 4.
- The constraint is enforceable: the golden-trace diff catches semantic emit-sequence changes, and the spec lists the exact regions that must not be touched.

**Anti-temptation note**: The spec lists these regions in `Constraints & Anti-Patterns to Respect` so any agent picking up the work has a concrete "don't touch this" checklist. Add a comment in each region pointing at this research note.

---

## R-010 — Wave PR shape and rollback policy

**Decision**: Each wave (A, C-services, B, C-rest, D) ships as its own squash-merged PR to `main`. Each PR description includes:
1. A 1-paragraph summary of what changed.
2. The exact `git revert <merge-sha>` command to undo it post-merge.
3. A smoke checklist (≤5 items) to confirm the revert restored function.

Wave-internal rollback (between sub-gates, before merge) stays branch-local on `011-refactoring` via `git reset` to the prior gate's tip.

**Rationale**:
- Five reviewable PRs are achievable; one wall-of-changes PR is not.
- Squash-merging keeps `main`'s history readable — one commit per wave, titled `phase 2/<wave>: <scope>`.
- The revert command in the PR description means a post-merge issue is one `git revert` away — no archaeology to recover the merge SHA, no debate about "what counts as the wave."
- The smoke checklist is short on purpose. Long checklists mean reverters skip them. Five items is the right ceiling.

**Alternatives considered**:
- **Rebase-merge per wave.** Rejected: scatters wave commits across `main`'s log; revert becomes per-commit instead of per-wave.
- **Merge commit per wave.** Rejected: loses the squash-summary line; PR title isn't the merge message.
- **Single mega-PR with checklist.** Rejected: every PR review tool times out on >2,000-line diffs and reviewers stop reading.

---

## Summary of resolutions

| ID | Topic | Decision |
|---|---|---|
| R-001 | Test infrastructure | Path A — vitest+jsdom (renderer) + `node:test` (core) |
| R-002 | A8-prep entry-point shape | Path α — keep slimmed `run()` |
| R-003 | Pending-question handle | On `OrchestrationContext` |
| R-004 | Golden-trace baseline | Two-run intersection, INFO\|WARN\|ERROR, stable-tokens-only |
| R-005 | Wave order | Pre-Wave → A → D-partial → C3 → B → C1+C2 → C4..C6 → C7 → D-rest |
| R-006 | Service typed errors | Discriminated-union `code` field; vocabulary enumerated up-front |
| R-007 | Orientation block | 3-line What/Not/Deps JSDoc |
| R-008 | File-size exceptions | 2 listed in `file-size-exceptions.md`; `npm run check:size` enforces |
| R-009 | Behaviour preservation | Listed regions remain unchanged; `01X-state-reconciliation` lands on top |
| R-010 | PR shape | 5 squash-merge PRs, each with explicit revert command + smoke checklist |

All `[NEEDS CLARIFICATION]` markers from the spec template were pre-resolved in spec.md's Assumptions section. None remain.
