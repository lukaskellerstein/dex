# File-size exceptions

`scripts/check-size.sh` (wired to `npm run check:size`) fails when any file under
`src/` exceeds **600 LOC**. This file is the allow-list's rationale — the script
names it in both its header comment and its failure message, so the two must
agree. The executable list is the `ALLOWLIST` array in the script; this document
explains *why* each entry is there.

## Perpetual exceptions

These are allow-listed indefinitely. Both are single-responsibility modules whose
size comes from breadth of cases, not from tangled concerns — splitting them
would scatter one coherent contract across files.

| File | LOC | Why |
|:--|--:|:--|
| `src/core/state.ts` | 759 | State reconciliation. One state machine; the length is the number of transitions it has to cover. Revisit under a dedicated state-reconciliation spec. |
| `src/core/agent/ClaudeAgentRunner.ts` | 873 | The Claude Agent SDK adapter. Length is SDK surface — hooks, stream handling, subagent lifecycle. Revisit under a dedicated SDK-adapter spec. |

## Retired exceptions

Scheduled deferrals from 011-refactoring, each removed when its wave landed:

| File | Retired | Result |
|:--|:--|:--|
| `src/core/stages/main-loop.ts` | Wave A4.5 | 824 → 573 LOC |
| `src/renderer/hooks/useOrchestrator.ts` | Wave B | 910 → 511 LOC |
| `src/renderer/App.tsx` | Wave C-rest | 717 → 506 LOC |

## Current violations — undecided

As of 2026-08-03 three files exceed the limit and are **not** allow-listed, so
`check:size` exits 1. Each needs a decision: split it, or add it to `ALLOWLIST`
with a justification above.

| File | LOC | Note |
|:--|--:|:--|
| `src/core/stages/main-loop.ts` | 764 | **Regressed.** Wave A4.5 brought it to 573; it has since grown past the limit again. |
| `src/renderer/components/checkpoints/timelineLayout.ts` | 683 | Added by 010-interactive-timeline, after this allow-list was written. Pure layout function — plausibly splittable by concern (lanes / edges / bands). |
| `src/renderer/components/checkpoints/TimelineGraph.tsx` | 628 | Added by 010-interactive-timeline. SVG rendering + d3-zoom wiring in one component. |

Until that decision is made, `npm run check:size` fails on these three. That is
the policy working as designed — the limit is only meaningful if exceeding it
blocks — but it does mean `npm test` exits non-zero on a clean checkout.
