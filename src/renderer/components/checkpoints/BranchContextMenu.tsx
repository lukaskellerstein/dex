import { useEffect, useRef } from "react";
import {
  PROMOTE_MENU_ITEM,
  PROMOTE_MENU_DISABLED_TOOLTIP,
} from "./branchOps/copy";

interface Props {
  /** Anchor coordinates in viewport pixels (typically the right-click event's clientX/Y). */
  x: number;
  y: number;
  branchName: string;
  /** True for `dex/*` and `selected-*` branches; false for `main`/`master`/user branches. */
  enabled: boolean;
  onPromote: (branchName: string) => void;
  onClose: () => void;
}

/**
 * Right-click floating menu opened on a timeline branch badge.
 * v1 has a single item: "Make this the new main".
 *
 * Closes on outside-click, Escape, or any item activation.
 */
export function BranchContextMenu({
  x,
  y,
  branchName,
  enabled,
  onPromote,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

  // Close on outside-click and Escape — standard floating-menu behaviour.
  useEffect(() => {
    function handleDown(ev: MouseEvent) {
      if (!ref.current) return;
      if (ref.current.contains(ev.target as Node)) return;
      onClose();
    }
    function handleKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      data-testid="branch-context-menu"
      style={{
        position: "fixed",
        top: y,
        left: x,
        zIndex: 1100,
        background: "var(--surface-elevated)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
        minWidth: 200,
        padding: 4,
      }}
    >
      <button
        role="menuitem"
        type="button"
        disabled={!enabled}
        title={enabled ? undefined : PROMOTE_MENU_DISABLED_TOOLTIP}
        data-testid={`promote-menu-item-${branchName}`}
        onClick={() => {
          if (!enabled) return;
          onPromote(branchName);
          onClose();
        }}
        style={{
          display: "block",
          width: "100%",
          padding: "8px 12px",
          textAlign: "left",
          background: "transparent",
          border: "none",
          color: enabled ? "var(--foreground)" : "var(--foreground-dim)",
          cursor: enabled ? "pointer" : "not-allowed",
          fontSize: 13,
          borderRadius: "var(--radius-sm, 4px)",
        }}
        onMouseEnter={(ev) => {
          if (!enabled) return;
          (ev.currentTarget as HTMLButtonElement).style.background =
            "var(--surface-hover, rgba(255,255,255,0.05))";
        }}
        onMouseLeave={(ev) => {
          (ev.currentTarget as HTMLButtonElement).style.background = "transparent";
        }}
      >
        {PROMOTE_MENU_ITEM}
      </button>
    </div>
  );
}
