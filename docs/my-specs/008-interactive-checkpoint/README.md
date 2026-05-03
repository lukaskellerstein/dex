# 008 Interactive Checkpoint — Branch, Version, and Retry Without Git

> **Status:** The "Keep this", "Unmark kept", "Try N ways from here", and Step Candidate prompt sections of this spec are superseded by `012-cleanup`. Record Mode auto-promote, the `attempt-*` branch family, `capture/*` branches, `checkpoint/done-*` tags, and the REC badge are superseded by `013-cleanup-2`. Go-Back and Jump-to-Checkpoint remain authoritative; the dirty-tree-save flow now commits on the current branch (no side branch) per 013-cleanup-2.

## Why this exists

Dex runs projects as a pipeline of discrete stages: `gap_analysis → specify → plan → tasks → implement → verify → learnings`, plus pre-cycle stages (`prerequisites`, `clarification_*`, `constitution`, `manifest_extraction`). Every stage produces inspectable output.

Today that pipeline is one-shot. If the user dislikes stage 4's output, there's no first-class way to retry just that stage, compare alternatives, or jump back to an earlier decision point — short of dropping into a terminal and using git. Most Dex users won't.

**What this feature provides**: a time-travel tree over the pipeline. Every completed stage creates a **checkpoint**. Users can go back to any past checkpoint, run that stage (or later stages) again as a new **attempt**, compare attempts, fan out into N parallel **variants**, and keep the ones they want. Git underneath; invisible to the user.

This is a **product pillar**, not a testing utility — it differentiates Dex from free-form AI coding tools (Cursor, Claude Code, Aider, Cline, Windsurf) because they have no pipeline structure to checkpoint against. Dex's structure is the moat.

## Prerequisite

`specs/007-sqlite-removal` ships first. The run/phase JSON files from 007 are the natural place to record candidate SHAs, checkpoint tags, attempt branch, parent run, and variant group — all fields the checkpoint feature populates. Building on SQLite would mean a dual-write migration that 007 eliminates.

## The user's mental model

Four user-facing verbs. That's the entire interaction surface:

- **Go back** to a past checkpoint.
- **Try again** — run the current stage (or later stages) differently.
- **Try N ways** — fork N parallel variants of the next stage, compare, pick one.
- **Keep this** — accept the current attempt (or a variant) as the new canonical state for that stage.

Plus one zero-interaction default: **just run it**. Checkpoints get created invisibly. Users can ignore the whole system until they need it.

## Three operating modes

### 1. Default (invisible autosave)

Start the loop, let it run. Every completed stage silently creates (or updates) a checkpoint. Timeline panel populates but isn't forced into view. When the run finishes, the user has a full tree they can explore — or never open it, and nothing changes.

### 2. Step mode (inspect each stage)

User toggles "Pause after each stage". Orchestrator runs one stage, auto-pauses. Summary panel shows output. User picks **Keep this** / **Try again** / **Try N ways**.

### 3. Record mode (canonical snapshot)

User toggles "Record" (REC badge in topbar). Every stage auto-keeps its attempt as a checkpoint AND moves the canonical timeline anchor forward. Useful for reference baselines — team sharing, CI snapshots, `dex-ecommerce` refresh.

Opt-in; default off. `DEX_RECORD_MODE=1` env var forces on for scripting.

## The Timeline panel — git-flow visualization

Horizontal lanes matching standard git-flow layout. Canonical timeline at the top, attempt lanes below, variant lanes below those. Checkpoint labels float above nodes as tags. Visual vocabulary matches what engineers already recognize from GitLab / Bitbucket / SourceTree diagrams.

### Layout

- **Top lane (blue)** — canonical timeline (`capture/<date>-<runId>` branch). Official checkpoint sequence.
- **Middle lane(s) (purple)** — active and recent attempt branches. One lane per attempt.
- **Bottom lane(s) (green)** — variant branches when a fan-out is active.
- **Tags above nodes** — checkpoint labels in plain language ("after plan", "cycle 2 · cart · after tasks").
- **Alternating node shades per cycle** — within a feature, odd and even cycles get slightly different backgrounds so cycle boundaries are visible at a glance.

### Interaction

- **Click a node** — right-side detail panel opens: stage summary + action buttons (Go back / Try again / Try N ways / Keep this).
- **Hover** — tooltip: stage name, cost, duration.
- **Variant fan-out** — Try N ways sprouts N short branches off the node; after all variants finish, detail panel switches to N-pane comparison with per-variant Keep this.
- **Auto-focus** — graph scrolls to keep the newest node visible.
- **Past attempts list** — collapsible searchable list below the graph; useful when the graph is crowded.

