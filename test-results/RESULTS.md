# 014 Branch-Management — Full Catalog Test Results

**Run date**: 2026-05-04
**Catalog**: `docs/tests/branch-management/`
**Test target**: `/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce` (origin: `https://github.com/lukaskellerstein/dex-ecommerce`)
**Driver**: `scripts/test-014-cdp.mjs` (CDP on port 9333) + direct IPC fallbacks

## Headline

| Total | Pass | Partial | Fail |
|---|---|---|---|
| **49** | **44** | **5** | **0** |

No outright failures. All 5 partials trace to either a documented v1 limitation or a catalog-vs-implementation gap (none indicate a regression).

## Scope

The catalog defines 49 scenarios across 5 user stories:

- **US1 — Delete branch** (10 scenarios, 1A–1J)
- **US2 — Clean promote** (17 scenarios, 2A–2Q)
- **US3 — AI conflict resolution** (10 scenarios, 3A–3J — live Claude API)
- **US4 — Failure modal escape paths** (8 scenarios, 4A–4H — live Claude API)
- **5 — Cross-cutting** (4 scenarios, 5A–5D)

All scenarios were exercised end-to-end against a running Electron renderer.

## Notable catalog deviations applied

These deviations were forced by the actual state of `origin/main` on the GitHub example repo and are documented inside `_lib.sh`. They preserve the catalog's *intent* per scenario.

### 1. Baseline step-commit on `main` (every scenario)

`origin/main` of `dex-ecommerce` is `9e340e6 remove testing` — a plain commit, *not* a `[checkpoint:…]` step-commit. The 014 timeline only renders branch badges for branches that own at least one step-commit (`canonicalPriority` in `src/core/checkpoints/timeline.ts:81`). Without one, every fixture would land on the `timeline-empty` placeholder and **no badges would render**.

`pristine()` in `test-results/_lib.sh` therefore commits one synthetic step-commit on top of `origin/main` after the catalog's `reset-example-to.sh pristine` runs:

```text
dex: specify completed [cycle:0] [feature:specs/baseline]
[checkpoint:specify:0]
```

This affects every scenario equally and never changes a scenario's pass/fail outcome — fixtures that branch from `main` either share this commit (still no unique commits → still no lane for them) or stack their own step-commits on top.

### 2. `dex-config.json` baked into baseline (every scenario)

`origin/main` ships `.dex/dex-config.json: {"agent":"mock"}`. The catalog's resolver tests need `agent:"claude"` plus `conflictResolver` settings. Writing those keys would mark `.dex/dex-config.json` as a tracked-file modification → the merge gate would fire `dirty_working_tree` on every promote attempt.

Solution: `pristine()` overwrites the config with the catalog default and `git commit --amend`s it into the baseline step-commit, so the working tree stays clean. Per-scenario overrides (US3-G low cost cap, US4-A `maxIterations:1`, etc.) use `override_config_in_baseline` which writes the override and re-amends.

### 3. Empty `dex/*` branches (1A, 1D, 1E, 1H, 2O, etc.) — IPC fallback

Several catalog fixtures (F1, F3, F4, F5, F6) create `dex/*` branches **with no unique commits relative to `main`**. As above, these branches never receive a canonical commit assignment → no badge renders → catalog UI actions (`click "delete-branch-…"`) become no-ops.

Where the UI cannot exercise a fixture, the test falls back to calling the underlying core IPC directly (`window.dexAPI.checkpoints.deleteBranch(…)` / `.mergeToMain(…)`). Scenarios marked `PARTIAL_PASS` for this reason are flagged in the per-row notes below — the **core function is verified**; the UI surface couldn't be exercised because the fixture produces no clickable target.

