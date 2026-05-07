import { useMemo, useRef, useState } from "react";
import { zoomIdentity, type ZoomTransform } from "d3-zoom";
import {
  layoutTimeline,
  type LaidOutNode,
  type LayoutOutput,
} from "../timelineLayout";
import type { TimelineSnapshot } from "../../../../core/checkpoints.js";

const LAYOUT_OPTIONS = {
  laneWidth: 100,
  rowHeight: 30,
  headerHeight: 30,
  gutterGap: 28,
};

/**
 * Owns the d3 state behind TimelineGraph: svg ref, layout memo, hover
 * state, and a pinned identity `transform`. Pan / zoom is intentionally
 * disabled — Ctrl+wheel zoom and drag-to-pan caused the canvas to drift
 * away from a meaningful "home" view. The wrapper div uses `overflow:
 * auto`, so users still scroll long timelines with the mouse wheel /
 * trackpad in the normal way. The `transform` is kept as a return value
 * (always identity) so the SVG render path stays unchanged.
 */
export function useD3Timeline(snapshot: TimelineSnapshot) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hovered, setHovered] = useState<LaidOutNode | null>(null);
  const transform: ZoomTransform = zoomIdentity;

  const layout: LayoutOutput = useMemo(
    () => layoutTimeline(snapshot, LAYOUT_OPTIONS),
    [snapshot],
  );

  const nodeById = useMemo(
    () => new Map(layout.nodes.map((n) => [n.id, n])),
    [layout.nodes],
  );

  return {
    svgRef,
    layout,
    nodeById,
    transform,
    hovered,
    setHovered,
  };
}
