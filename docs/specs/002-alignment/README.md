# Plan: Filesystem-First State Management with Git Checkpoints

## Context

Project state is split between SQLite DB, in-memory variables, and filesystem artifacts. On pause/resume they diverge: DB says one thing, `tasks.md` says another, in-memory state is lost. Manual edits to project files (deleting specs, editing tasks) make it worse — there's no drift detection.

**Goal**: Single source of truth via `.dex/state.json` committed to the branch, with artifact integrity checking and git checkpoints. DB demoted to append-only audit log.

---

## Architecture

### Three pillars

1. **`.dex/state.json`** (committed to git) — orchestrator position, failure counts, config snapshot, artifact manifest with content hashes
2. **Git commits as checkpoints** — one state-only commit per stage (`.dex/state.json` only, not `git add -A`), state file records previous checkpoint SHA for drift detection
3. **Integrity reconciliation on resume** — async verification that artifacts still exist and match, detect manual edits, decide what to re-run

### State file lives in the branch

- Committed after each stage → branch-scoped automatically
- Merge to main → `branchName` check detects stale state → deleted on next fresh start (see "Merge conflict prevention" section for git-level handling)
- Process crash → committed version is last checkpoint, working-tree version may be one step ahead → crash recovery logic picks the more-advanced valid state (see "Crash recovery" section)
- Protected from agent interference: agent prompts exclude `.dex/` from `git add` (see "Agent commit isolation" section), verified by automated grep guard (see "Agent prompt coverage verification")

---

## New file: `src/core/state.ts`

### `DexState` interface

```typescript
interface DexState {
  version: 1;
  runId: string;
  status: "running" | "paused" | "completed" | "failed";
  branchName: string;
  baseBranch: string;
  mode: "loop" | "build" | "plan";

  // Position cursor
  phase: "prerequisites" | "clarification" | "loop";
  currentCycleNumber: number;
  lastCompletedStage: LoopStageType | null;
  currentSpecDir: string | null;
  currentPhaseNumber: number | null;

  // Clarification
  clarificationCompleted: boolean;
  fullPlanPath: string | null;

  // Accumulators
  cumulativeCostUsd: number;
  cyclesCompleted: number;
  featuresCompleted: string[];
  featuresSkipped: string[];

  // Failure tracking (replaces in-memory Map + DB failure_tracker)
  failureCounts: Record<string, { implFailures: number; replanFailures: number }>;

  // Config snapshot for resume
  config: {
    model: string;
    maxLoopCycles?: number;
    maxBudgetUsd?: number;
    maxTurns: number;
    maxIterations: number;
    autoClarification?: boolean;
  };

  // Artifact integrity manifest
  artifacts: {
    goalFile: ArtifactEntry | null;
    clarifiedGoal: ArtifactEntry | null;
    productDomain: ArtifactEntry | null;
    technicalDomain: ArtifactEntry | null;
    constitution: ArtifactEntry | null;
    features: Record<string, FeatureArtifacts>;
  };

  // Git checkpoint
  checkpoint: {
    sha: string;       // HEAD SHA after last committed checkpoint
    timestamp: string;
  };

  // Pending user input (persisted so crash doesn't lose unanswered questions)
  pendingQuestion: {
    id: string;
    question: string;
    context: string;    // Which stage/phase prompted the question
    askedAt: string;
  } | null;

  // Timestamps
  startedAt: string;
  pausedAt: string | null;
}

interface ArtifactEntry {
  path: string;          // Relative to project root
  sha256: string;        // Content hash at checkpoint time
  completedAt: string;
}

interface FeatureArtifacts {
  specDir: string;
  status: "specifying" | "planning" | "implementing" | "verifying" | "completed" | "skipped";
  spec: ArtifactEntry | null;
  plan: ArtifactEntry | null;
  tasks: TasksArtifact | null;
  lastImplementedPhase: number;
}

interface TasksArtifact extends ArtifactEntry {
  taskChecksums: Record<string, boolean>; // task ID → was-checked
}
```

### Functions

All I/O-bound functions are async — `reconcileState` hashes every artifact and shells out to git, which can take seconds on large projects.

