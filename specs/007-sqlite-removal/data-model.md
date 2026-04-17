# Data Model: 007-sqlite-removal

**Authoritative shapes for the on-disk audit-trail files after SQLite retirement.**

Two surfaces are introduced by this feature. Everything else in Dex's on-disk layout (described in `CLAUDE.md § On-Disk Layout`) is unchanged.

- `<projectDir>/.dex/runs/<runId>.json` — one file per run, per project. Authoritative for run/phase/subagent summary data.
- `~/.dex/logs/<project>/<runId>/phase-<N>_<slug>/steps.jsonl` — one file per phase. Authoritative for the tool-call-level step stream.

All TypeScript types below live in `src/core/runs.ts` and are re-exported to the renderer through `src/renderer/electron.d.ts`.

---

## 1. `RunRecord` — `<projectDir>/.dex/runs/<runId>.json`

### Shape

```ts
export type RunMode = "loop" | "build" | "plan";
export type RunStatus = "running" | "completed" | "paused" | "failed" | "stopped" | "crashed";

export interface RunRecord {
  runId: string;                  // UUID v4; matches the JSON filename stem
  mode: RunMode;
  model: string;                  // e.g. "claude-opus-4-7"
  specDir: string;                // absolute or project-relative; matches the current behavior
  startedAt: string;              // ISO 8601, millisecond precision
  endedAt: string | null;
  status: RunStatus;
  totalCostUsd: number;           // sum of phase.costUsd for terminal phases
  totalDurationMs: number | null; // ms from startedAt to endedAt; null while running
  phasesCompleted: number;        // count of phases with status === "completed"
  writerPid: number;              // pid of the orchestrator that wrote this file; used by R-007 crash recovery
  description: string | null;     // optional human-readable run description (from today's `runs.description`)
  fullPlanPath: string | null;    // optional build-mode full-plan reference (from today's `runs.full_plan_path`)
  maxLoopCycles: number | null;
  maxBudgetUsd: number | null;
  loopsCompleted: number;         // monotonic cycle counter, mirrors today's `runs.loops_completed`
  phases: PhaseRecord[];          // in phase-start order
  failureCounters: Record<string, { impl: number; replan: number }>;
                                  // keyed by specDir, replaces the failure_tracker table
}
```

### Field semantics

- **`runId`**: UUID assigned at run creation; file is named `<runId>.json`. Must match the value inside the file — if they diverge, `listRuns` emits a warning and prefers the filename.
- **`writerPid`**: the orchestrator's `process.pid` captured when the run file is first written. On orchestrator startup, any run with `status === "running"` whose PID is not alive gets its status set to `"crashed"` and `endedAt` set to the scan timestamp (R-007).
- **`failureCounters`**: replaces the `failure_tracker` SQL table. Keyed by `specDir` because a run can pass through multiple specs (loop mode). Values track how many consecutive implementation or replan failures have occurred for that spec within the current run.
- **`specDir`**: the run-level spec directory (first spec the run targets). Individual phases carry their own `specDir` in `phases[]` because loop-mode runs visit multiple specs.

### State transitions

```
status: running ─┬─> completed
                 ├─> failed
                 ├─> stopped     (user-triggered abort)
                 ├─> paused      (loop paused, may resume later)
                 └─> crashed     (writerPid dead at startup scan)

paused ─resume─> running
```

Transitions are written only by the orchestrator (under `.dex/state.lock`). The UI never mutates a run.

### Validation rules

- **FR-001**: file path MUST be `<projectDir>/.dex/runs/<runId>.json`. Helpers construct the path from the two arguments; neither may be empty.
- **FR-002**: initial write on run start includes `status = "running"`, `phases = []`, `endedAt = null`, `totalDurationMs = null`, `phasesCompleted = 0`, `writerPid = process.pid`.
- **FR-010**: a file that fails `JSON.parse` or fails to match this shape is skipped by `listRuns` with a one-line warning log; it is not rewritten or deleted.
- **Timestamps**: ISO-8601 with millisecond precision (`new Date().toISOString()`). Sorted lexicographically — this is correct for ISO-8601 UTC strings.

---

## 2. `PhaseRecord` — `RunRecord.phases[]`

### Shape

```ts
export type PhaseStatus = "running" | "completed" | "failed" | "stopped" | "crashed";

export interface PhaseRecord {
  phaseTraceId: string;           // UUID v4, stable identifier used across IPC, DB replacement, and logs
  runId: string;                  // denormalized — allows PhaseRecord to be passed around without its parent
  specDir: string | null;         // spec this phase belongs to; nullable for loop-wrapper phases
  phaseNumber: number;            // monotonic within a run (1-based); in loop mode, resets? No — it monotonically increases across all phases of the run.
  phaseName: string;              // free-form display name, e.g. "loop:specify", "implement", "verify"
  stage: LoopStageType | null;    // structured stage identifier when the phase is one of the loop stages; null for legacy non-loop phases
  cycleNumber: number | null;     // loop cycle 1..N for loop-mode phases; null for build-mode phases
  featureSlug: string | null;     // derived from specDir at write time (basename); null if unavailable
  startedAt: string;
  endedAt: string | null;
  status: PhaseStatus;
  costUsd: number;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  subagents: SubagentRecord[];    // in start order
  // Populated by 008-interactive-checkpoint; null before that feature ships:
  checkpointTag: string | null;
  candidateSha: string | null;
}
```

