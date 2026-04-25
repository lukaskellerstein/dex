import type {
  TimelineSnapshot,
  CheckpointInfo,
  AttemptInfo,
  PendingCandidate,
  StartingPoint,
} from "../../../core/checkpoints.js";

export type TimelineNode =
  | { kind: "start"; data: StartingPoint }
  | { kind: "checkpoint"; data: CheckpointInfo }
  | { kind: "attempt"; data: AttemptInfo }
  | { kind: "pending"; data: PendingCandidate };

export interface LaidOutNode {
  id: string;
  node: TimelineNode;
  x: number;
  y: number;
  lane: "canonical" | "attempt" | "variant";
  laneIndex: number;
  laneColor: string;
  cycleNumber: number;
  unavailable: boolean;
}

export interface LaidOutEdge {
  fromId: string;
  toId: string;
  kind: "canonical" | "branch-off";
}

export interface LayoutOutput {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  width: number;
  height: number;
}

export interface LayoutOpts {
  columnWidth: number;
  rowHeight: number;
  padX?: number;
  padY?: number;
}

const COLOR_CANONICAL = "var(--primary, #7c3aed)";
const COLOR_ATTEMPT = "#5865f2";
const COLOR_VARIANT = "#22c55e";
const COLOR_START = "var(--foreground-muted, #94a3b8)";

const START_NODE_ID = "__start__";

/**
 * Pure deterministic layout fn. Canonical checkpoints in column 0, attempts in
 * column 1+, variant siblings share adjacent columns.
 */
export function layoutTimeline(
  snapshot: TimelineSnapshot,
  opts: LayoutOpts,
): LayoutOutput {
  const padX = opts.padX ?? 32;
  const padY = opts.padY ?? 24;

  const nodes: LaidOutNode[] = [];
  const edges: LaidOutEdge[] = [];

  // Starting point — anchor at top of canonical lane when known. Acts as the
  // visual root the first checkpoint branches off from, and is the only node
  // shown on a fresh project with no run history.
  const hasStart = snapshot.startingPoint !== null;
  if (snapshot.startingPoint) {
    nodes.push({
      id: START_NODE_ID,
      node: { kind: "start", data: snapshot.startingPoint },
      x: padX,
      y: padY,
      lane: "canonical",
      laneIndex: 0,
      laneColor: COLOR_START,
      cycleNumber: 0,
      unavailable: false,
    });
  }
  const canonicalOffset = hasStart ? 1 : 0;

  // Canonical checkpoints go on lane 0, ordered by timestamp (already sorted
  // ascending by listTimeline). Skip the synthetic "done-*" entries for layout.
  const canonicals = snapshot.checkpoints.filter((c) => !c.tag.startsWith("checkpoint/done-"));
  for (let i = 0; i < canonicals.length; i++) {
    const c = canonicals[i];
    nodes.push({
      id: c.tag,
      node: { kind: "checkpoint", data: c },
      x: padX,
      y: padY + (i + canonicalOffset) * opts.rowHeight,
      lane: "canonical",
      laneIndex: 0,
      laneColor: COLOR_CANONICAL,
      cycleNumber: c.cycleNumber,
      unavailable: Boolean(c.unavailable),
    });
    if (i === 0 && hasStart) {
      edges.push({
        fromId: START_NODE_ID,
        toId: c.tag,
        kind: "canonical",
      });
    } else if (i > 0) {
      edges.push({
        fromId: canonicals[i - 1].tag,
        toId: c.tag,
        kind: "canonical",
      });
    }
  }

  // Group attempts by variant group (branches sharing a "-<letter>" suffix).
  // For v1 we place each attempt in its own lane in order; variant siblings
  // get adjacent lanes for visual grouping. Lane index starts at 1.
  const attempts = [...snapshot.attempts].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  let nextLane = 1;
  for (const a of attempts) {
    const lane = nextLane++;
    const kind: "attempt" | "variant" = a.variantGroup ? "variant" : "attempt";
    const color = kind === "variant" ? COLOR_VARIANT : COLOR_ATTEMPT;

    // Anchor y to the parent checkpoint's row if known, else append below canonical.
    let y: number;
    if (a.baseCheckpoint) {
      const parent = nodes.find((n) => n.id === a.baseCheckpoint);
      y = parent
        ? parent.y + opts.rowHeight
        : padY + (canonicals.length + canonicalOffset) * opts.rowHeight + (lane - 1) * opts.rowHeight;
    } else {
      y = padY + (canonicals.length + canonicalOffset) * opts.rowHeight + (lane - 1) * opts.rowHeight;
    }

    nodes.push({
      id: a.branch,
      node: { kind: "attempt", data: a },
      x: padX + lane * opts.columnWidth,
      y,
      lane: kind,
      laneIndex: lane,
      laneColor: color,
      cycleNumber: 0,
      unavailable: false,
    });

    if (a.baseCheckpoint) {
      edges.push({
        fromId: a.baseCheckpoint,
        toId: a.branch,
        kind: "branch-off",
      });
    }
  }

  // Pending candidates — draw on the canonical lane as small "ghost" circles
  // above the tag location. In practice listTimeline already filters them out
  // if an existing tag covers the same sha; what remains is step-mode pending.
  for (const p of snapshot.pending) {
    const id = `pending:${p.candidateSha}`;
    // Stack pending nodes in a dedicated column to the right of attempts.
    const lane = nextLane++;
    nodes.push({
      id,
      node: { kind: "pending", data: p },
      x: padX + lane * opts.columnWidth,
      y: padY + (canonicals.length + canonicalOffset) * opts.rowHeight + (lane - 1) * opts.rowHeight,
      lane: "attempt",
      laneIndex: lane,
      laneColor: COLOR_ATTEMPT,
      cycleNumber: p.cycleNumber,
      unavailable: false,
    });
  }

  const canonicalRows = canonicals.length + canonicalOffset;
  const width = Math.max(padX + nextLane * opts.columnWidth + padX, 320);
  const height = Math.max(
    padY * 2 + Math.max(canonicalRows, 1) * opts.rowHeight,
    padY * 2 + attempts.length * opts.rowHeight,
    200,
  );

  return { nodes, edges, width, height };
}
