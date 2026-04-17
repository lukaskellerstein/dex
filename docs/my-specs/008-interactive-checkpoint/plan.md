# 008 Interactive Checkpoint — Implementation Plan

Companion to `README.md` (product design). This is what the implementing agent consumes: file paths, function signatures, slice ordering, code sketches, verification matrix.

**Prerequisite**: `007-sqlite-removal` has shipped. This spec assumes `src/core/runs.ts` exists and `<projectDir>/.dex/runs/<runId>.json` is the audit trail.

**Dev-phase**: no backward compatibility. Legacy `fixture/*` branches on `dex-ecommerce` are deleted at the start of implementation, not migrated.

---

## S0 — Preparatory refactors (ship first as one PR)

Each change is small, independently reviewable, zero-feature-risk. Several quick wins are pulled into S0 so they're useful from day 1 even while the rest is in-flight.

### P1. Remove `branchName` from `DexState`

Runtime state, not history. Its presence forces cascading tree-rewrites at promote time. Remove it.

**Files**:
- `src/core/types.ts` — remove `branchName`.
- `src/core/state.ts:287-298` (`detectStaleState`) — replace `state.branchName === currentBranch` with `getCurrentBranch(projectDir) === expectedBranch`.
- `src/core/state.ts:435-654` (`reconcileState`) — `state.branchName` reads → `getCurrentBranch()`.
- `src/core/orchestrator.ts:1213-1232` — drop `branchName` from `updateState`.
- First-load schema: strip `branchName` if present; no migration warning.

### P2. Rename `DexState.checkpoint` → `DexState.lastCommit`

"Checkpoint" is now the user-facing tag-backed domain term. The old `{sha, timestamp}` field just tracks the last `commitCheckpoint` return — rename clarifies.

Files: `src/core/types.ts`; grep `\.checkpoint\.` in `src/core/` and `src/main/` and rename call sites.

### P3. Stop committing `.dex/state.json`; gitignore it

With P1, state.json has no history-relevant fields. `commitCheckpoint` commits `feature-manifest.json` only.

**Files**:
- `src/core/git.ts:53` — `git add .dex/feature-manifest.json` (drop `state.json`).
- `src/core/git.ts:45-51` — delete the "agent committed state.json" warning (dead code).
- On project init (new repo): append `.dex/state.json`, `.dex/variant-groups/`, `.dex/worktrees/` to `.gitignore`. For existing repos with a committed state.json, `git rm --cached .dex/state.json` silently once.

### P4. `pauseReason` field + `status: "paused"` variants

Useful for every debug session between now and step mode landing. One field, no behavior change.

**`src/core/types.ts`**:
```ts
export type PauseReason = "user_abort" | "step_mode" | "budget" | "failure";
```

**`src/core/state.ts`**: add `pauseReason?: PauseReason` to `DexState`.

**`src/core/orchestrator.ts`**: every call site that writes `status: "paused"` also writes the corresponding `pauseReason`. User-abort path → `"user_abort"`. Budget-cap path → `"budget"`. Uncaught-error pause path → `"failure"`. Step mode (lands in S4) → `"step_mode"`.

### P5. Structured commit messages in `commitCheckpoint`

Makes `git log --all --grep='^\[checkpoint:'` a zero-UI terminal workflow from day 1.

**`src/core/git.ts:32-60`** (`commitCheckpoint`): extend the commit message to:

```
dex: <stage> completed [cycle:<N>] [feature:<slug>] [cost:$X.XX]
[checkpoint:<stage>:<cycle>]
```

Second line is the machine-parseable anchor. Shared constant exported as `CHECKPOINT_MESSAGE_PREFIX = "[checkpoint:"` so any parser (UI candidate detection, CLI scripts) imports the same string.

### P6. Empty-commit support in `commitCheckpoint`

Verify stages often produce no changes. Currently the catch block swallows the "nothing to commit" error, so `getHeadSha()` returns the previous SHA → fixtures for distinct stages collide on the same commit.

**`src/core/git.ts:53-58`**: replace the `git commit` line with:

```ts
exec(`git commit --allow-empty -m "${message}"`, projectDir);
```

Delete the try/catch that previously swallowed nothing-to-commit.

Every stage gets its own SHA. Graph shows every stage as its own node.

### P7. DEBUG badge additions

Zero UI work; useful for every debug session once any new state is introduced.

**`src/renderer/hooks/useDebugPayload.ts`** — add three lines to the clipboard payload:
```
CurrentAttemptBranch:  <git rev-parse --abbrev-ref HEAD>
LastCheckpointTag:     <derivable from listTimeline or null before S1>
CandidateSha:          <state.lastCommit.sha>
```

`LastCheckpointTag` is `null` until S1 lands; stub with `null` in S0.

### P8. Delete legacy `fixture/*` branches on `dex-ecommerce`

Dev phase. No migration path for branches that are intentionally force-moved.

One-time script, not part of app code:
```bash
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
git branch -D fixture/after-clarification fixture/after-tasks 2>/dev/null || true
```

Documented in `.claude/rules/06-testing.md` changes. Done once by the implementer; not re-run.

---

## S1 — Core module `src/core/checkpoints.ts`

Pure Node.js, no Electron imports, standalone-testable.

