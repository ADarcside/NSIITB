/**
 * Namma Space: floor plan shapes for the minimap (Round 2)
 *
 * Turns a NavGrid (grid.json) into a clean plan: the room outline as closed rings with straight
 * walls, plus furniture as boxes aligned to the room axes. Pure: no DOM, so it is unit-tested with
 * small hand-made grids.
 *
 * Obstacles come from the height layers (occupied cells per slice, not shrunk by the body radius).
 * Without layers the walkable bits grown back by the body radius stand in. The grid covers the
 * scene bounds plus agent_radius_m on every side (pipeline/grid.py), so that margin is wall.
 *
 * Hard rule: a box never covers a walkable cell, so the map never draws furniture under a route.
 */

import type { NavGrid } from '../contracts/types.js';
import { decodeBase64ToBytes } from '../collision/grid.js';

export interface PlanBox {
  id: number;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  tall: boolean;
}

export interface FloorPlan {
  /** Closed rings in world metres, outer ring first, then holes (solid islands inside the room) */
  outline: { x: number; z: number }[][];
  boxes: PlanBox[];
  source: 'layers' | 'free_bits';
}

/** Tuning values (see the build spec); world metres unless noted */
export const PLAN_TUNING = {
  /** Height band that counts as an obstacle */
  bandLoM: 0.2,
  bandHiM: 1.7,
  /** Occupied slices in the band for a cell to count as occupied */
  minSlices: 2,
  /** Share of the band occupied for a cell to count as solid (wall or tall furniture) */
  solidShare: 0.9,
  /** Furniture is found band by band, top down; a cell counts with this many occupied slices */
  furnitureBands: [
    { loM: 1.1, hiM: 1.7, minSlices: 1 },
    { loM: 0.6, hiM: 1.1, minSlices: 1 },
    { loM: 0.2, hiM: 0.6, minSlices: 2 },
  ],
  /** Morphological close on the furniture mask (gap width it bridges) */
  closeM: 0.1,
  /** Enclosed empty pockets up to this size inside furniture are filled (a bed frame's middle) (m²) */
  maxHoleM2: 4,
  /** Morphological open after filling: strips thinner than this are dropped */
  openM: 0.1,
  /** Blobs smaller than this are dropped (m²) */
  minBlobM2: 0.08,
  /** A blob that fills at least this share of its bounding box becomes that box */
  boxFill: 0.65,
  /** How many times a poorly filled blob may be split at its narrowest neck */
  maxSplits: 1,
  /** A box edge within this distance of a wall snaps onto it */
  wallSnapM: 0.15,
  /** Wall steps shorter than this are flattened */
  jogM: 0.3,
  /** Solid share of a box's cells for it to count as tall (cupboard, pillar) */
  tallShare: 0.5,
};

/** Inclusive cell rectangle */
interface CellBox {
  c0: number;
  r0: number;
  c1: number;
  r1: number;
  cells: number;
  solid: number;
}

const bit = (bytes: Uint8Array, i: number): number => (bytes[i >> 3] >> (7 - (i & 7))) & 1;

/** Square dilation (radius r cells); cells outside the grid count as empty */
function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask.slice();
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r) && !v; k++) v = mask[y * w + k];
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r) && !v; k++) v = tmp[k * w + x];
      out[y * w + x] = v;
    }
  }
  return out;
}

/** Square erosion (radius r cells); cells outside the grid count as `edge` */
function erode(mask: Uint8Array, w: number, h: number, r: number, edge: 0 | 1 = 0): Uint8Array {
  const inv = new Uint8Array(w * h);
  for (let i = 0; i < inv.length; i++) inv[i] = mask[i] ? 0 : 1;
  // Pad so the outside counts as `edge`
  const pw = w + 2 * r;
  const ph = h + 2 * r;
  const padded = new Uint8Array(pw * ph).fill(edge ? 0 : 1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) padded[(y + r) * pw + x + r] = inv[y * w + x];
  const grown = dilate(padded, pw, ph, r);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = grown[(y + r) * pw + x + r] ? 0 : 1;
  return out;
}

/** Connected components of a mask; returns labels (0 = background) and each component's cells */
function components(mask: Uint8Array, w: number, h: number, eight: boolean): { labels: Int32Array; groups: number[][] } {
  const labels = new Int32Array(w * h);
  const groups: number[][] = [];
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    const id = groups.length + 1;
    const cells: number[] = [];
    labels[start] = id;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      cells.push(i);
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if ((!dx && !dy) || (!eight && dx && dy)) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (mask[j] && !labels[j]) {
            labels[j] = id;
            stack.push(j);
          }
        }
      }
    }
    groups.push(cells);
  }
  return { labels, groups };
}

