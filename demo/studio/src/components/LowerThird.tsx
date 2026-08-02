import type React from "react";
import { Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "../lib/theme";

/**
 * The label that names what the viewer is looking at.
 *
 * Bottom-right, stacked above the caption band. A captured desktop app has no empty
 * margin to hide in — it owns every pixel — so the position is chosen from what the
 * recording actually leaves blank rather than from broadcast convention. Top-left, the
 * obvious choice, lands on the window's tab bar and clips its labels.
 *
 * It appears with the narration and leaves after ~3 seconds — a label that stays for the
 * whole section stops being read and starts being clutter.
 */
export const LowerThird: React.FC<{
  lowerThird: { text: string; inFrame: number; outFrame: number };
}> = ({ lowerThird }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { text, inFrame, outFrame } = lowerThird;

  const dur = Math.round(fps * 0.42);
  const enter = interpolate(frame, [inFrame, inFrame + dur], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.22, 0.61, 0.36, 1),
  });
  const exit = interpolate(frame, [outFrame - dur, outFrame], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.4, 0, 1, 1),
  });
  const opacity = Math.min(enter, exit);
  if (opacity <= 0.001) return null;

  return (
    <div
      style={{
        position: "absolute",
        bottom: theme.lowerThird.bottom,
        right: theme.safeArea.x,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "9px 16px 9px 13px",
        borderRadius: theme.radius.sm,
        background: theme.lowerThird.background,
        border: theme.lowerThird.border,
        backdropFilter: "blur(12px)",
        fontFamily: theme.font.mono,
        color: theme.lowerThird.color,
        fontSize: theme.lowerThird.fontSize,
        fontWeight: 500,
        // Mono at small sizes reads tight; a little tracking keeps URLs and
        // bracketed tags like [checkpoint:plan:1] scannable at a glance.
        letterSpacing: "0.01em",
        opacity,
        // Slides in from the right rather than up: the caption below animates
        // vertically, and two overlays rising together look like one block.
        transform: `translateX(${interpolate(opacity, [0, 1], [14, 0])}px)`,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          flexShrink: 0,
          backgroundColor: theme.color.accent,
          // The dot is the only saturated pixel in the plate — it marks the
          // annotation as Dex's own voice without a full accent stripe, which
          // at this size turned into a coloured bar competing with the text.
          boxShadow: `0 0 10px rgba(${theme.color.accentRgb}, 0.65)`,
        }}
      />
      {text}
    </div>
  );
};
