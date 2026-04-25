<!--
Sync Impact Report
- Version change: (none) → 1.0.0 (mock fixture — not a real constitution)
- Modified principles: N/A
-->

# Mock Project Constitution

## Core Principles

### I. Deterministic

Every stage of the mock loop has exactly one predictable outcome. The agent
does not make choices — it replays a script.

### II. Fast

A full multi-cycle mock run finishes in under 60 seconds. No external network
calls, no LLM tokens.

### III. Loud on Drift

If the script is missing an entry or a fixture is absent, the loop halts
immediately with a coordinate-level error. No silent fakes.

## Governance

This constitution is a fixture. It exists only to give downstream stages
(constitution, manifest_extraction, plan, tasks) a real file to read. Editing
it has no runtime effect beyond changing what the next mock run copies into
`.specify/memory/constitution.md`.

**Version**: 1.0.0 | **Ratified**: 2026-04-18
