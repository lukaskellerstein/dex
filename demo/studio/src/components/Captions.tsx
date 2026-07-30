import React from 'react';
import { interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import type { Caption } from '../lib/timeline';
import { theme } from '../lib/theme';

/**
 * Narration captions. On by default because most demo videos are first watched muted
 * (in a feed, in a doc, on a second monitor) — a demo that only works with sound loses
 * most of its audience.
 *
 * Frames are section-relative, so this renders inside the section's Sequence.
 */
export const Captions: React.FC<{ captions: Caption[] }> = ({ captions }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const active = captions.find((c) => frame >= c.startFrame && frame < c.endFrame);
  if (!active) return null;

  const fade = Math.max(2, Math.round(fps * 0.1));
  const opacity = Math.min(
    interpolate(frame, [active.startFrame, active.startFrame + fade], [0, 1], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    }),
    interpolate(frame, [active.endFrame - fade, active.endFrame], [1, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    })
  );

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: theme.safeArea.bottom,
        display: 'flex',
        justifyContent: 'center',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          maxWidth: theme.caption.maxWidth,
          margin: `0 ${theme.safeArea.x}px`,
          padding: `${theme.caption.paddingY}px ${theme.caption.paddingX}px`,
          borderRadius: theme.radius.md,
          backgroundColor: theme.color.surface,
          backdropFilter: 'blur(8px)',
          color: theme.color.text,
          fontFamily: theme.font.sans,
          fontSize: theme.caption.fontSize,
          lineHeight: theme.caption.lineHeight,
          fontWeight: 550,
          textAlign: 'center',
          textWrap: 'balance',
          opacity,
          // A caption that shifts vertically between lines is distracting; the box grows
          // upward from a fixed baseline instead.
          alignSelf: 'flex-end',
        }}
      >
        {active.text}
      </div>
    </div>
  );
};
