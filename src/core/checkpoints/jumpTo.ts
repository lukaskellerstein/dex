/**
 * What: 010 click-to-jump core (jumpTo) plus its cleanup verb (unselect) and the auto-prune helper for transient `selected-<ts>` navigation forks.
 * Not: Does not list the timeline (that's timeline.ts).
 * Deps: _helpers (gitExec, safeExec, log), tags.ts (selectedBranchName), node:child_process (raw execSync for porcelain status).
 */

import { execSync } from "node:child_process";
import { gitExec, safeExec, log, type RunLoggerLike } from "./_helpers.js";
import { selectedBranchName } from "./tags.js";

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
 *  3. dirty tree, force=save  → autosave (one commit on the current branch); refuse on detached HEAD
 *  4. dirty tree, force=disc  → reset --hard + clean -fd (preserves gitignored)
 *  5. unresolvable target     → not_found
 *  6. unique branch tip       → git checkout <branch>
 *  7. otherwise               → git checkout -B selected-<ts> <target>
 *
 * Note on `selected-*` interaction with force=save: when HEAD is on a
 * `selected-*` branch, the autosave commits onto that `selected-*` (not
 * onto `dex/*`). After the subsequent jump, `maybePruneEmptySelected`
 * preserves it because the new commit means the branch isn't "empty"
 * relative to the target.
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
      // Refuse to autosave on detached HEAD — the commit would be unreachable
      // from any branch. The user is inspecting history; preserve their
      // changes in the worktree without committing them anywhere unexpected.
      try {
        execSync(`git symbolic-ref -q HEAD`, {
          cwd: projectDir,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        return {
          ok: false,
          error: "git_error",
          message:
            "Cannot save changes while in detached-HEAD state. Switch to a branch first.",
        };
      }
      try {
        gitExec(`git add -A`, projectDir);
        gitExec(`git commit -q -m "dex: pre-jump autosave"`, projectDir);
        log(rlog, "INFO", `jumpTo: pre-jump autosave committed on current branch`);
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
  //    at the target. Distinct from `dex/*` run branches so navigation forks
  //    aren't conflated with run history.
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
 * When force=save is used and HEAD was on a `selected-*` branch, the autosave
 * commit lands on that branch — making it non-empty relative to the new
 * target — so this prune correctly preserves it.
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
