# Implementation Plan: Final feature (mock)

## Summary

Third feature in the mock set. Validates cross-cycle checkpoint behavior —
the orchestrator runs a full cycle for this feature and then terminates
naturally when the manifest shows no more pending features.

## Technical Context

**Language/Version**: TypeScript 5.6+ (strict)
**Primary Dependencies**: Node/Electron — no additions.

## Project Structure

```
src/mock/
└── c3-f-003.ts   # this feature's placeholder module
```
