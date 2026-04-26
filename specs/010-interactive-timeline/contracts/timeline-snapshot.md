# Contract — `TimelineSnapshot` (extended)

**Source of truth**: `src/core/checkpoints.ts` → `listTimeline(projectDir): TimelineSnapshot`
**Consumed by**: `useTimeline` hook (renderer), `<TimelinePanel>`, `<TimelineGraph>`, `<StageList>`, `<ProcessStepper>`, `<LoopDashboard>`.

The snapshot is the single source of truth for the Timeline tab AND the Steps tab (after this feature). Both tabs read from the same payload.

## Full shape (post-010)

```ts
interface TimelineSnapshot {
  // Existing 008 fields — UNCHANGED
  checkpoints: CheckpointInfo[];
  attempts: AttemptInfo[];
  currentAttempt: AttemptInfo | null;
  pending: PendingCandidate[];
  captureBranches: string[];
  startingPoint: StartingPoint | null;

  // NEW
  commits: TimelineCommit[];
  selectedPath: string[];
}
```

See [data-model.md §1–2](../data-model.md) for `TimelineCommit` and `TimelineSnapshot` field details.

## Invariants

- **`commits` is the only place** mid-stage WIP commits are filtered out. The renderer never re-filters; it trusts the array.
- **`commits` is sorted ascending by `timestamp`.** Layout is deterministic on this ordering.
- **`selectedPath` is a strict subset** of `commits.map(c => c.sha)`. Membership lookup is O(1) when the renderer wraps it in `new Set(...)`.
- **`selectedPath` is ordered oldest → newest.** The first entry is closest to the run's starting-point; the last is current HEAD's nearest step-commit ancestor (or HEAD itself if HEAD is a step-commit).
- **`startingPoint`** continues to point at the run's branch-off commit (typically a `main` SHA). It does NOT appear in `commits` unless its subject happens to match the step-commit pattern (which it normally doesn't).

## Error fallback

When `listTimeline()` throws (e.g., the project isn't a git repo yet), the IPC handler returns:

```ts
{
  checkpoints: [],
  attempts: [],
  currentAttempt: null,
  pending: [],
  captureBranches: [],
  startingPoint: null,
  commits: [],
  selectedPath: [],
}
```

`commits` and `selectedPath` MUST be `[]`, never `undefined`.

## Performance budget

`listTimeline()` for a project with up to ~200 step-commits across ≤10 branches MUST complete in ≤200 ms (current 008 budget — unchanged). The new commit-listing work fits inside this budget because it shares the existing `safeExec` git invocations.

## Renderer-side derivations

The following are computed in the renderer from the snapshot — they are NOT in the snapshot itself:

- **`keptShas`**: `new Set(checkpoints.filter(c => !c.unavailable).map(c => c.sha))`. Used to render red rings.
- **`selectedSet`**: `new Set(selectedPath)`. Used to render blue fills.
- **`columnsByBranch`**: `groupBy(commits, c => c.branch)`. Used by `timelineLayout()`.

Computing these in the renderer (rather than core) keeps the IPC payload small and the core test surface focused.
