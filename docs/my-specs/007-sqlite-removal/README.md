# 007 — Retire SQLite in favor of per-project JSON files

## Why this exists

Dex's audit trail (runs, phases, subagents, trace steps) lives in a single global SQLite database at `~/.dex/db/data.db`. This has three structural problems:

1. **Wrong locality.** Project audit data sits in a user-home DB, not in the project itself. Delete the project folder and zombie rows stay; move to another machine and history is gone; clone a project and none of its history travels.
2. **Opaque to tooling.** Debugging requires dropping into `sqlite3`. The most common operation ("show me what the last run did") is a multi-line SQL query instead of `cat … | jq`.
3. **Cross-project contamination.** Every query needs a `WHERE project = …` filter. Getting that wrong silently mixes runs from different projects.

The audit trail was always a structured summary alongside the per-run log tree in `~/.dex/logs/<project>/<runId>/` (see `.claude/rules/06-testing.md` § 4f.2). Treating it as a DB is overkill — at typical scale (10–50 runs per project × ~20 phases each ≈ <1000 rows), JSON files load into memory in milliseconds and aggregate faster than SQLite over the same data.

This feature retires SQLite and replaces it with per-project JSON files. It is independent of `008-interactive-checkpoint` and ships first, so the checkpoint feature builds on top of JSON storage natively without a dual-write migration phase.

**Dev-phase**: no backward compatibility. Existing `~/.dex/db/data.db` is wiped; existing audit data is lost; acceptable.

## Storage model

Per-project, under the project's existing `.dex/` directory:

```
<projectDir>/.dex/runs/
├── <runId-1>.json
├── <runId-2>.json
└── …
```

Each run = one JSON file, written at run start with skeleton content and updated throughout the lifecycle (phase start, phase complete, subagent events, run termination).

**Gitignore behavior**: `.dex/runs/` is NOT gitignored by default. It's committable — teams who want shared audit history push runs with the repo; individual users who prefer private traces add `.dex/runs/` to `.gitignore`. This choice is documented in `06-testing.md`, not enforced.

## Schema

```ts
// src/core/runs.ts

export type RunMode = "loop" | "build" | "plan";
export type RunStatus = "running" | "completed" | "paused" | "failed" | "stopped";
export type PhaseStatus = "running" | "completed" | "failed" | "stopped";
export type SubagentStatus = "running" | "ok" | "failed";

export interface SubagentRecord {
  id: string;
  type: string;               // "specify", "plan", etc.
  status: SubagentStatus;
  startedAt: string;          // ISO 8601
  endedAt: string | null;
  durationMs: number | null;
  costUsd: number;
}

export interface PhaseRecord {
  phaseTraceId: string;
  stage: LoopStageType;
  cycleNumber: number;
  featureSlug: string | null;   // derived from currentSpecDir if available
  startedAt: string;
  endedAt: string | null;
  status: PhaseStatus;
  costUsd: number;
  durationMs: number | null;
  inputTokens?: number;
  outputTokens?: number;
  subagents: SubagentRecord[];
  // Populated by the 008-checkpoint feature later; null before that ships:
  checkpointTag?: string | null;
  candidateSha?: string | null;
}

export interface RunRecord {
  runId: string;
  mode: RunMode;
  startedAt: string;
  endedAt: string | null;
  status: RunStatus;
  totalCostUsd: number;
  // Populated by 008; null before:
  attemptBranch?: string | null;
  parentRunId?: string | null;
  variantGroupId?: string | null;
  phases: PhaseRecord[];
}
```

Trace-step detail (individual tool calls within a phase) stays in the existing log files at `~/.dex/logs/<project>/<runId>/phase-<n>_*/agent.log` — that's already the authoritative source. UI reads log files on demand when the user opens a phase's detail view; no need to denormalize into JSON.

## Implementation

### 1. Remove SQLite

**Files to delete:**
- `src/main/db.ts` and any DB-specific helpers
- SQLite migrations / schema files
- `better-sqlite3` and `@types/better-sqlite3` from `package.json` + lockfile

**One-time cleanup** (first launch post-upgrade):

