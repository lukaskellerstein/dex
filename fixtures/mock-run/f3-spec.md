# Feature Specification: Final feature (mock)

**Feature**: 3 — Final feature
**Status**: Draft

Third feature in the mock fixture set. Exists so multi-cycle mock runs can
exercise cross-cycle checkpoint behavior (timeline, Go Back into an earlier
cycle, Try Again mid-run). After this cycle completes, the orchestrator
transitions to its synthetic GAPS_COMPLETE decision and terminates cleanly.

## User Scenarios

### User Story 1 — A third slice (P1)

A user exercises the third feature's happy path. The slice is deliberately
small — a single rendered button that dispatches a mock action.

**Acceptance Scenarios**:

1. **Given** the mock app, **When** the user clicks the feature-3 button,
   **Then** an action is dispatched and the UI reflects it.

## Requirements

- **FR-001**: The third feature MUST produce a non-empty checkpoint commit so
  the mock run validates cross-cycle checkpoint wiring.
