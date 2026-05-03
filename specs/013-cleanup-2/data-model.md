# Phase 1 — Data Model

**Feature**: Branch Namespace + Record-mode Cleanup (`013-cleanup-2`)

This document captures the data structures and namespace conventions that change shape as a result of this cleanup. There is no schema migration — every change is a *deletion* of an unused field, branch family, tag family, or event discriminant. Where a structure is named below as "removed" it is deleted from the type system entirely; downstream consumers must be updated to match (covered in spec FR-014, FR-013, FR-015 and detailed in the companion README's file map).

The shapes in this file are advisory documentation, not generated code. The authoritative TypeScript types live in `src/core/types.ts`, `src/core/checkpoints/timeline.ts`, `src/core/events.ts`, `src/core/state.ts`, and `src/renderer/electron.d.ts` — and become the post-cleanup shapes as described below.

---

## 1. `TimelineSnapshot` — reduced shape

The snapshot the IPC layer returns from `listTimeline` and the renderer consumes via `useTimeline`.

### Before

```ts
type TimelineSnapshot = {
  commits: TimelineCommit[];           // unchanged
  pending: PendingCandidate[];         // unchanged
  visibleBranches: string[];           // unchanged (filter list)

  // Removed by 013-cleanup-2:
  attempts: AttemptInfo[];             // ← deleted
  currentAttempt: AttemptInfo | null;  // ← deleted
  captureBranches: string[];           // ← deleted

  // ... other unrelated fields preserved
};

type AttemptInfo = {                   // ← entire type deleted
  name: string;        // "attempt-<ts>" or "attempt-<ts>-<letter>"
  sha: string;
  isCurrent: boolean;
  // ...
};
```

### After

```ts
type TimelineSnapshot = {
  commits: TimelineCommit[];
  pending: PendingCandidate[];
  visibleBranches: string[];
  // ... other unrelated fields preserved
};
// AttemptInfo: removed entirely
```

### Consumers updated

| Consumer | Site | Change |
|---|---|---|
| IPC error fallback | `src/main/ipc/checkpoints.ts:79-83` | Drop `attempts: []`, `currentAttempt: null`, `captureBranches: []` from the empty-snapshot object. |
| `EMPTY` constant | `src/renderer/components/checkpoints/hooks/useTimeline.ts:10-14` | Same drop. |
| Renderer typing | `src/renderer/electron.d.ts` | Drop the three field declarations. |
| Test fixtures | `src/renderer/services/__tests__/checkpointService.test.ts:52`, `src/core/__tests__/timelineLayout.test.ts:38` | Drop the three field assignments from each `EMPTY` fixture. |

### Validation rule

`TimelineSnapshot` is a plain DTO; there is no runtime validation guarding the shape. The TypeScript compiler is the contract enforcer. After the cleanup, any consumer still reading a removed field fails type-check immediately — this is the desired behaviour.

---

## 2. Branch namespace — canonical post-cleanup list

The git branch namespace produced by the **running app** (Dex opened on a user project) is exactly:

| Pattern | Producer | Lifetime |
|---|---|---|
| `main` (or `master`) | git (user-managed) | Forever |
| `dex/<YYYY-MM-DD>-<id>` | Each autonomous loop run | Until manually deleted (or auto-pruned by `prune-example-branches.sh` when fixture-tested against the example project) |
| `selected-<...>` | Timeline navigation forks (jumping back to an earlier checkpoint and continuing from it) | Lives until the next jump that targets a different parent — empty `selected-*` branches are auto-pruned on jump |

### Removed by 013-cleanup-2

| Pattern | Was produced by | Status post-cleanup |
|---|---|---|
| `attempt-<ts>` | (Already retired in 008/012 — no producer existed in the running app at the start of this spec) | Confirmed dead. No producer added. |
| `attempt-<ts>-saved` | `jumpTo.ts:130` (dirty-tree-save flow) | Producer rewritten to commit on the current branch (FR-001). The `attempt-*` family has zero producers in the running app after this cleanup. |
| `attempt-<ts>-<letter>` (variant slots) | (Already retired in 008/012) | Confirmed dead. |
| `capture/<YYYY-MM-DD>-<runId>` | Record-mode termination block in `orchestrator.ts:288` | Block deleted (FR-005). Zero producers post-cleanup. |

### Carve-out

`scripts/reset-example-to.sh:53` keeps minting fixture-only `attempt-${STAMP}` branches against the example project (`dex-ecommerce`). This is internal scaffolding for the testing flow and never reaches the running app's timeline. Documented in spec assumptions and research R7. The `prune-example-branches.sh` `attempt-*` glob is deleted (FR-015) so fixture branches linger in the example repo until manually deleted.

### Validation rule

Spec SC-002 — after one autonomous loop run on a freshly-reset example project, `git branch --list 'attempt-*' 'capture/*' | wc -l` returns 0.

---

## 3. Tag namespace — canonical post-cleanup list

The git tag namespace produced by the **running app** is exactly: **none**. No tags are auto-created during a run.

| Pattern | Producer | Lifetime |
|---|---|---|
| `checkpoint/after-<step>` (cycle 0) | `scripts/promote-checkpoint.sh` (manual) and any future user-driven "Keep this" verb. **Not produced by the running app during a normal run.** | Until manually deleted |
| `checkpoint/cycle-<N>-after-<step>` (cycle ≥ 1) | Same as above | Same |

### Removed by 013-cleanup-2

| Pattern | Was produced by | Status post-cleanup |
|---|---|---|
| `checkpoint/done-<slice>` | Record-mode termination block in `orchestrator.ts:286` | Block deleted (FR-006). Zero producers. The reading site (`timeline.ts:135-150`) is also deleted, so the tag becomes invisible to the timeline as well. |
| Auto-created `checkpoint/<step>:<cycle>` and `checkpoint/cycle-<N>-after-<step>` *during a run* | `autoPromoteIfRecordMode` in `recordMode.ts:65` | `recordMode.ts` deleted (FR-007). The same tag pattern is still creatable out-of-band by `promote-checkpoint.sh`, but never as part of a run. |

### Validation rule

Spec SC-003 — after one autonomous loop run on a freshly-reset example project, `git tag --list 'checkpoint/done-*' 'checkpoint/*' | wc -l` returns 0. (Step *commits* with `[checkpoint:...]` subjects still exist; only the *tags* are absent.)

---

## 4. Per-step commit-subject convention — unchanged

Step commits cut on every stage boundary continue to carry the subject prefix:

```
[checkpoint:<step>:<cycle>] <commit message body>
```

Producer: `commitCheckpoint` (unchanged). Consumer: `timeline.ts` derives the `pending: PendingCandidate[]` array from these commit subjects. After the cleanup, this is the *only* mechanism by which the timeline identifies stage boundaries (auto-promoted canonical tags are gone — see §3).

### Validation rule

Spec SC-003 — after a run, `git log --grep='^\[checkpoint:'` finds exactly the per-step commits cut by the run.

---

## 5. UI-prefs interface — `recordMode` field removed

`DexUiPrefs` in `src/core/state.ts:25` loses one field.

### Before

```ts
interface DexUiPrefs {
  recordMode?: boolean;   // ← deleted
  // ... other prefs preserved
}
```

### After

```ts
interface DexUiPrefs {
  // ... other prefs preserved
}
```

### Migration / backward compatibility

**None — by design.** The field is removed from the interface; deserialization does not reject unknown fields (TypeScript structural typing + `JSON.parse` ignores extras), so a pre-existing `state.json` containing `"recordMode": true` deserializes cleanly. The field is unread; setting it has no effect (FR-011).

---

## 6. Orchestrator-event union — `checkpoint_promoted` discriminant removed

`OrchestratorEvent` in `src/core/events.ts:100` loses one variant.

### Before (excerpt)

```ts
type OrchestratorEvent =
  | { type: "phase_start"; ... }
  | { type: "checkpoint_promoted"; runId: string; checkpoint: string; sha: string; }   // ← deleted
  | { type: "step_candidate"; attemptBranch: string; ... }
  | // ... other variants
  ;
```

### After (excerpt)

```ts
type OrchestratorEvent =
  | { type: "phase_start"; ... }
  | { type: "step_candidate"; attemptBranch: string; ... }   // ← name preserved (rename deferred)
  | // ... other variants
  ;
```

### Producer / consumer audit

| Site | Before | After |
|---|---|---|
| `src/core/orchestrator.ts:289` (Record-mode termination block) | Producer | Block deleted with the rest of Record mode |
| `src/core/checkpoints/recordMode.ts:65` (`autoPromoteIfRecordMode`) | Producer | File deleted |
| `src/renderer/components/checkpoints/hooks/useTimeline.ts:70` | Consumer (`case "checkpoint_promoted":` refresh trigger) | Case deleted |
| `src/renderer/App.tsx:365-369` | Consumer (DEBUG-badge state update) | Block deleted |

### Sequencing constraint

The discriminant deletion in `events.ts` must happen **after** both producers are removed and **before** the `tsc --noEmit` of the next step. The README pins this as step 7b in the implementation order. See spec FR-013 for the full rationale.

### Note on `step_candidate.attemptBranch`

The event field name `attemptBranch` is retained — its value is now always `dex/*`, `selected-*`, or empty (detached HEAD on a future feature). A `TODO(post-013)` comment at `App.tsx:36` flags the deferred rename. Renaming would touch the orchestrator event union, `finalize.ts` emit, `runs.ts` patches, App.tsx state, and the DEBUG-badge surface — out of scope for this cleanup.

---

## 7. Module relocation — `syncStateFromHead`

| Aspect | Before | After |
|---|---|---|
| Module path | `src/core/checkpoints/recordMode.ts` | `src/core/checkpoints/syncState.ts` |
| Export name | `syncStateFromHead` | `syncStateFromHead` (unchanged) |
| Helper `snapshotResumeFields` | Module-private in `recordMode.ts:162-184` | Module-private in `syncState.ts` (moves with the function — has no other callers) |
| Function signature | unchanged | unchanged |
| Function body | unchanged | unchanged |
| Dependencies | `_helpers`, `../state.js`, `../types.js`, `tags.ts` | `_helpers`, `../state.js`, `../types.js` (no `tags.ts` dep — does its own subject regex; the relocation removes the no-longer-needed import) |
| Re-export from `index.ts` | `export { syncStateFromHead } from "./recordMode.js";` | `export { syncStateFromHead } from "./syncState.js";` |
| File-header `What/Not/Deps` JSDoc | Mentions promotion + record mode (wrong for the new home) | Rewritten to narrate "post-jumpTo state.json reconciliation from HEAD's step-commit subject" |

### Live consumers (unchanged — only import paths shift)

1. `src/renderer/App.tsx:289` — pre-resume reconciliation
2. `src/main/ipc/checkpoints.ts:117` — IPC handler
3. `src/main/preload-modules/checkpoints-api.ts:12` — preload bridge
4. `src/renderer/services/checkpointService.ts:88` — renderer service
5. `src/renderer/electron.d.ts:33` — typing

The renderer/main consumers continue importing through `src/core/checkpoints/index.ts` (the barrel re-export is the single import surface). The change is invisible to them.

### Validation rule

Spec SC-004 — a reset to any `checkpoint/cycle-N-after-<step>` checkpoint followed by **Resume** completes within the same time bound and produces the same next-stage transition as before the cleanup.

---

## 8. State transitions — none changed

The cleanup does not alter any state machine. The orchestrator phase progression, the resume flow, the dirty-tree-save fork, and the timeline auto-prune logic all keep their existing transitions. The dirty-tree-save fork has one new outcome (detached-HEAD refusal) but it is a new *terminal* (returns immediately with no commit, no jump), not a new state.
