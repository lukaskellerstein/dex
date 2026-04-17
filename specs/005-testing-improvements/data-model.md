# Phase 1 — Data Model: Fast-Path Testing via Fixture Branches

**Feature**: 005-testing-improvements
**Date**: 2026-04-17

## Overview

This feature introduces no new data schemas in Dex. It defines the **shape of a fixture** — a git-tracked snapshot of `dex-ecommerce`'s `.dex/` and `.specify/` trees plus (for `after-tasks`) its `specs/` tree — and the invariants each fixture branch must satisfy so the orchestrator's existing resume path accepts it without drift.

---

## Entity: Checkpoint

A logical name for a restore target.

| Attribute | Type | Values |
|-----------|------|--------|
| `name` | enum string | `clean`, `after-clarification`, `after-tasks` |
| `targetBranch` | string | `main` (for `clean`) or `fixture/<name>` (for fixtures) |
| `skipsStages` | ordered list | For `clean`: none. For `after-clarification`: `prerequisites, clarification_*, constitution, manifest_extraction`. For `after-tasks`: adds `gap_analysis, specify, plan, tasks`. |

Not stored anywhere — this is the vocabulary of the reset-script CLI and docs.

---

## Entity: Fixture branch

A long-lived, force-updatable git branch on `dex-ecommerce`.

| Attribute | Type | Notes |
|-----------|------|-------|
| `name` | string | Exactly `fixture/after-clarification` or `fixture/after-tasks` |
| `remote` | optional | Local only by default. May be pushed to `origin/fixture/*` for sharing, same force-update rules apply. |
| `lifecycle` | "force-update in place" | `git branch -f <name> HEAD` — never versioned (`-v2`, `-new`) |
| `capturedAt` | implicit | Tip commit's committer date |

**Cardinality invariant**: The set of matching refs `git for-each-ref refs/heads/fixture/*` MUST have size exactly 2 at rest.

---

## Fixture content — `fixture/after-clarification`

Tree contents (working-tree post-checkout):

| Path | State | Source |
|------|-------|--------|
| `GOAL.md` | present, unchanged from main | Project baseline |
| `GOAL_clarified.md` | present | Produced by `clarification_synthesis` stage |
| `docs/product/*.md` | present | Produced by `clarification_product` |
| `docs/technical/*.md` | present | Produced by `clarification_technical` |
| `.specify/memory/constitution.md` | present, populated | Produced by `constitution` stage |
| `.specify/` (bootstrap) | present | Created during `prerequisites` |
| `.dex/state.json` | present, tracked | See invariants below |
| `.dex/feature-manifest.json` | present, populated | Produced by `manifest_extraction` |
| `.dex/state.lock` | **absent** | Gitignored; MUST NOT be committed |
| `.dex/learnings.md` | may be absent | Not produced until post-implement |
| `specs/` | **absent** | No feature spec work has started yet |

`.dex/state.json` invariants on this branch:

- `state.branchName === "fixture/after-clarification"`
- `state.lastCompletedStage === "manifest_extraction"`
- `state.phase === "loop"` (clarification phase is complete)
- `state.currentSpecDir === null`
- `state.status === "paused"` (so `detectStaleState` returns `"fresh"` and does not trigger branch-mismatch rejection; paused state is always resumable per `state.ts:288`)
- `state.artifacts.clarifiedGoal`, `state.artifacts.productDomain`, `state.artifacts.technicalDomain`, `state.artifacts.constitution` all non-null, each with `sha256` matching the committed file content
- `state.artifacts.features === {}`
- `state.pendingQuestion === null`

---

## Fixture content — `fixture/after-tasks`

All of `fixture/after-clarification`'s contents, plus:

| Path | State |
|------|-------|
| `specs/001-<feature>/spec.md` | present |
| `specs/001-<feature>/plan.md` | present |
| `specs/001-<feature>/tasks.md` | present, all `- [ ]` (no progress yet) |
| `specs/001-<feature>/research.md` | present |
| `specs/001-<feature>/data-model.md` | present |
| `specs/001-<feature>/quickstart.md` | present |
| `specs/001-<feature>/contracts/` | present (may be empty-with-README for pure-internal features) |
| `specs/001-<feature>/checklists/requirements.md` | present |

`.dex/state.json` invariants on this branch:

- `state.branchName === "fixture/after-tasks"`
- `state.lastCompletedStage === "tasks"`
- `state.phase === "loop"`
- `state.currentSpecDir === "specs/001-<feature>"`
- `state.status === "paused"`
- `state.artifacts.features["specs/001-<feature>"]` present with `status: "implementing"` (per `FeatureArtifacts.status` at `state.ts:93`), `spec`, `plan`, `tasks` all non-null, `sha256` matching committed content
- `state.artifacts.features["specs/001-<feature>"].tasks.taskChecksums` all `false` (no task checked yet)
- `.dex/feature-manifest.json` has the first feature marked `active`

---

## Runtime-derived invariants (checked by `reconcileState()`)

`src/core/state.ts:435-654` walks:

1. Checkpoint SHA comparison (`state.checkpoint.sha` vs `HEAD`). Fixtures update this on capture; after-restore HEAD === `state.checkpoint.sha` → no drift.
2. Artifact existence + hash (`sha256` field per entry). Fixtures have every listed artifact present on disk with matching hash.
3. Tasks checkbox diff (`taskChecksums`). Fixtures have all `false` — no regressions, no progressions unless a tester manually hand-edits `tasks.md` post-restore.
4. Pending question. Fixtures have none.

**If any invariant is violated after restore**, `reconcileState()` records it in `driftSummary` and rewinds to the earliest affected stage — that's the documented drift-detection safety net (SC-006).

---

## Reserved namespaces

| Prefix / name | Owner | Protected from |
|---------------|-------|----------------|
| `fixture/*` | This feature | Orchestrator run-branch creation; `prune-example-branches.sh` deletion |
| `main` | Example repo base | `prune-example-branches.sh` deletion |
| `lukas/*` | Developer's personal branches | `prune-example-branches.sh` deletion |
| `dex/*` | Orchestrator run branches | (eligible for prune if committer date > 7 days) |

---

## Out of scope

- Remote fixture branches (`origin/fixture/*`). If adopted later, the force-update rule applies; no schema change.
- Mid-implement fixture (`fixture/mid-implement`). See research.md Decision 7.
- Cross-project fixture support. The scripts are pinned to `dex-ecommerce`.