### Field semantics

- **`phaseTraceId`**: same identifier today's SQL rows expose as `phase_traces.id`. Renderer carries it through IPC when navigating from a phase in the runs list to the trace view.
- **`phaseNumber`**: preserves today's monotonic-within-run counter (`phase_traces.phase_number`). In loop mode the orchestrator currently passes `cycleNum` here; that behavior is preserved — see `orchestrator.ts:2000` / `:2214` / `:2236` / `:2506`.
- **`stage`**: structured loop-stage identifier (`specify`, `plan`, `tasks`, `implement`, ...). Useful for the UI to render stage-specific icons without string-matching `phaseName`. When the orchestrator creates a phase via `insertLoopCycle` / loop-phase path, `stage` is populated; for pre-existing non-loop paths (build mode), it may be `null`.
- **`featureSlug`**: convenience field the renderer needs and which is awkward to derive in the view. Computed by `runs.ts` helpers at write time as `path.basename(specDir)` (e.g., `007-sqlite-removal`).
- **`checkpointTag`**, **`candidateSha`**: optional slots reserved for the 008-interactive-checkpoint feature. This feature writes them as `null` and never reads them — they exist solely to lock the shape early so 008 does not need a schema migration.

### State transitions

```
status: running ─┬─> completed
                 ├─> failed
                 ├─> stopped
                 └─> crashed   (parent run marked crashed)
```

### Validation rules

- **FR-002**: `startPhase` appends a new `PhaseRecord` with `status = "running"`, `endedAt = null`, `subagents = []`, costs/durations zeroed-or-null.
- **FR-003**: every consumer of a phase summary (UI cost/duration display) reads these fields directly from the parent `RunRecord`; no JOINs, no per-phase file reads.
- **`costUsd` aggregation**: `RunRecord.totalCostUsd = sum(phases[].costUsd where status in ('completed','failed'))`. Maintained at phase-completion time by `completePhase`.

---

## 3. `SubagentRecord` — `PhaseRecord.subagents[]`

### Shape

```ts
export type SubagentStatus = "running" | "ok" | "failed" | "crashed";

export interface SubagentRecord {
  id: string;                    // subagent_id from the SDK (stable per spawn)
  type: string;                  // e.g. "specify", "plan", "code-reviewer"
  description: string | null;    // free-form from the SDK hook
  status: SubagentStatus;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  costUsd: number;               // defaults to 0; SDK does not attribute cost per subagent today, kept as a placeholder
}
```

### State transitions

```
status: running ─┬─> ok
                 ├─> failed
                 └─> crashed    (parent phase status === "crashed")
```

### Validation rules

- Identity is `(phaseTraceId, id)`. Two subagents with the same `id` within the same phase are the same entity — `recordSubagent` uses upsert-by-id semantics (see `src/core/runs.ts` contract).
- Duration is computed when `status` transitions to terminal.

---

## 4. `StepRecord` — `steps.jsonl` (one per line)

### File location

`~/.dex/logs/<project>/<runId>/phase-<N>_<slug>/steps.jsonl`

One JSON object per line, newline-terminated. Append-only during the phase's lifetime; read-only after the phase ends.

### Shape

```ts
export type StepType =
  | "user_message"
  | "assistant_message"
  | "agent_text"
  | "system_message"
  | "tool_call"
  | "tool_result"
  | "skill_invoke"
  | "subagent_start"
  | "subagent_stop";

export interface StepRecord {
  id: string;                      // unique per step; UUID or SDK-provided identifier
  phaseTraceId: string;            // denormalized for standalone parsing (the file path already encodes this, but inclusion makes each line self-describing)
  sequenceIndex: number;           // monotonic within the phase, starting at 0
  type: StepType;
  content: string | null;          // truncated to 10,000 characters by the orchestrator (existing behavior)
  metadata: Record<string, unknown> | null;
                                   // includes running `costUsd` / `inputTokens` / `outputTokens` / `belongsToSubagent`
  durationMs: number | null;       // null for messages; populated for tool_call/tool_result
  tokenCount: number | null;
  createdAt: string;               // ISO-8601 ms precision
}
```

### Semantics

- **Append-only**: each step is a single `fs.appendFileSync(file, JSON.stringify(step) + "\n")`. A crash during append can leave a half-written final line; readers skip lines that fail `JSON.parse`.
- **Ordering**: by `sequenceIndex` ascending. The file order matches sequence order under normal operation; readers may reorder defensively if the orchestrator is ever extended with concurrent writers to the same file (not currently planned).
- **Size bound**: ~500 steps/phase × ~200 bytes/step ≈ 100 KB typical, 2 MB worst-case with unusually long content.

### Validation rules

