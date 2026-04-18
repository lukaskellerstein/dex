# Implementation Plan: Authentication (mock)

**Input**: specs/<feature>/spec.md

## Summary

Minimal authentication slice: session-based login with email + password and
logout. No OAuth, no password reset, no MFA.

## Technical Context

**Language/Version**: TypeScript 5.6+ (strict)
**Primary Dependencies**: Node/Electron — no new additions in this mock.
**Storage**: In-memory for the mock (a Map keyed by email).

## Project Structure

```
src/mock/
└── c1-f-001.ts   # this feature's placeholder module
```