```ts
import type { LoopStageType } from "./types";
import { exec, getCurrentBranch, getHeadSha } from "./git";

// ── Naming ─────────────────────────────────────────

const slug = (s: string): string => s.replaceAll("_", "-");

export function checkpointTagFor(stage: LoopStageType, cycleNumber: number): string {
  if (cycleNumber === 0) return `checkpoint/after-${slug(stage)}`;
  return `checkpoint/cycle-${cycleNumber}-after-${slug(stage)}`;
}

// runId slice disambiguates multiple record-mode runs on the same day
export function checkpointDoneTag(runId: string): string {
  return `checkpoint/done-${runId.slice(0, 6)}`;
}

export function captureBranchName(runId: string, date = new Date()): string {
  return `capture/${date.toISOString().slice(0, 10)}-${runId.slice(0, 6)}`;
}

export function attemptBranchName(date = new Date(), variant?: string): string {
  const stamp = date.toISOString().replaceAll(/[:.]/g, "").slice(0, 15);
  return variant ? `attempt-${stamp}-${variant}` : `attempt-${stamp}`;
}

export function labelFor(stage: LoopStageType, cycleNumber: number, featureSlug?: string): string {
  const pretty: Record<LoopStageType, string> = {
    prerequisites: "prerequisites done",
    clarification: "clarifications done",
    clarification_product: "product questions answered",
    clarification_technical: "technical questions answered",
    clarification_synthesis: "requirements synthesized",
    constitution: "constitution drafted",
    manifest_extraction: "features identified",
    gap_analysis: "gap analysis done",
    specify: "spec written",
    plan: "plan written",
    tasks: "tasks generated",
    implement: "implementation done",
    implement_fix: "fixes applied",
    verify: "verification done",
    learnings: "learnings captured",
  };
  const label = pretty[stage] ?? stage;
  if (cycleNumber === 0) return label;
  const feature = featureSlug ? ` · ${featureSlug}` : "";
  return `cycle ${cycleNumber}${feature} · ${label}`;
}

// Stages that write only to specs/ and .dex/ (safe for parallel worktrees)
const PARALLELIZABLE_STAGES: LoopStageType[] = [
  "gap_analysis", "specify", "plan", "tasks", "learnings"
];
export function isParallelizable(stage: LoopStageType): boolean {
  return PARALLELIZABLE_STAGES.includes(stage);
}

// ── Promotion ─────────────────────────────────────

export function promoteToCheckpoint(
  projectDir: string,
  tag: string,
  candidateSha: string,
  rlog: RunLogger
): { ok: true } | { ok: false; error: string } {
  try {
    exec(`git rev-parse --verify ${candidateSha}`, projectDir);
    exec(`git tag -f ${tag} ${candidateSha}`, projectDir);
    rlog.run("INFO", `promoteToCheckpoint: ${tag} → ${candidateSha.slice(0, 7)}`);
    return { ok: true };
  } catch (err) {
    rlog.run("WARN", `promoteToCheckpoint failed for ${tag}: ${String(err)}`);
    return { ok: false, error: String(err) };
  }
}

// ── Go back ──────────────────────────────────────

export function startAttemptFrom(
  projectDir: string,
  checkpointTag: string,
  rlog: RunLogger,
  variant?: string
): { ok: true; branch: string } | { ok: false; error: string } {
  const branch = attemptBranchName(new Date(), variant);
  try {
    exec(`git rev-parse --verify refs/tags/${checkpointTag}`, projectDir);
    // Dirty-state check is the CALLER's responsibility (IPC modal).
    exec(`git checkout -B ${branch} ${checkpointTag}`, projectDir);
    // IMPORTANT: -fd not -fdx — respect .gitignore, preserve .env / build output / editor state.
    // -e .dex/state.lock stops us clobbering an in-flight orchestrator's lock.
    exec(`git clean -fd -e .dex/state.lock`, projectDir);
    return { ok: true, branch };
  } catch (err) {
    rlog.run("WARN", `startAttemptFrom failed: ${String(err)}`);
    return { ok: false, error: String(err) };
  }
}

// ── Dirty state ──────────────────────────────────

export function isWorkingTreeDirty(projectDir: string): { dirty: boolean; files: string[] } {
  // --porcelain lists tracked changes + untracked files NOT in .gitignore.
  const out = exec(`git status --porcelain`, projectDir).trim();
  if (!out) return { dirty: false, files: [] };
  return { dirty: true, files: out.split("\n").map((l) => l.slice(3)) };
}

// ── Variants ─────────────────────────────────────

export interface VariantSpawnRequest {
  fromCheckpoint: string;     // tag name
  variantLetters: string[];   // ["a", "b", "c"]
  stage: LoopStageType;       // determines parallel vs sequential
}

export interface VariantSpawnResult {
  groupId: string;
  branches: string[];
  worktrees: string[] | null; // non-null for parallel; null for sequential
  parallel: boolean;
}

export function spawnVariants(
  projectDir: string,
  request: VariantSpawnRequest,
  rlog: RunLogger
): { ok: true; result: VariantSpawnResult } | { ok: false; error: string } {
  const ts = new Date();
  const groupId = crypto.randomUUID();
  const branches: string[] = [];
  const worktrees: string[] = [];
  const parallel = isParallelizable(request.stage);

  try {
    for (const letter of request.variantLetters) {
      const branch = attemptBranchName(ts, letter);
      if (parallel) {
        const wtPath = `.dex/worktrees/${branch}`;
        // `worktree add` creates the branch AND checks it out in a new working dir.
        exec(`git worktree add -b ${branch} ${wtPath} ${request.fromCheckpoint}`, projectDir);
        branches.push(branch);
        worktrees.push(wtPath);
      } else {
        exec(`git branch ${branch} ${request.fromCheckpoint}`, projectDir);
        branches.push(branch);
      }
    }
    return {
      ok: true,
      result: {
        groupId,
        branches,
        worktrees: parallel ? worktrees : null,
        parallel,
      },
    };
  } catch (err) {
    // Rollback partial success
    for (const wt of worktrees) {
      try { exec(`git worktree remove --force ${wt}`, projectDir); } catch {}
    }
    for (const b of branches) {
      try { exec(`git branch -D ${b}`, projectDir); } catch {}
    }
    return { ok: false, error: String(err) };
  }
}

export function cleanupVariantWorktree(projectDir: string, worktreePath: string): void {
  try {
    exec(`git worktree remove --force ${worktreePath}`, projectDir);
  } catch {
    // Already removed or never existed — fine.
  }
}

// ── Listing ──────────────────────────────────────

export interface CheckpointInfo {
  tag: string;
  label: string;
  sha: string;
  stage: LoopStageType;
  cycleNumber: number;
  featureSlug: string | null;
  commitMessage: string;
  timestamp: string;
}

export interface AttemptInfo {
  branch: string;
  sha: string;
  isCurrent: boolean;
  baseCheckpoint: string | null;
  stepsAhead: number;
  timestamp: string;
  variantGroup: string | null;
}

export interface PendingCandidate {
  checkpointTag: string;
  candidateSha: string;
  stage: LoopStageType;
  cycleNumber: number;
}

export interface TimelineSnapshot {
  checkpoints: CheckpointInfo[];
  attempts: AttemptInfo[];
  currentAttempt: AttemptInfo | null;
  pending: PendingCandidate[];
  captureBranches: string[];  // zero or more capture/<date>-<runId>
}

export function listTimeline(projectDir: string): TimelineSnapshot { /* impl */ }
```

