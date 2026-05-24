# Feature Specification: Branch Management — Delete and Promote-to-Main with AI-Resolved Conflicts

**Feature Branch**: `014-branch-management`
**Created**: 2026-05-03
**Status**: Draft
**Input**: User description: "read /home/lukas/Projects/Github/lukaskellerstein/dex/docs/my-specs/014-branch-management/README.md"

## Overview

The interactive timeline lets users navigate between saved versions of their project but offers no way to remove a saved version they no longer want, or to declare "this is the version I'm keeping." Today, both gestures force the user to leave the application, open a terminal, and run version-control commands by hand. That breaks the product's core promise: the timeline should be the *only* surface a vibe-coder ever needs, and the underlying version-control machinery should stay invisible.

This feature adds two missing primitives directly to the timeline:

1. **Remove a saved version** — a one-click way to discard a version the user no longer cares about.
2. **Make this the new main** — promote any saved version into the project's primary line, with disagreements between versions resolved automatically by an AI agent so the user never sees a conflict marker.

Both gestures preserve the timeline's fork-and-rejoin shape so users keep visual continuity with where work came from.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Remove a saved version (Priority: P1)

A user has accumulated several saved versions on their timeline from prior exploration. They want to delete the ones they no longer need so the timeline shows only versions they care about — without ever opening a terminal.

**Why this priority**: This is the simplest of the two missing primitives and unblocks every cleanup workflow. A user who can't remove versions cannot keep the timeline tidy as exploration accumulates, and that alone makes them feel they need git knowledge. Shipping just this story already restores trust in the timeline as a self-contained surface.

**Independent Test**: Open a project that has at least one Dex-owned saved version on the timeline. Click the remove control on that version's badge. Verify the version disappears from the timeline, the application's current position moves automatically to the project's primary version, and no error or terminal prompt appears.

**Acceptance Scenarios**:

1. **Given** the timeline shows a saved version that is not the current position and carries no work that exists nowhere else, **When** the user clicks the remove control on that version's badge, **Then** the version disappears from the timeline, the current position remains unchanged, no warning modal appears, and the timeline refreshes within a few seconds.
2. **Given** the timeline shows a saved version that *is* the current position, **When** the user clicks the remove control on that version's badge, **Then** the application automatically switches the current position to the project's primary version before deletion, the version disappears, and a brief confirmation reflects the move.
3. **Given** a saved version carries work (one or more steps) that exists on no other saved version, **When** the user clicks the remove control, **Then** a confirmation modal appears titled "These steps will be lost" listing each at-risk step by its plain-English label (e.g. "Cycle 2 — Plan") plus a short identifier; choosing **Remove** deletes the version, choosing **Cancel** leaves it intact.
4. **Given** the user attempts to remove a version while a run is actively building that same version, **When** the remove control is clicked, **Then** a friendly message explains that the version is currently being built and asks the user to pause the run first; no destructive action is taken.
5. **Given** the user looks at the project's primary version (the protected version), or a version they themselves created outside of Dex, **When** they inspect that version's badge, **Then** no remove control is rendered, so the protected and user-owned versions cannot be deleted by mistake.

---

### User Story 2 — Make a saved version the new main, when versions agree (Priority: P1)

A user has explored the project across several saved versions and decided one of them is the version they want to keep going forward. They want to declare "this is the new main" with one gesture from the timeline. In this story, the chosen version's changes do not collide with any other change to the primary version.

**Why this priority**: This is the second missing primitive. Without it, every "I'm keeping this version" decision still requires a terminal. Pairing it with US1 covers the entire timeline-cleanup lifecycle. Shipping this story alone (with the conflict path deferred) already delivers value for the common case where a user explores a single direction and the primary version has not moved.

**Independent Test**: Prepare a project where the saved version contains all the changes and the primary version has not advanced since the fork point. Right-click the chosen version's badge, pick **"Make this the new main"** from the context menu, review the change summary in the confirmation modal, click confirm. Verify the primary version now contains the chosen version's work, the chosen version is removed from the timeline, the current position is on the primary version, and the timeline shows a fork-and-rejoin shape preserving the lineage.

