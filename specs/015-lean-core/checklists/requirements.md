# Specification Quality Checklist: Lean Core — Keep the Loop, Drop the Time Machine, Run on Existing Projects

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-11-05
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

- Validated in one pass on 2026-11-05; two wording fixes applied (FR-045, FR-047) to remove interface and SDK names.
- Deliberate exceptions to "no implementation details", because they are user-facing contracts rather than internals:
  - the files a human reads or writes (`.dex/queue.json`, `.dex/policy.json`, `.dex/questions.md`, `specs/<id>/verify.md`, `tasks.md`);
  - the headless commands (`dex run`, `dex queue init`) and their flags;
  - the tool names a policy rule targets (Edit, Write, NotebookEdit, shell commands).
- The audience is the Dex operator, a software engineer. "Non-technical stakeholder" is read as "no code-level knowledge of Dex needed".
- SC-006 and SC-007 measure the source tree (bypass references, line counts). They come verbatim from the brief's Definition of Done, and the size reduction is the business goal of this feature.
- FR-047 and FR-048 are delivery constraints (upgrade first, keep tests green per phase) carried over from the brief's implementation order.
- 2026-11-05, after `/speckit-plan`: FR-001 (last table row plus the branch-read note), FR-024 (`status` is now a human-owned override), US4 scenario 3, one edge case, and the "derived status" assumption were amended to match plan research R2 and R5. Re-validated: all items still pass.
- No [NEEDS CLARIFICATION] markers: the brief marks a proposed default for each of its 8 open decisions, and the spec adopts all of them (Assumptions). One gap in the brief was closed with a default: the clean-tree check ignores Dex's own `.dex/` files, because Dex writes entry status into the tracked queue but never commits.
