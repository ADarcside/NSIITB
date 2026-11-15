/**
 * Namma Space: walkable-path planner (Round 2)
 * A* over the NavGrid walking mask (free_bits_b64, already grown by agent_radius_m), 8-connected
 * with no corner cutting, searched backwards from the goal so the work is reused while the walker
 * moves (replanning along a route is near free, even on a hall-sized floor). Steps near walls and
 * furniture cost more, so routes keep to the middle of gaps instead of scraping edges. The cell
 * path is then shortened with line-of-sight checks that never bring it closer to an obstacle than
 * A* already went.
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

/** Min-heap of (key, cell) pairs. Entries are independent, so a cell may sit in it more than once. */
class Heap {
  private _keys: number[] = [];
  private _cells: number[] = [];
  get size(): number {
    return this._cells.length;
  }
  clear(): void {
    this._keys = [];
    this._cells = [];
  }
  push(key: number, cell: number): void {
    const k = this._keys, a = this._cells;
    k.push(key);
    a.push(cell);
    let c = a.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (k[p] <= k[c]) break;
      [k[p], k[c]] = [k[c], k[p]];
      [a[p], a[c]] = [a[c], a[p]];
      c = p;
    }
  }
  /** Smallest key's cell (call only when size > 0) */
  pop(): number {
    const k = this._keys, a = this._cells;
    const top = a[0];
    const lastK = k.pop()!, lastA = a.pop()!;
    if (a.length > 0) {
      k[0] = lastK;
      a[0] = lastA;
      let p = 0;
      for (;;) {
        const l = 2 * p + 1, r = l + 1;
        let m = p;
        if (l < a.length && k[l] < k[m]) m = l;
        if (r < a.length && k[r] < k[m]) m = r;
        if (m === p) break;
        [k[p], k[m]] = [k[m], k[p]];
        [a[p], a[m]] = [a[m], a[p]];
        p = m;
      }
    }
    return top;
  }
}

const UNSEEN = 0, OPEN = 1, CLOSED = 2;

/**
 * Search rooted at one goal cell, run backwards (goal -> start). Step costs are symmetric, so
 * the cost from the goal to a cell equals the cost from that cell to the goal. A closed cell's
 * cost is exact whatever start guided the search (consistent heuristic), so when the walker
 * moves, the work is kept: a start already closed is answered at once, and otherwise the open
 * cells are re-aimed at the new start and the search simply carries on.
 */
interface GoalField {
  goal: number;
  /** Cost from the goal (cell units, near-obstacle penalty included) */
  g: Float64Array;
  /** Next cell on the way to the goal */
  next: Int32Array;
  state: Uint8Array;
  open: Heap;
  /** Start the open keys are aimed at */
  aimedAt: number;
}

/** Fields kept at once: the active route plus one more (a place card's distance). */
const FIELD_CACHE = 2;
/** Blocked sight lines in a row (about 1 m of route at 5 cm cells) before string pulling stops looking further */
const SMOOTH_LOOKAHEAD_MISSES = 20;
/** Cells a local join may visit (about a 1.5 m circle of 5 cm cells) before the full search resumes */
const JOIN_MAX_CELLS = 3000;

export class NavPlanner {
  readonly grid: NavGrid;
  private readonly _free: Uint8Array;
  /** Distance in metres from each cell centre to the nearest blocked cell centre. */
  private readonly _clear: Float64Array;
  /** Cost factor for standing in each cell (1 = open floor) */
  private readonly _factor: Float32Array;
  /** Connected walkable area of each cell (4-connected, the same areas the 8 moves without corner cutting reach), -1 = blocked */
  private readonly _area: Int32Array;
  /** Most recently used first */
  private _fields: GoalField[] = [];

  constructor(grid: NavGrid) {
    this.grid = grid;
    this._free = decodeWalkMask(grid);
    const d = distanceToCells(grid.width, grid.height, i => this._free[i] === 0);
    const n = d.length;
    this._clear = new Float64Array(n);
    this._factor = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this._clear[i] = Math.min(d[i], 1e6) * grid.cell_m;
      const short = Math.max(0, PREFERRED_CLEARANCE_M - this._clear[i]) / PREFERRED_CLEARANCE_M;
      this._factor[i] = 1 + NEAR_OBSTACLE_PENALTY * short;
    }
    this._area = this._labelAreas();
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

  /**
   * Nearest walkable cell index to (x, z) within maxM (straight-line), or -1.
   * With `area`, only cells in that connected walkable area count (see areaOf).
   */
  nearestFreeCell(x: number, z: number, maxM = MAX_SNAP_M, area = -1): number {
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
        if (area >= 0 && this._area[i] !== area) continue;
        const d = (c - fc) * (c - fc) + (r - fr) * (r - fr);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    return best >= 0 && Math.sqrt(bestD) * g.cell_m <= maxM ? best : -1;
  }

