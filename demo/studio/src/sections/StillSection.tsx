import React from 'react';
import { AbsoluteFill, Img, staticFile } from 'remotion';
import type { Section } from '../lib/timeline';
import { Camera } from '../components/Camera';
import { theme } from '../lib/theme';

/**
 * A still image beat — architecture diagram, before/after screenshot, chart.
 *
 * Stills need a camera move more than video does: a motionless frame for eight seconds
 * reads as a buffering video. reconcile.mjs leaves the camera as authored, so give still
 * sections a kenburns move in the storyboard.
 */
export const StillSection: React.FC<{ section: Section }> = ({ section }) => {
  if (!section.still) {
    return (
      <AbsoluteFill
        style={{
          backgroundColor: theme.color.surfaceSolid,
          color: theme.color.textMuted,
          fontFamily: theme.font.sans,
          fontSize: 28,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {`Missing still for section ${section.id}`}
      </AbsoluteFill>
    );
  }

  return (
    <Camera camera={section.camera} durationInFrames={section.durationInFrames}>
      <AbsoluteFill style={{ backgroundColor: theme.color.surfaceSolid }}>
        <Img
          src={staticFile(section.still)}
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
        />
      </AbsoluteFill>
    </Camera>
  );
};
