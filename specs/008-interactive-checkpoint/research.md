# Phase 0 Research: Interactive Checkpoint

**Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

This document resolves all architectural unknowns identified in Technical Context. Every entry follows the **Decision / Rationale / Alternatives considered** format.

---

## R1. Timeline graph renderer: custom D3 + React-owned SVG

**Decision**: Build a custom renderer. React owns the DOM (SVG nodes + edges are React components with plain-React click/hover handlers). `d3-zoom` provides pan/zoom gestures. `d3-shape.linkVertical` computes curved edge path data. Layout itself is a pure TypeScript function (`timelineLayout.ts`) with deterministic lane assignment from the commit DAG. Added dependencies: `d3-zoom`, `d3-selection`, `d3-shape` (~12 kB gz total). No `d3` mega-bundle.

**Rationale**:
- **React controls DOM, d3 does math** — the idiomatic split. Click/hover/selection styling are plain React props; no library escape hatches; context menus, tooltips, and keyboard focus come for free. d3 is scoped to gesture handling and path geometry, where it has no JSX equivalent.
- **Pure layout function** — `layoutTimeline(snapshot, opts) → {nodes, edges, width, height}` is deterministic, unit-testable without a DOM, and snapshot-testable against fixture `TimelineSnapshot`s (including multi-variant fan-out). This gates against visual regressions slice by slice.
- **Bounded surface** — total renderer + layout fits in ~400 LOC. Swappable if requirements change (the layout fn stays; only the React SVG layer moves). Cheap to add virtualization later if the graph exceeds ~500 nodes.
- **No third-party coupling for a pillar feature**. Checkpoints is Dex's moat; binding it to a single external library's upgrade path would be a long-term liability.

**Alternatives considered**:
- `@gitgraph/react` — **archived on GitHub**, no active maintainer. Disqualifying for a new pillar feature.
- React Flow — MIT core is capable, but multiple advanced features (minimap, custom handles, certain edge types) now sit behind Pro. The gravitational pull toward a paid tier is a long-term risk for a feature we plan to iterate on repeatedly.
- Mermaid's `gitGraph` directive — string-based; lacks per-node click/hover handlers; not a good fit for an interactive detail panel.
- Plain HTML/CSS + absolutely-positioned divs — painful edge drawing; no curved paths without SVG anyway; no pan/zoom primitive.
- Full `d3` — overkill; we only need three scoped imports (~12 kB) vs. ~90 kB gz for the full bundle.

---

## R2. Variant execution model: git worktree parallelism for spec-only stages, sequential on main working tree for others

**Decision**: Classify each pipeline stage as **parallelisable** or **serial** via a single predicate `isParallelizable(stage)` in `src/core/checkpoints.ts`. Parallelisable stages (`gap_analysis`, `specify`, `plan`, `tasks`, `learnings`) fan out using `git worktree add -b <attempt-branch> <projectDir>/.dex/worktrees/<branch> <checkpoint-tag>`; N orchestrator instances run concurrently in their respective worktree paths. Serial stages (`implement`, `implement_fix`, `verify`) iterate variant branches sequentially on the main working directory.

**Rationale**:
- **Wall time is the feature**. A 5-minute `plan` with 3 variants takes 5 minutes, not 15. Without parallelism, "Try 3 ways" is a curiosity; with it, it is a headline.
- **Spec-only stages write only to `specs/` and `.dex/`** — isolated per-worktree state, no build-artefact conflicts, no port conflicts, no `node_modules` corruption. Safe to parallelise.
- **`implement`, `implement_fix`, `verify` run tests / compile / install deps**. Parallel worktrees would collide on `node_modules`, `dist/`, build caches, and port bindings. Sequential execution is the correct default; container-isolated parallelism is an explicit v2 follow-up (spec Assumptions).
- **Single predicate, central policy** — `isParallelizable(stage)` is the only place classification lives. Future stages opt in/out by name; no scattered if/else ladder.
- **Rollback on partial worktree failure** — `spawnVariants` tracks which worktrees and branches it created; on failure, it runs `git worktree remove --force` and `git branch -D` on every partial success.

**Alternatives considered**:
- All-parallel — unsafe for implement/verify (see above). Rejected.
- All-sequential — safe but defeats the headline-feature promise. Rejected for v1 spec-only stages.
- Parallel via process cwd isolation without worktrees — would share the git index/HEAD; would race on `.git/index.lock`. Rejected.
- Parallel via in-memory filesystem overlay (OverlayFS, fuse) — platform-specific, fragile across macOS/Windows. Follow-up only.
- Parallel via containerized worktrees — best long-term answer for implement variants; too much scope for v1. Documented as follow-up.