  /** Connected walkable area id of a cell (-1 when blocked). Two cells connect only if they share an area. */
  areaOf(cell: number): number {
    return cell >= 0 && cell < this._area.length ? this._area[cell] : -1;
  }

  /**
   * Shortest comfortable walkable path from `from` to `to`, or null if the start has no walkable
   * cell within MAX_SNAP_M, or no cell the start can reach lies within `goalSnapM` of the goal.
   * The goal snaps further because tags can sit on furniture or walls, away from the floor map.
   * A goal standing on walkable floor the walker can't reach gives null (that spot is cut off).
   * A goal off the floor map snaps only to floor the walker can reach, so a tag on furniture next
   * to a closed-off pocket still routes to the reachable side instead of failing.
   */
  findPath(from: Point2, to: Point2, goalSnapM = GOAL_SNAP_M): NavPath | null {
    const s = this.nearestFreeCell(from.x, from.z);
    if (s < 0) return null;
    let t = this.nearestFreeCell(to.x, to.z, goalSnapM);
    if (t < 0) return null;
    if (this._area[t] !== this._area[s]) {
      if (this.isWalkable(to.x, to.z)) return null;
      t = this.nearestFreeCell(to.x, to.z, goalSnapM, this._area[s]);
      if (t < 0) return null;
    }
    const cells = this._route(s, t);
    if (!cells) return null;
    const keep = this._smooth(cells);
    const points = keep.map(i => this.cellCentre(i));
    // Start where the walker really is when that spot is walkable. The straight line from there
    // to the next corner must keep as much room from furniture as the line it replaces; when it
    // doesn't, the route keeps its first cell centre and just starts with a short step onto it.
    if (this.isWalkable(from.x, from.z)) {
      const real = { x: from.x, z: from.z };
      if (points.length < 2) points[0] = real;
      else {
        const fc = this.cellAt(from.x, from.z)!;
        const minClear = Math.min(PREFERRED_CLEARANCE_M, this._clear[fc[1] * this.grid.width + fc[0]], this._segMinClear(points[0], points[1]));
        if (this._segClear(real, points[1], minClear, 0.05)) points[0] = real;
        else if (Math.hypot(real.x - points[0].x, real.z - points[0].z) > 1e-6) points.unshift(real);
      }
    }
    if (points.length === 1) points.push({ ...points[0] });
    let lengthM = 0;
    for (let k = 1; k < points.length; k++) lengthM += Math.hypot(points[k].x - points[k - 1].x, points[k].z - points[k - 1].z);
    return { points, lengthM };
  }

  /**
   * Walking distance in metres from `from` to every goal at once (spatial search: "how far is each
   * place from me"). One search over the floor grid (8 moves, no cutting corners past blocked cells),
   * stopping once every goal is reached. Goals snap to the floor the same way findPath snaps them.
   * Null for a goal that can't be reached. A little longer than a drawn route, which is smoothed.
   */
  walkDistances(from: Point2, goals: Point2[], goalSnapM = GOAL_SNAP_M): (number | null)[] {
    const out: (number | null)[] = goals.map(() => null);
    const s = this.nearestFreeCell(from.x, from.z);
    if (s < 0) return out;
    const area = this._area[s];
    const wanted = new Map<number, number[]>();
    goals.forEach((goal, k) => {
      let t = this.nearestFreeCell(goal.x, goal.z, goalSnapM);
      if (t >= 0 && this._area[t] !== area) {
        t = this.isWalkable(goal.x, goal.z) ? -1 : this.nearestFreeCell(goal.x, goal.z, goalSnapM, area);
      }
      if (t < 0) return;
      const list = wanted.get(t);
      if (list) list.push(k);
      else wanted.set(t, [k]);
    });
    let left = wanted.size;
    if (!left) return out;
    const g = this.grid;
    const w = g.width, free = this._free;
    const dist = new Float64Array(free.length).fill(Infinity);
    const done = new Uint8Array(free.length);
    const heap = new Heap();
    dist[s] = 0;
    heap.push(0, s);
    while (heap.size > 0 && left > 0) {
      const cur = heap.pop();
      if (done[cur]) continue;
      done[cur] = 1;
      const hit = wanted.get(cur);
      if (hit) {
        for (const k of hit) out[k] = dist[cur] * g.cell_m;
        left--;
      }
      const cc = cur % w, cr = (cur - cc) / w;
      for (const [dc, dr, len] of NEIGHBOURS) {
        const nc = cc + dc, nr = cr + dr;
        if (nc < 0 || nr < 0 || nc >= w || nr >= g.height) continue;
        const ni = nr * w + nc;
        if (!free[ni] || done[ni]) continue;
        if (dc !== 0 && dr !== 0 && (!free[cr * w + nc] || !free[nr * w + cc])) continue;
        const d = dist[cur] + len;
        if (d < dist[ni]) {
          dist[ni] = d;
          heap.push(d, ni);
        }
      }
    }
    return out;
  }

