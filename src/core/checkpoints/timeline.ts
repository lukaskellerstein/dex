/**
 * What: listTimeline — single read-side aggregator that builds the TimelineSnapshot consumed by the renderer's TimelineGraph (checkpoints + pending candidates + commit graph + selectedPath).
 * Not: Does not modify git state; pure read. Does not own tag-naming (tags.ts) or jump semantics (jumpTo.ts). Mutating verbs live elsewhere.
 * Deps: _helpers (safeExec, RunLoggerLike), tags.ts (parseCheckpointTag, labelFor, checkpointTagFor), ../types.js (StepType).
 */

import { safeExec, type RunLoggerLike } from "./_helpers.js";
import { checkpointTagFor, labelFor, parseCheckpointTag } from "./tags.js";
import type { StepType } from "../types.js";

// ── Types ────────────────────────────────────────────────

export interface CheckpointInfo {
  tag: string;
  label: string;
  sha: string;
  step: StepType;
  cycleNumber: number;
  featureSlug: string | null;
  commitMessage: string;
  timestamp: string;
  unavailable?: boolean;
}

export interface PendingCandidate {
  checkpointTag: string;
  candidateSha: string;
  step: StepType;
  cycleNumber: number;
}

export interface StartingPoint {
  branch: string;
  sha: string;
  shortSha: string;
  subject: string;
  timestamp: string;
}

/**
 * One step-commit on the canvas — a commit whose subject matches
 * `[checkpoint:<step>:<cycle>]`. Mid-stage WIP commits are filtered out
 * upstream and never appear here.
 *
 * `branch` is the *canonical* home assigned by walking the first-parent
 * chain of each branch (in priority order: main → dex/* → selected-*).
 * The first branch whose first-parent walk reaches a SHA "owns" it.
 * This matches git semantics: merges trace history along --first-parent,
 * and the trunk gets to claim its own history.
 *
 * `containingBranches` lists every visible branch that contains the SHA
 * (informational — used for tooltips, not rendering). The layout draws
 * ONE dot per commit in its canonical lane only.
 *
 * `mergedParentShas` is non-empty when this commit is a merge — its second
 * (and beyond) parents. The layout draws a merge-back edge from each merged
 * parent's canonical-lane back to this commit.
 *
 * `promoteSourceTip` is set on `kind: "promote"` commits that are squash
 * commits (no second parent). The renderer draws a synthetic rejoin edge
 * from the source branch's tip into the squash commit so the dex/* lane
 * visually merges back into main, matching the `--no-ff` predecessor.
 */
export interface TimelineCommit {
  sha: string;
  shortSha: string;
  branch: string;
  containingBranches: string[];
  parentSha: string | null;
  mergedParentShas: string[];
  promoteSourceTip?: string;
  /**
   * Discriminator the renderer uses to differentiate dot styling and
   * interaction. Only `"step"` commits enter `selectedPath`, can be
   * jumped to as checkpoints, or feed `LoopDashboard.pathDerived`.
   *   `"step"`    — `dex: <step> completed [cycle:N]` (orchestrator step)
   *   `"promote"` — `dex: promoted <source> to (main|master)` (merge commit)
   *   `"user"`    — anything else (manual commits, PR merges, etc.)
   */
  kind: "step" | "promote" | "user";
  /**
   * For `kind: "step"`: the step name. For `kind: "promote"`: `"promote"`.
   * Undefined for `kind: "user"` — read `subject` for the label instead.
   */
  step?: StepType | "promote";
  /** -1 for `promote` and `user`. Step number for `step` kind. */
  cycleNumber: number;
  subject: string;
  timestamp: string;
  hasCheckpointTag: boolean;
}

/**
 * Canonical branch ownership priority — lower wins. Used to ORDER the
 * first-parent walks, so main's history is claimed first, then dex/*,
 * then selected-*. Each commit ends up canonical to the highest-priority
 * branch whose first-parent chain visits it.
 *
 * Unknown user branches (e.g. `feature/foo`) are treated as feature-branch-like.
 */
function canonicalPriority(branch: string): number {
  if (branch === "main" || branch === "master") return 0;
  if (branch.startsWith("dex/")) return 1;
  if (branch.startsWith("selected-")) return 3;
  return 1;
}

