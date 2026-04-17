# Specification Quality Checklist: Retire SQLite audit DB in favor of per-project JSON files

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-04-17
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- This feature is internally-facing — the "users" in user stories are developers using Dex against their own projects, which is the only user class Dex serves. That framing is faithful to the product's audience and not a leak of implementation detail.
- The spec deliberately names a small number of file paths (`~/.dex/db/`, `~/.dex/logs/<project>/<runId>/phase-<n>_*/agent.log`, `<projectDir>/.dex/state.lock`) because they are user-observable filesystem locations the user inspects/edits/gitignores directly, not implementation choices. The legacy database directory in particular must be named so the cleanup behavior is unambiguous.
- The spec mentions four data-access helper names (`listRuns`, `getRun`, `getPhaseSubagents`, `getPhaseSteps`) under FR-008 to lock down the no-renderer-rewrite contract. These are public surface names that already exist; treating them as preserved-naming requirements is a stability commitment, not an implementation detail.
- `better-sqlite3` is named explicitly in FR-007 and SC-008 because it is the concrete dependency being removed and "the native-compiled audit DB library" alone would be ambiguous at acceptance time. Naming the package is a verification specificity, not a design choice.
- Items marked incomplete require spec updates before `/speckit.clarify` or `/speckit.plan`.
