# Implementation Plan: Branch Namespace + Record-mode Cleanup

**Branch**: `013-cleanup-2` | **Date**: 2026-05-02 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification at `/specs/013-cleanup-2/spec.md`
**Companion**: [`docs/my-specs/013-cleanup-2/README.md`](../../docs/my-specs/013-cleanup-2/README.md) — file-level execution detail (file map, line-numbered edits, deletion order, pre-flight greps).

## Summary

Delete two pieces of vestigial machinery in the timeline / checkpoints layer: (1) **Record mode** — the developer-only `recordMode` flag plus `capture/<date>-<runId>` branches, `checkpoint/done-<slice>` tags, the auto-promote-during-run behaviour, and the REC topbar badge, and (2) the **`attempt-*` branch family** — replace the only remaining producer (the dirty-tree-save flow inside `jumpTo`) with a normal commit on the current branch. Relocate `syncStateFromHead` from `recordMode.ts` into its own module so the file deletion is clean. End-state: the running app produces exactly two branch families (`dex/*` plus `selected-*`) and zero auto-created tags. Single user-visible UX change: the Go-Back confirm dialog's **Save** button label simplifies from "Save on a new branch" to "Save", and the body copy stops referencing internal branch names.

The companion README already pins every symbol-level edit, deletion order, and pre-flight grep; this plan deliberately does not duplicate that detail. The plan focuses on: gates, design contracts that other code in the repo depends on, and a concrete verification sequence.

## Technical Context

