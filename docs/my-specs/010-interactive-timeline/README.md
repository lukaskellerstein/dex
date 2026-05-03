# 010 Interactive Timeline — Click-to-jump + Variant Agent Profiles

> **Status:** The "Keep this", "Unmark kept", "Try N ways from here", and Step Candidate prompt sections of this spec are superseded by `012-cleanup`. Record Mode auto-promote, the `attempt-*` branch family (and the AttemptInfo/captureBranches fields on `TimelineSnapshot`), `capture/*` branches, and the REC badge are superseded by `013-cleanup-2`. Go-Back and Jump-to-Checkpoint remain authoritative; the dirty-tree-save flow now commits on the current branch (no side branch) per 013-cleanup-2.

## Context

The Loop Dashboard has two tabs — Steps and Timeline — but their roles aren't clear:

- **Steps** is the obvious "what's happening now" view: top macro-stepper + linear list of substages.
- **Timeline** is meant to show branching history but renders disconnected dots in lanes with awkward "pending stage" labels and a redundant collapsible list below it. Users can't tell what's connected to what, can't see commit hashes, and can only navigate via verb buttons in a side panel that obscures the structure.

The 008 spec laid out the right git-flow vision (checkpoints / attempts / variants visualized as columns with edges) and `spawnVariants` infrastructure is fully wired — but the canvas was never rebuilt to match. Worse, every Try-N-ways variant uses the **same agent config** (same model, same system prompt, same tool surface), so "diversity" depends entirely on Claude's RNG.

This spec fixes both at once:

1. **Timeline becomes the canonical canvas** — a real DAG with branch columns, step-commit chain, parent-child edges, single-click jumps, right-click verbs.
2. **Steps becomes a projection** — always renders the path from starting-point to HEAD on the active branch. Click a different Timeline node → Steps redraws.
3. **Variants become first-class** — each variant carries a complete `AgentProfile` defined as a **folder on disk** containing the runner's native config (`.claude/`, `.codex/`, etc.) plus a small Dex-specific `dex.json`. The Try N ways modal lets users pick a profile per variant. Users can run "same agent against the same prompt 3 times" or "Opus vs Sonnet vs Haiku" or "Conservative vs Standard vs Innovative" — orthogonal axes, fully composable. Profile folders are loaded into the variant's git worktree at spawn time so Claude Code's standard CWD-based discovery picks them up natively.

## The user's mental model

**Single primitive: click a commit.**

| User clicks | Dex does | (Internal) git op |
|---|---|---|
| Tip of another branch | Switch to that branch | `git checkout <branch>` |
| Mid-branch step-commit (or tip-of-multiple) | Fork an attempt at that commit | `git checkout -B attempt-<ts> <sha>` |
| Already-current HEAD | nothing | — |

**Right-click for the rare actions:**
- **Keep this** — promote to `checkpoint/<auto-name>` tag (red ring on node).
- **Unmark kept** — remove the tag.
- **Try N ways from here** — opens variant modal.

**Color states (per node):**
- **grey** — default (other step-commit)
- **blue** — on the path from starting-point → HEAD (auto-derived from `selectedPath`)
- **red** — has a `checkpoint/*` tag
- A node can be both (red ring + blue fill).

**Steps tab follows automatically.** When user clicks a Timeline node and HEAD moves, Steps redraws around the new active path. The orange pause-circle naturally appears on the next-unstarted row when `state.status === "paused"`.

## Operating modes (carried over from 008)

1. **Default (invisible autosave)** — run end-to-end; Timeline populates silently.
2. **Step mode (Pause after each stage)** — orchestrator pauses; user clicks Resume or jumps to a different commit.
3. **Record mode (REC badge)** — every stage auto-promotes (red rings appear inline as the run progresses).

Modes unchanged. The new UX surfaces them without obscuring them.

## Timeline rendering — what changes

### Today (broken)
- Lanes of disconnected dots, no edges between consecutive commits.
- "pending <stage>" labels that mean nothing to users.
- No commit hashes visible.
- Right-side `NodeDetailPanel` (300px) and bottom `PastAttemptsList` collapse — both removed.

