# Phase 0 — Research: Branch Management

**Feature**: 014-branch-management
**Date**: 2026-05-03
**Purpose**: Resolve the small set of unknowns the source design doc left to implementation choice. Most decisions are already made in `docs/my-specs/014-branch-management/README.md`; this file records only the items that still required investigation or where multiple credible options exist.

## R1 — Detecting non-content conflicts before invoking the resolver

**Decision**: Inspect `git status --porcelain=v1` after `git merge --no-ff --no-commit`. Treat any of these XY codes as "non-content" and abort the merge before spawning the resolver:

| XY code | Meaning |
|---|---|
| `DU` | deleted by us, modified by them |
| `UD` | modified by us, deleted by them |
| `DD` | both deleted (still recoverable but the resolver has no marker file) |
| `AU` | added by us (rename pair without content overlap) |
| `UA` | added by them |
| `AA` | both added (in v1 we treat as non-content; the marker form is too unstable across git versions) |

Plus an explicit check: if any unmerged path has Git attributes `binary` set, or `text` is `false` for that path via `git check-attr -a`, abort. Submodule conflicts are detected by walking `.gitmodules` and checking whether any conflicted path matches a submodule prefix.

**Rationale**: `git status --porcelain=v1` is stable across git ≥ 2.0 (we ship with whatever git the user has system-wide; nothing pins a specific version). The XY-code dispatch is what `git mergetool` uses internally, so we inherit a battle-tested classification. Binary detection via `git check-attr` is the canonical check — testing magic bytes ourselves duplicates work git already did.

**Alternatives considered**:

1. *Try the resolver on everything; let it fail.* Rejected — the resolver would burn cost on files where there is no conflict-marker form to repair (e.g. binary), and the failure UX would be worse (mysterious resolver "couldn't help" instead of a clear "AI doesn't handle this kind of conflict yet").
2. *Use `git status --porcelain=v2` and key off the unmerged-entry header.* Rejected — v2 is more structured but only adds clarity for already-classified content conflicts. The non-content classification still comes from XY-equivalent state, and v1 is less verbose to parse.
3. *Use `libgit2` for a structured conflict listing.* Rejected — adds a non-trivial native dep for a one-time check we can do in 20 lines of shell parsing.

## R2 — Diff summary for the promote-confirm modal

**Decision**: Compute via two cheap git invocations against the merge-base, before any merge attempt:

1. `git diff --shortstat <main>...<source>` → "N files changed, +A -B" (the parenthetical totals).
2. `git diff --name-only <main>...<source> | head -5` → top 5 changed paths.
3. `git diff --name-only <main>...<source>` → full list, lazy-loaded behind the "View all changes" expander only when the user opens it (avoids paying for the read on the common case).

Note the **three-dot** form (`<main>...<source>`): it diffs the source against the merge-base, not against tip-of-main, so a moving main does not change the summary the user sees.

**Rationale**: shortstat is the same summary `git log --stat` users are used to and matches the +A -B counts we already render in other places. Three-dot is the right semantic — the user is asking "what does this version add?", not "what is different right now?". Top-5 by `diff --name-only` order (alphabetical by default) is fine for v1; sorting by churn would require `--numstat` which is more parsing for marginal value in the confirm UI.

**Alternatives considered**:

1. *`git diff --stat <main>...<source>`* (full stat) — rejected, paid the file-content-walk cost up front for data we only show in the expander.
2. *Two-dot form `<main>..<source>`* — rejected, asymmetric semantics confuse the user when main has unrelated commits.
3. *Compute churn-ranked top-5 via `--numstat`* — rejected, adds parsing for a subjective "best 5" choice; alphabetical is good enough and predictable.

## R3 — Resolver agent allowed-tools surface

**Decision**: `allowedTools: ["Read", "Edit"]` only. No `Write`, no `Bash`, no `Glob`, no `Grep`, no MCP tools.

**Rationale**: The resolver edits exactly one file at a time, in place, removing conflict markers. `Read` is needed to inspect the file (the agent decides what content to keep); `Edit` is the in-place mutator. Any broader surface invites failure modes:

- `Write` — could create new files; the resolver is a closed-world operation.
- `Bash` — could run arbitrary commands; bypasses the structured agent invocation and breaks reproducibility.
- `Glob`/`Grep` — would let the agent gather context from the whole repo. Empirically, the focused-prompt approach (file content + last-5-commit-subjects + truncated `GOAL.md`) is sufficient and bounds prompt size.

**Alternatives considered**:

1. *Add `Bash` for build verification.* Rejected — verify is run by the harness, not the agent. Keeping the agent in a tighter sandbox makes its budget predictable.
2. *Add `Grep` so the agent can look up unfamiliar symbols.* Rejected for v1 — adds prompt-time variance (the agent may grep instead of editing); reconsider if real-world resolver runs show high failure rates rooted in missing context.

## R4 — Resolver per-file prompt template

**Decision**: One prompt per unmerged file, structured as system + user. The system message is the project's resolved system prompt (so it carries any user-installed `.claude/CLAUDE.md` rules) plus a short override identifying the resolver role. The user prompt has four sections in fixed order:

