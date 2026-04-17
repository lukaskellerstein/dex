# Contract: `src/core/runs.ts`

**Status**: Authoritative for the module's public surface. Implementation must conform. Internal helpers are not part of the contract.

## Location

`src/core/runs.ts`

## Invariants

1. **Pure Node only.** No imports from `electron`, `src/main/*`, or `src/renderer/*`. Allowed imports: `node:fs`, `node:path`, `node:os`, `node:crypto`, and sibling pure modules in `src/core/`.
2. **Sync I/O.** All file operations are synchronous. Caller holds `.dex/state.lock`.
3. **Atomic writes.** Every write to a `<runId>.json` uses write-tmp-and-rename. Never direct overwrite.
4. **No process global state.** All functions take `projectDir` explicitly. No singletons, no cached handles.

---

## Exported types

```ts
export type RunMode = "loop" | "build" | "plan";
export type RunStatus = "running" | "completed" | "paused" | "failed" | "stopped" | "crashed";
export type PhaseStatus = "running" | "completed" | "failed" | "stopped" | "crashed";
export type SubagentStatus = "running" | "ok" | "failed" | "crashed";
export type StepType =
  | "user_message" | "assistant_message" | "agent_text" | "system_message"
  | "tool_call" | "tool_result" | "skill_invoke" | "subagent_start" | "subagent_stop";

export interface SubagentRecord { /* see data-model.md § 3 */ }
export interface PhaseRecord    { /* see data-model.md § 2 */ }
export interface RunRecord      { /* see data-model.md § 1 */ }
export interface StepRecord     { /* see data-model.md § 4 */ }
export interface SpecStats {
  totalCostUsd: number;
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  phasesWithTraces: number;
}
```

---

## Exported functions

### Directory helpers

#### `runsDir(projectDir: string): string`
Returns `<projectDir>/.dex/runs`. Pure function, no I/O.

#### `ensureRunsDir(projectDir: string): void`
Creates `<projectDir>/.dex/runs` if missing. Idempotent. `mkdir -p` semantics.

---

### Low-level I/O

#### `writeRun(projectDir: string, run: RunRecord): void`

Writes `run` to `<projectDir>/.dex/runs/<run.runId>.json` atomically (write-tmp-and-rename). Creates the `runs/` directory if missing.

**Errors**:
- Throws `Error` if `run.runId` is empty or contains a path separator.
- Filesystem errors propagate (ENOSPC, EACCES, etc.).

#### `readRun(projectDir: string, runId: string): RunRecord | null`

Reads `<projectDir>/.dex/runs/<runId>.json` and `JSON.parse`s it. Returns `null` if the file does not exist. Throws on parse failure (the caller decides whether to treat as corruption).

#### `listRuns(projectDir: string, limit?: number): RunRecord[]`

Reads every `*.json` file in `<projectDir>/.dex/runs/`, parses each, sorts by `startedAt` descending, and returns the first `limit` (default: 50).

**Corruption handling**: Files that fail `JSON.parse` are skipped; a warning is logged via `console.warn` with the filename. The function never throws due to a malformed file.

**Performance contract**: ≤50 ms for 100 runs of ~20 KB each (cold SSD). See R-001.

---

### Mutation helpers

#### `updateRun(projectDir: string, runId: string, mutator: (r: RunRecord) => void): RunRecord`

Read-mutate-write cycle. Reads the run, applies `mutator` (mutates in place), writes it back atomically. Returns the updated record.

**Errors**: throws `Error("run <runId> not found")` if `readRun` returns `null`.

**Contract for mutators**: must be synchronous. Must not retain references to the record beyond the callback.

#### `startRun(projectDir: string, run: Omit<RunRecord, "endedAt" | "totalCostUsd" | "totalDurationMs" | "phasesCompleted" | "phases" | "failureCounters" | "loopsCompleted">): RunRecord`

Creates a new run file with skeleton content:
- `status: "running"`
- `endedAt: null`
- `totalCostUsd: 0`
- `totalDurationMs: null`
- `phasesCompleted: 0`
- `phases: []`
- `failureCounters: {}`
- `loopsCompleted: 0`
- `writerPid: process.pid` (caller supplies via the `run` argument)

Returns the written `RunRecord`.

#### `completeRun(projectDir: string, runId: string, status: RunStatus, totalCostUsd: number, totalDurationMs: number, phasesCompleted: number): void`

Sets terminal fields on the run: `status`, `totalCostUsd`, `totalDurationMs`, `phasesCompleted`, `endedAt = new Date().toISOString()`. Uses `updateRun` internally.

#### `updateRunLoopsCompleted(projectDir: string, runId: string, loopsCompleted: number): void`

Sets `run.loopsCompleted = loopsCompleted`.

---

### Phase helpers

#### `startPhase(projectDir: string, runId: string, phase: Omit<PhaseRecord, "endedAt" | "costUsd" | "durationMs" | "subagents" | "inputTokens" | "outputTokens" | "checkpointTag" | "candidateSha">): void`

