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
  checkpointDoneTag,
  captureBranchName,
  attemptBranchName,
  selectedBranchName,
  labelFor,
  isParallelizable,
  parseCheckpointTag,
} from "./tags.js";

export {
  promoteToCheckpoint,
  readRecordMode,
  autoPromoteIfRecordMode,
  syncStateFromHead,
} from "./recordMode.js";

export {
  jumpTo,
  unselect,
  unmarkCheckpoint,
  type JumpToResult,
} from "./jumpTo.js";

export {
  spawnVariants,
  cleanupVariantWorktree,
  type VariantSpawnRequest,
  type VariantSpawnResult,
} from "./variants.js";

export {
  listTimeline,
  type CheckpointInfo,
  type AttemptInfo,
  type PendingCandidate,
  type StartingPoint,
  type TimelineCommit,
  type TimelineSnapshot,
} from "./timeline.js";

export {
  writeVariantGroupFile,
  readVariantGroupFile,
  deleteVariantGroupFile,
  readPendingVariantGroups,
  type VariantGroupFile,
} from "./variantGroups.js";

export {
  commitCheckpoint,
  readPauseAfterStage,
} from "./commit.js";

// ── Namespace object ────────────────────────────────────

import {
  checkpointTagFor,
  checkpointDoneTag,
  captureBranchName,
  attemptBranchName,
  labelFor,
  isParallelizable,
  parseCheckpointTag,
} from "./tags.js";
import {
  promoteToCheckpoint,
  readRecordMode,
  autoPromoteIfRecordMode,
  syncStateFromHead,
} from "./recordMode.js";
import {
  jumpTo,
  unselect,
  unmarkCheckpoint,
} from "./jumpTo.js";
import {
  spawnVariants,
  cleanupVariantWorktree,
} from "./variants.js";
import { listTimeline } from "./timeline.js";
import {
  writeVariantGroupFile,
  readVariantGroupFile,
  deleteVariantGroupFile,
  readPendingVariantGroups,
} from "./variantGroups.js";
import { commitCheckpoint, readPauseAfterStage } from "./commit.js";

/**
 * Single-import surface for the checkpoint API. New code:
 *
 *   import { checkpoints } from "../checkpoints.js"
 *   checkpoints.commit(projectDir, stage, cycleNumber, feature)
 *   checkpoints.promote(projectDir, tag, sha)
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
  doneTag: checkpointDoneTag,
  captureBranchName,
  attemptBranchName,
  labelFor,
  isParallelizable,
  parseTag: parseCheckpointTag,

  // Promotion + record mode
  promote: promoteToCheckpoint,
  readRecordMode,
  autoPromoteIfRecordMode,
  syncStateFromHead,

  // Jump-to + cleanup
  jumpTo,
  unselect,
  unmark: unmarkCheckpoint,

  // Variants
  spawnVariants,
  cleanupVariantWorktree,

  // Timeline (read-side)
  listTimeline,

  // Variant-group state IO
  readVariantGroupFile,
  writeVariantGroupFile,
  deleteVariantGroupFile,
  readPendingVariantGroups,
} as const;
