# Research: Filesystem-First State Management

**Feature**: 002-filesystem-state-management
**Date**: 2026-04-16

## R1: Atomic File Writes on Node.js

**Decision**: Write to `.dex/state.json.tmp`, then `fs.renameSync()` to `.dex/state.json`.

**Rationale**: `rename()` is atomic on all major filesystems (ext4, APFS, NTFS) when source and destination are on the same filesystem. Since both are in `.dex/`, this is guaranteed. A crash during `writeFileSync()` to the tmp file leaves the previous state.json intact — the tmp file is simply orphaned and ignored on next load.

**Alternatives considered**:
- `writeFileSync()` directly: Not atomic — crash mid-write corrupts the file.
- Write-ahead log (WAL): Overkill for a single JSON file written at most once per stage (~every 30-120 seconds).
- SQLite for state: Adds complexity and defeats the purpose of committing state to git.

## R2: Advisory File Locking Strategy

**Decision**: PID + timestamp in `.dex/state.lock`, with dead-PID detection via `process.kill(pid, 0)` and 10-minute staleness threshold.

**Rationale**: True file locking (`flock`, `lockfile`) has cross-platform issues (Windows vs POSIX semantics differ). Advisory locking with PID check covers the actual threat model (two Electron windows on the same project). The 10-minute staleness threshold handles recycled PIDs — no legitimate Dex state operation takes more than ~1 second.

**Alternatives considered**:
- `proper-lockfile` npm package: External dependency for a ~20-line feature. Adds supply chain surface area.
- No locking: Concurrent writes corrupt JSON. Rare scenario but catastrophic outcome.
- SQLite advisory lock: Already have SQLite, but the lock needs to protect the file that replaces SQLite for state — circular.

## R3: Deep Merge vs Shallow Merge

**Decision**: Purpose-built 30-line `deepMerge()` with explicit semantics: `undefined` = skip, `null` = clear, primitive = replace, object = recurse, array = replace entirely.

**Rationale**: The state shape is known and finite (~15 top-level keys, max 3 levels deep). A purpose-built function with four rules is easier to audit than a library with configurable merge strategies. Key design choices:
- Arrays replace entirely (not element-wise merge) → prevents accidental duplication in `featuresCompleted`/`featuresSkipped`.
- `null` clears the field → essential for `pendingQuestion` and artifact reset.
- Objects recurse → allows `updateState({ artifacts: { goalFile: newEntry } })` without wiping other artifacts.

**Alternatives considered**:
- `lodash.merge`: Deep-merges arrays by index (wrong behavior for our arrays). Treats `null` differently. 70KB dependency for one function.
- Spread operator: Shallow only — `{ ...state, artifacts: patch.artifacts }` wipes all unmentioned artifact entries.
- Immutable.js `mergeDeep`: 60KB dependency, overkill for a known shape.

## R4: Git Checkpoint Commit Strategy

**Decision**: State-only commits (`git add .dex/state.json` only, not `git add -A`) with structured message format: `dex: <stage> completed [cycle:<N>] [feature:<name>] [cost:$<X.XX>]`.

**Rationale**: The agent already commits its own work as part of phase prompts. Using `git add -A` would double-commit agent work and pollute PR history with 14+ dex-internal commits per cycle. State checkpoints should be lightweight metadata commits that don't interfere with the agent's work.

**Alternatives considered**:
- `git add -A` for checkpoints: Double-commits agent work. Pollutes PR with ~14 extra commits per cycle. Makes rebase/squash messy.
- Amend the agent's commit: Race condition — agent commit happens inside `query()` which we don't control timing of.
- Git notes instead of commits: Not pushed by default, lost on clone, harder to work with.
- No git checkpoint at all: Crash recovery limited to in-memory state — back to the original problem.

## R5: Agent Commit Isolation (`:!.dex/` Exclusion)

**Decision**: Replace `git add -A` with `git add -A -- ':!.dex/'` in all 4 agent prompt locations. Add build-time grep guard and runtime guard.

**Rationale**: If any agent prompt uses `git add -A` without the exclusion, the agent commits a stale `state.json`, corrupting the checkpoint chain. A single missed prompt is a silent data corruption bug. The three-layer defense (prompt update + build-time grep + runtime check) ensures comprehensive protection.

**4 locations to update**:
1. `src/core/orchestrator.ts:441` — build mode gap analysis commit
2. `src/core/orchestrator.ts:448` — build mode phase commit
3. `src/core/orchestrator.ts:1630` — prerequisites `execSync()` commit
4. `src/core/prompts.ts:320` — loop mode implement commit

## R6: State File Schema Versioning

**Decision**: `version: 1` field in state. `loadState()` rejects unknown future versions (returns null → fresh start). Additive fields don't require version bumps (handled by defaults). Breaking changes bump version with inline migration.

**Rationale**: Over-engineering versioning for v1 is wasteful. The simple rule — additive changes are free, breaking changes get a bump — covers the realistic evolution path. Rejecting future versions (rather than attempting interpretation) is the safe default.

## R7: Reconciliation Performance

**Decision**: Hash all artifacts in parallel via `Promise.all(artifacts.map(hashFile))`. Git operations run as parallel child processes where independent. Target: <2 seconds for 100 artifacts on SSD.

**Rationale**: SHA-256 of small text files is fast (~1ms per file), but filesystem I/O benefits from concurrency. For a typical project (15-80 files), parallel hashing completes in <500ms. Git operations (`rev-parse`, `cat-file`, `log --oneline`) are independent and can overlap.

**Fallback**: If profiling shows >2s, add lazy hashing — only hash artifacts whose `mtime` changed since `checkpoint.timestamp`.

## R8: Migration from DB-Based Resume

**Decision**: One-time best-effort migration. Read last stopped/crashed run from DB, reconstruct state from DB fields + current disk artifacts, present to user for confirmation.

**Rationale**: The migration is inherently lossy — there are no prior checkpoint SHAs, artifact hashes must be computed fresh. The first reconciliation after migration will report "no prior checkpoint" which defaults to trusting current disk state. User confirmation ensures no silent data loss.

**Edge case**: If the user declines migration, the old run is effectively abandoned. The DB records remain for audit but are never used for resume again.
