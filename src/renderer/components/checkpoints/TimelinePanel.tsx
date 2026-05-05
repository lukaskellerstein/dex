import { useCallback, useEffect, useState } from "react";
import { useTimeline } from "./hooks/useTimeline";
import { GoBackConfirm } from "./GoBackConfirm";
import { TimelineGraph } from "./TimelineGraph";
import { DeleteBranchConfirm } from "./DeleteBranchConfirm";
import { BranchContextMenu } from "./BranchContextMenu";
import { PromoteConfirm } from "./PromoteConfirm";
import { ConflictResolverProgress } from "./ConflictResolverProgress";
import { ResolverFailureModal } from "./ResolverFailureModal";
import { checkpointService } from "../../services/checkpointService.js";
import { orchestratorService } from "../../services/orchestratorService.js";
import {
  DELETE_FAILED,
  DELETE_MID_RUN,
  DELETE_NO_PRIMARY,
  POST_MERGE_TOAST,
  PROMOTE_FAILED,
  PROMOTE_MID_RUN_BRANCH,
  PROMOTE_MID_RUN_MAIN,
  PROMOTE_NON_CONTENT_CONFLICT,
  RESOLVER_SUCCESS_TOAST,
  RESOLVER_FAILURE_TITLE,
} from "./branchOps/copy";
import type { LostStep, PromoteSummary } from "../../../core/checkpoints.js";

interface Props {
  projectDir: string;
  /** Disabled: no git repo / no identity. */
  disabled?: boolean;
  disabledReason?: string;
}

interface DirtyEnvelope {
  /** SHA the user originally wanted to jump to. The save/discard retry uses it. */
  targetSha: string;
  files: string[];
}

interface DeleteConfirmEnvelope {
  branchName: string;
  lostSteps: LostStep[];
}

interface ContextMenuEnvelope {
  branchName: string;
  x: number;
  y: number;
  enabled: boolean;
}

interface PromoteConfirmEnvelope {
  branchName: string;
  summary: PromoteSummary;
}

interface PromoteDirtyEnvelope {
  branchName: string;
  files: string[];
}

interface ResolverFailureEnvelope {
  branchName: string;
  reason: string;
  failedFiles: string[];
}

function isDexOwnedBranch(branch: string): boolean {
  return branch.startsWith("dex/") || branch.startsWith("selected-");
}

/**
 * 010 — full-width Timeline canvas. Single-click on a node calls jumpTo.
 * No side detail panel, no bottom past-attempts list.
 */
