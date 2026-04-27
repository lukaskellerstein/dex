/**
 * What: Typed wrapper over window.dexAPI.checkpoints.* — listTimeline, jumpTo, promote, unmark, spawnVariants, etc., plus typed CheckpointError.
 * Not: Does not cache, retry, or transform results — methods are 1:1 with IPC. Does not subscribe to events; that's orchestratorService.
 * Deps: window.dexAPI.checkpoints, error-codes.md vocabulary, core/checkpoints types.
 */
import type {
  TimelineSnapshot,
  VariantGroupFile,
  VariantSpawnRequest,
  VariantSpawnResult,
  JumpToResult,
} from "../../core/checkpoints.js";
import type { StepType } from "../../core/types.js";

export type CheckpointErrorCode =
  | "GIT_DIRTY"
  | "WORKTREE_LOCKED"
  | "INVALID_TAG"
  | "TAG_NOT_FOUND"
  | "VARIANT_GROUP_MISSING"
  | "BUSY"
  | "GIT_FAILURE";

export class CheckpointError extends Error {
  readonly code: CheckpointErrorCode;

  constructor(code: CheckpointErrorCode, message: string) {
    super(message);
    this.name = "CheckpointError";
    this.code = code;
  }
}

function mapToCheckpointError(err: unknown): CheckpointError {
  if (err instanceof CheckpointError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (/locked_by_other_instance|already in flight|busy/i.test(message)) {
    return new CheckpointError("BUSY", message);
  }
  if (/working tree.*uncommitted|uncommitted changes|git_dirty/i.test(message)) {
    return new CheckpointError("GIT_DIRTY", message);
  }
  if (/worktree.*lock/i.test(message)) {
    return new CheckpointError("WORKTREE_LOCKED", message);
  }
  if (/invalid.*tag|tag.*invalid|does not match.*pattern/i.test(message)) {
    return new CheckpointError("INVALID_TAG", message);
  }
  if (/tag.*not found|checkpoint.*not found/i.test(message)) {
    return new CheckpointError("TAG_NOT_FOUND", message);
  }
  if (/variant[- ]?group.*missing|variant.*not found/i.test(message)) {
    return new CheckpointError("VARIANT_GROUP_MISSING", message);
  }
  return new CheckpointError("GIT_FAILURE", message);
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    throw mapToCheckpointError(err);
  }
}

export const checkpointService = {
  listTimeline(projectDir: string): Promise<TimelineSnapshot> {
    return call(() => window.dexAPI.checkpoints.listTimeline(projectDir));
  },

  checkIsRepo(projectDir: string): Promise<boolean> {
    return call(() => window.dexAPI.checkpoints.checkIsRepo(projectDir));
  },

  checkIdentity(projectDir: string): Promise<{
    name: string | null;
    email: string | null;
    suggestedName: string;
    suggestedEmail: string;
  }> {
    return call(() => window.dexAPI.checkpoints.checkIdentity(projectDir));
  },

  estimateVariantCost(
    projectDir: string,
    step: StepType,
    variantCount: number,
  ): Promise<{
    perVariantMedian: number | null;
    perVariantP75: number | null;
    totalMedian: number | null;
    totalP75: number | null;
    sampleSize: number;
  }> {
    return call(() =>
      window.dexAPI.checkpoints.estimateVariantCost(projectDir, step, variantCount),
    );
  },

  readPendingVariantGroups(projectDir: string): Promise<VariantGroupFile[]> {
    return call(() => window.dexAPI.checkpoints.readPendingVariantGroups(projectDir));
  },

  promote(
    projectDir: string,
    tag: string,
    sha: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return call(() => window.dexAPI.checkpoints.promote(projectDir, tag, sha));
  },

  unmark(
    projectDir: string,
    sha: string,
  ): Promise<
    | { ok: true; deleted: string[] }
    | { ok: false; error: string }
    | { ok: false; error: "locked_by_other_instance" }
  > {
    return call(() => window.dexAPI.checkpoints.unmark(projectDir, sha));
  },

  unselect(
    projectDir: string,
    branchName: string,
  ): Promise<
    | { ok: true; switchedTo: string | null; deleted: string }
    | { ok: false; error: string }
    | { ok: false; error: "locked_by_other_instance" }
  > {
    return call(() => window.dexAPI.checkpoints.unselect(projectDir, branchName));
  },

  syncStateFromHead(projectDir: string): Promise<
    | { ok: true; updated: boolean; step?: string; cycle?: number }
    | { ok: false; error: string }
    | { ok: false; error: "locked_by_other_instance" }
  > {
    return call(() => window.dexAPI.checkpoints.syncStateFromHead(projectDir));
  },

  jumpTo(
    projectDir: string,
    targetSha: string,
    options?: { force?: "save" | "discard" },
  ): Promise<JumpToResult | { ok: false; error: "locked_by_other_instance" }> {
    return call(() =>
      window.dexAPI.checkpoints.jumpTo(projectDir, targetSha, options),
    );
  },

  spawnVariants(
    projectDir: string,
    request: VariantSpawnRequest,
  ): Promise<
    | { ok: true; result: VariantSpawnResult }
    | { ok: false; error: string }
  > {
    return call(() => window.dexAPI.checkpoints.spawnVariants(projectDir, request));
  },

  cleanupVariantGroup(
    projectDir: string,
    groupId: string,
    kind: "keep" | "discard",
    pickedLetter?: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return call(() =>
      window.dexAPI.checkpoints.cleanupVariantGroup(projectDir, groupId, kind, pickedLetter),
    );
  },

  initRepo(
    projectDir: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return call(() => window.dexAPI.checkpoints.initRepo(projectDir));
  },

  setIdentity(
    projectDir: string,
    name: string,
    email: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return call(() => window.dexAPI.checkpoints.setIdentity(projectDir, name, email));
  },

  compareAttempts(
    projectDir: string,
    branchA: string,
    branchB: string,
    step: StepType | null,
  ): Promise<
    | { ok: true; diff: string; mode: "path-filtered" | "stat"; paths?: string[] }
    | { ok: false; error: string }
  > {
    return call(() =>
      window.dexAPI.checkpoints.compareAttempts(projectDir, branchA, branchB, step),
    );
  },
};
