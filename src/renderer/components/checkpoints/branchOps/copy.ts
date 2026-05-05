/**
 * Single source of truth for every user-visible string in the branch-management
 * surface (014). Keeping the strings here means we can grep-test the
 * "no version-control jargon in user copy" rule (spec FR-028) — the only
 * legacy-jargon strings in the repo's user-visible code paths live in this
 * file with explicit `// allowed:` annotations.
 */

// ── Delete a saved version ────────────────────────────────────────

export const DELETE_TOOLTIP = "Remove this version";

export const LOST_WORK_TITLE = "These steps will be lost";
export const LOST_WORK_BODY =
  "This version contains steps that exist nowhere else. If you remove it, those steps disappear from the timeline.";
export const LOST_WORK_REMOVE = "Remove";
export const LOST_WORK_CANCEL = "Cancel";

export const DELETE_MID_RUN =
  "This version is currently being built — pause the run first.";

export const DELETE_NO_PRIMARY =
  "Cannot remove this version because the project has no primary version to fall back to.";

export const DELETE_FAILED = (detail: string): string =>
  `Couldn't remove this version: ${detail}`;

// ── Promote a saved version to main ───────────────────────────────

export const PROMOTE_MENU_ITEM = "Make this the new main";
export const PROMOTE_MENU_DISABLED_TOOLTIP =
  "This version can't be made the new main.";

export const PROMOTE_CONFIRM_TITLE = "Replace main with this version?";
export const PROMOTE_CONFIRM_BODY =
  "The current main will be replaced by this version's work. The old main stays in your history.";
export const PROMOTE_CONFIRM_VIEW_ALL = "View all changes";
export const PROMOTE_CONFIRM_CONFIRM = "Make this the new main";
export const PROMOTE_CONFIRM_CANCEL = "Cancel";

export const PROMOTE_MID_RUN_BRANCH =
  "This version is currently being built — pause the run first.";
export const PROMOTE_MID_RUN_MAIN =
  "Main is currently being built — pause the run first.";

export const PROMOTE_NON_CONTENT_CONFLICT =
  "This version has a kind of conflict AI can't resolve yet. The merge has been undone. Edit the files manually and try again."; // allowed: spec-mandated copy retains the word "merge" — see FR-028 allowlist note in spec.md and source design doc voice-and-copy table

export const POST_MERGE_TOAST = (sourceBranch: string): string =>
  `${sourceBranch} is now main. The old version has been removed.`;

export const PROMOTE_FAILED = (detail: string): string =>
  `Couldn't make this version the new main: ${detail}`;

// ── Diff summary helpers (used by the promote-confirm modal) ───────

export const PROMOTE_SUMMARY_FILES = (n: number): string =>
  `${n} ${n === 1 ? "file" : "files"} changed`;
export const PROMOTE_SUMMARY_PLUS_MINUS = (added: number, removed: number): string =>
  `+${added} -${removed}`;

// ── Conflict resolver progress (US3 — placeholder; full set lands in 014/US3) ─

export const RESOLVER_PROGRESS_TITLE =
  "Two versions disagree on the same lines. Resolving with AI…";
export const RESOLVER_PROGRESS_ITERATION = (n: number, total: number): string =>
  `Resolving disagreement #${n} of ${total}…`;

// ── Conflict resolver outcomes (US3/US4 — placeholders for later wiring) ─────

export const RESOLVER_SUCCESS_TOAST = (n: number): string =>
  `AI resolved ${n} ${n === 1 ? "disagreement" : "disagreements"}. The new main is ready.`;
export const RESOLVER_FAILURE_TITLE = "AI couldn't fully resolve the disagreement";
export const ACCEPT_AI_RESULT = "Accept what AI did";
export const ROLLBACK_MERGE = "Roll back the merge entirely"; // allowed: spec-mandated failure-modal label retains "merge" — see FR-028 allowlist note
export const OPEN_IN_EDITOR = "Open in editor";

// ── Generic ───────────────────────────────────────────────────────

export const MERGE_IN_PROGRESS = "Combining your changes with main…";
