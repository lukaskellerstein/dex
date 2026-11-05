# Feature Specification: Fixture A — a feature half done before Dex

**Feature Branch**: `900-fixture-a`

## User Scenarios

### User Story 1 — greet a user (P1)

A user runs the greeter and sees their name.

## Requirements

- **FR-001**: The greeter MUST print `Hello, <name>`.
- **FR-002**: The greeter MUST reject an empty name.

## Clarifications

### Session 2026-11-01

- Q: What does an empty name print? → A: An error on stderr, exit 2.