export function TimelinePanel({
  projectDir,
  disabled,
  disabledReason,
}: Props) {
  const { snapshot, refresh } = useTimeline(projectDir);
  const [dirty, setDirty] = useState<DirtyEnvelope | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmEnvelope | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuEnvelope | null>(null);
  const [promoteConfirm, setPromoteConfirm] = useState<PromoteConfirmEnvelope | null>(null);
  const [promoteDirty, setPromoteDirty] = useState<PromoteDirtyEnvelope | null>(null);
  const [resolverActive, setResolverActive] = useState(false);
  const [resolverFailure, setResolverFailure] = useState<ResolverFailureEnvelope | null>(null);
  // Track which files the resolver flagged as failing so the failure modal
  // can surface them and pass them to "Open in editor".
  const [resolverFailedFiles, setResolverFailedFiles] = useState<string[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focusedBranch, setFocusedBranch] = useState<string | null>(null);

  // Open the resolver progress modal as soon as the first conflict-resolver
  // event arrives during a mergeToMain call. Closes itself when the terminal
  // `done` event lands (the modal forwards the outcome via onDone). Also
  // accumulate the failed-file list so the failure modal can surface it.
  useEffect(() => {
    const off = orchestratorService.subscribeEvents((evt) => {
      const t = (evt as { type?: string }).type;
      if (t === "conflict-resolver:file-start") {
        setResolverActive(true);
        setResolverFailedFiles([]);
      } else if (t === "conflict-resolver:file-done") {
        const e = evt as { file: string; ok: boolean };
        if (!e.ok) setResolverFailedFiles((prev) => [...prev, e.file]);
      }
    });
    return off;
  }, []);

  const handleBranchFocus = useCallback((branch: string) => {
    setFocusedBranch((prev) => (prev === branch ? null : branch));
  }, []);

  const performJump = useCallback(
    async (targetSha: string, force?: "save" | "discard") => {
      setError(null);
      const r = await checkpointService.jumpTo(
        projectDir,
        targetSha,
        force ? { force } : undefined,
      );
      if (r.ok) {
        if (r.action !== "noop") {
          await refresh();
        }
        return true;
      }
      if (r.error === "dirty_working_tree") {
        setDirty({ targetSha, files: (r as { files: string[] }).files });
        return false;
      }
      if (r.error === "locked_by_other_instance") {
        setError("Another Dex instance holds the project lock — try again in a moment.");
        return false;
      }
      const detail =
        "message" in r && typeof (r as { message?: string }).message === "string"
          ? (r as { message: string }).message
          : r.error;
      setError(`Jump failed: ${detail}`);
      return false;
    },
    [projectDir, refresh],
  );

  const handleJump = useCallback((sha: string) => performJump(sha), [performJump]);

  const performDelete = useCallback(
    async (branchName: string, confirmedLoss?: boolean) => {
      setError(null);
      const r = await checkpointService.deleteBranch(
        projectDir,
        branchName,
        confirmedLoss ? { confirmedLoss: true } : undefined,
      );
      if (!("ok" in r)) {
        setError(DELETE_FAILED("unknown error"));
        return;
      }
      if (r.ok) {
        await refresh();
        return;
      }
      switch (r.error) {
        case "would_lose_work":
          setDeleteConfirm({ branchName, lostSteps: r.lostSteps });
          return;
        case "branch_in_active_run":
          setError(DELETE_MID_RUN);
          return;
        case "no_primary_to_switch_to":
          setError(DELETE_NO_PRIMARY);
          return;
        case "locked_by_other_instance":
          setError("Another Dex instance holds the project lock — try again in a moment.");
          return;
        case "git_error":
          setError(DELETE_FAILED(r.message));
          return;
        case "is_protected":
        case "not_dex_owned":
          // Defense-in-depth — UI should not have offered the control.
          setError(DELETE_FAILED(`"${r.branch}" cannot be removed`));
          return;
      }
    },
    [projectDir, refresh],
  );

  const handleDeleteBranch = useCallback(
    (branchName: string) => performDelete(branchName),
    [performDelete],
  );

  // ── Promote flow (014/US2) ─────────────────────────────────

  const handleBranchContextMenu = useCallback(
    (branchName: string, x: number, y: number) => {
      setContextMenu({
        branchName,
        x,
        y,
        enabled: isDexOwnedBranch(branchName),
      });
    },
    [],
  );

  const performMerge = useCallback(
    async (branchName: string, force?: "save" | "discard") => {
      setError(null);
      const r = await checkpointService.mergeToMain(
        projectDir,
        branchName,
        force ? { force } : undefined,
      );
      // The resolver modal is event-driven; whatever its outcome, by the time
      // the IPC promise resolves we should hide it before reacting.
      setResolverActive(false);
      if (!("ok" in r)) {
        setError(PROMOTE_FAILED("unknown error"));
        return;
      }
      if (r.ok) {
        await refresh();
        // Distinguish clean from resolved so the success toast can carry the
        // resolved-disagreement count where appropriate.
        if (r.mode === "resolved") {
          setToast(RESOLVER_SUCCESS_TOAST(r.resolvedFiles.length));
        } else {
          setToast(POST_MERGE_TOAST(branchName));
        }
        return;
      }
      switch (r.error) {
        case "dirty_working_tree":
          setPromoteDirty({ branchName, files: r.files });
          return;
        case "branch_in_active_run":
          setError(PROMOTE_MID_RUN_BRANCH);
          return;
        case "main_in_active_run":
          setError(PROMOTE_MID_RUN_MAIN);
          return;
        case "no_primary_branch":
          setError(PROMOTE_FAILED("no primary version exists in this project"));
          return;
        case "locked_by_other_instance":
          setError("Another Dex instance holds the project lock — try again in a moment.");
          return;
        case "git_error":
          setError(PROMOTE_FAILED(r.message));
          return;
        case "not_dex_owned":
          setError(PROMOTE_FAILED(`"${r.branch}" cannot be promoted`));
          return;
        case "non_content_conflict":
          setError(PROMOTE_NON_CONTENT_CONFLICT);
          await refresh();
          return;
        case "resolver_failed":
          // The merge state is left in-progress so the user can pick
          // accept-or-rollback via the failure modal.
          setResolverFailure({
            branchName,
            reason: r.reason,
            failedFiles: resolverFailedFiles,
          });
          return;
      }
    },
    [projectDir, refresh],
  );

  const handlePromoteRequest = useCallback(
    async (branchName: string) => {
      setError(null);
      let summary: PromoteSummary;
      try {
        summary = await checkpointService.promoteSummary(projectDir, branchName);
      } catch (e) {
        setError(PROMOTE_FAILED(e instanceof Error ? e.message : String(e)));
        return;
      }
      setPromoteConfirm({ branchName, summary });
    },
    [projectDir],
  );

  if (disabled) {
    return (
      <div
        style={{
          padding: 12,
          color: "var(--foreground-muted)",
          fontSize: 12,
          border: "1px dashed var(--border)",
          borderRadius: "var(--radius)",
          background: "var(--surface)",
        }}
      >
        {disabledReason ?? "Timeline disabled."}
      </div>
    );
  }

  // headSha — try to derive from the last entry of selectedPath, else from
  // the starting-point if no commits exist yet. The graph uses this to
  // emphasize the current HEAD's node.
  const headSha =
    snapshot.selectedPath.length > 0
      ? snapshot.selectedPath[snapshot.selectedPath.length - 1]
      : (snapshot.startingPoint?.sha ?? null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minHeight: 0, flex: 1 }}>
      {error && (
        <div
          role="alert"
          style={{
            padding: 8,
            color: "var(--status-error)",
            border: "1px solid var(--status-error)",
            borderRadius: "var(--radius)",
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}
      {toast && (
        <div
          role="status"
          data-testid="timeline-toast"
          style={{
            padding: 8,
            color: "var(--status-success, #a6e3a1)",
            border: "1px solid var(--status-success, #a6e3a1)",
            borderRadius: "var(--radius)",
            fontSize: 12,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>{toast}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            style={{
              background: "transparent",
              border: "none",
              color: "inherit",
              cursor: "pointer",
              padding: "0 4px",
            }}
          >
            ×
          </button>
        </div>
      )}
      <TimelineGraph
        snapshot={snapshot}
        onJumpTo={handleJump}
        headSha={headSha}
        onDeleteBranch={handleDeleteBranch}
        onBranchContextMenu={handleBranchContextMenu}
        focusedBranch={focusedBranch}
        onBranchFocus={handleBranchFocus}
      />
      {dirty && (
        <GoBackConfirm
          tag={`commit ${dirty.targetSha.slice(0, 7)}`}
          files={dirty.files}
          onCancel={() => setDirty(null)}
          onChoose={async (action) => {
            const target = dirty.targetSha;
            setDirty(null);
            await performJump(target, action);
          }}
        />
      )}
      {deleteConfirm && (
        <DeleteBranchConfirm
          lostSteps={deleteConfirm.lostSteps}
          onCancel={() => setDeleteConfirm(null)}
          onConfirm={async () => {
            const target = deleteConfirm.branchName;
            setDeleteConfirm(null);
            await performDelete(target, true);
          }}
        />
      )}
      {contextMenu && (
        <BranchContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          branchName={contextMenu.branchName}
          enabled={contextMenu.enabled}
          onPromote={handlePromoteRequest}
          onClose={() => setContextMenu(null)}
        />
      )}
      {promoteConfirm && (
        <PromoteConfirm
          summary={promoteConfirm.summary}
          onCancel={() => setPromoteConfirm(null)}
          onConfirm={async () => {
            const target = promoteConfirm.branchName;
            setPromoteConfirm(null);
            await performMerge(target);
          }}
        />
      )}
      {promoteDirty && (
        <GoBackConfirm
          tag={`make ${promoteDirty.branchName} the new main`}
          files={promoteDirty.files}
          onCancel={() => setPromoteDirty(null)}
          onChoose={async (action) => {
            const target = promoteDirty.branchName;
            setPromoteDirty(null);
            await performMerge(target, action);
          }}
        />
      )}
      {resolverActive && (
        <ConflictResolverProgress
          onDone={() => {
            // Close the modal immediately; the mergeToMain promise's resolution
            // is what drives the success toast / error banner.
            setResolverActive(false);
          }}
          onCancel={async () => {
            setResolverActive(false);
            // Best-effort abort — the resolver harness checks AbortController
            // between iterations, but in v1 we don't surface a per-call
            // controller through the IPC layer. Calling abortResolverMerge
            // resets the working tree; the subsequent mergeToMain promise
            // resolves with resolver_failed eventually.
            await checkpointService.abortResolverMerge(projectDir);
          }}
        />
      )}
      {resolverFailure && (
        <ResolverFailureModal
          reason={resolverFailure.reason}
          failedFiles={resolverFailure.failedFiles}
          onAccept={async () => {
            const branchName = resolverFailure.branchName;
            setResolverFailure(null);
            const r = await checkpointService.acceptResolverResult(projectDir);
            if ("ok" in r && r.ok) {
              await refresh();
              setToast(POST_MERGE_TOAST(branchName));
            } else if ("error" in r) {
              setError(PROMOTE_FAILED(typeof r.error === "string" ? r.error : "accept failed"));
            }
          }}
          onRollback={async () => {
            setResolverFailure(null);
            const r = await checkpointService.abortResolverMerge(projectDir);
            if ("ok" in r && r.ok) {
              await refresh();
              setToast("Merge rolled back. Nothing changed.");
            } else if ("error" in r) {
              setError(PROMOTE_FAILED(typeof r.error === "string" ? r.error : "rollback failed"));
            }
          }}
          onOpenInEditor={async () => {
            // Don't dismiss the modal — user may come back to accept or roll back.
            await checkpointService.openInEditor(projectDir, resolverFailure.failedFiles);
          }}
        />
      )}
    </div>
  );
}
