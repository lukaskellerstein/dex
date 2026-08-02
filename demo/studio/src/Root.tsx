import type React from "react";
import { Composition } from "remotion";
import timelineJson from "../../timeline.json";
import type { Timeline } from "./lib/timeline";
import { DemoTimeline } from "./Timeline";

// timeline.json is imported at build time, so the Studio hot-reloads whenever
// reconcile.mjs regenerates it, and `remotion render` needs no --props plumbing.
const timeline = timelineJson as unknown as Timeline;

export const RemotionRoot: React.FC = () => (
  <Composition
    id="Demo"
    component={DemoTimeline}
    durationInFrames={Math.max(timeline.durationInFrames ?? 1, 1)}
    fps={timeline.fps ?? 30}
    width={timeline.width ?? 1920}
    height={timeline.height ?? 1080}
    defaultProps={{ timeline }}
  />
);
