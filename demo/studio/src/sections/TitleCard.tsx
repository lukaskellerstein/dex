import type React from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { EASE_OUT, theme } from "../lib/theme";
import type { Section } from "../lib/timeline";

/**
 * Opening or closing card: the logo mark, a line of text, and nothing else. A demo's
 * title card exists to set expectation in two seconds, so the restraint is deliberate —
 * the only motion is the mark settling into place, and it is over before the wordmark
 * finishes reading.
 *
 * Both cards share this treatment on purpose: the same mark opening and closing the
 * video is what makes them read as a pair rather than as two unrelated slides.
 */
const LOGO_SIZE = 190;

export const TitleCard: React.FC<{ section: Section }> = ({ section }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const title = section.titlecard?.title ?? section.title;
  const subtitle = section.titlecard?.subtitle;

  // Overdamped (ratio ~1.4): the mark eases to rest without a bounce. Overshoot on a
  // developer-tool demo reads as an advert, and this audience distrusts polish.
  const settle = spring({
    frame,
    fps,
    config: { damping: 26, mass: 0.9, stiffness: 90 },
    durationInFrames: Math.round(fps * 1.2),
  });

  const fadeIn = (delaySeconds: number, overSeconds = 0.5) =>
    interpolate(
      frame,
      [Math.round(fps * delaySeconds), Math.round(fps * (delaySeconds + overSeconds))],
      [0, 1],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(...EASE_OUT) },
    );

  const logoIn = fadeIn(0, 0.45);
  // The mark leads; the text follows it in rather than arriving together, so the eye
  // lands on the logo first and reads the line second.
  const titleIn = fadeIn(0.38);
  const subtitleIn = fadeIn(0.56);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.color.surfaceSolid,
        alignItems: "center",
        justifyContent: "center",
        fontFamily: theme.font.sans,
        padding: theme.safeArea.x,
      }}
    >
      <div
        style={{
          position: "relative",
          width: LOGO_SIZE,
          height: LOGO_SIZE,
          marginBottom: 44,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {/* Bloom behind the mark: the logo is a lit object, and on a near-black field it
            otherwise floats with no relationship to the background. */}
        <div
          style={{
            position: "absolute",
            inset: -LOGO_SIZE * 0.42,
            opacity: logoIn * 0.55,
            transform: `scale(${interpolate(settle, [0, 1], [0.7, 1])})`,
            background: `radial-gradient(circle, rgba(${theme.color.brandRgb}, 0.42) 0%, rgba(${theme.color.brandRgb}, 0.11) 42%, rgba(${theme.color.brandRgb}, 0) 68%)`,
          }}
        />
        <Img
          src={staticFile("brand/logo.png")}
          style={{
            width: LOGO_SIZE,
            height: LOGO_SIZE,
            opacity: logoIn,
            transform: `scale(${interpolate(settle, [0, 1], [0.82, 1])}) rotate(${interpolate(settle, [0, 1], [-16, 0])}deg)`,
          }}
        />
      </div>

      <div
        style={{
          opacity: titleIn,
          transform: `translateY(${interpolate(titleIn, [0, 1], [14, 0])}px)`,
          color: theme.color.text,
          fontSize: theme.titleCard.titleSize,
          fontWeight: 650,
          letterSpacing: "-0.02em",
          textAlign: "center",
          lineHeight: 1.1,
          maxWidth: 1500,
        }}
      >
        {title}
      </div>

      {subtitle ? (
        <div
          style={{
            opacity: subtitleIn,
            transform: `translateY(${interpolate(subtitleIn, [0, 1], [12, 0])}px)`,
            marginTop: 26,
            color: theme.color.textMuted,
            fontSize: theme.titleCard.subtitleSize,
            fontWeight: 450,
            textAlign: "center",
            maxWidth: 1100,
          }}
        >
          {subtitle}
        </div>
      ) : null}

      <div
        style={{
          opacity: subtitleIn * 0.9,
          marginTop: 40,
          width: 64,
          height: 3,
          borderRadius: 2,
          backgroundColor: theme.color.brand,
        }}
      />
    </AbsoluteFill>
  );
};
