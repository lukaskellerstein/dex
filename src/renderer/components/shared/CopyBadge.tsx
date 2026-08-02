import { Check } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";

interface CopyBadgeProps {
  /** Lazy-evaluated text to copy. Called at click time so payloads can be fresh. */
  getCopyText: () => string;
  /** Idle label rendered alongside the icon. */
  label: ReactNode;
  /** Idle icon (e.g. <Bug size={10} />, <Copy size={10} />). */
  icon: ReactNode;
  /** Whether the icon sits before or after the label. Default: "left". */
  iconPosition?: "left" | "right";
  /** Tooltip when idle. */
  title?: string;
  /** Label shown for ~1.5s after copy succeeds. Defaults to "copied". */
  copiedLabel?: ReactNode;
}

/**
 * One-click "copy to clipboard" pill with a 1.5s confirmation flash.
 * Replaces the duplicated DebugCopyBadge / CopyIdBadge components.
 */
export function CopyBadge({
  getCopyText,
  label,
  icon,
  iconPosition = "left",
  title,
  copiedLabel = "copied",
}: CopyBadgeProps) {
  const [copied, setCopied] = useState(false);

  const handleClick = useCallback(() => {
    navigator.clipboard.writeText(getCopyText());
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [getCopyText]);

  const displayIcon = copied ? <Check size={10} /> : icon;
  const displayLabel = copied ? copiedLabel : label;

  return (
    <span
      title={copied ? "Copied!" : (title ?? "Click to copy")}
      onClick={handleClick}
      style={{
        fontSize: "0.68rem",
        padding: "1px 5px",
        borderRadius: "var(--radius)",
        background: copied
          ? "color-mix(in srgb, var(--status-success) 15%, var(--surface-elevated))"
          : "var(--surface-elevated)",
        border: `1px solid ${copied ? "var(--status-success)" : "var(--border)"}`,
        color: copied ? "var(--status-success)" : "var(--foreground-dim)",
        fontFamily: "var(--font-mono)",
        textTransform: "none",
        letterSpacing: "normal",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        transition: "background 0.15s, border-color 0.15s, color 0.15s",
      }}
    >
      {iconPosition === "left" && displayIcon}
      {displayLabel}
      {iconPosition === "right" && displayIcon}
    </span>
  );
}