- **FR-004**: step data does not duplicate into the `RunRecord` — `PhaseRecord` summarizes (`costUsd`, `durationMs`, `inputTokens`, `outputTokens`) and steps.jsonl carries the per-step detail.
- **FR-011**: if the file does not exist when the renderer opens a phase's trace, `getPhaseSteps` returns `[]` and the UI renders the "log file not found at `<path>`" empty state.
- **Pre-existing content truncation** (10k chars per `content` field) is preserved from today's `insertStep` implementation. Larger content is silently truncated at write time.

---

## 5. Project Audit Directory

### Path

`<projectDir>/.dex/runs/`

### Contents

- `*.json` — committed RunRecord files. Visible to `listRuns`.
- `*.json.tmp` — transient write-in-progress files produced by the atomic-rename pattern (R-002). Invisible to `listRuns`. Left behind by a crash mid-write; a follow-up prune script (out of scope) cleans them.

### Default visibility to git

Not listed in `.gitignore` by default — teams who want shared audit history commit the directory; users who prefer private traces add it themselves (FR-009). This feature does NOT modify the project's `.gitignore`.

### Lifetime

- Directory is created lazily on the first run for a project (`ensureRunsDir`).
- Never cleaned up by Dex. Growth management is user-controlled or a future prune script.

---

## 6. Legacy `~/.dex/db/` — removed

This path is explicitly **removed** on the first post-upgrade launch (R-004). It is not part of the new data model; listed here only to affirm the migration stance.

After launch:
- First launch post-upgrade: directory is `fs.rm`'d recursively. One `console.info` line to `~/.dex/dev-logs/electron.log`.
- Subsequent launches: directory is absent; no code path touches it.

---

## 7. Derived views (computed, not stored)

The spec README specifies that `loop_cycles` data is derivable. Spelling out the derivations:

### Cycle summary

```ts
function cycleSummary(run: RunRecord): Array<{ cycleNumber: number; costUsd: number; durationMs: number; stages: string[] }> {
  const byCycle = new Map<number, PhaseRecord[]>();
  for (const p of run.phases) {
    if (p.cycleNumber == null) continue;
    const list = byCycle.get(p.cycleNumber) ?? [];
    list.push(p);
    byCycle.set(p.cycleNumber, list);
  }
  return [...byCycle.entries()]
    .sort(([a], [b]) => a - b)
    .map(([cycleNumber, phases]) => ({
      cycleNumber,
      costUsd: phases.reduce((s, p) => s + p.costUsd, 0),
      durationMs: phases.reduce((s, p) => s + (p.durationMs ?? 0), 0),
      stages: phases.map((p) => p.stage ?? p.phaseName),
    }));
}
```

### Spec aggregate stats

```ts
function specAggregateStats(projectRuns: RunRecord[], specDir: string): SpecStats {
  // Latest phase per (phaseNumber, specDir) across all runs in the project
  const latest = new Map<number, PhaseRecord>(); // key: phaseNumber
  for (const run of projectRuns) {
    for (const phase of run.phases) {
      if (phase.specDir !== specDir) continue;
      const existing = latest.get(phase.phaseNumber);
      if (!existing || existing.startedAt < phase.startedAt) {
        latest.set(phase.phaseNumber, phase);
      }
    }
  }
  let totalCostUsd = 0, totalDurationMs = 0, totalInputTokens = 0, totalOutputTokens = 0;
  for (const p of latest.values()) {
    totalCostUsd += p.costUsd;
    totalDurationMs += p.durationMs ?? 0;
    totalInputTokens += p.inputTokens ?? 0;
    totalOutputTokens += p.outputTokens ?? 0;
  }
  return { totalCostUsd, totalDurationMs, totalInputTokens, totalOutputTokens, phasesWithTraces: latest.size };
}
```

These pure functions live in `src/core/runs.ts` alongside the I/O helpers and carry the same semantics today's SQL queries (`getSpecPhaseStats`, `getSpecAggregateStats`, `getLoopCycles`) express.

---

## 8. Cross-reference to spec requirements

| Spec FR  | Data-model element                                                 |
|---       |---                                                                 |
| FR-001   | `RunRecord` file at `<projectDir>/.dex/runs/<runId>.json`           |
| FR-002   | Skeleton write + in-place updates (`writeRun` / `updateRun`)        |
| FR-003   | `RunRecord`, `PhaseRecord`, `SubagentRecord` field set              |
| FR-004   | `StepRecord` in `steps.jsonl`, not duplicated in `RunRecord`        |
| FR-005   | Per-project location of `.dex/runs/` + lack of any global index     |
| FR-006   | Legacy `~/.dex/db/` removed per R-004                               |
| FR-007   | Module imports only `node:fs`, `node:path`, `node:crypto`, `node:os` |
| FR-008   | IPC handler names preserved (see `contracts/ipc-history.md`)        |
| FR-009   | No `.gitignore` mutation; default-included                          |
| FR-010   | Corrupted JSON skipped with warning; see `RunRecord` validation     |
| FR-011   | `StepRecord` empty-state + "log file not found" message             |
| FR-012   | Writes covered by existing `.dex/state.lock` — no new primitive     |
| FR-013   | No migration code — legacy DB is wiped, not converted (R-004)       |
| FR-014   | `projectDir` explicit on every data-access signature (R-006)        |
