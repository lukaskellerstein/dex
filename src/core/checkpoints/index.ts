/**
 * What: Public surface for the checkpoints module — re-exports flat symbols (back-compat for existing call sites) plus the `checkpoints` namespace object that new code uses.
 * Not: Does not contain logic. Does not re-export internal _helpers.
 * Deps: every sibling file in this directory.
 */

// ── Sub-file re-exports ─────────────────────────────────

export {
  CHECKPOINT_MESSAGE_PREFIX,
  PATHS_BY_STEP,
  checkpointTagFor,
  selectedBranchName,
  labelFor,
  isParallelizable,
  parseCheckpointTag,
} from "./tags.js";

export { syncStateFromHead } from "./syncState.js";

export {
  jumpTo,
  type JumpToResult,
} from "./jumpTo.js";

export {
  deleteBranch,
  mergeToMain,
  computePromoteSummary,
  readPendingPromote,
  clearPendingPromote,
  type DeleteBranchOpts,
  type DeleteBranchResult,
  type LostStep,
  type MergeToMainOpts,
  type MergeToMainResult,
  type MergeToMainResolverDeps,
  type NonContentConflictKind,
  type PendingPromote,
  type PromoteSummary,
} from "./branchOps.js";

export {
  listTimeline,
  type CheckpointInfo,
  type PendingCandidate,
  type StartingPoint,
  type TimelineCommit,
  type TimelineSnapshot,
} from "./timeline.js";

export {
  commitCheckpoint,
  readPauseAfterStage,
} from "./commit.js";

export { ensureDexGitignore } from "./gitignore.js";

// ── Namespace object ────────────────────────────────────

import {
  checkpointTagFor,
  labelFor,
  isParallelizable,
  parseCheckpointTag,
} from "./tags.js";
import { syncStateFromHead } from "./syncState.js";
import { jumpTo } from "./jumpTo.js";
import { deleteBranch, mergeToMain, computePromoteSummary } from "./branchOps.js";
import { listTimeline } from "./timeline.js";
import { commitCheckpoint, readPauseAfterStage } from "./commit.js";

/**
 * Single-import surface for the checkpoint API. New code:
 *
 *   import { checkpoints } from "../checkpoints.js"
 *   checkpoints.commit(projectDir, stage, cycleNumber, feature)
 *   checkpoints.jumpTo(projectDir, sha)
 *
 * The flat exports above remain for call sites that haven't migrated.
 */
export const checkpoints = {
  // Commit lifecycle
  commit: commitCheckpoint,
  readPauseAfterStage,

  // Naming + classification
  tagFor: checkpointTagFor,
  labelFor,
  isParallelizable,
  parseTag: parseCheckpointTag,

  // State sync
  syncStateFromHead,

  // Jump-to (navigation)
  jumpTo,

  // Branch ops (014 — delete subsumes the legacy `unselect`)
  deleteBranch,
  mergeToMain,
  computePromoteSummary,

  // Timeline (read-side)
  listTimeline,
} as const;
