/**
 * What: Typed style fragment objects that capture repeated inline-style patterns across the renderer — form labels, muted text, monospace small, card surfaces, link-like elements.
 * Not: Does not introduce a CSS framework. Does not replace CSS custom properties (those remain the design-token source). Does not cover every inline style — the rewritten C4–C6 files adopt these; the rest follows opportunistically.
 * Deps: React.CSSProperties only.
 */
import type { CSSProperties } from "react";

/** Small-form muted label used above form inputs (Max Cycles, Max Budget, GOAL.md path, etc.). */
export const formLabel = {
  display: "block",
  fontSize: "0.78rem",
  fontWeight: 500,
  color: "var(--foreground-muted)",
  marginBottom: 6,
} as const satisfies CSSProperties;

/** Body text in a slightly-dimmed colour — used for descriptions / helper text under labels. */
export const muted = {
  color: "var(--foreground-muted)",
  fontSize: "0.82rem",
  lineHeight: 1.5,
} as const satisfies CSSProperties;

/** Small mono helper text (timestamps, deltas, IDs in trace headers). */
export const monoSmall = {
  fontSize: "0.72rem",
  fontFamily: "var(--font-mono)",
  color: "var(--foreground-dim)",
} as const satisfies CSSProperties;

/** Card surface with subtle border, used for grouped content (clarification toggle, agent cards). */
export const cardSurface = {
  padding: "10px 12px",
  borderRadius: "var(--radius)",
  border: "1px solid var(--border)",
  background: "var(--surface-elevated)",
} as const satisfies CSSProperties;

/** Pointer-cursor link-like text. Pair with a hover handler for color shift. */
export const linkLike = {
  color: "var(--foreground-muted)",
  cursor: "pointer",
  transition: "color 0.15s",
} as const satisfies CSSProperties;

/** Standard text-input chrome shared by GOAL path, Max Cycles, Max Budget, name inputs. */
export const textInput = {
  padding: "6px 10px",
  borderRadius: "var(--radius)",
  border: "1px solid var(--border)",
  background: "var(--surface-elevated)",
  color: "var(--foreground)",
  fontSize: "0.82rem",
  fontFamily: "var(--font-mono)",
  outline: "none",
} as const satisfies CSSProperties;

/** Primary action button — Start Autonomous Loop, Save GOAL.md when active. */
export const primaryButton = {
  borderRadius: "var(--radius)",
  fontWeight: 600,
  background: "var(--primary)",
  color: "#fff",
  border: "none",
  cursor: "pointer",
} as const satisfies CSSProperties;

/** Secondary / disabled-state button surface — neutral chrome, no primary fill. */
export const neutralButton = {
  borderRadius: "var(--radius)",
  fontWeight: 500,
  background: "var(--surface-elevated)",
  color: "var(--foreground-muted)",
  border: "1px solid var(--border)",
  cursor: "pointer",
} as const satisfies CSSProperties;
