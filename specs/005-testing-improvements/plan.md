# Implementation Plan: Fast-Path Testing via Fixture Branches

**Branch**: `005-testing-improvements` | **Date**: 2026-04-17 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/005-testing-improvements/spec.md`

## Summary

Add two **bash scripts** under `dex/scripts/` — `reset-example-to.sh <clean|after-clarification|after-tasks>` and `prune-example-branches.sh` — plus a docs update to `.claude/rules/06-testing.md §4c.1`. The reset script replaces the current hand-typed three-line reset snippet with a single command that can also restore `dex-ecommerce` to one of two pre-captured `fixture/*` git branches, letting tests resume directly into `specify` or `implement` and saving 5–20 min per iteration. No source code changes in `src/core/`, `src/main/`, or `src/renderer/` — the feature rides entirely on the orchestrator's existing resume path (`config.resume=true`, `reconcileState()`, `detectStaleState`). Fixtures are captured manually from a real loop run and force-updated in place when inputs evolve.

## Technical Context

**Language/Version**: Bash (POSIX + git + jq), no TypeScript. Existing project is TypeScript 5.6+ strict but this feature adds zero TS.
**Primary Dependencies**: `bash`, `git`, `jq`. No npm dependency added. Implicitly depends on the orchestrator's existing state-reconciliation code paths (`src/core/state.ts:435-654` `reconcileState`, `src/core/state.ts:290-295` `detectStaleState`, `src/core/orchestrator.ts:1850-1945` resume entry, `src/renderer/App.tsx:297-304` / `src/renderer/components/Topbar.tsx:250` UI resume detection) as stable unchanged contracts.
**Storage**: Git fixture branches on `dex-ecommerce` (two total, long-lived, force-updatable): `fixture/after-clarification`, `fixture/after-tasks`. No new on-disk Dex state. `.dex/` and `.specify/` inside the example repo are committed into each fixture branch.
**Testing**: Manual end-to-end verification per `.claude/rules/06-testing.md §4c` against the live `dex-ecommerce` example, plus bash-level unit checks (`bash -n`, known-good / known-bad argument dispatch). See `quickstart.md` for the full verification matrix.
**Target Platform**: Local developer machine (Linux) at the pinned path `/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce`. No portability target in v1.
**Project Type**: Tooling / test infrastructure addition. Two shell scripts + one docs section — no source tree changes.
**Performance Goals**: Reset-to-implement-ready in under 60 s (SC-001), down from 15–20 min baseline. Prune script run time negligible (<5 s typical).
**Constraints**: (a) Zero source-code changes in `src/core/`, `src/main/`, `src/renderer/` — feature must be additive only (FR-015); (b) Destructive scope is strictly `dex-ecommerce` (FR-007); (c) `fixture/*` branch namespace reserved and limited to exactly two branches at all times (FR-010, FR-011); (d) Clean-reset path must stay byte-for-byte equivalent to today's reset snippet (FR-002, SC-003); (e) Fixtures must pass `reconcileState()` hash checks without drift (SC-004); (f) No new npm/TS dependency, no orchestrator schema change.
**Scale/Scope**: 2 new bash scripts (≈60 and ≈25 lines), 1 docs section rewritten (~40 lines). No source modifications. 1-time manual fixture capture per developer machine.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Clean-Context Orchestration | **PASS** | No change to agent spawning, hook callbacks, or stage sequencing. Orchestrator resume path is existing behavior; fixtures just pre-populate the filesystem state it already reads. |
| II. Platform-Agnostic Core | **PASS** | No `src/core/` modifications. Bash scripts live in `dex/scripts/` alongside the repo, not in core. |
| III. Test Before Report | **PASS** | Verification matrix in `quickstart.md` covers clean path (non-regression), both fixtures (resume stages), drift detection (deleted `plan.md` → rewind), argument errors, and fixture branch hygiene count. |
| IV. Simplicity First | **PASS** | Two scripts, no abstractions. Reset script is a single `case` dispatch. Prune script is one `git for-each-ref` pipeline. No flags, no config files, no tooling around tooling. |
| V. Mandatory Workflow | **PASS** | Spec → Plan (this doc) → Implement → Test → Report. Each step gated in the workflow rules. |

Constitution Technology Constraints clause "Scripts: TypeScript/Node.js by default; shell scripts only for trivial one-liners" is honored because:

- The scripts *are* trivial — a `case` dispatch on a checkpoint name plus a `for-each-ref` filter. Writing them in Node.js would add a `node` invocation, a `tsx` or compile step, and an `import child_process` just to shell out to `git` anyway.
- There is no shared code to reuse from the TS codebase; the logic is pure git plumbing.
- This mirrors the existing convention for `.specify/extensions/git/scripts/bash/*` in this repo.

**No violations.** Complexity Tracking section omitted.

### Re-evaluation after Phase 1 design

Phase 1 artefacts (`data-model.md`, `quickstart.md`, `contracts/README.md`) document existing contracts (the fixture branch schema, the CLI interface of the two scripts) — they add no new machinery. Gates remain PASS.

## Project Structure

### Documentation (this feature)

```text
specs/005-testing-improvements/
├── plan.md                    # This file (/speckit.plan output)
├── spec.md                    # Feature specification
├── research.md                # Phase 0 output — decisions + rejected alternatives
├── data-model.md              # Phase 1 output — fixture branch schema + state.json invariants
├── quickstart.md              # Phase 1 output — fixture capture + verification walkthrough
├── contracts/                 # Phase 1 output
│   └── README.md              # CLI contracts for reset + prune scripts
├── checklists/
│   └── requirements.md        # Spec quality checklist (from /speckit.specify)
└── tasks.md                   # Phase 2 — created by /speckit.tasks (NOT this command)
```

### Source Code (repository root)

This feature adds only two scripts and edits one docs file. No source tree changes.

```text
dex/
├── scripts/                              # NEW directory (does not exist today)
│   ├── reset-example-to.sh               # NEW — clean|after-clarification|after-tasks dispatch
│   └── prune-example-branches.sh         # NEW — delete dex/* branches older than 7 days
├── .claude/
│   └── rules/
│       └── 06-testing.md                 # MODIFIED — §4c.1 rewritten to introduce reset script
│                                         #   and document fixture branches + refresh workflow
├── src/                                  # UNCHANGED — zero modifications
│   ├── core/                             #   (resume path at state.ts:435-654, state.ts:290-295,
│   ├── main/                             #    orchestrator.ts:1850-1945, App.tsx:297-304,
│   └── renderer/                         #    Topbar.tsx:250 relied on as stable contracts)
└── …                                     # Everything else unchanged
```

Changes on the **target** repository (`dex-ecommerce`, not this repo):

```text
/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce/
└── (two new long-lived local branches, force-updatable)
    ├── fixture/after-clarification       # NEW — post-manifest_extraction snapshot
    └── fixture/after-tasks               # NEW — post-tasks snapshot (first feature)
```

**Structure Decision**: Scripts go under `dex/scripts/` because they are project-level developer tooling, distinct from the existing `.specify/extensions/git/scripts/bash/` which are spec-kit hook scripts with their own ownership. A new top-level `scripts/` directory is the least-surprising location and matches how most Node/TS projects organize ad-hoc automation. The new directory contains only these two files; we do not preemptively create a `lib/`, `util/`, or similar sub-tree.

## Phase 0 — Research

See [research.md](./research.md). Summary:

- **Decision**: Use `git branch -f <fixture>` (in-place force move) for refresh instead of versioned branch names. Rationale: fixed-size set, no accumulation, no surprise references in tooling that globs branch names.
- **Decision**: Use a `case` statement over subcommands. With exactly three checkpoint values and no shared flags, `reset-example-to.sh <checkpoint>` is the simplest surface.
- **Decision**: Sanity check `jq -e '.branchName == $b' .dex/state.json` after fixture checkout. Catches fixture drift (committed `state.json` disagreeing with branch name) before Dex sees it and before `detectStaleState` would reject the resume silently.
- **Decision**: Prune by committer date via `git for-each-ref --format='%(refname:short) %(committerdate:unix)' refs/heads/dex/*` piped through an `awk` threshold comparison, not `git branch --sort`. Committer date is stable; shell-side threshold keeps the script portable.
- **Decision**: Keep destructive authorization pinned inside the script (hardcoded `TARGET` constant, not `$1` or `$PWD`). The script inherits the exact authorization scope of the existing reset snippet in `06-testing.md`; no new trust surface.
- **Decision**: Manual fixture capture (pause loop at `manifest_extraction` / `tasks` → `git add -A` + `git commit` + `git branch -f`) is superior to an automated capture hook. The orchestrator already supports Pause, which persists `state.json` atomically; reusing that path is zero work and zero risk of capturing an inconsistent snapshot.
- **Rejected**: A generator script that synthesizes fixtures without running the loop. Would require faking `reconcileState()` hashes, which means computing SHA-256 over artifacts that the orchestrator would write — effectively re-implementing the orchestrator. Brittle and duplicates business logic.
- **Rejected**: Branching from a zipped snapshot rather than a git branch. Forfeits `git diff` introspection and loses the free sanity check that `detectStaleState` already provides via `state.branchName`.
- **Rejected**: A third `fixture/mid-implement` snapshot. `taskChecksums` is derived from live `tasks.md`, which `fixture/after-tasks` already captures; if a test needs partial progress, hand-ticking a few boxes in `tasks.md` after restoring `after-tasks` is cheaper than maintaining another branch.
- **Rejected**: Automating `prune-example-branches.sh` via hook or cron. Branch deletion is rare (weekly at most); automation adds footguns (deleting a branch a developer was actively iterating on) for marginal benefit.

All `NEEDS CLARIFICATION` markers from the spec are resolved (there were none — the spec was fully specified).

## Phase 1 — Design

See [data-model.md](./data-model.md), [quickstart.md](./quickstart.md), and [contracts/README.md](./contracts/README.md).

**Entities**:

- **Checkpoint** (enum): `clean | after-clarification | after-tasks`. Maps 1:1 to either the `main` branch or a `fixture/<name>` branch.
- **Fixture branch**: git branch on `dex-ecommerce`. Tree captures `.dex/state.json` (with `branchName` field equal to the branch itself), `.dex/feature-manifest.json`, `GOAL_clarified.md`, product/technical domain docs, `.specify/memory/constitution.md`, and (for `after-tasks`) a `specs/<feature>/` directory.
- **Script CLI**: two bash scripts with the signatures documented in `contracts/README.md`.

**State transitions**:

The reset script transitions the `dex-ecommerce` working tree across three states; the orchestrator then owns all subsequent transitions once `Resume` is clicked.

```text
(any)  --reset clean-------------------->  workspace: main, clean, no .dex/
(any)  --reset after-clarification------>  workspace: fixture/after-clarification, state: manifest_extraction
(any)  --reset after-tasks-------------->  workspace: fixture/after-tasks, state: tasks, currentSpecDir set
```

**Contracts**:

No external API contracts (this is internal developer tooling). The CLI contracts for both scripts are documented in `contracts/README.md` as the unit of review/testing.

**Agent context update**:

Ran `.specify/scripts/bash/update-agent-context.sh claude` (see Phase 1 step below).

## Complexity Tracking

> Not applicable — Constitution Check passed without violations.
