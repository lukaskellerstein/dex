# Feature Specification: Unified Logs & Diagnostics Layout

**Feature Branch**: `004-logs-alignment`
**Created**: 2026-04-17
**Status**: Draft
**Input**: User description: "Reorganise Dex's on-disk log and diagnostic layout into predictable roots-by-scope and subdirectories-by-concern. Every writer module points at a new path; on first run, a small idempotent migration helper moves legacy files into place so no historical data is lost."

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Predictable, self-describing diagnostic layout (Priority: P1)

As a developer debugging a Dex run, I want every log, database, and state artefact to live under a single, consistently-structured root whose subdirectories describe what's inside them, so I can find the file that answers my question without hunting across `/tmp/`, home directory, and project directories.

**Why this priority**: Diagnostics is the primary failure mode investigation path. Today the artefacts are scattered — ephemeral logs in `/tmp/dex-logs/`, the audit DB next to a fallback log in `~/.dex/`, per-project state split between `.dex/` and `.claude/rules/`. The scatter makes every debugging session start with "where does that file live again?". A unified layout collapses that lookup step.

**Independent Test**: After the change is in place, a fresh developer (or Claude instance) can locate any log or state artefact by reading only `CLAUDE.md` and `.claude/rules/06-testing.md`; no tribal knowledge or grep-the-codebase step is required. The directory structure itself documents the purpose of each file.

**Acceptance Scenarios**:

1. **Given** Dex has completed at least one run, **When** an engineer inspects `~/.dex/`, **Then** they see three subdirectories — `db/` (audit database + WAL/SHM), `logs/` (per-run orchestrator logs plus a fallback log), `dev-logs/` (dev-server output) — and no loose files at the root.
2. **Given** a project has been opened in Dex, **When** an engineer inspects `<projectDir>/.dex/`, **Then** they see exactly the files that describe project state (`state.json`, `state.lock`, `feature-manifest.json`, `learnings.md`) and nothing else.
3. **Given** the documentation describes where to find diagnostics, **When** an engineer follows those paths, **Then** every path referenced in `CLAUDE.md` and `.claude/rules/06-testing.md` matches the actual on-disk layout.

---

### User Story 2 — Zero historical-data loss on upgrade (Priority: P1)

As an existing Dex user, when I upgrade to the version that introduces the new layout, I want my prior runs, audit history, and accumulated learnings to be preserved automatically without any manual action on my part.

**Why this priority**: Audit data (`data.db`) is the source of truth for every past run — cost, timing, subagent behaviour. Losing it regresses the Loop Dashboard and breaks any forensic investigation of past incidents. Learnings are user-curated notes the orchestrator accrues over time; re-generating them is costly and lossy. Data preservation is therefore a hard constraint, not a nice-to-have.

**Independent Test**: Starting from a home directory with pre-upgrade `~/.dex/data.db` (non-empty), pre-upgrade `~/.dex/orchestrator.log` (if present), and a project with `<projectDir>/.claude/rules/learnings.md` (if present), launch the upgraded app once. All three artefacts appear in their new locations with identical contents, and the Loop Dashboard continues to list every pre-upgrade run.

**Acceptance Scenarios**:

1. **Given** a user has pre-upgrade audit data at the legacy paths, **When** the upgraded Dex starts for the first time, **Then** the data is relocated to the new paths before any component reads or writes it, and the user observes no data loss.
2. **Given** the migration has already run once, **When** Dex restarts, **Then** the migration step is a silent no-op — no files are moved, no errors are thrown, and startup time is unaffected.
3. **Given** a user has no pre-upgrade files at the legacy paths (fresh install), **When** Dex starts, **Then** the new layout is created on demand by normal writes and no migration activity occurs.

---

### User Story 3 — Dev-server logs outside `/tmp/` (Priority: P2)

As a developer running `./dev-setup.sh`, I want the Vite and Electron log files to live under `~/.dex/` alongside the rest of the diagnostic tree, so the rules for finding them match the rules for finding every other Dex artefact.