```typescript
// Atomic write: write .tmp then rename
async saveState(projectDir: string, state: DexState): Promise<void>

// Read + parse + version check, null on missing/corrupt
async loadState(projectDir: string): Promise<DexState | null>

// Delete state file (on clean completion)
async clearState(projectDir: string): Promise<void>

// Deep-merge update with explicit semantics (see "Deep merge contract" section).
// Prevents shallow-merge footgun where passing { artifacts: { goalFile: x } }
// would wipe all other artifact entries.
async updateState(projectDir: string, patch: DeepPartial<DexState>): Promise<void>

// SHA-256 of file contents
async hashFile(filePath: string): Promise<string>

// Check if state file is from current branch or stale
async detectStaleState(projectDir: string): Promise<"fresh" | "stale" | "completed" | "none">

// Build initial state from RunConfig
createInitialState(config: RunConfig, runId: string, branchName: string, baseBranch: string): DexState

// The key function: verify artifacts match state, return reconciliation plan.
// Emits `state_reconciling` event at start and `state_reconciled` event with drift summary on completion.
async reconcileState(projectDir: string, state: DexState): Promise<ReconciliationResult>

// Crash recovery: compare working-tree state.json vs last-committed state.json,
// pick the more-advanced one, validate it (see "Crash recovery" section)
async resolveWorkingTreeConflict(projectDir: string): Promise<DexState | null>

// Acquire/release advisory lock (.dex/state.lock) to prevent concurrent writes
// from multiple Electron windows targeting the same project
async acquireStateLock(projectDir: string): Promise<() => void>  // returns release fn

// Migrate from DB-based resume (one-time): reads last paused run from DB,
// generates state.json, returns it for confirmation before writing
async migrateFromDbResume(projectDir: string, db: Database): Promise<DexState | null>
```

### `DeepPartial<T>` type

```typescript
type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};
```

---

## Integrity reconciliation (`reconcileState`)

Runs on resume before entering the loop. Three checks:

### 1. Git checkpoint comparison

```
currentHead = git rev-parse HEAD
expectedSha = state.checkpoint.sha
If currentHead !== expectedSha:
  count commits between them → drift.extraCommits
```

### 2. Artifact existence + hash check

For each artifact in the manifest:
- File missing → `drift.missing.push(path)`
- File exists but hash differs → `drift.modified.push(path)`

For `tasks.md` specifically: compare task checkbox states against `taskChecksums`:
- Task unchecked that was checked → `drift.taskRegressions[specDir].push(taskId)`
- Task checked that was unchecked → `drift.taskProgressions[specDir].push(taskId)` (accept as manual progress)

### 3. Pending question re-ask

If `state.pendingQuestion` is non-null, the app crashed while waiting for user input. Re-emit `user_input_request` with the stored question before proceeding with any other reconciliation. The user's answer resolves the question and clears `pendingQuestion` from state.

### 4. Reconciliation decision matrix

| Drift | Action |
|---|---|
| No drift | Resume from `lastCompletedStage + 1` |
| `GOAL_clarified.md` deleted | Reset to clarification |
| `GOAL_clarified.md` modified | Ask user: re-run gap analysis? |
| `spec.md` deleted for feature X | Reset feature X to "specifying" |
| `plan.md` deleted for feature X | Reset feature X to "planning" |
| Tasks unchecked in `tasks.md` | Resume implement from earliest unchecked phase |
| Tasks newly checked | Accept progression, update state |
| Extra commits after checkpoint | Warn, update checkpoint, proceed |
| `constitution.md` deleted | Re-run constitution before next cycle |
| Pending question unanswered | Re-ask before resuming |

**Principle: Never start over. Find the furthest-back stage that needs re-running.**

### `ReconciliationResult`

```typescript
interface ReconciliationResult {
  canResume: boolean;
  resumeFrom: { phase: string; cycleNumber: number; stage: LoopStageType; specDir?: string };
  warnings: string[];    // Shown to user, don't block
  blockers: string[];    // Require user decision via user_input_request
  statePatches: DeepPartial<DexState>;
  driftSummary: {        // For telemetry + UI display
    missingArtifacts: string[];
    modifiedArtifacts: string[];
    taskRegressions: Record<string, string[]>;
    taskProgressions: Record<string, string[]>;
    extraCommits: number;
    pendingQuestionReask: boolean;
  };
}
```