function boxOf(cells: number[], w: number, solid: Uint8Array): CellBox {
  let c0 = Infinity, r0 = Infinity, c1 = -1, r1 = -1, s = 0;
  for (const i of cells) {
    const c = i % w;
    const r = (i - c) / w;
    if (c < c0) c0 = c;
    if (c > c1) c1 = c;
    if (r < r0) r0 = r;
    if (r > r1) r1 = r;
    s += solid[i];
  }
  return { c0, r0, c1, r1, cells: cells.length, solid: s };
}

const area = (b: CellBox): number => (b.c1 - b.c0 + 1) * (b.r1 - b.r0 + 1);

/**
 * Fits boxes to one blob: its bounding box, or, when the blob fills that box poorly (two pieces
 * touching, an L shape), split it along the straight line that leaves the two tightest boxes.
 */
function fitBlob(cells: number[], w: number, solid: Uint8Array, minCells: number, splitsLeft: number): CellBox[] {
  const b = boxOf(cells, w, solid);
  if (b.cells / area(b) >= PLAN_TUNING.boxFill || splitsLeft <= 0) return [b];
  const bw = b.c1 - b.c0 + 1;
  const bh = b.r1 - b.r0 + 1;
  // Extent of the blob in each column (rows) and each row (columns), plus cell counts
  const colLo = new Array<number>(bw).fill(Infinity), colHi = new Array<number>(bw).fill(-Infinity);
  const rowLo = new Array<number>(bh).fill(Infinity), rowHi = new Array<number>(bh).fill(-Infinity);
  const colN = new Array<number>(bw).fill(0), rowN = new Array<number>(bh).fill(0);
  for (const i of cells) {
    const c = i % w;
    const r = (i - c) / w;
    const x = c - b.c0, y = r - b.r0;
    colLo[x] = Math.min(colLo[x], r); colHi[x] = Math.max(colHi[x], r); colN[x]++;
    rowLo[y] = Math.min(rowLo[y], c); rowHi[y] = Math.max(rowHi[y], c); rowN[y]++;
  }
  // Best cut along one axis: total area of the two boxes (first `k` lines vs the rest)
  const bestCut = (lo: number[], hi: number[], cnt: number[]): { k: number; cost: number } => {
    const len = lo.length;
    const span = (from: number, to: number) => {
      let l = Infinity, h = -Infinity, first = -1, last = -1, nCells = 0;
      for (let k = from; k < to; k++) {
        if (!cnt[k]) continue;
        if (first < 0) first = k;
        last = k;
        l = Math.min(l, lo[k]); h = Math.max(h, hi[k]); nCells += cnt[k];
      }
      return first < 0 ? { a: 0, n: 0 } : { a: (last - first + 1) * (h - l + 1), n: nCells };
    };
    let best = { k: -1, cost: Infinity };
    for (let k = 1; k < len; k++) {
      const p = span(0, k), q = span(k, len);
      if (p.n < minCells || q.n < minCells) continue;
      const cost = p.a + q.a;
      if (cost < best.cost) best = { k, cost };
    }
    return best;
  };
  const cx = bestCut(colLo, colHi, colN);
  const cz = bestCut(rowLo, rowHi, rowN);
  const pick = cx.cost <= cz.cost ? { alongX: true, k: cx.k, cost: cx.cost } : { alongX: false, k: cz.k, cost: cz.cost };
  // Only split when it clearly tightens the fit
  if (pick.k < 0 || pick.cost > area(b) * 0.85) return [b];
  const cut = pick.alongX ? b.c0 + pick.k : b.r0 + pick.k;
  const first: number[] = [];
  const second: number[] = [];
  for (const i of cells) {
    const col = i % w;
    ((pick.alongX ? col : (i - col) / w) < cut ? first : second).push(i);
  }
  return [first, second].flatMap((part) => fitBlob(part, w, solid, minCells, splitsLeft - 1));
}

/** Shrinks a box until it covers no walkable cell; null if nothing is left */
function trimToFree(b: CellBox, free: Uint8Array, w: number): CellBox | null {
  const box = { ...b };
  const lineFree = (c0: number, r0: number, c1: number, r1: number): number => {
    let n = 0;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) n += free[r * w + c];
    return n;
  };
  for (;;) {
    if (box.c0 > box.c1 || box.r0 > box.r1) return null;
    if (!lineFree(box.c0, box.r0, box.c1, box.r1)) return box;
    const sides = [
      lineFree(box.c0, box.r0, box.c0, box.r1),
      lineFree(box.c1, box.r0, box.c1, box.r1),
      lineFree(box.c0, box.r0, box.c1, box.r0),
      lineFree(box.c0, box.r1, box.c1, box.r1),
    ];
    // Shrink the side whose edge line holds the largest share of walkable cells
    const len = [box.r1 - box.r0 + 1, box.r1 - box.r0 + 1, box.c1 - box.c0 + 1, box.c1 - box.c0 + 1];
    let k = 0;
    for (let s = 1; s < 4; s++) if (sides[s] / len[s] > sides[k] / len[k]) k = s;
    if (k === 0) box.c0++;
    else if (k === 1) box.c1--;
    else if (k === 2) box.r0++;
    else box.r1--;
  }
}