**Acceptance Scenarios**:

1. **Given** a saved version is selected via right-click and the primary version has not advanced since the fork point, **When** the user picks "Make this the new main", **Then** a confirmation modal opens titled "Replace main with this version?" showing a summary (file count, +/- line counts, top changed file paths, an expander for the full list).
2. **Given** the confirmation modal is open, **When** the user clicks **Make this the new main**, **Then** the application combines the chosen version into the primary version, the source version is automatically removed from the timeline, the current position lands on the primary version, and a small confirmation toast reads "<chosen-version> is now main. The old version has been removed."
3. **Given** the combine succeeds, **When** the user inspects the timeline afterward, **Then** the timeline shows a fork-and-rejoin shape that visually preserves where the chosen version came from and where it joined the primary version, so the historical lineage is not lost.
4. **Given** the user attempts to promote a version while a run is actively building either the primary version or the chosen version, **When** the right-click menu is used, **Then** a friendly refusal explains that promotion is unavailable while a run is in progress; no destructive action is taken.
5. **Given** the user has unsaved changes in the working files when they trigger a promotion, **When** the action begins, **Then** the existing "save / discard / cancel" prompt for unsaved work appears first; if the user chooses to save, the change is saved on the current version before the promotion proceeds.
6. **Given** the user right-clicks the project's primary version, or a user-owned version outside Dex's saved-version namespace, **When** the context menu opens, **Then** "Make this the new main" is disabled with a tooltip explaining why, so unsupported promotions cannot be triggered.

---

### User Story 3 — AI resolves disagreements when promoting (Priority: P2)

A user promotes a saved version to become the new main, but the chosen version and the primary version both modified the same lines in one or more files. Without help, this leaves files containing conflict markers and forces the user back to a terminal. With this story, an AI agent automatically resolves the disagreements while the user watches a live progress modal, then verifies the result before finalizing.

**Why this priority**: Without conflict resolution, US2 silently fails for any non-trivial workflow where both versions evolve. The conflict path is what makes "Make this the new main" actually safe to expose to vibe-coders. It's P2 because US2 still delivers value alone for the simpler case, but US3 dramatically extends US2's reach.

**Independent Test**: Prepare a project where the saved version and the primary version both modify the same line in at least one file. Promote the saved version. Verify the resolver progress modal opens and reports each disagreeing file as it works, the file ends up with a coherent merged version (no conflict markers), the project's verify command (such as a type check) passes, and the post-merge actions in US2 fire as normal.

**Acceptance Scenarios**:

1. **Given** the combine attempt detects one or more files where both versions disagree, **When** the AI resolver starts, **Then** a live progress modal opens titled "Two versions disagree on the same lines. Resolving with AI…" showing an iteration counter, the current file being resolved, and the cumulative cost so far.
2. **Given** the resolver successfully reconciles every disagreeing file, **When** it finishes, **Then** the project's verify command runs automatically; if verification passes, the combine is finalized, all post-promotion actions from US2 fire, and a success toast reads "AI resolved <N> disagreements. The new main is ready."
3. **Given** the resolver is running, **When** the user clicks **Cancel** on the progress modal, **Then** the resolver stops and the combine is rolled back to the pre-attempt state; the source version, the primary version, and the working files are restored as if the promotion never started.
4. **Given** the resolver detects a kind of disagreement it does not handle (file rename combined with deletion, binary files, embedded sub-projects), **When** that detection fires, **Then** the combine is rolled back automatically and a single-line message appears: "This version has a kind of conflict AI can't resolve yet. The merge has been undone. Edit the files manually and try again."
5. **Given** the resolver's running cost would exceed the configured cost ceiling, **When** the next iteration would push past it, **Then** the resolver halts before incurring further cost and flow continues to User Story 4.
6. **Given** all user-visible copy in the resolver flow is reviewed, **When** every modal, toast, button label, and progress label is examined, **Then** none of them mention "merge", "branch", "fast-forward", "conflict marker", "rebase", or any other version-control jargon; user-facing copy stays in vibe-coder language ("version", "disagreement", "combine", "remove").

