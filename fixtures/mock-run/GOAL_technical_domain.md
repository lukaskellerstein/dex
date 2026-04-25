# Technical Domain (mock fixture)

## Stack

- Language: TypeScript (strict).
- Runtime: Node + Electron 41.
- Tests: node:test with --experimental-strip-types.

## Architecture

Monolith for the mock. Each feature lands as a single module under
`src/mock/c<cycle>-<featureId>.ts`. No external services.

## Build / Test / Deploy

- Build: `npx tsc`
- Test: `node --test` on compiled output
- Deploy: N/A for this fixture
