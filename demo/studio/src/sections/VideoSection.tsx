import React from 'react';
import { AbsoluteFill, Freeze, OffthreadVideo, Sequence, staticFile } from 'remotion';
import type { Section } from '../lib/timeline';

/**
 * A captured clip, fitted to the section length the narration demands.
 *
 * Three mechanisms, all decided by reconcile.mjs — this component only executes them:
 *   playbackRate      mild speed change, capped at ±15% so motion still looks natural
 *   trimBefore/After  frame-accurate in/out points (FRAMES, matching the CFR transcode)
 *   hold              when the clip runs out early, freeze the final frame while the
 *                     camera (applied by SectionShell) keeps drifting, so the beat reads
 *                     as deliberate
 *
 * objectFit: cover fills the composition from a smaller capture (1600x900 -> 1920x1080)
 * without cropping, since both are 16:9.
 */
export const VideoSection: React.FC<{ section: Section }> = ({ section }) => {
  const video = section.video;
  if (!video) return <AbsoluteFill style={{ backgroundColor: '#000' }} />;

  const videoFrames = Math.max(video.videoFrames ?? section.durationInFrames, 1);
  const hold = video.holdLastFrameFrames ?? 0;

  const style: React.CSSProperties = { width: '100%', height: '100%', objectFit: 'cover' };
  const shared = {
    src: staticFile(video.src),
    playbackRate: video.playbackRate ?? 1,
    muted: true,
    style,
    ...(video.trimBefore !== undefined ? { trimBefore: video.trimBefore } : {}),
    ...(video.trimAfter !== undefined ? { trimAfter: video.trimAfter } : {}),
  };

  return (
    <AbsoluteFill>
      <Sequence durationInFrames={videoFrames} layout="none">
        <AbsoluteFill>
          <OffthreadVideo {...shared} />
        </AbsoluteFill>
      </Sequence>

      {hold > 0 ? (
        <Sequence from={videoFrames} durationInFrames={hold} layout="none">
          <Freeze frame={Math.max(videoFrames - 1, 0)}>
            <AbsoluteFill>
              <OffthreadVideo {...shared} />
            </AbsoluteFill>
          </Freeze>
        </Sequence>
      ) : null}
    </AbsoluteFill>
  );
};
