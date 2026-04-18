# Project Goal (mock fixture)

A small e-commerce demo consisting of three independent, composable features.

## Scope

1. **Authentication** — users can sign up, log in, and log out.
2. **Payments** — checkout flow that accepts a credit card and creates an order.
3. **Final feature** — a third deliberately-small slice so mock runs produce
   cross-cycle checkpoint history for the 008 checkpoint UX to operate on.
   The orchestrator terminates naturally after this cycle completes (the
   manifest shows no more pending features → synthetic `GAPS_COMPLETE`).

## Out of Scope

- Product catalog, inventory, shipping, reviews, admin panel. This fixture is
  deliberately narrow: it exists to exercise the orchestrator checkpoint surface
  under the mock agent, not to model a real product.

## Tech Constraints

- TypeScript, strict mode.
- No external runtime dependencies beyond Node + Electron.
- Each feature lands as one implementation file under `src/mock/c<cycle>-<featureId>.ts`.

## Non-Functional

- Feature implementations are symbolic: a single exported constant is enough to
  produce a non-empty diff and validate the checkpoint commit. Trace fidelity is
  intentionally sparse — one `agent_step` per stage.
