# Feature Specification: Authentication (mock)

**Feature**: 1 — Authentication
**Status**: Draft

## User Scenarios

### User Story 1 — Sign up, log in, log out (P1)

An end user visits the site, creates an account with email + password, logs in,
and logs out.

**Acceptance Scenarios**:

1. **Given** an unauthenticated visitor, **When** they submit a valid signup form,
   **Then** an account is created and they are logged in.
2. **Given** a logged-in user, **When** they click "Log out", **Then** their session
   ends and subsequent requests are unauthenticated.

## Requirements

- **FR-001**: The system MUST allow users to sign up with email + password.
- **FR-002**: The system MUST allow users to log in and log out.
- **FR-003**: Session state MUST persist across page reloads but end on logout.

## Success Criteria

- **SC-001**: A user can complete sign-up → log-in → log-out in under 30 seconds.