```
You are resolving a merge conflict. The file <path> contains git conflict
markers (<<<<<<<, =======, >>>>>>>). Resolve them by producing a final
version that keeps the intent of both branches. Context for what each branch
was trying to do is below.

Branch <main>:
<last 5 commit subjects on main, oldest-first, truncated to 80 chars each>

Branch <source>:
<last 5 commit subjects on source, oldest-first, truncated to 80 chars each>

Goal:
<contents of GOAL.md, truncated to 2KB>

Edit the file to remove all conflict markers. Do not modify any other file.
```

**Rationale**: The four context blocks are the smallest set that gives the agent the "why" behind each side without ballooning the prompt. `GOAL.md` is the project intent; the commit subjects on each branch tell the agent what each side was trying to do; the file path + markers locate the work. Truncations are deliberate — `GOAL.md` at 2KB stays well under the prompt-cache-friendly threshold; commit subjects at 80 chars × 5 each side cap the noise.

**Alternatives considered**:

1. *Include the full file diff (both sides + base).* Rejected — the marker form already contains both sides interleaved; adding the diff is redundant and triples the prompt size.
2. *Include surrounding files (e.g. siblings in the same module).* Rejected for v1 — out of `Read`/`Edit` budget and pushes the prompt past predictable cache behaviour. Reconsider if real-world resolutions need cross-file context.
3. *No `GOAL.md` (just the markers + commit subjects).* Rejected — `GOAL.md` is what tells the agent "this is a checkout flow, not a settings page", which dramatically improves resolution quality on ambiguous merges.

## R5 — Verify-command discipline (`verifyCommand: null` semantics)

**Decision**: When `conflictResolver.verifyCommand` is `null`, skip the verify step entirely. The resolver succeeds as soon as `git status` shows zero unmerged paths. The success toast still fires; the post-merge actions still run. No "skipped verification" warning is shown to the user.

**Rationale**: Some projects don't have a clean compile gate (early-stage prototypes, multi-language repos where TypeScript-only `tsc --noEmit` doesn't capture everything). Forcing them to provide a verify command would push users into writing a no-op `verify.sh` just to satisfy the schema. Treating `null` as opt-out keeps the config schema honest. The default config ships with `"verifyCommand": "npx tsc --noEmit"` so the average TypeScript user gets verification automatically.

**Alternatives considered**:

1. *Treat `null` as "use the project's default verify"* — rejected, there's no project-default verify config in Dex; we'd be inventing a new concept.
2. *Always require a non-null verify and ship a noop default like `true`* — rejected, the noop verify hides real verification failures in projects that should have one.
3. *Show a small "verification skipped" warning toast.* Rejected for v1 — the user opted into `null` consciously; a recurring warning is noise. Reconsider if support tickets show users surprised by missing verification.

## R6 — Cost accumulation and cap enforcement

**Decision**: Accumulate cost in the harness across iterations and across files. After each `runOneShot` returns, add `result.cost` to the running total. Before starting the **next** iteration, compare the running total against `costCapUsd`. If `total + iterationBudget > cap` (where `iterationBudget` is a conservative estimate based on the previous iteration's cost or, on the first iteration, on a constant ~$0.05), halt and emit `{type: "conflict-resolver:done", ok: false, costTotal, reason: "cost_cap"}`.

**Rationale**: We can't bound the cost of a single SDK call from outside the SDK (the SDK enforces `maxTurns` but cost depends on token usage). Checking *between* iterations gives us a clean cut point and ensures the cap is never exceeded by more than one iteration's worth. SC-008 ("never exceeds cap 100% of the time") is satisfied because we never *start* an iteration that would push us over.

**Alternatives considered**:

1. *Enforce the cap inside `runOneShot` by streaming cost from the SDK and aborting mid-call.* Rejected — the SDK's cost stream is post-hoc per assistant message; aborting mid-stream is racy and the partial result is unusable. Inter-iteration enforcement is the simpler correct shape.
2. *Pre-compute a per-iteration budget ($cap / maxIterations).* Rejected — if the first iteration is cheap, the second one shouldn't be artificially capped. Dynamic accumulation is more permissive without breaking the safety floor.

## R7 — Modal layering and z-index discipline

**Decision**: All four new modals (`<DeleteBranchConfirm>`, `<PromoteConfirm>`, `<ConflictResolverProgress>`, `<ResolverFailureModal>`) reuse the existing `<Modal>` primitive at `src/renderer/components/checkpoints/Modal.tsx`. Stacking is at most two deep (e.g., dirty-tree-`<GoBackConfirm>` over the underlying timeline, then the promote flow takes over after `<GoBackConfirm>` closes — they are never visible simultaneously).

**Rationale**: The existing `<Modal>` already handles the backdrop, escape-to-dismiss, and focus trap. Reusing it keeps the look consistent and dodges the per-modal styling drift that bites projects with five hand-rolled overlays. The "at most two deep" discipline is an implementation contract, not a runtime guard — flows are designed not to layer.

**Alternatives considered**:

1. *Build a new `<MultiStepFlow>` component to host the promote → confirm → resolver-progress → resolver-failure pipeline.* Rejected as premature abstraction — the flow is sequential, not nested; each step renders its own modal in turn. YAGNI per Constitution IV.
2. *Use a portal with a separate z-index plane for resolver progress (so it can sit "on top" of unrelated UI).* Rejected — the resolver runs blocking on a single user gesture; the user should never be doing other things while it runs.