### Rendering

Custom **D3 + SVG** adapter rendered by React. Vertical orientation (canonical trunk top-to-bottom, attempts/variants branching to the right), curved elbow edges.

- **React owns the DOM** — nodes and edges are React SVG components. Click/hover handlers are plain React props; no library escape hatches for context menus, tooltips, or selection styling.
- **d3 owns what it's best at** — `d3-zoom` for pan/zoom gestures, `d3-shape` (`linkVertical`) for curved edges. Layout itself is a pure TypeScript function (deterministic lane assignment from the commit DAG — canonical = lane 0, attempts take the next free lane, variant groups occupy adjacent lanes).
- **Why custom, not a library** — `@gitgraph/react` is archived. React Flow's MIT core is capable but the Pro-upgrade pull is a long-term risk for a pillar feature. Mermaid's `gitGraph` directive is string-based and lacks rich click/hover handlers. D3 gives full control at ~400 LOC.

Dependencies added: `d3-zoom`, `d3-selection`, `d3-shape` (~12 kB gz total).

## Per-stage summaries

When a stage completes (step mode) or the user clicks a past checkpoint, a summary panel shows the minimum the user needs to Keep or Try again:

| Stage | Summary content |
|---|---|
| `prerequisites` | Environment checked, git initialized, tools available. |
| `clarification_product` | Questions + answers. |
| `clarification_technical` | Questions + answers. |
| `clarification_synthesis` | Synthesized requirements + constraints. |
| `constitution` | N principles drafted: titles. |
| `manifest_extraction` | N features identified: `{id, name}` list. |
| `gap_analysis` | Decision (`NEXT_FEATURE` / `REPLAN_FEATURE` / `RESUME_FEATURE` / `GAPS_COMPLETE`) + rationale. |
| `specify` | Spec at `specs/NNN-foo/spec.md`, key requirements. |
| `plan` | N phases, M total tasks, tech stack. |
| `tasks` | N tasks across P phases. |
| `implement` | Phase N completed: title. Files F, commits C. |
| `implement_fix` | Issues fixed: count + description. |
| `verify` | PASS / FAIL + checks summary. |
| `learnings` | N entries added to `learnings.md`. |

Data sources: structured output from 003, commit messages, log files, `.dex/runs/<runId>.json` from 007. No new instrumentation.

## Variants — "Try N ways"

Fork from any checkpoint into N parallel attempts of the next stage; compare; pick one.

### Execution model — parallel for spec stages, sequential for implement

**Parallel via `git worktree`** (default for stages that only write to `specs/` and `.dex/`):