/** Extends box edges that sit within `reach` cells of a wall onto the wall */
function snapToWalls(b: CellBox, floor: Uint8Array, w: number, h: number, reach: number): CellBox {
  const box = { ...b };
  const isWall = (c: number, r: number): boolean => c < 0 || r < 0 || c >= w || r >= h || !floor[r * w + c];
  const mostlyWall = (cells: [number, number][]): boolean =>
    cells.filter(([c, r]) => isWall(c, r)).length * 2 >= cells.length;
  const span = (a: number, z: number): number[] => Array.from({ length: z - a + 1 }, (_, k) => a + k);
  for (let d = 1; d <= reach; d++) {
    if (mostlyWall(span(box.r0, box.r1).map((r) => [b.c0 - d, r]))) { box.c0 = b.c0 - d + 1; break; }
  }
  for (let d = 1; d <= reach; d++) {
    if (mostlyWall(span(box.r0, box.r1).map((r) => [b.c1 + d, r]))) { box.c1 = b.c1 + d - 1; break; }
  }
  for (let d = 1; d <= reach; d++) {
    if (mostlyWall(span(box.c0, box.c1).map((c) => [c, b.r0 - d]))) { box.r0 = b.r0 - d + 1; break; }
  }
  for (let d = 1; d <= reach; d++) {
    if (mostlyWall(span(box.c0, box.c1).map((c) => [c, b.r1 + d]))) { box.r1 = b.r1 + d - 1; break; }
  }
  return box;
}

/**
 * Traces the edges of a mask into closed rings of cell-corner points (column, row), with
 * collinear points removed. Rings run with the mask on their left in (column, row) space.
 */
function traceRings(mask: Uint8Array, w: number, h: number): [number, number][][] {
  const on = (c: number, r: number): boolean => c >= 0 && r >= 0 && c < w && r < h && mask[r * w + c] === 1;
  // Directed edges keyed by start corner; corner id = r * (w + 1) + c
  const W1 = w + 1;
  const out = new Map<number, number[]>();
  const add = (c0: number, r0: number, c1: number, r1: number) => {
    const k = r0 * W1 + c0;
    const list = out.get(k);
    const v = r1 * W1 + c1;
    if (list) list.push(v);
    else out.set(k, [v]);
  };
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (!on(c, r)) continue;
      if (!on(c, r - 1)) add(c + 1, r, c, r); // top edge, run west
      if (!on(c - 1, r)) add(c, r, c, r + 1); // left edge, run south
      if (!on(c, r + 1)) add(c, r + 1, c + 1, r + 1); // bottom edge, run east
      if (!on(c + 1, r)) add(c + 1, r + 1, c + 1, r); // right edge, run north
    }
  }
  const rings: [number, number][][] = [];
  const take = (from: number, prevDir: [number, number] | null): number | undefined => {
    const list = out.get(from);
    if (!list || !list.length) return undefined;
    if (list.length === 1 || !prevDir) {
      const v = list.shift()!;
      if (!list.length) out.delete(from);
      return v;
    }
    // Two edges leave this corner (cells touching diagonally): turn left, which keeps them apart
    const fc = from % W1;
    const fr = (from - fc) / W1;
    let pick = 0;
    let bestTurn = -Infinity;
    list.forEach((v, idx) => {
      const vc = v % W1;
      const vr = (v - vc) / W1;
      const d: [number, number] = [vc - fc, vr - fr];
      // In (column, row) space with rows pointing down, a left turn has a negative cross product
      const turn = -(prevDir[0] * d[1] - prevDir[1] * d[0]);
      if (turn > bestTurn) { bestTurn = turn; pick = idx; }
    });
    const v = list.splice(pick, 1)[0];
    if (!list.length) out.delete(from);
    return v;
  };
  while (out.size) {
    const start = out.keys().next().value as number;
    const pts: number[] = [start];
    let cur = start;
    let prev: [number, number] | null = null;
    for (let guard = 0; guard < 4 * (w + 1) * (h + 1); guard++) {
      const nxt = take(cur, prev);
      if (nxt === undefined) break;
      const cc = cur % W1, cr = (cur - cc) / W1, nc = nxt % W1, nr = (nxt - nc) / W1;
      prev = [nc - cc, nr - cr];
      cur = nxt;
      if (cur === start) break;
      pts.push(cur);
    }
    const ring = pts.map((p): [number, number] => [p % W1, Math.floor(p / W1)]);
    // Drop collinear corners
    const simple = ring.filter((p, i) => {
      const a = ring[(i - 1 + ring.length) % ring.length];
      const b = ring[(i + 1) % ring.length];
      return (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]) !== 0;
    });
    if (simple.length >= 4) rings.push(simple);
  }
  return rings;
}

