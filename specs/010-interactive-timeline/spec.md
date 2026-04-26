# Feature Specification: Interactive Timeline — Click-to-Jump Canvas + Variant Agent Profiles

**Feature Branch**: `010-interactive-timeline`
**Created**: 2026-04-25
**Status**: Draft
**Input**: User description: "read /home/lukas/Projects/Github/lukaskellerstein/dex/docs/my-specs/010-interactive-timeline/README.md"

## User Scenarios & Testing *(mandatory)*

Dex's Loop Dashboard splits its history view into two tabs — **Steps** (linear "what's running now") and **Timeline** (branching tree). The 008 release wired up the data — auto-checkpoints, attempt branches, parallel variants, dirty-tree handling — but the Timeline canvas itself never caught up. Today the canvas renders disconnected dots in lanes with no edges, no commit hashes, and "pending stage" placeholders that nobody can interpret. Users can only navigate via verb buttons hidden inside a side panel. Worse, when users invoke "Try N ways" to spawn parallel variants, every variant runs the **same** model with the **same** system prompt and the **same** tool surface — the only thing that varies is Claude's randomness.

This feature fixes both at once:

1. The Timeline becomes the canonical canvas — a real branching tree where every node is a stage's commit, edges show parent→child reachability, color tells you what's on the active path, and a single click on any node performs the right git operation.
2. The Steps tab becomes a projection — it always renders the path from the starting point to whatever the user has selected on the Timeline.
3. **Variants become first-class.** Users define **Agent Profiles** as folders on disk (`<projectDir>/.dex/agents/<name>/`) containing the runner's native config plus a small Dex-side knob file. The Try-N-ways modal lets users pick a profile per variant — "same model 3 times" or "Opus / Sonnet / Haiku" or "Conservative / Standard / Innovative" — orthogonal axes, fully composable.

The feature must preserve Dex's one-button feel: users who never open the Timeline see nothing new in the happy path. No new modals fire on the default run.

### User Story 1 - Click-to-jump Timeline canvas (Priority: P1)

The Timeline panel is rebuilt as a branching DAG. Each git ref (canonical run branch, attempt branches, variant branches) gets its own column, and each step-commit (one per completed stage) shows up as a node carrying the short SHA, stage label, and cycle number. Edges connect consecutive step-commits in the same column; cross-column edges show where an attempt or variant forked off. A single left-click on any node performs the right git operation — switch branch if the node is a unique branch tip, fork a new attempt if it is mid-branch — and the Steps tab redraws around the new HEAD. The right-side detail panel and the bottom collapsible attempts list are removed.

**Why this priority**: This is the minimum slice that makes Timeline navigation legible and usable. Without it, the canvas remains a broken decoration and users continue to navigate exclusively through hidden side-panel buttons. Every other story in this spec assumes a working Timeline.

**Independent Test**: Reset the example project to clean and run an autonomous pipeline. Open the Timeline. Confirm that each stage's commit lands as a labelled node in the active branch's column, edges are drawn between consecutive step-commits, and the SHA + stage label + cycle number are visible on every node without hovering. Click a step-commit two stages back; confirm an attempt branch is forked at that commit and the working tree is restored to that state. Click the tip of `main`; confirm the working tree returns to `main`.

**Acceptance Scenarios**:

1. **Given** a project that has just completed a multi-cycle autonomous run with no variants, **When** the user opens the Timeline panel, **Then** the panel shows one column for `main` and one column for the run branch, every step-commit is rendered as a node carrying short SHA + stage label + cycle number, edges connect consecutive step-commits in the run column, and a branch-off edge connects `main` to the run column's first commit.
2. **Given** the user is looking at a Timeline with multiple step-commits on the active branch, **When** they hover any node, **Then** a tooltip shows the full commit subject and timestamp.
3. **Given** the active HEAD is the tip of the run branch, **When** the user left-clicks a step-commit two stages back on the same branch, **Then** Dex creates a new attempt branch at that commit, the working tree is restored to the commit's state, the new attempt branch appears as its own column on the Timeline, and the Steps tab redraws around the new HEAD.
4. **Given** the active HEAD is on a non-`main` branch, **When** the user left-clicks the tip of `main`, **Then** Dex switches to `main` (no new branch created), the Steps tab shows the empty pre-run path, and `main`'s tip node is the only blue (on-path) node.
5. **Given** the user left-clicks the current HEAD's node, **When** the click is processed, **Then** nothing changes (no branch movement, no working-tree update, no Steps redraw).
6. **Given** the user has uncommitted edits in tracked files, **When** they left-click a non-HEAD step-commit, **Then** Dex opens the existing dirty-tree confirmation modal and waits for save / discard / cancel before performing any git operation.
7. **Given** a commit subject that does **not** match the step-commit pattern (e.g., a hand-made WIP commit somewhere in the run branch), **When** the Timeline renders, **Then** that commit is invisible on the canvas and edges hop over it (consecutive step-commits remain connected by a single edge).

