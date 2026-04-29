import type {
  TimelineSnapshot,
  TimelineCommit,
  StartingPoint,
} from "../../../core/checkpoints.js";

/**
 * Git-tree timeline layout.
 *
 * Each commit lives in EXACTLY ONE lane (its canonical branch). Branches
 * sprout from their parent branch via a right-angle fork edge and may merge
 * back via a right-angle merge edge. Lanes are recycled: when a branch
 * ends, its column becomes available for the next branch that forks later
 * on. Branch labels live in a single header row at the top of the canvas
 * (one badge per lane); recycled lanes get an additional badge at the
 * fork-row of each subsequent tenant.
 *
 *   row 0   ── top header row (branch badges)
 *   row 1+  ── one row per step-commit, sorted oldest-first
 *
 * Lane geometry:
 *   • main = lane 0 (always).
 *   • Other branches: greedy leftmost-free allocation by [forkRow, lastRow].
 *
 * Edge geometry (right-angle paths with rounded corners, like a metro map):
 *   • within-column: a vertical segment within one lane.
 *   • fork:   M sourceX,sourceY  H elbow.x-r  Q elbow.x,sourceY elbow.x,sourceY+r  V destY
 *   • merge:  M sourceX,sourceY  V destY-r    Q sourceX,destY sourceX-r,destY      H destX
 *   The renderer constructs the path from the precomputed `elbow` point.
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
  rowIndex: number;
  colorState: ColorState;
  laneColor: string;
  /**
   * True when this commit is a merge commit (parents.length > 1). The
   * renderer paints these as hollow circles so the merge structure pops.
   */
  isMerge?: boolean;
}

export interface LaidOutEdge {
  fromId: string;
  toId: string;
  kind: "within-column" | "fork" | "merge";
  laneColor: string;
  /**
   * Corner point for fork/merge edges. The renderer uses this with the
   * source and destination node positions to draw a right-angle path with a
   * rounded corner. Undefined for within-column edges (straight vertical).
   */
  elbow?: { x: number; y: number };
  /**
   * Explicit source point — used when the edge's source isn't a step-commit
   * node (e.g. a feature branch forking from main's pre-checkpoint anchor).
   * The renderer reads this instead of looking up the source node by id.
   */
  fromPoint?: { x: number; y: number };
  /**
   * Explicit destination point — used when the edge's destination isn't a
   * step-commit node (e.g. a fresh `selected-*` branch with no canonical
   * commits yet, forking up to its lane's badge anchor). The renderer reads
   * this instead of looking up the dest node by id.
   */
  toPoint?: { x: number; y: number };
  /**
   * Override branch identity for color / focused-lane logic. Defaults to
   * the destination node's branch when absent. Required when toPoint is
   * used because there's no destination node to read .branch from.
   */
  branch?: string;
}

export interface BranchColumn {
  /** Primary (oldest) tenant of this lane — drives the top-header badge. */
  branch: string;
  columnIndex: number;
  x: number;
  isAnchor: boolean;
  laneColor: string;
}

/**
 * Solid colored vertical segment for one branch's active lifespan
 * (firstRow → lastRow). Multiple segments can share the same `x` when a
 * lane is recycled — each is a distinct branch with its own color.
 */
export interface LaneSegment {
  branch: string;
  x: number;
  y1: number;
  y2: number;
  color: string;
}

/**
 * Faint dotted column marker — full canvas height for every non-trunk
 * lane. Provides the "ghost rail" the user can read even when a lane has
 * no active branch in a region. Neutral color (not lane-colored).
 */
export interface DottedMarker {
  x: number;
  y1: number;
  y2: number;
}

export interface CycleBand {
  cycleNumber: number;
  label: string;
  y: number;
  height: number;
  tintIndex: 0 | 1;
}

/**
 * Branch label. Each lane gets at least two badges: a head at the top of
 * its lifespan (row 0 for first tenant; fork-row for recycled tenants) and
 * a tail one row below `lastRow`. The tail keeps the branch identity in
 * view when the user has scrolled past the top header — without it, lanes
 * become anonymous strands at the bottom of long timelines.
 */