const ringArea = (ring: [number, number][]): number => {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
};

/** Closes gaps, fills enclosed pockets (a bed frame's middle) and drops thin strips */
function cleanFurniture(mask: Uint8Array, wall: Uint8Array, free: Uint8Array, w: number, h: number, cell: number): Uint8Array {
  const T = PLAN_TUNING;
  const n = w * h;
  let fur = mask;
  const close = Math.max(0, Math.round(T.closeM / cell / 2));
  if (close) fur = erode(dilate(fur, w, h, close), w, h, close, 0);
  for (let i = 0; i < n; i++) if (wall[i]) fur[i] = 0;
  const maxHole = Math.round(T.maxHoleM2 / (cell * cell));
  const empty = new Uint8Array(n);
  for (let i = 0; i < n; i++) empty[i] = fur[i] || wall[i] ? 0 : 1;
  for (const pocket of components(empty, w, h, false).groups) {
    if (pocket.length > maxHole) continue;
    const open = pocket.some((i) => {
      if (free[i]) return true;
      const c = i % w;
      const r = (i - c) / w;
      return c === 0 || r === 0 || c === w - 1 || r === h - 1 ||
        wall[i - 1] === 1 || wall[i + 1] === 1 || wall[i - w] === 1 || wall[i + w] === 1;
    });
    if (!open) for (const i of pocket) fur[i] = 1;
  }
  const opn = Math.max(0, Math.round(T.openM / cell / 2));
  if (opn) fur = dilate(erode(fur, w, h, opn, 1), w, h, opn);
  for (let i = 0; i < n; i++) if (wall[i] || free[i]) fur[i] = 0;
  return fur;
}

/** Shared masks behind a plan; exported for the minimap's tag fitting */
export interface PlanMasks {
  w: number;
  h: number;
  free: Uint8Array;
  /** Room floor after the outline is smoothed (1 = inside the walls) */
  floor: Uint8Array;
}

/** Builds the floor plan for a grid, or null when the grid holds nothing to draw */
export function buildFloorPlan(grid: NavGrid): FloorPlan | null {
  return buildFloorPlanWithMasks(grid)?.plan ?? null;
}

