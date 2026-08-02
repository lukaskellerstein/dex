import type React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";
import { theme } from "../lib/theme";
import type { Section } from "../lib/timeline";
import { Camera } from "./Camera";
import { Captions } from "./Captions";
import { LowerThird } from "./LowerThird";

/**
 * Wraps a section's picture with its camera move, its incoming transition and its overlay
 * layer.
 *
 * The camera lives here rather than inside each surface component so that every surface —
 * captured video, code card, title card — gets the same drift from the same timeline
 * field, and so the overlays stay pinned to the frame while the picture moves under them.
 *
 * Transitions are implemented here rather than with <TransitionSeries> because the
 * timeline assigns every section an absolute startFrame: the reconciler already accounted
 * for the overlap, so the layout must not be recomputed by a component.
 */
export const SectionShell: React.FC<{ section: Section; children: React.ReactNode }> = ({
  section,
  children,
}) => {
  const frame = useCurrentFrame();
  const { kind, frames } = section.transitionIn ?? { kind: "cut", frames: 0, seconds: 0 };

  let opacity = 1;
  let transform: string | undefined;

  if (frames > 0 && kind !== "cut") {
    const progress = interpolate(frame, [0, frames], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.bezier(0.4, 0, 0.2, 1),
    });

    if (kind === "crossfade") {
      opacity = progress;
    } else if (kind === "fadeThroughBlack") {
      // Hold black for the first half, then reveal — reads as a scene change rather than
      // a dissolve, which is what you want between unrelated parts of a demo.
      opacity = interpolate(progress, [0.5, 1], [0, 1], { extrapolateLeft: "clamp" });
    } else if (kind === "slide") {
      opacity = interpolate(progress, [0, 0.35], [0, 1], { extrapolateRight: "clamp" });
      transform = `translateX(${interpolate(progress, [0, 1], [6, 0])}%)`;
    }
  }

  return (
    <AbsoluteFill style={{ opacity, transform }}>
      <AbsoluteFill style={{ backgroundColor: theme.color.letterbox }}>
        <Camera camera={section.camera} durationInFrames={section.durationInFrames}>
          {children}
        </Camera>
      </AbsoluteFill>

      {section.lowerThird ? <LowerThird lowerThird={section.lowerThird} /> : null}
      {section.captions?.length ? <Captions captions={section.captions} /> : null}
    </AbsoluteFill>
  );
};
