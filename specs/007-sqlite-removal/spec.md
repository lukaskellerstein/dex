# Feature Specification: Retire SQLite audit DB in favor of per-project JSON files

**Feature Branch**: `007-sqlite-removal`
**Created**: 2026-04-17
**Status**: Draft
**Input**: User description: "read /home/lukas/Projects/Github/lukaskellerstein/dex/docs/my-specs/007-sqlite-removal/README.md"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Inspect audit data with plain file tooling (Priority: P1)

A developer using Dex wants to answer a quick question about a run they just executed — "what did it cost?", "how long did the plan phase take?", "did any subagent fail?" — without opening the UI or dropping into a SQL shell. Today this requires a multi-line `sqlite3` query against a database in their home directory. After this feature, every run is a standalone JSON file inside the project's own `.dex/runs/` directory, readable with standard tooling (`cat`, `jq`, text editor, IDE preview).

**Why this priority**: This is the single largest ergonomic gap the feature fixes. The audit trail exists to help developers understand and debug runs; if the cheapest form of inspection requires SQL, the trail is under-used. P1 because every downstream benefit (locality, isolation, zero deps) depends on the JSON-first storage model this story introduces.

**Independent Test**: Start a Dex run on any project, let it complete one loop cycle, then run `cat <projectDir>/.dex/runs/<runId>.json | jq '.totalCostUsd, (.phases | length)'` from a plain shell. Expect a cost number and a phase count, with no Dex process running and no database tool involved.

**Acceptance Scenarios**:

1. **Given** a completed run in a project, **When** the user opens `<projectDir>/.dex/runs/<runId>.json` in any text tool, **Then** they see a human-readable record with the run's mode, timestamps, status, total cost, and an ordered list of phases (each with timings, cost, status, and subagents).
2. **Given** a run in progress, **When** the user re-reads the same JSON file between phase boundaries, **Then** the file reflects the latest committed state (phase-start updates are visible as soon as that phase begins).
3. **Given** a completed run, **When** the user asks "show me the tool calls the plan phase made", **Then** the system renders that detail from the existing per-run log tree at `~/.dex/logs/<project>/<runId>/phase-<n>_*/agent.log` — the JSON records are a summary, not a full trace replacement.

---

### User Story 2 - Audit history lives with the project (Priority: P1)

A developer moves a Dex-managed project folder to another machine, clones it from git, or deletes it entirely. Audit history travels with the project (if committed) or is cleanly absent (if the folder is gone) — there are no orphan rows in a global database that outlive the project, and no "my history disappeared" surprises when moving between machines.

**Why this priority**: Locality is the structural reason the DB has to go. As long as audit data sits in `~/.dex/db/data.db`, it is decoupled from the project it describes — a bug in every direction (zombie rows after project deletion, missing history after migration, no way to share history with a teammate). P1 because the checkpoint feature (`008-interactive-checkpoint`) assumes this locality as its foundation.

**Independent Test**: Run Dex against a project; note its run identifier and the contents of `<projectDir>/.dex/runs/<runId>.json`. Delete the project folder. Confirm that nothing about that run remains elsewhere on the machine except the text log tree under `~/.dex/logs/<project>/` (which is intentional — logs are machine-local, unlike the audit summary).

**Acceptance Scenarios**:

1. **Given** a project with run history, **When** the user deletes the project folder, **Then** no audit records for that project remain in any global location.
2. **Given** a project committed to git with `.dex/runs/` not ignored, **When** the user clones the repo on a second machine, **Then** past runs are visible in the Dex UI on the second machine without any import step.
3. **Given** a project with `.dex/runs/` explicitly listed in `.gitignore`, **When** the user clones the repo elsewhere, **Then** no audit records are present and the UI shows an empty runs list — no errors, no warnings beyond "no runs yet".

---

### User Story 3 - Zero cross-project contamination (Priority: P2)