When `blockers.length > 0`, emit `user_input_request` asking the user to choose: "Re-run from X" or "Accept current state."

Emit `state_reconciled` OrchestratorEvent with `driftSummary` so the UI can show what changed since last run.

---

## Git checkpoint protocol

### State-only commits (not `git add -A`)

After each stage completes:

1. Update `state.json` with new `lastCompletedStage`, updated artifact hashes
2. `git add .dex/state.json && git commit -m "dex: <stage> completed [cycle:<N>] [feature:<name>]"`
3. `state.json.checkpoint.sha = git rev-parse HEAD`
4. Write updated `state.json` to disk (NOT committed yet — sits in working tree)

On next stage, step 2 picks up the updated checkpoint SHA.

**Why state-only commits:** The agent already commits its own work as part of the phase prompts. Using `git add -A` would double-commit agent work and pollute PR history with 14+ dex-internal commits per cycle. State checkpoints should be lightweight metadata commits.

### Agent commit isolation

Agent prompts must exclude `.dex/` from their `git add` commands to prevent the agent from accidentally committing a stale working-tree `state.json`. In prompt building, replace `git add -A` with:

```bash
git add -A -- ':!.dex/'
```

This ensures the agent's commits contain only its own work, and `.dex/state.json` is only committed by the checkpoint protocol above.

### Crash recovery

On crash, two versions of `state.json` may exist:
- **Committed version**: from the last checkpoint commit (has the previous checkpoint SHA)
- **Working-tree version**: may be one step ahead (has the latest checkpoint SHA)

`resolveWorkingTreeConflict()` handles this explicitly:

1. Read both versions (committed via `git show HEAD:.dex/state.json`, working-tree via filesystem)
2. If only one exists, use it
3. If both exist, compare `lastCompletedStage` ordinal — pick the more-advanced one
4. Validate the chosen state: verify its `checkpoint.sha` exists in git history (`git cat-file -t <sha>`)
5. If validation fails, fall back to the other version
6. If both fail, return null → fresh start

### Commit message format (machine-parseable)

```
dex: <stage_type> completed [cycle:<N>] [feature:<name>] [cost:$<X.XX>]
```

---

## Changes to existing files

### `src/core/types.ts`
- Remove `resumeRunId?: string` from `RunConfig` (line 173)
- Add `resume?: boolean` to `RunConfig`
- Export `DexState`, `ArtifactEntry`, `FeatureArtifacts`, `TasksArtifact`, `ReconciliationResult`

### `src/core/orchestrator.ts`
- Import state functions from `state.ts`
- **`run()` (~line 1291)**: After `createRun()`, call `saveState()` with initial state. In `finally` block: write `status="paused"` if stopped, `clearState()` if completed
- **`runLoop()` (~line 1735-1759)**: Replace the `if (config.resumeRunId)` block with:
  - `loadState()` from state file
  - `reconcileState()` to check integrity
  - Restore position, failure counts, accumulators from state — not from DB
- **Remove `loadFailureRecords()`** (lines 1711-1718) — failure counts come from state file
- **After each stage**: call `saveState()` + git commit checkpoint
- **`stopRun()`**: Store `projectDir` in module-level var so finally block can write paused state

### `src/core/git.ts`
- Add `commitCheckpoint(projectDir, stage, cycleNumber, featureName, cost): string` — stages `.dex/state.json` only (NOT `git add -A`), commits with structured message, returns new HEAD SHA
- Add `getHeadSha(projectDir): string`
- Add `countCommitsBetween(projectDir, fromSha, toSha): number`
- Add `getCommittedFileContent(projectDir, ref, filePath): string | null` — for crash recovery (`git show HEAD:.dex/state.json`)
- Update agent prompt building: replace `git add -A` with `git add -A -- ':!.dex/'` in all phase/stage prompts

### `src/main/ipc/orchestrator.ts`
- Add `orchestrator:getProjectState` handler that reads state file for a given projectDir
- Update `orchestrator:getRunState`: when not running, fall back to state file

