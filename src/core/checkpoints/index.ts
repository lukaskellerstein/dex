/**
 * What: Public surface for the checkpoints module — re-exports flat symbols (back-compat for existing call sites) plus the `checkpoints` namespace object that new code uses.
 * Not: Does not contain logic. Does not re-export internal _helpers.
 * Deps: every sibling file in this directory.
 */

// ── Sub-file re-exports ─────────────────────────────────

export {
  clearPendingPromote,
  computePromoteSummary,
  type DeleteBranchOpts,
  type DeleteBranchResult,
  deleteBranch,
  type LostStep,
  type MergeToMainOpts,
  type MergeToMainResolverDeps,
  type MergeToMainResult,
  mergeToMain,
  type NonContentConflictKind,
  type PendingPromote,
  type PromoteSummary,
  readPendingPromote,
} from "./branchOps.js";
export {
  commitCheckpoint,
  readPauseAfterStage,
} from "./commit.js";
export { ensureDexGitignore } from "./gitignore.js";
export {
  type JumpToResult,
  jumpTo,
} from "./jumpTo.js";
export { syncStateFromHead } from "./syncState.js";
export {
  CHECKPOINT_MESSAGE_PREFIX,
  checkpointTagFor,
  isParallelizable,
  labelFor,
  PATHS_BY_STEP,
  parseCheckpointTag,
  selectedBranchName,
} from "./tags.js";
export {
  type CheckpointInfo,
  listTimeline,
  type PendingCandidate,
  type StartingPoint,
  type TimelineCommit,
  type TimelineSnapshot,
} from "./timeline.js";

// ── Namespace object ────────────────────────────────────

import { computePromoteSummary, deleteBranch, mergeToMain } from "./branchOps.js";
import { commitCheckpoint, readPauseAfterStage } from "./commit.js";
import { jumpTo } from "./jumpTo.js";
import { syncStateFromHead } from "./syncState.js";
import { checkpointTagFor, isParallelizable, labelFor, parseCheckpointTag } from "./tags.js";
import { listTimeline } from "./timeline.js";

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