A developer runs Dex against multiple projects on the same machine. Each project sees only its own runs. There is no global query that can accidentally mix runs from project A with runs from project B. If the developer wants an aggregate view across projects, that requires an explicit, opt-in action.

**Why this priority**: Today every query needs a `WHERE project = ?` filter and forgetting that filter silently produces wrong results. P2 because the bug is latent (not actively reported), but the new model eliminates the class of error entirely — there is no global bucket to forget to filter.

**Independent Test**: Open project A in Dex and complete a cycle. Open project B in Dex and complete a cycle. In each project's UI, verify the runs list contains exactly that project's runs. On disk, verify that `<projectA>/.dex/runs/` contains only A's run files and `<projectB>/.dex/runs/` contains only B's.

**Acceptance Scenarios**:

1. **Given** two projects each with completed runs on the same machine, **When** the user opens the runs list in project A, **Then** only project A's runs appear, with no possibility of project B's data leaking in.
2. **Given** the same setup, **When** the user opens project B, **Then** project B's runs list is populated independently and matches B's on-disk files.

---

### User Story 4 - UI parity — no visible regression (Priority: P1)

All existing Dex UI surfaces that depend on audit data — runs list, run detail, per-phase cost/duration, subagent breakdown, and the trace view that shows individual tool calls — continue to work identically after the switch. A user who does not read release notes should be unable to tell the storage layer changed.

**Why this priority**: This is the feature's non-regression floor. If any of these surfaces breaks, the feature is not shippable even if the storage model is conceptually cleaner. P1 alongside Story 1 because the two are co-dependent: we cannot ship JSON storage without keeping the UI intact.

**Independent Test**: Before and after the change, run the same scripted scenario (reset the example project, run one cycle, click through runs list → run detail → phase detail → trace view). Compare screenshots and verify every visible field matches: run identifier, mode, status, total cost, per-phase duration, per-phase cost, subagent list with timings, and tool-call steps in the trace view.

**Acceptance Scenarios**:

1. **Given** a completed run, **When** the user opens the runs list, **Then** the list shows the same fields (identifier, mode, start time, status, total cost) it did before, in the same order and with matching values.
2. **Given** a run in progress, **When** the user opens its trace view, **Then** per-phase tool-call steps appear with the same content and ordering as before.
3. **Given** an opened phase, **When** the user expands the subagent breakdown, **Then** each subagent shows the same type, status, start/end timestamps, duration, and cost as before.

---

### User Story 5 - Clean install, no native build (Priority: P2)

A developer cloning the Dex repository and running the standard install flow gets a working build without any native-compilation step. This simplifies CI, reduces install time on Node version bumps, and removes the class of "install broke because the native audit DB module failed to rebuild" failures.

**Why this priority**: Dev-experience win with a real time-cost in the current workflow (native rebuild on every Electron major-version bump). P2 because it's a background improvement — nobody is actively blocked, but everyone benefits.

**Independent Test**: On a fresh machine or clean installed-dependencies tree, run the standard install flow. Confirm no native-module download/compile runs during install, no post-install hook executes, and the installed dependency tree no longer contains `better-sqlite3` or its type definitions.

**Acceptance Scenarios**:

1. **Given** a fresh checkout, **When** the user runs the standard install command, **Then** the install completes without invoking any native-module build.
2. **Given** the installed tree, **When** the user searches for `better-sqlite3` in the lockfile, **Then** no match is found.

---

### Edge Cases

