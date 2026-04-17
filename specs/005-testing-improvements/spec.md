# Feature Specification: Fast-Path Testing via Fixture Branches

**Feature Branch**: `005-testing-improvements`
**Created**: 2026-04-17
**Status**: Draft
**Input**: User description: "Fast-path testing via git fixture branches on dex-ecommerce to skip LLM-heavy early stages of the Dex Loop during E2E tests" (full context: `docs/my-specs/005-testing-improvements/README.md`)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Resume into the implement loop from a pre-captured checkpoint (Priority: P1)

A Dex maintainer is iterating on orchestrator behavior that only takes effect from the `implement` stage onward (e.g., a change to how tasks are dispatched, how `tasks.md` checkboxes are updated, or how subagent logs are routed). Today, every test cycle forces them to wait 15–20 minutes while prerequisites, clarification, constitution, manifest extraction, gap analysis, specify, plan, and tasks all run unchanged. They want a single command that restores `dex-ecommerce` to a snapshot taken right after the `tasks` stage, so the next Dex run boots directly into `implement`.

**Why this priority**: This is the dominant case for day-to-day Dex development. Most in-flight work touches the implement loop or later. Shrinking the test cycle from ~15–20 minutes to seconds compounds across every iteration and is the single largest engineering-velocity win in scope.

**Independent Test**: Run the reset script targeting the `after-tasks` checkpoint on a freshly-cloned `dex-ecommerce`, launch Dex through the welcome screen, and observe that the first stage emitted by the orchestrator is `implement` (not `prerequisites`). No changes to the Dex app or orchestrator code are required for this to work; it delivers value standalone.

**Acceptance Scenarios**:

1. **Given** `dex-ecommerce` is in any state (clean, partially modified, or on a stale run branch), **When** the maintainer runs the reset script with the `after-tasks` checkpoint, **Then** the working tree matches the fixture branch exactly, the current branch is the fixture branch, and `git status` is clean.
2. **Given** the workspace has just been reset to `after-tasks`, **When** the maintainer opens the project in Dex via the welcome screen, **Then** the welcome submit button reads **Open Existing** and the loop page's primary button reads **Resume** (not **Start**).
3. **Given** the maintainer clicks **Resume**, **When** the orchestrator starts, **Then** it skips prerequisites, reuses the existing `runId`, and the first stage it emits is `implement` for the feature captured in the fixture.
4. **Given** the fixture captures `lastCompletedStage: "tasks"`, **When** `reconcileState()` runs on launch, **Then** it reports zero drift (every artifact hash matches `state.artifacts.*.sha256`).

---

### User Story 2 - Resume into specify/plan/tasks from a pre-clarified checkpoint (Priority: P2)

A Dex maintainer is working on a change that affects how the orchestrator produces `specs/` content (e.g., adjusting the `plan` or `tasks` subagent's prompt, tweaking `reconcileState()`'s handling of `specs/` drift). They do not want to re-run clarification and constitution for every test, but they do need the specify/plan/tasks stages to execute fresh under the new code. They want a checkpoint that has GOAL clarification, domain docs, constitution, and feature manifest all committed, but no `specs/` directory yet.

**Why this priority**: Important but less frequent than P1. Applies whenever stages `specify`, `plan`, `tasks`, or `gap_analysis` are under test.

**Independent Test**: Run the reset script targeting the `after-clarification` checkpoint, launch Dex, and observe that the first stage emitted is `gap_analysis` or `specify` — neither prerequisites nor any clarification sub-stage nor constitution nor manifest_extraction should run.

**Acceptance Scenarios**:

1. **Given** `dex-ecommerce` is reset to `after-clarification`, **When** Dex resumes the loop, **Then** the orchestrator's first emitted stage is `gap_analysis` or `specify` (whichever `reconcileState()` selects next).
2. **Given** the fixture captures `lastCompletedStage: "manifest_extraction"`, **When** the loop runs end-to-end, **Then** it produces a `specs/` directory that matches the structure a fresh run would produce, with no state.json corruption warnings.

---

### User Story 3 - Preserve the existing clean-reset path unchanged (Priority: P3)

A Dex maintainer is testing a change that affects prerequisites, clarification, or any other stage captured inside the fixtures themselves. They need the full run from scratch, exactly as today. They should not have to learn a new command; the existing reset procedure must keep working.

