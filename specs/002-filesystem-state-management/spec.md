# Feature Specification: Filesystem-First State Management with Git Checkpoints

**Feature Branch**: `lukas/full-dex`  
**Created**: 2026-04-16  
**Status**: Draft  
**Input**: User description: "Filesystem-first state management replacing DB-based resume with .dex/state.json committed to git, artifact integrity checking, and git checkpoints"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Reliable Pause/Resume Across Restarts (Priority: P1)

A user starts a multi-feature orchestration loop, pauses mid-run (or the app crashes), and resumes later. The system picks up exactly where it left off — correct stage, correct cycle, correct feature — without re-executing completed work or losing accumulated state (cost, completed features, failure counts).

**Why this priority**: This is the core value proposition. The current DB + in-memory approach causes state divergence on pause/resume, leading to duplicate work, lost progress, and incorrect failure tracking. Every other user story depends on a reliable state persistence mechanism.

**Independent Test**: Start a loop, let it complete 2+ stages, pause. Restart the app and resume. Verify the orchestrator continues from the next uncompleted stage with all accumulators intact.

**Acceptance Scenarios**:

1. **Given** a running loop at cycle 3, stage "implement", **When** the user pauses and resumes, **Then** the orchestrator resumes from the "implement" stage of cycle 3 with correct cost accumulator and failure counts.
2. **Given** a loop paused mid-run, **When** the Electron process is killed (crash), **Then** on restart the system recovers from the last committed checkpoint and resumes from the correct position.
3. **Given** a paused run, **When** the user resumes, **Then** the system does not re-execute any previously completed stages.

---

### User Story 2 - Artifact Integrity Detection on Resume (Priority: P2)

A user manually edits project files between sessions — deletes a spec folder, unchecks tasks in `tasks.md`, or modifies `GOAL_clarified.md`. On resume, the system detects these changes and adjusts its execution plan accordingly, re-running only the minimum necessary stages rather than starting over or ignoring the edits.

**Why this priority**: Manual edits to project artifacts are a common workflow (users tweak specs, revert tasks). Without drift detection, the orchestrator operates on stale assumptions, producing incorrect output or failing silently. This is the second most impactful problem after basic resume reliability.

**Independent Test**: Pause a run, manually delete a spec folder, resume. Verify the system detects the missing artifact and resets that feature to the "specifying" stage.

**Acceptance Scenarios**:

1. **Given** a paused run with a completed spec for feature X, **When** the user deletes feature X's spec folder and resumes, **Then** the system resets feature X to "specifying" and re-runs specification.
2. **Given** a paused run with checked tasks, **When** the user unchecks tasks in `tasks.md` and resumes, **Then** the system resumes implementation from the earliest unchecked phase.
3. **Given** a paused run, **When** the user modifies `GOAL_clarified.md`, **Then** the system asks the user whether to re-run gap analysis.
4. **Given** a paused run with no manual edits, **When** the user resumes, **Then** reconciliation completes with no drift detected and the orchestrator proceeds immediately.

---

### User Story 3 - Crash Recovery with Pending User Input (Priority: P2)

The app crashes while waiting for user input (e.g., a clarification question). On restart, the pending question is re-presented to the user without losing the question context, and the orchestrator resumes normally after the user answers.

**Why this priority**: Losing unanswered questions on crash forces the user to re-trigger the entire stage that prompted the question, wasting time and context.

**Independent Test**: Trigger a user input question, kill the app process, restart. Verify the question re-appears with its original context.

**Acceptance Scenarios**:

1. **Given** the orchestrator has asked a clarification question and is waiting for input, **When** the app crashes and restarts, **Then** the same question is re-presented with original context.
2. **Given** a re-presented question, **When** the user answers, **Then** the orchestrator resumes from the stage that prompted the question.

---

### User Story 4 - Branch-Scoped State with Clean Main (Priority: P3)

State is scoped to the git branch where work happens. When a feature branch is merged to main and the user starts a new loop on main, stale state from the merged branch is automatically cleaned up. No manual intervention required.

**Why this priority**: Without branch scoping, state from completed feature branches leaks into new work on main, causing confusion and incorrect resume behavior.

**Independent Test**: Complete a loop on a feature branch, merge to main, start a new loop on main. Verify stale state is detected and cleaned up automatically.

**Acceptance Scenarios**:

1. **Given** a completed run on branch `feature-x`, **When** `feature-x` is merged to main and a new loop starts on main, **Then** the stale state file is deleted and a fresh run begins.
2. **Given** a state file from branch `feature-a`, **When** the user switches to branch `feature-b` and starts a loop, **Then** the system detects stale state and starts fresh.

---

### User Story 5 - Migration from DB-Based Resume (Priority: P3)

Users with in-progress runs paused under the old DB-based resume system can upgrade without losing their progress. The system performs a one-time migration, reconstructing filesystem state from the database, and offers the user a chance to confirm before proceeding.

**Why this priority**: Without migration, upgrading strands in-progress work. This is a one-time transition path that affects existing users.

**Independent Test**: Pause a run using the old system, upgrade to the new version, start the app. Verify the migration prompt appears with correct run details and that confirming it creates a valid state file.

**Acceptance Scenarios**:

1. **Given** a paused run in the database with no state file, **When** the user starts the app after upgrading, **Then** the system reconstructs state from the DB and presents it for confirmation.
2. **Given** a migration prompt, **When** the user confirms, **Then** a valid state file is written and the normal resume flow proceeds.
3. **Given** a migration prompt, **When** the user declines, **Then** a fresh run starts without the old state.

