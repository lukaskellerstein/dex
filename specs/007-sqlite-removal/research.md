# Phase 0: Research & Decisions

**Feature**: 007-sqlite-removal
**Purpose**: Resolve every design unknown introduced by the spec before writing the data model and contracts.

The spec deliberately left implementation choices open. This file records the decisions that lock down how the JSON-file approach actually behaves, plus the alternatives each was weighed against.

---

## R-001: Where does per-phase tool-call detail live?

### Decision

**One append-only JSON-lines file per phase**, written alongside the existing `agent.log`:

```
~/.dex/logs/<project>/<runId>/phase-<N>_<slug>/
├── agent.log       # existing — human-tailable log (unchanged)
├── steps.jsonl     # NEW — one JSON object per line, one per AgentStep
└── subagents/      # existing — unchanged
```

Each line is `JSON.stringify(AgentStep) + "\n"`. Reading is a streaming line-split + `JSON.parse` per line.

### Rationale

- The spec's README hand-waves "log lines are already JSON-structured, parsing is a streaming split + filter". In reality, today's `agent.log` stores DEBUG log messages (e.g., `emitAndStore: step type=tool_call {id, seq}`) — **not** full step records. The authoritative step data lives in SQL today; something has to replace it.
- A sibling `steps.jsonl` file keeps `agent.log` strictly for humans tailing live runs (short messages, ergonomic grep) and gives the renderer a machine-authoritative replay source.
- Append-only JSONL is the right write pattern: steps arrive monotonically during a phase (hooks append as events fire), no rewrites, crash-friendly (a half-written final line is detected by JSON.parse and skipped — the rest of the file remains valid).
- The existing `insertStep(...)` call in `orchestrator.ts:561, 948, 1098` etc. already runs inside the hook callbacks. Swapping `insertStep` for `appendStep(phaseDir, step)` is a mechanical one-line-per-site change.
- Benchmark envelope: for 500 steps with ~200 bytes average per serialized step (content truncated to 10k already, but most steps are short) ≈ 100 KB per file. Disk reads of 100 KB from a warm buffer cache complete in sub-millisecond; cold reads on SSD are 2–5 ms. Meets SC-004 (≤100 ms first frame) with 20× headroom.

### Alternatives considered

- **Extend `agent.log` to include a full JSON step record per line.** Rejected — mixes human and machine formats, breaks existing log grep patterns (`grep ERROR agent.log` returns gigantic step blobs), and requires the UI to tolerate non-step lines interleaved with step lines.
- **Store steps in the run JSON itself under `phases[].steps[]`.** Rejected — run JSON would grow to megabytes, the "read-mutate-write on every append" pattern becomes O(n²) over a phase's lifetime, and the spec's performance target for `readRun` would be violated.
- **Per-step individual files.** Rejected — filesystem metadata cost dwarfs the data at ~500 files per phase.
- **CBOR or a binary framing.** Rejected — violates Story 1 (inspect with plain tooling). Plain-text JSONL is readable with `jq`, `head`, `tail`, `grep`.

---

## R-002: Atomic write strategy for run JSON mutations

### Decision

Every write to `<projectDir>/.dex/runs/<runId>.json` uses the **write-temp-and-rename** pattern synchronously:

```ts
export function writeRun(projectDir: string, run: RunRecord): void {
  ensureRunsDir(projectDir);
  const target = path.join(runsDir(projectDir), `${run.runId}.json`);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(run, null, 2));
  fs.renameSync(tmp, target);
}
```

All orchestrator call sites wrap mutation through `updateRun(projectDir, runId, mutator)`, which reads → mutates → writes atomically.

### Rationale

- POSIX `rename(2)` is atomic within a single filesystem: either the old file is in place or the new file is in place — never a half-written blob.
- A crash mid-write leaves at most a `<runId>.json.tmp` file. The `listRuns` / `readRun` helpers filter for the `.json` suffix, so stale `.tmp` files are invisible to the UI. A follow-up prune script (already mentioned in spec as out-of-scope) can clean them.
- Sync I/O is fine here — this code runs in the orchestrator event loop, not the renderer, and each write is a single ~20 KB file-write on a hot path that fires at most a few times per second (phase start, phase end, subagent events).
- Keeps the module free of a concurrency primitive (locks, mutexes, queues). The single-writer invariant (`.dex/state.lock`) plus atomic rename is sufficient.

### Alternatives considered

