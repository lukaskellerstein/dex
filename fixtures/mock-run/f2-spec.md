# Feature Specification: Payments (mock)

**Feature**: 2 — Payments
**Status**: Draft

## User Scenarios

### User Story 1 — Checkout with a credit card (P1)

A logged-in user adds items to a cart and completes checkout by providing a
credit card. An order record is created.

**Acceptance Scenarios**:

1. **Given** a cart with at least one item, **When** the user submits valid card
   details, **Then** an order is created and the user sees a confirmation.

## Requirements

- **FR-001**: Users MUST be able to check out with a credit card.
- **FR-002**: Each successful checkout MUST create exactly one order record.
- **FR-003**: Declined cards MUST NOT create an order.

## Success Criteria

- **SC-001**: 95% of valid checkouts complete in under 5 seconds.
