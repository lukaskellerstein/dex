import { useRef, type MouseEvent } from "react";
import { type LaidOutNode, type ColorState } from "./timelineLayout";
import type { TimelineSnapshot, TimelineCommit } from "../../../core/checkpoints.js";
import { useD3Timeline } from "./hooks/useD3Timeline.js";

interface Props {
  snapshot: TimelineSnapshot;
  /** Left-click on a step-commit. Caller invokes checkpointService.jumpTo. */
  onJumpTo: (sha: string) => void;
  /** Right-click on a step-commit. Caller opens CommitContextMenu (US3). */
  onContextMenu?: (commit: TimelineCommit, position: { x: number; y: number }) => void;
  /** SHA of the commit corresponding to current HEAD; rendered with a slight emphasis. */
  headSha?: string | null;
  /** Click the ✕ on a selected-* lane's pill. Caller calls checkpoints:unselect. */
  onUnselect?: (branchName: string) => void;
}

const DOT_RADIUS = 7;
const COLOR_KEPT_RING = "#ef4444";

/**
 * Mermaid-style: every dot is solid-filled with its lane color. The
 * "selected" highlight is a thicker stroke + a subtle inner ring rather than
 * a different fill, so the lane palette stays consistent across the canvas.
 */
function fillFor(node: LaidOutNode): string {
  return node.laneColor;
}

function ringFor(state: ColorState): string | null {
  return state === "kept" || state === "selected+kept" ? COLOR_KEPT_RING : null;
}

function shortBranch(name: string): string {
  // Show the full branch name. The canvas overflows horizontally and the
  // wrapper scrolls (`overflow: auto`) when there are many branches.
  return name;
}