---

## R3. Storage layering: three layers, each with one job

**Decision**: Three storage layers, each with a single responsibility.

| Layer       | Where                                                                                                                                                    | What                                                                                                                  | Shared?                            |
|-------------|----------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------|-------------------------------------|
| **Cache**   | `<projectDir>/.dex/state.json` (gitignored) + `.dex/variant-groups/*.json` (gitignored) + `.dex/worktrees/` (gitignored)                                 | Runtime state — current stage, pending clarifications, retry counts, UI prefs, in-flight variant group progress.       | **Local only**, rebuilt on open    |
| **History** | Git refs — `checkpoint/*` tags, `attempt-*` branches, `capture/*` anchor branches                                                                        | Named save points, attempt timelines, canonical anchor.                                                                | **Shared via `git push`** — teams collaborate on checkpoint trees |
| **Audit**   | `<projectDir>/.dex/runs/<runId>.json` (from 007) + `~/.dex/logs/<project>/<runId>/`                                                                       | Per-run cost/duration/phase metadata + verbose step stream.                                                            | Per-project JSON; opt-in committable |

**Rationale**:
- **Resolves the "gitignore vs team sharing" problem**. State.json was previously committed, which conflated runtime and history and forced tree-rewrites at promote time. By making state.json local-only and making git refs the shared authoritative layer, reconciliation becomes the authority — rebuild state.json from refs + filesystem on open rather than syncing state.json between collaborators.
- **Refs travel naturally** — a collaborator who clones the project and `git fetch --tags` sees the same checkpoint tree Dex renders locally. No cloud service, no external sync, no additional setup (SC-009).
- **Audit trail remains per-project** — integrates with the feature-007 model without any dual-write.
- **Worktrees under `.dex/worktrees/`** — gitignored; short-lived; cleaned on Keep this / Discard all; rollback-safe on partial spawn failure.

**Alternatives considered**:
- Keep committing state.json — forces tree-rewrites on every promote; contradicts git-ignores-runtime-cache norm. Rejected.
- External sync service (cloud) — out of scope (spec Assumption); refs are enough. Rejected for v1.
- Variant groups in SQLite — would require resurrecting the DB that feature 007 just deleted. Flat JSON is enough (one file per group, typical size < 2 KB). Rejected.

**Reconciliation implications**: `reconcileState` in `src/core/state.ts` gains an authoritative mode — "rebuild state.json from refs + filesystem". Existing modes (drift repair against committed state.json) are obsoleted for the committed fields that P1–P3 remove. Runs on: project open (every time); after Go back / Try again / Try N ways; after any external ref change detected by 30 s poll + focus.

---

## R4. Checkpoint naming schema and label source-of-truth

**Decision**: Two layers of names.

- **Machine-facing (git refs)**:
  - Tags: `checkpoint/after-<stage>` (cycle 0) or `checkpoint/cycle-<N>-after-<stage>` (cycle ≥ 1), plus `checkpoint/done-<runId-slice>` on run termination.
  - Attempt branches: `attempt-<YYYYMMDDThhmmss>` or `attempt-<ts>-<letter>` for variants.
  - Canonical anchor branch: `capture/<YYYY-MM-DD>-<runId-slice>`.
  - Underscore→dash slug: `clarification_product` → `clarification-product`.
- **User-facing labels**: single function `labelFor(stage, cycleNumber, featureSlug?)` in `src/core/checkpoints.ts`. Examples: `"prerequisites done"`, `"cycle 2 · cart · after tasks"`, `"learnings captured"`. No git vocabulary in labels.
- **Structured commit message** (commit the tag points at):

  ```
  dex: <stage> completed [cycle:<N>] [feature:<slug>] [cost:$X.XX]
  [checkpoint:<stage>:<cycle>]
  ```

  Shared constant `CHECKPOINT_MESSAGE_PREFIX = "[checkpoint:"`.

