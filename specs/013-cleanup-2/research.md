# Phase 0 — Research

**Feature**: Branch Namespace + Record-mode Cleanup (`013-cleanup-2`)
**Companion**: [`docs/my-specs/013-cleanup-2/README.md`](../../docs/my-specs/013-cleanup-2/README.md) — Why This Is Safe (§ pre-flight grep evidence) + § Files (file-level edit map).

## Summary

**No open clarifications.** The source spec has zero `[NEEDS CLARIFICATION]` markers. Every decision the cleanup turns on (deletion targets, deletion order, rename strings, behavioural carve-outs) is already pinned by the companion README, which performs an exhaustive set of grep audits to prove that each piece of machinery being removed is dead under the running app. This research file documents the audits at the level of "what was decided and why" so a reviewer who has not read the README can still accept the deletions.

The format below follows the Phase 0 protocol: **Decision → Rationale → Alternatives**.

---

## R1 — How is "dead" verified?

**Decision**: Use `grep -rn '<symbol>' src/` to enumerate every reference to each symbol or string slated for deletion, and require the result to be either (a) the export site itself, or (b) a call site inside another block that is also being deleted in the same change. Six symbols/strings are audited explicitly in the README's [Why this is safe](../../docs/my-specs/013-cleanup-2/README.md#why-this-is-safe) section; the audit results are reproduced in the spec's Assumptions section.

**Rationale**: A textual grep is sufficient because TypeScript imports are explicit (no dynamic `require` paths in `src/core/` or `src/renderer/`) and there is no runtime reflection that could resurrect a "dead" symbol. The same approach was used successfully in `012-cleanup` (variant-groups verbs / step-candidate prompt removal) and in `007-sqlite-removal` (entire `better-sqlite3` dependency).

**Alternatives considered**:

- **Static dead-code analyzer (`ts-prune`, `knip`)**: noisier on a TypeScript repo with `index.ts` re-export barrels — false positives where a re-export is an intentional public surface. Manual grep gives a precise audit trail per symbol.
- **Compiler-driven pruning (delete the symbol, see what breaks)**: works but brittle on a multi-step deletion where intermediate states must type-check (see R2).

---

## R2 — How is the deletion order chosen?