/** React-owned SVG, d3-zoom for pan/zoom, d3-shape for path geometry. */
export function TimelineGraph({ snapshot, onJumpTo, onContextMenu, headSha, onUnselect }: Props) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const { svgRef, layout, nodeById, linkGen, transform, hovered, setHovered } =
    useD3Timeline(snapshot);

  if (layout.nodes.length === 0) {
    return (
      <div
        data-testid="timeline-empty"
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

  const handleClick = (n: LaidOutNode) => {
    if (n.node.kind === "step-commit") {
      onJumpTo(n.node.data.sha);
    } else if (n.node.kind === "start") {
      onJumpTo(n.node.data.sha);
    }
  };

  const handleContextMenu = (n: LaidOutNode, ev: MouseEvent<SVGGElement>) => {
    if (!onContextMenu || n.node.kind !== "step-commit") return;
    ev.preventDefault();
    onContextMenu(n.node.data, { x: ev.clientX, y: ev.clientY });
  };

  return (
    <div
      ref={wrapperRef}
      data-testid="timeline-graph"
      style={{
        position: "relative",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        background: "var(--surface)",
        overflow: "auto",
        // Take all the available height from the parent so the wrapper
        // bounds itself to the viewport — both scrollbars stay inside the
        // visible area instead of the horizontal one living at the bottom
        // of a 1000+px-tall SVG.
        flex: 1,
        minHeight: 0,
      }}
    >
      <svg
        ref={svgRef}
        role="img"
        aria-label="Checkpoint timeline"
        width={Math.max(layout.width, 480)}
        height={Math.max(layout.height, 240)}
        style={{ display: "block", cursor: "grab" }}
      >
        <g transform={transform.toString()}>
          {/* Branch column headers — horizontal pills above each lane. */}
          {layout.columns.map((col) => {
            const label = shortBranch(col.branch);
            const isSelected = col.branch.startsWith("selected-");
            const padX = 8;
            const charW = 6.4;
            const xBtnW = isSelected && onUnselect ? 18 : 0;
            const w = Math.max(label.length * charW + padX * 2 + xBtnW, 36);
            return (
              <g key={`col-${col.branch}`} transform={`translate(${col.x - w / 2}, 8)`}>
                <rect
                  x={0}
                  y={0}
                  width={w}
                  height={18}
                  rx={4}
                  ry={4}
                  fill={col.laneColor}
                  fillOpacity={0.18}
                  stroke={col.laneColor}
                  strokeWidth={1}
                />
                <text
                  x={(w - xBtnW) / 2}
                  y={13}
                  fontSize={10.5}
                  fontFamily="var(--font-mono, monospace)"
                  fill={col.laneColor}
                  textAnchor="middle"
                  style={{ pointerEvents: "none" }}
                >
                  {label}
                </text>
                {isSelected && onUnselect && (
                  <g
                    data-testid={`unselect-${col.branch}`}
                    transform={`translate(${w - xBtnW + 2}, 0)`}
                    style={{ cursor: "pointer" }}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onUnselect(col.branch);
                    }}
                  >
                    <rect x={0} y={0} width={xBtnW - 2} height={18} fill="transparent" />
                    <text
                      x={(xBtnW - 2) / 2}
                      y={13}
                      fontSize={13}
                      fill={col.laneColor}
                      textAnchor="middle"
                      style={{ pointerEvents: "none", fontWeight: 700 }}
                    >
                      ×
                    </text>
                  </g>
                )}
              </g>
            );
          })}

          {/* Trunk line — main's continuous backbone, drawn behind everything
              so branch-off arcs visually emerge from it. */}
          {layout.trunkLine && (
            <line
              x1={layout.trunkLine.x}
              y1={layout.trunkLine.y1}
              x2={layout.trunkLine.x}
              y2={layout.trunkLine.y2}
              stroke={layout.trunkLine.color}
              strokeWidth={2}
              opacity={0.55}
              strokeDasharray="2 4"
            />
          )}

          {/* Edges — straight vertical for within-lane (mermaid-style track),
              curved for cross-lane branch-offs and trunk-sprouts. */}
          {layout.edges.map((e) => {
            const to = nodeById.get(e.toId);
            if (!to) return null;
            // Trunk-sprout (origin = phantom point on main lane at target row)
            // → always curved.
            if (e.fromPoint) {
              return (
                <path
                  key={`${e.fromId}-${e.toId}`}
                  d={linkGen(e) ?? ""}
                  fill="none"
                  stroke={e.laneColor}
                  strokeWidth={1.75}
                  opacity={0.9}
                />
              );
            }
            const from = nodeById.get(e.fromId);
            if (!from) return null;
            // Same column → straight vertical line.
            if (from.columnIndex === to.columnIndex) {
              return (
                <line
                  key={`${e.fromId}-${e.toId}`}
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  stroke={e.laneColor}
                  strokeWidth={2}
                  opacity={0.9}
                />
              );
            }
            // Different column → curved arc.
            return (
              <path
                key={`${e.fromId}-${e.toId}`}
                d={linkGen(e) ?? ""}
                fill="none"
                stroke={e.laneColor}
                strokeWidth={1.75}
                opacity={0.85}
              />
            );
          })}

          {/* Dots */}
          {layout.nodes.map((n) => {
            const isHovered = hovered?.id === n.id;
            const isHead = n.node.kind === "step-commit" && headSha === n.node.data.sha;
            const ring = ringFor(n.colorState);
            return (
              <g
                key={n.id}
                data-testid={
                  n.node.kind === "start"
                    ? "timeline-anchor"
                    : `timeline-node-${(n.node.data as TimelineCommit).shortSha}`
                }
                transform={`translate(${n.x}, ${n.y})`}
                style={{ cursor: "pointer" }}
                onMouseEnter={() => setHovered(n)}
                onMouseLeave={() => setHovered(null)}
                onClick={() => handleClick(n)}
                onContextMenu={(ev) => handleContextMenu(n, ev)}
              >
                {ring && (
                  <circle
                    r={DOT_RADIUS + 3}
                    fill="transparent"
                    stroke={ring}
                    strokeWidth={2}
                  />
                )}
                <circle
                  r={DOT_RADIUS + (isHovered ? 1 : 0)}
                  fill={fillFor(n)}
                  stroke={isHead ? "var(--foreground, #fff)" : "transparent"}
                  strokeWidth={isHead ? 2 : 0}
                />
                {/* Inner highlight for "on selected path" — a small white core
                    inside the lane-colored dot, like mermaid's HEAD marker. */}
                {(n.colorState === "selected" || n.colorState === "selected+kept") && (
                  <circle r={DOT_RADIUS - 3} fill="var(--surface, #0e1120)" />
                )}
              </g>
            );
          })}

          {/* Per-dot labels — placed immediately to the right of each dot so
              the SHA + step text tracks the dot's lane instead of all aligning
              to a single right-side gutter. */}
          {layout.nodes
            .filter((n) => n.node.kind === "step-commit")
            .map((n) => {
              const c = n.node.data as TimelineCommit;
              const isHead = headSha === c.sha;
              return (
                <g
                  key={`label-${n.id}`}
                  transform={`translate(${n.x + DOT_RADIUS + 8}, ${n.y})`}
                  style={{ pointerEvents: "none" }}
                >
                  <text
                    fontSize={11}
                    fontFamily="var(--font-mono, monospace)"
                    fill={isHead ? "var(--foreground)" : "var(--foreground-muted)"}
                    fontWeight={isHead ? 600 : 400}
                    y={4}
                  >
                    {c.shortSha}
                    <tspan fill="var(--foreground-dim, #64748b)" fontFamily="var(--font, sans-serif)">
                      {"  "}
                      {c.step}
                      {c.cycleNumber > 0 ? ` · cycle ${c.cycleNumber}` : ""}
                    </tspan>
                  </text>
                </g>
              );
            })}
          {/* Anchor label — show "starting-point" hint at the anchor row. */}
          {layout.nodes
            .filter((n) => n.node.kind === "start")
            .map((n) => {
              const sp = n.node.data;
              if (n.node.kind !== "start") return null;
              return (
                <g
                  key={`label-${n.id}`}
                  transform={`translate(${n.x + DOT_RADIUS + 8}, ${n.y})`}
                  style={{ pointerEvents: "none" }}
                >
                  <text
                    fontSize={11}
                    fontFamily="var(--font-mono, monospace)"
                    fill="var(--foreground-dim, #64748b)"
                    y={4}
                  >
                    {sp.shortSha}
                    <tspan fontFamily="var(--font, sans-serif)">
                      {"  "}starting-point · {shortBranch(sp.branch)}
                    </tspan>
                  </text>
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
            maxWidth: 360,
          }}
        >
          {hovered.node.kind === "step-commit" ? (
            <>
              <div style={{ fontWeight: 600 }}>{hovered.node.data.subject}</div>
              <div style={{ color: "var(--foreground-dim)", fontFamily: "var(--font-mono)" }}>
                {hovered.node.data.shortSha} · {hovered.node.data.branch}
              </div>
              <div style={{ color: "var(--foreground-dim)", fontFamily: "var(--font-mono)" }}>
                {hovered.node.data.timestamp}
              </div>
            </>
          ) : (
            <>
              <div style={{ fontWeight: 600 }}>
                {hovered.node.data.branch} @ {hovered.node.data.shortSha}
              </div>
              <div style={{ color: "var(--foreground-dim)" }}>{hovered.node.data.subject}</div>
              <div style={{ fontFamily: "var(--font-mono)", color: "var(--foreground-dim)" }}>
                {hovered.node.data.timestamp}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
