/**
 * What: Typed wrapper over window.dexAPI.profiles.* — list, saveDexJson — plus typed ProfilesError.
 * Not: Does not own profile editor state — consumers manage that. Does not validate dex.json shape inline; relies on backend validators.
 * Deps: window.dexAPI.profiles, ProfileEntry/DexJsonShape from core/agent-profile.
 */
import type {
  ProfileEntry,
  DexJsonShape,
} from "../../core/agent-profile.js";

export type ProfilesErrorCode =
  | "WORKTREE_MISSING"
  | "PROFILE_INVALID"
  | "OVERLAY_FAILED"
  | "PROFILES_FAILURE";

export class ProfilesError extends Error {
  readonly code: ProfilesErrorCode;

  constructor(code: ProfilesErrorCode, message: string) {
    super(message);
    this.name = "ProfilesError";
    this.code = code;
  }
}

function mapToProfilesError(err: unknown): ProfilesError {
  if (err instanceof ProfilesError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (/worktree path does not exist|worktree.*missing/i.test(message)) {
    return new ProfilesError("WORKTREE_MISSING", message);
  }
  if (/profile.*invalid|invalid profile/i.test(message)) {
    return new ProfilesError("PROFILE_INVALID", message);
  }
  if (/overlay.*failed/i.test(message)) {
    return new ProfilesError("OVERLAY_FAILED", message);
  }
  return new ProfilesError("PROFILES_FAILURE", message);
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    throw mapToProfilesError(err);
  }
}

export const profilesService = {
  list(projectDir: string): Promise<ProfileEntry[]> {
    return call(() => window.dexAPI.profiles.list(projectDir));
  },

  saveDexJson(
    projectDir: string,
    name: string,
    dexJson: DexJsonShape,
  ): Promise<
    | { ok: true }
    | { ok: false; error: string }
    | { ok: false; error: "locked_by_other_instance" }
  > {
    return call(() =>
      window.dexAPI.profiles.saveDexJson(projectDir, name, dexJson),
    );
  },
};