---

### User Story 4 — Escape paths when the AI cannot fully resolve (Priority: P3)

The AI resolver may exhaust its iteration budget, hit its cost ceiling, produce a result that fails the project's verify command, or simply give up. The user needs a clear, calm choice between accepting whatever the AI produced, abandoning the attempt entirely, or — for power users — opening the unresolved files in their editor.

**Why this priority**: This is the safety net for US3. It activates only when the AI cannot complete on its own. P3 because most promotions either succeed cleanly (US2) or are resolved by AI (US3); the failure path matters but is the last 5–10% of cases.

**Independent Test**: Configure a low resolver iteration limit and prepare a deliberately unresolvable disagreement. Promote the saved version. Verify the resolver fails after the limit, the failure modal opens with three clearly distinct choices, and each of the three choices produces a sensible final state.

**Acceptance Scenarios**:

1. **Given** the resolver exhausted its iteration budget without resolving every file, **When** the failure modal opens, **Then** it is titled "AI couldn't fully resolve the disagreement" and presents three options: **Accept what AI did**, **Roll back the merge entirely**, **Open in editor** (the third rendered as a small, secondary control bottom-right).
2. **Given** the resolver finished but the project's verify command failed, **When** the failure modal opens, **Then** the same three options appear; choosing **Accept what AI did** finalizes the combine despite the failed verify, allowing the user to override.
3. **Given** the user picks **Roll back the merge entirely**, **When** rollback completes, **Then** the working files, the primary version, and the source version are restored to their pre-promotion state and no permanent record of the attempted combine remains.
4. **Given** the user picks **Open in editor**, **When** that flow runs, **Then** the unresolved files are surfaced in the user's external editor; this is the only place in the entire feature where a power-user gesture intentionally crosses into manual file editing.

---

### Edge Cases

- **Primary version does not exist** — if the project has neither a `main` nor a `master` primary version, removing the current position must refuse with a friendly error rather than leave the application in an inconsistent state.
- **Removing a version with no unique work** — the lost-work warning modal is suppressed; the version disappears immediately on click.
- **Removing the version a run is actively building** — refused with a "this version is currently being built — pause the run first" message.
- **Promoting while the orchestrator is running on either the primary or chosen version** — refused with a friendly mid-run message; no destructive operation begins.
- **Promotion confirmation dismissed mid-flight** — closing the confirmation modal before clicking confirm leaves all state untouched.
- **User cancels resolver progress modal** — the entire combine attempt rolls back; primary, chosen version, and working files return to pre-attempt state.
- **Resolver produces non-compiling output** — verification step catches this; flow proceeds to US4's failure modal.
- **Disagreement type the resolver cannot handle (rename/delete, binary, sub-project)** — abort the combine before invoking the AI; show single-line message; never present partial state to the user.
- **Cost ceiling reached mid-iteration** — halt at the next safe boundary; flow continues to US4.
- **Multiple disagreeing files** — resolver reports each file separately in the progress modal; if some succeed and some fail, the failure modal in US4 still applies because the combine cannot be finalized until all files are clean.
- **Right-click on a non-Dex-owned version** — context menu still opens but the "Make this the new main" item is disabled with an explanatory tooltip; the user-owned version remains untouched.

## Requirements *(mandatory)*

### Functional Requirements

#### Removal of saved versions

- **FR-001**: Users MUST be able to remove a Dex-owned saved version from the timeline with a single click on a control attached to the version's badge.
- **FR-002**: The removal control MUST be available only on Dex-owned saved versions (run versions and selection versions); it MUST NOT be rendered or active on the project's primary version, on a fallback primary version, or on user-created versions outside Dex's namespace.
- **FR-003**: When the user removes the saved version that holds the application's current position, the system MUST first move the current position to the project's primary version (or, if the primary version is unavailable, to a fallback primary version) before deleting the source version.
- **FR-004**: Before deleting a saved version that carries one or more steps not present on any other tracked version, the system MUST display a confirmation modal listing each at-risk step using its plain-English label and a short identifier; the modal MUST require explicit confirmation before deletion proceeds.
- **FR-005**: Deletion MUST be refused with a friendly message when an active run is currently building the target version.
- **FR-006**: Deletion MUST NOT modify or block on the user's working files (an in-progress edit must not prevent removal).
- **FR-007**: After successful deletion, the timeline MUST refresh automatically so the removed version no longer appears.

