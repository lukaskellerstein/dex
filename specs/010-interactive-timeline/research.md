# Phase 0 Research — 010 Interactive Timeline

This document resolves the open technical questions implicit in the spec. There are no `[NEEDS CLARIFICATION]` markers in the spec; the items below are decisions that fixed shape during planning so the implementation can proceed without re-litigating them.

---

## R-1. How does the Timeline render only step-commits while preserving parent edges through non-step ancestors?

**Decision**: Use git's `--ancestry-path` plus a regex filter as the input to `timelineLayout()`. For each branch column, fetch `git log <branch> --format='%H%x09%P%x09%s%x09%cI'` once, then keep only commits whose subject matches `^\\[checkpoint:` (the canonical step-commit pattern). For each retained commit, walk its parent chain (via the parent-SHA index built from the same log output) until we hit another retained commit or fall off the column; that retained ancestor is the edge target. This produces "reachability edges" — the rendered chain hops over WIP commits without ever pretending they don't exist on disk.

**Rationale**: Git already knows the full DAG; we don't need a second representation. Regex-filtering the subject field is the same approach `listTimeline()` uses today for its `pending` candidates, so the cost model is known. The alternative of running `git log --grep='^\\[checkpoint:'` per column would lose the parent-SHA chain we need for edge resolution.

**Alternatives considered**:
- **Run `git log --grep` per branch and rely on its `--ancestry-path`**. Rejected because `--grep` filters output but breaks parent linkage when intermediate commits exist; the filtered log shows step-commits but each one's `%P` still points at the in-between WIP commit.
- **Maintain a separate index of step-commits in `state.json`**. Rejected because it duplicates information that's authoritatively in git, and would require a migration path for projects whose `state.json` predates this feature.

---

## R-2. How is `selectedPath` derived?

**Decision**: At `listTimeline()` time, after we've determined `currentBranch` and `headSha`, run `git log --first-parent <headSha> --format='%H%x09%s'` and keep SHAs whose subject matches the step-commit pattern. The starting point of the path is the first non-step ancestor (typically the run's `dex/<date>-<id>` branch-off from `main`); if none exists, the path's tail is `main`'s tip. Return the SHAs in chronological order (oldest first).

**Rationale**: `--first-parent` collapses merges (none expected today, but future-proofs) and stops at the run's starting point naturally. Keeping the path in `TimelineSnapshot` (rather than letting the renderer recompute) keeps the rendering pure — `TimelineGraph` and `<StageList>` both read the same array.

**Alternatives considered**:
- **Compute `selectedPath` in the renderer from `commits[]`**. Rejected because we'd duplicate the git invocation (renderer doesn't have shell access) or we'd ship the entire commit graph and re-walk it client-side. The IPC payload is smaller when core does the walk.

---

## R-3. How does `jumpTo` decide between checkout and fork?

