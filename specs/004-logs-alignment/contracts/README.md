# Contracts — intentionally empty

**Feature**: `004-logs-alignment`
**Phase**: 1 — Design

This feature introduces **no external interface changes**. No contract files are produced.

## Why

Spec-kit's `/contracts/` directory is the place to document interfaces the project exposes to external consumers — public APIs for libraries, IPC/HTTP endpoints, CLI command schemas, wire protocols. Changes to those contracts require careful documentation because they impact callers.

This feature is a purely internal refactor:

- **IPC surface** (`window.dexAPI.*`) — unchanged. No method is added, removed, renamed, or retyped. Renderer code compiles and runs without modification.
- **CLI surface** — not applicable; Dex has no CLI.
- **SQLite schema** — unchanged. No tables, columns, or indexes are added, removed, or altered.
- **Log line format** — unchanged. `[<ISO-timestamp>] [<LEVEL>] <message> <optional JSON>` stays identical byte-for-byte.
- **JSON state file shapes** — `state.json`, `feature-manifest.json` shapes unchanged.
- **Filesystem paths** — changed, but *filesystem paths are not an interface contract* in this project. No external tool (aside from the user visually inspecting the filesystem) reads these paths; they are implementation-internal. Documentation of the new layout lives in `CLAUDE.md` and `.claude/rules/06-testing.md` — the human-visible surface — rather than in a machine-readable contract file.

## What *does* change

The audit DB's on-disk location, the fallback log's on-disk location, the dev-server logs' on-disk location, and the per-project `learnings.md`'s on-disk location. Every change is covered in `data-model.md` and the migration call sites are enumerated in `plan.md`.

If a future feature exposes a Dex log path through an IPC method (e.g., "open the current run's log in the system editor"), that feature will need a contract entry here. At that point the abstraction crosses the process boundary, and external consumers take a dependency on the path shape.