**Tests** (`src/core/__tests__/checkpoints.test.ts`, jest):

- Property-based round-trip: for every stage × cycles {0, 1, 7}, `labelFor` and `checkpointTagFor` produce distinct outputs.
- `promoteToCheckpoint` against a tmpdir: tag moves, idempotent re-promote, non-existent SHA returns `{ok: false}`.
- `startAttemptFrom` against a tmpdir: HEAD matches tag, `.env`-like untracked-ignored files preserved, stray untracked files cleaned.
- `spawnVariants` for parallel stage: N worktrees created; partial-failure rollback removes all.
- `spawnVariants` for sequential stage: N branches, no worktrees.
- `listTimeline` against seeded tmpdir.

---

## S2 — CLI `promote-checkpoint.sh` (dogfooding before UI)

Ships concurrently with S1 so power users can exercise the core primitive from the terminal.

`dex/scripts/promote-checkpoint.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
PROJECT="${1:?project dir required}"
NAME="${2:?checkpoint name required}"
case "$NAME" in checkpoint/*) ;; *) NAME="checkpoint/$NAME" ;; esac
SHA="${3:-HEAD}"
node "$(dirname "$0")/promote.mjs" "$PROJECT" "$NAME" "$SHA"
```

`dex/scripts/promote.mjs` (~15 lines):
```js
import { promoteToCheckpoint } from "../dist/core/checkpoints.js";
import { execFileSync } from "node:child_process";
const [projectDir, tag, sha] = process.argv.slice(2);
const sha_ = sha === "HEAD"
  ? execFileSync("git", ["-C", projectDir, "rev-parse", "HEAD"]).toString().trim()
  : sha;
const r = promoteToCheckpoint(projectDir, tag, sha_, { run: (...a) => console.log(...a) });
process.exit(r.ok ? 0 : 1);
```

**`dex/scripts/reset-example-to.sh`** — rewritten to resolve tags and create replay branches:

```bash
#!/usr/bin/env bash
set -euo pipefail
TARGET="/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce"
CHECKPOINT="${1:-clean}"
case "$CHECKPOINT" in
  list)  git -C "$TARGET" tag --list 'checkpoint/*' | sort; exit 0 ;;
  clean) git -C "$TARGET" reset --hard HEAD
         git -C "$TARGET" clean -fd
         git -C "$TARGET" checkout main
         exit 0 ;;
esac
case "$CHECKPOINT" in checkpoint/*) ;; *) CHECKPOINT="checkpoint/$CHECKPOINT" ;; esac
node "$(dirname "$0")/go-back.mjs" "$TARGET" "$CHECKPOINT"
```

No legacy-name translations. Old fixture branches already deleted in P8.

**`dex/scripts/prune-example-branches.sh`** extended: sweep `attempt-*` (30-day threshold). Protect `main`, `checkpoint/*` (tags immune anyway), `capture/*`, `lukas/*`.

---

## S3 — Orchestrator emits `stage_candidate` + writes phase fields

Wire the core module into the orchestrator. No UI yet; events flow to the existing stream, fields populate the runs JSON (from 007).

