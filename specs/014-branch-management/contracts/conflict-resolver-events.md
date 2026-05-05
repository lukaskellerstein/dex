# Event-Stream Contract: `conflict-resolver:*`

**Channel**: `orchestrator:event` (`webContents.send`) — the existing event channel; resolver events ride alongside step/run events.
**Lifecycle**: Events emit only between the moment `mergeToMain` detects a conflict and the moment the resolver returns. Outside that window, no `conflict-resolver:*` events are emitted.

## Event types

```ts
type ConflictResolverEvent =
  | FileStartEvent
  | FileDoneEvent
  | IterationEvent
  | DoneEvent;

interface FileStartEvent {
  type: "conflict-resolver:file-start";
  file: string;        // workspace-relative path
  index: number;       // 1-based file index in this resolver invocation
  total: number;       // total file count for this invocation
}

interface FileDoneEvent {
  type: "conflict-resolver:file-done";
  file: string;
  ok: boolean;         // true if the file ended in DONE state, false if FAILED
  iterationsUsed: number;
}

interface IterationEvent {
  type: "conflict-resolver:iteration";
  n: number;           // 1-based iteration counter (across all files)
  costSoFar: number;   // USD, cumulative
  currentFile: string;
}

interface DoneEvent {
  type: "conflict-resolver:done";
  ok: boolean;
  costTotal: number;
  reason?: ResolverFailReason;  // present iff ok === false
}
```

## Ordering guarantees

1. **Bracketing**: For each file in `conflictedPaths`, exactly one `file-start` precedes any `iteration` events for that file, and exactly one `file-done` follows the last `iteration` for that file before the next `file-start`. Files are processed sequentially; no interleaving.
2. **Iteration counter**: `IterationEvent.n` is monotonically increasing across the entire resolver invocation (it does not reset per file). It increments by 1 immediately before each `runOneShot` call. This makes it easy for the renderer to display `"Resolving disagreement #N…"` without tracking per-file counts.
3. **Cost accumulation**: `IterationEvent.costSoFar` is the cumulative cost *after* the prior iteration's `runOneShot` resolved (i.e. before the iteration named `n` runs). On the very first iteration, `costSoFar` is `0`.
4. **Terminal event**: `DoneEvent` is the last event in the stream. The renderer must unsubscribe (or stop reacting) after this event for this resolver invocation.
5. **Cancel/abort**: When the user cancels via `checkpoints:abortResolverMerge`, the harness emits one `DoneEvent` with `ok: false; reason: "user_cancelled"` after the in-flight `runOneShot` aborts. No further events follow.

## Event payload size

All events are small (≤ 200 bytes serialised). The full `currentFile` path is included on every `IterationEvent` so the progress modal doesn't need to track which file is current — it just renders whatever the most-recent event reported.

## Renderer subscription pattern

```ts
// In TimelinePanel.tsx
useEffect(() => {
  if (!resolverActive) return;
  const off = window.dexAPI.onOrchestratorEvent((evt) => {
    if (!evt.type?.startsWith("conflict-resolver:")) return;
    setResolverState(reduceResolverEvent(prevState, evt));
    if (evt.type === "conflict-resolver:done") {
      setResolverActive(false);
    }
  });
  return off;
}, [resolverActive]);
```

The reducer pattern keeps the progress modal pure-functional over the event stream. State shape:

```ts
interface ResolverProgressState {
  totalFiles: number;
  currentFile: string | null;
  currentFileIndex: number;
  iteration: number;
  costSoFar: number;
  resolvedFiles: string[];
  failedFiles: string[];
  done: boolean;
  finalReason?: ResolverFailReason;
}
```

## Why these events specifically

The minimum the progress modal needs to render is: which file are we on (file-start), where in the file are we (iteration counter), and how much has it cost (costSoFar). `file-done` is included so the modal can display a running tally of resolved-vs-pending in real time without the renderer tracking it. `done` is the terminal so the renderer knows when to swap modal contents (success toast → close, failure → `<ResolverFailureModal>`).

Earlier drafts considered a per-token streaming event for "what is the agent typing right now". Rejected — pure noise, slows the SDK loop, and the user doesn't actually want to read the agent's stream of consciousness mid-resolution.