- **Plain `fs.writeFileSync(target, ...)`**. Rejected — a power loss mid-write leaves a truncated `.json` that `listRuns` would either crash on or silently treat as empty. Violates Edge Case "corrupted run JSON" more often than necessary.
- **File locks (e.g., `proper-lockfile`)**. Rejected — adds a dependency; the `.dex/state.lock` PID file already enforces single-writer at the process level.
- **Async writes (`fs.promises.writeFile`)**. Rejected — the orchestrator is not CPU-starved, and sync writes simplify the call-site semantics (the caller can assume the write is durable by the time the helper returns).
- **Durable fsync between write and rename**. Rejected — overkill; Dex audit data is not a financial ledger. The rename atomicity alone covers the overwhelming majority of crash scenarios; a worst-case loss of the last few seconds of writes (page cache dirty pages lost on kernel panic) is acceptable.

---

## R-003: Field naming — SQL snake_case rows vs. JSON camelCase records

### Decision

**New JSON records use camelCase** throughout (`runId`, `projectDir`, `specDir`, `costUsd`, `startedAt`, `endedAt`, `totalCostUsd`, `phaseTraceId`, `cycleNumber`, `featureSlug`, `inputTokens`, `outputTokens`, etc.).

Renderer hooks and components are **updated in place** to consume camelCase. The two legacy type names (`RunRow`, `PhaseTraceRow`) are renamed to `RunRecord`, `PhaseRecord` and re-exported from `src/core/runs.ts` for import by the renderer. Two legacy helper types stay SQL-shaped only during the migration window itself: we do the rename atomically in the same PR — no transition/adapter layer.

### Rationale

- The spec's FR-008 preserves the *IPC method* names (`listRuns`, `getRun`, `getPhaseSubagents`, `getPhaseSteps`) but says nothing about field names. FR-003 requires that the same *set* of fields appear in JSON — it does not require preserving snake_case.
- The rest of the Dex codebase is camelCase TypeScript. Keeping SQL-era snake_case on JSON records (`total_cost_usd`) would be an ongoing foreign-body in otherwise idiomatic code.
- An adapter layer (map snake_case rows → camelCase records at the IPC boundary) would be 20+ lines of pointless mapping and would outlive the transition indefinitely.
- The renderer edit surface is small: `src/renderer/hooks/useOrchestrator.ts` (~8 field references), `src/renderer/hooks/useProject.ts` (~3 references), `src/renderer/electron.d.ts` (type definitions only). Manageable in one PR.

### Alternatives considered

- **Keep snake_case in JSON** (direct SQL column names → JSON keys). Rejected — bleeds SQL conventions into the long-term API and contradicts the rest of the codebase.
- **Dual-name adapter layer** (`RunRow` adapter that emits both casings). Rejected — speculative "we might need it" abstraction forbidden by Constitution Principle IV.
- **Keep `RunRow` type names; change field names only**. Rejected — a type literally named `Row` is a lie once it represents a JSON object; renaming to `Record` is simultaneously honest and cheap.

---

## R-004: Legacy `~/.dex/db/` cleanup behavior

### Decision

**One-shot silent removal on Electron `app.whenReady`**, before any IPC handlers are registered:

```ts
// src/main/index.ts, inside createWindow() or preceding it
const legacyDb = path.join(os.homedir(), ".dex", "db");
if (fs.existsSync(legacyDb)) {
  fs.rmSync(legacyDb, { recursive: true, force: true });
  console.info("[dex] removed legacy SQLite directory:", legacyDb);
}
```

One `console.info` line lands in `~/.dex/dev-logs/electron.log` on the first launch post-upgrade. Subsequent launches find the directory absent and do nothing (no log, no cost).

### Rationale

- Matches FR-006 literally: "detect and remove … and log that it did so". One `console.info` to stderr is sufficient — this is not a surface the user interacts with, and the log is there for post-mortem diagnosis, not for the user's feed.
- No UI prompt. Dev-phase; no user consent dance needed. The spec's Assumption "dev-phase policy" covers this.
- No migration path to attempt. FR-013 forbids conversion. The cleanup is a pure delete.
- Runs before any IPC handler; ensures the DB file is fully gone before the renderer boots and starts calling `history:list-runs`.

### Alternatives considered

- **Rename `~/.dex/db/` to `~/.dex/db-backup-<timestamp>/` instead of deleting.** Rejected — "dev-phase" spec guarantee means the old data has no value; a backup is retention theater that eventually leaks disk space.
- **Show a one-time migration notice in the UI.** Rejected — overengineering for a dev-phase tool with no production users.
- **Lazy cleanup on first `listRuns` call.** Rejected — complicates the otherwise trivial `listRuns` implementation and leaves the legacy directory on disk in the common "user opens app, browses files, closes" case.

---

## R-005: Which SQL tables map to which JSON fields?

### Decision

Mapping summary — lock down before writing the data model:

| Legacy SQL table     | New home                                                       | Collapse strategy                                                                                       |
|---                   |---                                                             |---                                                                                                      |
| `runs`               | `<projectDir>/.dex/runs/<runId>.json` top-level fields          | 1:1 — one row → one file. `project_dir` is implicit (location). `created_at` → `startedAt`. `completed_at` → `endedAt`. `total_cost_usd` → `totalCostUsd`. |
| `phase_traces`       | `phases[]` inside the run JSON                                  | 1:many per run. `phase_number` → `phaseNumber`. `phase_name` → `stage` (the stage identifier, not free-form name). `cost_usd` → `costUsd`. Timings renamed to `startedAt` / `endedAt` / `durationMs`. |
| `subagent_metadata`  | `phases[].subagents[]` inside the owning phase                  | 1:many per phase. `subagent_id` → `id`. `subagent_type` → `type`. `started_at` / `completed_at` → `startedAt` / `endedAt`. |
| `trace_steps`        | `~/.dex/logs/<project>/<runId>/phase-<N>_*/steps.jsonl`         | One table row → one JSONL line. Moves out of run JSON entirely (R-001). Includes `sequenceIndex`, `type`, `content`, `metadata`, `durationMs`, `tokenCount`, `createdAt`. |
| `loop_cycles`        | **derived from `phases[]` grouped by `cycleNumber`**            | No separate storage. UI aggregates at display time. Spec README explicitly states this. |
| `failure_tracker`    | `<projectDir>/.dex/runs/<runId>.json` — `phases[].failureCount` (new optional field), plus per-run counters via a small helper | `impl_failures` / `replan_failures` aren't per-phase in today's SQL — they're per-run-per-specDir. Moving them into `phases[]` aggregated by specDir is the natural fit; the `getFailureRecord` / `upsertFailureRecord` helpers read/mutate the matching run JSON. |

### Rationale