### After
- **Branch columns** — one per ref (`main`, `dex/<date>-<id>`, `attempt-<ts>`, `attempt-<ts>-<letter>`). Branch name as column header.
- **Step-commits only** — commits matching `^\[checkpoint:<stage>:<cycle>\]` in subject. Mid-stage WIP commits don't render or click.
- **Edges** — between consecutive step-commits on the same branch (reachability — skip non-step commits in between). Branch-off edges from divergence point to the new column's first commit.
- **Starting-point anchor** at the top of each column.
- **Per-node** — short SHA + stage label + cycle number. Hover shows full subject + timestamp.

### Layout algorithm

Pure deterministic function. Inputs: `commits[]` (with `branch`, `parentSha`, `stage`, `cycleNumber`), `selectedPath` (set of SHAs), `kept` (set of SHAs with checkpoint tags). Output: positioned nodes + edges.

1. Group commits by branch → one column per branch.
2. Within each column: topological sort (parent before child).
3. Edges within column: each commit → previous step-commit in same column.
4. Cross-column edges: when commit's `parentSha` lives in another column, branch-off edge to that column.
5. Color: red if `kept.has(sha)`, blue if `selectedPath.has(sha)`, otherwise grey. (Both → red ring + blue fill.)

Continues to use `d3-shape`'s `linkVertical` for edges and `d3-zoom` for pan/zoom.

## Steps tab — projection

Single source of truth: `selectedPath` from `TimelineSnapshot` (HEAD-derived).

- Top `<ProcessStepper>` (Prerequisites → Clarification → Dex Loop → Completion) reads macro-phase status from `selectedPath`'s deepest stage.
- `<StageList>` renders one row per stage in `STAGE_ORDER_RENDERER` (existing — `src/renderer/components/checkpoints/stageOrder.ts`), with status derived from:
  - `done` if the stage's expected `[checkpoint:<stage>:N]` commit is in `selectedPath`.
  - `running` if `state.currentStage === stage && state.status === "running"`.
  - `paused` if `state.currentStage === stage && state.status === "paused"`.
  - **`pause-pending` (NEW)** if `state.status === "paused"` and stage is the **next** unstarted row.
  - `pending` otherwise.

`StageList.tsx` and `ProcessStepper.tsx` keep their visual contracts — only the source of `status` changes (from orchestrator state to projected path).

Variants handled automatically: switching to attempt-X updates `selectedPath`; Steps redraws.

## Click semantics — `jumpTo` IPC

New: `checkpoints:jumpTo(projectDir, targetSha)` in `src/main/ipc/checkpoints.ts`.

Behavior:
1. Read current HEAD. If `targetSha === HEAD` → no-op `{ok: true, action: "noop"}`.
2. Check dirty working tree. If dirty → `{ok: false, error: "dirty_working_tree", files: [...]}`. UI shows existing `<GoBackConfirm>` modal.
3. Find branches whose tip is `targetSha`. If exactly one → `git checkout <branch>`. Return `{ok: true, action: "checkout", branch}`.
4. Otherwise (mid-branch ancestor or tip of multiple) → `git checkout -B attempt-<ts> <targetSha>`. Return `{ok: true, action: "fork", branch}`.

Reuses:
- `safeExec()` in `src/core/checkpoints.ts:296` for git commands.
- `startAttemptFrom()` in `src/core/checkpoints.ts` for the fork branching + state reconciliation.
- Dirty-tree detection from existing `goBack` IPC handler.

`goBack` and `promote` IPC handlers stay (called by right-click "Unmark kept" and direct API).

## Variant Agent Profiles

### Data model

An agent profile is a **folder on disk**. The runner's native config lives inside (`.claude/` for Claude, `.codex/` for Codex, etc.) and Dex-specific knobs that the runner's settings can't express live in `dex.json`. The on-disk shape:

```
<projectDir>/.dex/agents/<name>/
  dex.json                  # Dex-specific knobs (see schema below)
  .claude/                  # Claude Code config root (for agentRunner="claude-sdk")
    settings.json
    CLAUDE.md
    skills/...
    agents/...
    .mcp.json
```