**`src/core/types.ts`** — new event + `stepMode` in `RunConfig`:

```ts
export interface RunConfig {
  /* existing */
  stepMode?: boolean;
}

export type OrchestratorEvent =
  /* existing */
  | { type: "stage_candidate"; runId: string; cycleNumber: number; stage: LoopStageType;
      checkpointTag: string; candidateSha: string; attemptBranch: string }
  | { type: "checkpoint_promoted"; runId: string; checkpointTag: string; sha: string };
```

**`src/core/orchestrator.ts:1213-1232`** — after `commitCheckpoint`:

```ts
const sha = commitCheckpoint(activeProjectDir, stageType, cycleNumber, specDir ?? null, totalCost);
await updateState(activeProjectDir, {
  lastCommit: { sha, timestamp: new Date().toISOString() },
});

const candidateTag = checkpointTagFor(stageType, cycleNumber);
const attemptBranch = getCurrentBranch(activeProjectDir);

// Update the phase record in runs JSON (from 007) with candidate info
completePhase(activeProjectDir, runId, phaseTraceId, {
  status: "completed",
  costUsd: totalCost,
  durationMs,
  candidateSha: sha,
  checkpointTag: candidateTag,
});

emit({
  type: "stage_candidate",
  runId,
  cycleNumber,
  stage: stageType,
  checkpointTag: candidateTag,
  candidateSha: sha,
  attemptBranch,
});

const recordMode = process.env.DEX_RECORD_MODE === "1"
  || (await readUiFlag(activeProjectDir, "recordMode"));
if (recordMode) {
  promoteToCheckpoint(activeProjectDir, candidateTag, sha, rlog);
  emit({ type: "checkpoint_promoted", runId, checkpointTag: candidateTag, sha });
}
```

On `loopTermination` with record mode:
```ts
if (recordMode && activeProjectDir) {
  const finalSha = getHeadSha(activeProjectDir);
  promoteToCheckpoint(activeProjectDir, checkpointDoneTag(runId), finalSha, rlog);
  exec(`git branch -f ${captureBranchName(runId)} HEAD`, activeProjectDir);
}
```

DEBUG badge (P7 stub) now populates `LastCheckpointTag` by reading `listTimeline(projectDir).pending[0]?.checkpointTag` or the most recent `checkpoint/*` tag.

---

## S4 — Step mode

Proper pause signal, distinct from abort.

**`src/core/orchestrator.ts`** — after emitting `stage_completed`:

```ts
if (config.stepMode) {
  await updateState(activeProjectDir, { status: "paused", pauseReason: "step_mode" });
  emit({ type: "paused", runId, reason: "step_mode", stage: stageType });
  return; // exit cycle body cleanly — no abort signal
}
```

User-abort path (unchanged): sets `pauseReason: "user_abort"`. Budget path: `"budget"`. Failure path: `"failure"`.

Resume logic (006-mid-cycle-resume) already picks up at the next stage after `lastCompletedStage` regardless of `pauseReason`.

---

## S5 — Checkpoint IPC

`src/main/ipc/checkpoints.ts`:

```ts
import { ipcMain } from "electron";
import { acquireStateLock } from "../../core/state";
import {
  listTimeline, promoteToCheckpoint, startAttemptFrom, spawnVariants,
  cleanupVariantWorktree, isWorkingTreeDirty,
} from "../../core/checkpoints";
import { listRuns } from "../../core/runs";

ipcMain.handle("checkpoints:listTimeline", async (_, projectDir) =>
  listTimeline(projectDir));

ipcMain.handle("checkpoints:promote", async (_, projectDir, tag, sha) => {
  const release = acquireStateLock(projectDir);
  if (!release) return { ok: false, error: "locked_by_other_instance" };
  try { return promoteToCheckpoint(projectDir, tag, sha, rlogFor(projectDir)); }
  finally { release(); }
});

ipcMain.handle("checkpoints:goBack", async (_, projectDir, tag, options) => {
  const release = acquireStateLock(projectDir);
  if (!release) return { ok: false, error: "locked_by_other_instance" };
  try {
    const dirty = isWorkingTreeDirty(projectDir);
    if (dirty.dirty && !options?.force) {
      return { ok: false, error: "dirty_working_tree", files: dirty.files };
    }
    if (dirty.dirty && options?.force === "save") {
      const savedBranch = `attempt-${Date.now()}-saved`;
      exec(`git checkout -B ${savedBranch}`, projectDir);
      exec(`git add -A`, projectDir);
      exec(`git commit -m "saved: uncommitted changes before go-back"`, projectDir);
    }
    return startAttemptFrom(projectDir, tag, rlogFor(projectDir));
  } finally { release(); }
});

ipcMain.handle("checkpoints:spawnVariants", async (_, projectDir, request) => {
  const release = acquireStateLock(projectDir);
  if (!release) return { ok: false, error: "locked_by_other_instance" };
  try { return spawnVariants(projectDir, request, rlogFor(projectDir)); }
  finally { release(); }
});

ipcMain.handle("checkpoints:deleteAttempt", async (_, projectDir, branch) => {
  const release = acquireStateLock(projectDir);
  if (!release) return { ok: false, error: "locked_by_other_instance" };
  try {
    const current = exec(`git rev-parse --abbrev-ref HEAD`, projectDir).trim();
    if (current === branch) return { ok: false, error: "cannot_delete_current" };
    exec(`git branch -D ${branch}`, projectDir);
    return { ok: true };
  } finally { release(); }
});

// Stage-aware diff — path filter depends on stage
ipcMain.handle("checkpoints:compareAttempts",
  async (_, projectDir, branchA, branchB, stage) => {
    const PATH_BY_STAGE: Partial<Record<LoopStageType, string[]>> = {
      gap_analysis:        [".dex/feature-manifest.json"],
      manifest_extraction: [".dex/feature-manifest.json"],
      specify:             ["specs/"],
      plan:                ["specs/"],
      tasks:               ["specs/"],
      learnings:           [".dex/learnings.md"],
      verify:              [".dex/verify-output/"],
    };
    const paths = PATH_BY_STAGE[stage];
    const diff = paths
      ? exec(`git diff ${branchA}..${branchB} -- ${paths.join(" ")}`, projectDir)
      : exec(`git diff --stat ${branchA}..${branchB}`, projectDir);
    return { diff };
  });

// Variant group persistence (resume-mid-variant support)
ipcMain.handle("checkpoints:writeVariantGroup", async (_, projectDir, group) => {
  const dir = path.join(projectDir, ".dex/variant-groups");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${group.groupId}.json`), JSON.stringify(group, null, 2));
});

