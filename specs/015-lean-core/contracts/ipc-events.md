# Contract: IPC channels and orchestrator events

Transport is unchanged: request–response through `ipcMain.handle`, events on the
single channel `orchestrator:event` (`src/main/ipc/orchestrator.ts`), fanned out
in the renderer by `orchestrator-api.ts`.

## IPC channels

| Channel | Change | Shape |
|---|---|---|
| `checkpoints:*` (13 channels) | **delete** | — |
| `profiles:list`, `profiles:saveDexJson` | **delete** | — |
| `orchestrator:answer-question` | **replace** by `orchestrator:answer-request` | — |
| `orchestrator:answer-request` | **add** | `(requestId: string, answer: RequestAnswer) => void`. It resolves a request an agent is waiting on (a question or a tool approval) and ignores the rest. A pause is not answered here: no agent waits on it, the run has ended, and Continue is Resume. |
| `project:get-run-snapshot` | **add** | `(projectDir: string) => RunSnapshot` |
| `project:*`, `history:*`, `appConfig:*`, `orchestrator:start/stop/getRunState/getProjectState` | keep | unchanged |

```ts
type RequestAnswer =
  | { kind: "question"; answers: Record<string, string> }       // question text → label
  | { kind: "tool_approval"; decision: "approve" | "deny"; message?: string }
  | { kind: "pause"; option: string };                          // one of the request's options

interface RunSnapshot {
  state: DexStateV2 | null;          // .dex/state.json, read fresh
  queue: QueueView | null;           // null when there is no queue yet (new project before manifest), or the queue is invalid
  errors: string[];                  // queue / policy validation errors, verbatim
}

interface QueueView {
  kind: "new" | "existing";
  entries: Array<{
    id: string;
    title: string;
    status: "pending" | "active" | "done" | "skipped";
    nextStage: StageName | null;     // null when done/skipped
    reason: string;                  // picker's reason in words
    taskPhase: number | null;
    costUsd: number;                 // summed from .dex/runs/<runId>.json agentRuns for this entry
  }>;
}
```

`project:get-run-snapshot` runs the picker in describe mode (`describeQueue`),
which reads files and git refs and never writes (a v2 manifest migrates in
memory only). `src/core/run-snapshot.ts` is the one implementation; `dex run
--status` prints the same snapshot. `costUsd` sums the run record's agent runs by
`featureSlug`, which is the entry id.

### Renderer rule (FR-043)

On `run_started`, `step_started`, `step_completed`, `paused`, `run_completed`
and `loop_terminated`, the renderer calls `project:get-run-snapshot` and replaces
its queue and status view with the result. It no longer infers the next stage
(`NEXT_STAGE_AFTER` in `useLoopState.ts` goes) and no longer re-syncs from git.
The live trace (`agent_step`, `subagent_*`) stays event-driven: it is a stream,
not state. Each read gets a ticket and only the newest answer lands; a failed read
keeps the last snapshot. `currentStage` moves only on `step_started`; the
renderer's optimistic advance is gone. The pending request on reload comes from
`state.pendingRequests`, restored only while `getRunState()` reports a live run.

What the app does with the snapshot, in `useRunSnapshot.ts`: `startActionFor`
chooses Start's action (an invalid queue or policy disables it; a paused run, or an
open entry with a run state, resumes; an open entry without one starts the queue
loop; no queue runs the unfinished spec folders in build mode), and `queueProgress`
gives the cycle count and the placeholder cycles (done of the entries that will run;
one placeholder per entry not started, at most three).

## Orchestrator events (`src/core/events.ts`)

### Delete

| Event | Producer today | Consumers to edit |
|---|---|---|
| `step_candidate` | `stages/finalize.ts:85` | `App.tsx:384`, `checkpoints/hooks/useTimeline.ts:67` |
| `head_changed` | `main/ipc/checkpoints.ts:141` | `App.tsx:235`, `useProject.ts:54` |
| `loop_reset` | `main/ipc/checkpoints.ts:122` | `useLoopState.ts:128`, `useProject.ts:53` |
| `state_reconciling`, `state_reconciled` | `state.ts:708, 755` | `useRunSession.ts:108` (console only) |
| `conflict-resolver:file-start/file-done/iteration/done` | `conflict-resolver.ts` | `ConflictResolverProgress.tsx`, `TimelinePanel.tsx` |
| `verify_failed` | `cycle-stages.ts:289` | none |
| `manifest_drift_detected` | `manifest-extraction.ts:48` | none |
| `clarification_question` | none | none |

`DriftSummary` in `types.ts` goes with `state_reconciled`.

### Change

```ts
| { type: "paused"; runId: string; reason: PauseReason; detail?: string; step?: StepType }
| { type: "loop_terminated"; runId: string; termination: LoopTermination }
//   TerminationReason = "queue_complete" | "user_abort" | "paused" | "budget_exceeded" | "failed"
```

`loop_cycle_started` / `loop_cycle_completed` keep their shape. `cycleNumber`
now means the entry's 1-based position in the queue, so the log tree
(`phase-<cycle>_<step>/`) and `runs.ts` stay unchanged. `featureName` is the
entry title; `decision` on `loop_cycle_completed` is `done`, `stopped`, or the
pause/termination reason. `LoopTermination.cyclesCompleted` is the number of done
entries, read from the queue view, not a count of cycles seen.

### Add

```ts
| { type: "stage_decision"; runId: string; cycleNumber: number; entryId: string;
    stage: StageName | null; decision: "stage" | "pause" | "complete"; reason: string }
| { type: "policy_denied"; runId: string; agentRunId: string; toolName: string;
    subject: string; reason: string; rule: "deny" | "writeRoots" | "frozen" }
| { type: "tool_approval_request"; runId: string; requestId: string; toolName: string;
    subject: string; input: unknown; source: "policy" | "settings"; reason?: string }
| { type: "request_resolved"; requestId: string; by: "human" | "default" | "answer_book" | "stop" }
| { type: "tree_dirty"; runId: string; cycleNumber: number; files: string[] }
```

`user_input_request` / `user_input_response` stay for `AskUserQuestion`. In
`recommended-then-review` mode a defaulted question emits both, then
`request_resolved { by: "default" }`; one answered from the answer book emits the
same with `by: "answer_book"`. `stage_decision` for a finished queue carries
`cycleNumber: 0`, `entryId: ""`, `stage: null`. A `tree_dirty` event is emitted by
the loop after a stage that left uncommitted files (Dex's runtime files excluded).
`policy_denied` is emitted by the PreToolUse hook (`agent/permissions.ts`).