  /** 4-connected labelling of the walking mask (iterative flood fill). */
  private _labelAreas(): Int32Array {
    const g = this.grid;
    const n = g.width * g.height;
    const area = new Int32Array(n).fill(-1);
    const stack = new Int32Array(n);
    let next = 0;
    for (let i = 0; i < n; i++) {
      if (!this._free[i] || area[i] >= 0) continue;
      let top = 0;
      stack[top++] = i;
      area[i] = next;
      while (top > 0) {
        const cur = stack[--top];
        const c = cur % g.width;
        const tryCell = (j: number) => {
          if (this._free[j] && area[j] < 0) {
            area[j] = next;
            stack[top++] = j;
          }
        };
        if (c > 0) tryCell(cur - 1);
        if (c < g.width - 1) tryCell(cur + 1);
        if (cur >= g.width) tryCell(cur - g.width);
        if (cur < n - g.width) tryCell(cur + g.width);
      }
      next++;
    }
    return area;
  }

  /** The goal's field (new or cached), moved to the front of the cache. */
  private _field(t: number): GoalField {
    const k = this._fields.findIndex(f => f.goal === t);
    if (k >= 0) {
      const f = this._fields[k];
      if (k > 0) {
        this._fields.splice(k, 1);
        this._fields.unshift(f);
      }
      return f;
    }
    const n = this.grid.width * this.grid.height;
    // Reuse the least recently used field's arrays when the cache is full
    const old = this._fields.length >= FIELD_CACHE ? this._fields.pop()! : null;
    const f: GoalField = old ?? {
      goal: t,
      g: new Float64Array(n),
      next: new Int32Array(n),
      state: new Uint8Array(n),
      open: new Heap(),
      aimedAt: -1,
    };
    f.goal = t;
    f.g.fill(Infinity);
    f.next.fill(-1);
    f.state.fill(UNSEEN);
    f.open.clear();
    f.aimedAt = -1;
    f.g[t] = 0;
    f.state[t] = OPEN;
    f.open.push(0, t);
    this._fields.unshift(f);
    return f;
  }

  /** Octile distance in cells (admissible and consistent: every step costs at least its length). */
  private _h(i: number, j: number): number {
    const w = this.grid.width;
    const dx = Math.abs((i % w) - (j % w)), dz = Math.abs(Math.floor(i / w) - Math.floor(j / w));
    return Math.max(dx, dz) + (SQRT2 - 1) * Math.min(dx, dz);
  }

  /** Cell path from s to t (both walkable, same area), or null. */
  private _route(s: number, t: number): number[] | null {
    if (this._area[s] !== this._area[t]) return null;
    const f = this._field(t);
    if (f.state[s] !== CLOSED) {
      // Usually the walker is a step or two off cells the field already settled: join them locally
      const joined = this._joinField(f, s);
      if (joined) return joined;
      if (f.aimedAt !== s) {
        // Re-aim the open cells at the new start; closed costs stay exact
        const cells: number[] = [];
        while (f.open.size > 0) {
          const c = f.open.pop();
          if (f.state[c] === OPEN) {
            f.state[c] = UNSEEN; // marks it collected (dedupes repeated entries)
            cells.push(c);
          }
        }
        for (const c of cells) {
          f.state[c] = OPEN;
          f.open.push(f.g[c] + this._h(c, s), c);
        }
        f.aimedAt = s;
      }
      this._expandUntilClosed(f, s);
      if (f.state[s] !== CLOSED) return null;
    }
    const out: number[] = [];
    for (let i = s; i !== -1; i = f.next[i]) {
      out.push(i);
      if (i === t) return out;
      if (out.length > this._free.length) return null; // never loops, but never hang either
    }
    return null;
  }

