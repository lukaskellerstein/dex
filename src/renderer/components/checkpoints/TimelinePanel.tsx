import { useCallback, useState } from "react";
import { useTimeline } from "./hooks/useTimeline";
import { GoBackConfirm } from "./GoBackConfirm";
import { TimelineGraph } from "./TimelineGraph";
import { CommitContextMenu } from "./CommitContextMenu";
import type { TimelineCommit } from "../../../core/checkpoints.js";

interface Props {
  projectDir: string;
  /** Disabled: no git repo / no identity. */
  disabled?: boolean;
  disabledReason?: string;
  /** Right-click "Try N ways from here" — parent opens the variant modal. */
  onTryNWaysAt?: (commit: TimelineCommit) => void;
}

interface DirtyEnvelope {
  /** SHA the user originally wanted to jump to. The save/discard retry uses it. */
  targetSha: string;
  files: string[];
}

interface MenuState {
  commit: TimelineCommit;
  isKept: boolean;
  position: { x: number; y: number };
}

/**
 * Canonical step-commit tag for a (step, cycleNumber) pair, mirroring the
 * core's `checkpointTagFor` helper. Kept inline here to avoid pulling the
 * core module into the renderer at runtime.
 */
function tagFor(step: string, cycleNumber: number): string {
  const slug = step.replaceAll("_", "-");
  return cycleNumber === 0
    ? `checkpoint/after-${slug}`
    : `checkpoint/cycle-${cycleNumber}-after-${slug}`;
}

/**
 * 010 — full-width Timeline canvas. Single-click on a node calls jumpTo;
 * right-click opens the CommitContextMenu (Keep / Unmark / Try N ways).
 * No side detail panel, no bottom past-attempts list.
 */
export function TimelinePanel({
  projectDir,
  disabled,
  disabledReason,
  onTryNWaysAt,
}: Props) {
  const { snapshot, refresh } = useTimeline(projectDir);
  const [dirty, setDirty] = useState<DirtyEnvelope | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const performJump = useCallback(
    async (targetSha: string, force?: "save" | "discard") => {
      setError(null);
      const r = await window.dexAPI.checkpoints.jumpTo(
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

  const handleKeep = useCallback(
    async (commit: TimelineCommit) => {
      setError(null);
      const tag = tagFor(commit.step, commit.cycleNumber);
      const r = await window.dexAPI.checkpoints.promote(projectDir, tag, commit.sha);
      if (!("ok" in r) || !r.ok) {
        setError(`Keep failed: ${("error" in r && r.error) || "unknown"}`);
        return;
      }
      await refresh();
    },
    [projectDir, refresh],
  );

  const handleUnkeep = useCallback(
    async (commit: TimelineCommit) => {
      setError(null);
      const r = await window.dexAPI.checkpoints.unmark(projectDir, commit.sha);
      if (!("ok" in r) || !r.ok) {
        setError(`Unmark failed: ${("error" in r && r.error) || "unknown"}`);
        return;
      }
      await refresh();
    },
    [projectDir, refresh],
  );

  const handleTryNWays = useCallback(
    (commit: TimelineCommit) => {
      onTryNWaysAt?.(commit);
    },
    [onTryNWaysAt],
  );

  const handleUnselect = useCallback(
    async (branchName: string) => {
      setError(null);
      const r = await window.dexAPI.checkpoints.unselect(projectDir, branchName);
      if (!("ok" in r) || !r.ok) {
        setError(`Unselect failed: ${("error" in r && r.error) || "unknown"}`);
        return;
      }
      await refresh();
    },
    [projectDir, refresh],
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
      <TimelineGraph
        snapshot={snapshot}
        onJumpTo={handleJump}
        onContextMenu={(commit, position) => {
          setMenu({ commit, isKept: commit.hasCheckpointTag, position });
        }}
        headSha={headSha}
        onUnselect={handleUnselect}
      />
      {menu && (
        <CommitContextMenu
          commit={menu.commit}
          isKept={menu.isKept}
          position={menu.position}
          onKeep={handleKeep}
          onUnkeep={handleUnkeep}
          onTryNWays={handleTryNWays}
          onClose={() => setMenu(null)}
        />
      )}
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
    </div>
  );
}
