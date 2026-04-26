import type {
  TimelineSnapshot,
  TimelineCommit,
  StartingPoint,
} from "../../../core/checkpoints.js";

/**
 * 010 Layout — git-log-style canvas.
 *
 * One row per step-commit, sorted oldest-first. Each commit is positioned at
 * (lane.x, globalRow * rowHeight): the lane (== branch column) determines x;
 * the global row index — shared across all lanes — determines y. This lets a
 * fixed right-side gutter line up SHA + step labels per row, like git-log
 * --graph.
 *
 * Within-lane edges connect consecutive step-commits in the same lane.
 * Cross-lane "branch-off" edges connect a lane's first commit to its parent
 * step-commit when that parent lives in a different lane.
 *
 * Mid-stage WIP commits never appear here — they were filtered out at the
 * source (in `listTimeline`).
 */

export type ColorState = "default" | "selected" | "kept" | "selected+kept";

type TimelineNode =
  | { kind: "start"; data: StartingPoint }
  | { kind: "step-commit"; data: TimelineCommit };

export interface LaidOutNode {
  id: string;
  node: TimelineNode;
  x: number;
  y: number;
  branch: string;
  columnIndex: number;
  /** 0-based row across the entire canvas — drives the right-side label gutter. */
  rowIndex: number;
  colorState: ColorState;
  /** Per-lane palette color (used for the dot fill / stroke). */
  laneColor: string;
}

export interface LaidOutEdge {
  fromId: string;
  toId: string;
  kind: "within-column" | "branch-off" | "to-starting-point" | "trunk-sprout";
  laneColor: string;
  /**
   * Optional explicit source point. When set, the renderer uses these
   * coordinates instead of looking up the from-node's position. Used by
   * "trunk-sprout" edges that originate at (trunkLaneX, target.y) — a phantom
   * point on the main lane at the same row as the target commit, mimicking
   * how mermaid TB sprouts side branches off the trunk at the moment they
   * were created.
   */
  fromPoint?: { x: number; y: number };
}

interface BranchColumn {
  branch: string;
  columnIndex: number;
  x: number;
  isAnchor: boolean;
  laneColor: string;
}

export interface LayoutOutput {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  columns: BranchColumn[];
  width: number;
  height: number;
  /** x-coordinate where SHA labels in the right-side gutter begin. */
  labelGutterX: number;
  rowHeight: number;
  /**
   * The trunk lane's continuous track. Renderers draw this as a single
   * vertical line so main appears as an unbroken trunk regardless of how
   * many step-commits it actually carries. Null when no main/master exists.
   */
  trunkLine: { x: number; y1: number; y2: number; color: string } | null;
}

interface LayoutOpts {
  laneWidth: number;
  rowHeight: number;
  padX?: number;
  padY?: number;
  headerHeight?: number;
  /** Horizontal gap between the rightmost lane and the start of the SHA gutter. */
  gutterGap?: number;
}

const START_NODE_ID = "__start__";

// Six-color lane palette tuned for dark theme. Lane 0 (trunk) is the project
// primary; subsequent lanes cycle through warm/cool hues for visual contrast.
const TRUNK_COLOR = "var(--primary, #5865f2)";
/** Reserved color for transient `selected-*` (010 click-to-jump) lanes. */
const SELECTED_COLOR = "#f59e0b"; // amber — same hue as the pause-pending icon
/** De-emphasized color for `attempt-*-saved` autosave branches. */
const AUTOSAVE_COLOR = "#94a3b8"; // muted gray
const LANE_PALETTE = [
  "#22c55e",  // green
  "#ef4444",  // red
  "#eab308",  // yellow
  "#06b6d4",  // cyan
  "#a855f7",  // purple
  "#ec4899",  // pink
];

/**
 * Deterministic hash → palette-index mapping. Same branch name always gets
 * the same palette slot regardless of which other branches happen to be
 * present in the snapshot. djb2 is good enough for this; collisions just
 * mean two unrelated branches share a color, which is acceptable.
 */
