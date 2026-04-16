# Quickstart: Filesystem-First State Management

**Feature**: 002-filesystem-state-management

## What This Feature Does

Replaces the hybrid in-memory + SQLite resume mechanism with a single `.dex/state.json` file committed to git. On resume, the system reads the state file, checks artifact integrity, and picks up exactly where it left off.

## Key Concepts

### State File (`.dex/state.json`)
- Lives in the project directory (not `~/.dex/`)
- Committed to the branch after each stage
- Contains: position cursor, accumulators, failure counts, artifact hashes, checkpoint SHA
- Single source of truth for pause/resume

### Checkpoint Commits
- State-only git commits (just `.dex/state.json`, not `git add -A`)
- One per stage completion
- Message format: `dex: <stage> completed [cycle:<N>] [feature:<name>] [cost:$<X.XX>]`

### Reconciliation
- Runs on every resume
- Compares artifact hashes on disk vs manifest in state
- Detects: missing files, modified files, unchecked tasks, extra commits
- Computes minimum rollback point — never starts over

### Agent Isolation
- Agent prompts use `git add -A -- ':!.dex/'` to exclude state directory
- Prevents agents from committing stale state
- Verified by build-time and runtime guards

## Implementation Order

1. `src/core/state.ts` — types + I/O + locking + crash recovery
2. `src/core/git.ts` — checkpoint commits + helpers
3. Agent prompt updates — `.dex/` exclusion in 4 locations
4. Orchestrator wiring — state writes at stage transitions
5. Reconciliation engine — integrity checking on resume
6. DB migration — one-time from old resume system
7. Resume rewrite — state file replaces DB for resume
8. IPC + preload — expose state to renderer
9. Renderer — new resume UX + drift summary display
10. Git config — `.gitattributes` + `.gitignore`

## How to Test

### Basic pause/resume
1. Start a loop, let 2+ stages complete
2. Pause (or kill the process)
3. Resume — verify correct stage, no duplicates

### Artifact drift
1. Pause a run
2. Delete a spec folder or uncheck tasks
3. Resume — verify reconciliation adjusts the plan

### Crash recovery
1. Start a loop, trigger a user question
2. Kill the process
3. Restart — verify the question reappears