**Rationale**:
- **`cyclesCompleted` in `DexState` is feature-indexed** — it increments once per `learnings`, which runs once per feature. Cycle number is a unique key for features within a run; the feature slug is a UI affordance, not a disambiguator.
- **Single source of truth for labels** — Timeline, NodeDetailPanel, Past Attempts list, and StageSummary all call `labelFor`. One function, tested for distinctness across cycles {0, 1, 7}.
- **Machine-parseable commits** — `git log --all --grep='^\[checkpoint:'` is a zero-UI terminal workflow from S0. Documented in `.claude/rules/06-testing.md` as a supported power-user path (satisfies SC-010 and FR-041).
- **Underscore→dash slug** matches ref-name hygiene (some shells and tooling treat `_` oddly in refs; `-` is universally safe).
- **`runId.slice(0, 6)` suffix on `checkpoint/done-*`** disambiguates multiple record-mode runs on the same day.

**Alternatives considered**:
- One tag per run only — defeats the point; user wants to rewind per-stage.
- Plain-English ref names (`checkpoint/after-planning-cycle-1`) — verbose, spaces problematic. Current form is tight and script-friendly.
- No cycle prefix for cycle 0 — explicitly chosen, to keep pre-cycle stages' labels short and readable ("prerequisites done", not "cycle 0 · prerequisites done").

---

## R5. `git clean` scope: `-fd` never `-fdx` on Go back

**Decision**: On Go back, run `git clean -fd -e .dex/state.lock`. Never `-fdx`.

**Rationale**:
- **`.gitignore` captures user intent** — `.env`, build output (`dist/`, `node_modules/`), editor state (`.vscode/`, `.idea/`), plus `.dex/state.json` and `.dex/variant-groups/` post-P3, all live under `.gitignore`. A Go back must preserve them (spec FR-006, edge case "Go back must preserve user-excluded files").
- **`-fdx` would wipe all of these** — the single most damaging behaviour we could ship.
- **`-e .dex/state.lock`** — prevents clobbering an in-flight orchestrator's lockfile if two app instances race Go back at the same moment. State-lock acquisition still guards against concurrent mutations (FR-034); `-e` is belt-and-braces.
- **Still cleans stray untracked files** — e.g., files created by a failed stage that weren't in .gitignore. Matches user expectation ("rewind to that save point").

**Alternatives considered**:
- `git reset --hard <tag>` only — leaves stray untracked files behind. Rejected — "go back" should restore, not partially restore.
- `-fdx` — destroys protected user files. Rejected outright.
- Ask the user per-file — unworkable UX; defeats "hide git".

---

## R6. Resume-mid-variant: on-disk JSON state file

**Decision**: When variants are spawned, write `<projectDir>/.dex/variant-groups/<group-id>.json` with the group schema (see `contracts/json-schemas.md`). On orchestrator startup (post-state-lock), scan `.dex/variant-groups/` for any file whose variants contain `status: "pending" | "running"`; if found, emit an event that opens a "Continue variant group" modal. User confirms → pending variants resume; running variants (whose process died) restart from the stored checkpoint. File is deleted on Keep this / Discard all (via `checkpoints:cleanupVariantGroup` IPC).

**Rationale**:
- **FR-026 mandates clean recovery** — closing the app or crashing mid-fan-out must not strand the user. A file-based state lets any future orchestrator instance pick up the group.
- **JSON file per group** — bounded cardinality (at most a handful concurrent), small (~2 KB), atomic write via rename, human-inspectable for diagnostics.
- **Resume has priority over new-run initiation** — if a pending group exists, the Start button is blocked until the user resolves it. Prevents accidental forking and keeps state consistent.
- **Crashed variant handling** — worktree removed; branch status set to `failed`; group file preserved for diagnosis. User can still Keep a surviving variant.
- **File lifecycle is bounded** — spawned → pending/running → complete → resolved (deleted). No accumulation.

**Alternatives considered**:
- Keep state in `state.json` — conflates cache (local) with orchestration state (needs to survive crash). Separate files are cleaner.
- In-memory only — loses state on crash. Rejected by FR-026.
- SQLite — reintroduces the dependency feature 007 just removed. Rejected.

---

## R7. Pause reason: typed field replacing boolean `paused`

**Decision**: Add `pauseReason?: "user_abort" | "step_mode" | "budget" | "failure"` to `DexState`. Every call site that writes `status: "paused"` also writes the matching reason.

**Rationale**:
- **FR-015 requires distinguishing** pause causes in state and UI. A boolean is insufficient: the same UI slot ("Paused") would otherwise conflate step-mode interactivity with error recovery.
- **One field, no behaviour change for existing paths** — shipping in S0 as a pure addition lets the distinction start showing up in the DEBUG badge from day 1 and makes step-mode's emit straightforward when it lands in S4.
- **Defaults are explicit** — uncaught-error pause path → `"failure"`; Stop button → `"user_abort"`; budget cap → `"budget"`; step-mode → `"step_mode"`. No fall-through ambiguity.