The TypeScript model is a discriminated union over runner type. All fields not expressible in `.claude/` (or whichever runner-native folder applies) live here:

```ts
type AgentProfile = ClaudeProfile | CodexProfile | CopilotProfile;

interface BaseProfile {
  /** Folder name under <projectDir>/.dex/agents/ — also displayed in UI. */
  name: string;
  /** Absolute path to the agent folder (resolved at load time). */
  agentDir: string;
}

interface ClaudeProfile extends BaseProfile {
  agentRunner: "claude-sdk";
  model: string;                  // claude-opus-4-7 | sonnet-4-6 | haiku-4-5
  systemPromptAppend?: string;    // persona / hint — appended to assembled prompt
  allowedTools?: string[];        // SDK-level tool restriction; subset of project tools
  // Skills / subagents / plugins / MCP servers / marketplaces are NOT enumerated here.
  // They live as files inside <agentDir>/.claude/ and are picked up natively by the SDK
  // when the worktree is spawned with cwd pointing at the worktree (see "Agent overlay" below).
}

interface CodexProfile extends BaseProfile {
  agentRunner: "codex";
  model: string;
  systemPromptAppend?: string;
}

interface CopilotProfile extends BaseProfile {
  agentRunner: "copilot";
  model: string;
  systemPromptAppend?: string;
}
```

`dex.json` schema (per agent folder):

```json
{
  "agentRunner": "claude-sdk",
  "model": "claude-sonnet-4-6",
  "systemPromptAppend": "Prefer minimal diffs. Avoid new dependencies.",
  "allowedTools": ["Read", "Edit", "Write", "Grep", "Bash"]
}
```

`name` is derived from the folder name. `agentDir` is computed from the project path + folder name. Neither is stored in `dex.json`.

### Phasing

| Capability | This PR (v1) | Follow-up |
|---|---|---|
| `AgentProfile` type + folder-on-disk schema | ✅ | — |
| Claude — `model` per variant (via `dex.json`) | ✅ wired | — |
| Claude — `systemPromptAppend` per variant (via `dex.json`) | ✅ wired | — |
| Claude — `allowedTools` per variant (via `dex.json`, SDK option) | ✅ wired | — |
| Claude — full `.claude/` overlay (skills / subagents / plugins / MCP / marketplaces) on **worktree-friendly** stages (`gap_analysis`, `specify`, `plan`, `tasks`, `learnings`) | ✅ via worktree + folder copy | — |
| Claude — full `.claude/` overlay on **sequential** stages (`implement`, `implement_fix`, `verify`) | 🟡 not in v1 — only SDK-level knobs (`model` / `systemPromptAppend` / `allowedTools`) apply on these stages. `.claude/` inherits from project. | ✅ tied to "container-isolated worktrees" follow-up in 008's out-of-scope list |
| Profile selector UI (pick existing folder per variant) | ✅ | — |
| In-app profile editor (create / edit profile folder from UI) | ❌ users create folders manually in v1 | ✅ |
| Codex / Copilot runners | 🟡 type stubs; UI options disabled "Coming soon" | ✅ separate spec each |

**Why phase**: per-variant `.claude/` overlay on sequential stages would require swapping `.claude/` in-place on the project root before each variant runs — risky if the orchestrator dies mid-swap. Worktree-friendly stages already use `git worktree add` (008), so dropping the agent folder into the worktree is a clean, isolated additional step. The follow-up that unlocks full overlay for sequential stages is the same engineering 008 calls out for parallel `implement` variants — container-isolated workspaces.

### Storage

- **Project-level only** — `<projectDir>/.dex/agents/<name>/` (committed; teams share via git).
- No user-level (`~/.dex/agents/`) library in v1. Each project defines the agents that make sense for it. If users want cross-project portability, they copy folders between projects.
- The folder name IS the agent name (no separate `name` field in `dex.json`). Renaming = `mv <name>/ <new-name>/`.
- An agent folder is a regular committable directory. Users can `git diff`, branch, share, and version it like any other project asset.
- A bare `dex.json` with no `.claude/` is valid: the variant inherits the project's `.claude/` and only overrides Dex-side knobs (model / systemPromptAppend / allowedTools).