  /**
   * Exact path from s by a small forward search that stops at the field's closed cells: the best
   * path leaves the unsettled cells somewhere, and every closed cell knows its exact cost to the
   * goal, so the cheapest (local cost + field cost) wins. Null when that needs a wide search.
   */
  private _joinField(f: GoalField, s: number): number[] | null {
    const w = this.grid.width, h = this.grid.height;
    const free = this._free, factor = this._factor;
    const cost = new Map<number, number>([[s, 0]]);
    const prev = new Map<number, number>();
    const done = new Set<number>();
    const heap = new Heap();
    heap.push(0, s);
    let best = Infinity, bestCell = -1, pops = 0;
    while (heap.size > 0) {
      const cur = heap.pop();
      if (done.has(cur)) continue;
      const cCur = cost.get(cur)!;
      if (cCur >= best) break; // nothing left can beat it (field costs are >= 0)
      if (++pops > JOIN_MAX_CELLS) return null;
      done.add(cur);
      const cc = cur % w, cr = (cur - cc) / w;
      for (const [dc, dr, len] of NEIGHBOURS) {
        const nc = cc + dc, nr = cr + dr;
        if (nc < 0 || nr < 0 || nc >= w || nr >= h) continue;
        const ni = nr * w + nc;
        if (!free[ni] || done.has(ni)) continue;
        if (dc !== 0 && dr !== 0 && (!free[cr * w + nc] || !free[nr * w + cc])) continue;
        const c = cCur + len * 0.5 * (factor[cur] + factor[ni]);
        if (f.state[ni] === CLOSED) {
          if (c + f.g[ni] < best) {
            best = c + f.g[ni];
            bestCell = ni;
            prev.set(ni, cur);
          }
          continue;
        }
        if (c < (cost.get(ni) ?? Infinity)) {
          cost.set(ni, c);
          prev.set(ni, cur);
          heap.push(c, ni);
        }
      }
    }
    if (bestCell < 0) return null;
    const head: number[] = [];
    for (let i: number | undefined = prev.get(bestCell); i !== undefined; i = i === s ? undefined : prev.get(i)) head.push(i);
    head.reverse();
    const out = head;
    for (let i = bestCell; i !== -1; i = f.next[i]) {
      out.push(i);
      if (i === f.goal) return out;
      if (out.length > free.length) return null;
    }
    return null;
  }

  private _expandUntilClosed(f: GoalField, s: number): void {
    const g = this.grid;
    const w = g.width;
    const free = this._free, factor = this._factor;
    while (f.open.size > 0) {
      const cur = f.open.pop();
      if (f.state[cur] !== OPEN) continue; // a stale repeat of a closed cell
      f.state[cur] = CLOSED;
      if (cur === s) return;
      const cc = cur % w, cr = (cur - cc) / w;
      const gCur = f.g[cur];
      const fCur = factor[cur];
      for (const [dc, dr, len] of NEIGHBOURS) {
        const nc = cc + dc, nr = cr + dr;
        if (nc < 0 || nr < 0 || nc >= w || nr >= g.height) continue;
        const ni = nr * w + nc;
        if (!free[ni] || f.state[ni] === CLOSED) continue;
        // No cutting corners past a blocked cell
        if (dc !== 0 && dr !== 0 && (!free[cr * w + nc] || !free[nr * w + cc])) continue;
        const tentative = gCur + len * 0.5 * (fCur + factor[ni]);
        if (tentative < f.g[ni]) {
          f.g[ni] = tentative;
          f.next[ni] = cur;
          f.state[ni] = OPEN;
          f.open.push(tentative + this._h(ni, s), ni);
        }
      }
    }
  }

  /** Every cell centre on the segment a-b is walkable with clearance >= minClear. */
  private _lineClear(a: number, b: number, minClear: number): boolean {
    return this._segClear(this.cellCentre(a), this.cellCentre(b), minClear);
  }

  /** Lowest clearance (m) of the cells along the segment pa-pb (0 when it leaves the floor). */
  private _segMinClear(pa: Point2, pb: Point2): number {
    const g = this.grid;
    const steps = Math.max(1, Math.ceil(Math.hypot(pb.x - pa.x, pb.z - pa.z) / (g.cell_m * 0.25)));
    let min = Infinity;
    for (let k = 0; k <= steps; k++) {
      const u = k / steps;
      const cell = this.cellAt(pa.x + (pb.x - pa.x) * u, pa.z + (pb.z - pa.z) * u);
      if (!cell) return 0;
      const i = cell[1] * g.width + cell[0];
      min = Math.min(min, this._free[i] ? this._clear[i] : 0);
    }
    return min;
  }

  /** Every point sampled (every `stepCells` cells) on the segment pa-pb is walkable with clearance >= minClear. */
  private _segClear(pa: Point2, pb: Point2, minClear: number, stepCells = 0.25): boolean {
    const g = this.grid;
    const dist = Math.hypot(pb.x - pa.x, pb.z - pa.z);
    const steps = Math.max(1, Math.ceil(dist / (g.cell_m * stepCells)));
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
      // Look ahead until sight has been blocked for a while: sight rarely comes back after that, and
      // checking every later cell made long routes cost seconds (quadratic in the route length)
      let misses = 0;
      for (let b = a + 2; b < cells.length; b++) {
        runMin = Math.min(runMin, this._clear[cells[b]]);
        if (this._lineClear(cells[a], cells[b], Math.min(runMin, PREFERRED_CLEARANCE_M))) {
          next = b;
          misses = 0;
        } else if (++misses > SMOOTH_LOOKAHEAD_MISSES) {
          break;
        }
      }
      keep.push(cells[next]);
      a = next;
    }
    return keep;
  }
}
