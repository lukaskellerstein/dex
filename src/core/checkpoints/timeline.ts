/**
 * What: listTimeline — single read-side aggregator that builds the TimelineSnapshot consumed by the renderer's TimelineGraph (checkpoints + attempts + pending candidates + capture branches + commit graph + selectedPath).
 * Not: Does not modify git state; pure read. Does not own tag-naming (tags.ts) or jump semantics (jumpTo.ts). Mutating verbs live elsewhere.
 * Deps: _helpers (safeExec), tags.ts (parseCheckpointTag, labelFor, checkpointTagFor), ../types.js (StepType).
 */

import { safeExec } from "./_helpers.js";
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
 */
export interface TimelineCommit {
  sha: string;
  shortSha: string;
  branch: string;
  parentSha: string | null;
  step: StepType;
  cycleNumber: number;
  subject: string;
  timestamp: string;
  hasCheckpointTag: boolean;
}

export interface TimelineSnapshot {
  checkpoints: CheckpointInfo[];
  attempts: AttemptInfo[];
  currentAttempt: AttemptInfo | null;
  pending: PendingCandidate[];
  captureBranches: string[];
  startingPoint: StartingPoint | null;
  /** Every step-commit reachable from any tracked branch, sorted ascending by timestamp. */
  commits: TimelineCommit[];
  /** Step-commit SHAs from the run's starting-point to current HEAD, oldest-first. */
  selectedPath: string[];
}

// ── Aggregator ───────────────────────────────────────────