### `src/main/preload.ts` + `src/renderer/electron.d.ts`
- Add `getProjectState(dir: string)` to exposed API

### `src/renderer/hooks/useOrchestrator.ts`
- Mount effect (line 132+): For paused state detection, call `getProjectState()` — no need to reverse-engineer from DB phase traces
- Simplify `loadRunHistory()` — state file explicitly says status and position

### `src/renderer/App.tsx`
- `handleStartLoop()` (line 198): Replace `resumeRunId?: string` with `resume?: boolean`
- `handleStart()` (line 242): Pass `resume: true` instead of `resumeRunId`

### `src/core/database.ts`
- **All writes stay** — DB is the audit trail
- `getActiveRunState()` can be deprecated (no longer used for resume)
- `failure_tracker` table writes stay for history but are not read for resume

---

## Merge-to-main handling

State file includes `branchName`. On any loop start:

```typescript
detectStaleState(projectDir):
  "none"      → no state file → fresh start
  "completed" → status is completed → delete state, fresh start
  "stale"     → branchName !== current branch → delete state, fresh start
  "fresh"     → same branch, paused/running → offer resume
```

On clean loop completion: set `status: "completed"`, commit. State file persists as inert record.

---

## Migration from DB-based resume

Existing paused runs use `resumeRunId` to resume from DB state. Removing that path without a migration would strand in-progress runs.

### One-time migration (`migrateFromDbResume`)

On first load after upgrade, if:
- No `.dex/state.json` exists, AND
- DB has a run with `status = 'stopped'` or `status = 'crashed'` for this `projectDir`

Then:
1. Read the last non-completed run from DB
2. Reconstruct `DexState` from DB fields: run config, last phase_trace, loop_cycles, failure_tracker
3. Hash current artifacts on disk to populate the manifest
4. Present the reconstructed state to the user: "Found a paused run from [date]. Resume from [stage]?"
5. On confirmation, write `.dex/state.json` and proceed with normal resume flow

This is a best-effort reconstruction — artifact hashes won't match any prior checkpoint (there were none), so the first resume will trigger reconciliation with "no prior checkpoint" which defaults to trusting current disk state.

After migration, the old `resumeRunId` code path can be removed.

---

## State file locking

If two Electron windows target the same project directory, concurrent writes to `state.json` corrupt it.

- `acquireStateLock()` creates `.dex/state.lock` with PID + timestamp
- Uses advisory locking (check PID still alive before stealing)
- Returns a release function; automatically releases on process exit via `process.on('exit')`
- `.dex/state.lock` is gitignored (unlike `state.json` itself)

---

## Deep merge contract

`updateState()` uses a purpose-built deep merge (not lodash) with explicit, deterministic semantics. No ambiguity on edge cases:

| Value in patch | Behavior |
|---|---|
| `undefined` key (or key absent) | Ignored — existing value preserved |
| `null` | **Replaces** — clears the field (e.g., `{ pendingQuestion: null }` removes it) |
| Primitive (string, number, boolean) | Replaces |
| Object | Recursively merged with existing object |
| Array | **Replaces entirely** — no element-wise merge (e.g., `{ featuresCompleted: ["a"] }` replaces the whole array) |

**Why no lodash:** The state shape is known and finite. A 30-line recursive function with these four rules is easier to audit than a library with configurable merge strategies. Arrays-replace-not-merge prevents accidental duplication in `featuresCompleted`/`featuresSkipped`. `null`-clears-field is essential for `pendingQuestion` and artifact reset.

```typescript
function deepMerge<T>(target: T, patch: DeepPartial<T>): T {
  const result = { ...target };
  for (const key of Object.keys(patch) as Array<keyof T>) {
    const patchVal = patch[key];
    if (patchVal === undefined) continue;
    if (patchVal === null || Array.isArray(patchVal) || typeof patchVal !== "object") {
      (result as any)[key] = patchVal;
    } else {
      (result as any)[key] = deepMerge((target as any)[key] ?? {}, patchVal);
    }
  }
  return result;
}
```

---

## Merge conflict prevention