---

### User Story 6 - Concurrent Instance Protection (Priority: P3)

Two Electron windows targeting the same project directory cannot corrupt the state file by writing simultaneously. The system uses advisory locking to prevent concurrent writes.

**Why this priority**: Data corruption from concurrent writes is catastrophic but the scenario (two windows on same project) is uncommon. Important for correctness but lower frequency than other scenarios.

**Independent Test**: Open two Electron windows on the same project, attempt to start runs in both. Verify the second instance is blocked with an appropriate message.

**Acceptance Scenarios**:

1. **Given** one instance holding the state lock, **When** a second instance attempts to write state, **Then** the second instance is blocked with an informative error.
2. **Given** a lock held by a crashed process, **When** a new instance starts, **Then** the stale lock is detected (dead process) and safely acquired.

---

### Edge Cases

- What happens when the state file is manually deleted between sessions? System starts fresh (equivalent to "none" detection).
- What happens when the state file is corrupted (invalid JSON)? System treats it as missing and starts fresh.
- What happens when a git checkpoint reference no longer exists in history (force push, rebase)? Validation fails, system falls back to alternative state version or fresh start.
- What happens when the state file schema version is from a future version? System rejects unknown versions and starts fresh.
- What happens when merge conflicts occur on the state file between branches? Auto-resolved via "keep ours" merge strategy — current branch's version always wins.
- What happens when a lock file references a recycled PID (OS reused the PID for a different process)? Staleness threshold (10 minutes) catches this — no legitimate operation holds the lock that long.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST persist orchestrator state to a single filesystem file committed to the git branch after each stage completion.
- **FR-002**: System MUST record the orchestrator's position cursor (phase, cycle number, last completed stage, current spec directory) so resume picks up at the exact stage.
- **FR-003**: System MUST maintain an artifact integrity manifest with content hashes for all generated artifacts (specs, plans, tasks, goal files, constitution).
- **FR-004**: System MUST create a state-only git commit (state file only, not all tracked files) after each stage as a checkpoint.
- **FR-005**: System MUST detect and reconcile artifact drift on resume by comparing current content hashes against the manifest and checking git checkpoint alignment.
- **FR-006**: System MUST determine the minimum rollback point when drift is detected — re-running only from the furthest-back affected stage, never starting over entirely.
- **FR-007**: System MUST persist pending user input questions so they survive crashes and are re-presented on restart.
- **FR-008**: System MUST detect stale state from a different branch (via branch name comparison) and clean it up automatically on new loop start.
- **FR-009**: System MUST prevent concurrent state file writes from multiple instances targeting the same project directory via advisory file locking.
- **FR-010**: System MUST support one-time migration from the previous resume mechanism to filesystem-based resume for existing paused runs, with user confirmation before writing.
- **FR-011**: System MUST use atomic file writes (write to temp file, then rename) to prevent corruption from interrupted writes.
- **FR-012**: System MUST exclude the state directory from agent git commits to prevent agents from accidentally committing stale state.
- **FR-013**: System MUST continue writing to the existing audit trail (existing write paths preserved, not removed).
- **FR-014**: System MUST support state file schema versioning, rejecting unknown future versions gracefully (fresh start, not crash).
- **FR-015**: System MUST emit reconciliation events so the UI can display drift summaries to the user on resume.

### Key Entities

- **Orchestrator State**: The primary state record — contains position cursor, accumulators (cost, cycles, features), failure counts, configuration snapshot, artifact manifest, checkpoint reference, and pending question.
- **Artifact Entry**: A tracked file with its path, content hash, and completion timestamp.
- **Feature Artifacts**: Per-feature artifact tracking — spec, plan, tasks, implementation phase progress, and overall feature status lifecycle (specifying → planning → implementing → verifying → completed/skipped).
- **Reconciliation Result**: The output of integrity checking — resume point, warnings, blockers requiring user decision, state patches to apply, and drift summary for UI display.
- **Lock File**: Advisory lock metadata — process identifier and timestamp for staleness detection.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can pause and resume a multi-cycle orchestration run across app restarts with zero duplicate stage executions.
- **SC-002**: On resume, the system detects all manually edited, deleted, or added artifacts and adjusts its execution plan within 2 seconds for projects with up to 100 tracked artifacts.
- **SC-003**: Crash recovery (including pending question re-ask) completes without user intervention beyond answering the re-presented question.
- **SC-004**: Branch switching or merging never causes the orchestrator to resume stale state from a different branch.
- **SC-005**: Existing users with paused runs under the old system can migrate to the new system without losing progress.
- **SC-006**: Two simultaneous instances targeting the same project are prevented from corrupting state — the second instance receives a clear error.
- **SC-007**: Agent commits never contain the state file — verified by automated guards.

## Assumptions

- The project operates within a git repository and git is available on the system.
- The app has filesystem write access to the project directory.
- Content hashing of text-based artifacts is sufficient for change detection.
- The existing audit trail schema and write paths remain unchanged — this feature adds a parallel persistence layer, not a replacement.
- Advisory file locking (process-based with staleness detection) is sufficient for the expected concurrency model (multiple desktop windows, not distributed systems).
- A 10-minute staleness threshold for lock files is appropriate — no legitimate state write operation takes that long.
- State-only checkpoint commits are acceptable in the git history alongside agent work commits.
- The "keep ours" merge strategy for the state file is acceptable for the user's git workflow.
