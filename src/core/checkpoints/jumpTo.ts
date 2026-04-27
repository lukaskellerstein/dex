/**
 * What: 010 click-to-jump core (jumpTo) plus its cleanup verbs (unselect, unmarkCheckpoint) and the auto-prune helper for transient `selected-<ts>` navigation forks.
 * Not: Does not promote (that's recordMode.ts), does not spawn variants (that's variants.ts), does not list the timeline (that's timeline.ts).
 * Deps: _helpers (gitExec, safeExec, log), tags.ts (attemptBranchName, selectedBranchName, parseCheckpointTag), node:child_process (raw execSync for porcelain status).
 */

import { execSync } from "node:child_process";
import { gitExec, safeExec, log, type RunLoggerLike } from "./_helpers.js";
import { attemptBranchName, parseCheckpointTag, selectedBranchName } from "./tags.js";

// ── Unselect (010 — drop a `selected-*` navigation fork) ──────

/**
 * Drop a `selected-<ts>` navigation fork. If HEAD is currently on it, switch
 * first to the most "natural" parent branch — main / master, then any `dex/*`
 * containing the SHA, then any other non-`selected-*` branch — and only then
 * delete it. Refuses to act on non-`selected-*` branches.
 */
export function unselect(
  projectDir: string,
  branchName: string,
  rlog?: RunLoggerLike,
): { ok: true; switchedTo: string | null; deleted: string } | { ok: false; error: string } {
  if (!branchName.startsWith("selected-")) {
    return { ok: false, error: "only selected-* branches can be unselected" };
  }
  let switchedTo: string | null = null;
  try {
    const current = gitExec(`git rev-parse --abbrev-ref HEAD`, projectDir);
    if (current === branchName) {
      // HEAD is on this branch; switch to a natural parent before deleting.
      const sha = gitExec(`git rev-parse HEAD`, projectDir);
      const containingRaw = safeExec(
        `git for-each-ref --contains ${sha} --format='%(refname:short)' refs/heads/`,
        projectDir,
      );
      const containing = containingRaw
        .split("\n")
        .filter((b) => Boolean(b) && b !== branchName && !b.startsWith("selected-"));
      const preferred =
        containing.find((b) => b === "main" || b === "master") ??
        containing.find((b) => b.startsWith("dex/")) ??
        containing[0];
      if (!preferred) {
        return { ok: false, error: "no parent branch contains this commit" };
      }
      gitExec(`git checkout -q ${preferred}`, projectDir);
      switchedTo = preferred;
    }
    gitExec(`git branch -D ${branchName}`, projectDir);
    log(rlog, "INFO", `unselect: deleted ${branchName}${switchedTo ? ` (switched to ${switchedTo})` : ""}`);
    return { ok: true, switchedTo, deleted: branchName };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ── Unmark kept (010 right-click verb) ───────────────────

/**
 * Delete every canonical step-commit checkpoint tag (matching the
 * `checkpoint/[cycle-N-]after-<step>` shape) that points at `sha`. System
 * tags like `checkpoint/done-*` are left alone — those mark whole-run
 * lifecycle, not individual stages.
 */
export function unmarkCheckpoint(
  projectDir: string,
  sha: string,
  rlog?: RunLoggerLike,
): { ok: true; deleted: string[] } | { ok: false; error: string } {
  try {
    const tagsRaw = gitExec(`git tag --points-at ${sha}`, projectDir);
    const tags = tagsRaw.split("\n").filter(Boolean);
    const canonical = tags.filter((t) => parseCheckpointTag(t) !== null);
    const deleted: string[] = [];
    for (const tag of canonical) {
      try {
        gitExec(`git tag -d ${tag}`, projectDir);
        deleted.push(tag);
      } catch (err) {
        log(rlog, "WARN", `unmarkCheckpoint: failed to delete ${tag}: ${String(err)}`);
      }
    }
    log(rlog, "INFO", `unmarkCheckpoint: ${sha.slice(0, 7)} deleted=${deleted.length}`);
    return { ok: true, deleted };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ── Jump-to (010) ────────────────────────────────────────

export type JumpToResult =
  | { ok: true; action: "noop" }
  | { ok: true; action: "checkout"; branch: string }
  | { ok: true; action: "fork"; branch: string }
  | { ok: false; error: "dirty_working_tree"; files: string[] }
  | { ok: false; error: "not_found"; message: string }
  | { ok: false; error: "git_error"; message: string };

/**
 * Click-to-jump core for the 010 Timeline canvas.
 *
 * Decision tree (matches contracts/ipc-checkpoints-jumpTo.md):
 *  1. target == HEAD          → noop
 *  2. dirty tree, no force    → dirty_working_tree
 *  3. dirty tree, force=save  → save dirty change on attempt-<ts>-saved branch
 *  4. dirty tree, force=disc  → reset --hard + clean -fd (preserves gitignored)
 *  5. unresolvable target     → not_found
 *  6. unique branch tip       → git checkout <branch>
 *  7. otherwise               → git checkout -B attempt-<ts> <target>
 */
export function jumpTo(
  projectDir: string,
  targetSha: string,
  options?: { force?: "save" | "discard" },
  rlog?: RunLoggerLike,
): JumpToResult {
  // 1. HEAD no-op
  let head: string;
  try {
    head = gitExec(`git rev-parse HEAD`, projectDir);
  } catch (err) {
    return { ok: false, error: "git_error", message: String(err) };
  }
  if (targetSha === head) {
    return { ok: true, action: "noop" };
  }

  // 5. Resolve target SHA before doing anything destructive.
  let resolved: string;
  try {
    resolved = gitExec(`git rev-parse --verify ${targetSha}^{commit}`, projectDir);
  } catch (err) {
    return { ok: false, error: "not_found", message: String(err) };
  }
  if (resolved === head) {
    // Resolved to HEAD via abbreviated SHA / ref. Treat as noop.
    return { ok: true, action: "noop" };
  }

  // 2-4. Dirty-tree handling. Per spec FR-011, only **tracked** file
  // modifications block a jump — untracked noise (e.g. Dex's own runtime
  // `.dex/state.lock` PID file) must not be confused for unsaved work.
  // Use raw execSync (not gitExec/trim) — porcelain status leads with a space
  // for unstaged modifications; trimming would corrupt the slice(3) parse below.
  let dirtyTracked: { dirty: boolean; files: string[] };
  try {
    const out = execSync(`git status --porcelain --untracked-files=no`, {
      cwd: projectDir,
      encoding: "utf-8",
    });
    const lines = out.split("\n").filter((l) => l.length > 0);
    dirtyTracked = { dirty: lines.length > 0, files: lines.map((l) => l.slice(3)) };
  } catch (err) {
    return { ok: false, error: "git_error", message: String(err) };
  }
  if (dirtyTracked.dirty) {
    if (!options?.force) {
      return { ok: false, error: "dirty_working_tree", files: dirtyTracked.files };
    }
    if (options.force === "save") {
      const saveBranch = attemptBranchName(new Date()) + "-saved";
      try {
        gitExec(`git checkout -B ${saveBranch}`, projectDir);
        gitExec(`git add -A`, projectDir);
        gitExec(`git commit -q -m "dex: dirty-tree autosave before jumpTo"`, projectDir);
        // Return to whatever branch we came from before forking. We don't know the
        // original ref, so instead just continue from the saved branch — the next
        // step will move HEAD anyway and the dirty change is preserved on saveBranch.
        log(rlog, "INFO", `jumpTo: saved dirty tree on ${saveBranch}`);
      } catch (err) {
        return { ok: false, error: "git_error", message: String(err) };
      }
    } else if (options.force === "discard") {
      try {
        gitExec(`git reset --hard HEAD`, projectDir);
        // Same -fd hygiene as startAttemptFrom — preserve gitignored files.
        gitExec(`git clean -fd -e .dex/state.lock`, projectDir);
      } catch (err) {
        return { ok: false, error: "git_error", message: String(err) };
      }
    }
  }

  // Capture the branch we were on so we can auto-prune it (if empty + transient)
  // after HEAD moves. Click-by-click navigation should NOT leave a trail of
  // empty selected-<ts> branches behind.
  const previousBranch = safeExec(`git rev-parse --abbrev-ref HEAD`, projectDir);

  // 6. Unique branch tip → checkout that branch.
  let tipsRaw: string;
  try {
    tipsRaw = gitExec(
      `git for-each-ref --points-at ${resolved} --format='%(refname:short)' refs/heads/`,
      projectDir,
    );
  } catch (err) {
    return { ok: false, error: "git_error", message: String(err) };
  }
  const tips = tipsRaw.split("\n").filter(Boolean);
  if (tips.length === 1) {
    try {
      gitExec(`git checkout -q ${tips[0]}`, projectDir);
      log(rlog, "INFO", `jumpTo: checkout ${tips[0]} @ ${resolved.slice(0, 7)}`);
      maybePruneEmptySelected(projectDir, previousBranch, tips[0], rlog);
      return { ok: true, action: "checkout", branch: tips[0] };
    } catch (err) {
      return { ok: false, error: "git_error", message: String(err) };
    }
  }

  // 7. Mid-branch ancestor or tip-of-multiple → fork a `selected-<ts>` branch
  //    at the target. Distinct from 008's `attempt-<ts>` (Try Again / Go back)
  //    so navigation forks don't get conflated with intentional retries.
  const branch = selectedBranchName(new Date());
  try {
    gitExec(`git checkout -B ${branch} ${resolved}`, projectDir);
    log(rlog, "INFO", `jumpTo: fork ${branch} @ ${resolved.slice(0, 7)}`);
    maybePruneEmptySelected(projectDir, previousBranch, branch, rlog);
    return { ok: true, action: "fork", branch };
  } catch (err) {
    return { ok: false, error: "git_error", message: String(err) };
  }
}

/**
 * If the previously-checked-out branch is a transient `selected-<ts>` (010
 * click-to-jump fork) with no commits the new branch doesn't already have,
 * delete it. Click-by-click navigation thus doesn't leave dead branches.
 *
 * 008 `attempt-*` branches (Try Again / Go back / variants) are NOT pruned —
 * those carry intentional user retry intent.
 */
function maybePruneEmptySelected(
  projectDir: string,
  previousBranch: string,
  newBranch: string,
  rlog: RunLoggerLike | undefined,
): void {
  if (!previousBranch) return;
  if (previousBranch === newBranch) return;
  if (!previousBranch.startsWith("selected-")) return;

  const reachable = safeExec(
    `git log ${previousBranch} --format=%H ^${newBranch}`,
    projectDir,
  )
    .split("\n")
    .filter(Boolean);
  if (reachable.length > 0) return; // has commits the new branch doesn't — keep

  try {
    gitExec(`git branch -D ${previousBranch}`, projectDir);
    log(rlog, "INFO", `jumpTo: auto-pruned empty ${previousBranch}`);
  } catch {
    // Best-effort cleanup — never fail the jump for this.
  }
}