export interface TimelineSnapshot {
  checkpoints: CheckpointInfo[];
  /** Branch name HEAD is currently on (`git rev-parse --abbrev-ref HEAD`); empty string if detached or unavailable. */
  currentBranch: string;
  /**
   * Actual current HEAD SHA (`git rev-parse HEAD`). Distinct from
   * `selectedPath[last]` because HEAD may be a non-step commit (e.g. a
   * promote merge or a user commit) — in those cases selectedPath
   * doesn't include it. Empty string when detached or unavailable.
   */
  headSha: string;
  pending: PendingCandidate[];
  startingPoint: StartingPoint | null;
  /**
   * Every commit reachable from any tracked branch, sorted ascending by
   * timestamp. Includes step / promote / user commits; the renderer
   * differentiates via `TimelineCommit.kind` and may apply its own
   * display window (e.g. "show last 50, Load more for older").
   */
  commits: TimelineCommit[];
  /** Step-commit SHAs from the run's starting-point to current HEAD, oldest-first. */
  selectedPath: string[];
}

// ── Aggregator ───────────────────────────────────────────

export function listTimeline(projectDir: string, rlog?: RunLoggerLike): TimelineSnapshot {
  const checkpoints: CheckpointInfo[] = [];
  const pending: PendingCandidate[] = [];

  // Local closure threads `rlog` to every safeExec so silent git failures get
  // recorded in `electron.log` with the failed command + stderr instead of
  // disappearing without a trace.
  const sx = (cmd: string): string => safeExec(cmd, projectDir, rlog);

  // Current branch + HEAD SHA
  const currentBranch = sx(`git rev-parse --abbrev-ref HEAD`);

  // Checkpoints — tags
  const tagsRaw = sx(`git tag --list 'checkpoint/*'`);
  for (const tag of tagsRaw.split("\n").filter(Boolean)) {
    const parsed = parseCheckpointTag(tag);
    if (!parsed) continue;
    const sha = sx(`git rev-list -n 1 ${tag}`);
    if (!sha) {
      checkpoints.push({
        tag,
        label: `${tag} (unavailable)`,
        sha: "",
        step: parsed.step,
        cycleNumber: parsed.cycleNumber,
        featureSlug: null,
        commitMessage: "",
        timestamp: "",
        unavailable: true,
      });
      continue;
    }
    const message = sx(`git log -1 --format=%B ${tag}`);
    const when = sx(`git log -1 --format=%cI ${tag}`);
    const featureMatch = message.match(/\[feature:([\w-]+)\]/);
    const featureSlug = featureMatch && featureMatch[1] !== "-" ? featureMatch[1] : null;
    checkpoints.push({
      tag,
      label: labelFor(parsed.step, parsed.cycleNumber, featureSlug),
      sha,
      step: parsed.step,
      cycleNumber: parsed.cycleNumber,
      featureSlug,
      commitMessage: message,
      timestamp: when,
    });
  }

  // Pending candidates — commits with [checkpoint:<stage>:<cycle>] reachable from
  // HEAD that have no matching tag. Scoped to HEAD (not --all) so orphan commits
  // on stale dex/* branches from previous runs don't leak through.
  const existingTags = new Set(checkpoints.map((c) => c.tag));
  const candidateLog = sx(`git log HEAD --grep='^\\[checkpoint:' --format='%H%x09%s%x09%cI'`);
  for (const line of candidateLog.split("\n").filter(Boolean)) {
    const [sha, subject] = line.split("\t");
    // Subject format: "dex: <step> completed [cycle:N] [feature:x]"
    const m = subject?.match(/^dex: (\w+) completed \[cycle:(\d+)\]/);
    if (!m) continue;
    const step = m[1] as StepType;
    const cycleNumber = Number(m[2]);
    const tag = checkpointTagFor(step, cycleNumber);
    if (existingTags.has(tag)) continue;
    pending.push({ checkpointTag: tag, candidateSha: sha, step, cycleNumber });
  }

  // Starting point — pin to main / master tip so the trunk is always visible
  // on the canvas regardless of which branch HEAD is currently on. Falls back
  // to currentBranch + HEAD only when no main/master exists.
  let startingPoint: StartingPoint | null = null;
  const headSha = sx(`git rev-parse HEAD`);
  for (const trunk of ["main", "master"]) {
    // Probe both — at most one exists. Bare safeExec (no rlog) so the
    // expected miss doesn't pollute the log on every refresh.
    const trunkSha = safeExec(`git rev-parse --verify ${trunk}`, projectDir);
    if (trunkSha) {
      startingPoint = {
        branch: trunk,
        sha: trunkSha,
        shortSha: trunkSha.slice(0, 7),
        subject: sx(`git log -1 --format=%s ${trunk}`),
        timestamp: sx(`git log -1 --format=%cI ${trunk}`),
      };
      break;
    }
  }
  if (!startingPoint && currentBranch && headSha) {
    startingPoint = {
      branch: currentBranch,
      sha: headSha,
      shortSha: headSha.slice(0, 7),
      subject: sx(`git log -1 --format=%s HEAD`),
      timestamp: sx(`git log -1 --format=%cI HEAD`),
    };
  }

  // Build commits[] — every step-commit reachable from any **session-relevant**
  // branch. Per spec FR-001, the canvas surfaces: `main`/`master`, the
  // currentBranch, selected-* navigation forks, and `dex/*` run branches.
  // Fixture/* and unrelated user branches are filtered out so the canvas
  // stays legible.
  const checkpointShaSet = new Set(checkpoints.map((c) => c.sha).filter((s) => Boolean(s)));

  // for-each-ref's --format does not expand `%x09`. Use a delimiter git refnames
  // cannot legally contain ('|' is forbidden by git's check-ref-format).
  const allBranchesRaw = sx(`git for-each-ref --format='%(refname:short)|%(committerdate:iso-strict)' refs/heads/`);
  const allBranches: Array<{ name: string; tipTime: string }> = [];
  for (const line of allBranchesRaw.split("\n").filter(Boolean)) {
    const [name, tipTime] = line.split("|");
    if (name) allBranches.push({ name, tipTime: tipTime ?? "" });
  }

  const visibleBranches = new Set<string>();
  // Always include the project's default trunk(s).
  for (const def of ["main", "master"]) {
    if (allBranches.some((b) => b.name === def)) visibleBranches.add(def);
  }
  // Always include the currently checked-out branch.
  if (currentBranch && allBranches.some((b) => b.name === currentBranch)) {
    visibleBranches.add(currentBranch);
  }
  // Always include all `selected-*` branches (010 click-to-jump forks).
  for (const b of allBranches) {
    if (b.name.startsWith("selected-")) {
      visibleBranches.add(b.name);
    }
  }
  // Include all `dex/*` run branches (each is a distinct autonomous run).
  // Old runs are pruned by `scripts/prune-example-branches.sh`, so this set
  // stays bounded in practice.
  for (const b of allBranches) {
    if (b.name.startsWith("dex/")) visibleBranches.add(b.name);
  }

  // Filter to session-relevant branches.
  const filtered = allBranches.filter((b) => visibleBranches.has(b.name));

  type CommitData = {
    sha: string;
    parentSha: string | null;
    mergedParentShas: string[];
    kind: "step" | "promote" | "user";
    step?: StepType | "promote";
    cycleNumber: number;
    subject: string;
    timestamp: string;
  };

  // Subject parser: classifies any commit subject into `step` / `promote`
  // / `user`. Step-commits get a parsed `step` + `cycleNumber`; promote
  // merges get `step: "promote"`, `cycleNumber: -1`; everything else is a
  // user commit with no step/cycle info.
  //
  // Special case: the orchestrator stamps the post-run `completion`
  // commit with `[cycle:N]` (the last-completed cycle) for audit
  // traceability, but it's a phase-level marker — not part of any
  // cycle's story. We flatten its cycleNumber to -1 so the layout
  // groups it under the "Run Complete" band instead of the last cycle.
  function classifySubject(
    subject: string,
  ): { kind: "step" | "promote" | "user"; step?: StepType | "promote"; cycleNumber: number } {
    const stepMatch = subject.match(/^dex: (\w+) completed \[cycle:(\d+)\]/);
    if (stepMatch) {
      const step = stepMatch[1] as StepType;
      const cycleNumber = step === "completion" ? -1 : Number(stepMatch[2]);
      return { kind: "step", step, cycleNumber };
    }
    if (/^dex: promoted \S+ to (main|master)$/.test(subject)) {
      return { kind: "promote", step: "promote", cycleNumber: -1 };
    }
    return { kind: "user", cycleNumber: -1 };
  }

  // ── Pass 1: Full reachability scan ─────────────────────
  // For each visible branch, walk every reachable commit (not just
  // first-parent). Records:
  //   • commitData[sha]   — parents, kind, step, cycle, subject, timestamp
  //   • containing[sha]   — every visible branch that reaches this SHA
  //
  // We include EVERY commit (step / promote / user) so the canvas can
  // surface the full history with dex commits visually differentiated.
  const containing = new Map<string, Set<string>>();
  const commitData = new Map<string, CommitData>();
  for (const { name: branch } of filtered) {
    // `--topo-order --reverse` inserts parents before children in our
    // commitData map. When two commits share the same committer-second
    // timestamp (common for back-to-back stage commits, e.g. learnings
    // and completion both fired in <1s), the later `commits.sort` is
    // stable and ties resolve to insertion order — guaranteeing the
    // child commit always renders below its parent.
    const logRaw = sx(`git log --topo-order --reverse ${branch} --format='%H%x09%P%x09%s%x09%cI'`);
    for (const line of logRaw.split("\n").filter(Boolean)) {
      const parts = line.split("\t");
      if (parts.length < 4) continue;
      const [sha, parents, subject, timestamp] = parts;
      const classified = classifySubject(subject);
      let set = containing.get(sha);
      if (!set) {
        set = new Set<string>();
        containing.set(sha, set);
      }
      set.add(branch);
      if (!commitData.has(sha)) {
        const parentList = parents.split(" ").filter(Boolean);
        commitData.set(sha, {
          sha,
          parentSha: parentList[0] ?? null,
          mergedParentShas: parentList.slice(1),
          kind: classified.kind,
          step: classified.step,
          cycleNumber: classified.cycleNumber,
          subject,
          timestamp,
        });
      }
    }
  }

  // ── Pass 2: Canonical branch assignment via first-parent walks ─
  // Walk each branch in priority order (main → dex/* → selected-*) along
  // its --first-parent chain. The first branch whose walk reaches a SHA
  // claims it as canonical. This matches git's own notion of branch
  // ownership: --first-parent on main shows the trunk's history (including
  // merge commits), and feature branches inherit commits unique to them.
  //
  // Net effect: main owns its setup commits and merge commits; dex/* owns
  // its run-specific commits; selected-* owns only commits unique to it
  // (typically zero — they're labels on existing commits).
  const priorityOrdered = [...filtered].sort((a, b) => {
    const pa = canonicalPriority(a.name);
    const pb = canonicalPriority(b.name);
    if (pa !== pb) return pa - pb;
    return a.name.localeCompare(b.name);
  });
  const canonicalOf = new Map<string, string>();
  for (const { name: branch } of priorityOrdered) {
    const walkRaw = sx(`git log --first-parent ${branch} --format='%H'`);
    for (const sha of walkRaw.split("\n").filter(Boolean)) {
      if (!commitData.has(sha)) continue; // not a step-commit
      if (canonicalOf.has(sha)) continue; // already claimed
      canonicalOf.set(sha, branch);
    }
  }

  // ── Pass 3: Recover deleted-branch lineage from promote merges ──
  // After mergeToMain promotes a `dex/<run>` branch and deletes it, the
  // run's exclusive step-commits (the ones reachable only via the merge's
  // second parent) have no canonical owner — Pass 2 walks --first-parent
  // and never sees them. Without this pass they'd be dropped from
  // commits[] entirely, costing the user the visual lineage that
  // motivated keeping the merge in the first place.
  //
  // For each promote merge in commitData, parse the source-branch name
  // out of its subject and walk `<secondParent> ^<firstParent>` to find
  // commits exclusive to the deleted branch. Each unclaimed commit
  // along that walk (step or user) gets canonical to the synthetic
  // source branch — the layout then renders the original fork-and-rejoin
  // shape with the source branch's name on the badge, even though the
  // underlying ref no longer exists.
  for (const data of commitData.values()) {
    if (data.kind !== "promote") continue;
    if (data.mergedParentShas.length === 0 || !data.parentSha) continue;
    const m = data.subject.match(/^dex: promoted (\S+) to (main|master)$/);
    if (!m) continue;
    const sourceBranch = m[1];
    if (sourceBranch === "main" || sourceBranch === "master") continue;
    for (const mergedParent of data.mergedParentShas) {
      const exclusiveRaw = sx(
        `git rev-list --first-parent ${mergedParent} ^${data.parentSha}`,
      );
      for (const orphanSha of exclusiveRaw.split("\n").filter(Boolean)) {
        if (!commitData.has(orphanSha)) continue;
        if (canonicalOf.has(orphanSha)) continue;
        canonicalOf.set(orphanSha, sourceBranch);
        // Surface the recovered branch in `containingBranches` too so the
        // tooltip reflects where the dot's lane name comes from.
        let set = containing.get(orphanSha);
        if (!set) {
          set = new Set<string>();
          containing.set(orphanSha, set);
        }
        set.add(sourceBranch);
      }
    }
  }

  // Build commits[]. `containingBranches` is informational; the layout
  // uses only `branch` (canonical) to place the dot.
  const commits: TimelineCommit[] = [];
  for (const [sha, branchSet] of containing) {
    const data = commitData.get(sha)!;
    const canonical = canonicalOf.get(sha);
    if (!canonical) continue; // unreachable from any visible branch
    const containingBranches = [...branchSet].sort((a, b) => {
      const pa = canonicalPriority(a);
      const pb = canonicalPriority(b);
      if (pa !== pb) return pa - pb;
      return a.localeCompare(b);
    });

    // Squash-promote rejoin: if this is a `kind: "promote"` commit with no
    // second parent (squash, not `--no-ff`), look up the source branch's
    // current tip so the layout can draw a synthetic merge-back edge from
    // the dex/* lane into the squash commit on main. The source branch is
    // intentionally retained post-squash (see _mergeHelpers.ts), so the ref
    // is normally still resolvable.
    let promoteSourceTip: string | undefined;
    if (data.kind === "promote" && data.mergedParentShas.length === 0) {
      const m = data.subject.match(/^dex: promoted (\S+) to (?:main|master)$/);
      if (m) {
        const sourceBranch = m[1];
        const tip = sx(`git rev-parse refs/heads/${sourceBranch}`);
        if (tip) promoteSourceTip = tip;
      }
    }

    commits.push({
      sha,
      shortSha: sha.slice(0, 7),
      branch: canonical,
      containingBranches,
      parentSha: data.parentSha,
      mergedParentShas: data.mergedParentShas,
      ...(promoteSourceTip ? { promoteSourceTip } : {}),
      kind: data.kind,
      step: data.step,
      cycleNumber: data.cycleNumber,
      subject: data.subject,
      timestamp: data.timestamp,
      hasCheckpointTag: checkpointShaSet.has(sha),
    });
  }
  commits.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // Build selectedPath — step-commits from the run's starting-point to HEAD,
  // oldest-first. Uses --first-parent to collapse merges.
  const selectedPath: string[] = [];
  if (headSha) {
    const pathLogRaw = sx(`git log --first-parent ${headSha} --format='%H%x09%s'`);
    const acc: string[] = [];
    for (const line of pathLogRaw.split("\n").filter(Boolean)) {
      const [sha, subject] = line.split("\t");
      if (subject && /^dex: (\w+) completed \[cycle:(\d+)\]/.test(subject)) {
        acc.push(sha);
      }
    }
    // git log returns newest-first; spec wants oldest-first.
    acc.reverse();
    selectedPath.push(...acc);
  }

  // Sort: checkpoints by timestamp ascending
  checkpoints.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return {
    checkpoints,
    currentBranch,
    headSha,
    pending,
    startingPoint,
    commits,
    selectedPath,
  };
}