#### Promotion of saved versions

- **FR-008**: Users MUST be able to trigger promotion of a Dex-owned saved version via a right-click context menu on the version's badge that includes a "Make this the new main" item.
- **FR-009**: The "Make this the new main" item MUST be available only on Dex-owned saved versions; on other version types it MUST be disabled with an explanatory tooltip.
- **FR-010**: Before promoting, the system MUST display a confirmation modal showing a change summary (count of changed files, total added and removed line counts, the top five changed file paths, and an expander for the full list) and require explicit confirmation.
- **FR-011**: Promotion MUST preserve a fork-and-rejoin shape on the timeline so the chosen version's lineage remains visually traceable after the operation.
- **FR-012**: Promotion MUST be refused with a friendly message when an active run is currently building either the primary version or the chosen source version.
- **FR-013**: When the user has unsaved working changes at the time of promotion, the system MUST present the existing save / discard / cancel choice; if the user chooses to save, the change MUST be persisted on the current version before promotion proceeds.
- **FR-014**: When promotion completes successfully, the system MUST automatically remove the source version from the timeline, place the current position on the primary version, and display a success toast.
- **FR-015**: Promotion MUST NOT create new named save points beyond the existing record of the operation; the timeline's fork-and-rejoin shape and the operation's record together provide all needed historical context.

#### AI conflict resolution

- **FR-016**: When two versions disagree on the same lines of the same file, the system MUST automatically invoke an AI resolver before falling back to any failure path.
- **FR-017**: The resolver MUST display a live progress modal showing iteration counter, current file being resolved, and cumulative cost.
- **FR-018**: After the resolver finishes, the system MUST run the project's configured verify command; if verification passes, promotion finalizes; if it fails, flow continues to the failure modal.
- **FR-019**: The resolver MUST honor configurable ceilings on (a) maximum iterations, (b) maximum AI conversational turns per iteration, and (c) total cost; reaching any ceiling MUST halt the resolver and route flow to the failure modal.
- **FR-020**: The resolver MUST detect disagreement types it does not handle (file rename combined with deletion, binary files, embedded sub-projects) and abort the combine immediately with a friendly single-line message.
- **FR-021**: The user MUST be able to cancel an in-progress resolver from the progress modal; cancellation MUST roll back the combine attempt to its pre-attempt state.

#### Failure escape paths

- **FR-022**: When the resolver fails (iterations exhausted, cost ceiling, verify failure, or resolver gave up), the system MUST present a failure modal with exactly three options: accept the AI's partial result, roll back the entire attempt, or open the unresolved files in the user's editor.
- **FR-023**: The "open in editor" option MUST be visually subordinate to the other two (small, secondary placement) to reflect that it is the only intentional power-user gesture in the feature.
- **FR-024**: Choosing "Accept what AI did" MUST finalize the combine using whatever resolved state the AI reached, even when verification failed, so the user retains the override authority.
- **FR-025**: Choosing "Roll back the merge entirely" MUST restore the primary version, the chosen version, and the working files to their pre-attempt state with no permanent trace of the attempt.

#### Configuration

- **FR-026**: All resolver ceilings (max iterations, max turns per iteration, cost ceiling, verify command, resolver model selection) MUST be configurable per project; reasonable defaults MUST be provided so first-time users do not need to author configuration.
- **FR-027**: When the resolver model is not explicitly configured, the system MUST fall back to the project's primary model setting.

#### Voice and copy