export function listTimeline(projectDir: string): TimelineSnapshot {
  const checkpoints: CheckpointInfo[] = [];
  const attempts: AttemptInfo[] = [];
  const pending: PendingCandidate[] = [];
  const captureBranches: string[] = [];
  let currentAttempt: AttemptInfo | null = null;

  // Current branch + HEAD SHA
  const currentBranch = safeExec(`git rev-parse --abbrev-ref HEAD`, projectDir);

  // Checkpoints — tags
  const tagsRaw = safeExec(`git tag --list 'checkpoint/*'`, projectDir);
  for (const tag of tagsRaw.split("\n").filter(Boolean)) {
    // Skip checkpoint/done-* tags — they aren't stage checkpoints
    if (tag.startsWith("checkpoint/done-")) {
      // Treat done tags as pseudo-checkpoint entries with sentinel values
      const sha = safeExec(`git rev-list -n 1 ${tag}`, projectDir);
      const message = safeExec(`git log -1 --format=%B ${tag}`, projectDir);
      const when = safeExec(`git log -1 --format=%cI ${tag}`, projectDir);
      checkpoints.push({
        tag,
        label: "run completed",
        sha,
        step: "learnings",
        cycleNumber: -1,
        featureSlug: null,
        commitMessage: message,
        timestamp: when,
      });
      continue;
    }
    const parsed = parseCheckpointTag(tag);
    if (!parsed) continue;
    const sha = safeExec(`git rev-list -n 1 ${tag}`, projectDir);
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
    const message = safeExec(`git log -1 --format=%B ${tag}`, projectDir);
    const when = safeExec(`git log -1 --format=%cI ${tag}`, projectDir);
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

  // Attempts — attempt-* branches
  const branchesRaw = safeExec(`git branch --list 'attempt-*' --format='%(refname:short)'`, projectDir);
  for (const branch of branchesRaw.split("\n").filter(Boolean)) {
    const sha = safeExec(`git rev-parse ${branch}`, projectDir);
    const when = safeExec(`git log -1 --format=%cI ${branch}`, projectDir);
    const variantMatch = branch.match(/-(?<letter>[a-e])$/);
    const variantGroup = variantMatch ? (variantMatch.groups?.letter ?? null) : null;

    // Find nearest ancestor checkpoint
    let baseCheckpoint: string | null = null;
    try {
      const nearest = safeExec(`git describe --tags --match 'checkpoint/*' --abbrev=0 ${sha}`, projectDir);
      baseCheckpoint = nearest || null;
    } catch {
      baseCheckpoint = null;
    }

    let stepsAhead = 0;
    if (baseCheckpoint) {
      try {
        const count = safeExec(`git rev-list --count ${baseCheckpoint}..${branch}`, projectDir);
        stepsAhead = parseInt(count, 10) || 0;
      } catch {
        stepsAhead = 0;
      }
    }

    const info: AttemptInfo = {
      branch,
      sha,
      isCurrent: branch === currentBranch,
      baseCheckpoint,
      stepsAhead,
      timestamp: when,
      variantGroup,
    };
    attempts.push(info);
    if (info.isCurrent) currentAttempt = info;
  }

  // Capture branches
  const captureRaw = safeExec(`git branch --list 'capture/*' --format='%(refname:short)'`, projectDir);
  for (const b of captureRaw.split("\n").filter(Boolean)) {
    captureBranches.push(b);
  }

  // Pending candidates — commits with [checkpoint:<stage>:<cycle>] reachable from
  // HEAD that have no matching tag. Scoped to HEAD (not --all) so orphan commits
  // on stale dex/* or attempt-* branches from previous runs don't leak through.
  const existingTags = new Set(checkpoints.map((c) => c.tag));
  const candidateLog = safeExec(
    `git log HEAD --grep='^\\[checkpoint:' --format='%H%x09%s%x09%cI'`,
    projectDir
  );
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
  const headSha = safeExec(`git rev-parse HEAD`, projectDir);
  for (const trunk of ["main", "master"]) {
    const trunkSha = safeExec(`git rev-parse --verify ${trunk}`, projectDir);
    if (trunkSha) {
      startingPoint = {
        branch: trunk,
        sha: trunkSha,
        shortSha: trunkSha.slice(0, 7),
        subject: safeExec(`git log -1 --format=%s ${trunk}`, projectDir),
        timestamp: safeExec(`git log -1 --format=%cI ${trunk}`, projectDir),
      };
      break;
    }
  }
  if (!startingPoint && currentBranch && headSha) {
    startingPoint = {
      branch: currentBranch,
      sha: headSha,
      shortSha: headSha.slice(0, 7),
      subject: safeExec(`git log -1 --format=%s HEAD`, projectDir),
      timestamp: safeExec(`git log -1 --format=%cI HEAD`, projectDir),
    };
  }

  // Build commits[] — every step-commit reachable from any **session-relevant**
  // branch. Per spec FR-001, the canvas surfaces: `main`/`master`, the
  // currentBranch, attempt-* branches, and the latest `dex/*` run branch.
  // Stale dex/* runs from prior sessions, fixture/*, capture/*, and unrelated
  // user branches are filtered out so the canvas stays legible.
  const commits: TimelineCommit[] = [];
  const seenCommitShas = new Set<string>();
  const checkpointShaSet = new Set(checkpoints.map((c) => c.sha).filter((s) => Boolean(s)));

  // for-each-ref's --format does not expand `%x09`. Use a delimiter git refnames
  // cannot legally contain ('|' is forbidden by git's check-ref-format).
  const allBranchesRaw = safeExec(
    `git for-each-ref --format='%(refname:short)|%(committerdate:iso-strict)' refs/heads/`,
    projectDir,
  );
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
  // Always include all `attempt-*` branches (008 Try Again / Go back, and
  // variant slots `attempt-<ts>-{a,b,c}`) and `selected-*` branches (010
  // click-to-jump forks).
  for (const b of allBranches) {
    if (b.name.startsWith("attempt-") || b.name.startsWith("selected-")) {
      visibleBranches.add(b.name);
    }
  }
  // Include all `dex/*` run branches (each is a distinct autonomous run).
  // Old runs are pruned by `scripts/prune-example-branches.sh`, so this set
  // stays bounded in practice.
  for (const b of allBranches) {
    if (b.name.startsWith("dex/")) visibleBranches.add(b.name);
  }

  // Iterate filtered branches in stable order: trunk first (so anchor + main
  // commits land in the leftmost lane), then by tip time descending.
  const filtered = allBranches
    .filter((b) => visibleBranches.has(b.name))
    .sort((a, b) => {
      const score = (n: string) =>
        n === "main" || n === "master" ? 0 : n === currentBranch ? 1 : 2;
      const sa = score(a.name);
      const sb = score(b.name);
      if (sa !== sb) return sa - sb;
      return b.tipTime.localeCompare(a.tipTime);
    });

  for (const { name: branch } of filtered) {
    const logRaw = safeExec(
      `git log ${branch} --reverse --format='%H%x09%P%x09%s%x09%cI'`,
      projectDir,
    );
    for (const line of logRaw.split("\n").filter(Boolean)) {
      const parts = line.split("\t");
      if (parts.length < 4) continue;
      const [sha, parents, subject, timestamp] = parts;
      const m = subject.match(/^dex: (\w+) completed \[cycle:(\d+)\]/);
      if (!m) continue;
      if (seenCommitShas.has(sha)) continue;
      seenCommitShas.add(sha);
      const firstParent = parents.split(" ").filter(Boolean)[0] ?? null;
      commits.push({
        sha,
        shortSha: sha.slice(0, 7),
        branch,
        parentSha: firstParent,
        step: m[1] as StepType,
        cycleNumber: Number(m[2]),
        subject,
        timestamp,
        hasCheckpointTag: checkpointShaSet.has(sha),
      });
    }
  }
  commits.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // Build selectedPath — step-commits from the run's starting-point to HEAD,
  // oldest-first. Uses --first-parent to collapse merges.
  const selectedPath: string[] = [];
  if (headSha) {
    const pathLogRaw = safeExec(
      `git log --first-parent ${headSha} --format='%H%x09%s'`,
      projectDir,
    );
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

  // Sort: checkpoints by timestamp ascending, attempts by timestamp descending
  checkpoints.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  attempts.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return {
    checkpoints,
    attempts,
    currentAttempt,
    pending,
    captureBranches,
    startingPoint,
    commits,
    selectedPath,
  };
}