export function buildFloorPlanWithMasks(grid: NavGrid): { plan: FloorPlan; masks: PlanMasks } | null {
  const w = grid.width;
  const h = grid.height;
  const cell = grid.cell_m;
  if (!(w > 0 && h > 0 && cell > 0)) return null;
  const n = w * h;
  const T = PLAN_TUNING;

  const freeBytes = decodeBase64ToBytes(grid.free_bits_b64 || '');
  const free = new Uint8Array(n);
  let freeCount = 0;
  for (let i = 0; i < n; i++) {
    free[i] = (i >> 3) < freeBytes.length ? bit(freeBytes, i) : 0;
    freeCount += free[i];
  }

  // Margin around the scene bounds: the grid adds agent_radius_m on every side
  let pad = Math.round((grid.agent_radius_m || 0) / cell);
  if (2 * pad >= w || 2 * pad >= h) pad = 0;
  const inside = (i: number): boolean => {
    const c = i % w;
    const r = (i - c) / w;
    return c >= pad && r >= pad && c < w - pad && r < h - pad;
  };

  // 1. Obstacles: occupied and solid cells
  const occ = new Uint8Array(n);
  const solid = new Uint8Array(n);
  let bandMasks: Uint8Array[] | null = null;
  let source: FloorPlan['source'] = 'free_bits';
  const L = grid.layers;
  const layerBytes = L ? decodeBase64ToBytes(L.occupied_bits_b64 || '') : null;
  if (L && layerBytes && layerBytes.length * 8 >= L.count * n && L.dy_m > 0) {
    const eps = 1e-6;
    const lo = Math.max(0, Math.ceil((T.bandLoM - L.y0_m) / L.dy_m - eps));
    const hi = Math.min(L.count - 1, Math.floor((T.bandHiM - L.y0_m) / L.dy_m + eps) - 1);
    const bandN = hi - lo + 1;
    if (bandN > 0) {
      source = 'layers';
      const solidN = Math.max(T.minSlices, Math.ceil(T.solidShare * bandN));
      for (let i = 0; i < n; i++) {
        let k = 0;
        for (let l = lo; l <= hi; l++) k += bit(layerBytes, l * n + i);
        occ[i] = k >= T.minSlices ? 1 : 0;
        solid[i] = k >= solidN ? 1 : 0;
      }
      bandMasks = T.furnitureBands.map(({ loM, hiM, minSlices }) => {
        const a = Math.max(0, Math.ceil((loM - L.y0_m) / L.dy_m - eps));
        const b = Math.min(L.count - 1, Math.floor((hiM - L.y0_m) / L.dy_m + eps) - 1);
        const m = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
          let k = 0;
          for (let l = a; l <= b; l++) k += bit(layerBytes, l * n + i);
          m[i] = k >= minSlices ? 1 : 0;
        }
        return m;
      });
    }
  }
  if (source === 'free_bits') {
    if (!freeCount) return null;
    // Walkable bits grown back by the body radius; everything else inside the bounds is an obstacle
    const grown = dilate(free, w, h, Math.max(1, pad));
    for (let i = 0; i < n; i++) occ[i] = grown[i] ? 0 : 1;
  }

  // 2. Wall: the margin, plus solid cells joined to it. Solid islands inside stay furniture (tall)
  const wall = new Uint8Array(n);
  const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!inside(i)) { wall[i] = 1; stack.push(i); }
  }
  while (stack.length) {
    const i = stack.pop()!;
    const c = i % w;
    const r = (i - c) / w;
    const near = [c > 0 ? i - 1 : -1, c < w - 1 ? i + 1 : -1, r > 0 ? i - w : -1, r < h - 1 ? i + w : -1];
    for (const j of near) {
      if (j >= 0 && !wall[j] && solid[j] && !free[j]) { wall[j] = 1; stack.push(j); }
    }
  }

  // 3. Floor: the largest open area, with short wall steps flattened. Walkable cells always stay in
  let floor: Uint8Array = new Uint8Array(n);
  for (let i = 0; i < n; i++) floor[i] = wall[i] ? 0 : 1;
  const floorParts = components(floor, w, h, false).groups;
  if (!floorParts.length) return null;
  const main = floorParts.reduce((a, b) => (b.length > a.length ? b : a));
  floor = new Uint8Array(n);
  for (const i of main) floor[i] = 1;
  const jog = Math.max(1, Math.round(T.jogM / cell / 2));
  floor = erode(dilate(floor, w, h, jog), w, h, jog, 0); // close: fill notches
  floor = dilate(erode(floor, w, h, jog, 0), w, h, jog); // open: cut thin spurs
  for (let i = 0; i < n; i++) if (free[i]) floor[i] = 1;

  const rings = traceRings(floor, w, h)
    .map((ring) => ({ ring, a: ringArea(ring) }))
    .filter((r) => Math.abs(r.a) * cell * cell >= T.minBlobM2)
    .sort((p, q) => Math.abs(q.a) - Math.abs(p.a));
  if (!rings.length) return null;
  const outline = rings.map(({ ring }) =>
    ring.map(([c, r]) => ({ x: grid.origin[0] + c * cell, z: grid.origin[1] + r * cell }))
  );

  // 4. Furniture, one height band at a time from the top down. High bands come first because tall
  // pieces (bunks, shelves) separate cleanly there; lower bands then add what is not yet covered
  const minCells = Math.max(1, Math.round(T.minBlobM2 / (cell * cell)));
  const reach = Math.max(0, Math.round(T.wallSnapM / cell));
  const claimed = new Uint8Array(n);
  const boxes: PlanBox[] = [];
  for (const band of bandMasks ?? [occ]) {
    let fur: Uint8Array = new Uint8Array(n);
    for (let i = 0; i < n; i++) fur[i] = band[i] && !wall[i] && !claimed[i] ? 1 : 0;
    fur = cleanFurniture(fur, wall, free, w, h, cell);
    for (const blob of components(fur, w, h, true).groups) {
      if (blob.length < minCells) continue;
      for (const fitted of fitBlob(blob, w, solid, minCells, T.maxSplits)) {
        const trimmed = trimToFree(snapToWalls(fitted, floor, w, h, reach), free, w);
        if (!trimmed || area(trimmed) < minCells) continue;
        // Mostly on top of a box found in a higher band: the same object
        let covered = 0;
        for (let r = trimmed.r0; r <= trimmed.r1; r++) {
          for (let c = trimmed.c0; c <= trimmed.c1; c++) covered += claimed[r * w + c];
        }
        if (covered > area(trimmed) * 0.5) continue;
        for (let r = trimmed.r0; r <= trimmed.r1; r++) {
          for (let c = trimmed.c0; c <= trimmed.c1; c++) claimed[r * w + c] = 1;
        }
        boxes.push({
          id: boxes.length,
          minX: grid.origin[0] + trimmed.c0 * cell,
          minZ: grid.origin[1] + trimmed.r0 * cell,
          maxX: grid.origin[0] + (trimmed.c1 + 1) * cell,
          maxZ: grid.origin[1] + (trimmed.r1 + 1) * cell,
          tall: fitted.cells > 0 && fitted.solid / fitted.cells >= T.tallShare,
        });
      }
    }
  }

  return { plan: { outline, boxes, source }, masks: { w, h, free, floor } };
}