**Decision**: Follow the numbered implementation order in [README §11 Implementation order](../../docs/my-specs/013-cleanup-2/README.md#implementation-order). The non-obvious bit is the gating sequence around the `checkpoint_promoted` orchestrator-event discriminant: **the discriminant in `events.ts` and the consumer `case` in `useTimeline.ts:70` cannot be removed until both producers (`orchestrator.ts:289` and `recordMode.ts:65`) are gone**. Deleting the discriminant earlier breaks `recordMode.ts` type-checking; deleting it later leaves a dead type. The README pins this as step 7b — fired immediately after step 7 (the `recordMode.ts` delete).

**Rationale**: Each numbered step must end with `npx tsc --noEmit` + `npm test` + `npm run lint` green (Constitution Principle III + spec NFR-001). The only ordering constraint that's not "obvious from imports" is the discriminant gating, so the README calls it out separately.

**Alternatives considered**:

- **Single big-bang commit**: simpler to write, harder to review, and risks intermediate breakage if the reviewer needs to bisect later. Rejected.
- **Move discriminant deletion before producer deletion**: would force a temporary `// @ts-ignore` in `recordMode.ts` during the transition. Rejected — violates Principle IV (no shims).

---

## R3 — Why a `dex: pre-jump autosave` commit instead of a side branch?

**Decision**: When the user picks **Save** in the Go-Back confirm dialog with a dirty working tree, run `git add -A && git commit -q -m "dex: pre-jump autosave"` on the currently checked-out branch (no `git branch` / `git checkout` machinery), then proceed with the timeline jump. The post-jump auto-prune of empty `selected-*` branches naturally preserves a `selected-*` branch the autosave landed on, because the new commit makes it non-empty relative to the jump target.

**Rationale**: The pre-cleanup behaviour minted an `attempt-<ts>-saved` side branch that was the *only* remaining producer of the entire `attempt-*` family. Replacing it with a normal commit on the current branch:

1. Eliminates the family at its root, unblocking the rest of the cleanup.
2. Removes the leaky branch name from the user-visible Save dialog (UX win).
3. Preserves the user's intent (their changes are saved somewhere reachable) without adding a hidden branch they didn't ask for.

The commit message `dex: pre-jump autosave` is intentionally short and present-tense (matches the existing `dex:` prefix convention used by `commitCheckpoint`).

**Alternatives considered**:

- **`git stash`**: implicitly stashes onto a worktree-private stack with no UI affordance. Users would have no obvious way to find their changes again. Rejected.
- **Keep the side branch but rename it to `dex/saved-<ts>` (still in `dex/*` namespace)**: solves the "different namespace" problem but keeps the dirty-tree-save flow on a different branch from where the user was working. Adds confusion for zero benefit. Rejected.
- **Keep `attempt-<ts>-saved` but hide the branch name in the UI**: cosmetic-only, leaves the entire `attempt-*` family alive in the timeline / pruner / type system. Rejected.

---

## R4 — Why refuse on detached HEAD instead of falling back to a side branch?

**Decision**: When `git symbolic-ref -q HEAD` returns non-zero (HEAD is detached), the dirty-tree-save flow returns `{ ok: false, error: "git_error", message: "Cannot save changes while in detached-HEAD state. Switch to a branch first." }` and creates no commit, no branch.

**Rationale**: Detached HEAD is reachable today only via timeline node-clicks landing on a `checkpoint/*` tag's commit (a deliberate user action — viewing history). A user in this state is inspecting history, not editing — uncommitted changes here are almost always accidental edits the user wants to inspect, not save. A friendly refusal preserves their changes in the worktree without committing them anywhere unexpected. If saving is truly desired, the user can branch out manually.

**Alternatives considered**:

- **Auto-create a fresh `dex/saved-<ts>` branch on detached HEAD**: re-introduces the side-branch concept the cleanup is removing. Rejected.
- **Commit on detached HEAD anyway (an orphan commit)**: produces a commit reachable only by SHA. The user has no way to find it from the UI later. Rejected.
- **Silently drop the dirty changes**: data loss. Rejected.

---

## R5 — Why relocate `syncStateFromHead` instead of leaving it in place?

**Decision**: Move `syncStateFromHead` from `src/core/checkpoints/recordMode.ts` to a new `src/core/checkpoints/syncState.ts`. Move the module-private helper `snapshotResumeFields` along with it (it has no other callers). Same signatures, same bodies, same dependencies after the move.

**Rationale**: `recordMode.ts` is being deleted entirely (all its other functions are dead post-cleanup). `syncStateFromHead` is the one function in the file that is *not* dead — it has five live consumers (App.tsx, IPC, preload, renderer service, electron.d.ts) and is unrelated to Record mode despite living in the same file historically. Two options: (a) inline-merge it into one of its callers, or (b) give it its own home. Option (b) preserves the call-site surface (no IPC change), keeps the function platform-agnostic (lives in `src/core/`), and is a clean split with zero behavioural change.

**Alternatives considered**:

- **Inline `syncStateFromHead` into `src/main/ipc/checkpoints.ts`**: would break the platform-agnostic-core boundary (Constitution Principle II) — the function reads/writes `state.json` via `loadState` / `updateState` and runs git via `gitExec`, which are in `src/core/`. Inlining moves core logic into main process. Rejected.
- **Keep `recordMode.ts` and just delete its dead functions**: leaves a misleadingly-named module containing only `syncStateFromHead`. Future readers would wonder why a "record mode" file is loaded on every resume. Rejected.

---

## R6 — Why keep `commitCheckpoint` and the `[checkpoint:<step>:<cycle>]` subject convention?

**Decision**: `commitCheckpoint` and the `[checkpoint:<step>:<cycle>]` commit-subject convention are explicitly out of scope. After this cleanup the convention becomes the *only* mechanism by which the timeline identifies stage boundaries — pending candidates are derived from grepping commit subjects (the existing `pending: PendingCandidate[]` mechanism on `TimelineSnapshot`).

**Rationale**: The convention is a producer of timeline data (each stage produces one commit with this subject). Removing it would break the timeline. The auto-promotion to canonical `checkpoint/*` tags during a run is a *consumer* of the convention; that consumer is what's being removed (FR-007 in the spec). The producer side is unchanged — step commits still get cut on every stage boundary; they just stay as commits, not tags, until someone explicitly promotes them via `scripts/promote-checkpoint.sh`.

**Alternatives considered**:

- **Remove the subject convention and identify stages by some other mechanism (e.g. trailers, git notes)**: substantially larger refactor. Out of scope; not motivated by user need.

---

## R7 — Why is `scripts/reset-example-to.sh` allowed to keep minting `attempt-*` branches?

**Decision**: The fixture-only `attempt-${STAMP}` branch creation in `scripts/reset-example-to.sh:53` is preserved as a deliberate carve-out. The `prune-example-branches.sh` `attempt-*` glob is deleted (FR-015), so fixture-created branches linger until manually deleted.

**Rationale**: The script is a testing fixture entry point pointed *only* at the example project (`dex-ecommerce`). The `attempt-*` name is internal scaffolding for the testing flow; it never reaches the running app's timeline (because Dex is opened on a different project, not the example). Renaming would be churn for zero user benefit, and the script is the *only* authorised destructive path against the example project (per `.claude/rules/06-testing.md`), so introducing a new name there would force coordinated edits to the testing harness. The pruner glob removal is fine — fixture branches don't accumulate at scale in a typical dev session.

**Alternatives considered**:

- **Rename to `dex/fixture-${STAMP}` to match the new namespace**: tempting for consistency, but the rename has to be coordinated with `reset-example-to.sh`'s callers and the testing harness. Out of scope. The carve-out is documented in [Keep untouched](../../docs/my-specs/013-cleanup-2/README.md#keep-untouched).

---

## R8 — Why no migration for pre-existing user state?

**Decision**: Users with a `state.json.ui.recordMode = true` field set today (developer-only — the field was never reachable from the UI) silently ignore the field after the cleanup (FR-011). No first-launch migration. Pre-existing `capture/*` branches, `checkpoint/done-*` tags, and `attempt-*` branches in user repos linger until manually deleted.

**Rationale**: The `recordMode` field is unread post-cleanup — TypeScript will error at compile time if any code tries to read it (the field is removed from the interface), and the field doesn't appear in any deserialization validator. Pre-existing git refs are not corruption — they're just unused branches and tags that the running app no longer produces. A user who wants a clean repo can `git branch -D` / `git tag -d` them manually. Building an automated cleanup at first launch would (a) be code that runs on every launch but does meaningful work zero times for ≥99.99 % of users, (b) violate Principle IV (YAGNI), and (c) introduce a non-trivial blast radius for what's currently an inert problem.

**Alternatives considered**:

- **One-shot first-launch cleanup, gated on a "migration version" field**: see (a)-(c) above. Rejected.
- **Print a warning when a `recordMode` field is detected at load time**: noise for the developer-only audience that set the field intentionally. Rejected.

---

## Open Questions

**None.** Every implementation decision in the spec is pinned. The companion README is the single source of file-level truth; the spec is the single source of contract truth; this research file justifies the decisions both rest on.
