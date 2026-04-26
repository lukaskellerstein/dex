# Implementation Plan: Interactive Timeline — Click-to-Jump Canvas + Variant Agent Profiles

**Branch**: `010-interactive-timeline` | **Date**: 2026-04-25 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/010-interactive-timeline/spec.md`

## Summary

Two coupled changes that share one substrate (the Timeline data flow):

1. **Timeline becomes the canonical canvas.** Rebuild `TimelineGraph` + `timelineLayout` around branch columns, step-commit chains, and reachability edges; wire single-click to a new `checkpoints:jumpTo` IPC that does the right git operation (no-op / checkout / fork attempt). Move "Keep this", "Unmark kept", and "Try N ways from here" to a right-click context menu (`<CommitContextMenu>`). Delete `<NodeDetailPanel>` and `<PastAttemptsList>`. The Steps tab loses its independent state and projects from a new `selectedPath: string[]` carried inside `TimelineSnapshot`.
2. **Variants become first-class.** Introduce `AgentProfile` as a folder on disk under `<projectDir>/.dex/agents/<name>/` with a small `dex.json` knob file plus optional runner-native subdirectory (`.claude/`). The Try-N-ways modal grows a per-variant form (profile dropdown + inline overrides + overlay-content chip). At spawn time, on worktree-friendly stages, copy the profile's `.claude/` top-level entries into the variant's worktree; the runner's CWD-based discovery picks them up. On sequential stages, only the Dex-side knobs (`model`, `systemPromptAppend`, `allowedTools`) flow through to `query()`. The project root's `.claude/` is never touched.

The two halves share `TimelineSnapshot` as the single source of truth — adding `commits[]` and `selectedPath[]` to its shape — and the existing 008 worktree flow as the isolation boundary for the overlay step.

## Technical Context

**Language/Version**: TypeScript 5.6+ (strict mode), Node.js bundled with Electron 41 (Node 20 runtime).
**Primary Dependencies**: Unchanged — `@anthropic-ai/claude-agent-sdk` ^0.1.45, `electron` ^41.2.1, `react` ^18.3.1, `gsap` ^3.12.5, `lucide-react` ^0.460.0, `d3-shape` + `d3-zoom` (already used by current `TimelineGraph`). **No new dependencies.** Filesystem work uses `node:fs`, `node:path`, `node:crypto`; git invocations reuse `safeExec()`/`gitExec()` from `src/core/checkpoints.ts`.
**Storage**:
- `<projectDir>/.dex/agents/<name>/dex.json` — per-profile knob file (NEW; committable).
- `<projectDir>/.dex/agents/<name>/.claude/…` — optional runner-native overlay tree (NEW; committable).
- `<projectDir>/.dex/variant-groups/<groupId>.json` — extended to record `profile.name` + `profile.agentDir` per variant (existing file; new fields).
- `<projectDir>/.dex/worktrees/<branch>/.claude/` — overwritten in-place at spawn time by `applyOverlay()` (existing 008 worktree; new files materialized inside it).
**Testing**:
- `npx tsc --noEmit` for type safety.
- `npx tsx --test src/core/__tests__/*.test.ts` for new + extended core tests (`timelineLayout.test.ts`, `jumpTo.test.ts`, `agentProfile.test.ts`, `agentOverlay.test.ts`).
- `electron-chrome` MCP (CDP 9333) for end-to-end UI verification per the spec's DoD.
**Target Platform**: Electron desktop app (frameless window) — primary Linux, secondary macOS. Windows is not a release target.
**Project Type**: Desktop application (Electron main + React 18 renderer + platform-agnostic core).
**Performance Goals**:
- `timelineLayout()` runs in ≤16 ms for any project with ≤200 step-commits (so the Timeline re-renders within one frame on every snapshot tick).
- `selectedPath` recomputation after a `jumpTo` propagates to `<StageList>` within one render frame (≤16 ms target — SC-004).
- `applyOverlay()` for a `.claude/` tree of typical project size (≤500 KB) completes in ≤50 ms per variant, since this runs inline with `git worktree add` for each spawn.
**Constraints**:
- Project root's `.claude/` MUST be byte-for-byte unchanged after any variant spawn (SC-007). Verified by hashing before/after in tests.
- `src/core/` MUST remain free of `electron`, `src/main/`, and `src/renderer/` imports (Constitution II).
- All git invocations go through `safeExec()`/`gitExec()` so dirty-tree detection and error swallowing remain consistent with 008.
- Try-N-ways modal MUST not regress the existing cost-estimate path (`checkpoints:estimateVariantCost` IPC stays unchanged).
**Scale/Scope**:
- Typical project carries 5–50 step-commits over a few cycles; outlier projects (long autonomous runs) up to ~200. Layout must scale to 200.
- Typical user defines 0–5 profiles per project; modal scales 2–5 variants per spawn (existing 008 limit).
- ≈24 files touched, 2 deleted, 7 new (per the spec's File table).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

**I. Clean-Context Orchestration** — ✅ Pass.
The agent-profile feature only widens the inputs to `query()` (`model`, system-prompt append, `allowedTools`) and the runner's `cwd`. Each `query()` call still owns its own context; nothing about profiles introduces cross-call state. Hooks remain unaffected.

**II. Platform-Agnostic Core** — ✅ Pass.
- `src/core/agent-profile.ts` (NEW) and `src/core/agent-overlay.ts` (NEW) use only `node:fs`, `node:path`, `node:crypto` and existing `src/core/checkpoints.ts` helpers. No `electron`, no `src/main/*`, no `src/renderer/*`.
- All UI state (selection, context menu, modal form) lives in `src/renderer/`. The renderer talks to core only via the existing IPC pattern (new handlers in `src/main/ipc/checkpoints.ts` + a new `src/main/ipc/profiles.ts`).
- The shared shape (`TimelineSnapshot.commits`, `TimelineSnapshot.selectedPath`, `AgentProfile`, `TimelineCommit`) is defined in core and consumed by both sides via the preload bridge.

**III. Test Before Report** — ✅ Pass.
- Core: four targeted tests (`timelineLayout.test.ts` extended, plus new `jumpTo.test.ts`, `agentProfile.test.ts`, `agentOverlay.test.ts`) all run under `npx tsx --test`.
- Type check: `npx tsc --noEmit` after every step.
- UI: the spec's DoD already enumerates 11 MCP-driven scenarios; the quickstart in this plan formalises the same flow.

**IV. Simplicity First** — ✅ Pass with one explicit phasing call-out.
- Top-level file replacement, not deep merge — matches "three similar lines beat a premature abstraction".
- No in-app profile editor (filesystem only in v1) — keeps the surface area minimal.
- No `~/.dex/agents/` library — project-scoped only.
- Codex / Copilot stubs are typed but inert; no speculative wiring.
- The phasing call-out — sequential-stage `.claude/` overlay deferred — is justified: in-place `.claude/` swap on the project root is risky if the orchestrator dies mid-swap, and 008 already has "container-isolated worktrees" tracked as the unlock. We do **not** introduce a partial swap mechanism that we'd later have to migrate.

**V. Mandatory Workflow** — ✅ Pass.
- Understand: covered in spec + this plan's research phase.
- Plan: this document.
- Implement: order in spec's "Implementation order" (13 steps) is preserved in `tasks.md` (Phase 2 output).
- Test: per Principle III above.
- Report: post-implementation summary against the spec's DoD list.

**Result**: All gates pass. Proceeding to Phase 0.

## Project Structure

### Documentation (this feature)

```text
specs/010-interactive-timeline/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
│   ├── ipc-checkpoints-jumpTo.md
│   ├── ipc-profiles.md
│   └── timeline-snapshot.md
├── checklists/
│   └── requirements.md  # /speckit.specify checklist (already created)
├── spec.md              # /speckit.specify output (already created)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

The repo follows the standard Dex layout (Electron main + platform-agnostic core + React renderer). This feature touches the same three subtrees:

```text
src/
├── core/                                         # Platform-agnostic engine
│   ├── checkpoints.ts                            # EXTEND: TimelineSnapshot.{commits,selectedPath}, jumpTo(), VariantSpawnRequest.profile, applyOverlay() call site in spawnVariants()
│   ├── agent-profile.ts                          # NEW: AgentProfile union, dex.json parser/validator, persona presets, listProfiles()/loadProfile()/saveDexJson()
│   ├── agent-overlay.ts                          # NEW: applyOverlay(worktreePath, profile) — top-level .claude/ copy
│   ├── agent/
│   │   └── ClaudeAgentRunner.ts                  # EXTEND: accept profile?: ClaudeProfile; thread model / systemPromptAppend / allowedTools / cwd into query()
│   └── __tests__/
│       ├── timelineLayout.test.ts                # EXTEND: branch-column / color / selectedPath / kept overlay fixtures
│       ├── jumpTo.test.ts                        # NEW: branch-tip vs fork; HEAD no-op; dirty-tree refusal
│       ├── agentProfile.test.ts                  # NEW: dex.json parsing; listProfiles fixtures; type narrowing
│       └── agentOverlay.test.ts                  # NEW: top-level copy; no-op when missing; project-root untouched
│
├── main/
│   ├── ipc/
│   │   ├── checkpoints.ts                        # EXTEND: register checkpoints:jumpTo handler; listTimeline error fallback adds {commits:[], selectedPath:[]}
│   │   └── profiles.ts                           # NEW: profiles:list, profiles:saveDexJson handlers
│   └── preload.ts                                # EXTEND: expose jumpTo(), profiles.list(), profiles.saveDexJson()
│
└── renderer/
    ├── electron.d.ts                             # EXTEND: type new APIs
    ├── components/
    │   ├── checkpoints/
    │   │   ├── timelineLayout.ts                 # REWRITE: branch columns + step-commit chain + reachability + cross-column edges + 3-color state
    │   │   ├── TimelineGraph.tsx                 # REWRITE: branch column headers; left-click → jumpTo; right-click → context menu; render colors + red ring
    │   │   ├── TimelinePanel.tsx                 # SIMPLIFY: drop NodeDetailPanel + PastAttemptsList; full-width graph
    │   │   ├── TimelineView.tsx                  # SIMPLIFY: trim props that fed the removed children
    │   │   ├── CommitContextMenu.tsx             # NEW: right-click menu (Keep / Unmark / Try N ways)
    │   │   ├── TryNWaysModal.tsx                 # REWRITE BODY: per-variant form + Apply-same toggle + sequential warning
    │   │   ├── AgentProfileForm.tsx              # NEW: reusable per-variant form (also reusable later in profile library)
    │   │   ├── NodeDetailPanel.tsx               # DELETE
    │   │   └── PastAttemptsList.tsx              # DELETE
    │   └── loop/
    │       ├── StageList.tsx                     # EXTEND: derive status from selectedPath; new pause-pending state + icon
    │       ├── ProcessStepper.tsx                # EXTEND: macro-phase status from selectedPath
    │       └── LoopDashboard.tsx                 # WIRE: pass selectedPath from useTimeline snapshot to both children
    └── components/checkpoints/hooks/             # (existing useTimeline hook continues to publish the snapshot)
```

**Structure Decision**: Standard Dex layout. No new top-level directories. The new core modules (`agent-profile.ts`, `agent-overlay.ts`) live alongside `checkpoints.ts` in `src/core/` because they share its lifecycle (spawn-time + IPC consumers); putting them in a new subfolder would create churn without benefit.

## Complexity Tracking

> No constitution violations to justify.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| (none) | | |

The single phasing call-out — `.claude/` overlay deferred on sequential stages — is **not** a violation: it is a deliberate scope decision that aligns with Principle IV (Simplicity First). It is documented in the spec's *Out of Scope / Follow-ups* section and tied to the same engineering 008 already calls out as future work (container-isolated worktrees).