Appends a new `PhaseRecord` to `run.phases` with:
- `endedAt: null`
- `costUsd: 0`
- `durationMs: null`
- `subagents: []`
- `inputTokens: null`
- `outputTokens: null`
- `checkpointTag: null`
- `candidateSha: null`

Caller supplies `phaseTraceId`, `runId`, `specDir`, `phaseNumber`, `phaseName`, `stage`, `cycleNumber`, `featureSlug`, `startedAt`, `status: "running"`.

#### `completePhase(projectDir: string, runId: string, phaseTraceId: string, patch: Partial<PhaseRecord> & { status: PhaseStatus }): void`

Finds the phase with the matching `phaseTraceId` inside `run.phases` and applies `patch`, plus sets `endedAt = new Date().toISOString()` and computes `durationMs` if not supplied.

Also recomputes `run.totalCostUsd` as the sum of `phases[].costUsd` where `status ∈ {"completed", "failed"}`, and increments `run.phasesCompleted` if `patch.status === "completed"`.

**No-op behavior**: if no phase matches, logs a warning and returns without error — matches today's lenient DB UPDATE semantics.

---

### Subagent helpers

#### `recordSubagent(projectDir: string, runId: string, phaseTraceId: string, sub: SubagentRecord): void`

Upserts by `(phaseTraceId, sub.id)`:
- If a subagent with the same `id` already exists in the target phase, `Object.assign` its fields with `sub`'s.
- Otherwise, appends.

Used for both `subagent_start` and `subagent_stop` lifecycle events.

---

### Failure counter helpers

#### `getFailureCount(projectDir: string, runId: string, specDir: string): { impl: number; replan: number }`

Reads `run.failureCounters[specDir]`, returning `{ impl: 0, replan: 0 }` if the key is missing.

#### `upsertFailureCount(projectDir: string, runId: string, specDir: string, impl: number, replan: number): void`

Sets `run.failureCounters[specDir] = { impl, replan }`.

#### `resetFailureCount(projectDir: string, runId: string, specDir: string): void`

Equivalent to `upsertFailureCount(projectDir, runId, specDir, 0, 0)`.

---

### Crash-recovery sweep

#### `reconcileCrashedRuns(projectDir: string, aliveCheck?: (pid: number) => boolean): void`

For every run in `<projectDir>/.dex/runs/` with `status === "running"`, if `aliveCheck(run.writerPid)` returns `false`, set `status = "crashed"`, `endedAt = now`, and for every `phase` with `status === "running"` set it to `"crashed"` with the same `endedAt`, and same for subagents.

Default `aliveCheck` uses `process.kill(pid, 0)` with a try/catch — returning `true` if the kill succeeds (process exists) or `false` if `ESRCH` (no such process).

Called once at orchestrator entry points (before starting any new run), mirroring today's `cleanupOrphanedRuns` (`database.ts:136`).

---

### Steps helpers — `steps.jsonl`

#### `appendStep(projectDir: string, runId: string, phaseSlug: string, phaseNumber: number, step: StepRecord): void`

Appends a single line (`JSON.stringify(step) + "\n"`) to `<LOGS_ROOT>/<projectName>/<runId>/phase-<phaseNumber>_<phaseSlug>/steps.jsonl`. Creates the directory if missing (the orchestrator usually has already created it for `agent.log`).

Derives `projectName` as `path.basename(projectDir)` — consistent with today's `RunLogger` constructor (`orchestrator.ts:122`).

#### `readSteps(projectDir: string, runId: string, phaseSlug: string, phaseNumber: number): StepRecord[]`

Reads the same file, splits on `\n`, discards empty lines, `JSON.parse`s each remaining line. Lines that fail to parse are skipped with a `console.warn`. Returns `[]` if the file does not exist (FR-011's empty-state contract).

Performance contract: ≤50 ms for 500 steps of ~200 bytes each.

---

### Derived views

#### `cycleSummary(run: RunRecord): CycleSummaryRow[]`

Returns one row per `cycleNumber` present in `run.phases`, with total cost / duration / stage list. See data-model.md § 7.

#### `getSpecAggregateStats(projectRuns: RunRecord[], specDir: string): SpecStats`

Latest-per-phase aggregation across all runs of a project for the given `specDir`. See data-model.md § 7.

---

## Testing contract

Unit tests live in `src/core/runs.test.ts` and run under `node --test`.

Required cases:
1. `writeRun` + `readRun` round-trip preserves every field.
2. `listRuns` returns empty array for a non-existent directory; returns a single result for one file; sorts by `startedAt` descending for multiple files.
3. `listRuns` skips malformed JSON and continues.
4. `updateRun` is atomic under simulated crash: no orphan `.tmp` visible to `listRuns`.
5. `startPhase` + `completePhase` round-trip: phase appears with correct status progression, `run.totalCostUsd` recomputes.
6. `recordSubagent` upsert semantics: calling twice with the same `id` updates in place, does not duplicate.
7. `reconcileCrashedRuns` with a stub `aliveCheck` correctly transitions a stale "running" run to "crashed".
8. `appendStep` + `readSteps` round-trip, including newline handling and parse-failure skip on a partial last line.