```ts
// src/main/index.ts on app-ready
const legacyDb = path.join(os.homedir(), ".dex", "db");
if (fs.existsSync(legacyDb)) {
  fs.rmSync(legacyDb, { recursive: true, force: true });
  console.info("Removed legacy SQLite directory");
}
```

### 2. New module `src/core/runs.ts`

```ts
import * as fs from "node:fs";
import * as path from "node:path";

const runsDir = (projectDir: string) => path.join(projectDir, ".dex", "runs");

export function ensureRunsDir(projectDir: string): void {
  fs.mkdirSync(runsDir(projectDir), { recursive: true });
}

export function writeRun(projectDir: string, run: RunRecord): void {
  ensureRunsDir(projectDir);
  const p = path.join(runsDir(projectDir), `${run.runId}.json`);
  fs.writeFileSync(p, JSON.stringify(run, null, 2));
}

export function readRun(projectDir: string, runId: string): RunRecord | null {
  const p = path.join(runsDir(projectDir), `${runId}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8")) as RunRecord;
}

export function listRuns(projectDir: string, limit = 50): RunRecord[] {
  const dir = runsDir(projectDir);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const runs = files.map((f) =>
    JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as RunRecord
  );
  runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return runs.slice(0, limit);
}

/**
 * Read → mutate → write. Single-writer guaranteed by `.dex/state.lock`.
 * Caller is responsible for holding the lock.
 */
export function updateRun(
  projectDir: string,
  runId: string,
  mutator: (r: RunRecord) => void
): RunRecord {
  const run = readRun(projectDir, runId);
  if (!run) throw new Error(`run ${runId} not found`);
  mutator(run);
  writeRun(projectDir, run);
  return run;
}

/**
 * Append a phase to a run at phase-start time. Typical flow:
 *   startPhase() → (stage executes) → updatePhaseOnComplete()
 */
export function startPhase(
  projectDir: string,
  runId: string,
  phase: Omit<PhaseRecord, "endedAt" | "costUsd" | "durationMs" | "subagents">
): void {
  updateRun(projectDir, runId, (r) => {
    r.phases.push({
      ...phase,
      endedAt: null,
      costUsd: 0,
      durationMs: null,
      subagents: [],
    });
  });
}

export function completePhase(
  projectDir: string,
  runId: string,
  phaseTraceId: string,
  patch: Partial<PhaseRecord>
): void {
  updateRun(projectDir, runId, (r) => {
    const ph = r.phases.find((p) => p.phaseTraceId === phaseTraceId);
    if (ph) Object.assign(ph, patch, { endedAt: new Date().toISOString() });
  });
}