export interface BranchTitle {
  branch: string;
  laneColor: string;
  y: number;
  rowIndex: number;
  /** True if this is the top-header (row 0) badge; false for recycled-lane mid-canvas badges. */
  isTopHeader: boolean;
  isSelectedLane: boolean;
  /** True for the bottom badge repeated at lastRow + 1; false for head/recycled badges. */
  isTail: boolean;
}

export interface LayoutOutput {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  columns: BranchColumn[];
  width: number;
  height: number;
  labelGutterX: number;
  rowHeight: number;
  /** Solid colored lane segments — one per branch's active lifespan. */
  laneSegments: LaneSegment[];
  /** Dotted column markers — full canvas height, non-trunk lanes only. */
  dottedMarkers: DottedMarker[];
  cycleBands: CycleBand[];
  branchTitles: BranchTitle[];
}

interface LayoutOpts {
  laneWidth: number;
  rowHeight: number;
  padX?: number;
  padY?: number;
  headerHeight?: number;
  gutterGap?: number;
}

const TRUNK_COLOR = "var(--primary, #5865f2)";
const SELECTED_COLOR = "#f59e0b";
const AUTOSAVE_COLOR = "#94a3b8";
const MARKER_COLOR = "#4a4d63";

function buildLanePalette(n: number): string[] {
  const palette: string[] = [];
  for (let i = 0; i < n; i++) {
    const hue = Math.round((360 * i) / n);
    const lightness = i % 2 === 0 ? 55 : 65;
    palette.push(`hsl(${hue}, 65%, ${lightness}%)`);
  }
  return palette;
}

const LANE_PALETTE = buildLanePalette(50);