**Why this priority**: Baseline — non-regression. Must be preserved; breaking the clean path breaks the entire testing protocol for deeper changes.

**Independent Test**: Run the reset script with the `clean` checkpoint and confirm the resulting workspace is indistinguishable (file-by-file, branch state, and `git status` output) from what the current manual reset commands (`git checkout main && git reset --hard HEAD && git clean -fdx`) produce.

**Acceptance Scenarios**:

1. **Given** any workspace state, **When** the maintainer runs the reset script with the `clean` checkpoint, **Then** the resulting workspace contains only `GOAL.md` and `.git/`, is on branch `main`, and `git status` is clean.
2. **Given** the clean reset completes, **When** the maintainer walks through the welcome screen and starts the loop, **Then** the orchestrator runs every stage from `prerequisites` through `implement` exactly as it does today.

---

### User Story 4 - Prune stale run branches on the example repo (Priority: P3)

Every autonomous run leaves behind a `dex/YYYY-MM-DD-xxxxxx` branch on `dex-ecommerce`. Over weeks of testing these accumulate to dozens of dead branches, cluttering `git branch` output and making it harder to see fixtures and real development branches. A maintainer wants a one-command cleanup that removes aged run branches while leaving reserved names untouched.

**Why this priority**: Quality-of-life / hygiene. Not required for the P1/P2 value, but ships alongside at near-zero cost and solves an existing pain point.

**Independent Test**: Populate `dex-ecommerce` with several `dex/*` branches, some with committer dates within 7 days and some older, plus reserved branches (`main`, `fixture/*`, `lukas/*`). Run the prune script and confirm only `dex/*` branches older than 7 days are deleted; all reserved names remain.

**Acceptance Scenarios**:

1. **Given** `dex-ecommerce` has `dex/*` branches with varying committer dates, **When** the maintainer runs the prune script, **Then** branches whose tip commit is older than 7 days are deleted and branches within 7 days remain.
2. **Given** `dex-ecommerce` has `main`, `fixture/after-clarification`, `fixture/after-tasks`, and `lukas/*` branches, **When** the maintainer runs the prune script, **Then** none of those branches are affected regardless of age.

---

### User Story 5 - Refresh a fixture when inputs evolve (Priority: P3)

When `GOAL.md`, the constitution template, the clarification prompts, or the spec templates change in a way that alters fixture content, a maintainer needs a documented, repeatable workflow to regenerate both fixtures. Critically, refreshing must not spawn new branch names (`fixture/after-tasks-v2`) — the existing pointer must move to the new commit.

**Why this priority**: Operational — infrequent but necessary to keep fixtures honest. Without this, fixtures silently rot and `reconcileState()` starts rewinding them (which defeats the purpose).

**Independent Test**: Starting from a clean reset, run the loop to each fixture point and confirm the documented refresh workflow (pause → commit → `git branch -f`) produces an updated fixture branch at the same name, with no stale duplicate branches created.

**Acceptance Scenarios**:

1. **Given** the maintainer has paused the loop at `manifest_extraction`, **When** they follow the documented refresh workflow for `after-clarification`, **Then** `fixture/after-clarification` points to the new commit and no `fixture/after-clarification-*` variant is created.
2. **Given** both fixtures have been refreshed, **When** the maintainer lists `git branch -l 'fixture/*'`, **Then** exactly two entries appear.

---

### Edge Cases

