# Phase 0 — Research: Fast-Path Testing via Fixture Branches

**Feature**: 005-testing-improvements
**Date**: 2026-04-17
**Status**: Complete — no unresolved `NEEDS CLARIFICATION`

## Scope

The source spec is prescriptive about the mechanism (git fixture branches + a restore script) but leaves a handful of implementation choices open. This document records those choices, the rationale, and the alternatives that were rejected.

---

## Decision 1 — Script location: `dex/scripts/`

**Decision**: Place both scripts under a new top-level `dex/scripts/` directory.

**Rationale**:

- `.specify/extensions/git/scripts/bash/` is owned by spec-kit (commands: `speckit.git.initialize`, `speckit.git.feature`, etc.). Putting test-infrastructure scripts there conflates ownership.
- `.claude/` is reserved for agent rules and claude-code configuration.
- No existing location for developer-facing shell scripts. A fresh top-level `scripts/` matches common Node/TS project convention and won't surprise a contributor.

**Alternatives considered**:

- `tools/` — equally valid; rejected only because `scripts/` is more idiomatic for "bash stuff a human runs directly."
- `.specify/extensions/custom/` — would couple test scripts to the spec-kit extension lifecycle, which is wrong (these scripts are not extensions).
- Project root (`dex/reset-example-to.sh`) — clutters the top-level listing.

---

## Decision 2 — CLI surface: positional argument over flags

**Decision**: `reset-example-to.sh <clean|after-clarification|after-tasks>` (positional); `prune-example-branches.sh` (no arguments).

**Rationale**:

- Three total checkpoint values, no modifier flags, no composability — `case "$1"` is the most direct expression.
- Matches the README's sketched usage line verbatim.
- Positional keeps the muscle memory short (`./dex/scripts/reset-example-to.sh after-tasks`).

**Alternatives considered**:

- Subcommands (`reset-example-to clean`, `reset-example-to fixture after-tasks`) — more typing, no added expressiveness.
- `--checkpoint=<name>` long flag — verbose for three values; scripts with zero other options don't benefit from named flags.

---

## Decision 3 — Drift sanity check at the end of reset

**Decision**: After `git checkout -B <fixture> <fixture>`, run `jq -e --arg b "$BRANCH" '.branchName == $b' .dex/state.json` and bail on mismatch.

**Rationale**:

- `detectStaleState` at `src/core/state.ts:290-295` rejects a resume when `state.branchName !== currentBranch`. A fixture whose committed `state.json` has the wrong `branchName` field (e.g., captured from the wrong HEAD during refresh) would silently fall through the orchestrator's "stale — start fresh" path and wipe the fixture state from the user's perspective.
- Catching the mismatch in the reset script turns a silent wipe into a loud exit.
- `jq` is already a universal bash tool; no new dependency. It is available on all Linux dev setups we target.

**Alternatives considered**:

- No sanity check — would pass the reset but fail the resume silently. Bad UX.
- Parse `state.json` with `grep "branchName"` — fragile, fails on formatting changes.
- Bake the check into the Dex app — adds source code for a developer-tooling concern; violates FR-015 (no src changes).

---

## Decision 4 — Prune threshold implementation

**Decision**: `git for-each-ref --format='%(refname:short) %(committerdate:unix)' refs/heads/dex/*` piped through `awk` comparing against `$(date +%s) - 604800` (seconds in 7 days). Deletes each qualifying ref via `git branch -D`.

**Rationale**:

- `git for-each-ref` gives stable, machine-readable output; avoids parsing `git branch` human output.
- Committer date is the right signal — author date can be rewritten, reflog is ephemeral, but committer date reflects when the branch last saw activity.
- `604800` is computed once at script start and compared numerically in awk — no date math per-branch.
- `git branch -D` (force delete) is correct here because the branches are orphan run branches from autonomous runs — they may contain un-merged commits that are meaningless (the run failed or was superseded). `git branch -d` would refuse.

**Alternatives considered**:

- `git branch --sort=committerdate` + head/tail — possible but requires counting; harder to read.
- `find .git/refs/heads/dex -mtime +7` — relies on filesystem mtime, which may not match committer date after packed-refs operations.
- Keep the threshold configurable — YAGNI; 7 days is fine and can be changed in the script if needed.

---

## Decision 5 — Hardcoded `TARGET` path, no argument for it

**Decision**: `TARGET=/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce` is hardcoded inside `reset-example-to.sh` and `prune-example-branches.sh`. No way to override via CLI.

**Rationale**:

- The destructive authorization in `.claude/rules/06-testing.md` is scoped to this exact path. Taking a path argument widens the authorization surface and invites `reset-example-to.sh . clean` style misuse.
- Only one developer / one machine today. If that changes, a future spec can add override via env var with a whitelist; not needed now.
- The scripts refusing to run elsewhere is a feature, not a limitation.

**Alternatives considered**:

- `cd "${DEX_EXAMPLE:-/home/lukas/...}"` — lets a second developer repoint. Defer until there's a second developer.
- Read from `.specify/init-options.json` — overkill for a constant.

---

## Decision 6 — Manual fixture capture, no generator

**Decision**: Fixtures are created/refreshed by running the loop for real, pausing at the right `stage_completed` event, and committing the resulting workspace. There is no synthetic generator.

**Rationale**:

- A synthetic generator would have to re-implement `manifest_extraction` and `tasks` output formats, including the SHA-256 hashes `reconcileState()` verifies. That reconstructs the orchestrator's output format in two places — exactly the drift risk we want to avoid.
- The orchestrator already supports Pause, which persists `state.json` atomically via its fsync-rename write path. Reusing Pause means the fixture is always in a state the orchestrator itself produced — by construction valid.
- Refresh frequency is low (when `GOAL.md`, constitution template, or spec templates change). Cost of manually capturing is a one-time 15-minute run, amortized over many test cycles.

**Alternatives considered**:

- Synthetic generator in Node.js — 200+ lines, duplicates orchestrator logic, must be updated whenever the state schema changes.
- Snapshot via `tar`/zip rather than a git branch — loses `git diff` introspection and the free `state.branchName` sanity check.
- Committing fixtures to this repo's `fixtures/` directory — mixes example-repo state into the Dex repo; cross-repo coupling is a smell.

---

## Decision 7 — Rejected: third `fixture/mid-implement` branch

**Decision**: Only two fixtures. Explicitly out of scope.

**Rationale**:

- `state.artifacts.features[X].tasks.taskChecksums` reflects the boolean state of each checkbox in `tasks.md`. The hash verification in `reconcileState()` hashes `tasks.md` itself, so any mid-implement state is a function of what's committed in `tasks.md`.
- To produce partial progress from `fixture/after-tasks`, a tester edits a few `- [ ]` to `- [x]` in `tasks.md` before clicking Resume; `reconcileState()` picks up the progressions via `driftSummary.taskProgressions`.
- Maintaining a third fixture for every possible implement-progress ratio (0%, 25%, 50%, ...) is combinatorial and a maintenance tax.

---

## Decision 8 — Rejected: automating prune via hook / cron

**Decision**: Prune is manual, invoked only when the developer runs the script.

**Rationale**:

- Deleting a branch a developer is actively iterating on (but hasn't pushed in 7+ days) is a data-loss event. The blast radius of a false positive dwarfs the cost of running `./dex/scripts/prune-example-branches.sh` manually once per month.
- Branch list bloat is a papercut, not a recurring pain — it surfaces in `git branch` output, not in any critical path.
- If the volume grows enough to need automation, a future spec can revisit with a dry-run + confirmation flow.

---

## Open questions

None. All spec clarifications are resolved.
