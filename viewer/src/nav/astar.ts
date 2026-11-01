/**
 * Namma Space: walkable-path planner (Round 2)
 * A* over the NavGrid walking mask (free_bits_b64, already grown by agent_radius_m), 8-connected
 * with no corner cutting. Steps near walls and furniture cost more, so routes keep to the middle of
 * gaps instead of scraping edges. The cell path is then shortened with line-of-sight checks that
 * never bring it closer to an obstacle than A* already went.
 */

import type { NavGrid } from '../contracts/types.js';
import { decodeBase64ToBytes, distanceToCells } from '../collision/grid.js';

export interface Point2 {
  x: number;
  z: number;
}

export interface NavPath {
  /** World waypoints on the floor, start first; the first and last are the snapped start and goal. */
  points: Point2[];
  lengthM: number;
}

/** Clearance (m) below which a step costs extra; and how much extra at zero clearance. */
export const PREFERRED_CLEARANCE_M = 0.45;
export const NEAR_OBSTACLE_PENALTY = 2.5;
/** How far a start or goal may be moved to reach a walkable cell (POIs often sit on furniture). */
export const MAX_SNAP_M = 2.0;
/** A tag placed anywhere (on a bunk, a wall) routes to the closest floor cell within this distance */
export const GOAL_SNAP_M = 6.0;

const SQRT2 = Math.SQRT2;
const NEIGHBOURS: [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
];

/** Walking mask, 1 = free, row-major (row = z, column = x), from free_bits_b64 (MSB first). */
export function decodeWalkMask(grid: NavGrid): Uint8Array {
  const bytes = decodeBase64ToBytes(grid.free_bits_b64);
  const n = grid.width * grid.height;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const b = i >> 3;
    if (b < bytes.length && (bytes[b] >> (7 - (i & 7))) & 1) mask[i] = 1;
  }
  return mask;
}

/** Min-heap of cell indices keyed by f-score. */
class Heap {
  private readonly _items: number[] = [];
  constructor(private readonly _key: Float64Array) {}
  get size(): number {
    return this._items.length;
  }
  push(i: number): void {
    const a = this._items;
    a.push(i);
    let c = a.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (this._key[a[p]] <= this._key[a[c]]) break;
      [a[p], a[c]] = [a[c], a[p]];
      c = p;
    }
  }
  pop(): number {
    const a = this._items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let p = 0;
      for (;;) {
        const l = 2 * p + 1, r = l + 1;
        let m = p;
        if (l < a.length && this._key[a[l]] < this._key[a[m]]) m = l;
        if (r < a.length && this._key[a[r]] < this._key[a[m]]) m = r;
        if (m === p) break;
        [a[p], a[m]] = [a[m], a[p]];
        p = m;
      }
    }
    return top;
  }
}

export class NavPlanner {
  readonly grid: NavGrid;
  private readonly _free: Uint8Array;
  /** Distance in metres from each cell centre to the nearest blocked cell centre. */
  private readonly _clear: Float64Array;

  constructor(grid: NavGrid) {
    this.grid = grid;
    this._free = decodeWalkMask(grid);
    const d = distanceToCells(grid.width, grid.height, i => this._free[i] === 0);
    this._clear = new Float64Array(d.length);
    for (let i = 0; i < d.length; i++) this._clear[i] = Math.min(d[i], 1e6) * grid.cell_m;
  }

  /** Cell (col, row) holding world point (x, z), or null outside the grid. */
  cellAt(x: number, z: number): [number, number] | null {
    const g = this.grid;
    const c = Math.floor((x - g.origin[0]) / g.cell_m);
    const r = Math.floor((z - g.origin[1]) / g.cell_m);
    return c < 0 || r < 0 || c >= g.width || r >= g.height ? null : [c, r];
  }

  cellCentre(i: number): Point2 {
    const g = this.grid;
    return { x: g.origin[0] + ((i % g.width) + 0.5) * g.cell_m, z: g.origin[1] + (Math.floor(i / g.width) + 0.5) * g.cell_m };
  }

  isWalkable(x: number, z: number): boolean {
    const cell = this.cellAt(x, z);
    return cell !== null && this._free[cell[1] * this.grid.width + cell[0]] === 1;
  }

