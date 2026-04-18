# Project Instructions (mock fixture)

This file is a fixture used by the mock agent backend (009-testing-checkpointing)
to stand in for a real CLAUDE.md an actual run would produce. Downstream stages
(plan, tasks, implement) read it as project guidance — its content is
intentionally minimal.

## Conventions

- Language: TypeScript (strict).
- Test runner: node:test with --experimental-strip-types.
- Each feature implementation lives in `src/mock/` with file name
  `c<cycle>-<featureId>.ts`.

## Non-Goals

- Real business logic. The mock produces placeholder modules whose only purpose
  is to generate a non-empty diff for each stage's checkpoint commit.
