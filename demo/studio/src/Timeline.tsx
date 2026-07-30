import React from 'react';
import { AbsoluteFill, Audio, Sequence, staticFile, useVideoConfig } from 'remotion';
import type { Timeline } from './lib/timeline';
import { dbToGain } from './lib/timeline';
import { theme } from './lib/theme';
import { SectionShell } from './components/SectionShell';
import { VideoSection } from './sections/VideoSection';
import { StillSection } from './sections/StillSection';
import { TitleCard } from './sections/TitleCard';
import { CodeSection } from './sections/CodeSection';

export const DemoTimeline: React.FC<{ timeline: Timeline }> = ({ timeline }) => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill style={{ backgroundColor: theme.color.letterbox }}>
      {timeline.sections.map((section) => (
        // One Sequence per section, positioned by absolute frame. Sections that crossfade
        // start before the previous one ends, so both are mounted during the overlap and
        // the incoming section's opacity ramp reveals it over the outgoing one.
        <Sequence
          key={section.id}
          from={section.startFrame}
          durationInFrames={section.durationInFrames}
          name={`${section.id} · ${section.title}`}
          layout="none"
        >
          <SectionShell section={section}>
            {section.surface === 'web' || section.surface === 'electron' ? (
              <VideoSection section={section} />
            ) : section.surface === 'still' ? (
              <StillSection section={section} />
            ) : section.surface === 'code' ? (
              <CodeSection section={section} />
            ) : (
              <TitleCard section={section} />
            )}
          </SectionShell>

          {section.audio ? (
            <Sequence from={section.audio.delayFrames} layout="none" name={`${section.id} VO`}>
              <Audio src={staticFile(section.audio.src)} volume={section.audio.volume ?? 1} />
            </Sequence>
          ) : null}
        </Sequence>
      ))}

      {timeline.music ? <MusicBed music={timeline.music} fps={fps} /> : null}
    </AbsoluteFill>
  );
};

/**
 * Music bed with narration ducking. The gain is evaluated per frame against the duck
 * ranges reconcile.mjs derived from the measured narration, with a short ramp either side
 * so the level change is never audible as a step.
 */
const MusicBed: React.FC<{ music: NonNullable<Timeline['music']>; fps: number }> = ({ music, fps }) => {
  const bedGain = dbToGain(music.gainDb ?? -22);
  const duckGain = dbToGain(music.duckDb ?? -30);
  const ramp = Math.round(fps * 0.35);

  return (
    <Audio
      src={staticFile(music.src)}
      loop
      volume={(frame) => {
        let closest = Infinity;
        let inside = false;
        for (const range of music.duckRanges ?? []) {
          if (frame >= range.startFrame && frame <= range.endFrame) {
            inside = true;
            break;
          }
          closest = Math.min(closest, Math.abs(frame - range.startFrame), Math.abs(frame - range.endFrame));
        }
        if (inside) return duckGain;
        if (closest < ramp) {
          const t = closest / ramp; // 0 at the edge of narration, 1 fully clear of it
          return duckGain + (bedGain - duckGain) * t;
        }
        return bedGain;
      }}
    />
  );
};
