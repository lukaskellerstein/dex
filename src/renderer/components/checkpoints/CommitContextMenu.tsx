import { useEffect, useRef, type CSSProperties } from "react";
import { Bookmark, BookmarkMinus, GitBranch } from "lucide-react";
import type { TimelineCommit } from "../../../core/checkpoints.js";

export interface CommitContextMenuProps {
  commit: TimelineCommit;
  isKept: boolean;
  position: { x: number; y: number };
  onKeep: (commit: TimelineCommit) => Promise<void> | void;
  onUnkeep: (commit: TimelineCommit) => Promise<void> | void;
  onTryNWays: (commit: TimelineCommit) => void;
  onClose: () => void;
}

const itemStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 10px",
  fontSize: "0.78rem",
  color: "var(--foreground)",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  textAlign: "left",
  width: "100%",
  transition: "background 0.1s",
};

/**
 * Right-click verb menu for a step-commit on the Timeline canvas.
 *
 * The menu's items conditionally render based on `isKept`:
 *   - When NOT kept: shows **Keep this** + **Try N ways from here**
 *   - When kept:     shows **Unmark kept** + **Try N ways from here**
 *
 * Closes on outside-click, Escape, or after any item is clicked.
 */
export function CommitContextMenu({
  commit,
  isKept,
  position,
  onKeep,
  onUnkeep,
  onTryNWays,
  onClose,
}: CommitContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handleDocClick = (ev: MouseEvent) => {
      if (ref.current && !ref.current.contains(ev.target as Node)) {
        onClose();
      }
    };
    const handleKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
    };
    // Defer the listener attachment one tick so the right-click that opened
    // the menu doesn't immediately close it.
    const t = window.setTimeout(() => {
      document.addEventListener("mousedown", handleDocClick);
      document.addEventListener("keydown", handleKey);
    }, 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("mousedown", handleDocClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  // Clamp position so the menu stays inside the viewport.
  const menuW = 200;
  const menuH = isKept ? 76 : 76;
  const x = Math.min(position.x, window.innerWidth - menuW - 8);
  const y = Math.min(position.y, window.innerHeight - menuH - 8);

  const wrap = async (action: () => Promise<void> | void) => {
    try {
      await action();
    } finally {
      onClose();
    }
  };

  return (
    <div
      ref={ref}
      role="menu"
      data-testid="commit-context-menu"
      style={{
        position: "fixed",
        left: x,
        top: y,
        minWidth: menuW,
        background: "var(--surface-elevated)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        boxShadow: "0 8px 24px rgba(0,0,0,0.32)",
        padding: "4px 0",
        zIndex: 1000,
      }}
    >
      <div
        style={{
          padding: "4px 10px 6px",
          fontSize: "0.66rem",
          fontFamily: "var(--font-mono, monospace)",
          color: "var(--foreground-dim)",
          borderBottom: "1px solid var(--border)",
          marginBottom: 4,
        }}
      >
        {commit.shortSha} · {commit.step}
        {commit.cycleNumber > 0 ? ` · cycle ${commit.cycleNumber}` : ""}
      </div>

      {!isKept && (
        <button
          type="button"
          data-testid="ctx-keep"
          onClick={() => wrap(() => onKeep(commit))}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          style={itemStyle}
        >
          <Bookmark size={13} color="#ef4444" />
          Keep this
        </button>
      )}

      {isKept && (
        <button
          type="button"
          data-testid="ctx-unkeep"
          onClick={() => wrap(() => onUnkeep(commit))}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          style={itemStyle}
        >
          <BookmarkMinus size={13} color="var(--foreground-muted)" />
          Unmark kept
        </button>
      )}

      <button
        type="button"
        data-testid="ctx-try-n-ways"
        onClick={() => wrap(() => onTryNWays(commit))}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        style={itemStyle}
      >
        <GitBranch size={13} color="var(--primary, #5865f2)" />
        Try N ways from here
      </button>
    </div>
  );
}