---

### User Story 2 - Steps tab projects from Timeline selection (Priority: P2)

The Steps tab no longer derives its rendering from raw orchestrator state. Instead it reads a single `selectedPath` — the ordered list of step-commits between the run's starting point and the currently checked-out HEAD — and projects it onto the existing macro-stepper and per-stage list. When a stage's expected step-commit is on the path, the row is `done`. When orchestrator state says `running` or `paused`, the row reflects that. When the orchestrator is paused, the next unstarted row gets a new `pause-pending` indicator (orange pause-circle) so users see *where* the run is going to resume. Switching Timeline nodes redraws Steps automatically — no manual refresh, no separate selection state.

**Why this priority**: Without this projection, the Timeline becomes a viewer that disagrees with Steps whenever the user navigates. This story makes the two tabs share a single source of truth and is required for the click-to-jump UX (Story 1) to feel consistent.

**Independent Test**: With an active autonomous run paused mid-cycle, open the Timeline and click the most recent completed step-commit. Confirm the Steps tab shows that stage and all earlier stages as `done`, the next unstarted stage as `pause-pending` (orange), and any later stages as `pending`. Click an earlier step-commit and confirm Steps shrinks to reflect the new path.

**Acceptance Scenarios**:

1. **Given** an autonomous run is in progress and currently `running` stage X, **When** the user opens the Steps tab, **Then** every stage with a checkpointed commit on the active path shows `done`, stage X shows `running`, and all later stages show `pending`.
2. **Given** an autonomous run is `paused` at the boundary between stage X and stage X+1, **When** the user opens the Steps tab, **Then** stage X shows `done`, stage X+1 shows `pause-pending` (orange pause-circle), and all later stages show `pending`.
3. **Given** the user has navigated via the Timeline to an attempt branch that was forked two stages back, **When** the Steps tab redraws, **Then** the path is shorter (only stages up to the fork point are `done`) and the macro-stepper reflects the deeper stage on the new path.
4. **Given** the user clicks the tip of `main` (a starting point with no step-commits on the path), **When** Steps redraws, **Then** every stage shows `pending` and the macro-stepper shows the pipeline as not yet started.

---

### User Story 3 - Right-click context menu (Priority: P2)

Single-click navigates. Less-frequent verbs move from the side panel to a right-click context menu opened directly on a step-commit. The menu offers **Keep this** (promote to a `checkpoint/<auto-name>` tag — node turns red), **Unmark kept** (remove the tag — only available on already-kept nodes), and **Try N ways from here** (open the variant modal anchored to the selected commit).

**Why this priority**: With the Timeline now click-driven, the existing side-panel verbs lose their home. Surfacing them on right-click keeps them discoverable without re-introducing a side panel that obscures the canvas. The current `goBack` and `promote` IPC handlers are reused unchanged.

**Independent Test**: Right-click any step-commit on the Timeline. Confirm the context menu shows **Keep this** and **Try N ways from here** when the node is unkept. Click **Keep this**; confirm a `checkpoint/<auto-name>` tag is created at that SHA, the node grows a red ring on the canvas, and right-clicking that same node now shows **Unmark kept** instead of **Keep this**. Click **Unmark kept**; confirm the tag is gone and the red ring disappears.

**Acceptance Scenarios**:

1. **Given** a step-commit with no `checkpoint/*` tag, **When** the user right-clicks, **Then** the context menu shows **Keep this** and **Try N ways from here**.
2. **Given** a step-commit that already has a `checkpoint/*` tag, **When** the user right-clicks, **Then** the context menu shows **Unmark kept** and **Try N ways from here** (Keep this is hidden because it's already kept).
3. **Given** the user clicks **Keep this** on a step-commit, **When** the operation completes, **Then** a `checkpoint/<auto-name>` tag is created at that SHA, the node renders with a red ring on the Timeline, and the macro-stepper indicates the corresponding stage as kept.
4. **Given** the user clicks **Unmark kept** on a kept step-commit, **When** the operation completes, **Then** the tag is deleted and the node returns to its prior color (grey or blue depending on whether it's on the active path).
5. **Given** the user clicks **Try N ways from here**, **When** the click is processed, **Then** the Try-N-ways modal opens anchored to the selected commit's SHA (Story 4 covers the modal contents).

---

### User Story 4 - Per-variant Agent Profiles (Priority: P2)

Variants gain real diversity. An **Agent Profile** is a folder on disk under `<projectDir>/.dex/agents/<name>/` containing two things: (1) a small Dex-side knob file (`dex.json`) that names the runner, model, system-prompt addendum, and the variant's allowed-tool subset; and (2) optionally, the runner's native config tree (`.claude/` for Claude Code; runner-equivalent for Codex / Copilot in later phases). The Try-N-ways modal is rebuilt: each of the N variant slots gets a profile dropdown listing folders found under `.dex/agents/`, plus inline overrides for runner / model / persona / allowed tools. Selecting a profile populates the inline fields from the folder's `dex.json`. An **Apply same profile to all** toggle covers the common "all 3 variants identical" case.

When a variant runs on a worktree-friendly stage (gap analysis, specify, plan, tasks, learnings — stages 008 already runs in a `git worktree`), Dex copies the profile folder's `.claude/` top-level entries into the worktree's `.claude/`, replacing what was committed there. The agent's standard CWD-based config discovery picks them up natively. The project root's `.claude/` is never modified. When a variant runs on a sequential stage (implement, implement-fix, verify) that does not use a worktree, only the Dex-side knobs (model / system-prompt addendum / allowed tools) are applied — the modal warns the user that the `.claude/` overlay won't take effect on these stages in v1.

**Why this priority**: Without this, "Try N ways" is just "the same agent 3 times" with stochastic noise as the only differentiator. With it, users get principled comparisons (Conservative vs Standard vs Innovative; Opus vs Sonnet vs Haiku; minimal-tools vs full-tools) without writing code. This is the standout capability that differentiates Dex's variant story from free-form AI tools.

**Independent Test**: Create three folders under `<dex-ecommerce>/.dex/agents/` — `conservative/` (Opus + persona "minimize change" + a `.claude/CLAUDE.md` containing a one-line directive), `standard/` (Sonnet, no `.claude/` so it inherits the project), `innovative/` (Haiku + persona "modern libs" + `.claude/agents/code-reviewer.md` defining a subagent unique to this profile). Right-click a step-commit at the boundary of a worktree-friendly stage and choose **Try 3 ways**. Pick A=conservative, B=standard, C=innovative. Confirm three attempt branches spawn, each in its own worktree, and that the contents of each worktree's `.claude/` reflect that variant's profile (or the project default for `standard`). Confirm each variant runs the next stage with the configured model and that the cost estimate at the modal footer is the per-model sum.

**Acceptance Scenarios**:

1. **Given** a project with one or more profile folders under `<projectDir>/.dex/agents/`, **When** the user opens the Try-N-ways modal, **Then** the modal lists each folder name in the per-variant profile dropdown, plus a `(none)` entry that means "use the project defaults with no overlay".
2. **Given** the user selects a profile in a variant slot, **When** the dropdown change is processed, **Then** the runner / model / persona-addendum / allowed-tools inline fields populate from the selected folder's `dex.json`, and a read-only chip shows what the profile's `.claude/` bundles (e.g., `2 skills · 1 subagent · 1 MCP server`) or `(no .claude/ overlay)`.
3. **Given** the user toggles **Apply same profile to all**, **When** the toggle is on, **Then** changing variant A's profile updates B and C to the same selection, and the per-variant override fields for B and C are read-only.
4. **Given** the user clicks **Run variants** with three different profiles selected, **When** spawn completes, **Then** three attempt branches exist, each pointing at its own worktree containing the overlaid `.claude/` (where the profile has one), the project root's `.claude/` is unchanged, and each variant invokes its runner with the profile's model / system-prompt addendum / allowed-tools.
5. **Given** the user opens the modal anchored to a step-commit whose **next** stage is a sequential stage (implement, implement-fix, verify), **When** the modal loads, **Then** a banner warns that `.claude/` overlays will not apply on this stage in v1 (only the Dex-side knobs will), regardless of which profiles are selected.
6. **Given** the project has zero profile folders defined, **When** the user opens the modal, **Then** a stub explains that no profiles are defined and offers to run the variants with the project default for all slots.
7. **Given** the user picks a profile, edits an inline field (e.g. switches the model), and clicks **Save changes to profile**, **When** the save completes, **Then** the corresponding field in the profile folder's `dex.json` is updated and the chip and other variant slots referencing the same profile reflect the new value on next open.
8. **Given** a variant has been spawned and the orchestrator process is restarted before the variant resolves, **When** state is rehydrated, **Then** the variant-group state still records the profile name and folder path so that — if the worktree was reconstructed — the overlay can be re-applied.

---

### Edge Cases

- **Click on tip of multiple branches.** When a single SHA is the tip of two or more branches simultaneously, the click forks a new attempt at that SHA (rather than picking one branch arbitrarily). The "switch to existing branch" path applies only when the target SHA is the unique tip of exactly one branch.
- **Click on a step-commit and dirty working tree at once.** The existing dirty-tree modal (Save / Discard / Cancel) intercepts the click before any git operation runs.
- **Profile folder missing or malformed `dex.json`.** The profile dropdown silently skips folders that fail validation; a small inline warning is shown in the modal so the user knows why the folder isn't listed.
- **Profile folder name uniqueness.** The folder name *is* the profile name; uniqueness is filesystem-enforced. Renaming a profile is `mv <old>/ <new>/`.
- **Profile folder with no `.claude/`.** Valid configuration — the variant inherits the worktree's committed `.claude/` (i.e., the project default). Only Dex-side knobs apply.
- **Worktree overlay collision.** The overlay replaces top-level `.claude/` entries (file-by-file at the top level). It does not deep-merge `settings.json` or other JSON. If the user wants project defaults plus profile additions, the profile must include both.
- **Mid-stage WIP commits in the run branch.** The Timeline only renders commits whose subject matches `[checkpoint:<stage>:<cycle>]`. Other commits do not render and cannot be clicked, but reachability edges hop over them so consecutive step-commits remain visually connected.
- **Run with `(none)` selected for a variant.** That slot uses the project's default agent config — no overlay, only inline knobs (which may also be at project defaults).
- **Codex / Copilot picker.** The runner dropdown lists Codex and Copilot as disabled "Coming soon" entries in v1. Selecting them is impossible.
- **Try-N-ways from a non-stage-aligned commit.** Today every step-commit is stage-aligned by construction (one stage = one step-commit). Promotion-naming for non-stage-aligned commits is deferred (see Out of Scope).
- **Resume mid-variant after orchestrator restart.** Variant-group state on disk records each variant's profile name and folder path, so the runner can re-apply the overlay if its worktree is reconstructed.

## Requirements *(mandatory)*

### Functional Requirements

#### Timeline canvas

- **FR-001**: Timeline MUST render one column per git ref discovered in the project (canonical run branch, `main`, attempt branches, variant branches), with the branch name as the column header.
- **FR-002**: Timeline MUST render only step-commits — commits whose subject matches the canonical step-commit pattern (`[checkpoint:<stage>:<cycle>]` for cycle ≥ 1; `[checkpoint:<stage>]` for cycle 0). Any other commit MUST be invisible on the canvas.
- **FR-003**: Each rendered node MUST display the commit's short SHA, stage label, and cycle number directly on the node (visible without hover).
- **FR-004**: Hovering a node MUST show the full commit subject and the commit's timestamp.
- **FR-005**: Within a column, Timeline MUST draw an edge between each step-commit and the previous step-commit reachable in the same column (skipping non-step-commit ancestors).
- **FR-006**: Where a column's first commit's parent lives in another column, Timeline MUST draw a cross-column branch-off edge from that parent to the new column's first commit.
- **FR-007**: Each node MUST take exactly one of three colors: **grey** (default), **blue** (the SHA is on the path from the active run's starting-point to current HEAD), **red** (the SHA has a `checkpoint/*` tag). A SHA that satisfies both blue and red MUST render with a red ring around a blue fill.
- **FR-008**: The Timeline panel MUST occupy the full width of its tab (the existing right-side detail panel and bottom collapsible attempts list MUST be removed).

#### Click-to-jump navigation

- **FR-009**: Left-click on a step-commit MUST trigger the jump-to action.
- **FR-010**: When the click target SHA equals current HEAD, jump-to MUST be a no-op (no branch movement, no working-tree update).
- **FR-011**: When the working tree is dirty (uncommitted changes in tracked files), jump-to MUST refuse to proceed and the existing dirty-tree confirmation modal MUST open with Save / Discard / Cancel.
- **FR-012**: When the click target is the unique tip of exactly one branch, jump-to MUST switch to that branch (equivalent to `git checkout <branch>`).
- **FR-013**: When the click target is mid-branch (an ancestor that is not a tip) or the tip of more than one branch, jump-to MUST fork a new attempt branch at the target SHA (equivalent to `git checkout -B attempt-<ts> <sha>`).
- **FR-014**: After any successful jump-to, the Steps tab MUST redraw automatically based on the new HEAD's path.

#### Steps tab projection

- **FR-015**: The Steps tab MUST derive each stage row's status from the active path (the ordered list of step-commits between the run's starting point and current HEAD) plus orchestrator state, in this order: a stage with its expected step-commit on the path is `done`; a stage matching `state.currentStage` is `running` or `paused` according to `state.status`; the **next** unstarted stage when `state.status === paused` is `pause-pending` (NEW); all others are `pending`.
- **FR-016**: The macro-stepper above the per-stage list MUST derive its phase status from the deepest stage represented on the active path.
- **FR-017**: The Steps tab MUST not maintain a separate selection state — its rendering is fully a function of the active path plus orchestrator state.

#### Right-click context menu

- **FR-018**: Right-click on a step-commit MUST open a context menu.
- **FR-019**: The context menu MUST include **Try N ways from here** for any step-commit.
- **FR-020**: For a step-commit without a `checkpoint/*` tag, the menu MUST include **Keep this**; for one with a tag, the menu MUST include **Unmark kept** instead.
- **FR-021**: **Keep this** MUST create a `checkpoint/<auto-name>` tag at the selected SHA and the node MUST immediately render with a red ring.
- **FR-022**: **Unmark kept** MUST delete the `checkpoint/*` tag and the node MUST immediately revert to its prior color.
- **FR-023**: **Try N ways from here** MUST open the variant modal with the spawn-from SHA pre-set to the selected commit.

#### Agent Profiles — data model and storage

- **FR-024**: An Agent Profile MUST be storable as a folder under `<projectDir>/.dex/agents/<folder-name>/`, where the folder name is the profile name (no separate `name` field stored inside the folder).
- **FR-025**: Each profile folder MUST contain a `dex.json` file declaring at minimum the runner identifier (`agentRunner`) and may contain `model`, `systemPromptAppend`, and `allowedTools`.
- **FR-026**: Each profile folder MAY contain a runner-native subdirectory (`.claude/` for `agentRunner: claude-sdk`; runner-equivalent for future runners). A profile with no runner-native subdirectory is valid.
- **FR-027**: The system MUST support discovering profiles by listing folders under `<projectDir>/.dex/agents/` and parsing each `dex.json`.
- **FR-028**: Folders that fail `dex.json` validation MUST be excluded from the profile picker but reported to the user (e.g., as a warning row in the modal) rather than silently omitted.
- **FR-029**: Profiles are project-scoped only in v1 — there is no user-level profile library.

#### Agent Profiles — Try-N-ways modal

- **FR-030**: The Try-N-ways modal MUST present N per-variant rows (where N matches the variant count selector, range 2–5).
- **FR-031**: Each variant row MUST include a profile dropdown listing the project's available profiles plus a `(none)` entry meaning "use project defaults, no overlay".
- **FR-032**: Selecting a profile MUST populate the inline runner / model / persona-addendum / allowed-tools fields from that profile's `dex.json`.
- **FR-033**: Each variant row MUST include a read-only chip summarising the profile's runner-native overlay contents (e.g., `2 skills · 1 subagent · 1 MCP server`) or indicate `(no .claude/ overlay)` when none is present.
- **FR-034**: An **Apply same profile to all** toggle MUST be available; when on, changes to variant A propagate to all other variant rows and the per-variant override fields are read-only on B, C, … N.
- **FR-035**: A **Save changes to profile** action MUST be available per variant row; clicking it MUST write the inline field values back into that profile's `dex.json` (only the editable Dex-side fields; the runner-native overlay is not edited from the modal in v1).
- **FR-036**: When the modal is anchored to a step-commit whose **next** stage is a sequential stage (implement, implement-fix, verify), the modal MUST display a non-dismissable banner warning that runner-native overlays will not apply on the next stage in v1 (only Dex-side knobs will).
- **FR-037**: When the project has zero profile folders, the modal MUST present a stub state explaining how to create a profile and offering to run all N variants with the project default.
- **FR-038**: The cost estimate at the modal footer MUST sum the per-model cost estimates for all selected variant slots.

#### Agent Profiles — variant spawn behaviour

- **FR-039**: For variants spawned on a worktree-friendly stage (the existing parallel set: gap analysis, specify, plan, tasks, learnings), the system MUST copy each profile folder's `.claude/` top-level entries into the corresponding worktree's `.claude/`, replacing whatever was committed there inside the worktree.
- **FR-040**: Worktree overlay MUST be a top-level file replacement (no deep merge of JSON or directory trees). If the profile has no `.claude/`, the overlay step MUST be skipped and the worktree's committed `.claude/` is used as-is.
- **FR-041**: The project root's `.claude/` MUST never be modified by an overlay — only the worktree's working copy is touched.
- **FR-042**: When a variant runs on a sequential stage that does not use a worktree, only Dex-side knobs (model / system-prompt addendum / allowed-tools) MUST be applied. The runner-native overlay MUST be skipped.
- **FR-043**: The Claude runner MUST consume the profile's `model` (overriding the orchestrator default), `systemPromptAppend` (appended to the assembled system prompt), and `allowedTools` (passed through as the runner's allowed-tools restriction). When a worktree is in use, the runner's working directory MUST be the worktree path (not the project root).
- **FR-044**: Default behaviour MUST be unchanged when a variant has no profile (`(none)`): no overlay; the runner uses orchestrator defaults; the working directory follows the existing 008 worktree rules.

#### Agent Profiles — persistence and resume

- **FR-045**: The variant-group state on disk MUST record each variant's profile name and folder path so that the overlay can be re-applied if the orchestrator restarts mid-variant and a worktree is reconstructed.

#### Removals

- **FR-046**: The right-side node detail panel and the bottom collapsible past-attempts list under the Timeline MUST be removed; the Timeline panel becomes full-width.

### Key Entities

- **Step-commit**: A git commit whose subject matches the canonical step-commit pattern. Carries SHA, branch, parent SHA, stage, cycle number, timestamp. Every node on the Timeline corresponds to exactly one step-commit.
- **Branch column**: A vertical lane on the Timeline canvas, one per discovered git ref. Within a column, step-commits are topologically sorted (parent above child) and connected by edges.
- **Selected path**: The ordered list of step-commit SHAs from the run's starting-point to current HEAD on the active branch. Source of truth for the Steps tab projection and for blue (on-path) coloring on the Timeline.
- **Checkpoint tag**: A git tag of the form `checkpoint/<auto-name>` marking a step-commit as kept. Renders as a red ring on the canvas. Created by **Keep this**, removed by **Unmark kept**.
- **Agent Profile**: A folder under `<projectDir>/.dex/agents/<name>/` bundling Dex-side knobs (`dex.json`) and optionally the runner-native config tree (`.claude/` for the Claude runner). The folder name is the profile name.
- **`dex.json` schema**: Per-profile knob file declaring runner identifier and the Dex-side fields the runner config does not express — `model`, `systemPromptAppend`, `allowedTools`.
- **Variant slot**: One of the N rows in the Try-N-ways modal. Bundles a profile choice (or `(none)`) plus the spawn-from SHA. Maps 1:1 to one attempt branch + worktree at spawn time.
- **Worktree overlay**: The act of copying a profile's `.claude/` top-level entries into the variant's worktree before the runner is invoked. Top-level file replacement; never touches the project root.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can navigate to any prior step-commit in **one** click without opening any side panel.
- **SC-002**: A user can identify which commit corresponds to which stage of which cycle at a glance — short SHA, stage label, and cycle number are visible on every Timeline node without hovering.
- **SC-003**: A user can identify whether a step-commit is on the active path, kept, both, or neither, by color alone — no panel inspection required.
- **SC-004**: After clicking a Timeline node, the Steps tab redraws to reflect the new HEAD with no manual refresh and no perceivable lag (within one render frame).
- **SC-005**: A user can spawn three Try-N-ways variants with three different profiles selected from a dropdown, with no code changes, in under 60 seconds from opening the modal to the first variant beginning execution.
- **SC-006**: With three profiles defined as `conservative` (Opus + restrictive prompt), `standard` (Sonnet, no overlay), and `innovative` (Haiku + permissive prompt + custom subagent), the resulting variant outputs are demonstrably different across at least one observable dimension (chosen model, diff size, or behaviour traceable to the custom subagent or persona). A profile with no `.claude/` directory still spawns and runs successfully.
- **SC-007**: The project root's `.claude/` directory is byte-for-byte identical before and after spawning variants — confirmed by hashing the directory before and after.
- **SC-008**: Resuming a paused autonomous run after a Timeline jump does not start a new run record — the orchestrator's resume flow uses the existing run id and skips already-completed stages.
- **SC-009**: A user with zero profile folders defined can still open the Try-N-ways modal and spawn variants using the project default for every slot.
- **SC-010**: When the Try-N-ways modal is opened anchored to a sequential stage (implement / implement-fix / verify), the warning banner about overlay non-application on v1 is shown 100% of the time, regardless of which profiles are selected.

## Assumptions

- The orchestrator's existing 008 infrastructure is in place: auto-checkpoints land as step-commits with the canonical `[checkpoint:<stage>:<cycle>]` subject pattern; the worktree-based parallel-variant flow runs gap analysis, specify, plan, tasks, and learnings stages in `.dex/worktrees/<branch>` directories; the dirty-tree confirmation modal exists and is reused unchanged.
- The runner's standard CWD-based config discovery will pick up an overlaid `.claude/` inside the worktree without any runner-side changes, because the runner is invoked with the worktree path as its working directory.
- Top-level file replacement is sufficient as the v1 overlay model. Deep-merging of JSON files inside `.claude/` is deferred until a concrete need surfaces.
- Users in v1 create and edit profile folders via the filesystem (or `git`) — the in-app profile editor is out of scope for this release.
- Profiles are project-scoped only in v1. Cross-project sharing is via `cp -r` between projects (or via committing `.dex/agents/` to the project repo and pulling it into another).
- Codex and Copilot runners are stubs in v1: type-level support exists, but the modal options for them are disabled with a "Coming soon" tooltip.
- `.claude/` overlays apply only on worktree-friendly stages in v1. Sequential-stage overlay support depends on the same engineering 008 calls out as a follow-up — container-isolated workspaces — and is therefore deferred to that follow-up.
- Promotion (`Keep this`) on non-stage-aligned commits is not a v1 concern because every step-commit on the Timeline is stage-aligned by construction.

## Out of Scope / Follow-ups

- Full `.claude/` overlay on sequential stages (`implement`, `implement_fix`, `verify`). Tied to the 008 follow-up that introduces container-isolated worktrees for parallel implement variants — the same engineering unlocks both.
- An in-app profile editor (creating, renaming, deleting, and editing profile folders directly from the Dex UI). Tracked separately.
- A user-level / cross-project profile library (`~/.dex/agents/`). Out by explicit decision in v1.
- Deep-merge of overlaid `.claude/` with the worktree's committed `.claude/`.
- Codex and Copilot runner adapters. Each gets its own spec.
- Multi-stage variants (a single Try-N-ways spawn that runs more than the next single stage). Out of scope per 008.
- Promotion-naming rules when **Keep this** is invoked on a non-stage-aligned commit. Deferred — every step-commit is stage-aligned by construction today.