When two branches both have `.dex/state.json` and are merged, git produces a conflict. The `branchName` check handles semantic correctness after merge, but the merge itself must not block.

**Solution:** Add `.gitattributes` in the project root (or ensure it exists):

```
.dex/state.json merge=ours
```

This tells git to always keep the current branch's version on merge conflict. Safe because:
- `detectStaleState()` runs on next loop start and deletes stale state anyway
- The "ours" version is the branch you're working on — always the correct one to keep
- If merging a feature branch into main, main's state is either absent or completed — both get cleaned up

Add to implementation step 11: register the `.gitattributes` entry alongside gitignore changes.

---

## Advisory lock hardening

The lock file contains PID + timestamp. Stealing logic must handle two failure modes:

1. **Dead PID** — process crashed while holding lock. Check via `process.kill(pid, 0)` (signal 0 = existence check, no signal sent). If dead → steal.
2. **Recycled PID** — OS reused the PID for a different process. Mitigate with a staleness threshold: if lock timestamp is older than **10 minutes**, steal regardless of PID liveness. No legitimate Dex operation holds the lock for 10 minutes — `saveState` + `commitCheckpoint` takes <1 second.

```typescript
interface LockFile {
  pid: number;
  timestamp: string; // ISO 8601
}

function isLockStale(lock: LockFile): boolean {
  const ageMs = Date.now() - new Date(lock.timestamp).getTime();
  if (ageMs > 10 * 60 * 1000) return true; // Older than 10 min → stale
  try { process.kill(lock.pid, 0); return false; } // PID alive → not stale
  catch { return true; } // PID dead → stale
}
```

---

## Agent prompt coverage verification

If any agent prompt uses `git add -A` without the `:!.dex/` exclusion, the agent commits a stale `state.json`, corrupting the checkpoint chain. A single missed prompt is a silent data corruption bug.

**Build-time guard:** Add to implementation step 3 — after updating all prompts, add a verification grep to the test/verification suite:

```typescript
// In verification or as a unit test
const promptFiles = ["src/core/orchestrator.ts", "src/core/prompts.ts"];
for (const file of promptFiles) {
  const content = fs.readFileSync(file, "utf-8");
  const gitAddAll = /git add -A(?! -- ':!\.dex\/')/g;
  const matches = content.match(gitAddAll);
  assert(matches === null, `Unguarded 'git add -A' found in ${file}`);
}
```

**Runtime guard:** `commitCheckpoint()` should verify that the last agent commit (if any) does NOT contain `.dex/state.json` in its diff. If it does, emit a warning event — the checkpoint chain may be compromised but the run can continue.

```typescript
// In commitCheckpoint(), after agent phase completes:
const agentCommitFiles = execSync(`git diff-tree --no-commit-id --name-only -r HEAD`, { cwd: projectDir });
if (agentCommitFiles.includes(".dex/state.json")) {
  emit({ type: "warning", message: "Agent committed .dex/state.json — checkpoint may be stale" });
}
```

---

## Reconciliation performance

`reconcileState` hashes every artifact and shells out to git. For projects with 20+ features (60+ files to hash), this must not block resume noticeably.

**Implementation rules:**
1. Hash all artifacts in parallel via `Promise.all(artifacts.map(a => hashFile(a.path)))` — SHA-256 of small text files is CPU-bound and fast, but filesystem I/O benefits from concurrency
2. Git operations (`rev-parse`, `cat-file`, `log --oneline`) run as parallel child processes where independent
3. Target: reconciliation completes in <2 seconds for 100 artifacts on SSD. If profiling shows otherwise, add lazy hashing (only hash artifacts whose `mtime` changed since `checkpoint.timestamp`)

---

## State file schema versioning

`version: 1` is included in the interface. Future changes:

- Additive fields (new optional properties): no version bump needed, handled by defaults in `loadState()`
- Breaking changes (renamed/removed fields, semantic changes): bump version, add migration in `loadState()`:
  ```typescript
  if (raw.version === 1) { state = migrateV1toV2(raw); }
  ```
- `loadState()` rejects unknown future versions (returns null → fresh start) rather than silently misinterpreting

---

## Known limitations

### No mid-phase resume