ipcMain.handle("checkpoints:readPendingVariantGroups", async (_, projectDir) => {
  const dir = path.join(projectDir, ".dex/variant-groups");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))
    .filter((g) => g.variants.some((v) =>
      v.status === "pending" || v.status === "running"));
});

ipcMain.handle("checkpoints:cleanupVariantGroup", async (_, projectDir, groupId) => {
  const file = path.join(projectDir, ".dex/variant-groups", `${groupId}.json`);
  const group = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const v of group.variants) {
    if (v.worktree) cleanupVariantWorktree(projectDir, v.worktree);
  }
  fs.unlinkSync(file);
});

// Cost estimation — median + p75 of recent successful runs of this stage
ipcMain.handle("checkpoints:estimateVariantCost",
  async (_, projectDir, stage, variantCount) => {
    const runs = listRuns(projectDir, 20);
    const costs = runs
      .flatMap((r) => r.phases)
      .filter((p) => p.stage === stage && p.status === "completed")
      .map((p) => p.costUsd)
      .slice(0, 5)
      .sort((a, b) => a - b);
    if (costs.length === 0) return { perVariantMedian: null, perVariantP75: null };
    const median = costs[Math.floor(costs.length / 2)];
    const p75 = costs[Math.floor(costs.length * 0.75)];
    return {
      perVariantMedian: median,
      perVariantP75: p75,
      totalMedian: median * variantCount,
      totalP75: p75 * variantCount,
    };
  });

// Identity / repo bootstrap
ipcMain.handle("checkpoints:checkIdentity", async (_, projectDir) => { /* ... */ });
ipcMain.handle("checkpoints:setIdentity", async (_, projectDir, name, email) => { /* ... */ });
ipcMain.handle("checkpoints:checkIsRepo", async (_, projectDir) =>
  fs.existsSync(path.join(projectDir, ".git")));
ipcMain.handle("checkpoints:initRepo", async (_, projectDir) => { /* ... */ });

// UI prefs
ipcMain.handle("checkpoints:setRecordMode", async (_, projectDir, on) => {
  await updateState(projectDir, { ui: { recordMode: on } });
});
ipcMain.handle("checkpoints:setPauseAfterStage", async (_, projectDir, on) => {
  await updateState(projectDir, { ui: { pauseAfterStage: on } });
});
```

Preload exposes all under `window.dexAPI.checkpoints.*`.

---

## S6 — Lock extension across checkpoint IPC

Existing `.dex/state.lock` only guarded orchestrator start. Extend to wrap all checkpoint-mutating IPC (see handlers above — each one acquires `acquireStateLock`).

Refactor `acquireStateLock` in `src/core/state.ts` to support:
- PID + timestamp in the lockfile (existing).
- "Stale lock recovery" (existing).
- Read-only probe: `isLockedByAnother(projectDir): boolean` — for the second-window UI to render itself read-only without competing for the lock.

---

## S7 — First-run UX modals

- `InitRepoPrompt` — at project open, if `.git/` absent, offer `git init` + initial commit.
- `IdentityPrompt` — if `user.name` / `user.email` unset, prompt with OS defaults (`os.userInfo().username`, `${username}@${os.hostname()}`). Writes to local config only.
- `GoBackConfirm` — dirty-state modal with Save / Discard / Cancel before `checkpoints:goBack`. Receives `files[]` from `dirty_working_tree` error payload.

Hooks: `App.tsx` at project-open time calls `checkpoints:checkIsRepo` and `checkpoints:checkIdentity`. `GoBackConfirm` is shown by the Timeline panel's Go back handler when the IPC returns `dirty_working_tree`.

---

## S8 — Timeline panel with `@gitgraph/react`

Git-flow visualization is the v1. No stopgap; `@gitgraph/react` adapter is ~100 LOC.

**Library verification** — the implementer checks:
```bash
npm view @gitgraph/react
```
If last-publish > 18 months and GitHub issues show no maintainer response for recent PRs, fall back to `mermaid` gitGraph or a custom D3/SVG renderer. The data layer (`listTimeline`) is library-agnostic.

**Files**:

```
src/renderer/components/checkpoints/
├── TimelinePanel.tsx         container — TimelineGraph + NodeDetailPanel + PastAttemptsList
├── TimelineGraph.tsx         @gitgraph/react adapter (or fallback)
├── NodeDetailPanel.tsx       right-side panel: stage summary + action buttons
├── PastAttemptsList.tsx      collapsible searchable list below the graph
├── RecBadge.tsx              topbar REC indicator
├── GoBackConfirm.tsx
├── IdentityPrompt.tsx
├── InitRepoPrompt.tsx
└── hooks/
    ├── useTimeline.ts        calls listTimeline, polls on 30s + focus
    ├── useRecordMode.ts
    └── useDirtyCheck.ts
