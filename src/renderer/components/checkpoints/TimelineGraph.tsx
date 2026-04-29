import { useRef, type MouseEvent } from "react";
import { type LaidOutNode, type LaidOutEdge, type ColorState } from "./timelineLayout";
import type { TimelineSnapshot, TimelineCommit } from "../../../core/checkpoints.js";
import { useD3Timeline } from "./hooks/useD3Timeline.js";

interface Props {
  snapshot: TimelineSnapshot;
  /** Left-click on a step-commit. Caller invokes checkpointService.jumpTo. */
  onJumpTo: (sha: string) => void;
  /** Right-click on a step-commit. Caller opens CommitContextMenu. */
  onContextMenu?: (commit: TimelineCommit, position: { x: number; y: number }) => void;
  /** SHA corresponding to current HEAD; rendered with subtle emphasis. */
  headSha?: string | null;
  /** Click the ✕ on a `selected-*` lane's badge. Caller calls checkpoints:unselect. */
  onUnselect?: (branchName: string) => void;
  /** Branch currently in "focus" mode — others dim to gray. */
  focusedBranch?: string | null;
  /** Click on a header badge → toggle focus for that branch. */
  onBranchFocus?: (branch: string) => void;
}

const DOT_RADIUS = 6;
const CORNER_R = 10;
const COLOR_KEPT_RING = "#ef4444";
const FOCUS_HIGHLIGHT = "var(--foreground, #cdd6f4)";
const FOCUS_DIMMED = "var(--foreground-dim, #6c7086)";
const MARKER_COLOR = "#4a4d63";
const SURFACE_COLOR = "var(--surface, #0e1120)";

const BAND_TINTS: [string, string] = [
  "rgba(255, 255, 255, 0.025)",
  "rgba(255, 255, 255, 0.060)",
];

function displayColor(originalColor: string, branch: string, focused: string | null): string {
  if (focused === null) return originalColor;
  if (focused === branch) return FOCUS_HIGHLIGHT;
  return FOCUS_DIMMED;
}

function displayOpacity(branch: string, focused: string | null, base: number): number {
  if (focused === null) return base;
  if (focused === branch) return base;
  return Math.min(base, 0.35);
}

function ringFor(state: ColorState): string | null {
  return state === "kept" || state === "selected+kept" ? COLOR_KEPT_RING : null;
}

/** Compact header-badge text. Last 3 chars of branch name; main/master kept verbatim. */
function badgeText(branch: string): string {
  if (branch === "main" || branch === "master") return branch;
  if (branch.length <= 3) return branch;
  return branch.slice(-3);
}

/**
 * Right-angle path with one rounded corner. The `elbow` is the corner.
 *   • Fork: source on parent lane at parent row → corner at (childX, parentY) → drop to childY.
 *     Path: M sx,sy  H elbowX-r  Q elbowX,elbowY  elbowX,elbowY+r  V destY
 *   • Merge: source on merged lane at merged row → corner at (mergedX, mergeY) → glide left to mergeX.
 *     Path: M sx,sy  V elbowY-r  Q elbowX,elbowY  elbowX-r,elbowY  H destX
 * The function inspects elbow.y vs source.y to decide which leg comes first.
 */
function rightAnglePath(
  sx: number, sy: number,
  ex: number, ey: number,
  dx: number, dy: number,
  r = CORNER_R,
): string {
  const horizontalFirst = ey === sy;
  if (horizontalFirst) {
    const goingRight = ex > sx;
    const beforeCornerX = ex - (goingRight ? r : -r);
    const goingDown = dy > ey;
    const afterCornerY = ey + (goingDown ? r : -r);
    return `M ${sx} ${sy} H ${beforeCornerX} Q ${ex} ${ey} ${ex} ${afterCornerY} V ${dy}`;
  } else {
    const goingDown = ey > sy;
    const beforeCornerY = ey - (goingDown ? r : -r);
    const goingLeft = dx < ex;
    const afterCornerX = ex + (goingLeft ? -r : r);
    return `M ${sx} ${sy} V ${beforeCornerY} Q ${ex} ${ey} ${afterCornerX} ${ey} H ${dx}`;
  }
}

