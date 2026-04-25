import { useEffect, useMemo, useRef, useState } from "react";
import { select as d3Select } from "d3-selection";
import { zoom as d3Zoom, zoomIdentity, type ZoomTransform } from "d3-zoom";
import { linkVertical } from "d3-shape";
import {
  layoutTimeline,
  type LaidOutNode,
  type LaidOutEdge,
  type LayoutOutput,
} from "./timelineLayout";
import type { TimelineSnapshot } from "../../../core/checkpoints.js";
import type { SelectedNode } from "./PastAttemptsList";

interface Props {
  snapshot: TimelineSnapshot;
  selectedId: string | null;
  onSelect: (node: SelectedNode) => void;
}

const NODE_RADIUS = 9;

/** React-owned SVG, d3-zoom for pan/zoom, d3-shape for path geometry. */
export function TimelineGraph({ snapshot, selectedId, onSelect }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [hovered, setHovered] = useState<LaidOutNode | null>(null);
  const [transform, setTransform] = useState<ZoomTransform>(zoomIdentity);

  const layout: LayoutOutput = useMemo(
    () => layoutTimeline(snapshot, { columnWidth: 72, rowHeight: 64 }),
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

  // Auto-focus newest node when snapshot grows.
  useEffect(() => {
    // Simple heuristic — center on the last canonical or attempt we saw.
    // Without a persistent prior-snapshot ref, we just re-apply identity when
    // switching projects; pan is user-controlled otherwise.
    setTransform(zoomIdentity);
  }, [snapshot.checkpoints.length === 0 ? "empty" : snapshot.checkpoints[0]?.tag]);

  const linkGen = useMemo(
    () =>
      linkVertical<LaidOutEdge, { x: number; y: number }>()
        .source((e) => {
          const n = layout.nodes.find((nn) => nn.id === e.fromId);
          return n ? { x: n.x, y: n.y } : { x: 0, y: 0 };
        })
        .target((e) => {
          const n = layout.nodes.find((nn) => nn.id === e.toId);
          return n ? { x: n.x, y: n.y } : { x: 0, y: 0 };
        })
        .x((p) => p.x)
        .y((p) => p.y),
    [layout.nodes],
  );

  if (layout.nodes.length === 0) {
    return (
      <div
        style={{
          padding: 16,
          color: "var(--foreground-muted)",
          fontSize: 12,
          border: "1px dashed var(--border)",
          borderRadius: "var(--radius)",
          background: "var(--surface)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: 200,
        }}
      >
        No checkpoints yet — run a cycle to populate the timeline.
      </div>
    );
  }

  return (
    <div
      ref={wrapperRef}
      style={{
        position: "relative",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        background: "var(--surface)",
        overflow: "hidden",
        minHeight: 240,
      }}
    >
      <svg
        ref={svgRef}
        role="img"
        aria-label="Checkpoint timeline"
        width="100%"
        height={Math.max(layout.height, 240)}
        style={{ display: "block", cursor: "grab" }}
      >
        <g transform={transform.toString()}>
          {/* Alternating cycle shading — subtle row bands for canonical lane */}
          {layout.nodes
            .filter((n) => n.lane === "canonical")
            .map((n, i) => (
              <rect
                key={`band-${n.id}`}
                x={0}
                y={n.y - 24}
                width={layout.width}
                height={48}
                fill={i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.02)"}
              />
            ))}
          {layout.edges.map((e) => (
            <path
              key={`${e.fromId}-${e.toId}`}
              d={linkGen(e) ?? ""}
              fill="none"
              stroke={e.kind === "canonical" ? "var(--primary)" : "var(--border-bright)"}
              strokeWidth={e.kind === "canonical" ? 2 : 1.5}
              opacity={0.8}
            />
          ))}
          {layout.nodes.map((n) => {
            const isSelected = selectedId === n.id;
            const isHovered = hovered?.id === n.id;
            const stroke = n.unavailable ? "var(--foreground-disabled)" : n.laneColor;
            return (
              <g
                key={n.id}
                transform={`translate(${n.x}, ${n.y})`}
                style={{ cursor: n.unavailable ? "not-allowed" : "pointer" }}
                onMouseEnter={() => setHovered(n)}
                onMouseLeave={() => setHovered(null)}
                onClick={() => {
                  if (n.unavailable) return;
                  if (n.node.kind === "checkpoint" || n.node.kind === "attempt") {
                    onSelect(n.node as SelectedNode);
                  }
                }}
              >
                <circle
                  r={NODE_RADIUS + (isSelected ? 3 : isHovered ? 1 : 0)}
                  fill={n.unavailable ? "transparent" : n.laneColor}
                  stroke={stroke}
                  strokeWidth={isSelected ? 3 : 1.5}
                  opacity={n.unavailable ? 0.4 : 1}
                />
                {n.lane === "canonical" && (
                  <text
                    x={NODE_RADIUS + 6}
                    y={4}
                    fontSize={11}
                    fill="var(--foreground)"
                    style={{ pointerEvents: "none" }}
                  >
                    {n.node.kind === "checkpoint"
                      ? n.node.data.label
                      : n.node.kind === "start"
                        ? `${n.node.data.branch} @ ${n.node.data.shortSha}`
                        : ""}
                  </text>
                )}
                {n.lane !== "canonical" && (
                  <text
                    x={NODE_RADIUS + 6}
                    y={4}
                    fontSize={10}
                    fill="var(--foreground-muted)"
                    style={{ pointerEvents: "none" }}
                  >
                    {n.node.kind === "attempt"
                      ? n.node.data.branch.slice(-16)
                      : n.node.kind === "pending"
                        ? `pending ${n.node.data.step}`
                        : ""}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      {hovered && (
        <div
          style={{
            position: "absolute",
            pointerEvents: "none",
            top: 8,
            right: 8,
            background: "var(--surface-elevated)",
            border: "1px solid var(--border)",
            padding: "6px 8px",
            fontSize: 11,
            borderRadius: "var(--radius)",
            maxWidth: 280,
          }}
        >
          {hovered.node.kind === "checkpoint" ? (
            <>
              <div style={{ fontWeight: 600 }}>{hovered.node.data.label}</div>
              <div style={{ color: "var(--foreground-dim)" }}>
                step: {hovered.node.data.step} · cycle {hovered.node.data.cycleNumber}
              </div>
              <div style={{ fontFamily: "var(--font-mono)", color: "var(--foreground-dim)" }}>
                {hovered.node.data.timestamp}
              </div>
            </>
          ) : hovered.node.kind === "attempt" ? (
            <>
              <div style={{ fontWeight: 600 }}>{hovered.node.data.branch}</div>
              <div style={{ color: "var(--foreground-dim)" }}>
                {hovered.node.data.stepsAhead} step(s) ahead
              </div>
            </>
          ) : hovered.node.kind === "start" ? (
            <>
              <div style={{ fontWeight: 600 }}>
                {hovered.node.data.branch} @ {hovered.node.data.shortSha}
              </div>
              <div style={{ color: "var(--foreground-dim)" }}>{hovered.node.data.subject}</div>
              <div style={{ fontFamily: "var(--font-mono)", color: "var(--foreground-dim)" }}>
                {hovered.node.data.timestamp}
              </div>
            </>
          ) : (
            <>
              <div style={{ fontWeight: 600 }}>pending {hovered.node.data.step}</div>
              <div style={{ color: "var(--foreground-dim)" }}>cycle {hovered.node.data.cycleNumber}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