```

`TimelineGraph` adapter sketch:

```tsx
import { Gitgraph, templateExtend, TemplateName } from "@gitgraph/react";

export function TimelineGraph({ snapshot, onNodeClick }: Props) {
  const template = templateExtend(TemplateName.Metro, {
    colors: ["#89b4fa", "#cba6f7", "#a6e3a1"], // canonical, attempts, variants
    commit: { spacing: 60, dot: { size: 12 } },
    branch: { spacing: 40 },
  });

  return (
    <Gitgraph options={{ template, orientation: "horizontal" }}>
      {(gitgraph) => {
        const canonical = gitgraph.branch({ name: "canonical" });
        for (const cp of snapshot.checkpoints) {
          canonical.commit({
            subject: cp.label,
            // alternating cycle shade
            style: { dot: { color: cp.cycleNumber % 2 ? "#89b4fa" : "#74c7ec" } },
            onClick: () => onNodeClick({ type: "checkpoint", ref: cp.tag }),
          }).tag(cp.tag.replace("checkpoint/", ""));
        }
        for (const attempt of snapshot.attempts) {
          const branch = canonical.branch({ name: attempt.branch });
          branch.commit({
            subject: `${attempt.branch} (+${attempt.stepsAhead})`,
            onClick: () => onNodeClick({ type: "attempt", ref: attempt.branch }),
          });
        }
      }}
    </Gitgraph>
  );
}
```

Integration points:
- `LoopDashboard.tsx` mounts `TimelinePanel`. Adds Pause-after-stage toggle + Record toggle.
- `Topbar.tsx` mounts `RecBadge` when `ui.recordMode`.

---

## S9 — Candidate prompt + step flow UI

- `CandidatePrompt.tsx` — subscribes to `stage_candidate` events when step mode is on. Shows Keep / Try again / Try N ways buttons.
- Step button on the Loop Dashboard: runs with `stepMode: true`.
- Per-stage `StageSummary.tsx` renderers (one per stage type, using the summary data described in README).

---

## S10 — Variants (the headline)

Parallel execution + comparison + resume-mid-variant.

### Orchestrator driver

Add `runVariants` mode to orchestrator:

```ts
export async function runVariants(
  projectDir: string,
  fromCheckpoint: string,
  stage: LoopStageType,
  variantCount: number,
  parentRunId: string | null
): Promise<void> {
  const letters = ["a", "b", "c", "d", "e"].slice(0, variantCount);
  const { result } = await spawnVariants(projectDir, {
    fromCheckpoint, variantLetters: letters, stage
  }, rlogFor(projectDir));

  // Persist group for resume-mid-variant
  await writeVariantGroup(projectDir, {
    groupId: result.groupId,
    fromCheckpoint, stage,
    parallel: result.parallel,
    variants: result.branches.map((branch, i) => ({
      letter: letters[i],
      branch,
      worktree: result.worktrees?.[i] ?? null,
      status: "pending",
      runId: null,
    })),
  });

  if (result.parallel) {
    // Concurrent orchestrators, each in its own worktree
    await Promise.all(result.branches.map((branch, i) =>
      runSingleVariant(projectDir, result.worktrees![i], branch, stage,
                       result.groupId, parentRunId)
    ));
  } else {
    // Sequential on main working dir
    for (let i = 0; i < result.branches.length; i++) {
      const branch = result.branches[i];
      exec(`git checkout ${branch}`, projectDir);
      await runSingleVariant(projectDir, projectDir, branch, stage,
                             result.groupId, parentRunId);
    }
  }

  // All variants done — emit group_complete event; UI opens VariantCompareModal
  emit({ type: "variant_group_complete", groupId: result.groupId });
}
```

`runSingleVariant` creates a new runId + `runs/<runId>.json` (from 007), sets `parentRunId` and `variantGroupId`, runs one stage in step mode, updates the variant's status in the group file.

### Resume-mid-variant

Hook into existing resume machinery at `src/core/orchestrator.ts:1850-1945`.

At orchestrator startup (after state lock acquisition), check `.dex/variant-groups/`:

```ts
const pending = await readPendingVariantGroups(projectDir);
if (pending.length > 0) {
  // Emit event → UI shows "Continue variant group" modal.
  // On user confirm, resume:
  for (const group of pending) {
    for (const v of group.variants.filter((x) => x.status === "pending")) {
      await runSingleVariant(...);
    }
    for (const v of group.variants.filter((x) => x.status === "running")) {
      // Orchestrator died mid-run; restart from the variant's checkpoint
      await runSingleVariant(...);
    }
  }
  emit({ type: "variant_group_complete", groupId: group.groupId });
}
```

The resume flow has priority over new-run initiation — if a variant group is pending, block Start button until user resolves it.

### UI: VariantCompareModal

Opens on `variant_group_complete`. N panes side-by-side. Each pane:
- Stage summary (reuses `StageSummary.tsx`).
- Diff pane (calls `checkpoints:compareAttempts` with stage as parameter).
- Keep this button → `checkpoints:promote` on that variant's candidateSha.

On Keep: remaining variants' worktrees cleaned up via `checkpoints:cleanupVariantGroup`. Branches stay 30 days.

On Discard all: same cleanup path, no tag moved.

---

## S11 — `AttemptCompareModal` for manual comparisons

Click Compare button between any two Timeline entries; stage-aware diff (same IPC as variant comparison).

---

## S12 — Docs + GitHub Action

**Docs updates**:
- `.claude/rules/06-testing.md` § 4c — rewrite checkpoint table; document `git log --all --grep='^\[checkpoint:'` as power-user workflow.
- `docs/my-specs/005-testing-improvements/README.md` — superseded-by banner.
- `CLAUDE.md` — one-line mention of checkpoint IPC + Timeline panel.
- Root `README.md` — headline "Checkpoints" section.

**`.github/workflows/refresh-checkpoints.yml`**:

```yaml
name: refresh dex-ecommerce checkpoints
on:
  schedule: [{ cron: "0 6 * * 1" }]   # Mondays 06:00 UTC
  workflow_dispatch: {}
jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          repository: lukaskellerstein/dex-ecommerce
          token: ${{ secrets.FIXTURE_PAT }}
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: DEX_RECORD_MODE=1 npm run loop
      - run: |
          git push --tags --force origin 'refs/tags/checkpoint/*'
          git push --force origin 'refs/heads/capture/*'
```

---

## Slice ordering

Each slice independently shippable.

| Slice | Contents | Visible? |
|---|---|---|
| **S0** | P1–P8 prep (remove branchName, rename checkpoint→lastCommit, stop committing state.json, pauseReason, structured commit messages, empty commits, DEBUG badge stubs, delete legacy fixtures) | No |
| **S1** | `src/core/checkpoints.ts` + unit tests | No |
| **S2** | `promote-checkpoint.sh` CLI + `reset-example-to.sh` + extended `prune-example-branches.sh` | Terminal |
| **S3** | Orchestrator `stage_candidate` emit + populates phase fields in runs JSON + DEBUG badge fills `LastCheckpointTag` | Event stream |
| **S4** | Step mode (`stepMode` config + paused-with-reason emit) | Backend ready |
| **S5** | Checkpoint IPC handlers | API ready |
| **S6** | Lock extension across checkpoint IPC + read-only probe for second window | Safety |
| **S7** | First-run modals (InitRepo, Identity, GoBackConfirm) | First-run UX |
| **S8** | `TimelinePanel` with `@gitgraph/react` + `NodeDetailPanel` + `PastAttemptsList` + `RecBadge` + Record toggle | Primary UX |
| **S9** | `CandidatePrompt` + Step button + Pause-after-stage toggle + `StageSummary` per-stage renderers | Per-stage flow |
| **S10** | Variants: `runVariants` orchestrator mode, worktree parallelism for spec stages, `VariantCompareModal`, resume-mid-variant | Headline |
| **S11** | `AttemptCompareModal` (stage-aware diff reused from S5) | A/B |
| **S12** | Docs updates + GitHub Action for nightly record refresh | Infra |

S0–S3 ship without visible UI. S4–S7 prepare foundation. S8 delivers the graph. S9 delivers step mode. S10 is the standout capability. S11–S12 are finish work.

---

## Verification matrix

### S0 preparatory

- Typecheck passes after each of P1–P8.
- Existing resume flow works: `state.json` has no `branchName`, `detectStaleState` accepts the paused state anyway.
- `.dex/state.json` is gitignored; `git status` after a run shows it as untracked.
- `pauseReason` appears in every paused-state transition.
- `[checkpoint:<stage>:<cycle>]` marker visible in commit messages: `git log --all --grep='^\[checkpoint:'`.
- Empty-commit stage: a `verify` that touches no files yields a distinct SHA from the preceding `implement` commit.
- DEBUG badge shows `CurrentAttemptBranch` from the start.
- `fixture/*` branches absent from `dex-ecommerce`.

### S1 core module

- Naming round-trip property tests pass.
- `promoteToCheckpoint` idempotent re-promote.
- `startAttemptFrom`: HEAD on tag, `.env`-like ignored files preserved, stray untracked files cleaned.
- `spawnVariants` parallel: worktrees exist at expected paths; rollback on partial failure removes all.
- `spawnVariants` sequential: branches only.
- `isParallelizable`: true for spec stages, false for implement/implement_fix/verify.

### S2 CLI

- `promote-checkpoint.sh <dir> cycle-1-after-plan <sha>` → tag exists at that SHA.
- `reset-example-to.sh list` → sorted tag list.
- `reset-example-to.sh cycle-1-after-plan` → new `attempt-*` branch, HEAD matches tag.

### S3 candidate events + runs JSON

- Run a full loop. `run.log` shows `stage_candidate` entries.
- `.dex/runs/<runId>.json` phases have `checkpointTag` + `candidateSha` populated.

### S4 step mode

- Start run with `stepMode: true` — one-stage advance, emits `paused` with `reason: "step_mode"`, halts. Resume → next stage.
- User Stop during step run → `pauseReason: "user_abort"` (distinct).

### S5 + S6 IPC + lock

- Two windows on same project. First starts loop. Second clicks Go back → `locked_by_other_instance`. First finishes → second succeeds.
- Second window renders Timeline read-only while first holds lock.

### S7 first-run UX

- Remove `.git/` → `InitRepoPrompt` on open.
- Unset `user.email` → `IdentityPrompt` with OS defaults.
- Dirty file in attempt → Go back shows `GoBackConfirm`.

### S8 gitgraph timeline

- Horizontal graph with canonical / attempt / variant lanes in distinct colors.
- Click node → `NodeDetailPanel` opens with summary + actions.
- Alternating cycle shades visible at cycle boundaries.
- REC toggle shows badge in topbar.
- Graph refreshes on focus + stage_completed events.

### S9 candidate prompt

- Toggle pause-after-stage. Click Step → one-stage advance + CandidatePrompt with Keep / Try again / Try N ways.
- Keep this → tag moves, graph updates.
- Try again → archive current attempt, new attempt, re-run stage.

### S10 variants (the big one)

- Reset to `checkpoint/cycle-1-after-plan`. Click Try 3 ways.
- Cost estimate modal shows median/p75 from last 5 successful plan runs × 3.
- Parallel-stage variants (plan): 3 worktrees at `.dex/worktrees/attempt-…-{a,b,c}` exist. Concurrent orchestrators run. Wall time ≈ 1× stage duration (not 3×).
- Sequential-stage variants (implement): worktrees absent; branches only; run serially.
- `VariantCompareModal` shows 3 panes with summaries + stage-aware diffs.
- Keep this on B → tag moves to B's candidate SHA. A, C branches remain; worktrees removed.
- Discard all → all worktrees removed, branches kept, no tag moved.
- **Resume-mid-variant**: during variant A, close app. Reopen → "Continue variant group" modal. Confirm → B and C run to completion.

### S11 manual compare

- Two attempts. Click Compare → stage-aware diff.

### S12 infrastructure

- Docs updated. `06-testing.md` § 4f describes new layout.
- GitHub Action YAML passes lint.

### Integration — default flow (zero modals)

- Fresh `dex-ecommerce`. Reset to clean. Open project. Click Start. Zero unplanned modals.
- `git tag --list 'checkpoint/*'` shows ~15+ after first cycle.
- `.dex/runs/` has one JSON file.

---

## Opportunities shipped with the feature

- **Compare attempts** (S11) — stage-aware `git diff` via IPC.
- **Nightly GitHub Action** (S12) — 30 lines of YAML.
- **Machine-parseable audit trail** — `git log --all --grep='^\[checkpoint:'` from S0; documented in `06-testing.md`.

---

## Open questions for implementer

- **`@gitgraph/react` maintenance**: verify before committing. If stale, `mermaid` gitGraph is the recommended fallback.
- **Variant stage scope v2**: v1 fans out one stage. Multi-stage fan-out needs UX (when does the group close?).
- **Attempt retention**: 30-day prune threshold is a guess. Instrument attempt counts; revisit after first month.
- **Record-mode mid-run toggle**: enabling mid-run promotes from here forward, not retroactively. Document.
- **Graph performance at scale**: `@gitgraph/react` handles ~200 nodes smoothly. If users accumulate 50+ attempts, default-collapse older ones in the graph.
- **Reconciliation when state.json diverges from refs**: `reconcileState` needs an authoritative mode that fully rebuilds state.json from refs + filesystem. Details TBD in implementation.

---

## Estimated effort

**15–20 working days** for a single engineer across 12 slices.

This is larger than prior estimates to account for:
- Two subtle subsystems — worktree-based parallel variants, and resume-mid-variant coordination.
- Graph library evaluation + possible fallback implementation.
- Stage-aware diff infrastructure touching every variant comparison.
- Full first-run UX (identity, init-repo, dirty-tree modals).
- 10 explicit abstraction-leak scenarios, each verified.

Rough daily breakdown:

- Days 1–2: S0 preparatory refactors.
- Day 3: S1 core module + tests.
- Day 4: S2 CLI + reset script rewrite.
- Day 5: S3 orchestrator events + runs JSON wiring.
- Day 6: S4 step mode + S5 IPC handlers.
- Day 7: S6 locking + S7 first-run modals.
- Days 8–10: S8 gitgraph timeline + `NodeDetailPanel` + `PastAttemptsList` + `RecBadge`.
- Day 11: S9 candidate prompt + stage summaries.
- Days 12–15: S10 variants (worktree parallelism, compare modal, resume-mid-variant).
- Day 16: S11 manual compare.
- Day 17: S12 docs + GitHub Action.
- Days 18–20: verification matrix, buffer, polish.

No new npm deps beyond `@gitgraph/react` (or `mermaid` fallback). Removes `better-sqlite3` (from 007).