Resume granularity is per-stage (`lastCompletedStage + 1`). If a long implementation phase (30+ minutes) crashes at 95% completion, it restarts from the beginning of that phase. This is the same limitation as the current system.

**Why not fix now:** Mid-phase checkpoints would require the agent SDK to support resumable sessions or the orchestrator to break phases into sub-steps. Both are significant scope increases. The state file architecture supports adding phase-internal checkpoints later (e.g., `lastCompletedSubStep` field) without breaking changes.

**Mitigation:** The `maxTurns` config limits phase duration, so the worst-case restart cost is bounded.

---

## Implementation order

1. Create `src/core/state.ts` — types (`DexState`, `DeepPartial`, `ReconciliationResult`), read/write/clear, purpose-built `deepMerge` (see "Deep merge contract"), hash, locking with staleness check (see "Advisory lock hardening"), crash recovery (`resolveWorkingTreeConflict`)
2. Add `commitCheckpoint()` (state-only, not `git add -A`), `getCommittedFileContent()` to `src/core/git.ts`. Include runtime guard that warns if agent committed `.dex/state.json` (see "Agent prompt coverage verification")
3. Update agent prompt building in `orchestrator.ts`: replace `git add -A` with `git add -A -- ':!.dex/'`. Add build-time grep guard to verify no unguarded `git add -A` remains (see "Agent prompt coverage verification")
4. Wire state file writes into `orchestrator.ts` at all stage transitions (additive — both DB and state file). Persist `pendingQuestion` before emitting `user_input_request`.
5. Implement `reconcileState()` with parallel artifact hashing via `Promise.all` (see "Reconciliation performance"), pending question re-ask, and `state_reconciled` event emission
6. Add `migrateFromDbResume()` — one-time migration from DB-based resume to state file
7. Replace resume-from-DB with resume-from-state-file in `runLoop()`: `loadState()` → `resolveWorkingTreeConflict()` → `reconcileState()`
8. Update `RunConfig` type: `resume: boolean` replaces `resumeRunId`
9. Update IPC handlers + preload + electron.d.ts
10. Update renderer hooks + App.tsx — handle `state_reconciled` event to show drift summary
11. Ensure `.dex/state.json` is NOT gitignored; add `.dex/state.lock` TO gitignore; add `.dex/state.json merge=ours` to `.gitattributes` (see "Merge conflict prevention")

---

## Verification

1. `npx tsc --noEmit` passes
2. Start loop → verify `.dex/state.json` created and updates at each stage
3. Verify checkpoint commits contain ONLY `.dex/state.json` (not agent work files)
4. Verify agent commits do NOT contain `.dex/state.json` (`:!.dex/` exclusion works)
5. Pause mid-run → verify state file has `status: "paused"` with correct position + artifact hashes
6. Resume → verify picks up from correct stage, no duplicate execution
7. Kill Electron process → restart → verify crash recovery picks correct state (working-tree vs committed)
8. Kill while user-input question pending → restart → verify question is re-asked
9. Manually delete a spec folder → resume → verify reconciliation detects it and re-runs from specify
10. Manually uncheck tasks in `tasks.md` → resume → verify it re-runs implement from the right phase
11. Let loop complete → verify state file set to "completed" and cleaned up on next start
12. Check `.dex/state.json` appears in git commits on the branch
13. Verify UI shows `state_reconciled` drift summary on resume
14. Test DB migration: stop a run using old code, upgrade, verify `migrateFromDbResume()` generates valid state file
15. Open two Electron windows on same project → verify state lock prevents corruption
16. Kill Electron while holding lock → restart → verify stale lock is detected and stolen (PID dead check)
17. Merge feature branch into main → verify `.gitattributes merge=ours` prevents conflict on `.dex/state.json`
18. Start loop on main after merge → verify `detectStaleState` returns "stale" and cleans up
19. Run grep guard on `orchestrator.ts` + `prompts.ts` → verify no unguarded `git add -A` patterns exist
20. Verify `updateState({ pendingQuestion: null })` clears the field (null = replace, not ignored)
21. Verify `updateState({ featuresCompleted: ["a"] })` replaces the array (not appends)