export function TimelineGraph({
  snapshot,
  onJumpTo,
  onContextMenu,
  headSha,
  onUnselect,
  focusedBranch,
  onBranchFocus,
}: Props) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const { svgRef, layout, nodeById, transform, hovered, setHovered } =
    useD3Timeline(snapshot);
  const focused = focusedBranch ?? null;

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

  const renderEdge = (e: LaidOutEdge) => {
    const to = nodeById.get(e.toId);
    // For fork/merge, an explicit `toPoint` substitutes for a missing dest
    // node (e.g. a synthetic `selected-*` lane anchor). `within-column` edges
    // always require a real dest node.
    if (!to && (e.kind === "within-column" || !e.toPoint)) return null;
    const branchForColor = e.branch ?? to?.branch ?? "";
    const stroke = displayColor(e.laneColor, branchForColor, focused);
    const opacity = displayOpacity(branchForColor, focused, 0.9);

    if (e.kind === "within-column") {
      const from = nodeById.get(e.fromId);
      if (!from || !to) return null;
      return (
        <line
          key={`${e.fromId}-${e.toId}`}
          x1={from.x}
          y1={from.y}
          x2={to.x}
          y2={to.y}
          stroke={stroke}
          strokeWidth={3}
          opacity={opacity}
        />
      );
    }
    // fork or merge: right-angle path with rounded corner. Source is the
    // fromPoint when set (e.g. trunk anchor for forks-from-non-step), else
    // the lookup node's position. Same posture for the destination via
    // toPoint (synthetic empty-commit selected-* lanes anchor at their badge).
    const from = e.fromPoint ?? nodeById.get(e.fromId);
    const dest = to ?? e.toPoint;
    if (!from || !dest || !e.elbow) return null;
    const d = rightAnglePath(from.x, from.y, e.elbow.x, e.elbow.y, dest.x, dest.y);
    return (
      <path
        key={`${e.fromId}-${e.toId}`}
        d={d}
        fill="none"
        stroke={stroke}
        strokeWidth={3}
        strokeLinecap="round"
        opacity={opacity}
      />
    );
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
          {/* Cycle bands — horizontal background stripes per cycle. */}
          {layout.cycleBands.map((band, i) => {
            const bandWidth = Math.max(layout.width, 480);
            return (
              <g key={`band-${i}-${band.cycleNumber}`} style={{ pointerEvents: "none" }}>
                <rect x={0} y={band.y} width={bandWidth} height={band.height} fill={BAND_TINTS[band.tintIndex]} />
                {band.height >= 18 && (
                  <text
                    x={bandWidth - 8}
                    y={band.y + 12}
                    fontSize={9.5}
                    fontFamily="var(--font-ui, sans-serif)"
                    fontWeight={600}
                    letterSpacing={0.6}
                    fill="var(--foreground-dim, #6c7086)"
                    textAnchor="end"
                    style={{ textTransform: "uppercase" }}
                  >
                    {band.label}
                  </text>
                )}
              </g>
            );
          })}

          {/* Dotted column markers — full canvas height, neutral color. */}
          {layout.dottedMarkers.map((m, i) => (
            <line
              key={`marker-${i}`}
              x1={m.x}
              y1={m.y1}
              x2={m.x}
              y2={m.y2}
              stroke={MARKER_COLOR}
              strokeWidth={1}
              strokeDasharray="2 6"
              opacity={0.5}
            />
          ))}

          {/* Lane segments — solid colored line per branch's [firstRow, lastRow]. */}
          {layout.laneSegments.map((seg, i) => {
            const stroke = displayColor(seg.color, seg.branch, focused);
            const opacity = displayOpacity(seg.branch, focused, 0.85);
            return (
              <line
                key={`seg-${i}-${seg.branch}`}
                x1={seg.x}
                y1={seg.y1}
                x2={seg.x}
                y2={seg.y2}
                stroke={stroke}
                strokeWidth={3}
                opacity={opacity}
              />
            );
          })}

          {/* Edges — within-column (vertical), fork (right-angle), merge (right-angle). */}
          {layout.edges.map(renderEdge)}

          {/* Branch badges. Top-pinned (row 0) for first tenant of each lane;
              mid-canvas (at fork row) for recycled lane tenants. */}
          {layout.branchTitles.map((title) => {
            const col = layout.columns.find((c) => c.columnIndex !== undefined && layout.nodes.some((n) => n.branch === title.branch && n.columnIndex === c.columnIndex)) ??
              layout.columns.find((c) => c.branch === title.branch);
            if (!col) return null;
            const text = badgeText(title.branch);
            const isFocused = focused === title.branch;
            const fill = displayColor(title.laneColor, title.branch, focused);
            const opacity = displayOpacity(title.branch, focused, 1);
            const charW = 7.5;
            // Unselect ✕ lives only on the head badge so duplicate tail badges
            // don't produce duplicate testids or click targets.
            const showUnselect = title.isSelectedLane && !!onUnselect && !title.isTail;
            const xBtnW = showUnselect ? 16 : 0;
            const padInner = 6;
            const labelW = Math.max(text.length * charW, 28) + padInner * 2 + xBtnW;
            const badgeH = 20;
            const badgeX = col.x - labelW / 2;
            const badgeY = title.y + (layout.rowHeight - badgeH) / 2;
            const textX = badgeX + (labelW - xBtnW) / 2;
            return (
              <g
                key={`title-${title.branch}-${title.rowIndex}`}
                data-testid={`branch-badge-${title.branch}${title.isTail ? "-tail" : ""}`}
                opacity={opacity}
              >
                <title>{title.branch}</title>
                <rect
                  x={badgeX}
                  y={badgeY}
                  width={labelW}
                  height={badgeH}
                  rx={4}
                  fill={fill}
                  style={{ cursor: onBranchFocus ? "pointer" : "default" }}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onBranchFocus?.(title.branch);
                  }}
                />
                <text
                  x={textX}
                  y={badgeY + badgeH / 2 + 4}
                  fontSize={11}
                  fontFamily="var(--font-mono, monospace)"
                  fill="#ffffff"
                  textAnchor="middle"
                  fontWeight={isFocused ? 700 : 600}
                  style={{ pointerEvents: "none" }}
                >
                  {text}
                </text>
                {showUnselect && (
                  <g
                    data-testid={`unselect-${title.branch}`}
                    style={{ cursor: "pointer" }}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onUnselect?.(title.branch);
                    }}
                  >
                    <rect
                      x={badgeX + labelW - xBtnW}
                      y={badgeY}
                      width={xBtnW}
                      height={badgeH}
                      fill="transparent"
                    />
                    <text
                      x={badgeX + labelW - xBtnW / 2}
                      y={badgeY + badgeH / 2 + 4}
                      fontSize={12}
                      fill="#ffffff"
                      textAnchor="middle"
                      fontWeight={700}
                      style={{ pointerEvents: "none" }}
                    >
                      ×
                    </text>
                  </g>
                )}
              </g>
            );
          })}

          {/* Dots */}
          {layout.nodes.map((n) => {
            const isHovered = hovered?.id === n.id;
            const isHead = n.node.kind === "step-commit" && headSha === n.node.data.sha;
            const ring = ringFor(n.colorState);
            const dotColor = displayColor(n.laneColor, n.branch, focused);
            const dotOpacity = displayOpacity(n.branch, focused, 1);
            const shortSha = n.node.kind === "step-commit"
              ? (n.node.data as TimelineCommit).shortSha
              : "";
            const testid = n.node.kind === "start"
              ? "timeline-anchor"
              : `timeline-node-${shortSha}`;
            const headOffset = isHead ? 2 : 0;
            const effectiveDotR = DOT_RADIUS + headOffset + (isHovered ? 1 : 0);
            return (
              <g
                key={n.id}
                data-testid={testid}
                transform={`translate(${n.x}, ${n.y})`}
                style={{ cursor: "pointer" }}
                onMouseEnter={() => setHovered(n)}
                onMouseLeave={() => setHovered(null)}
                onClick={() => handleClick(n)}
                onContextMenu={(ev) => handleContextMenu(n, ev)}
                opacity={dotOpacity}
              >
                {isHead && (
                  // Outer halo — frames the HEAD/selected commit so it
                  // reads as "you are here" against the rest of the lane.
                  <>
                    <circle
                      r={effectiveDotR + 6}
                      fill="transparent"
                      stroke="var(--foreground, #fff)"
                      strokeWidth={1.25}
                      opacity={0.35}
                    />
                    <circle
                      r={effectiveDotR + 3}
                      fill="transparent"
                      stroke="var(--foreground, #fff)"
                      strokeWidth={1.5}
                      opacity={0.7}
                    />
                  </>
                )}
                {ring && (
                  <circle
                    r={effectiveDotR + (isHead ? 9 : 3)}
                    fill="transparent"
                    stroke={ring}
                    strokeWidth={2}
                  />
                )}
                {n.isMerge ? (
                  // Merge commit — hollow circle with the lane's stroke color
                  // so the merge structure pops against solid commits.
                  <circle
                    r={effectiveDotR}
                    fill={SURFACE_COLOR}
                    stroke={dotColor}
                    strokeWidth={isHead ? 4 : 3}
                  />
                ) : (
                  <circle
                    r={effectiveDotR}
                    fill={dotColor}
                    stroke={isHead ? "var(--foreground, #fff)" : "transparent"}
                    strokeWidth={isHead ? 2.5 : 0}
                  />
                )}
                {(n.colorState === "selected" || n.colorState === "selected+kept") && !n.isMerge && (
                  <circle r={Math.max(2, effectiveDotR - 1.5)} fill="#ff0000" />
                )}
              </g>
            );
          })}

          {/* Per-dot labels — to the right of each dot. */}
          {layout.nodes
            .filter((n) => n.node.kind === "step-commit")
            .map((n) => {
              const c = n.node.data as TimelineCommit;
              const isHead = headSha === c.sha;
              return (
                <g
                  key={`label-${n.id}`}
                  transform={`translate(${layout.labelGutterX}, ${n.y})`}
                  style={{ pointerEvents: "none" }}
                  opacity={displayOpacity(n.branch, focused, 1)}
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