**Language/Version**: TypeScript 5.6+ (strict mode), Node.js bundled with Electron 41 (Node 20 runtime)
**Primary Dependencies**: Unchanged. `@anthropic-ai/claude-agent-sdk` ^0.1.45, `electron` ^41.2.1, `react` ^18.3.1, `gsap` ^3.12.5, `lucide-react` ^0.460.0, `d3-shape`, `d3-zoom`. Dev: `vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom` (already present). **No dependencies added or removed by this spec.**
**Storage**: Per-project filesystem only — `<projectDir>/.dex/state.json`, `<projectDir>/.dex/feature-manifest.json`, `<projectDir>/.dex/learnings.md`, `<projectDir>/.dex/runs/<runId>.json`. Per-run logs at `~/.dex/logs/<project>/<runId>/`. No schema change.
**Testing**: `vitest` for unit tests, `npx tsc --noEmit` for type-checks, `npm run lint` for lint, `electron-chrome` MCP (CDP port 9333) for UI verification against the `dex-ecommerce` example project.
**Target Platform**: Linux + macOS Electron desktop application.
**Project Type**: Desktop application (Electron main + React renderer + platform-agnostic core).
**Performance Goals**: Unchanged. The cleanup only deletes code; it does not introduce any new runtime work.
**Constraints**: Every numbered step in the implementation order from the README MUST end with `npx tsc --noEmit` + `npm test` + `npm run lint` green. The `events.ts` discriminant deletion is gated on both `checkpoint_promoted` producers being gone (sequencing matters — see spec FR-013 / README step 7b). The `syncStateFromHead` relocation MUST land before any `recordMode.ts` deletion.
**Scale/Scope**: ≈ 22 files in `src/` modified, 1 script modified, 2 files deleted (`recordMode.ts`, `RecBadge.tsx`), 1 file created (`syncState.ts`). Net file count decreases by 1 in `src/`. No public-API rename — the only deferred rename (`step_candidate.attemptBranch`) is explicitly out of scope and marked with a `TODO(post-013)` comment.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Verdict | Notes |
|---|---|---|
| **I. Clean-Context Orchestration** | ✅ N/A | The cleanup does not touch agent spawning, `query()` calls, or hook callbacks. No agent context boundary is altered. |
| **II. Platform-Agnostic Core** | ✅ Pass | The new `src/core/checkpoints/syncState.ts` lives entirely under `src/core/`. Its dependencies are `_helpers` (`gitExec`, `log`), `../state.js`, `../types.js` — no Electron, main-process, or renderer imports. The relocation strictly preserves the boundary. |
| **III. Test Before Report (NON-NEGOTIABLE)** | ✅ Pass | DoD in spec (SC-007, plus README §12 final sweep) requires `tsc` + `vitest` + `lint` green at the head AND at each numbered implementation step. UI-touching changes (Go-Back dialog, REC badge removal) are explicitly verified via `electron-chrome` MCP per the spec's User Stories 1 and 4. |
| **IV. Simplicity First** | ✅ Pass | This spec **is** a simplicity push: net deletion of code, two whole subsystems removed, one branch family eliminated, one event-discriminant retired. No new abstractions are introduced. The single new file (`syncState.ts`) is a relocation, not new code. No backwards-compatibility shims (FR-011 explicitly: pre-existing `state.json.ui.recordMode` is silently ignored, no migration). |
| **V. Mandatory Workflow** | ✅ Pass | Understand step covered by README pre-flight greps and the [Why this is safe](../../docs/my-specs/013-cleanup-2/README.md#why-this-is-safe) section. Plan step is this document plus the companion README. Implement / Test / Report follow normally. |

**Constitution gate: PASS.** No violations, no exceptions, no Complexity Tracking entries needed.

## Project Structure

### Documentation (this feature)

```text
specs/013-cleanup-2/
├── plan.md              # This file (Phase 0/1 artifacts inline + linked)
├── research.md          # Phase 0 — open questions resolved (very short)
├── data-model.md        # Phase 1 — TimelineSnapshot shape change, branch/tag namespaces, module relocation
├── quickstart.md        # Phase 1 — engineer's "how to verify the cleanup landed" walkthrough
├── contracts/
│   ├── timeline-snapshot.md      # Shape of TimelineSnapshot before/after
│   └── orchestrator-events.md    # Orchestrator-event union before/after (with the checkpoint_promoted removal)
├── checklists/
│   └── requirements.md  # (created in /speckit.specify)
└── tasks.md             # Phase 2 — created by /speckit.tasks (NOT this command)
```

### Source Code (touched paths only — no new tree)

The repo structure is unchanged. The cleanup touches existing files in three layers and adds exactly one new file. Concrete file map and line-numbered edits live in the companion README; this section names only the directories so reviewers know where to look.

```text
src/
├── core/
│   ├── orchestrator.ts             # Modified — Record-mode termination block deleted, imports trimmed
│   ├── events.ts                   # Modified — checkpoint_promoted discriminant deleted (after both producers go)
│   ├── state.ts                    # Modified — recordMode field removed from DexUiPrefs interface
│   ├── stages/
│   │   └── finalize.ts             # Modified — autoPromoteIfRecordMode call + import deleted
│   └── checkpoints/
│       ├── recordMode.ts           # DELETED entire file
│       ├── syncState.ts            # NEW — syncStateFromHead moved here verbatim
│       ├── index.ts                # Modified — flat re-exports + namespace object cleaned up
│       ├── tags.ts                 # Modified — checkpointDoneTag, captureBranchName, attemptBranchName deleted
│       ├── timeline.ts             # Modified — capture/* + attempt-* query blocks deleted, snapshot shape reduced
│       └── jumpTo.ts               # Modified — dirty-tree-save body rewritten, attempt-* references removed
├── main/
│   └── ipc/
│       └── checkpoints.ts          # Modified — syncStateFromHead import path, error-fallback shape reduced
└── renderer/
    ├── electron.d.ts               # Modified — TimelineSnapshot typing reduced
    ├── App.tsx                     # Modified — checkpoint_promoted handler deleted, deferred-rename comment added
    ├── services/
    │   └── checkpointService.ts    # Modified — file-header doc updated
    └── components/
        ├── checkpoints/
        │   ├── RecBadge.tsx        # DELETED entire file
        │   ├── GoBackConfirm.tsx   # Modified — button label, body copy, JSDoc all branch-free
        │   └── hooks/
        │       └── useTimeline.ts  # Modified — EMPTY constant reduced, checkpoint_promoted case deleted
        └── layout/
            └── Topbar.tsx          # Modified — RecBadge import + render + polling block deleted

src/core/__tests__/                 # Modified — see README test rows (jumpTo/finalize/checkpoints/timelineLayout)
src/renderer/services/__tests__/    # Modified — EMPTY fixture reduced

scripts/
└── prune-example-branches.sh      # Modified — attempt-* glob deleted, dex/* glob preserved
```

**Structure Decision**: No structural change. Layers (`core/` / `main/` / `renderer/`) and the platform-agnostic-core boundary are preserved. The single new file (`syncState.ts`) lives inside `src/core/checkpoints/` adjacent to the file it splits from.

## Phase 0 — Research

See [research.md](./research.md). One-sentence summary: **all open questions are pinned by the companion README and the Why-This-Is-Safe pre-flight greps; no clarifications outstanding.**

## Phase 1 — Design & Contracts

Three artifacts:

1. [data-model.md](./data-model.md) — the data structures changed by this spec: `TimelineSnapshot` shape reduction, branch/tag namespaces (post-cleanup canonical lists), the `syncStateFromHead` module relocation, the orchestrator-event union shrinkage.
2. [contracts/](./contracts/) — internal contracts that downstream code in the repo depends on:
   - [`timeline-snapshot.md`](./contracts/timeline-snapshot.md) — the before/after shape of `TimelineSnapshot` (the data structure flowing across the IPC boundary into `useTimeline`).
   - [`orchestrator-events.md`](./contracts/orchestrator-events.md) — the orchestrator-event discriminated union, with `checkpoint_promoted` removed.
3. [quickstart.md](./quickstart.md) — engineer-facing walkthrough: pre-flight greps → implement in the order from README §11 → run the DoD verification → end state.

This feature does not expose any external interface (no public API, no CLI grammar, no over-the-wire schema). The contracts above are *internal* contracts only — they're documented because IPC, renderer, and tests all depend on them, and the cleanup changes their shape.

### Constitution re-check (post-design)

The artifacts in this phase introduce no new code paths, no new abstractions, no new dependencies. The boundary preservation noted under Principle II (no Electron imports in `src/core/`) is reinforced by the `syncState.ts` file header (described in `data-model.md`). The post-design constitution check is identical to the pre-design check: **PASS**.

### Agent context update

`update-agent-context.sh claude` is run at the end of Phase 1 to keep `CLAUDE.md` in sync with active technologies and recent changes (the script preserves manual additions between markers — see Phase 1 step 3 in the skill outline).

## Complexity Tracking

*N/A — Constitution Check passes without violations.*