- **First launch after the change**: the user's machine still has `~/.dex/db/` from a prior release. Dex detects and removes the legacy directory on first launch and emits a one-line informational log entry. It does NOT attempt to migrate data — dev-phase, prior history is discarded by design.
- **Manually corrupted or partially-written run JSON**: a run file fails to parse. The runs list skips that file with a single warning log entry and continues; the UI does not crash. A corrupted file is not silently rewritten — it is left in place so the user can recover it manually.
- **Missing log file when opening trace view**: the run JSON exists but the expected `~/.dex/logs/<project>/<runId>/phase-<n>_*/agent.log` file is missing (e.g., log tree was manually deleted). The trace view shows an empty state with a clear "log file not found at `<path>`" message — not an error banner.
- **Concurrent writers on the same project**: ruled out by the existing single-writer invariant — `<projectDir>/.dex/state.lock` is a PID file held for the duration of one orchestrator process per project. This feature does not change that invariant; writes to `.dex/runs/` happen under the same implicit lock.
- **Two projects at the same absolute path**: cannot happen on a single filesystem; if the user uses symlinks to alias one project under two paths, each path is treated as an independent project and has its own `.dex/runs/`. This matches current behavior for `.dex/state.json`.
- **Cross-machine clock skew in committed run files**: run records use ISO-8601 timestamps at millisecond precision. If a team commits audit records and clocks differ across contributors, runs may appear out-of-order when sorted by start time across machines. Documented as a known cosmetic effect; not a correctness issue.
- **Cross-project aggregate queries**: intentionally out of scope. If a user wants "total spend across all my Dex projects", they walk known project directories explicitly — no hidden global index exists.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST store each run's audit summary as a single JSON file located inside that project's audit directory, one file per run, named by the run's identifier.
- **FR-002**: The system MUST write the initial run file at run start with skeleton content (identifier, mode, start timestamp, status `running`, empty phase list) and update it in place throughout the run lifecycle on every phase start, phase completion, subagent lifecycle event, and run termination.
- **FR-003**: The system MUST preserve, in each run's JSON, the set of fields currently shown by the UI — mode, start/end timestamps, run status, total cost, and for each phase: stage name, cycle number, feature slug, timings, status, cost, token counts (when available), and the list of subagents with type, status, timings, and cost.
- **FR-004**: The system MUST source per-phase tool-call-level detail (the "trace steps" shown when the user drills into a phase) from the existing per-run log tree at `~/.dex/logs/<project>/<runId>/phase-<n>_*/agent.log` — the JSON records MUST NOT duplicate this detail.
- **FR-005**: The system MUST isolate audit data between projects by virtue of its location — a project's audit directory is inside that project, and no global index or shared file contains records for more than one project.
- **FR-006**: The system MUST, on the first application launch after this change is installed, detect and remove the legacy global audit database directory (`~/.dex/db/`) and log that it did so.
- **FR-007**: The system MUST NOT depend on any native-compiled database library; the installed dependency tree after this change MUST be free of `better-sqlite3` and its type definitions.
- **FR-008**: The system MUST preserve the names of the public in-process data-access helpers used by the UI (`listRuns`, `getRun`, `getPhaseSubagents`, `getPhaseSteps`) so renderer components continue to call the same functions; only the implementation changes.
- **FR-009**: The system MUST allow the user to decide whether the audit directory is committed to version control — nothing in the system enforces one policy or the other, and the default is "not ignored" so users must opt in to ignoring it.
- **FR-010**: The system MUST gracefully skip and log a warning for any run JSON that fails to parse, without crashing the runs list or the UI.
- **FR-011**: The system MUST render a clear "log file not found" empty state in the trace view when the backing log file for a phase is missing, rather than an error dialog.
- **FR-012**: The system MUST treat writes to a project's audit directory as covered by the existing single-writer lock (`<projectDir>/.dex/state.lock`); no new locking primitive is introduced.
- **FR-013**: The system MUST NOT attempt to migrate data from the legacy audit database to the new format — legacy data is discarded.
- **FR-014**: The system MUST expose the project directory as an explicit parameter on every data-access path that reaches the audit files, since storage is now per-project rather than global.

### Key Entities *(include if feature involves data)*

