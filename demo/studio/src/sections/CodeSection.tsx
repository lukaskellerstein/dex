import React from 'react';
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import type { Section } from '../lib/timeline';
import { theme } from '../lib/theme';

/**
 * A code beat — the integration snippet, the config that makes the feature work, the API
 * call. Deliberately dependency-free: no syntax highlighter, because a demo code beat is
 * on screen for six seconds and what matters is the highlighted lines, not token colour.
 *
 * `code.content` holds the literal snippet (the storyboard author pastes it in);
 * `code.highlight` is a 1-based line range like "3-5" that stays full-brightness while
 * the rest dims.
 */
export const CodeSection: React.FC<{ section: Section }> = ({ section }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const code = section.code;

  const content = code?.content ?? '';
  const lines = content.replace(/\n$/, '').split('\n');
  const [hlStart, hlEnd] = parseRange(code?.highlight);

  // The storyboard validator requires code.content, but if a timeline arrives without it,
  // fail visibly — a blank code panel in a rendered video is far harder to diagnose.
  if (!content.trim()) {
    return (
      <AbsoluteFill
        style={{
          backgroundColor: theme.color.surfaceSolid,
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: theme.font.mono,
          fontSize: 30,
          color: theme.color.textMuted,
        }}
      >
        Missing code.content for section {section.id}
      </AbsoluteFill>
    );
  }

  // Lines fade in as a group quickly, then the highlight settles — fast enough that the
  // viewer is reading, not watching an animation.
  const reveal = interpolate(frame, [0, Math.round(fps * 0.5)], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.22, 0.61, 0.36, 1),
  });
  const focus = interpolate(frame, [Math.round(fps * 0.5), Math.round(fps * 1.1)], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.color.surfaceSolid,
        alignItems: 'center',
        justifyContent: 'center',
        padding: theme.safeArea.x,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 1440,
          backgroundColor: theme.color.panel,
          borderRadius: theme.radius.lg,
          border: '1px solid rgba(255,255,255,0.08)',
          overflow: 'hidden',
          opacity: reveal,
          transform: `translateY(${interpolate(reveal, [0, 1], [12, 0])}px)`,
        }}
      >
        {code?.file ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '16px 22px',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
              fontFamily: theme.font.mono,
              fontSize: 20,
              color: theme.color.textMuted,
            }}
          >
            <span style={{ width: 10, height: 10, borderRadius: 5, background: theme.color.accent }} />
            {code.file}
            {code.lines ? <span style={{ opacity: 0.6 }}>{` · ${code.lines}`}</span> : null}
          </div>
        ) : null}

        <pre
          style={{
            margin: 0,
            padding: '26px 24px',
            fontFamily: theme.font.mono,
            fontSize: 26,
            lineHeight: 1.5,
            color: theme.color.text,
          }}
        >
          {lines.map((line, i) => {
            const lineNo = i + 1;
            const highlighted = hlStart !== null && lineNo >= hlStart && lineNo <= (hlEnd ?? hlStart);
            const dim = hlStart !== null && !highlighted ? 1 - 0.55 * focus : 1;
            return (
              <div
                key={i}
                style={{
                  display: 'flex',
                  gap: 20,
                  opacity: dim,
                  backgroundColor: highlighted ? `rgba(${theme.color.accentRgb}, ${0.14 * focus})` : undefined,
                  margin: '0 -24px',
                  padding: '0 24px',
                }}
              >
                <span style={{ opacity: 0.32, minWidth: 42, textAlign: 'right', userSelect: 'none' }}>
                  {lineNo}
                </span>
                <span style={{ whiteSpace: 'pre' }}>{line || ' '}</span>
              </div>
            );
          })}
        </pre>
      </div>
    </AbsoluteFill>
  );
};

function parseRange(range?: string): [number | null, number | null] {
  if (!range) return [null, null];
  const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(range.trim());
  if (!match) return [null, null];
  return [Number(match[1]), match[2] ? Number(match[2]) : null];
}
