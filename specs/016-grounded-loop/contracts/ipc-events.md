# Contract: events and IPC — the 016 additions

Extends [015's contract](../../015-lean-core/contracts/ipc-events.md).

## New orchestrator events

```ts
| {
    type: "sensor_run";
    runId: string;
    entryId: string;
    stage: string;            // "baseline" | "red-first" | "implement" | "verify"
    agentRunId: string | null;
    run: SensorRun;           // data-model § Sensor run, tail included
  }
| {
    type: "gate_decided";
    runId: string;
    entryId: string;
    agentRunId: string | null;
    decision: GateDecision;   // data-model § Gate decision
    evidenceFile: string;     // project-relative, e.g. ".dex/evidence/003-promo-codes/implement-3.json"
  }
| {
    type: "digest_written";
    runId: string;
    entryId: string;
    path: string;             // absolute
  }
```

- `policy_denied.rule` gains `"scope"`.
- `paused.reason` gains the five new pause reasons (data-model § State changes).
- `sensor_run` and `gate_decided` are not stage-boundary events, so the app does
  not re-read the snapshot on them (015 FR-043).

## New IPC handler

| Channel | Args | Returns |
|---|---|---|
| `project:get-digest` | `(projectDir, entryId)` | `{ markdown: string, path: string } \| null` |

Preload: `window.dexAPI.getDigest(projectDir, entryId)`.

`RunSnapshot` gains `digests: string[]`: the entry ids with a file in
`.dex/digests/`, sorted. The queue panel's Digest button and the pause card's
link show only for those ids, so the app never asks for a digest that is not
there. An entry id that is not one path segment (`..`, a `/`) reads as no digest.

## The gate step in the live trace

The app turns the two events into an `AgentStep` of type `gate` (metadata: the
entry id, the decision, the sensor runs since the entry's last decision, the
evidence file). It is never written to `steps.jsonl`, so a run read from history
shows no gate cards. A `baseline` gate runs before the stage it guards, so its
card opens that stage's trace; when the baseline itself paused the run, the card
joins the trace that is open.

## UI

| Where | What |
|---|---|
| agent trace, under a stage | a gate card (`gate-card`): the gate, pass, fail or pause (`gate-outcome`), the reason (`gate-reason`), each sensor run (name, result, duration) with its tail folded (`gate-run-tail`) |
| queue panel, per entry | a "Digest" button (`queue-row-digest`) when the entry is in `RunSnapshot.digests`; opens the digest view (`digest-view`) |
| pause card | the digest link (`pause-digest-link`), when the pause wrote one |