// =============================================================================
// Tags on the plan: which box each tag belongs to, same-size groups, dots, door and window
// =============================================================================

/** The fields of a tag the plan uses (a POI fits) */
export interface PlanTag {
  poi_id: string;
  name: string;
  category?: string;
  aliases?: string[];
  position: { x: number; z: number };
}

export interface PlanOpening {
  kind: 'door' | 'window';
  poi_id: string;
  /** Ends of the opening on the wall line, world metres */
  a: { x: number; z: number };
  b: { x: number; z: number };
  /** Unit normal pointing into the room */
  inward: { x: number; z: number };
}

export interface PlanLayout {
  /** Boxes after same-kind resizing (same ids as plan.boxes) */
  boxes: PlanBox[];
  /** Box each tag belongs to (absent when none) */
  boxOf: Map<string, number>;
  /** Where each tag's dot is drawn: on its box, or its real spot when it has none */
  dots: Map<string, { x: number; z: number }>;
  openings: PlanOpening[];
}

export const TAG_TUNING = {
  /** A tag this close to a box may share it with another kind's tags */
  containSlackM: 0.3,
  /** Otherwise a tag takes the nearest box within this distance */
  nearestM: 1.0,
  /** Same-kind boxes are resized when each side is within this share of the group median */
  sameSizeShare: 0.35,
  doorWidthM: 0.9,
  windowWidthM: 1.2,
  /** Door and window are skipped when the nearest wall is further than this */
  wallReachM: 1.0,
};

const distToBox = (x: number, z: number, b: PlanBox): number =>
  Math.hypot(Math.max(b.minX - x, 0, x - b.maxX), Math.max(b.minZ - z, 0, z - b.maxZ));

/** Door and window tags open the wall instead of belonging to a box */
const isOpeningTag = (t: PlanTag): { door: boolean; window: boolean } => {
  const door = t.category === 'exit';
  return { door, window: !door && [t.name, ...(t.aliases ?? [])].some((s) => /window/i.test(s)) };
};

/**
 * Box each tag belongs to. A tag inside a box takes it, and that box then belongs to the tag's kind.
 * Any other tag takes the nearest box within reach, unless that box belongs to another kind and a
 * free box is only a little further (Table 2 by Bunk 1's corner goes to its own table). A tag that
 * would share another kind's box does so only within the contain slack (Posters above Bunk 3).
 */
export function matchTagsToBoxes(boxes: PlanBox[], tags: PlanTag[]): Map<string, number> {
  const out = new Map<string, number>();
  const T = TAG_TUNING;
  const owner = new Map<number, string>();
  const ranked = (t: PlanTag) =>
    boxes
      .map((b) => ({ b, d: distToBox(t.position.x, t.position.z, b), a: (b.maxX - b.minX) * (b.maxZ - b.minZ) }))
      .filter((c) => c.d <= Math.max(T.containSlackM, T.nearestM))
      .sort((p, q) => p.d - q.d || p.a - q.a);
  const candidates = tags.filter((t) => { const o = isOpeningTag(t); return !o.door && !o.window; });
  const later: PlanTag[] = [];
  for (const t of candidates) {
    const best = ranked(t)[0];
    if (best && best.d === 0) {
      out.set(t.poi_id, best.b.id);
      if (!owner.has(best.b.id)) owner.set(best.b.id, kindOf(t));
    } else {
      later.push(t);
    }
  }
  for (const t of later) {
    const list = ranked(t);
    if (!list.length) continue;
    const k = kindOf(t);
    const ok = (id: number) => !owner.has(id) || owner.get(id) === k;
    const nearest = list[0];
    if (ok(nearest.b.id)) { out.set(t.poi_id, nearest.b.id); continue; }
    const alt = list.find((c) => ok(c.b.id) && c.d <= nearest.d + T.containSlackM);
    if (alt) out.set(t.poi_id, alt.b.id);
    else if (nearest.d <= T.containSlackM) out.set(t.poi_id, nearest.b.id);
  }
  return out;
}

