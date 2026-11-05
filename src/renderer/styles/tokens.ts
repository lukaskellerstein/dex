/**
 * What: Typed style fragment objects that capture repeated inline-style patterns across the renderer — form labels, muted text, monospace small, card surfaces, link-like elements.
 * Not: Does not introduce a CSS framework. Does not replace CSS custom properties (those remain the design-token source). Does not cover every inline style — the rewritten C4–C6 files adopt these; the rest follows opportunistically.
 * Deps: React.CSSProperties only.
 */
import type { CSSProperties } from "react";

/** Body text in a slightly-dimmed colour — used for descriptions / helper text under labels. */
export const muted = {
  color: "var(--foreground-muted)",
  fontSize: "0.82rem",
  lineHeight: 1.5,
} as const satisfies CSSProperties;

/** Card surface with subtle border, used for grouped content (clarification toggle, agent cards). */
export const cardSurface = {
  padding: "10px 12px",
  borderRadius: "var(--radius)",
  border: "1px solid var(--border)",
  background: "var(--surface-elevated)",
} as const satisfies CSSProperties;
