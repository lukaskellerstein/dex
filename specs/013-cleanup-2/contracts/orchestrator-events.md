# Contract: `OrchestratorEvent` discriminated union

**Boundary**: Main process orchestrator → renderer (event stream over `webContents.send("orchestrator:event", event)`).
**Source of truth (post-cleanup)**: `src/core/events.ts` (`OrchestratorEvent` type).

This contract documents the orchestrator-event union before and after `013-cleanup-2`. The cleanup removes one variant (`checkpoint_promoted`) and preserves all others. One variant (`step_candidate`) keeps a misleadingly-named field (`attemptBranch`) deliberately — the rename is deferred to a future spec.

## Why this is a contract

`OrchestratorEvent` is the message shape on the orchestrator-to-renderer event stream. Three places consume the union:

1. **Main process emit sites** — every call to `webContents.send("orchestrator:event", ...)` in `src/main/` and event-emit calls inside `src/core/orchestrator.ts` and `src/core/checkpoints/recordMode.ts` produce values of this type.
2. **Renderer event handler** — `src/renderer/App.tsx`'s `useEffect` on `window.dexAPI.onOrchestratorEvent(...)` switches on `event.type`.
3. **Renderer hooks** — `useTimeline` in `src/renderer/components/checkpoints/hooks/useTimeline.ts` uses `event.type` cases to trigger snapshot refreshes.

The discriminant is the only routing key on this stream. Adding or removing a discriminant value requires coordinated edits at every producer and consumer in the same change (see [Sequencing constraint](#sequencing-constraint) below).

## Removed variant — `checkpoint_promoted`

### Before

```ts
type OrchestratorEvent =
  // ... other variants
  | {
      type: "checkpoint_promoted";
      runId: string;
      checkpoint: string;   // canonical checkpoint name (e.g. "cycle-3-after-tasks")
      sha: string;          // commit SHA the tag was placed on
    }
  // ... other variants
  ;
```

### After

The `checkpoint_promoted` variant is **removed entirely** from the union. Producers and consumers are deleted in the same change.

| Site | Role | After 013-cleanup-2 |
|---|---|---|
| `src/core/orchestrator.ts:289` | Producer (Record-mode termination block) | Block deleted (FR-005). |
| `src/core/checkpoints/recordMode.ts:65` | Producer (`autoPromoteIfRecordMode`) | File deleted (FR-007). |
| `src/renderer/components/checkpoints/hooks/useTimeline.ts:70` | Consumer (`case "checkpoint_promoted":` refresh trigger) | Case deleted. |
| `src/renderer/App.tsx:365-369` | Consumer (DEBUG-badge state update) | Block deleted. |

## Sequencing constraint

The discriminant deletion in `events.ts` must happen **after both producers** are removed, otherwise `recordMode.ts` (which references the discriminant when constructing the event) fails to type-check during the intermediate state. The implementation order in the README pins this as **step 7b** — fired immediately after step 7 (the `recordMode.ts` delete). Spec FR-013 captures the constraint formally.

## Preserved variant — `step_candidate` (with deferred rename)

### Shape

```ts
type StepCandidateEvent = {
  type: "step_candidate";
  runId: string;
  attemptBranch: string;   // ← name preserved, semantics changed
  // ... other fields
};
```

### Semantic change to `attemptBranch`

Pre-013, `attemptBranch` always held a value matching `attempt-*` or `dex/*`. Post-013, the value is always one of:

- `dex/<YYYY-MM-DD>-<id>` — the run branch
- `selected-<...>` — when running on a navigation fork
- `""` — when `getCurrentBranch()` falls back on detached HEAD (legitimate post-013, e.g. a future feature inspecting a checkpoint)

`attempt-*` values are gone — no producer mints them.

### Why the rename is deferred

Renaming `attemptBranch` to (say) `currentRunBranch` would touch:

1. `src/core/events.ts` — the type definition.
2. `src/core/stages/finalize.ts:74-95` — the emit site.
3. `src/core/runs.ts` — patches the run record from this field.
4. `src/renderer/App.tsx:36, 68, 347, 350, 361, 397, 414` — state declaration, threading, DEBUG-badge payload.
5. The DEBUG-badge user-shareable payload (line 68 in App.tsx is what surfaces in the diagnostic copy).

This is roughly 8-10 sites of coordinated mechanical edits across the producer/consumer graph for a name change with no behaviour delta. Out of scope for a cleanup whose primary goal is symbol *removal*. A `TODO(post-013)` comment at `App.tsx:36` flags the deferred work for grep discoverability.

## Other variants — unchanged

All other variants of `OrchestratorEvent` are preserved verbatim. The cleanup does not add a new variant, change a payload, or alter a discriminant. The full union is auditable in `src/core/events.ts` post-cleanup.

## Validation

After the cleanup lands:

```bash
grep -rn "checkpoint_promoted" src/ | grep -v test
# expected: zero hits
```

The TypeScript compiler enforces the union shape — any consumer still switching on the removed variant fails type-check, any producer still constructing it fails to compile.

## Backward compatibility

**None offered.** This is an internal in-process event stream between the main and renderer of the same Electron binary. There is no persistent log of past events that would need a migration; events are ephemeral.