- `gap_analysis`, `specify`, `plan`, `tasks`, `learnings` — spec-only side effects. No compiled state.
- Implementation: `spawnVariants` runs `git worktree add <projectDir>/.dex/worktrees/<variant-branch> <checkpoint-tag>` per variant, spawns N orchestrator instances concurrently rooted at their own worktree paths.
- Wall time: **T** (one variant's duration) instead of `N × T`. This is what makes variants a headline feature rather than a curiosity — a 5-minute `plan` stage with 3 variants takes 5 minutes, not 15.

**Sequential** (for stages with shared build/compile side effects):

- `implement`, `implement_fix`, `verify` — these run tests, compile, install deps. Parallel worktrees would conflict on `node_modules`, build artifacts, port bindings.
- Implementation: orchestrator iterates variant branches one at a time on the main working directory.

Stage-type gating lives in `src/core/checkpoints.ts` as a single `isParallelizable(stage)` predicate so future stages can opt in/out by name.

### UX flow

- User clicks **Try N ways** on a checkpoint (default N=3, configurable 2–5).
- Cost estimate modal: "Estimated $X ± Y per variant (median of last 5 successful runs of this stage × N)." Median + p75, not mean — early-cycle costs are cheap, late-cycle costs grow.
- User confirms; orchestrator spawns variants.
- When all variants complete, `VariantCompareModal` opens with N panes. Each pane: stage summary + stage-aware diff against baseline checkpoint + Keep this button.
- **Keep this on variant B** → `checkpoint/…` tag moves to B; other variants stay as branches (rejected, prunable).
- **Discard all** → archives all; user can spawn a new round.

### Resume-mid-variant

A variant group's orchestration state persists so pause/quit/crash recovers cleanly.

When variants are spawned, write `<projectDir>/.dex/variant-groups/<group-id>.json`:

```json
{
  "groupId": "uuid",
  "fromCheckpoint": "checkpoint/cycle-1-after-plan",
  "stage": "plan",
  "parallel": true,
  "variants": [
    { "letter": "a", "branch": "attempt-…-a", "worktree": ".dex/worktrees/…-a",
      "status": "running", "runId": "…" },
    { "letter": "b", "branch": "attempt-…-b", "worktree": ".dex/worktrees/…-b",
      "status": "pending", "runId": null },
    { "letter": "c", "branch": "attempt-…-c", "worktree": ".dex/worktrees/…-c",
      "status": "pending", "runId": null }
  ]
}
```

On app restart: if any file in `.dex/variant-groups/` has pending/running variants, the resume flow offers "Continue variant group" → orchestrator picks up from the next pending variant (sequential mode) or restarts variants whose processes died (parallel mode). Group file is deleted once resolved (Keep or Discard).

### Cleanup

- **Keep this**: other variants' worktrees removed (`git worktree remove`), branches kept 30 days then pruned.
- **Discard all**: all worktrees removed, branches kept 30 days.
- **Crashed variant**: worktree removed; branch status set to `failed`; group JSON preserved for diagnosis.

## Compare attempts — stage-aware

For any two branches, Compare opens a diff whose path filter depends on the stage being compared:

| Variant stage | Diff command |
|---|---|
| `gap_analysis`, `manifest_extraction` | `git diff A..B -- .dex/feature-manifest.json` |
| `specify`, `plan`, `tasks` | `git diff A..B -- specs/` |
| `implement`, `implement_fix` | `git diff --stat A..B` (code stat; detail on demand) |
| `verify` | `git diff A..B -- .dex/verify-output/` (or equivalent; depends on 006 verify output location) |
| `learnings` | `git diff A..B -- .dex/learnings.md` |

IPC: `checkpoints:compareAttempts(projectDir, branchA, branchB, stage)` — stage is explicit, not hard-coded.

## Terminology mapping

| User sees | Internal concept | Git ref |
|---|---|---|
| Checkpoint | Named save point | `checkpoint/<name>` (annotated tag) |
| Attempt | Timeline scratch branch | `attempt-<timestamp>` (branch) |
| Variant | Attempt with shared fan-out origin | `attempt-<ts>-<letter>` (branch) |
| Go back | Reset + create attempt | `git checkout -B attempt-… <tag>` |
| Keep this | Promote candidate | `git tag -f checkpoint/<name> <sha>` |
| Try again | Archive + re-run current stage | New attempt branch + re-enter stage |
| Try N ways | Fan-out | N attempt branches (+ worktrees for parallel stages) |
| Record | Auto-promote mode | `DEX_RECORD_MODE=1` / `ui.recordMode` |
| (invisible) | Canonical timeline anchor | `capture/<date>-<runId-slice>` |

User-facing labels come from `labelFor(stage, cycleNumber, featureSlug?)` in `src/core/checkpoints.ts` — single source of truth.

`cyclesCompleted` in `DexState` is feature-indexed today (increments once per `learnings`, which runs once per feature). Cycle number uniquely identifies features within a run; the feature slug is a UI affordance, not a disambiguator.

## Commit semantics

### Structured commit messages

Every `commitCheckpoint` commit uses a parse-friendly format:

```
dex: <stage> completed [cycle:<N>] [feature:<slug>] [cost:$X.XX]
[checkpoint:<stage>:<cycle>]
```

The second line makes `git log --all --grep='^\[checkpoint:'` a zero-UI terminal workflow from day 1. Documented in `06-testing.md` as a supported power-user path.

### Empty-commit stages

Stages like `verify` often produce no file changes. `commitCheckpoint` always creates a commit, using `git commit --allow-empty` when there's nothing to stage. Rationale:

- Every stage gets its own SHA. Checkpoint tags point at distinct commits; `checkpoint/cycle-1-after-verify` and `checkpoint/cycle-1-after-implement` never coincide.
- The graph shows every stage as its own node.
- Go back semantics are unambiguous — reset to verify's commit reproduces verify's on-disk state.

## Storage model — three layers, each with one role

| Layer | Where | What | Behavior |
|---|---|---|---|
| **Cache** | `<projectDir>/.dex/state.json` (gitignored) + `.dex/feature-manifest.json` (committed) + `.dex/variant-groups/*.json` (gitignored) | Runtime state: current stage, pending questions, retry counts, artifact hashes, UI prefs, active variant group. | **Local, not shared.** Rebuilt from refs + filesystem on Go back / project open / external git change. |
| **History** | Git refs — `checkpoint/*` tags, `attempt-*` branches, `capture/*` anchor | Named save points; attempt timelines; canonical anchor. | **Authoritative, shared via `git push`.** Teams collaborate on checkpoint trees. |
| **Audit** | `<projectDir>/.dex/runs/<runId>.json` (from 007) + `~/.dex/logs/<project>/<runId>/` | Cost, duration, phase metadata, subagent info, verbose step stream. | Per-project JSON from 007. Optionally committable. |

**Resolving the "gitignore vs team sharing" question**: state.json is local runtime cache, always. Git refs are the shared authoritative layer. When a collaborator clones your project, they get the refs; their `state.json` is rebuilt fresh by reconciliation on open. Nobody shares runtime cache.

This means reconciliation is authoritative — `reconcileState` extends to "rebuild state.json from refs + filesystem" rather than "repair drift against committed state.json". Runs on:
- Project open (every time).
- After Go back / Try again / Try N ways.
- After any external git ref change detected by poll.

### DexState changes

- **Remove** `branchName`. Derive from `git rev-parse --abbrev-ref HEAD`.
- **Rename** `checkpoint: {sha, timestamp}` → `lastCommit: {sha, timestamp}`. "Checkpoint" is the domain term for user-facing tag-backed save points.
- **Add** `pauseReason: "user_abort" | "step_mode" | "budget" | "failure"`.
- **Add** `ui.recordMode: boolean` and `ui.pauseAfterStage: boolean`. Session-scoped UI prefs.

## Abstraction leak prevention

1. **Uncommitted user changes before Go back** — dirty-state check before reset. Modal: Save / Discard / Cancel.
2. **Missing git identity** — prompt at project open, OS-default suggestions, local config only.
3. **Not a git repo** — offer `git init` + initial commit. Skip → Timeline disabled with banner.
4. **Missing checkpoint** (tag deleted, commit GC'd) — listing IPC validates; dead rows show `(unavailable — refresh)`.
5. **Detached HEAD** — never expose; wrap every potential detach in immediate `checkout -B`.
6. **External git ops** — Timeline auto-refreshes on focus + 30s poll. Deleted current attempt → prompt "Start new attempt from last known checkpoint?"
7. **Keep this fails** — atomic plumbing, friendly toast, full error to `electron.log`.
8. **Concurrent Dex instances** — `.dex/state.lock` wraps all checkpoint-mutating IPC. Second window read-only.
9. **Cloned/forked project** — refs travel via `git push --tags`; state.json rebuilt locally on open. Feature.
10. **`git clean` leak** — on Go back, use `git clean -fd` (respects `.gitignore`), **NOT** `-fdx`. Preserves `.env`, build output, editor state, anything gitignored. Still removes stray Dex-created untracked files.

## Default behavior contract

**Dex must still feel like a one-button tool for users who don't care about checkpoints.**

- Open → Start → run to completion. Zero modals in the happy path.
- Timeline panel collapsed by default. Small "Timeline (N checkpoints)" header in the Agent Trace area.
- Record mode off by default.
- Abstraction-leak modals fire only when a real problem needs user input.

## Verification at a glance

- Default flow: run end-to-end, zero modals, tags exist after.
- Step mode: one-stage advances, summaries render, Keep / Try again work.
- Parallel variants: 3 `plan` variants → wall time ≈ 1× stage duration. Sequential `implement` variants: ≈ 3×.
- Record mode: REC badge visible, canonical tags move automatically.
- Resume-mid-variant: quit during variant A; restart; offered Continue variant group; B and C complete.
- Abstraction leaks: each of the 10 scenarios produces a friendly modal.
- Typecheck + property tests on naming round-trips.

Detailed matrix in `plan.md`.

## Out of scope / follow-ups

- **Multi-stage variants** — v1 fans out one stage. Multi-stage is a follow-up with its own UX.
- **Parallel implement variants** — blocked on shared build state. Future work via container-isolated worktrees or in-memory filesystems.
- **Cloud sync** — checkpoints travel via git; no separate sync.
- **Automatic stale-tag pruning** — follow-up `prune-stale-checkpoints.sh`.
- **Checkpoint renaming from UI** — power users use `git tag -f` from terminal.

## Supersedes

- `docs/my-specs/005-testing-improvements` — three-fixture scheme becomes a special case. Legacy `fixture/*` branches on `dex-ecommerce` are deleted (dev phase, no migration).
- `.claude/rules/06-testing.md` § 4c — rewritten to point at the checkpoint system.
