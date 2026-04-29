import { useEffect, useMemo, useRef, useState } from "react";
import { select as d3Select } from "d3-selection";
import { zoom as d3Zoom, zoomIdentity, type ZoomTransform } from "d3-zoom";
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
 * Owns the d3 state behind TimelineGraph: svg ref, layout memo, pan/zoom
 * transform, hover state. Right-angle fork/merge paths are constructed
 * inline in the renderer (no d3-shape needed); pan/zoom handles the rest.
 */
export function useD3Timeline(snapshot: TimelineSnapshot) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hovered, setHovered] = useState<LaidOutNode | null>(null);
  const [transform, setTransform] = useState<ZoomTransform>(zoomIdentity);

  const layout: LayoutOutput = useMemo(
    () => layoutTimeline(snapshot, LAYOUT_OPTIONS),
    [snapshot],
  );

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const zoom = d3Zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.25, 4])
      .on("zoom", (event) => {
        setTransform(event.transform);
      });
    const sel = d3Select(svg);
    sel.call(zoom);
    return () => {
      sel.on(".zoom", null);
    };
  }, []);

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