function paletteIndexFor(branch: string): number {
  let h = 5381;
  for (let i = 0; i < branch.length; i++) {
    h = ((h << 5) + h + branch.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % LANE_PALETTE.length;
}

/**
 * Lane color is name-pattern aware. Reserved slots: main/master = primary,
 * `selected-*` = amber (always — distinct so navigation forks pop out),
 * `*-saved` = muted gray. Other branches use the deterministic-by-name
 * palette slot so colors stay stable across snapshot refreshes.
 */
function laneColorFor(branch: string): string {
  if (branch === "main" || branch === "master") return TRUNK_COLOR;
  if (branch.startsWith("selected-")) return SELECTED_COLOR;
  if (branch.endsWith("-saved")) return AUTOSAVE_COLOR;
  return LANE_PALETTE[paletteIndexFor(branch)];
}

function pickColorState(sha: string, selectedSet: Set<string>, keptSet: Set<string>): ColorState {
  const sel = selectedSet.has(sha);
  const kept = keptSet.has(sha);
  if (sel && kept) return "selected+kept";
  if (kept) return "kept";
  if (sel) return "selected";
  return "default";
}

/**
 * Column ordering — gitk convention:
 *
 *   1. `main` (or `master`) is always lane 0 (leftmost). This is the trunk
 *      regardless of how many step-commits it carries — even an anchor-only
 *      main holds the leftmost slot.
 *   2. The starting-point's branch comes next if it isn't main/master.
 *   3. Remaining branches sorted by their first commit's timestamp ascending
 *      (older runs to the left, newer to the right).
 *   4. Branches with no step-commits and that aren't main/master/anchor are
 *      excluded from the column list.
 */
function orderColumns(
  commitsByBranch: Map<string, TimelineCommit[]>,
  startingPoint: StartingPoint | null,
): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const allBranches = new Set([
    ...commitsByBranch.keys(),
    ...(startingPoint ? [startingPoint.branch] : []),
  ]);

  // 1. main / master pin to lane 0.
  for (const trunk of ["main", "master"]) {
    if (allBranches.has(trunk) && !seen.has(trunk)) {
      ordered.push(trunk);
      seen.add(trunk);
    }
  }

  // 2. Starting-point's branch (if not already added).
  if (startingPoint && !seen.has(startingPoint.branch)) {
    ordered.push(startingPoint.branch);
    seen.add(startingPoint.branch);
  }

  // 3. Remaining branches by first-commit timestamp ascending (oldest to the
  //    left). Branches with no step-commits are skipped.
  const remaining = [...commitsByBranch.entries()]
    .filter(([branch]) => !seen.has(branch))
    .sort((a, b) => a[1][0].timestamp.localeCompare(b[1][0].timestamp))
    .map(([branch]) => branch);
  for (const b of remaining) {
    ordered.push(b);
    seen.add(b);
  }
  return ordered;
}

export function layoutTimeline(
  snapshot: TimelineSnapshot,
  opts: LayoutOpts,
): LayoutOutput {
  const padX = opts.padX ?? 24;
  const padY = opts.padY ?? 16;
  const headerHeight = opts.headerHeight ?? 24;
  const gutterGap = opts.gutterGap ?? 24;
  const rowHeight = opts.rowHeight;

  const commits = snapshot.commits;
  const commitBySha = new Map<string, TimelineCommit>();
  const commitsByBranch = new Map<string, TimelineCommit[]>();
  for (const c of commits) {
    commitBySha.set(c.sha, c);
    let arr = commitsByBranch.get(c.branch);
    if (!arr) {
      arr = [];
      commitsByBranch.set(c.branch, arr);
    }
    arr.push(c);
  }

  const selectedSet = new Set(snapshot.selectedPath);
  const keptSet = new Set(
    snapshot.checkpoints
      .filter((c) => !c.unavailable && c.sha)
      .map((c) => c.sha),
  );

  const orderedBranches = orderColumns(commitsByBranch, snapshot.startingPoint);
  const columns: BranchColumn[] = orderedBranches.map((branch, idx) => ({
    branch,
    columnIndex: idx,
    x: padX + idx * opts.laneWidth,
    isAnchor: snapshot.startingPoint?.branch === branch,
    laneColor: laneColorFor(branch),
  }));
  const columnOf = new Map(columns.map((c) => [c.branch, c]));

  // Global row index: each commit gets a unique y coordinate, sorted oldest-first.
  // The starting-point anchor (if rendered) takes row 0; commits start at row 1.
  const nodes: LaidOutNode[] = [];
  const edges: LaidOutEdge[] = [];

  let nextRow = 0;
  if (snapshot.startingPoint && columnOf.has(snapshot.startingPoint.branch)) {
    const col = columnOf.get(snapshot.startingPoint.branch)!;
    nodes.push({
      id: START_NODE_ID,
      node: { kind: "start", data: snapshot.startingPoint },
      x: col.x,
      y: padY + headerHeight + nextRow * rowHeight,
      branch: col.branch,
      columnIndex: col.columnIndex,
      rowIndex: nextRow,
      colorState: selectedSet.has(snapshot.startingPoint.sha) ? "selected" : "default",
      laneColor: col.laneColor,
    });
    nextRow += 1;
  }

  // Track per-lane "previous commit id" for within-column edges.
  const prevInLane = new Map<string, string | null>();
  // Anchor lane's previous = anchor (so first commit in anchor lane connects to start).
  if (snapshot.startingPoint && columnOf.has(snapshot.startingPoint.branch)) {
    prevInLane.set(snapshot.startingPoint.branch, START_NODE_ID);
  }

  for (const commit of commits) {
    const col = columnOf.get(commit.branch);
    if (!col) continue; // commit's branch wasn't visible — skip silently.
    const rowIndex = nextRow++;
    nodes.push({
      id: commit.sha,
      node: { kind: "step-commit", data: commit },
      x: col.x,
      y: padY + headerHeight + rowIndex * rowHeight,
      branch: col.branch,
      columnIndex: col.columnIndex,
      rowIndex,
      colorState: pickColorState(commit.sha, selectedSet, keptSet),
      laneColor: col.laneColor,
    });

    const prev = prevInLane.get(col.branch) ?? null;
    const trunkColX = columns[0]?.x;
    if (prev !== null) {
      edges.push({
        fromId: prev,
        toId: commit.sha,
        kind: prev === START_NODE_ID ? "to-starting-point" : "within-column",
        laneColor: col.laneColor,
      });
    } else {
      // First commit in a non-trunk lane → sprout from the trunk's lane at
      // the same row as this commit. That visual matches mermaid TB: a smooth
      // arc emerges from main's vertical track at the time the side branch
      // was created.
      if (commit.parentSha && commitBySha.has(commit.parentSha)) {
        const parentCommit = commitBySha.get(commit.parentSha)!;
        const parentCol = columnOf.get(parentCommit.branch);
        if (parentCol && parentCol.columnIndex !== col.columnIndex) {
          // Parent is on a step-commit in another lane — connect directly to it.
          edges.push({
            fromId: commit.parentSha,
            toId: commit.sha,
            kind: "branch-off",
            laneColor: col.laneColor,
          });
        }
      } else if (trunkColX !== undefined) {
        // No step-commit ancestor in our set — sprout off the trunk lane at
        // the row of this commit (phantom point on main's continuous track).
        edges.push({
          fromId: `__trunk_at_${commit.sha}__`,
          toId: commit.sha,
          kind: "trunk-sprout",
          laneColor: col.laneColor,
          fromPoint: {
            x: trunkColX,
            y: padY + headerHeight + rowIndex * rowHeight,
          },
        });
      }
    }
    prevInLane.set(col.branch, commit.sha);
  }

  // Bounding box.
  const colCount = Math.max(columns.length, 1);
  const lastLaneX = padX + (colCount - 1) * opts.laneWidth;
  const labelGutterX = lastLaneX + gutterGap;
  // Rough estimate of label width — narrow enough that the canvas isn't huge,
  // wide enough to fit "shortSha · step · cycle N · branch-tail".
  const labelWidth = 280;
  const width = Math.max(labelGutterX + labelWidth + padX, 480);
  const lastRowY = padY + headerHeight + Math.max(nextRow - 1, 0) * rowHeight;
  const height = Math.max(padY * 2 + headerHeight + Math.max(nextRow, 1) * rowHeight, 200);

  // Trunk line — the leftmost column's continuous vertical track. Drawn from
  // the anchor row to the last commit row so main appears as an unbroken
  // backbone even when it carries no step-commits beyond the anchor.
  let trunkLine: LayoutOutput["trunkLine"] = null;
  if (columns.length > 0 && nextRow > 0) {
    const trunkCol = columns[0];
    trunkLine = {
      x: trunkCol.x,
      y1: padY + headerHeight,
      y2: lastRowY,
      color: trunkCol.laneColor,
    };
  }

  return { nodes, edges, columns, width, height, labelGutterX, rowHeight, trunkLine };
}