**Why this priority**: `/tmp/` is outside the one-root mental model this feature establishes. Keeping dev-server logs there is a visible inconsistency that erodes the value of User Story 1. It is P2 rather than P1 because the loss is ergonomic — `/tmp/dex-logs/` still works, it just breaks the pattern.

**Independent Test**: Run `./dev-setup.sh` on a machine where `~/.dex/dev-logs/` does not yet exist. After startup, the directory exists, contains both `vite.log` and `electron.log`, and the banner printed by the script points the user at those paths.

**Acceptance Scenarios**:

1. **Given** `dev-setup.sh` is run, **When** startup completes, **Then** `~/.dex/dev-logs/vite.log` and `~/.dex/dev-logs/electron.log` exist and contain the current session's output.
2. **Given** `dev-setup.sh` has just started, **When** it prints its banner, **Then** the banner tells the user the new paths (no stale `/tmp/` references).

---

### Edge Cases

- **Concurrent migration attempts.** If two Dex processes somehow start near-simultaneously on the same machine, the migration must not corrupt state. Because each move is atomic (same-filesystem rename) and guarded by existence checks on both the source and destination, the second process sees the destination already exists and skips the move; no duplicate files, no partial copies.
- **Permissions failure under `~/.dex/`.** If the user does not have write permission to create the new subdirectories (unusual but possible on locked-down machines), the migration should fail fast with a clear, actionable error rather than silently falling back to the legacy path. Silent fallback would mean the user's data is half-migrated and diverging across two locations — worse than a loud failure.
- **Partially migrated legacy state.** If a previous attempt moved `data.db` but not `data.db-wal` (e.g., a crash mid-migration — not possible with `renameSync` but worth specifying), the next run completes the remaining moves. Each file is migrated independently with its own idempotent guard.
- **Legacy file and new file both present.** Should never occur under normal operation, but if it does (e.g., a user manually copied a file) the migration defers to the new-path file and leaves the legacy file in place for the user to inspect/delete. No silent overwrite of the user's data.
- **Migration source does not exist.** Fresh install — the migration is a no-op, no warnings logged, startup proceeds as normal.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST store the audit database and its WAL/SHM sidecar files in a dedicated `db/` subdirectory under the global Dex home.
- **FR-002**: The system MUST store per-run orchestrator logs under a dedicated `logs/` subdirectory under the global Dex home, preserving the existing `<project>/<runId>/phase-N_slug/` tree structure.
- **FR-003**: The system MUST store the pre-run fallback orchestrator log inside the `logs/` subdirectory, under a filename that sorts before any project directory (so it's visually prominent when the directory is listed).
- **FR-004**: The system MUST store dev-server logs (Vite and Electron stdout/stderr captured by `dev-setup.sh`) under a dedicated `dev-logs/` subdirectory under the global Dex home, replacing the previous `/tmp/` location.
- **FR-005**: The system MUST store per-project state in `<projectDir>/.dex/` only — covering lifecycle state, lock file, feature manifest, and accumulated learnings. No per-project data may be written under `<projectDir>/.claude/`.
- **FR-006**: On first start after upgrade, the system MUST detect each legacy artefact (audit DB + sidecars, fallback orchestrator log, project-level learnings file) and relocate it atomically to its new path before any component reads or writes that artefact.
- **FR-007**: The migration step MUST be idempotent: subsequent runs detect that the migration has already occurred and perform no filesystem operations and log no errors.
- **FR-008**: The migration step MUST NOT overwrite an existing file at the destination path. If both legacy and new-path files exist, the legacy file is left in place untouched and the new-path file is preserved as authoritative.
- **FR-009**: The system MUST surface the new paths in its first-run user-visible output (dev-setup banner) so a user starting fresh knows where to look without reading documentation.
- **FR-010**: Project documentation (`CLAUDE.md`, `.claude/rules/06-testing.md`) MUST describe the final layout precisely, including every directory and file an engineer would need to reach during debugging.
- **FR-011**: The system MUST NOT change the content format of any artefact. Log line format, database schema, and JSON state file shapes remain identical to their pre-migration equivalents.
- **FR-012**: The system MUST NOT expose log paths through the IPC surface. No renderer-visible API reads or writes the affected paths; the reorganisation is entirely server-side.
- **FR-013**: If migration cannot complete (e.g., permission denied on the Dex home directory), the system MUST fail initialisation with a clear error rather than falling back silently to legacy paths.

### Key Entities *(include if feature involves data)*

- **Global Dex home** (`~/.dex/`): The single root containing all machine-level Dex data. After the change, contains exactly three subdirectories (`db/`, `logs/`, `dev-logs/`) and no loose files.
- **Audit database** (`~/.dex/db/data.db` + WAL + SHM): SQLite store of run/phase/step/subagent/loop-cycle records. Moved as a unit — the three files must travel together.
- **Per-run log tree** (`~/.dex/logs/<project>/<runId>/…`): Hierarchical text logs, one directory per run, one subdirectory per phase, one file per subagent. Structure unchanged; only the parent directory is codified.
- **Fallback orchestrator log** (`~/.dex/logs/_orchestrator.log`): Catch-all log written when the orchestrator is in a pre-run state with no `runId` yet. Underscore prefix keeps it sorted above project directories in listings.
- **Dev-server logs** (`~/.dex/dev-logs/vite.log`, `electron.log`): Per-session truncated captures of the bundler and Electron main process output, written by `dev-setup.sh`.
- **Per-project state** (`<projectDir>/.dex/state.json`, `state.lock`, `feature-manifest.json`, `learnings.md`): Project-scoped artefacts, kept together so a project's Dex footprint is visible in one directory.
- **Migration helper**: A small, idempotent routine invoked at process startup by each writer module before its first write. Detects legacy files and relocates them atomically using same-filesystem rename.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An engineer can name the correct on-disk path for any Dex log or state artefact within 10 seconds by reading `CLAUDE.md` — no codebase grep required.
- **SC-002**: Zero historical runs are lost across the upgrade: the count of rows in the `runs` table before and after the migration is identical, and every pre-upgrade `runId` remains visible in the Loop Dashboard.
- **SC-003**: The migration completes in under 1 second on a machine with a fresh `~/.dex/` containing a typical working-set DB (≤100 runs), measured from orchestrator process start to first audit-DB write.
- **SC-004**: Restarting Dex 10 times in a row after a successful migration results in zero filesystem writes attributable to the migration helper (measured by watching the relevant paths).
- **SC-005**: Project documentation accuracy is 100%: every path reference in `CLAUDE.md` and `.claude/rules/06-testing.md` resolves to a real file/directory on a running instance.

## Assumptions

- **Same-filesystem moves.** The legacy and new paths live on the same filesystem (both under `~/.dex/` or both inside a project's `.dex/`), so `renameSync` is atomic and cross-device fallback logic is unnecessary.
- **No upgrade dual-boot.** Users do not routinely alternate between the pre-migration and post-migration versions of Dex against the same home directory. A forward-only migration is acceptable; reverting requires manual file moves.
- **`<projectDir>/.dex/` is committable.** The per-project state directory is already the intended home for committed project state (per existing CLAUDE.md), except for `state.lock` which is gitignored. Adding `learnings.md` to this directory keeps it within the same commit policy.
- **No existing `.dex/artifacts/` users.** CLAUDE.md previously mentioned `<projectDir>/.dex/artifacts/` for phase artefacts with SHA-256 hashes, but this subdirectory was never implemented. Removing the mention is a documentation correction, not a feature removal.
- **`/tmp/dex-pr-body-*.md` stays ephemeral.** Short-lived PR-body buffer files passed to `gh` continue to live in `/tmp/` because they are cleaned by the OS and never meant for post-session inspection.
- **Renderer and IPC contracts unchanged.** The renderer queries the audit DB via existing typed IPC helpers, which know the DB path only indirectly through the main-process initialisation; relocating the DB requires no renderer or preload change.
- **No schema or format changes.** The reorganisation is purely a layout change. SQLite schema and log-line format remain identical, which means the migration is safe to run against any pre-upgrade state without backwards-incompatibility concerns.
