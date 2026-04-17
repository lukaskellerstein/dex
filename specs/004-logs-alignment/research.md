# Research: Unified Logs & Diagnostics Layout

**Feature**: `004-logs-alignment`
**Phase**: 0 — Outline & Research
**Status**: Complete

The feature spec had no `[NEEDS CLARIFICATION]` markers (it was distilled from a fully-formed technical plan). This document records the design-level decisions that shape the implementation — each with the alternatives that were considered and rejected.

---

## Decision 1 — Migration primitive: `fs.renameSync` with double-sided existence guard

**Decision**: Migrate legacy files to their new paths using `fs.renameSync(oldPath, newPath)`, gated by `existsSync(oldPath) && !existsSync(newPath)`.

**Rationale**:

- `renameSync` is atomic on a single filesystem on both POSIX and Windows. The file either exists at the old path or the new path — never both, never neither, never partially.
- Both migrations in this feature operate within one filesystem: legacy and canonical locations are both under `~/.dex/` (global) or both inside `<projectDir>/` (per-project).
- The double-sided existence check makes the helper idempotent: repeated calls after a successful migration are zero-work no-ops. This satisfies FR-007.
- The helper does not overwrite existing destinations — if a user has somehow produced a file at the new path while the legacy file still exists, the legacy file is preserved untouched for manual inspection (FR-008).

**Alternatives considered**:

- **`copyFileSync` + `unlinkSync`**. *Rejected.* Two-step copy+delete has a window in which both files exist (losing "the legacy file is the source of truth" determinism) and a crash between steps leaves the old file intact while the new file is partial — data-loss hazard. No advantage over rename for same-FS moves.
- **Cross-filesystem fallback with `copyFile` + checksum verify + delete**. *Rejected.* Legitimate concern only if the Dex home and the project could span filesystems, but (a) both migrations operate within one directory root each, (b) the added complexity (checksum, retry, partial-state logic) is disproportionate to a scenario that does not exist in practice, and (c) if the scenario ever arose, `renameSync` would throw `EXDEV`, surfacing a clear error rather than silently corrupting data.
- **Transactional migration (stage everything, commit once)**. *Rejected.* No cross-file invariant needs to hold atomically — each legacy-to-new mapping is independent, so per-file atomicity is sufficient.

---

## Decision 2 — Invocation site: at the writer, before the first I/O

**Decision**: Each writer module calls `migrateIfNeeded` immediately before its first read or write of the owned path:

- `database.ts::initDatabase` calls it for `data.db`, `data.db-wal`, `data.db-shm` **before** `new Database(...)`.
- `orchestrator.ts::log` (fallback logger) calls it for `orchestrator.log` before the first `appendFileSync` to `FALLBACK_LOG`.
- `manifest.ts::appendLearnings` calls it for `<projectDir>/.claude/rules/learnings.md` before reading or writing `<projectDir>/.dex/learnings.md`.

**Rationale**:

- The writer is the only place guaranteed to run before any reader of the same path — there is no reader elsewhere that precedes these writes.
- Distributing the migration call prevents ordering bugs. A central "migrate all paths at app startup" step would have to be provably first; if a subsystem initialises lazily (the fallback log and `appendLearnings` both do), a central step may run too late or require an explicit wiring contract.
- Each call is O(1) after the first successful migration: a single `existsSync` check on the new path (returns `true`) short-circuits the helper. No measurable overhead.
- Localising the migration to the writer keeps `paths.ts` free of Electron lifecycle concerns and keeps each writer's responsibility self-contained — removing the need for anyone to remember a bootstrap sequence.

**Alternatives considered**:

- **Central "migrate on startup" in `src/main/index.ts`**. *Rejected.* Would couple the platform-agnostic core's migration to Electron's lifecycle, violating Principle II. Also creates an implicit ordering dependency between initialisation steps in `src/main/`.
- **Lazy one-shot module initialiser in `paths.ts`**. *Rejected.* Running filesystem mutations at module import time is a side effect that makes the module impossible to import in tests without touching disk. Keeping migration explicit at the call site is clearer and more testable.
- **Single call from `initDatabase` that migrates everything**. *Rejected.* `initDatabase` has no business knowing about `learnings.md` or the orchestrator fallback log. Violates single-responsibility and Simplicity-First; future changes to manifest paths would require touching database code.

---

## Decision 3 — Fallback log filename: underscore prefix (`_orchestrator.log`)

**Decision**: Name the fallback log `_orchestrator.log` (rather than `orchestrator.log`) inside `~/.dex/logs/`.

**Rationale**:

- `ls` sorts underscore-prefixed names before alphabetic names, so the fallback log appears at the top of `~/.dex/logs/` listings, above any project directories. When a developer opens the log root to diagnose a problem, the catch-all log is visually prominent.
- Zero code cost: it's just a filename.
- Disambiguates the fallback log from any future project name that might conflict (a project literally named "orchestrator" would collide without the prefix).

**Alternatives considered**:

- **`orchestrator.log`** (no prefix). *Rejected.* Would sort interleaved with project directories, burying the catch-all log among runs. Feels like noise rather than a landmark.
- **Nested under `logs/_pre-run/orchestrator.log`**. *Rejected.* Over-structured for a single file; the extra directory adds navigation cost for no meaningful organisation gain.

---

## Decision 4 — Dev-server logs: `~/.dex/dev-logs/` (out of `/tmp/`)

**Decision**: Relocate `vite.log` and `electron.log` from `/tmp/dex-logs/` to `~/.dex/dev-logs/`.

**Rationale**:

- Brings dev-server output under the same one-root mental model as every other Dex artefact. A developer looking for any Dex output goes to `~/.dex/` — no exceptions.
- Consistent with the existing `dev-setup.sh` behaviour of truncating both files on every restart; the new location is just as ephemeral, just more discoverable.
- Survives `/tmp` cleanup on reboot, which is occasionally useful when a crash in a dev session is investigated later.

**Alternatives considered**:

- **Leave in `/tmp/dex-logs/`**. *Rejected.* Perpetuates the inconsistency the feature exists to eliminate (User Story 1).
- **Write to `~/.dex/logs/dev/…`**. *Rejected.* `logs/` is per-run orchestrator output keyed by `runId`. Mixing dev-session captures into that tree blurs the purpose of each subdirectory. Separate concerns → separate subdirectories.

---

## Decision 5 — `/tmp/dex-pr-body-*.md` stays in `/tmp/`

**Decision**: The short-lived PR-body buffer files that the implement phase writes to `/tmp/` before passing them to `gh pr create` are **not** relocated.

**Rationale**:

- These files are ephemeral input buffers for a single subprocess call. They are never consumed by any reader other than `gh`, never inspected post-session, and are cleaned by the OS.
- Moving them to `~/.dex/` implies persistence that does not apply — a developer who sees them there may assume they contain meaningful state.
- `/tmp/` is the canonical location for short-lived process handoff files on POSIX.

**Alternatives considered**:

- **`~/.dex/pr-bodies/`**. *Rejected.* Implies historical retention that does not exist.

---

## Decision 6 — Forward-only migration, no reverse path

**Decision**: Do not support a "read from old path if present" fallback in any consumer. Once the migration runs, the legacy path is treated as non-existent by the app.

**Rationale**:

- Dual-path reader logic re-introduces the "where does that file live?" ambiguity the feature exists to eliminate — permanently. It would remain in the codebase long after the upgrade window closed.
- The migration is non-lossy (atomic rename), so there is no scenario where a user "needs" the old path to still work — the data is still there, just in the new place.
- A user who must revert to a pre-migration build performs a manual move. This is a one-time, power-user action; optimising the codebase for it is poor tradeoff.

**Alternatives considered**:

- **Dual-read, single-write**. *Rejected* — see above.
- **Versioned migration registry with up/down scripts**. *Rejected.* Gross over-engineering for a one-time path flattening with three sources.

---

## Decision 7 — No new tests

**Decision**: Do not add a unit-test layer for `paths.ts` or `migrateIfNeeded`. Verification is end-to-end against the `dex-ecommerce` example project per `quickstart.md` and `.claude/rules/06-testing.md` section 4c.

**Rationale**:

- The project does not currently ship a unit-test harness for the core engine — adding one for this feature alone would introduce a testing convention ahead of its justifying need (YAGNI).
- `migrateIfNeeded` is small, pure, and easy to verify by filesystem inspection. The tests that would exist at the unit level (legacy-exists-migrates, already-migrated-is-noop, both-exist-preserves-new) are covered at the quickstart level where they matter most — against the real writer code paths.
- Type-level correctness (`npx tsc --noEmit`) catches the class of bug most likely to regress in path code: a typo in a constant name or a wrong export.

**Alternatives considered**:

- **Add Vitest and a `paths.test.ts`**. *Rejected.* First test file in the core engine; establishing a test layer is a policy decision that exceeds this feature's scope.
- **Add a shell-based smoke test**. *Rejected.* Duplicates what `quickstart.md` already documents for the human verifier.
