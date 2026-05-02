# 014 Branch Management — Delete + Promote-to-main with AI-resolved conflicts

> **Prerequisite:** `013-cleanup-2` lands first. It removes Record mode (incl. `capture/*`) and `attempt-*`, leaving the codebase on a single two-family branch namespace (`dex/*` + `selected-*`) and rewriting the dirty-tree-save flow to commit on the current branch (no side branch). Every operating-model description in 014 below assumes that end-state.

## Context

The 010 Timeline canvas exposes navigation (`jumpTo`) and a single deletion verb (the ✕ button on `selected-*` lane badges, wired to `unselect` in `src/core/checkpoints/jumpTo.ts:19`). It does **not** let users:

1. Get rid of a `dex/*` run branch they don't want anymore.
2. Promote a branch to `main` once they've decided it's the version they want to keep.

Today both gestures require the user to drop into a terminal, know that "branches" are a thing, and run `git` commands by hand. That breaks the product pillar that the timeline hides git from the user (the user should never need to know git is underneath).

This spec adds the two missing primitives and routes merge conflicts through an AI agent so the user never sees a conflict marker. Vibe-coders are the target persona: they treat the timeline as "saved versions of my project", not as a DAG.

## Operating model

### Branch deletion (✕ button)

- Surface: every Dex-owned branch badge in the timeline (`dex/*`, `selected-*`) gets the same ✕ button that `selected-*` already has. Same shape, same testid pattern (`unselect-<branch>` becomes `delete-branch-<branch>`).
- Deletable set v1: **`dex/*` + `selected-*`** only. After the namespace cleanup these are the only two families that exist; the deletable set is also the visible set.
- Refused (button hidden / disabled with tooltip): `main`, `master`, any branch outside Dex namespaces. User branches stay safe by construction.
- HEAD handling: if the branch being deleted is the current branch, **always switch HEAD to `main` first**. (Differs from `unselect`'s "natural parent" search — vibe-coders only have one natural home.) If `main` doesn't exist, fall back to `master`. If neither exists, refuse with a friendly error.
- Lost-work warning: before deleting, check if the branch carries step-commits no other tracked branch reaches (`git log <branch> --not --branches=main --branches=dex/* --branches=selected-*`). If yes, open a confirmation modal listing the lost stages by their plain-English label (e.g. "Cycle 2 — Plan", "Cycle 2 — Tasks") plus the short-SHA. User confirms or cancels.
- Mid-run safety: if the branch is the orchestrator's current run branch (`state.json.status === "running"` and `currentBranch === <branch>`), refuse with a friendly "this version is currently being built — pause the run first" message. Acquired via existing `withLock(projectDir, ...)`.
- Dirty tree: not a blocker (deletion never touches working tree). Skipped — this differs from `jumpTo`'s dirty-tree handling on purpose.
- Post-delete: refresh the timeline. Source branch disappears, HEAD is on main.

### Promote-to-main (right-click → "Make this the new main")

- Surface: right-click on a branch badge for `dex/*` or `selected-*` → context menu with **"Make this the new main"**. (Re-uses the right-click-on-badge pattern; no left-click escalation — left-click stays scoped to focus.)
- Mergeable set v1: **`dex/*` + `selected-*`**. Same set as deletable (every branch a vibe-coder actually sees).
- Refused: `main`, `master`, user branches.
- Strategy: **always true merge** (`git merge --no-ff <source>`). Preserves the fork-and-rejoin in the timeline so the per-stage `[checkpoint:...]` history of the source branch survives — that history is the entire point of the timeline. No squash, no rebase, no fast-forward shortcut.
- Lock + dirty tree: same posture as `jumpTo`. Acquire `withLock`. If the working tree is dirty, reuse the existing `<GoBackConfirm>` modal (Save / Discard / Cancel). After 013-cleanup-2, "Save" already commits dirty changes onto the **current branch** before proceeding — no extra implementation work needed in 014; the merge flow simply calls into the same dirty-handling path that `jumpTo` uses.
- Mid-run safety: refuse if the orchestrator is running on `main` or on the source branch.

### Promote-to-main flow

1. **Confirm** — modal opens with a plain-English summary:
   - Title: **"Replace main with this version?"**
   - Body: file-level diff summary (counts: `4 files changed · +120 -38`); top 5 changed file paths; "View all changes" expander.
   - Buttons: **`Make this the new main`** / **`Cancel`**.
2. **Merge attempt** — orchestrator runs `git checkout main && git merge --no-ff --no-commit <source>`. Two outcomes:
   - **Clean merge** → commit (`dex: promoted <source> to main` with `[checkpoint:promoted:<source>]` trailer) → continue at step 4.
   - **Conflicts** → continue at step 3.
3. **AI conflict resolution** (only if `git merge` reports `CONFLICT`):
   - Live progress modal opens: **"Two versions disagree. Resolving with AI…"** Shows iteration counter, current file being resolved, cumulative cost so far.
   - Spawn the resolver agent (see [Conflict resolver agent](#conflict-resolver-agent) below). The agent edits files in the working tree to remove conflict markers. After each iteration: re-check `git status` for remaining unmerged paths.
   - On resolver success → run the project's verify command (e.g. `npx tsc --noEmit` from `dex-config.json` `verify.command`) → if pass, stage all + commit; if fail, treat as resolver failure.
   - On resolver failure (max iterations hit, build still failing, agent gave up): show the human escape modal:
     - **"Accept what AI did"** — commits whatever resolved state the agent reached.
     - **"Roll back the merge entirely"** — runs `git merge --abort`, returns to pre-merge HEAD.
     - **"Open in editor"** (small, bottom-right, power-user) — runs `git merge --abort` *or* keeps the conflicted state per a sub-toggle, and surfaces file paths in the user's `$EDITOR`. Single git-leak path, kept intentionally for advanced users.
   - The resolver does **not** handle non-content conflicts (rename/delete, binary, submodule). On detection, abort the merge and show: **"This version has a kind of conflict AI can't resolve yet. The merge has been undone. Edit the files manually and try again."** Single line; detailed guidance lives in docs.
4. **Post-merge actions** (all three, no toggles in v1):
   - Switch HEAD to `main` (it's already there from step 2).
   - Auto-delete the source branch silently.
   - Show a small toast: **"`<source>` is now main. The old version has been removed."**

   No new tag is created. The merge commit on `main` (subject `dex: promoted <source> to main`, parent set including the source tip) plus the fork-and-rejoin in the timeline already encode "this was promoted, from where, when". An extra `checkpoint/promoted-*` tag would be visual noise without information gain.
5. **Sync to remote** (out of scope v1) — see [Out of scope](#out-of-scope--follow-ups). Hook designed in.

### Conflict resolver agent

A new ad-hoc agent invocation — **not** a cycle step, **not** a task phase. The orchestrator's `AgentRunner` interface today only exposes `runStep` (cycle-step shaped) and `runTaskPhase` (build-mode tasks shaped); neither fits. We extend the interface with a third method:

```ts
interface AgentRunner {
  runStep(ctx: StepContext): Promise<StepResult>;
  runTaskPhase(ctx: TaskPhaseContext): Promise<TaskPhaseResult>;
  /** 013 — generic ad-hoc invocation. v1 implemented only on Claude. */
  runOneShot(ctx: OneShotContext): Promise<OneShotResult>;
}

interface OneShotContext {
  config: RunConfig;
  prompt: string;
  systemPromptOverride?: string;
  allowedTools?: string[];
  cwd?: string;
  abortController: AbortController | null;
  emit: EmitFn;
  rlog: RunLogger;
  /** Hard ceilings — resolver wraps each iteration inside one runOneShot call. */
  maxTurns?: number;
}

interface OneShotResult {
  cost: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  finalText: string;
  /** True when the SDK ended cleanly (not abort, not error). */
  finishedNormally: boolean;
}
```

`MockAgentRunner.runOneShot` returns a deterministic stub for tests. `ClaudeAgentRunner.runOneShot` calls `query()` with `cwd`, `allowedTools`, and a system prompt that combines `systemPromptOverride` (if any) with the project's resolved system prompt. No structured output, no spec dir, no cycle context — this is a free-form agent invocation.

#### Resolver harness

`src/core/conflict-resolver.ts` (new) wraps `runOneShot` in a loop:

1. Read all unmerged paths via `git status --porcelain` (lines starting with `UU`, `AA`, `DU`, etc.).
2. For each conflict file: read it, build a focused prompt:
   ```
   You are resolving a merge conflict. The file <path> contains git conflict
   markers (<<<<<<<, =======, >>>>>>>). Resolve them by producing a final
   version that keeps the intent of both branches. Context for what each branch
   was trying to do is below.

   Branch <main>: <last 5 commit subjects on main>
   Branch <source>: <last 5 commit subjects on source>
   Goal: <contents of GOAL.md, truncated to 2KB>

   Edit the file to remove all conflict markers. Do not modify any other file.
   ```
3. Call `runOneShot` with `allowedTools: ["Read", "Edit"]`, `cwd: projectDir`, `maxTurns: 5` (configurable per-iteration cap). The agent edits the file directly via the SDK's `Edit` tool.
4. After return: re-check the file. If conflict markers remain or the file failed to parse, count this iteration as failed. Move to next file.
5. After all files processed: re-run `git status` to verify zero unmerged paths.
6. If everything resolved: run the project's verify command (configurable). On pass, stage + commit. On fail, treat as failure (max iterations exhausted).
7. Emit progress events at each step: `{type: "conflict-resolver:file-start", file}`, `{type: "conflict-resolver:file-done", file, ok}`, `{type: "conflict-resolver:iteration", n, costSoFar}`, `{type: "conflict-resolver:done", ok, costTotal}`.

#### Configuration

Extend `<projectDir>/.dex/dex-config.json` with:

```json
{
  "conflictResolver": {
    "model": null,
    "maxIterations": 5,
    "maxTurnsPerIteration": 5,
    "costCapUsd": 0.50,
    "verifyCommand": "npx tsc --noEmit"
  }
}
```

- `model: null` → falls back to `dex-config.json` top-level `model` (same as the active orchestrator). Override only when the user wants a different model for resolution (e.g. cheaper).
- `maxIterations` — outer loop cap. After N file-attempts across all files, give up.
- `maxTurnsPerIteration` — cap inside one `runOneShot` call (SDK `maxTurns`).
- `costCapUsd` — accumulate cost across iterations; abort if exceeded. Hard floor on runaway spend.
- `verifyCommand` — what to run after resolution to validate. `null` skips verification.

All fields optional, all defaulted. New users do not need to touch this file.

### Voice and copy

The vibe-coder framing means the UI never says "merge", "branch", "PR", "fast-forward", "conflict marker". Reference table for everything user-visible:

| Concept | UI copy |
|---|---|
| Delete a branch (✕ tooltip) | "Remove this version" |
| Lost-work warning title | "These steps will be lost" |
| Promote-to-main right-click | "Make this the new main" |
| Promote confirm title | "Replace main with this version?" |
| Merge in progress | "Combining your changes with main…" |
| Conflict found | "Two versions disagree on the same lines. Resolving with AI…" |
| Resolver progress | "Resolving disagreement #3 of 7…" |
| Resolver success toast | "AI resolved 7 disagreements. The new main is ready." |
| Resolver failure modal title | "AI couldn't fully resolve the disagreement" |
| Post-merge success toast | "<source> is now main. The old version has been removed." |
| Non-content conflict abort | "This version has a kind of conflict AI can't resolve yet. The merge has been undone. Edit the files manually and try again." |

These strings live in `src/renderer/components/checkpoints/branchOps/copy.ts` so they're greppable / translatable later.

## Files

| File | Change |
|---|---|
| **Spec** | |
| `docs/my-specs/014-branch-management/README.md` | NEW — this document |
| **Core** | |
| `src/core/checkpoints/branchOps.ts` | NEW — `deleteBranch(projectDir, branchName, opts?)` and `mergeToMain(projectDir, sourceBranch, opts?)` core logic. Uses `safeExec`/`gitExec` from `_helpers.ts`. Returns discriminated-union results matching `JumpToResult`'s pattern. `mergeToMain` orchestrates: dirty check → checkout main → `git merge --no-ff --no-commit` → on conflict, hand off to `conflict-resolver.ts` → finalize commit + tag + delete-source. |
| `src/core/conflict-resolver.ts` | NEW — `resolveConflicts(projectDir, sourceBranch, runner, config, emit)`. Iterates over unmerged paths, calls `runner.runOneShot`, runs verify command, reports progress via `emit`. Pure function over `AgentRunner` — testable with `MockAgentRunner`. |
| `src/core/agent/AgentRunner.ts` | Add `runOneShot(ctx: OneShotContext): Promise<OneShotResult>` to `AgentRunner` interface. Add `OneShotContext` and `OneShotResult` types. |
| `src/core/agent/ClaudeAgentRunner.ts` | Implement `runOneShot` — thin wrapper over `query()` with `cwd`, `allowedTools`, `maxTurns`, no structured output, no spec dir. |
| `src/core/agent/MockAgentRunner.ts` | Implement `runOneShot` — deterministic stub. Honor a per-test fixture (`mock-config.json`) entry `oneShotResponses` so tests can script the resolver's behavior. |
| `src/core/checkpoints/index.ts` | Re-export `deleteBranch`, `mergeToMain` (flat + via `checkpoints` namespace). |
| **Main process / IPC** | |
| `src/main/ipc/checkpoints.ts` | New `checkpoints:deleteBranch` handler (wraps `deleteBranch` in `withLock`). New `checkpoints:mergeToMain` handler (wraps `mergeToMain` in `withLock`). Forwards resolver progress events via `webContents.send("orchestrator:event", ...)` using the existing event channel. |
| `src/main/preload.ts` | Expose `deleteBranch`, `mergeToMain` on `window.dexAPI`. |
| **Renderer types** | |
| `src/renderer/electron.d.ts` | Type the new APIs. |
| **Renderer — Timeline** | |
| `src/renderer/components/checkpoints/TimelineGraph.tsx` | Generalise the `selected-*`-only ✕ button into a "delete" button shown on every deletable badge (`dex/*` + `selected-*`). Replace `onUnselect` prop with `onDeleteBranch`. Add right-click handler on every badge → opens new `<BranchContextMenu>`. |
| `src/renderer/components/checkpoints/BranchContextMenu.tsx` | NEW — small floating menu on right-click. Single item v1: **"Make this the new main"** (disabled with tooltip when the branch is `main` itself). |
| `src/renderer/components/checkpoints/TimelinePanel.tsx` | Wire `deleteBranch` and `mergeToMain` IPC calls. Owns the new modals (`<DeleteBranchConfirm>`, `<PromoteConfirm>`, `<ConflictResolverProgress>`, `<ResolverFailureModal>`). Reuses `<GoBackConfirm>` for dirty-tree-before-merge. |
| `src/renderer/components/checkpoints/DeleteBranchConfirm.tsx` | NEW — modal listing lost stages when branch carries unique commits. Plain "Remove" / "Cancel" buttons. Skipped when branch has no unique commits. |
| `src/renderer/components/checkpoints/PromoteConfirm.tsx` | NEW — modal showing diff summary (file count, +/- lines, top 5 paths, expandable full list). Buttons: "Make this the new main" / "Cancel". |
| `src/renderer/components/checkpoints/ConflictResolverProgress.tsx` | NEW — live status modal. Subscribes to `conflict-resolver:*` events on the orchestrator event stream. Shows iteration counter, current file, cost so far. Cancel button → aborts resolver and rolls back the merge. |
| `src/renderer/components/checkpoints/ResolverFailureModal.tsx` | NEW — three-button escape modal ("Accept what AI did" / "Roll back the merge entirely" / "Open in editor" — last is small and bottom-right). |
| `src/renderer/components/checkpoints/branchOps/copy.ts` | NEW — single source of truth for all user-facing strings (see "Voice and copy" table). |
| **Removed (subsumed)** | |
| Existing `unselect` IPC + `checkpoints:unselect` handler + `unselect()` core fn (`src/core/checkpoints/jumpTo.ts:19`) | DELETE — `deleteBranch` subsumes it. The "switch HEAD to natural parent before deleting" logic is replaced with the simpler "always switch to main" rule. The `selected-*`-only restriction is gone (already covered by the deletable-set check in `deleteBranch`). UI ✕ button keeps the same pixel position; only the IPC target changes. |
| **Tests** | |
| `src/core/__tests__/branchOps.test.ts` | NEW — `deleteBranch`: deletable set respected (only `dex/*` + `selected-*`), HEAD switches to main, lost-work detection, mid-run lock refusal, refusal on `main`/`master`/user branches. `mergeToMain`: clean merge deletes source + switches HEAD to main + no new tag (regression check), dirty tree refused, mid-run refused. |
| `src/core/__tests__/conflictResolver.test.ts` | NEW — using `MockAgentRunner` with scripted `oneShotResponses`: clean resolution path, single-file resolution, multi-file resolution, max-iterations exhausted, cost-cap hit, verify-command-fails-after-resolution path, non-content conflict aborts before invoking agent. |
| `src/core/agent/__tests__/runOneShot.test.ts` | NEW — `MockAgentRunner.runOneShot` returns scripted result; `ClaudeAgentRunner.runOneShot` is integration-tested by the conflict-resolver tests. |

≈ 16 files touched, 4 deleted (the `unselect` surface), 12 new (incl. spec doc). All `attempt-*` / `capture/*` / Record-mode cleanup is counted against `013-cleanup-2`, not here.

## Existing helpers reused

- `safeExec()` / `gitExec()` — `src/core/checkpoints/_helpers.ts` for all git invocations.
- `withLock(projectDir, ...)` — `src/main/ipc/lock-utils.ts` for IPC mutation guarding.
- `<GoBackConfirm>` — `src/renderer/components/checkpoints/GoBackConfirm.tsx` for dirty-tree-before-merge prompt (Save / Discard / Cancel).
- `MockAgentRunner` — `src/core/agent/MockAgentRunner.ts` for resolver tests.
- `query()` from `@anthropic-ai/claude-agent-sdk` for `runOneShot` in `ClaudeAgentRunner`.
- Existing `checkpoints:listTimeline` consumed by the renderer for post-action refresh.
- Existing event stream (`orchestrator:event` over `webContents.send`) for resolver progress.
- `selectedBranchName()` factory in `src/core/checkpoints/tags.ts` — unchanged, used by `jumpTo`'s navigation-fork path. The dirty-tree-save flow no longer creates a new branch, so it does not call this factory.

## Implementation order

Assumes `013-cleanup-2` has landed. If implementing on top of pre-cleanup state, all `selected-*`-only restrictions on `unselect` need to keep working until `deleteBranch` subsumes them in step 3.

1. **Spec doc** — already in place at `docs/my-specs/014-branch-management/README.md`.
2. **`runOneShot` in `AgentRunner`** — interface + `MockAgentRunner` stub + `ClaudeAgentRunner` impl. Tests.
3. **`branchOps.ts` — `deleteBranch`** — core fn + IPC + UI generalisation of the existing ✕ button. Subsumes/deletes `unselect`. Tests + visual MCP check.
4. **`conflict-resolver.ts`** — pure function over `AgentRunner`, fully testable with `MockAgentRunner` scripted responses. Tests.
5. **`branchOps.ts` — `mergeToMain` (clean-merge path only)** — core fn + IPC + `<PromoteConfirm>` modal + post-merge cleanup (delete source, switch HEAD, toast). End-to-end MCP check on a non-conflicting promote.
6. **`mergeToMain` — conflict path** — wire `conflict-resolver` invocation, `<ConflictResolverProgress>` modal, `<ResolverFailureModal>`. Force-test by hand-crafting a conflicting `dex/*` branch in `dex-ecommerce`.
7. **`conflictResolver` config** — extend `dex-config.json` schema + defaults + load path.
8. **End-to-end verification** — see DoD.

## Verification (DoD)

1. **Reset + clean delete** — `./scripts/reset-example-to.sh <some checkpoint that produces a dex/* branch>`. Open project. Right-click is irrelevant for delete; click the ✕ on the `dex/*` lane badge. Confirm:
   - HEAD switches to `main` (`git rev-parse --abbrev-ref HEAD === "main"`).
   - Source branch is gone (`git branch --list 'dex/*'` does not include it).
   - No lost-work modal appeared (the `dex/*` branch's commits exist on no other branch ⇒ modal SHOULD have appeared — re-test confirms it did).
2. **Lost-work warning shown** — same as 1 but explicitly verify the modal listed the correct stages by their plain-English label and short SHA, and that "Cancel" left the branch intact.
3. **Delete refused on `main`** — ✕ button is not rendered (verified via MCP `take_snapshot` — no `delete-branch-main` testid).
4. **Delete refused on user branches** — manually create `feature/foo`; confirm no ✕ button appears on its badge.
5. **Delete refused mid-run** — start a run, while it's executing, attempt to delete its `dex/*` branch via the ✕ button. Confirm the IPC returns the friendly mid-run error and no destructive git op fires.
6. **Promote — clean merge** — reset to a checkpoint with a single `dex/*` branch ahead of `main` (no diverging changes on `main`). Right-click the `dex/*` badge → **"Make this the new main"** → diff modal opens with correct file list → click "Make this the new main". Confirm:
   - `git log main` includes a merge commit `dex: promoted <source> to main` with `--no-ff` topology (visible as a fork-and-rejoin in the timeline).
   - **No** new tag was created (regression check — verifies the spec change to drop `checkpoint/promoted-*`).
   - Source branch is gone.
   - HEAD on main.
   - Toast appeared.
7. **Promote — clean merge mid-run refused** — same as 6 but during an active run; confirm friendly refusal.
8. **Promote — AI resolves a single-file conflict** — hand-prep `dex-ecommerce` with a `dex/*` branch that touches the same line as a fresh commit on `main`. Right-click → promote. Confirm:
   - `<ConflictResolverProgress>` modal opens with iteration counter ticking.
   - Resolver agent edits the file, removes conflict markers.
   - Verify command runs (`npx tsc --noEmit`) and passes.
   - Final commit lands on main.
   - All four post-merge actions fire (tag, delete source, switch to main, toast).
9. **Promote — AI resolves a multi-file conflict** — same setup but two files conflict; confirm resolver iterates per file and reports each separately in the progress modal.
10. **Promote — AI fails (max iterations)** — set `conflictResolver.maxIterations: 1` in `dex-config.json` and prep an unresolvable conflict (e.g. mutually exclusive interface signatures). Confirm:
    - `<ResolverFailureModal>` opens after iteration 1 fails.
    - "Roll back the merge entirely" → `git merge --abort` runs, HEAD returns to pre-merge `main`, source branch still exists, no tag created.
11. **Promote — AI fails (verify command)** — engineer a conflict where the agent removes markers but produces non-compiling code; confirm verify failure routes to `<ResolverFailureModal>` with "Accept what AI did" still allowing commit (user override).
12. **Promote — non-content conflict** — engineer a rename/delete conflict; confirm merge aborts before invoking the resolver and the friendly message appears.
13. **Promote — cost cap hit** — set `costCapUsd: 0.001`; confirm resolver halts at the first iteration that pushes total cost over the cap; failure modal opens.
14. **Promote — dirty-tree-save before merge** — modify a tracked file, right-click promote, pick "Save" in the `<GoBackConfirm>` dialog. Confirm the dirty change is autosaved on the current branch (per `013-cleanup-2`'s rewrite — verified there) and the merge proceeds.
15. **Type/build** — `npx tsc --noEmit` passes; `npm test` passes.
16. **Visual check** — MCP screenshots at each milestone via `electron-chrome`: ✕ tooltip text, lost-work modal, promote diff modal, resolver progress, failure modal, post-merge timeline (showing the new fork-and-rejoin merge commit on main, no extra tag ring on it).

## Out of scope / follow-ups

- **Sync to remote / push to GitHub** — natural follow-up after a successful promote. UI hook designed in (toast could grow a "Sync to GitHub" button when `git remote get-url origin` returns a value), but the entire push flow (auth, conflict on push, multi-remote, branch protection rules) is its own spec. Out of v1.
- **PR / GitHub PR flow** — explicitly excluded. The vibe-coder default is in-app diff + AI conflict resolution; users who want code review by humans can push to a feature branch in their own GitHub flow. PR-as-promote is a power-user toggle for a future spec.
- **Bulk delete UI** — `scripts/prune-example-branches.sh` keeps doing its cron-style sweep (now narrowed to `dex/*` only). No "Clean up old branches" panel in v1.
- **Delete user (non-Dex) branches** — explicitly refused. A vibe-coder's hand-made `feature/foo` branch is not Dex's to remove.
- **Squash / rebase / fast-forward strategies** — `git merge --no-ff` is the only strategy in v1. Power-user strategies belong to a future "Promote settings" panel.
- **Non-content conflicts (rename/delete, binary, submodule)** — abort with friendly message. Resolver does not attempt these. Future spec if they become common.
- **Scriptable / headless invocation** of delete + promote (CLI surface) — IPC is the only interface in v1.
- **Conflict-resolver model swap mid-resolution** (e.g. fall back from Sonnet to Opus on failure) — single model per `dex-config.json` setting in v1.
- **Per-file resolver progress diff preview** — resolver progress modal shows file paths + counters only. No live "what is the agent editing right now" view.
- **All cleanup of `attempt-*`, `capture/*`, Record mode** — covered by the prerequisite spec `013-cleanup-2`. 014 only touches the user-facing feature surface; it doesn't redo any of that hygiene work.
- **`unselect` IPC compatibility shim** — the IPC handler is removed outright (subsumed by `deleteBranch`). No call sites outside the renderer; no shim needed.