  /** Nearest walkable cell index to (x, z) within maxM (straight-line), or -1. */
  nearestFreeCell(x: number, z: number, maxM = MAX_SNAP_M): number {
    const g = this.grid;
    const fc = (x - g.origin[0]) / g.cell_m - 0.5;
    const fr = (z - g.origin[1]) / g.cell_m - 0.5;
    const rad = Math.ceil(maxM / g.cell_m);
    const c0 = Math.round(fc), r0 = Math.round(fr);
    let best = -1, bestD = Infinity;
    for (let r = Math.max(0, r0 - rad); r <= Math.min(g.height - 1, r0 + rad); r++) {
      for (let c = Math.max(0, c0 - rad); c <= Math.min(g.width - 1, c0 + rad); c++) {
        const i = r * g.width + c;
        if (!this._free[i]) continue;
        const d = (c - fc) * (c - fc) + (r - fr) * (r - fr);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    return best >= 0 && Math.sqrt(bestD) * g.cell_m <= maxM ? best : -1;
  }

  /** Extra cost factor for standing in cell i (1 = open floor). */
  private _stepFactor(i: number): number {
    const short = Math.max(0, PREFERRED_CLEARANCE_M - this._clear[i]) / PREFERRED_CLEARANCE_M;
    return 1 + NEAR_OBSTACLE_PENALTY * short;
  }

  /**
   * Shortest comfortable walkable path from `from` to `to`, or null if the start has no walkable
   * cell within MAX_SNAP_M, the goal none within `goalSnapM`, or the two are not connected.
   * The goal snaps further because tags can sit on furniture or walls, away from the floor map.
   */
  findPath(from: Point2, to: Point2, goalSnapM = GOAL_SNAP_M): NavPath | null {
    const s = this.nearestFreeCell(from.x, from.z);
    const t = this.nearestFreeCell(to.x, to.z, goalSnapM);
    if (s < 0 || t < 0) return null;
    const cells = this._astar(s, t);
    if (!cells) return null;
    const keep = this._smooth(cells);
    const points = keep.map(i => this.cellCentre(i));
    // Start where the walker really is when that spot is walkable
    if (this.isWalkable(from.x, from.z)) points[0] = { x: from.x, z: from.z };
    if (points.length === 1) points.push({ ...points[0] });
    let lengthM = 0;
    for (let k = 1; k < points.length; k++) lengthM += Math.hypot(points[k].x - points[k - 1].x, points[k].z - points[k - 1].z);
    return { points, lengthM };
  }

  private _astar(s: number, t: number): number[] | null {
    const g = this.grid;
    const n = g.width * g.height;
    const gScore = new Float64Array(n).fill(Infinity);
    const fScore = new Float64Array(n).fill(Infinity);
    const came = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const tc = t % g.width, tr = Math.floor(t / g.width);
    const h = (i: number): number => {
      const dx = Math.abs((i % g.width) - tc), dz = Math.abs(Math.floor(i / g.width) - tr);
      return Math.max(dx, dz) + (SQRT2 - 1) * Math.min(dx, dz); // octile, admissible (factor >= 1)
    };
    const open = new Heap(fScore);
    gScore[s] = 0;
    fScore[s] = h(s);
    open.push(s);
    while (open.size > 0) {
      const cur = open.pop();
      if (cur === t) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      const cc = cur % g.width, cr = Math.floor(cur / g.width);
      for (const [dc, dr, len] of NEIGHBOURS) {
        const nc = cc + dc, nr = cr + dr;
        if (nc < 0 || nr < 0 || nc >= g.width || nr >= g.height) continue;
        const ni = nr * g.width + nc;
        if (!this._free[ni] || closed[ni]) continue;
        // No cutting corners past a blocked cell
        if (dc !== 0 && dr !== 0 && (!this._free[cr * g.width + nc] || !this._free[nr * g.width + cc])) continue;
        const tentative = gScore[cur] + len * 0.5 * (this._stepFactor(cur) + this._stepFactor(ni));
        if (tentative < gScore[ni]) {
          gScore[ni] = tentative;
          fScore[ni] = tentative + h(ni);
          came[ni] = cur;
          open.push(ni);
        }
      }
    }
    if (s !== t && came[t] < 0) return null;
    const out: number[] = [];
    for (let i = t; i !== -1; i = came[i]) out.push(i);
    return out.reverse();
  }

  /** Every cell centre on the segment a-b is walkable with clearance >= minClear. */
  private _lineClear(a: number, b: number, minClear: number): boolean {
    const g = this.grid;
    const pa = this.cellCentre(a), pb = this.cellCentre(b);
    const dist = Math.hypot(pb.x - pa.x, pb.z - pa.z);
    const steps = Math.max(1, Math.ceil(dist / (g.cell_m * 0.25)));
    for (let k = 1; k < steps; k++) {
      const u = k / steps;
      const cell = this.cellAt(pa.x + (pb.x - pa.x) * u, pa.z + (pb.z - pa.z) * u);
      if (!cell) return false;
      const i = cell[1] * g.width + cell[0];
      if (!this._free[i] || this._clear[i] < minClear - 1e-9) return false;
    }
    return true;
  }

  /** Greedy string pulling: from each kept cell, jump to the farthest later cell in clear sight. */
  private _smooth(cells: number[]): number[] {
    if (cells.length <= 2) return cells.slice();
    const keep = [cells[0]];
    let a = 0;
    while (a < cells.length - 1) {
      let next = a + 1;
      // Lowest clearance the A* path itself has between a and b
      let runMin = Math.min(this._clear[cells[a]], this._clear[cells[a + 1]]);
      for (let b = a + 2; b < cells.length; b++) {
        runMin = Math.min(runMin, this._clear[cells[b]]);
        if (this._lineClear(cells[a], cells[b], Math.min(runMin, PREFERRED_CLEARANCE_M))) next = b;
      }
      keep.push(cells[next]);
      a = next;
    }
    return keep;
  }
}