- **Fixture branch missing**: Script exits with a non-zero status and an error message naming the missing branch. Does not silently fall back to clean.
- **Fixture drift — `state.json.branchName` disagrees with checked-out branch**: Script detects the mismatch (the same condition `detectStaleState` guards at runtime) and fails loudly rather than handing Dex a booby-trapped workspace.
- **Uncommitted changes in `dex-ecommerce` when the reset runs**: Script is destructive by design (same trust boundary as today's reset commands) and wipes them. The script is the only authorized destructive path against `dex-ecommerce` and must not be invoked against any other repo.
- **Orchestrator artifact schema evolves after a fixture was captured**: `reconcileState()` detects the hash mismatch and rewinds to the earliest affected stage; the fixture is not bypassed, only short-circuited where the hashes match. Maintainer refreshes the fixture per User Story 5.
- **Prune script run on a machine with no `dex/*` branches**: Exits cleanly with no output and no error.
- **Prune script encounters a `dex/*` branch that is currently checked out**: Branch is not deleted (git protects the current branch); script continues with the remaining candidates.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The repository MUST provide a single reset script that takes one argument — a checkpoint name from the set `{clean, after-clarification, after-tasks}` — and restores the `dex-ecommerce` working tree to that checkpoint.
- **FR-002**: The `clean` checkpoint MUST produce a workspace byte-for-byte equivalent to running `git checkout main && git reset --hard HEAD && git clean -fdx` on `dex-ecommerce` today.
- **FR-003**: The `after-clarification` and `after-tasks` checkpoints MUST restore the workspace by checking out the corresponding `fixture/<checkpoint>` git branch, after first discarding any uncommitted changes and untracked files.
- **FR-004**: The reset script MUST verify that the requested fixture branch exists before touching the workspace, and exit with a non-zero status and a clear error message if it does not.
- **FR-005**: After restoring a fixture checkpoint, the reset script MUST verify that `.dex/state.json`'s `branchName` field equals the checked-out fixture branch name, and exit with a non-zero status if it does not.
- **FR-006**: The reset script MUST reject unknown checkpoint arguments with exit code 2 and a usage message.
- **FR-007**: The reset script MUST operate exclusively on the pinned `dex-ecommerce` path. No mechanism may retarget it to another repository. The script's destructive authorization is scoped to that path and no other.
- **FR-008**: The `fixture/after-clarification` branch MUST capture, at a minimum, the clarified GOAL, product and technical domain docs, the constitution, the `.specify/` bootstrap, `.dex/feature-manifest.json`, and `.dex/state.json` with `lastCompletedStage` set to `manifest_extraction`. It MUST NOT contain a `specs/` directory.
- **FR-009**: The `fixture/after-tasks` branch MUST capture everything in `after-clarification` plus the first feature's `specs/<feature>/` directory (including spec.md, plan.md, tasks.md, data-model.md, research.md, quickstart.md, contracts/, and checklists/), `.dex/state.json` with `lastCompletedStage: "tasks"` and `currentSpecDir` pointing to that feature, and the feature marked `active` in `.dex/feature-manifest.json`.
- **FR-010**: The `fixture/*` branch namespace MUST be reserved. No automated process (including the orchestrator's run branches) may create branches under this prefix.
- **FR-011**: Only two fixture branches may exist at any time: `fixture/after-clarification` and `fixture/after-tasks`. Refreshes MUST move these pointers in place via `git branch -f`; versioned variants (e.g., `fixture/after-tasks-v2`) are disallowed.
- **FR-012**: The repository MUST provide a prune script that deletes local branches matching `dex/*` whose tip commit is older than 7 days, while leaving `main`, `fixture/*`, and `lukas/*` untouched regardless of age.
- **FR-013**: The prune script MUST be manually invoked (not automated via hook or schedule). It MUST NOT modify remote branches and MUST NOT delete the currently checked-out branch.
- **FR-014**: The testing documentation (`.claude/rules/06-testing.md §4c.1`) MUST be updated to: keep the existing clean-reset instructions as the default; introduce the reset script with a table mapping each checkpoint to the stages it skips; provide guidance on when to use each checkpoint; document that the welcome submit button will read **Open Existing** and the loop button will read **Resume** after restoring a fixture; document the `fixture/*` reservation and the refresh workflow.
- **FR-015**: No source code in `src/core/`, `src/main/`, or `src/renderer/` may be modified. The feature depends on the existing orchestrator resume path (`config.resume=true`, `reconcileState()`, `STAGE_ORDER`, `detectStaleState`) as stable contracts.
- **FR-016**: The refresh workflow MUST be documented end-to-end: reset clean → start the loop → pause at the appropriate `stage_completed` event → commit and force-move the fixture branch. Stale commits left behind are expected to be garbage-collected by git.

### Key Entities

- **Checkpoint**: A named logical state of `dex-ecommerce`. Three values: `clean` (blank slate on `main`), `after-clarification` (post-manifest-extraction, pre-specify), `after-tasks` (post-tasks for the first feature, pre-implement). Each checkpoint maps 1:1 to either `main` or a fixture branch.
- **Fixture Branch**: A long-lived, force-updatable git branch on `dex-ecommerce` named `fixture/<checkpoint>`. Its tree captures a committed snapshot of `.dex/`, `.specify/`, and (for `after-tasks`) `specs/` at the corresponding loop checkpoint. Its `state.json.branchName` equals the branch name itself so `detectStaleState` accepts it as current.
- **Reset Script**: The single authorized destructive entry point against `dex-ecommerce`. Dispatches on checkpoint name. Its authorization scope is identical to today's manual reset snippet in the testing protocol.
- **Prune Script**: A manual hygiene helper that deletes aged local run branches (`dex/*`) without touching reserved prefixes. Orthogonal to fixtures but shipped alongside because it addresses the same "branch bloat" concern.
- **Reserved Branch Prefix**: Namespaces the feature treats as off-limits for automated creation or deletion. `fixture/*` is protected from orchestrator use; `main`, `fixture/*`, and `lukas/*` are protected from prune.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Wall-clock time from "workspace on `main`" to "orchestrator emits its first `implement` event" via the `after-tasks` path is under 60 seconds on a typical developer machine. (Baseline: 15–20 minutes.)
- **SC-002**: Wall-clock time from "workspace on `main`" to "orchestrator emits its first `specify` or `gap_analysis` event" via the `after-clarification` path is under 60 seconds. (Baseline: 5–10 minutes.)
- **SC-003**: The clean-reset path produces a workspace that is file-for-file and `git status`-output identical to the pre-feature manual reset procedure. Zero observed differences across the verification matrix.
- **SC-004**: After restoring either fixture, `reconcileState()` reports zero drift on launch (no artifact hash mismatches, no rewind warnings in the orchestrator log).
- **SC-005**: After 10 consecutive end-to-end test runs across mixed checkpoints, `git branch -l 'fixture/*'` on `dex-ecommerce` returns exactly two entries — no versioned variants accumulate.
- **SC-006**: Drift detection remains functional: deleting `specs/<feature>/plan.md` from an `after-tasks` restore and launching causes `reconcileState()` to rewind that feature to the `planning` stage with a warning logged — proving fixtures short-circuit only when honest.
- **SC-007**: Supplying an unknown checkpoint argument to the reset script produces exit code 2 and a usage message on stderr; supplying a missing fixture branch name produces a non-zero exit with a clear error; supplying a fixture whose `state.json.branchName` mismatches the checked-out branch produces a non-zero exit with a drift message.
- **SC-008**: The prune script, run against a `dex-ecommerce` with a mix of `dex/*` branches aged across the 7-day threshold plus reserved branches, deletes only the aged `dex/*` branches — verified by branch count before/after against the threshold partition.

## Assumptions

- The `dex-ecommerce` example repository lives at the pinned path `/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce` and is the only target. Portability to other machines/users is out of scope for v1.
- Fixtures live locally on the developer's machine. Pushing to `origin/fixture/*` for team sharing is a future concern; if done, the same "force-update in place" rule applies.
- The orchestrator's resume path (`config.resume=true`, `reconcileState()` artifact hashing, `STAGE_ORDER` lookup, `detectStaleState` branch-name check) is a stable internal contract and will not change as part of this work.
- Fixture refresh is infrequent and manual — triggered when `GOAL.md`, the constitution template, clarification prompts, or the spec templates evolve enough that fixture content no longer matches a fresh run. No tooling automates detection of this drift.
- Mid-implement fixtures are out of scope. If partial implement progress is needed for a test, the maintainer starts from `after-tasks` and hand-ticks a few `tasks.md` checkboxes rather than maintaining a third fixture.
- The 7-day threshold for branch pruning is a reasonable default matching current developer habits. Tuning is a future concern.
- The `dex/*` prefix is exclusively produced by the orchestrator for autonomous run branches; nothing else in `dex-ecommerce` uses it. The `lukas/*` and `fixture/*` prefixes are likewise not produced by the orchestrator.
- Destructive bash commands against `dex-ecommerce` (equivalent to `git reset --hard` + `git clean -fdx`) are pre-authorized by the existing testing protocol. The reset script inherits that authorization and no broader scope.