**Decision**: The new `jumpTo(projectDir, targetSha)` core function follows this order (matches the spec's table):

1. `git rev-parse HEAD` → if `targetSha === HEAD` → `{ok: true, action: "noop"}`.
2. `isWorkingTreeDirty(projectDir)` (existing helper) → if dirty, return `{ok: false, error: "dirty_working_tree", files}`. The renderer already opens `<GoBackConfirm>` on this error.
3. `git for-each-ref --points-at <targetSha> --format='%(refname:short)' refs/heads/` → list of branches whose tip is the target. If exactly one → `git checkout <branch>` → `{ok: true, action: "checkout", branch}`.
4. Otherwise → `git checkout -B attempt-<ts> <targetSha>` (timestamp via `attemptBranchName(new Date())`) → `{ok: true, action: "fork", branch}`.

**Rationale**: `for-each-ref --points-at` is the canonical "is this SHA a tip of any branch?" query; it returns zero, one, or many entries cleanly. Treating "tip of multiple" as fork (rather than picking one branch arbitrarily) avoids surprising side effects on branches the user didn't ask for.

**Alternatives considered**:
- **Re-use `goBack` IPC**. Rejected because `goBack` is checkpoint-tag-driven (`checkpoints/<auto-name>` → SHA) and assumes the operation is always a fork from a tag. Click-to-jump works on raw SHAs and includes the no-op + branch-tip-checkout cases, which `goBack` does not handle.

---

## R-4. Where does the overlay's `.claude/` get written?

**Decision**: At spawn time, after `git worktree add -b <branch> <wtPath> <fromSha>` succeeds inside `spawnVariants()`, call `applyOverlay(<absoluteWorktreePath>, profile)`. The function:

1. If `profile` is undefined or `profile.agentDir/.claude/` does not exist → no-op.
2. `fs.readdirSync(<agentDir>/.claude/)` → for each top-level entry (file or directory), `fs.cpSync(<src>, <wtPath>/.claude/<entry>, {recursive: true, force: true})`.
3. Never touch anything outside `<wtPath>/.claude/`. The project root's `.claude/` (which is `<projectDir>/.claude/`) is unrelated.

**Rationale**: `fs.cpSync` with `force: true` does the top-level replace cleanly. Worktree-friendly stages (gap analysis, specify, plan, tasks, learnings) all already create a worktree (008's `isParallelizable()`); we hook in immediately after that step so the runner sees a populated `.claude/` when it walks up from `cwd = wtPath`.

**Alternatives considered**:
- **Symlinks instead of copy**. Rejected because Windows symlink semantics are inconsistent and the runner's auto-discovery may resolve symlinks differently across platforms. Copying is portable and the volume is small (≤500 KB typical).
- **Copy `.claude/` into a sibling `_dex_overlay/` directory and pass it as a separate flag to the runner**. Rejected because the runner has no such flag — CWD is the only handle. Putting it in `<wtPath>/.claude/` is the only way the runner sees it natively.

---

## R-5. How does the runner consume the profile knobs?

**Decision**: `ClaudeAgentRunner.runStep(ctx)` and `runTaskPhase(ctx)` accept an optional `profile?: ClaudeProfile` field on `ctx`. Inside the runner, after the existing prompt assembly:

- `model = profile?.model ?? config.model`
- `systemPrompt = baseSystemPrompt + (profile?.systemPromptAppend ? "\n\n" + profile.systemPromptAppend : "")`
- `allowedTools = profile?.allowedTools ?? defaultAllowedTools`
- `cwd = ctx.worktreePath ?? config.projectDir` (the new `worktreePath` field is set by `spawnVariants()` for parallel variants; absent for sequential variants and single-stream runs)

These four values flow into the `query()` options object. No other call sites change. When `profile` is `undefined` and `worktreePath` is `undefined`, behavior is byte-identical to today.

**Rationale**: The runner already takes a `config` with `model`/`projectDir`, so we're widening the same shape. Passing `worktreePath` separately from `profile` decouples "which working directory" (set by the spawn flow) from "which agent settings" (set by the user via the modal) — important because a `(none)` profile still wants the worktree CWD when one exists.

**Alternatives considered**:
- **Stash the profile on the orchestrator and have the runner read it from there**. Rejected because it couples the runner to orchestrator internals. `ctx` is the runner's contract; widening it is the cleanest path.

---

## R-6. How is the variant-group state extended for resume?

**Decision**: The variant-group JSON file at `<projectDir>/.dex/variant-groups/<groupId>.json` already records `{groupId, branches[], worktrees[], parallel, step}`. We add a sibling `profiles[]` array indexed by variant letter:

```jsonc
{
  "groupId": "...",
  "branches": ["attempt-2026-04-25-abc-a", "...-b"],
  "worktrees": [".dex/worktrees/attempt-...-a", "..."],
  "profiles": [
    { "letter": "a", "name": "conservative", "agentDir": "/abs/path/to/.dex/agents/conservative" },
    { "letter": "b", "name": null,           "agentDir": null }
  ],
  "parallel": true,
  "step": "plan"
}
```

A null `name`/`agentDir` means `(none)` was selected for that variant. On resume, if a worktree exists (or has been reconstructed) and the corresponding entry has a non-null `agentDir`, the orchestrator re-applies the overlay before invoking the runner.

**Rationale**: The shape stays JSON-array-aligned with `branches[]` and `worktrees[]`, so iteration is uniform. Storing `agentDir` (an absolute path) in addition to `name` lets us survive a profile-folder rename between spawn and resume — the file at the recorded path is what we copied in the first place.

**Alternatives considered**:
- **Store the full `dex.json` snapshot in the variant-group file**. Rejected because it duplicates state and creates a divergence question if the user edits the profile mid-run. The current shape ("name + path") is "what we used at spawn"; if the user wants different settings they spawn a new variant group.

---

## R-7. How does the modal know whether the next stage is sequential?

**Decision**: Reuse the existing `isParallelizable(step)` predicate that already exists in `src/core/checkpoints.ts` (used by `spawnVariants()` to decide between worktree and branch-only spawn). The modal receives the `nextStage` prop (already passed today). Render the warning banner when `!isParallelizable(nextStage)`.

**Rationale**: One source of truth — if 008 considers a stage parallelizable, we apply the overlay; if not, we warn. No risk of the modal and the spawn flow disagreeing.

**Alternatives considered**:
- **Hard-code the sequential set in the modal** (`["implement", "implement_fix", "verify"]`). Rejected; introduces a list that has to be kept in sync with `isParallelizable()`.

---

## R-8. How is the Steps tab's `pause-pending` row identified?

**Decision**: With `selectedPath` available, the row order is fixed (`STAGE_ORDER_RENDERER`). The `pause-pending` row is the **first** stage in `STAGE_ORDER_RENDERER` that is **not** represented in `selectedPath` AND comes after `state.currentStage`, evaluated only when `state.status === "paused"`. If no such row exists (run is paused at the very last stage), no `pause-pending` indicator appears.

**Rationale**: This is a pure projection — same inputs always yield the same row. The orange icon is added to the existing `<StageList>` row renderer as an additional discriminator alongside `done` / `running` / `paused` / `pending`.

**Alternatives considered**:
- **Use `state.nextStage` if present**. Rejected because `state.nextStage` is not currently a tracked field; introducing it adds writeback paths in the orchestrator. Deriving from `selectedPath + STAGE_ORDER_RENDERER` is zero-cost.

---

## R-9. Does the modal need to validate `dex.json` before letting the user pick a profile?

**Decision**: Yes, but lazily. `profiles:list(projectDir)` returns one of three states per folder: `{kind: "ok", profile}`, `{kind: "warn", folder, reason}`, or absent (folder skipped silently — e.g., `.DS_Store`). The modal renders the "ok" entries in the dropdown and the "warn" entries as disabled rows with the reason next to them. This way users see why a folder isn't pickable instead of wondering why their newly created profile is missing.

**Rationale**: Silent skipping is the worst UX — users edit `dex.json`, screw up the JSON, and spend minutes debugging before realizing the picker dropped their profile. A visible warning row (red text, cannot select) makes the failure obvious and actionable.

**Alternatives considered**:
- **Validate at modal-open and pop a global error**. Rejected because it interrupts the flow even when most folders are fine.

---

## R-10. What does `saveDexJson` write, and what does it leave alone?

**Decision**: `profiles:saveDexJson(projectDir, name, dexJson)` writes the **entire** `dex.json` content as JSON, formatted with 2-space indent and a trailing newline. The fields it writes are exactly the editable Dex-side fields: `agentRunner`, `model`, `systemPromptAppend`, `allowedTools`. It does not touch the runner-native subdirectory (`.claude/`, etc.) — that's filesystem-only in v1, per the spec.

**Rationale**: A full rewrite is simpler than a partial JSON merge and avoids surprises if a user has hand-added unknown keys. If a future version of the schema adds keys, the modal will surface them via the `loadProfile` parser; for now the schema is closed.

**Alternatives considered**:
- **Preserve unknown keys via deep-merge before write**. Deferred to a follow-up; v1 schema is closed and small.

---

## R-11. Performance budget for `timelineLayout()`

**Decision**: Target 16 ms for ≤200 step-commits across ≤10 branches. This is the existing function's order of magnitude; the rewrite changes its shape but not its complexity (still O(N) over commits + O(B) over branches). Verified in the existing test by adding a fixture with 200 step-commits across 5 columns and asserting the function returns within 16 ms (Node's `performance.now` margin).

**Rationale**: Keeps Timeline interactive at 60 fps even on heavily-used projects. The current canvas already meets this; the rewrite must not regress.

**Alternatives considered**:
- **Render a fixed window** (last 50 commits). Rejected; users want to see the whole project history, and 200 nodes on D3-zoom is well within browser comfort.

---

## R-12. Why is the in-app profile editor out of scope?

**Decision**: v1 only consumes profile folders (read + spawn); creation/edit/delete is filesystem-only. The "Save changes to profile" button in the modal is the one exception — it writes back the four Dex-side fields a user just edited inline.

**Rationale**: A full editor (folder creation, `.claude/` skill picker, MCP server config, file tree) is its own product surface. Shipping v1 without it lets users try the feature with hand-rolled folders and tells us which knobs they actually want surfaced. Adding a Settings panel later is a follow-up that depends on which fields prove most-edited in practice.

**Alternatives considered**:
- **Ship a minimal editor in v1**. Rejected because the design space is genuinely open (the profile folder can contain arbitrary `.claude/` content) and we don't yet know which subset to surface.

---

## Summary of resolved unknowns

| Topic | Decision |
|---|---|
| Step-commit edges through non-step ancestors | Reachability via parent-SHA index from `git log` |
| `selectedPath` derivation | Core-side `git log --first-parent` walk; ships in `TimelineSnapshot` |
| `jumpTo` decision tree | HEAD no-op → dirty refusal → unique branch tip checkout → otherwise fork |
| Overlay write target | `<wtPath>/.claude/` only; top-level `cpSync` with force |
| Runner consumption of profile | `profile?` field on `ctx`; widens `query()` options; `cwd = worktreePath ?? projectDir` |
| Variant-group state | `profiles[]` array indexed by letter; null = `(none)` |
| Sequential-stage detection | Reuse `isParallelizable()` from core |
| `pause-pending` row | First `STAGE_ORDER_RENDERER` entry past `currentStage` not in `selectedPath`, when status is paused |
| Invalid `dex.json` UX | List with `kind: "warn"` rows visible in modal |
| `saveDexJson` write semantics | Full rewrite of the four editable fields, JSON with 2-space indent |
| Layout perf budget | 16 ms for 200 step-commits / 10 columns |
| In-app profile editor | Out of scope; only inline 4-field write-back |

All resolved — no `[NEEDS CLARIFICATION]` markers remain. Proceeding to Phase 1.