/** "Bunk 2" and "Bunk 3" are one kind: category plus the name without its trailing number */
export const kindOf = (t: PlanTag): string =>
  `${(t.category ?? '').toLowerCase()}|${t.name.trim().replace(/\s*\d+$/, '').toLowerCase()}`;

const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Lays tags onto a plan: same-kind boxes get one common size (wall edges stay put, never over a
 * walkable cell), each matched dot sits on its box, and exit and window tags open the wall.
 */
export function layoutTags(grid: NavGrid, plan: FloorPlan, masks: PlanMasks, tags: PlanTag[]): PlanLayout {
  const cell = grid.cell_m;
  const [ox, oz] = grid.origin;
  const { w, h, free, floor } = masks;
  const boxes = plan.boxes.map((b) => ({ ...b }));
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const boxOf = matchTagsToBoxes(boxes, tags);

  const toCells = (b: PlanBox): CellBox => ({
    c0: Math.round((b.minX - ox) / cell), r0: Math.round((b.minZ - oz) / cell),
    c1: Math.round((b.maxX - ox) / cell) - 1, r1: Math.round((b.maxZ - oz) / cell) - 1, cells: 0, solid: 0,
  });
  const setFromCells = (b: PlanBox, c: CellBox) => {
    b.minX = ox + c.c0 * cell; b.minZ = oz + c.r0 * cell;
    b.maxX = ox + (c.c1 + 1) * cell; b.maxZ = oz + (c.r1 + 1) * cell;
  };
  const wallAt = (c: number, r: number): boolean => c < 0 || r < 0 || c >= w || r >= h || !floor[r * w + c];
  // Which edges of a box sit against a wall
  const wallEdges = (c: CellBox) => {
    const side = (pts: [number, number][]) => pts.filter(([x, y]) => wallAt(x, y)).length * 2 >= pts.length;
    const cols = Array.from({ length: c.c1 - c.c0 + 1 }, (_, k) => c.c0 + k);
    const rows = Array.from({ length: c.r1 - c.r0 + 1 }, (_, k) => c.r0 + k);
    return {
      left: side(rows.map((r) => [c.c0 - 1, r])), right: side(rows.map((r) => [c.c1 + 1, r])),
      top: side(cols.map((x) => [x, c.r0 - 1])), bottom: side(cols.map((x) => [x, c.r1 + 1])),
    };
  };
  // Resize a cell box to nx by nz cells, anchored on its wall edges (else its centre)
  const resize = (c: CellBox, nx: number, nz: number): CellBox => {
    const e = wallEdges(c);
    const out = { ...c };
    const axis = (lo: number, hi: number, n: number, keepLo: boolean, keepHi: boolean): [number, number] => {
      if (keepLo && !keepHi) return [lo, lo + n - 1];
      if (keepHi && !keepLo) return [hi - n + 1, hi];
      const mid = (lo + hi + 1) / 2;
      const a = Math.round(mid - n / 2);
      return [a, a + n - 1];
    };
    [out.c0, out.c1] = axis(c.c0, c.c1, nx, e.left, e.right);
    [out.r0, out.r1] = axis(c.r0, c.r1, nz, e.top, e.bottom);
    out.c0 = Math.max(0, out.c0); out.r0 = Math.max(0, out.r0);
    out.c1 = Math.min(w - 1, out.c1); out.r1 = Math.min(h - 1, out.r1);
    return out;
  };

  // Same-kind groups of two or more distinct boxes
  const groups = new Map<string, Set<number>>();
  for (const t of tags) {
    const id = boxOf.get(t.poi_id);
    if (id === undefined) continue;
    const k = kindOf(t);
    if (!groups.has(k)) groups.set(k, new Set());
    groups.get(k)!.add(id);
  }
  const resized = new Set<number>();
  for (const ids of groups.values()) {
    // A box shared with another kind (Table 2 under the Bookshelf) is still sized with its own kind
    const members = [...ids].filter((id) => !resized.has(id)).map((id) => byId.get(id)!);
    if (members.length < 2) continue;
    const cells = members.map(toCells);
    const dims = cells.map((c) => {
      const x = c.c1 - c.c0 + 1, z = c.r1 - c.r0 + 1;
      return { long: Math.max(x, z), short: Math.min(x, z), xLong: x >= z };
    });
    const mLong = Math.round(median(dims.map((d) => d.long)));
    const mShort = Math.round(median(dims.map((d) => d.short)));
    const within = (v: number, m: number) => Math.abs(v - m) <= TAG_TUNING.sameSizeShare * m;
    const pick = dims.map((d, i) => (within(d.long, mLong) && within(d.short, mShort) ? i : -1)).filter((i) => i >= 0);
    if (pick.length < 2) continue;
    // Pass 1: median size, then trimmed off walkable cells
    const fitted = pick.map((i) => {
      const d = dims[i];
      const r = resize(cells[i], d.xLong ? mLong : mShort, d.xLong ? mShort : mLong);
      return trimToFree(r, free, w) ?? cells[i];
    });
    // Pass 2: everyone shrinks to the smallest trimmed size, so the group really matches
    const fLong = Math.min(...fitted.map((c) => Math.max(c.c1 - c.c0 + 1, c.r1 - c.r0 + 1)));
    const fShort = Math.min(...fitted.map((c) => Math.min(c.c1 - c.c0 + 1, c.r1 - c.r0 + 1)));
    pick.forEach((i, k) => {
      const xLong = dims[i].xLong;
      const final = trimToFree(resize(fitted[k], xLong ? fLong : fShort, xLong ? fShort : fLong), free, w) ?? fitted[k];
      setFromCells(members[i], final);
      resized.add(members[i].id);
    });
  }

  // Dots: on the box's centre; several tags in one box spread along its long side
  const dots = new Map<string, { x: number; z: number }>();
  const inBox = new Map<number, PlanTag[]>();
  for (const t of tags) {
    const id = boxOf.get(t.poi_id);
    if (id === undefined) { dots.set(t.poi_id, { x: t.position.x, z: t.position.z }); continue; }
    if (!inBox.has(id)) inBox.set(id, []);
    inBox.get(id)!.push(t);
  }
  for (const [id, list] of inBox) {
    const b = byId.get(id)!;
    const alongX = b.maxX - b.minX >= b.maxZ - b.minZ;
    // Keep their order along the box as in the real scene
    list.sort((p, q) => (alongX ? p.position.x - q.position.x : p.position.z - q.position.z));
    list.forEach((t, k) => {
      const f = (k + 1) / (list.length + 1);
      dots.set(t.poi_id, alongX
        ? { x: b.minX + f * (b.maxX - b.minX), z: (b.minZ + b.maxZ) / 2 }
        : { x: (b.minX + b.maxX) / 2, z: b.minZ + f * (b.maxZ - b.minZ) });
    });
  }

  // Door and window on the nearest wall of the outer ring
  const openings: PlanOpening[] = [];
  const ring = plan.outline[0] ?? [];
  const cx = ring.reduce((s, p) => s + p.x, 0) / Math.max(1, ring.length);
  const cz = ring.reduce((s, p) => s + p.z, 0) / Math.max(1, ring.length);
  for (const t of tags) {
    const { door: isDoor, window: isWindow } = isOpeningTag(t);
    if (!isDoor && !isWindow) continue;
    let best: { d: number; a: { x: number; z: number }; b: { x: number; z: number }; s: number; len: number } | null = null;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 1e-6) continue;
      const s = Math.max(0, Math.min(len, ((t.position.x - a.x) * (b.x - a.x) + (t.position.z - a.z) * (b.z - a.z)) / len));
      const px = a.x + ((b.x - a.x) * s) / len, pz = a.z + ((b.z - a.z) * s) / len;
      const d = Math.hypot(t.position.x - px, t.position.z - pz);
      if (!best || d < best.d) best = { d, a, b, s, len };
    }
    if (!best || best.d > TAG_TUNING.wallReachM) continue;
    const width = Math.min(best.len, isDoor ? TAG_TUNING.doorWidthM : TAG_TUNING.windowWidthM);
    const s0 = Math.max(0, Math.min(best.len - width, best.s - width / 2));
    const ux = (best.b.x - best.a.x) / best.len, uz = (best.b.z - best.a.z) / best.len;
    // Inward normal: the side of the wall the room's centre is on
    let nx = -uz, nz = ux;
    const mx = best.a.x + ux * (s0 + width / 2), mz = best.a.z + uz * (s0 + width / 2);
    if ((cx - mx) * nx + (cz - mz) * nz < 0) { nx = -nx; nz = -nz; }
    openings.push({
      kind: isDoor ? 'door' : 'window',
      poi_id: t.poi_id,
      a: { x: best.a.x + ux * s0, z: best.a.z + uz * s0 },
      b: { x: best.a.x + ux * (s0 + width), z: best.a.z + uz * (s0 + width) },
      inward: { x: nx, z: nz },
    });
  }

  return { boxes, boxOf, dots, openings };
}