function paletteIndexFor(branch: string): number {
  let h = 5381;
  for (let i = 0; i < branch.length; i++) {
    h = ((h << 5) + h + branch.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % LANE_PALETTE.length;
}

function laneColorFor(branch: string): string {
  if (branch === "main" || branch === "master") return TRUNK_COLOR;
  if (branch.startsWith("selected-")) return SELECTED_COLOR;
  if (branch.endsWith("-saved")) return AUTOSAVE_COLOR;
  return LANE_PALETTE[paletteIndexFor(branch)];
}

function cycleLabel(cycleNumber: number): string {
  if (cycleNumber === 0) return "Clarification";
  if (cycleNumber < 0) return "Run Complete";
  return `Cycle ${cycleNumber}`;
}

function pickColorState(sha: string, selectedSet: Set<string>, keptSet: Set<string>): ColorState {
  const sel = selectedSet.has(sha);
  const kept = keptSet.has(sha);
  if (sel && kept) return "selected+kept";
  if (kept) return "kept";
  if (sel) return "selected";
  return "default";
}

function isTrunk(branch: string): boolean {
  return branch === "main" || branch === "master";
}

interface BranchInfo {
  branch: string;
  firstRow: number;
  lastRow: number;
  /** Row of the parent commit on its parent branch (where this branch sprouted). */
  forkRow: number;
  /** Parent SHA on the parent branch. Undefined for trunk or for branches whose parent isn't visible. */
  forkParentSha: string | null;
}

/**
 * Chronological lane allocation. Trunk = lane 0. Every other branch gets a
 * dedicated lane assigned in forkRow order: branches that sprouted earlier
 * land further left, the most-recently-forked branch always sits at the
 * far right. Lanes are NOT recycled — even when an old branch ends well
 * before a new one forks, the old branch keeps its column. The tradeoff
 * is canvas width vs. visual stability: users coming back to the timeline
 * always find the newest activity on the right edge.
 */
function allocateLanes(infos: BranchInfo[]): Map<string, number> {
  const branchLane = new Map<string, number>();

  // Trunk first. Then sort by forkRow ascending — this is the chronological
  // order the user sees. lastRow + branch name are deterministic tiebreakers.
  const sorted = [...infos].sort((a, b) => {
    const ta = isTrunk(a.branch);
    const tb = isTrunk(b.branch);
    if (ta && !tb) return -1;
    if (tb && !ta) return 1;
    if (a.forkRow !== b.forkRow) return a.forkRow - b.forkRow;
    if (a.lastRow !== b.lastRow) return a.lastRow - b.lastRow;
    return a.branch.localeCompare(b.branch);
  });

  let nextLane = 1;
  for (const info of sorted) {
    if (isTrunk(info.branch)) {
      branchLane.set(info.branch, 0);
      continue;
    }
    branchLane.set(info.branch, nextLane);
    nextLane += 1;
  }
  return branchLane;
}

export function layoutTimeline(
  snapshot: TimelineSnapshot,
  opts: LayoutOpts,
): LayoutOutput {
  const padX = opts.padX ?? 24;
  const padY = opts.padY ?? 16;
  const headerHeight = opts.headerHeight ?? 8;
  const gutterGap = opts.gutterGap ?? 24;
  const rowHeight = opts.rowHeight;

  const commits = [...snapshot.commits].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );

  // Row assignment: row 0 reserved for the top-header badge strip; commits
  // start at row 1.
  const HEADER_ROW = 0;
  const FIRST_COMMIT_ROW = 1;
  const rowOf = new Map<string, number>();
  commits.forEach((c, i) => rowOf.set(c.sha, FIRST_COMMIT_ROW + i));

  const yForRow = (r: number) => padY + headerHeight + r * rowHeight;

  // Group canonical commits by branch.
  const commitsByBranch = new Map<string, TimelineCommit[]>();
  for (const c of commits) {
    let arr = commitsByBranch.get(c.branch);
    if (!arr) {
      arr = [];
      commitsByBranch.set(c.branch, arr);
    }
    arr.push(c);
  }

  // Per-branch lifespan info.
  const branchInfos: BranchInfo[] = [];
  for (const [branch, branchCommits] of commitsByBranch) {
    if (branchCommits.length === 0) continue;
    const firstCommit = branchCommits[0];
    const lastCommit = branchCommits[branchCommits.length - 1];
    const firstRow = rowOf.get(firstCommit.sha)!;
    const lastRow = rowOf.get(lastCommit.sha)!;
    const forkParentSha = firstCommit.parentSha;
    const forkRow = forkParentSha
      ? rowOf.get(forkParentSha) ?? Math.max(0, firstRow - 1)
      : Math.max(0, firstRow - 1);
    branchInfos.push({ branch, firstRow, lastRow, forkRow, forkParentSha });
  }

  // Inject the trunk into branchInfos if missing — keeps lane 0 reserved
  // even when main has no step-commits in this snapshot.
  if (!branchInfos.some((b) => isTrunk(b.branch))) {
    if (snapshot.startingPoint && isTrunk(snapshot.startingPoint.branch)) {
      const r = HEADER_ROW + 1;
      branchInfos.push({
        branch: snapshot.startingPoint.branch,
        firstRow: r,
        lastRow: r,
        forkRow: HEADER_ROW,
        forkParentSha: null,
      });
    }
  }

  // Inject the current `selected-*` branch when it has no canonical commits
  // yet — fresh forks created by Timeline click-to-jump (jumpTo case 7) point
  // at SHAs already owned by a higher-priority lane (main/dex/*/attempt-*),
  // so without this the just-created branch has no lane and the user gets no
  // immediate visual feedback that their click took effect. Anchor the
  // synthetic info at HEAD's row so a fork edge can connect to the original
  // commit's dot.
  const cur = snapshot.currentBranch;
  if (
    cur &&
    cur.startsWith("selected-") &&
    !branchInfos.some((b) => b.branch === cur) &&
    snapshot.selectedPath.length > 0
  ) {
    const headSha = snapshot.selectedPath[snapshot.selectedPath.length - 1];
    const headRow = rowOf.get(headSha);
    if (headRow !== undefined) {
      branchInfos.push({
        branch: cur,
        firstRow: headRow,
        lastRow: headRow,
        forkRow: headRow,
        forkParentSha: headSha,
      });
    }
  }

  const branchLane = allocateLanes(branchInfos);
  const branchByLane = new Map<number, BranchInfo[]>();
  for (const info of branchInfos) {
    const lane = branchLane.get(info.branch)!;
    if (!branchByLane.has(lane)) branchByLane.set(lane, []);
    branchByLane.get(lane)!.push(info);
  }
  // Sort each lane's tenants by fork-row so the FIRST tenant is the lane's "primary".
  for (const tenants of branchByLane.values()) {
    tenants.sort((a, b) => a.forkRow - b.forkRow);
  }

  // Build columns. One per lane (regardless of how many tenants share it).
  const maxLane = Math.max(0, ...branchLane.values());
  const columns: BranchColumn[] = [];
  for (let i = 0; i <= maxLane; i++) {
    const tenants = branchByLane.get(i);
    if (!tenants || tenants.length === 0) continue;
    const primary = tenants[0];
    columns.push({
      branch: primary.branch,
      columnIndex: i,
      x: padX + i * opts.laneWidth,
      isAnchor: snapshot.startingPoint?.branch === primary.branch,
      laneColor: laneColorFor(primary.branch),
    });
  }
  const laneToCol = new Map(columns.map((c) => [c.columnIndex, c]));

  // Build nodes — one per commit in its canonical lane.
  const selectedSet = new Set(snapshot.selectedPath);
  const keptSet = new Set(
    snapshot.checkpoints.filter((c) => !c.unavailable && c.sha).map((c) => c.sha),
  );
  const nodes: LaidOutNode[] = [];
  for (const commit of commits) {
    const lane = branchLane.get(commit.branch);
    if (lane === undefined) continue;
    const col = laneToCol.get(lane);
    if (!col) continue;
    const rowIndex = rowOf.get(commit.sha)!;
    nodes.push({
      id: commit.sha,
      node: { kind: "step-commit", data: commit },
      x: col.x,
      y: yForRow(rowIndex),
      branch: commit.branch,
      columnIndex: lane,
      rowIndex,
      colorState: pickColorState(commit.sha, selectedSet, keptSet),
      laneColor: laneColorFor(commit.branch),
      isMerge: commit.mergedParentShas.length > 0,
    });
  }
  const nodeBySha = new Map(nodes.map((n) => [n.id, n]));

  // Edges.
  const edges: LaidOutEdge[] = [];

  // Within-column edges: consecutive canonical commits in same branch.
  for (const branchCommits of commitsByBranch.values()) {
    for (let i = 1; i < branchCommits.length; i++) {
      const fromId = branchCommits[i - 1].sha;
      const toId = branchCommits[i].sha;
      const branch = branchCommits[i].branch;
      edges.push({
        fromId,
        toId,
        kind: "within-column",
        laneColor: laneColorFor(branch),
      });
    }
  }

  // Fork edges. For each non-trunk branch, draw a right-angle path from
  // its fork-parent commit's canonical position to its first canonical
  // commit. The elbow sits at the destination column's X, at the source's Y.
  //
  // Special case: if the parent SHA isn't a step-commit (e.g. dex/* runs
  // forking from main's pre-checkpoint starting-point), anchor the fork
  // on the trunk's lane at row 1 (just below the top header) — the
  // implicit "trunk backbone" point. Multiple branches forking from the
  // same non-step main commit will all originate from this single anchor.
  const trunkLaneCol = laneToCol.get(0);
  const trunkAnchorY = yForRow(FIRST_COMMIT_ROW);
  for (const info of branchInfos) {
    if (isTrunk(info.branch)) continue;
    const branchCommits = commitsByBranch.get(info.branch);
    const laneCol = laneToCol.get(branchLane.get(info.branch)!);

    // Synthetic empty-commit branch (fresh `selected-*` from jumpTo case 7) —
    // draw a short fork stub from the parent commit going sideways into the
    // synthetic lane and dropping just under half a row so it visibly forks
    // off without crossing the next commit's row or chasing the badge all
    // the way up to the canvas top. Path: parent → elbow at (laneX, parent.y)
    // → drop to (laneX, parent.y + rowHeight/2).
    if ((!branchCommits || branchCommits.length === 0) && laneCol) {
      const parent = info.forkParentSha ? nodeBySha.get(info.forkParentSha) : undefined;
      if (!parent) continue;
      edges.push({
        fromId: parent.id,
        toId: `__synth_lane_anchor__${info.branch}`,
        kind: "fork",
        laneColor: laneColorFor(info.branch),
        elbow: { x: laneCol.x, y: parent.y },
        toPoint: { x: laneCol.x, y: parent.y + rowHeight * 0.5 },
        branch: info.branch,
      });
      continue;
    }

    if (!branchCommits || branchCommits.length === 0) continue;
    const child = nodeBySha.get(branchCommits[0].sha);
    if (!child) continue;

    let sourceX: number;
    let sourceY: number;
    let fromId: string;
    let fromPoint: { x: number; y: number } | undefined;

    const parent = info.forkParentSha ? nodeBySha.get(info.forkParentSha) : undefined;
    if (parent) {
      sourceX = parent.x;
      sourceY = parent.y;
      fromId = parent.id;
    } else if (trunkLaneCol) {
      sourceX = trunkLaneCol.x;
      sourceY = trunkAnchorY;
      fromId = `__trunk_anchor__${info.branch}`;
      fromPoint = { x: sourceX, y: sourceY };
    } else {
      continue;
    }

    edges.push({
      fromId,
      toId: child.id,
      kind: "fork",
      laneColor: laneColorFor(info.branch),
      elbow: { x: child.x, y: sourceY },
      ...(fromPoint ? { fromPoint } : {}),
    });
  }

  // Merge edges. For each merge commit, draw a right-angle path from each
  // merged parent's canonical position back to the merge commit. The elbow
  // sits at the merged parent's X, at the merge commit's Y.
  for (const commit of commits) {
    if (commit.mergedParentShas.length === 0) continue;
    const merge = nodeBySha.get(commit.sha);
    if (!merge) continue;
    for (const mergedSha of commit.mergedParentShas) {
      const mergedTip = nodeBySha.get(mergedSha);
      if (!mergedTip) continue;
      edges.push({
        fromId: mergedTip.id,
        toId: commit.sha,
        kind: "merge",
        laneColor: laneColorFor(mergedTip.branch),
        elbow: { x: mergedTip.x, y: merge.y },
      });
    }
  }

  // Lane segments — solid colored line per branch's first→last commit row.
  const laneSegments: LaneSegment[] = [];
  for (const info of branchInfos) {
    const col = laneToCol.get(branchLane.get(info.branch)!);
    if (!col) continue;
    const branchCommits = commitsByBranch.get(info.branch);
    if (!branchCommits || branchCommits.length === 0) continue;
    const firstRow = rowOf.get(branchCommits[0].sha)!;
    const lastRow = rowOf.get(branchCommits[branchCommits.length - 1].sha)!;
    if (firstRow === lastRow) continue; // single-commit branch — no segment to draw
    laneSegments.push({
      branch: info.branch,
      x: col.x,
      y1: yForRow(firstRow),
      y2: yForRow(lastRow),
      color: laneColorFor(info.branch),
    });
  }

  // Trunk backbone — when main has no canonical step-commits (typical for
  // dex's "every run forks fresh from main" pattern), draw its lane as a
  // continuous line from the trunk anchor to the bottom of the canvas so
  // the trunk is still visible in the layout.
  if (
    trunkLaneCol &&
    !commitsByBranch.has(trunkLaneCol.branch) &&
    commits.length > 0
  ) {
    const lastRow = FIRST_COMMIT_ROW + commits.length - 1;
    laneSegments.push({
      branch: trunkLaneCol.branch,
      x: trunkLaneCol.x,
      y1: trunkAnchorY,
      y2: yForRow(lastRow),
      color: laneColorFor(trunkLaneCol.branch),
    });
  }

  // Bounding box. One extra row below the last commit reserves space for
  // the per-lane tail badges (rendered at lastRow + 1).
  const lastCol = columns[columns.length - 1];
  const lastLaneX = lastCol ? lastCol.x : padX;
  const labelGutterX = lastLaneX + gutterGap;
  const labelWidth = 280;
  const width = Math.max(labelGutterX + labelWidth + padX, 480);
  const totalRows = FIRST_COMMIT_ROW + commits.length + 1;
  const height = Math.max(padY * 2 + headerHeight + totalRows * rowHeight, 200);

  // Dotted column markers — full canvas height for non-trunk lanes.
  const markerY1 = padY + headerHeight;
  const markerY2 = height - padY;
  const dottedMarkers: DottedMarker[] = columns
    .filter((c) => c.columnIndex > 0)
    .map((c) => ({ x: c.x, y1: markerY1, y2: markerY2 }));

  // Cycle bands — group consecutive rows by cycleNumber.
  const cycleBands: CycleBand[] = [];
  const stepRows: Array<{ row: number; cycle: number }> = [];
  for (const n of nodes) {
    if (n.node.kind === "step-commit") {
      stepRows.push({ row: n.rowIndex, cycle: n.node.data.cycleNumber });
    }
  }
  if (stepRows.length > 0) {
    stepRows.sort((a, b) => a.row - b.row);
    const halfRow = rowHeight / 2;
    let bandStart = stepRows[0].row;
    let bandCycle = stepRows[0].cycle;
    let tintToggle: 0 | 1 = 0;
    const flush = (endExclusiveRow: number) => {
      cycleBands.push({
        cycleNumber: bandCycle,
        label: cycleLabel(bandCycle),
        y: padY + headerHeight + bandStart * rowHeight - halfRow,
        height: (endExclusiveRow - bandStart) * rowHeight,
        tintIndex: tintToggle,
      });
      tintToggle = tintToggle === 0 ? 1 : 0;
    };
    for (let i = 1; i < stepRows.length; i++) {
      const { row, cycle } = stepRows[i];
      if (cycle !== bandCycle) {
        flush(row);
        bandStart = row;
        bandCycle = cycle;
      }
    }
    flush(stepRows[stepRows.length - 1].row + 1);
  }

  // Branch titles — top-pinned (row 0) for first tenant of each lane;
  // mid-canvas (at fork row) for recycled-lane tenants. Plus a tail badge
  // per multi-commit branch at lastRow + 1 so the branch identity stays
  // visible when the canvas scrolls past the top header.
  const branchTitles: BranchTitle[] = [];
  for (const tenants of branchByLane.values()) {
    tenants.forEach((info, i) => {
      const isFirst = i === 0;
      const rowIndex = isFirst ? HEADER_ROW : info.forkRow;
      branchTitles.push({
        branch: info.branch,
        laneColor: laneColorFor(info.branch),
        y: yForRow(rowIndex),
        rowIndex,
        isTopHeader: isFirst,
        isSelectedLane: info.branch.startsWith("selected-"),
        isTail: false,
      });
    });
  }
  for (const info of branchInfos) {
    // Single-commit lanes don't need a tail — the head badge is one row above.
    if (info.firstRow === info.lastRow) continue;
    const tailRow = info.lastRow + 1;
    branchTitles.push({
      branch: info.branch,
      laneColor: laneColorFor(info.branch),
      y: yForRow(tailRow),
      rowIndex: tailRow,
      isTopHeader: false,
      isSelectedLane: info.branch.startsWith("selected-"),
      isTail: true,
    });
  }

  return {
    nodes,
    edges,
    columns,
    width,
    height,
    labelGutterX,
    rowHeight,
    laneSegments,
    dottedMarkers,
    cycleBands,
    branchTitles,
  };
}

// Re-exports for tests that referenced the marker constant.
export { MARKER_COLOR };