export function recordSubagent(
  projectDir: string,
  runId: string,
  phaseTraceId: string,
  sub: SubagentRecord
): void {
  updateRun(projectDir, runId, (r) => {
    const ph = r.phases.find((p) => p.phaseTraceId === phaseTraceId);
    if (ph) {
      const existing = ph.subagents.find((s) => s.id === sub.id);
      if (existing) Object.assign(existing, sub);
      else ph.subagents.push(sub);
    }
  });
}
```

### 3. Orchestrator wire-up

Everywhere `orchestrator.ts` writes to SQLite today (phase start, phase complete, subagent lifecycle, run completion, loop cycles), replace with calls to `runs.ts` helpers.

Grep for `phase_traces`, `completePhaseTrace`, `insertLoopCycle`, `updateLoopCycle`, `insertSubagent`, `updateSubagent` in `src/core/orchestrator.ts` — each site maps to one of `startPhase` / `completePhase` / `recordSubagent` / `writeRun` (for initial run creation) / `updateRun` (for status changes).

The `loop_cycles` table doesn't need a replacement — the data is derivable from `phases` grouped by `cycleNumber`. Any UI that shows "cycle N costs" computes it from the run JSON.

### 4. IPC handlers

Four handlers in `src/main/preload.ts` / `src/main/ipc/*` today (per `06-testing.md` § 4f.4):

| Existing IPC | Previous implementation | New implementation |
|---|---|---|
| `window.dexAPI.listRuns(limit)` | `SELECT … FROM runs ORDER BY created_at DESC LIMIT ?` | `listRuns(projectDir, limit)` |
| `window.dexAPI.getRun(runId)` | `SELECT … WHERE id = ?` + JOIN on phase_traces | `readRun(projectDir, runId)` |
| `window.dexAPI.getPhaseSteps(phaseTraceId)` | `SELECT … FROM trace_steps WHERE phase_trace_id = ?` | Reads `~/.dex/logs/<project>/<runId>/phase-<n>_*/agent.log`, parses structured events |
| `window.dexAPI.getPhaseSubagents(phaseTraceId)` | `SELECT … FROM subagents WHERE phase_trace_id = ?` | Reads `phases[].subagents` from the run JSON |

`getPhaseSteps` is the one meaningful change — it moves from SQL to log parsing. Log lines are already JSON-structured (`[<ISO>] [<LEVEL>] <message> <optional JSON>` per `06-testing.md` § 4f.2), so parsing is a streaming `split + filter`. For a 500-step phase, that's <5ms.

All four handlers need `projectDir` as a parameter now (SQLite was global; JSON is per-project). The preload layer resolves this from the currently-active project in state.

### 5. Renderer components

Components that call these IPC handlers:
- `TraceView` (consumes `getPhaseSteps`, `getPhaseSubagents`)
- `RunsList` or equivalent (consumes `listRuns`)
- Any cost/duration display (consumes `getRun`)

Only field-name adjustments. Shape of the returned data stays close to the SQL rows (same field names on the surface: `runId`, `stage`, `costUsd`, etc.).

### 6. Documentation

- `.claude/rules/06-testing.md` § 4f.4 — rewrite the "Audit trail" section to describe JSON files instead of SQLite. Keep the IPC helper names (they're unchanged).
- `CLAUDE.md` — remove the `better-sqlite3` dependency mention.
- `.specify/feature.json` — update active-technologies section.

## Verification

1. **Clean install**: fresh checkout, `npm install` — no `better-sqlite3` in lockfile, no native build step.
2. **No legacy DB**: run the app once; `~/.dex/db/` is absent (cleaned up on first launch).
3. **Basic run**: start a loop, let it complete one cycle. `<projectDir>/.dex/runs/<runId>.json` exists, contains phases with costs matching what the trace view displays.
4. **Resume**: pause mid-run. Close app. Reopen. Resume. Verify the run JSON is updated in place — phase count grows, `status` transitions through `paused` → `running` → `completed`.
5. **Multi-project isolation**: open project A, run a cycle. Open project B, run a cycle. Confirm A's runs JSON is only in A's `.dex/runs/`, not in B's.
6. **IPC smoke**: from DevTools console:
   ```js
   await window.dexAPI.listRuns(5)
   await window.dexAPI.getRun((await window.dexAPI.listRuns(1))[0].runId)
   ```
   Both return correct data matching on-disk JSON.
7. **TraceView**: open a past run's phase → trace steps render (sourced from log files).
8. **Typecheck**: `npx tsc --noEmit` passes.
9. **Unit tests**: `runs.ts` round-trip (write → read → list), concurrent-writer simulation via `state.lock`.

## Out of scope

- Migrating old SQLite data to JSON. Dev phase; old data is wiped.
- Git-committability policy. Teams decide per-project via `.gitignore`.
- Archival of old run JSONs. Files are cheap; leave them until a user manually cleans up. A follow-up `dex/scripts/prune-runs.sh` can sweep JSONs older than N days.
- Cross-project aggregation ("total spend across all my Dex projects"). Possible via a thin CLI that walks known project dirs and sums `totalCostUsd`; out of scope for this feature.

## Estimated effort

**2–3 working days** for a single engineer.

- Day 1: `src/core/runs.ts` + unit tests, orchestrator wire-up, IPC handlers.
- Day 2: `getPhaseSteps` log parsing, renderer component adjustments, legacy DB cleanup.
- Day 3: verification matrix, docs updates, buffer for renderer field renames.

No new dependencies. One removed (`better-sqlite3`). No schema migrations, no data preservation.