**Alternatives considered**:
- Add it only when step mode lands — delays a small, useful distinction (debugability) for zero benefit.
- Two booleans (`pausedByUser`, `pausedByStep`) — doesn't scale and requires conversion later.

---

## R8. Empty-commit stages: every stage gets its own SHA

**Decision**: Replace the `git commit` call in `commitCheckpoint` with `git commit --allow-empty -m <message>`. Delete the try/catch that previously swallowed the "nothing to commit" error.

**Rationale**:
- **Every stage is a node in the graph**. `verify` often produces no file changes; without `--allow-empty`, `getHeadSha()` returns the previous SHA → `checkpoint/cycle-1-after-verify` and `checkpoint/cycle-1-after-implement` coincide. The graph would show them as the same node.
- **Go back semantics become unambiguous** — resetting to verify's commit reproduces verify's on-disk state (same files as implement, but the audit/commit message clearly says "verify done").
- **No downside**. Empty commits are cheap (~60 bytes each); the existing try/catch code path was dead anyway.

**Alternatives considered**:
- Tag the same SHA with multiple stage names — silly; loses the 1-stage-1-commit invariant; queries like "where was verify?" become ambiguous.
- Generate a dummy file change — pollutes the tree with fake content. Rejected.

---

## R9. DexState schema changes (P1–P4)

**Decision**: Four targeted schema changes shipped in S0 before any UI work.

| Change | Reason |
|---|---|
| **Remove** `branchName` | Runtime state, not history. Its presence forces tree-rewrites at promote time. Derive from `git rev-parse --abbrev-ref HEAD`. (P1) |
| **Rename** `checkpoint: {sha, timestamp}` → `lastCommit: {sha, timestamp}` | "Checkpoint" is the user-facing term for tag-backed save points. The old field just tracked `commitCheckpoint`'s return — `lastCommit` is unambiguous. (P2) |
| **Add** `pauseReason?: PauseReason` | See R7. (P4) |
| **Add** `ui: { recordMode?: boolean; pauseAfterStage?: boolean }` | Session-scoped UI prefs. Persisted in state.json so a relaunch preserves user choice. (S3/S4) |

Consequences handled in S0:
- `state.branchName === currentBranch` check in `detectStaleState` replaced by `getCurrentBranch(projectDir) === expectedBranch`.
- `reconcileState` reads of `state.branchName` replaced by `getCurrentBranch()`.
- `updateState` call sites that set `branchName` drop the field.
- First-load schema: strip `branchName` if present; no migration warning.

**Rationale**:
- **Removing `branchName` first** unlocks S1–S10 — every slice assumes the state shape is simple and reconcilable from refs.
- **Renaming `checkpoint` → `lastCommit`** prevents semantic collision with the user-facing "checkpoint" vocabulary. Done once, mechanically (grep + replace), in a single PR.

**Alternatives considered**:
- Leave `branchName` — every promote becomes a tree-rewrite. Rejected.
- Keep `checkpoint` field name and overload it — guaranteed confusion when reviewing future PRs. Rejected.

---

## R10. Abstraction-leak handling: ten scenarios, one modal each

**Decision**: The ten scenarios named in spec Edge Cases each get a dedicated UX:

| # | Scenario | Handling |
|---|---|---|
| 1 | Dirty tree before Go back | `GoBackConfirm` modal (Save / Discard / Cancel). IPC returns `{ok: false, error: "dirty_working_tree", files}` → renderer opens modal. Save path creates an `attempt-<ts>-saved` branch, commits the changes, then proceeds. |
| 2 | Missing git identity | `IdentityPrompt` at project open. Suggests OS defaults (`os.userInfo().username` / `${username}@${os.hostname()}`). Writes local config only (`git config user.name` without `--global`). |
| 3 | Not a git repo | `InitRepoPrompt` at project open. Offers `git init` + initial commit. Skip → Timeline panel disabled with banner "Version control not initialised". |
| 4 | Missing checkpoint data (tag deleted / commit GC'd) | `listTimeline` validates each entry; dead rows show `(unavailable — refresh)` label and are non-interactive. |
| 5 | Detached HEAD | Never exposed. Every potential-detach operation (e.g., `git checkout <tag>`) is immediately wrapped in `git checkout -B <attempt-branch>`. |
| 6 | External git ops (user deletes current attempt in terminal) | Timeline auto-refreshes on focus + 30 s poll. Deleted-current detection → prompt "Start new attempt from last known checkpoint?" |
| 7 | Promotion fails mid-operation | Atomic-enough plumbing — `git tag -f <tag> <sha>` is the one dangerous step; if it throws, the canonical timeline is unchanged. Friendly toast; full error to `electron.log`. |
| 8 | Two concurrent Dex instances | `acquireStateLock` wraps every checkpoint-mutating IPC. `isLockedByAnother(projectDir)` lets the second window render the timeline read-only. |
| 9 | Cloned/forked project | Refs travel via `git push --tags` / `git fetch --tags`. state.json rebuilt locally on open by `reconcileState`. This is a feature, not an edge case. |
| 10 | `git clean` leak | See R5 — `-fd -e .dex/state.lock`, never `-fdx`. |

**Rationale**: FR-040 and SC-004 mandate that no raw git error string reaches primary UI. Each of these ten has a tested fallback; each produces either a friendly modal/banner or a silent auto-recovery. Ten is a short enough list that each can be verified individually in the matrix.

**Alternatives considered**:
- Generic error modal — "Something went wrong" would fail SC-004. Rejected.
- Surface git errors directly (power-user escape hatch) — leaks abstraction. Rejected for primary paths; the full error is always available in `electron.log` for diagnosis.

---

## R11. Cost estimation: median + p75 of last 5 successful runs of the same stage

**Decision**: `checkpoints:estimateVariantCost(projectDir, stage, variantCount)` reads `listRuns(projectDir, 20)`, flattens `phases`, filters by `stage + status === "completed"`, takes the 5 lowest-index matches (i.e., most recent), sorts by cost, and returns `{ perVariantMedian, perVariantP75, totalMedian, totalP75 }`.

**Rationale**:
- **Early-cycle costs are cheap; late-cycle costs grow**. Mean would be pulled high by a single long late-cycle run. Median + p75 is resilient to that skew.
- **Last 5 not last 1** — variance per stage is real (clarification_synthesis can cost $0.10 or $2.00 depending on answer length). 5 is enough for a stable median.
- **Returns a range, not a point estimate** — modal displays "Estimated $X (median) – $Y (p75)" per variant.
- **Graceful empty case** — if no prior runs match (fresh project), return `{ perVariantMedian: null, perVariantP75: null }`. UI displays "No cost history yet — estimate unavailable" and still lets the user proceed.

**Alternatives considered**:
- Mean — susceptible to outliers. Rejected.
- Point estimate — hides variance. Rejected.
- Global (all-projects) stats — privacy + noise issues. Rejected.

---

## R12. Prerequisite: feature 007 (per-project JSON audit) has shipped

**Decision**: Build on `<projectDir>/.dex/runs/<runId>.json`. `candidateSha` and `checkpointTag` become new fields on each phase record (see `contracts/json-schemas.md`).

**Rationale**:
- **Zero dual-write** — all candidate metadata lands in the same JSON record that 007 established. No legacy SQL table to keep in sync.
- **Sequencing matches spec Assumptions** — the companion design explicitly states 007 ships first.
- **Audit continuity** — existing phase records are backwards-compatible readers; missing `candidateSha` / `checkpointTag` is tolerated for pre-008 runs.

**Alternatives considered**:
- Build on SQLite and run in parallel with 007 — guaranteed dual-write bugs. Rejected at the spec level.
- Introduce a fourth storage layer dedicated to candidates — unnecessary; the audit layer is right-sized.

---

## R13. Cleanup retention window: 30 days

**Decision**: Auto-prune `attempt-*` branches older than 30 days. Do not auto-prune `checkpoint/*` tags (tags are the shared authoritative history layer). `capture/*` branches also preserved.

**Rationale**:
- **Spec Assumptions explicitly flag this as a starting guess** ("revisit after first month"). 30 days balances "still available if the user wants to inspect" against "not accumulating forever".
- **Tags are cheap and meaningful** — never auto-prune.
- **`capture/*` branches** are canonical anchors — never auto-prune.
- **Operational**: extends `dex/scripts/prune-example-branches.sh` with an `attempt-*` sweep. Protects `main`, `checkpoint/*` (tags are already immune), `capture/*`, `lukas/*`.

**Alternatives considered**:
- 7 days — too aggressive for reasonable inspection windows.
- 90 days — ref accumulation pressure, especially with heavy variant usage.
- No auto-prune — ref count grows unboundedly.

---

## R14. Lock extension across all checkpoint-mutating IPC

**Decision**: Refactor `acquireStateLock` in `src/core/state.ts` to support:
- PID + timestamp in the lockfile (existing).
- Stale-lock recovery (existing).
- **New**: read-only probe `isLockedByAnother(projectDir): boolean` — lets the second-window UI render itself read-only without competing for the lock.

Every checkpoint-mutating IPC handler (`promote`, `goBack`, `spawnVariants`, `deleteAttempt`, `writeVariantGroup`, `cleanupVariantGroup`) acquires the lock before mutation and releases in a `finally`.

**Rationale**:
- **FR-034 mandates** that two instances cannot both mutate checkpoint state. Today's lock guarded only orchestrator start; this extends it.
- **Read-only probe** lets the second window render timeline data (via `listTimeline`, which is read-only and doesn't need the lock) with all mutation buttons disabled. UX is honest: you can look, you can't touch, until the other instance finishes.
- **`finally` release** — no orphaned locks on exception paths.

**Alternatives considered**:
- One lock per IPC channel — more granular but allows racy interleavings (Go back starting while a Promote finishes). Single-mutex is simpler and safe.
- Optimistic / CAS — git refs are already CAS-safe individually, but multi-step ops (Go back = checkout + clean) aren't. Reject.

---

## R15. Test strategy

**Decision**: Four tiers, corresponding to four testing needs.

| Tier | Tool | Scope |
|---|---|---|
| Type-level | `npx tsc --noEmit` | Every PR gate |
| Unit (pure Node) | `node --test` | `checkpoints.ts` (round-trip, promote, startAttemptFrom, spawnVariants rollback); `timelineLayout.ts` (snapshot fixtures). tmpdir git repos for integration within the "unit" tier. |
| Property-based | `node --test` with fast-check-style exhaustive input | `labelFor` / `checkpointTagFor` distinctness over `(stage × cycles {0, 1, 7})`. |
| End-to-end UI | `electron-chrome` MCP (CDP 9333) against `dex-ecommerce` | Default flow (zero modals), Step mode, Variants (parallel wall-time assertion), Resume-mid-variant (quit/reopen), Abstraction-leak modals firing. |

**Rationale**:
- **Pure core → pure-Node tests** keeps the test tier fast, DOM-free, and matches Constitution Principle II.
- **Layout fn snapshot tests** catch visual regressions without running a renderer.
- **MCP for end-to-end** is the project's established UI verification path (`.claude/rules/06-testing.md` § 4d).
- **`dex-ecommerce` + `reset-example-to.sh`** remains the canonical fixture, now expressed in checkpoint terms.

**Alternatives considered**:
- Jest — the existing codebase does not depend on Jest; `node --test` is the simpler fit for `src/core/` pure-Node tests.
- Playwright against a built Electron binary — slower, doesn't integrate with the existing MCP-driven verification culture. Rejected.

---

## Summary of architectural decisions

| # | Area | Choice |
|---|---|---|
| R1 | Graph renderer | Custom D3 + React-owned SVG (~400 LOC) |
| R2 | Variant parallelism | Git worktrees for spec-only stages, sequential for implement/verify |
| R3 | Storage layers | Cache (local) / History (git refs, shared) / Audit (per-project JSON) |
| R4 | Naming | Two layers: machine refs + `labelFor` single source of truth |
| R5 | `git clean` on Go back | `-fd -e .dex/state.lock`, never `-fdx` |
| R6 | Resume-mid-variant | `.dex/variant-groups/<id>.json` state file |
| R7 | Pause reason | Typed `PauseReason` field on DexState |
| R8 | Empty-commit stages | `git commit --allow-empty` — every stage gets its own SHA |
| R9 | DexState schema | Drop `branchName`, rename `checkpoint`→`lastCommit`, add `pauseReason`, add `ui` |
| R10 | Abstraction-leak UX | 10 scenarios, one dedicated modal/auto-recovery each |
| R11 | Cost estimation | Median + p75 of last 5 same-stage completed runs |
| R12 | Audit integration | Extends 007's per-project JSON; zero dual-write |
| R13 | Retention | 30-day auto-prune for `attempt-*`; never for `checkpoint/*`/`capture/*` |
| R14 | Locking | Extend `acquireStateLock`; add read-only probe |
| R15 | Tests | typecheck + node --test (pure Node + snapshot) + property + MCP E2E |

All NEEDS CLARIFICATION markers resolved. No open questions remaining for Phase 1.