- **Run Record**: the full audit summary of one orchestrator invocation. Captures the run's identifier, mode (`loop`, `build`, or `plan`), start/end timestamps, status (`running`, `completed`, `paused`, `failed`, `stopped`), accumulated cost, and the ordered list of phases. One Run Record maps to one file under the project's audit directory.
- **Phase Record**: the audit summary of one stage within a run. Captures a stable phase-trace identifier, the stage name, the cycle number within the run, the feature slug (when derivable from the active spec directory), timings, status (`running`, `completed`, `failed`, `stopped`), cost, token counts (when available), an ordered list of subagents, and placeholders for checkpoint metadata to be populated by the `008-interactive-checkpoint` feature.
- **Subagent Record**: the audit summary of one spawned subagent within a phase. Captures the subagent's identifier, type (e.g., `specify`, `plan`), status, start/end timestamps, duration, and cost.
- **Project Audit Directory**: the per-project directory (inside the project's `.dex/` area) that contains all Run Records for that project. Its presence/absence in version control is an opt-in per-project choice.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A developer can answer "what did my last run cost?" and "how many phases ran?" using only a file viewer and `jq` — no Dex process, no SQL shell — in under 30 seconds from a cold start on the terminal.
- **SC-002**: After first launch post-upgrade, 0 bytes of audit data remain outside of per-project directories on the user's machine (the legacy global audit directory is fully removed).
- **SC-003**: The standard install flow completes without triggering a native-module build step, reducing install time on Node-version changes by the duration previously spent on native rebuilds.
- **SC-004**: Opening a run's trace view for a typical phase (≤500 steps) produces the first visible frame within 100 ms of the click, matching or beating current SQLite-backed performance.
- **SC-005**: Running a loop cycle against the example project and then running a second cycle against a different project on the same machine produces two disjoint run-file sets — each project's audit directory contains exactly its own runs, zero cross-contamination across 100% of test invocations.
- **SC-006**: A user who deletes a project folder leaves zero audit-trail orphans on their machine for that project (measured by scanning the home directory for any file referencing that project's identifiers).
- **SC-007**: All existing UI views (runs list, run detail, per-phase cost/duration, subagent list, trace view) render the same visible fields with identical values before and after the change for the same reproducible scenario — screenshot-diff parity verified on the example project's one-cycle run.
- **SC-008**: Zero new runtime dependencies are added to the project; exactly one is removed (the native-compiled audit DB library plus its type definitions).

## Assumptions

- **Scale**: typical project has under ~1,000 audit rows (10–50 runs × ~20 phases each). JSON files of this size load into memory in milliseconds and aggregate faster than SQL would over the same data.
- **Single-writer per project**: enforced by the existing `<projectDir>/.dex/state.lock` PID file, held for the duration of one orchestrator process. This feature does not change that invariant and adds no new locking primitive.
- **Dev-phase policy**: no backward compatibility is required. Existing audit data in `~/.dex/db/data.db` is acceptable to wipe; users are not expected to have production-critical history to preserve.
- **Per-run log tree is authoritative for tool-call detail**: `~/.dex/logs/<project>/<runId>/phase-<n>_*/agent.log` is already the source of truth for structured per-step events, and this feature does not change that. The audit JSON is a summary; the log tree is the trace.
- **Gitignore default is "not ignored"**: the project defaults to including the audit directory in version control. Users who want private traces add the directory to `.gitignore`. This is a documentation choice, not a system-enforced policy.
- **UI field names**: renderer components may need minor field-name adjustments, but the shape of returned data stays close to today's SQL-projection shape (identifier, stage, cost, duration, timestamps) — this is a lightweight rename, not a UI rewrite.
- **Independence from 008**: this feature is independent of `008-interactive-checkpoint` and ships first. Checkpoint metadata fields exist on the phase record as optional slots but are populated only by the checkpoint feature when it lands.
- **Cross-project aggregation**: any "total cost across all my Dex projects" capability is explicitly out of scope; if needed later, it is a thin walker over known project directories, not a restored global database.
- **Archival/cleanup**: long-term growth of the audit directory is out of scope for this feature. A follow-up prune script can sweep files older than a threshold.
- **Legacy DB cleanup is one-shot and silent**: the first post-upgrade launch removes the legacy audit directory and logs a single informational line; subsequent launches do nothing.
