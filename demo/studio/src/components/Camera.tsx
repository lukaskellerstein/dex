import React from 'react';
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from 'remotion';
import type { Camera as CameraSpec } from '../lib/timeline';
import { focusToOrigin } from '../lib/timeline';

/**
 * Slow scale move over a section, converging on a focus point.
 *
 * Why any camera move at all: a static screen recording of a mostly static UI reads as a
 * still image, and viewers disengage. A 4-6% drift over ten seconds is invisible as an
 * effect but keeps the frame alive. It is also what makes a held final frame acceptable —
 * the picture is still moving even when the recording has run out.
 *
 * Keep `to` under ~1.15 for captured video: beyond that the upscale gets visibly soft.
 */
export const Camera: React.FC<{
  camera: CameraSpec;
  durationInFrames: number;
  children: React.ReactNode;
}> = ({ camera, durationInFrames, children }) => {
  const frame = useCurrentFrame();
  const kind = camera?.kind ?? 'static';

  if (kind === 'static' || !camera) {
    return <AbsoluteFill>{children}</AbsoluteFill>;
  }

  const from = camera.from ?? 1;
  const to = camera.to ?? 1.06;

  let scale = from;
  if (kind === 'kenburns') {
    // Linear across the whole section: a constant drift is less noticeable than an eased
    // one, which reads as a deliberate zoom.
    scale = interpolate(frame, [0, durationInFrames], [from, to], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
  } else if (kind === 'zoomTo') {
    // Settle into the target early, then hold — used when narration references detail.
    scale = interpolate(frame, [0, Math.round(durationInFrames * 0.45)], [from, to], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: Easing.bezier(0.22, 0.61, 0.36, 1),
    });
  } else if (kind === 'punchIn') {
    // Fast snap for an accent beat.
    const hold = Math.round(durationInFrames * 0.12);
    scale = interpolate(frame, [0, hold], [from, to], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: Easing.out(Easing.cubic),
    });
  }

  return (
    <AbsoluteFill
      style={{
        transform: `scale(${scale})`,
        transformOrigin: focusToOrigin(camera.focus ?? 'center'),
        // Avoid a hairline edge when scale rounds below 1 on a sub-pixel boundary.
        willChange: 'transform',
      }}
    >
      {children}
    </AbsoluteFill>
  );
};