### Agent overlay mechanism (worktree-based)

Coding agents (Claude Code, Codex, Copilot) only expose **CWD** as a configuration handle — there's no separate "config root" option. So Dex uses `git worktree` as the isolation boundary and overlays the agent folder's `.claude/` (or runner-equivalent) into the worktree before spawning the agent.

#### Spawn sequence per variant

1. **Create worktree** — `git worktree add .dex/worktrees/<branch> <fromSha>`. Already wired in 008's `spawnVariants()`.
2. **Overlay agent config** (NEW step) — if the variant has an `AgentProfile` with a populated `.claude/` (or `.codex/` / `.copilot/`):
   - For each top-level entry in `<agentDir>/.claude/`, copy it into `<worktreePath>/.claude/` (overwriting the project's committed version inside the worktree). The original project root is untouched.
   - If the agent folder has no `.claude/` subdir, skip — the worktree keeps the project's committed `.claude/`.
3. **Resolve Dex knobs** — read `<agentDir>/dex.json`. Apply `model`, `systemPromptAppend`, `allowedTools` as SDK options on top of (or replacing) the orchestrator's defaults.
4. **Spawn the SDK** — `query()` is invoked with `cwd = <worktreePath>`. Claude Code's auto-discovery walks up from the worktree, finds the overlaid `.claude/`, loads it natively. File operations (`Bash`, `Read`, `Edit`) happen against the real worktree files (which are real project files, branch-isolated by the worktree).
5. **Cleanup** — when the variant resolves (Keep / Discard), existing `cleanupVariantWorktree()` removes the worktree (and the overlaid `.claude/` along with it). The agent folder under `<projectDir>/.dex/agents/<name>/` is never modified.

#### Replace, don't merge (v1)

The agent's `.claude/` **replaces** what's in the worktree, file-by-file at the top level. We don't deep-merge `settings.json` content. Predictable; if karel wants project defaults, karel includes them. Deep-merge is a follow-up if it proves necessary.

#### Sequential stages

For `implement` / `implement_fix` / `verify`, variants run sequentially on the project root (no worktree, per 008's parallelism rules). In v1, only the Dex knobs in `dex.json` apply on these stages — `model`, `systemPromptAppend`, `allowedTools` are honored via SDK options; the agent's `.claude/` is **not** overlaid (would require an in-place swap). Skills / subagents / plugins / MCP inherit from the project. The Try-N-ways modal warns the user when the next stage falls into this class.

### `ClaudeAgentRunner` changes

`src/core/agent/ClaudeAgentRunner.ts` — `runStep(ctx)` and `runTaskPhase(ctx)` accept an optional `profile?: ClaudeProfile`. The runner does NOT itself touch the agent folder — the overlay copy happens in `spawnVariants()` before the runner is invoked. The runner only consumes the Dex knobs:
- `model` overrides `ctx.config.model`.
- `systemPromptAppend` is appended to the assembled system prompt before passing to `query()`.
- `allowedTools` is passed through to the SDK's `allowedTools` option.
- `cwd` is set to the worktree path (not the project root) when a worktree exists.

Default behavior unchanged when `profile` is `undefined` and CWD is the project root.

### `spawnVariants` changes

`spawnVariants(projectDir, fromSha, requests)` exists in `src/core/checkpoints.ts` (lines 162-231). Two changes:

1. Extend `VariantSpawnRequest` with `profile?: AgentProfile`. Codex/Copilot reject early with `"runner not implemented"`.
2. After `git worktree add` and before invoking the runner, perform the **overlay step** described above — copy `<profile.agentDir>/.claude/` into `<worktreePath>/.claude/` (top-level file replacement). If `profile` is undefined or has no `.claude/`, skip.

The variant-group JSON file (`.dex/variant-groups/<groupId>.json` from 008) records `profile.name` and `profile.agentDir` per variant so resume-mid-variant logic can reapply the overlay if a worktree is reconstructed.

### `TryNWaysModal` rebuild

`src/renderer/components/checkpoints/TryNWaysModal.tsx` already collects N + cost estimate. Replace its body with the per-variant form:

- Header: `Variants: [3 ▾]   ☐ Apply same profile to all`
- Per variant (A, B, C…):
  - **Profile**: dropdown listing folders found in `<projectDir>/.dex/agents/`. Selecting one populates the rest from the folder's `dex.json`. `(none)` option keeps the project default — no overlay, only inline knobs.
  - **Runner**: `Claude Code ▾` (Codex/Copilot greyed with "Coming soon" tooltip). Reflects `dex.json["agentRunner"]` of the chosen profile when one is selected; editable when `(none)`.
  - **Model**: `claude-opus-4-7 ▾` / sonnet-4-6 / haiku-4-5. Editable inline; saving back to `dex.json` requires the user to click "Save changes to profile" (see below).
  - **Persona/system prompt addendum**: free-form textarea, prefilled from `dex.json["systemPromptAppend"]`. Persona presets (Conservative / Standard / Innovative) are quick-fill buttons that overwrite the textarea.
  - **Allowed tools**: multi-select checkboxes; prefilled from `dex.json["allowedTools"]` (or full project set if not set).
  - **`.claude/` overlay**: read-only chip showing what's bundled in the profile folder (e.g. `2 skills · 1 subagent · 1 MCP server`) so users can see what's about to be overlaid. Disabled-toggle warning shown when next stage is sequential ("`.claude/` overlay not applied on implement/verify in v1").
  - "Copy from A" button (when "Apply same" off).
  - "Save changes to profile" button — writes the in-modal values back to `<agentDir>/dex.json` (only the editable fields; `.claude/` overlay isn't editable from the modal in v1).
- Footer: cost estimate (sums per-model costs from existing `costEstimateModal` data); `[Cancel] [Run variants]`.

When the user has zero profile folders in `<projectDir>/.dex/agents/`, the modal shows a stub: "No agents defined for this project. Run with project default for all variants, or create a folder under `.dex/agents/<name>/` and reopen this modal."

## Files

| File | Change |
|---|---|
| **Spec** | |
| `docs/my-specs/010-interactive-timeline/README.md` | NEW — this document |
| **Core** | |
| `src/core/agent-profile.ts` | NEW — `AgentProfile` discriminated union, `dex.json` parser/validator, persona-preset table, `loadProfile(projectDir, name)` and `listProfiles(projectDir)` helpers (filesystem-backed; project-only) |
| `src/core/agent-overlay.ts` | NEW — `applyOverlay(worktreePath, profile)` performs the `.claude/` top-level file copy from `<agentDir>/.claude/` into `<worktreePath>/.claude/`. No-op when profile has no `.claude/` |
| `src/core/checkpoints.ts` | Extend `TimelineSnapshot` with `commits: TimelineCommit[]` + `selectedPath: string[]`. New `TimelineCommit` interface. Add `jumpTo()` core function. Extend `VariantSpawnRequest` with `profile?: AgentProfile`. Call `applyOverlay()` after `git worktree add` in `spawnVariants()` |
| `src/core/agent/ClaudeAgentRunner.ts` | Accept optional `profile: ClaudeProfile`; thread `model` / `systemPromptAppend` / `allowedTools` into `query()`. Set `cwd` to worktree path when applicable |
| **Main process / IPC** | |
| `src/main/ipc/checkpoints.ts` | New `checkpoints:jumpTo` handler. `listTimeline` error-fallback adds `commits: [], selectedPath: []` |
| `src/main/ipc/profiles.ts` | NEW — `profiles:list(projectDir)` returns folders under `<projectDir>/.dex/agents/`, parsed `dex.json` per entry. `profiles:saveDexJson(projectDir, name, dexJson)` writes the file. No user-library path. |
| `src/main/preload.ts` | Expose `jumpTo`, `profiles.*` |
| **Renderer types** | |
| `src/renderer/electron.d.ts` | Type new APIs |
| **Renderer — Timeline** | |
| `src/renderer/components/checkpoints/timelineLayout.ts` | Rewrite around branch columns + step-commit chain + reachability edges |
| `src/renderer/components/checkpoints/TimelineGraph.tsx` | Branch column headers; three color states; left-click → `jumpTo`; right-click → context menu |
| `src/renderer/components/checkpoints/TimelinePanel.tsx` | Drop `<NodeDetailPanel>` + `<PastAttemptsList>`; full-width graph |
| `src/renderer/components/checkpoints/TimelineView.tsx` | Trim |
| `src/renderer/components/checkpoints/CommitContextMenu.tsx` | NEW — right-click menu (Keep / Unmark / Try N ways) |
| **Renderer — Try N ways** | |
| `src/renderer/components/checkpoints/TryNWaysModal.tsx` | Replace body with per-variant form |
| `src/renderer/components/checkpoints/AgentProfileForm.tsx` | NEW — reusable per-variant form (also reusable later in profile library) |
| **Renderer — Steps** | |
| `src/renderer/components/loop/StageList.tsx` | Status derivation reads `selectedPath`; new `pause-pending` state + icon |
| `src/renderer/components/loop/ProcessStepper.tsx` | Macro-phase status reads from `selectedPath` |
| `src/renderer/components/loop/LoopDashboard.tsx` | Wire `selectedPath` from `useTimeline` snapshot to both child views |
| **Removed** | |
| `src/renderer/components/checkpoints/PastAttemptsList.tsx` | DELETE |
| `src/renderer/components/checkpoints/NodeDetailPanel.tsx` | DELETE |
| **Tests** | |
| `src/core/__tests__/timelineLayout.test.ts` | Update fixtures; new tests for branch columns / colors / selected-path / kept overlay |
| `src/core/__tests__/jumpTo.test.ts` | NEW — branch-tip vs fork; dirty-tree refusal; HEAD no-op |
| `src/core/__tests__/agentProfile.test.ts` | NEW — `dex.json` parser, `listProfiles()` against a fixture project, type-narrowing |
| `src/core/__tests__/agentOverlay.test.ts` | NEW — `applyOverlay()` copies top-level `.claude/` entries into worktree; no-op when missing; doesn't touch project root |

≈ 24 files touched, 2 deleted, 7 new (incl. spec doc).

## Existing helpers reused

- `safeExec()` — `src/core/checkpoints.ts:296` for all git invocations
- `startAttemptFrom()` — `src/core/checkpoints.ts` for fork-branch creation + state reconciliation
- `spawnVariants()` + worktree flow — `src/core/checkpoints.ts:162-231`, fully wired
- `STAGE_ORDER_RENDERER` — `src/renderer/components/checkpoints/stageOrder.ts`
- `StageList.tsx` + `ProcessStepper.tsx` — visual contracts unchanged
- `<GoBackConfirm>` modal — already wired for dirty-tree path
- Cost estimate logic in existing `TryNWaysModal` — preserved
- `query()` from `@anthropic-ai/claude-agent-sdk` — same call site, additional options threaded

## Implementation order

1. Spec doc lives at `docs/my-specs/010-interactive-timeline/README.md` (already in place).
2. **Data layer** — `agent-profile.ts` (types + `dex.json` parser + `listProfiles()`) + extend `TimelineSnapshot` with `commits` and `selectedPath`. Tests.
3. **`jumpTo`** — core fn + IPC. Tests.
4. **Layout rewrite** + tests.
5. **TimelineGraph rewrite** — render, click, right-click. `<CommitContextMenu>`.
6. **TimelinePanel cleanup** — drop `NodeDetailPanel` + `PastAttemptsList`.
7. **Steps projection** — `StageList` + `ProcessStepper` read from `selectedPath`. Pause-pending icon.
8. **`agent-overlay.ts`** — `applyOverlay()` filesystem helper. Tests against a fixture worktree.
9. **`ClaudeAgentRunner.profile`** — model + systemPromptAppend + allowedTools through `query()`. Worktree-aware `cwd`.
10. **`spawnVariants.profile`** — call `applyOverlay()` after worktree add; record profile in variant-group JSON.
11. **`profiles` IPC** — `list` + `saveDexJson`.
12. **`TryNWaysModal`** body rewrite — profile selector + per-variant form + "Apply same" toggle. Sequential-stage warning.
13. **End-to-end verification** against `dex-ecommerce`.

## Verification (DoD)

1. **Reset to clean** — `./scripts/reset-example-to.sh clean`. Open project. Timeline shows starting-point only (`main @ <sha>`).
2. **Run start** — kick off an autonomous run. Timeline columns populate as step-commits land. Each commit shows short SHA + stage label. Edges connect consecutive step-commits in the active column.
3. **Pause + Resume** — pause after a stage. Steps tab shows orange pause-pending circle on the **next** unstarted stage. Resume completes the loop.
4. **Click-to-jump (mid-branch)** — click a step-commit two stages back. Verify `git checkout -B attempt-<ts> <sha>` ran (new attempt branch in `git branch`, attempt column appears in Timeline). Steps redraws around new HEAD.
5. **Click-to-jump (branch tip)** — click `main`'s tip. Verify `git checkout main` (no new branch). Steps shows the empty pre-run path.
6. **Dirty modal** — touch a tracked file, click a different commit. Confirm `<GoBackConfirm>` opens. Save → commit → checkout. Discard → reset → checkout.
7. **Right-click → Keep this** — on a step-commit. Verify `checkpoint/<auto-name>` tag created at that SHA. Node turns red.
8. **Right-click → Try N ways** — opens modal. First, create 3 agent folders under `<projectDir>/.dex/agents/` for the test:
   - `conservative/dex.json` (model=opus, persona "minimize change") + `conservative/.claude/CLAUDE.md` with a one-line directive.
   - `standard/dex.json` (model=sonnet) — no `.claude/` (project default applies).
   - `innovative/dex.json` (model=haiku, persona "modern libs") + `innovative/.claude/agents/code-reviewer.md` (a subagent only this profile gets).

   In the modal, pick A=conservative, B=standard, C=innovative. Confirm:
   - 3 attempt branches spawn (`attempt-<ts>-{a,b,c}`), each in its own worktree.
   - The conservative worktree contains the overlaid `CLAUDE.md`; the innovative worktree contains the overlaid `code-reviewer.md` subagent; the standard worktree's `.claude/` is the project default (no overlay).
   - Each variant runs the next stage with the configured model + prompt addendum.
   - Cost estimate sums correctly per model.
   - When picking a sequential stage (e.g. `implement`) and selecting profiles with `.claude/` entries, the modal shows the warning that overlay won't apply.
9. **Variant inspect** — click each variant column's tip. Steps tab projects each. Right-click → Keep this on the winner.
10. **Type/build** — `npx tsc --noEmit` passes. `npx tsx --test src/core/__tests__/*.test.ts` passes.
11. **MCP visual check** — snapshot Timeline at each milestone via `electron-chrome` MCP.

## Out of scope / follow-ups

- **Full `.claude/` overlay on sequential stages** (`implement`, `implement_fix`, `verify`). Tied to 008's "container-isolated worktrees" follow-up — same engineering unlocks both.
- **In-app profile editor** — creating / editing / deleting agent folders from inside the Dex UI. v1 expects users to create folders manually (or copy from another project). A dedicated settings panel comes later.
- **User-level / cross-project profile library** (`~/.dex/agents/`). Out by explicit decision — agents are project-scoped in v1. Cross-project portability via `cp -r`.
- **Deep-merge of overlaid `.claude/`** with project's `.claude/` (top-level file-replace is the v1 model).
- **Codex / Copilot runner adapters** — each its own spec.
- **Multi-stage variants** (008 already lists this as out of scope).
- **Promotion-naming rules** when "Keep this" runs on a non-stage-aligned commit (defer; today every step-commit IS stage-aligned by construction).
