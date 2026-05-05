/**
 * What: Typed wrapper over window.dexAPI.checkpoints.* — listTimeline, jumpTo, deleteBranch, mergeToMain, promoteSummary, syncStateFromHead, initRepo, setIdentity, plus typed CheckpointError.
 * Not: Does not cache, retry, or transform results — methods are 1:1 with IPC. Does not subscribe to events; that's orchestratorService.
 * Deps: window.dexAPI.checkpoints, error-codes.md vocabulary, core/checkpoints types.
 */
import type {
  TimelineSnapshot,
  JumpToResult,
  DeleteBranchResult,
  MergeToMainResult,
  PromoteSummary,
} from "../../core/checkpoints.js";

export type CheckpointErrorCode =
  | "GIT_DIRTY"
  | "INVALID_TAG"
  | "TAG_NOT_FOUND"
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
  if (/invalid.*tag|tag.*invalid|does not match.*pattern/i.test(message)) {
    return new CheckpointError("INVALID_TAG", message);
  }
  if (/tag.*not found|checkpoint.*not found/i.test(message)) {
    return new CheckpointError("TAG_NOT_FOUND", message);
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

  deleteBranch(
    projectDir: string,
    branchName: string,
    opts?: { confirmedLoss?: boolean },
  ): Promise<DeleteBranchResult | { ok: false; error: "locked_by_other_instance" }> {
    return call(() =>
      window.dexAPI.checkpoints.deleteBranch(projectDir, branchName, opts),
    );
  },

  promoteSummary(projectDir: string, sourceBranch: string): Promise<PromoteSummary> {
    return call(() =>
      window.dexAPI.checkpoints.promoteSummary(projectDir, sourceBranch),
    );
  },

  mergeToMain(
    projectDir: string,
    sourceBranch: string,
    opts?: { force?: "save" | "discard" },
  ): Promise<MergeToMainResult | { ok: false; error: "locked_by_other_instance" }> {
    return call(() =>
      window.dexAPI.checkpoints.mergeToMain(projectDir, sourceBranch, opts),
    );
  },

  acceptResolverResult(
    projectDir: string,
  ): Promise<
    | { ok: true; mergeSha: string }
    | { ok: false; error: string }
    | { ok: false; error: "locked_by_other_instance" }
  > {
    return call(() => window.dexAPI.checkpoints.acceptResolverResult(projectDir));
  },

  abortResolverMerge(
    projectDir: string,
  ): Promise<
    | { ok: true }
    | { ok: false; error: string }
    | { ok: false; error: "locked_by_other_instance" }
  > {
    return call(() => window.dexAPI.checkpoints.abortResolverMerge(projectDir));
  },

  openInEditor(
    projectDir: string,
    files: string[],
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return call(() => window.dexAPI.checkpoints.openInEditor(projectDir, files));
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
};