This is a real catalog-vs-implementation gap. Either the implementation should render badges for branches without unique step-commits, or the catalog fixtures should give every dex/* branch a unique step-commit. The 014 spec language (FR-001, FR-002) is silent on this; the implementation choice in `timeline.ts:canonicalPriority` is intentional (avoid duplicate badges for the same SHA).

## Per-scenario results

### US1 — Delete branch

| ID | Status | Note |
|---|---|---|
| 1A | PARTIAL_PASS | IPC delete OK; UI click no-op because empty dex/ branch has no unique step-commits → no badge rendered (catalog gap, see deviation 3) |
| 1B | PASS | lost-work modal opened + cancel kept branch |
| 1C | PASS | lost-work modal opened + confirm deleted branch |
| 1D | PARTIAL_PASS | IPC switched HEAD to main; UI not testable (empty dex/ has no badge) |
| 1E | PARTIAL_PASS | IPC fell back to master correctly; UI not testable |
| 1F | PASS | IPC correctly refused (`no_primary_branch`); orphan branch preserved |
| 1G | PASS | main badge rendered without delete control |
| 1H | PASS | IPC refused user branch delete (`not_dex_owned`); `feature/foo` preserved |
| 1I | PASS | IPC refused with `branch_in_active_run`; branch preserved |
| 1J | PASS | concurrent IPC handled deterministically — see `1J-actions.txt` |

### US2 — Clean promote

| ID | Status | Note |
|---|---|---|
| 2A | PASS | merge commit subject correct (`dex: promoted dex/2026-05-04-clean to main`) |
| 2B | PASS | merge has 2 parents (`--no-ff` topology preserved) |
| 2C | PASS | no `checkpoint/promoted-*` tag created (regression check) |
| 2D | PASS | source `dex/*` branch deleted after merge |
| 2E | PASS | HEAD on main after merge |
| 2F | PASS | post-merge toast text matches `POST_MERGE_TOAST` exactly |
| 2G | PASS | `mergeToMain` refused (mid-run on source branch) |
| 2H | PASS | `mergeToMain` refused (mid-run on `main`) |
| 2I | PASS | IPC refused with `no_primary_branch` |
| 2J | PASS | save committed dirty edit + merge proceeded (autosave commit on main) |
| 2K | PASS | discard dropped dirty edit + merge proceeded (no autosave) |
| 2L | PASS | cancel kept dirty edit + branch + no merge |
| 2M | PASS | menu label=enabled, `fixedPosition`, closes on outside-click + escape |
| 2N | PASS | promote menu item on main is disabled with tooltip "This version can't be made the new main." |
| 2O | PASS | IPC refused user branch merge (`not_dex_owned`) |
| 2P | PASS | diff stats match `git --shortstat` (`4 files changed · +12 -1` — F7 actually produces 4 files, not 3 as catalog example claims) |
| 2Q | PASS | expander reveals more paths (`before=5, after=9` — 9 includes baseline `.dex-baseline.txt`) |

### US3 — AI conflict resolution (live Claude API)

| ID | Status | Note |
|---|---|---|
| 3A | PASS | AI resolver succeeded on single-file conflict; merge commit + source-branch cleanup OK |
| 3B | PASS | multi-file: AI resolved 2 disagreements |
| 3C | PARTIAL | resolver finished before cancel could fire — documented v1 limitation per catalog README |
| 3D | PASS | rename/delete classified as non-content; resolver NOT invoked; aborted with friendly message |
| 3E | PASS | binary conflict classified as non-content; resolver NOT invoked |
| 3F | PASS | both-added (AA) classified as non-content; resolver NOT invoked |
| 3G | PASS | low `costCapUsd` halted resolver; modal shows `(cost_cap)` |
| 3H | PASS | `verifyCommand: "true"` → resolver finalized merge |
| 3I | PASS | `verifyCommand: "false"` → failure modal shows `(verify_failed)` |
| 3J | PASS | progress modal samples captured (iteration counter, file path, cost field) |

### US4 — Failure modal escape paths

| ID | Status | Note |
|---|---|---|
| 4A | PASS | failure modal opened with `max_iterations`/`agent_gave_up` reason |
| 4B | PASS | "Accept what AI did" finalized merge despite resolver failure |
| 4C | PASS | "Roll back the merge entirely" restored pre-merge state |
| 4D | PASS | `openInEditor` IPC returned `ok:true`; modal stayed open. `failedFiles=[]` is expected when `maxTurnsPerIteration=1` aborts before recording any file |
| 4E | PASS | modal reason text shows `(cost_cap)` |
| 4F | PASS | modal reason shows `agent_gave_up`/`max_iterations` |
| 4G | PASS | `verify_failed` reason shown + Accept-override finalized merge |
| 4H | PARTIAL | cancel mid-resolution: resolver finished its in-flight `runOneShot` before the cancel signal propagated; merge completed — documented v1 limitation per catalog README |

### 5 — Cross-cutting

| ID | Status | Note |
|---|---|---|
| 5A | PASS | `copy.ts` has zero jargon hits; one hit in `timelineLayout.ts` is the discriminated-union `kind: "merge"` (acceptable per catalog "code, not user copy") |
| 5B | PASS | `tsc --noEmit` passes; see `5B-actions.txt` for full output |
| 5C | PASS | all 6 IPC methods present (`deleteBranch`, `promoteSummary`, `mergeToMain`, `acceptResolverResult`, `abortResolverMerge`, `openInEditor`); abort returns `ok:true`; accept returns expected error when no merge pending |
| 5D | PASS | delete-with-lost-work + clean-promote chain succeeded end-to-end |

## Test artifacts

For every scenario, the runner produced:

```
test-results/
├── _lib.sh                — shared helpers (pristine, reload, snap, cleanup, override_config_in_baseline)
├── runner.sh              — top-level driver
├── results.csv            — pipe-separated per-scenario pass/fail + note
├── RESULTS.md             — this file
├── <id>-actions.txt       — every CDP/IPC command + output for that scenario
├── <id>-pre.json          — git state before actions
├── <id>-pre-ui.json       — UI snapshot (badges, modals, alerts) before actions
├── <id>-post.json         — git state after actions
├── <id>-post-ui.json      — UI snapshot after actions
└── screenshots/
    ├── 1B-lost-work-modal.png       — delete-with-lost-work modal
    ├── 2A-context-menu.png          — branch right-click menu
    ├── 2A-promote-confirm-modal.png — promote-confirm modal with diff summary
    └── 3G-failure-modal-cost-cap.png — resolver failure modal showing (cost_cap)
```

## Five partials — root cause summary

| ID | Cause | Fix path |
|---|---|---|
| 1A, 1D, 1E | Catalog fixtures F1, F3, F4 create dex/* branches with no unique step-commits → no badge rendered. Verified via direct IPC instead. | Either patch fixtures to add a unique step-commit, or update implementation to render every dex/* branch regardless of canonical ownership. |
| 3C, 4H | User cancel mid-resolution: documented v1 limit — `runOneShot` doesn't see the abort signal and completes its in-flight turn before the renderer's `abortResolverMerge` lands. | Out of v1 scope. Future enhancement: thread `AbortSignal` through `runOneShot` per the README's "known limitations" entry. |

## Test cost

US3 + US4 ran the live Claude resolver ~13 times against `claude-sonnet-4-6`. Approximate API cost: **~$0.80–$1.50** total based on `cost: 0.0xx` lines logged in `electron.log` per iteration.

## Did NOT touch

- No commits or pushes against the `dex` repo itself.
- No modifications outside `dex-ecommerce/` or `dex/test-results/`.
- The `dex-ecommerce` repo finished in clean state on `main` (verifiable via `cd dex-ecommerce && git status`).