- **FR-028**: All user-visible copy across delete, promote, resolver, and failure flows MUST avoid version-control jargon; specifically, the words "merge", "branch", "fast-forward", "rebase", "conflict marker", and "PR" MUST NOT appear in any modal, toast, button label, tooltip, or status message visible to the user.
- **FR-029**: User-visible copy MUST be centralized in a single source so future translations and audits operate against one location.

#### Safety guardrails (cross-cutting)

- **FR-030**: All destructive operations (delete, promote, rollback) MUST be guarded against concurrent invocation against the same project; a second attempt while the first is in flight MUST be refused.
- **FR-031**: The system MUST never present a state in which the user sees raw conflict markers, partial merges, or incoherent file content; either the operation completes with a clean result, the failure modal is shown, or the operation rolls back to its pre-attempt state.

### Key Entities *(include if feature involves data)*

- **Saved Version** — A point on the timeline representing a recorded state of the project. Has a kind (run version, selection version, primary version, fallback primary, user version), a current-position flag, and may carry steps unique to that version. Only run versions and selection versions are eligible for delete or promote.
- **Step** — A unit of work captured on a saved version. Each step has a plain-English label (e.g. "Cycle 2 — Plan") used by the lost-work warning to describe what would disappear if a version were deleted.
- **Disagreement** — A point during a promotion where the chosen version and the primary version both modified the same lines of the same file. The resolver iterates over disagreements one file at a time; each may resolve, fail, or be classified as unhandled.
- **Resolver Run** — A bounded execution of the AI resolver for one promotion. Has iteration count, cumulative cost, current file pointer, and final outcome (success / iterations-exhausted / cost-cap / verify-failed / unhandled-disagreement / user-cancelled).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A vibe-coder user can remove an unwanted saved version from the timeline in under 30 seconds without leaving the application or being shown any version-control terminology.
- **SC-002**: A vibe-coder user can promote a chosen saved version to become the new primary version in under two minutes for the clean-merge case, end-to-end inside the application.
- **SC-003**: For promotions that involve disagreements, the AI resolver completes successfully on its first attempt for at least 80% of routine cases (single-file or two-file disagreements where the intent of each version is preserved).
- **SC-004**: Across the entire feature surface — every modal, toast, button, tooltip, status message, and error string — zero user-visible strings contain the words "merge", "branch", "fast-forward", "rebase", "conflict marker", or "PR".
- **SC-005**: 100% of promotions either complete cleanly or roll back to a state indistinguishable from before the attempt; no promotion ever leaves the project's saved versions, primary version, or working files in a partial or inconsistent state.
- **SC-006**: 100% of remove and promote attempts initiated while a run is actively building the relevant version are refused with a friendly message and produce no destructive change.
- **SC-007**: When the resolver fails, the user reaches a coherent final state (accepted, rolled back, or handed off to editor) within one additional click; no failure path leaves the user staring at a screen they cannot dismiss.
- **SC-008**: The total cost of any single promotion (including AI resolver) stays under the configured cost ceiling 100% of the time; runaway spend is impossible by construction.

## Assumptions

- The 013-cleanup-2 prerequisite has landed before implementation begins, so the codebase contains only Dex-owned saved-version namespaces (`dex/*` and `selected-*`) plus user versions and the primary version. No legacy "attempt" or "capture" namespaces remain to disambiguate.
- The vibe-coder persona is the primary target audience; power users who want fully manual control are accommodated only by the small "open in editor" escape hatch in User Story 4.
- The project provides an executable verify command (such as a type check) that returns non-zero when the codebase is broken; if no verify command is configured, the resolver skips verification.
- The AI resolver operates only on text files containing in-line line disagreements; rename/delete combinations, binary files, and embedded sub-project disagreements are explicitly out of scope and route to the unhandled-disagreement abort.
- A single primary version exists per project (named `main`, with `master` as fallback); projects with multiple primary lines are out of scope for v1.
- Out-of-scope follow-ups: pushing the new primary version to a remote service, opening a code-review request, bulk version cleanup UI, scriptable / headless invocation, mid-resolution model swapping, per-file live diff preview, deletion of user-owned versions, and merge strategies other than the one true-merge strategy used in v1.
