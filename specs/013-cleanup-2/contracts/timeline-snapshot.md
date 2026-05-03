# Contract: `TimelineSnapshot`

**Boundary**: IPC (main process → renderer) and the `useTimeline` hook.
**Source of truth (post-cleanup)**: `src/core/checkpoints/timeline.ts` (`TimelineSnapshot` type).

This contract documents the shape of `TimelineSnapshot` before and after `013-cleanup-2`. The cleanup *reduces* the shape — three fields and one supporting type are removed entirely. There is no addition, no rename, no relaxation of constraints.

## Why this is a contract

`TimelineSnapshot` flows across three boundaries:

1. **Main → Renderer over IPC** — `src/main/ipc/checkpoints.ts` returns the snapshot from `listTimeline`; the renderer receives it via `window.dexAPI.listTimeline(...)`.
2. **Hook input → component output** — `useTimeline` (in `src/renderer/components/checkpoints/hooks/useTimeline.ts`) holds the snapshot in React state and feeds it to `TimelineGraph` and friends.
3. **Test fixtures** — both `src/core/__tests__/timelineLayout.test.ts` and `src/renderer/services/__tests__/checkpointService.test.ts` build `EMPTY` fixtures of this shape; the fixtures must match the type.

A change to the shape requires coordinated edits at every consumer; the cleanup performs those edits in a single change.

## Before — pre-013 shape (truncated)

```ts
type TimelineSnapshot = {
  // Stable across the cleanup:
  commits: TimelineCommit[];
  pending: PendingCandidate[];
  visibleBranches: string[];
  // ... unchanged fields elided

  // Removed by 013-cleanup-2:
  attempts: AttemptInfo[];
  currentAttempt: AttemptInfo | null;
  captureBranches: string[];
};

type AttemptInfo = {
  name: string;          // "attempt-<ts>" or "attempt-<ts>-<letter>"
  sha: string;
  isCurrent: boolean;
  // ... fields elided
};
```

## After — post-013 shape (truncated)

```ts
type TimelineSnapshot = {
  commits: TimelineCommit[];
  pending: PendingCandidate[];
  visibleBranches: string[];
  // ... unchanged fields elided
};

// AttemptInfo: removed entirely.
```

## Field-level diff

| Field | Type (before) | Type (after) | Reason |
|---|---|---|---|
| `attempts` | `AttemptInfo[]` | (removed) | The `attempt-*` branch family has no producer in the running app post-cleanup. Surfacing it in the snapshot served only the dirty-tree-save lane and timeline-debug rendering — both gone. |
| `currentAttempt` | `AttemptInfo \| null` | (removed) | Same. |
| `captureBranches` | `string[]` | (removed) | The `capture/*` branch family is removed with Record mode. Field has no remaining consumer. |
| `AttemptInfo` (type) | object as above | (removed) | Sole consumer was `TimelineSnapshot`. |

All other fields on `TimelineSnapshot` are stable across the cleanup. The cleanup does not introduce any new field.

## Consumers updated in the same change

| Consumer | File | Change |
|---|---|---|
| IPC error fallback | `src/main/ipc/checkpoints.ts:79-83` | Drop `attempts: []`, `currentAttempt: null`, `captureBranches: []` from the empty-snapshot object returned on error. |
| `EMPTY` constant | `src/renderer/components/checkpoints/hooks/useTimeline.ts:10-14` | Same drop. |
| Renderer typing | `src/renderer/electron.d.ts` | Drop the three field declarations. |
| Test fixture | `src/renderer/services/__tests__/checkpointService.test.ts:52` | Drop the three field assignments. |
| Test fixture | `src/core/__tests__/timelineLayout.test.ts:38` | Drop the three field assignments. |

## Validation

The contract is enforced by the TypeScript compiler — `npx tsc --noEmit` must remain green at every numbered implementation step (spec NFR-001). There is no runtime schema validator on this DTO; the type system is the only enforcement.

After the cleanup lands:

```bash
grep -rn "attempts:\|currentAttempt:\|captureBranches:" src/ | grep -v test
# expected: zero hits

grep -rn "AttemptInfo" src/
# expected: zero hits
```

The presence of any hit indicates a missed consumer.

## Backward compatibility

**None offered.** This is an internal IPC contract between the main process and renderer of the same Electron app — both sides ship together as a single binary. There is no over-the-wire backward-compatibility concern.