- This collapses 5 tables + 1 pseudo-table into 2 on-disk surfaces (the run JSON and the phase's steps.jsonl). Simpler surface = fewer invariants to maintain.
- `loop_cycles` being derivable rules out a parallel `cycles[]` array inside the run JSON — the cycle number already lives on each phase; summing `costUsd` / `durationMs` by `cycleNumber` yields the same data the old table held.
- `failure_tracker` collapses cleanly because its keys (`runId`, `specDir`) both live inside the run JSON; turning it into a per-run map `failureCounters: Record<specDir, {impl, replan}>` keeps the existing helper signatures (`upsertFailureRecord`, `getFailureRecord`, `resetFailures`) trivial to port.

### Alternatives considered

- **Keep `loop_cycles` as a separate `cycles[]` array in the run JSON.** Rejected — README explicitly says derive-on-display. No reason to store the same data twice.
- **Promote `failureCounters` to a separate file (`<projectDir>/.dex/failures.json`).** Rejected — the data has no lifetime independent of its run, and splitting creates a two-file invariant (delete run → also delete failure counters). Keeping it on the run is cleaner.

---

## R-006: Renderer/IPC shape — what does each handler return?

### Decision

The four primary IPC handlers keep their method names but return the new camelCase shapes. Two existing handlers gain a `projectDir` parameter they currently lack.

| IPC channel                        | New signature                                                               | Returns                                                     |
|---                                 |---                                                                          |---                                                          |
| `history:list-runs`                | `(projectDir: string, limit?: number) => Promise<RunRecord[]>`              | `RunRecord[]`, sorted by `startedAt` desc                   |
| `history:get-run`                  | `(projectDir: string, runId: string) => Promise<RunRecord \| null>`         | Single `RunRecord` (phases inline, subagents inline)       |
| `history:get-latest-project-run`   | `(projectDir: string) => Promise<RunRecord \| null>`                        | Latest `RunRecord` for the project                         |
| `history:get-phase-steps`          | `(projectDir: string, runId: string, phaseTraceId: string) => Promise<StepRecord[]>` | Parsed from `steps.jsonl`                        |
| `history:get-phase-subagents`      | `(projectDir: string, runId: string, phaseTraceId: string) => Promise<SubagentRecord[]>` | From `phases[].subagents` in the run JSON          |
| `history:get-latest-phase-trace`   | `(projectDir: string, specDir: string, phaseNumber: number) => Promise<PhaseRecord \| null>` | Scan all run JSONs in `.dex/runs/` for the project |
| `history:get-spec-phase-stats`     | `(projectDir: string, specDir: string) => Promise<PhaseRecord[]>`           | Latest `PhaseRecord` per `phaseNumber` for that specDir    |
| `history:get-spec-aggregate-stats` | `(projectDir: string, specDir: string) => Promise<SpecStats>`               | Sum of latest-per-phase costs/durations/tokens             |

### Rationale

- The spec's FR-014 mandates an explicit `projectDir` parameter on every data-access path. Five of the eight handlers already carry it; `listRuns`, `getRun`, and the two phase-level ones (`getPhaseSteps`, `getPhaseSubagents`) need it added.
- `getPhaseSteps` + `getPhaseSubagents` also need `runId` because the new storage is "per-run" rather than "global with a phaseTraceId index". The renderer already knows `runId` wherever it has a `phaseTraceId` (verified: every call site in `useOrchestrator.ts:249, 782, 824, 879` is inside a scope where `runId` is already in hand).
- The `getSpecPhaseStats` / `getSpecAggregateStats` handlers perform an in-memory aggregation across the project's runs. At ~50 runs × 20 KB, full scan is <5 ms — well under the SC-004 budget.

### Alternatives considered

- **Scope every call to the "currently open project" in main-process state instead of passing `projectDir`.** Rejected — creates hidden global state, couples history IPC to the orchestrator's "active project" concept, and breaks future multi-window scenarios. Explicit parameter is trivially more code and much cleaner.
- **Index run JSONs with a sidecar index file (`<projectDir>/.dex/runs/index.json`).** Rejected — premature optimization. At spec-stated scale (≤50 runs), full-directory reads beat maintaining an index. The file system already provides a directory listing.

---

## R-007: Crash recovery — what happens to "running" state on orchestrator restart?

### Decision

On every orchestrator entry point, scan the active project's `<projectDir>/.dex/runs/*.json`. For any run with `status === "running"` whose PID (recorded at run start as a new top-level field `writerPid`) is no longer alive, mark status `crashed` and set `endedAt` to the scan timestamp. Same rule for nested `phases[]` entries and their `subagents[]`.

This mirrors the existing `cleanupOrphanedRuns` logic (`database.ts:136-147`), preserving the same behavior contract the UI already expects.

### Rationale

- The spec edge case "concurrent writers" is ruled out by the lock file. But "orchestrator SIGKILL'd mid-run" is a real scenario (laptop shut, power loss, crash). Today SQLite's startup code catches this and reconciles "running" → "crashed". The new implementation must do the same or the UI will display forever-running phantom runs.
- Recording `writerPid` at run start is a minimal schema addition and makes the dead-process check unambiguous (PID not alive on the current host = writer dead). Cross-machine committed runs will always have a dead PID, which is correct — if the run JSON was committed by someone else on a different machine, we have no way of knowing they were live, and "crashed" is the safe conservative label.
- Doing this on every orchestrator entry point (not in a separate background sweep) keeps the logic simple and local.

### Alternatives considered

- **Detect crashes via file age (no heartbeat updates for >N seconds → crashed).** Rejected — fragile across laptop-sleep scenarios. A heartbeat in the run JSON would require repeated writes, which is the behavior we want to minimize.
- **Rely solely on `.dex/state.lock` staleness.** Rejected — the lock file guards the orchestrator's in-flight state (`state.json`), not individual run JSONs. A stale run JSON can outlive the lock cleanly by virtue of being in a different file.

---

## R-008: Test strategy for `src/core/runs.ts`

### Decision

- **Unit tests** via Node's built-in `node --test` runner (no Jest/Vitest dependency added). Covered scenarios: `writeRun`/`readRun` round-trip; `listRuns` sort order and limit; `updateRun` read-mutate-write; `startPhase` / `completePhase` / `recordSubagent` state machine; `writeRun` atomicity (kill-between-tmp-and-rename simulation); corrupted-JSON skip-and-warn; missing directory returns empty list.
- **Integration test** via the existing `reset-example-to.sh after-tasks` fixture: after one loop cycle, assert that `<projectDir>/.dex/runs/<runId>.json` exists, has `status === "completed"`, and that `phases.length >= 4` (specify, plan, tasks, implement).
- **UI parity test** via electron-chrome MCP: before/after screenshots of (a) runs list, (b) run detail, (c) trace view for a single phase — same example project, same fixture, same cycle.

### Rationale

- `node --test` ships with Node 20+ (Electron 41 bundles Node 20). Zero added dependency, zero configuration. Meets Constitution IV (Simplicity First).
- `reset-example-to.sh` already exists as the canonical end-to-end harness per `.claude/rules/06-testing.md` § 4c. Using it for this feature's integration test costs nothing extra.
- Screenshot-diff via MCP is the cheapest way to prove UI parity (SC-007).

### Alternatives considered

- **Add Vitest for unit tests.** Rejected — a new dev dependency for ~200 lines of test code. `node --test` does the job.
- **Spawn a headless Electron harness for unit tests.** Rejected — `src/core/` is already platform-agnostic (Constitution II). Running unit tests under plain Node is simpler and faster.
