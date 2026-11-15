/**
 * Namma Space: movable objects for Rearrange (move furniture)
 *
 * Turns the floor plan boxes (plan.boxes, never the tidied minimap boxes) into objects that can be
 * lifted out: the box on the floor, the part of it that is lifted (pulled in from walls), and the
 * height range. Pure: no DOM, no renderer, so it is unit-tested on the live K-720 grid.
 */

import type { NavGrid } from '../contracts/types.js';
import { decodeBase64ToBytes } from '../collision/grid.js';
import type { FloorPlan, PlanMasks } from '../nav/floorplan.js';
import type { BoxEdit } from './layout_file.js';

export { ADDED_BOX_ID, cleanBoxEdits, type BoxEdit } from './layout_file.js';

export interface MovableObject {
  /** plan.boxes id */
  id: number;
  /** The box on the floor plan (world metres) */
  box: { minX: number; minZ: number; maxX: number; maxZ: number };
  /** The lifted box: the plan box pulled in on sides that touch a wall. Grid footprint and pivot. */
  lift: { minX: number; minZ: number; maxX: number; maxZ: number };
  /**
   * How far the splats reach: the lift, except that a side against the room's outer wall goes on
   * to the wall itself. The grid marks a body radius along every outer wall as solid, so the plan
   * box stops 25 cm short of it and a bunk's wall end (pillow, end frame) was left behind. Splat
   * lifting narrows this to just in front of the wall surface (lift.ts fitReachToWalls).
   */
  reach: { minX: number; minZ: number; maxX: number; maxZ: number };
  /** Lifted height range in metres (lift starts just above the floor) */
  y0: number;
  y1: number;
  /** Height layers that belong to the object (inclusive), or -1 when the grid has none */
  l0: number;
  l1: number;
  /**
   * Pieces of this object that stick out into a neighbour's box (a table top running under the
   * end of a bunk). Lifted with this object, and cut out of the neighbour's lift.
   */
  extra: LiftPiece[];
  /** Pieces inside this box that belong to a neighbour (its extra): never lifted with this object */
  cut: LiftPiece[];
}

/** A world-space box with a height range */
export interface LiftPiece {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  y0: number;
  y1: number;
}

export const OBJECT_TUNING = {
  /** Floor area above which a box does not move (m²) */
  maxAreaM2: 4,
  /**
   * A side whose outside strip is mostly wall is pulled in by this much (m). The plan box already
   * ends at the wall face (K-720: solid wall starts in the very next cell), so this only keeps wall
   * splats out. 7.5 cm left a bunk's wall-side legs behind; 2 cm takes the whole bunk.
   */
  wallInsetM: 0.02,
  /** Without splats to find the wall, a side at the outer wall reaches this close to the grid edge */
  edgeGapM: 0.05,
  /** The lift starts this far above the floor, so the floor stays behind */
  floorM: 0.05,
  /** Going up, an empty gap this tall across the whole footprint ends the object */
  gapM: 0.4,
  /** Never lift closer than this to the ceiling */
  ceilingMarginM: 0.2,
  /** A layer at least this full across the room floor counts as the ceiling */
  ceilingShare: 0.5,
  /** Fallback height when the grid has no height layers */
  noLayersHeightM: 1.0,
  /**
   * Going up, cells this close to a wall side do not keep the object going: a shelf, switchboard
   * or poster on the wall above a table belongs to the wall, not to the table (m)
   */
  wallBandM: 0.25,
  /** A flat part (table top) at most this thick may reach into a neighbour's box (m) */
  slabMaxM: 0.4,
  /** Share of a column's cells the flat part must fill to keep going into the neighbour */
  slabFill: 0.5,
  /** ...while the layers just above and below it in that column stay this empty (the neighbour's own parts) */
  slabClear: 0.3,
  /** How far a flat part may reach into a neighbour's box (m) */
  slabReachM: 0.4,
  /** Flat parts lower than this are not followed (seats, bed frames) (m) */
  slabMinY: 0.2,
  /** Going up, a layer needs at least this many filled cells to keep the object going (stray cells don't) */
  minLayerCells: 3,
};

const bitAt = (bytes: Uint8Array, i: number): number => (bytes[i >> 3] >> (7 - (i & 7))) & 1;

/** Highest y the lift may reach: just under the ceiling layer, or under the top of the layers */
export function ceilingY(grid: NavGrid, floor: Uint8Array): number {
  const L = grid.layers;
  if (!L) return Infinity;
  const bytes = decodeBase64ToBytes(L.occupied_bits_b64);
  const n = grid.width * grid.height;
  let floorCells = 0;
  for (let i = 0; i < n; i++) floorCells += floor[i];
  const top = L.y0_m + L.count * L.dy_m;
  if (!floorCells) return top;
  for (let l = 0; l < L.count; l++) {
    const y = L.y0_m + l * L.dy_m;
    if (y < 1.8) continue;
    let k = 0;
    for (let i = 0; i < n; i++) if (floor[i]) k += bitAt(bytes, l * n + i);
    if (k >= OBJECT_TUNING.ceilingShare * floorCells) return y;
  }
  return top;
}

/**
 * The plan with the owner's box fixes: an edited or added box replaces the detected one and is
 * always movable (the owner said it is furniture), a removed box is no longer an object. Boxes are
 * snapped to grid cells and kept inside the grid.
 */
export function applyBoxEdits(grid: NavGrid, plan: FloorPlan, edits: readonly BoxEdit[] | undefined): { plan: FloorPlan; forced: Set<number> } {
  if (!edits?.length) return { plan, forced: new Set() };
  const cell = grid.cell_m;
  const [ox, oz] = grid.origin;
  const snap = (v: number, o: number, n: number) => o + Math.min(n, Math.max(0, Math.round((v - o) / cell))) * cell;
  const byId = new Map(plan.boxes.map(b => [b.id, b]));
  const forced = new Set<number>();
  for (const e of edits) {
    if (!Number.isInteger(e.id)) continue;
    if (e.removed) {
      byId.delete(e.id);
      continue;
    }
    const minX = snap(Math.min(e.minX, e.maxX), ox, grid.width), maxX = snap(Math.max(e.minX, e.maxX), ox, grid.width);
    const minZ = snap(Math.min(e.minZ, e.maxZ), oz, grid.height), maxZ = snap(Math.max(e.minZ, e.maxZ), oz, grid.height);
    if (maxX - minX < cell * 2 || maxZ - minZ < cell * 2) continue;
    byId.set(e.id, { id: e.id, minX, minZ, maxX, maxZ, tall: false });
    forced.add(e.id);
  }
  return { plan: { ...plan, boxes: [...byId.values()].sort((a, b) => a.id - b.id) }, forced };
}

/**
 * The movable objects of a plan: not tall (cupboards, pillars) and under maxAreaM2 of floor, plus
 * every box in `forced` (the owner fixed or added it, so it is furniture whatever its size).
 */
export function movableObjects(grid: NavGrid, plan: FloorPlan, masks: PlanMasks, forced: ReadonlySet<number> = new Set()): MovableObject[] {
  const T = OBJECT_TUNING;
  const { w, h, floor } = masks;
  const cell = grid.cell_m;
  const [ox, oz] = grid.origin;
  const L = grid.layers;
  const bytes = L ? decodeBase64ToBytes(L.occupied_bits_b64) : null;
  const n = w * h;
  const cap = ceilingY(grid, floor) - T.ceilingMarginM;
  const out: MovableObject[] = [];

  for (const b of plan.boxes) {
    if (!forced.has(b.id)) {
      if (b.tall) continue;
      if ((b.maxX - b.minX) * (b.maxZ - b.minZ) > T.maxAreaM2) continue;
    }
    const c0 = Math.round((b.minX - ox) / cell);
    const c1 = Math.round((b.maxX - ox) / cell) - 1;
    const r0 = Math.round((b.minZ - oz) / cell);
    const r1 = Math.round((b.maxZ - oz) / cell) - 1;

    // Share of a strip of cells (just outside one side) that is not room floor
    const wallShare = (cells: [number, number][]): number => {
      let k = 0, all = 0;
      for (const [c, r] of cells) {
        all++;
        if (c < 0 || r < 0 || c >= w || r >= h || !floor[r * w + c]) k++;
      }
      return all ? k / all : 0;
    };
    const strip = (side: 'minX' | 'maxX' | 'minZ' | 'maxZ'): [number, number][] => {
      const cells: [number, number][] = [];
      for (let d = 1; d <= 2; d++) {
        if (side === 'minX' || side === 'maxX') {
          const c = side === 'minX' ? c0 - d : c1 + d;
          for (let r = r0; r <= r1; r++) cells.push([c, r]);
        } else {
          const r = side === 'minZ' ? r0 - d : r1 + d;
          for (let c = c0; c <= c1; c++) cells.push([c, r]);
        }
      }
      return cells;
    };
    type Side = 'minX' | 'maxX' | 'minZ' | 'maxZ';
    const walled = (side: Side) => wallShare(strip(side)) >= 0.5;
    const inset = (side: Side) => (walled(side) ? T.wallInsetM : 0);
    const lift = {
      minX: b.minX + inset('minX'),
      maxX: b.maxX - inset('maxX'),
      minZ: b.minZ + inset('minZ'),
      maxZ: b.maxZ - inset('maxZ'),
    };
    // Sides against the outer wall: only the body-radius band lies between the box and the grid edge
    const pad = Math.round(grid.agent_radius_m / cell) + 2;
    const atEdge = (side: Side) =>
      walled(side) && (side === 'minX' ? c0 <= pad : side === 'maxX' ? c1 >= w - 1 - pad : side === 'minZ' ? r0 <= pad : r1 >= h - 1 - pad);
    const reach = {
      minX: atEdge('minX') ? ox + T.edgeGapM : lift.minX,
      maxX: atEdge('maxX') ? ox + w * cell - T.edgeGapM : lift.maxX,
      minZ: atEdge('minZ') ? oz + T.edgeGapM : lift.minZ,
      maxZ: atEdge('maxZ') ? oz + h * cell - T.edgeGapM : lift.maxZ,
    };

    // Height: from the floor up to the first empty gap of gapM across the footprint, leaving out a
    // band along wall sides (what hangs on the wall above stays). A box too thin for that uses all.
    const band = Math.round(T.wallBandM / cell);
    // A shallow box keeps at least 3 cells: the band narrows (a 35 cm table under a wall rack)
    const keep = (a: number, b: number, lo: boolean, hi: boolean): [number, number] => {
      const sides = (lo ? 1 : 0) + (hi ? 1 : 0);
      const bb = sides ? Math.max(0, Math.min(band, Math.floor((b - a + 1 - 3) / sides))) : 0;
      return [lo ? a + bb : a, hi ? b - bb : b];
    };
    const [hc0, hc1] = keep(c0, c1, walled('minX'), walled('maxX'));
    const [hr0, hr1] = keep(r0, r1, walled('minZ'), walled('maxZ'));
    let y1 = T.noLayersHeightM;
    let l0 = -1, l1 = -1;
    if (L && bytes) {
      const gapLayers = Math.max(1, Math.round(T.gapM / L.dy_m));
      let top = -1, empty = 0;
      for (let l = 0; l < L.count; l++) {
        if (L.y0_m + l * L.dy_m >= cap) break;
        let k = 0;
        const need = Math.min(T.minLayerCells, (hr1 - hr0 + 1) * (hc1 - hc0 + 1));
        for (let r = hr0; r <= hr1 && k < need; r++) {
          for (let c = hc0; c <= hc1 && k < need; c++) k += bitAt(bytes, l * n + r * w + c);
        }
        const hit = k >= need;
        if (hit) { top = l; empty = 0; } else if (top >= 0 && ++empty >= gapLayers) break;
      }
      if (top < 0) continue; // nothing in the layers: not an object
      l0 = 0;
      l1 = top;
      y1 = Math.min(cap, L.y0_m + (top + 1) * L.dy_m + 0.05);
      // Floor to ceiling with no gap: a built-in (cupboard, door frame), not furniture. The owner
      // can still make it movable with the box tool.
      if (y1 >= cap && !forced.has(b.id)) continue;
    }
    out.push({ id: b.id, box: { minX: b.minX, minZ: b.minZ, maxX: b.maxX, maxZ: b.maxZ }, lift, reach, y0: T.floorM, y1, l0, l1, extra: [], cut: [] });
  }
  if (L && bytes) findOverhangs(grid, bytes, plan, out);
  return out;
}

/**
 * Flat parts that run on into a neighbouring box: a table top that goes under the end of a bunk was
 * split at the bunk's box edge, so its end stayed behind. For each side of an object that touches
 * another box, a thin band of layers filled along the edge column (the table top) is followed into
 * the neighbour column by column while it stays filled and the layers just above and below it stay
 * empty (the neighbour's own parts there end it). The piece found goes with the object and is cut
 * out of the neighbour's lift.
 */
function findOverhangs(grid: NavGrid, bytes: Uint8Array, plan: FloorPlan, objs: MovableObject[]): void {
  const T = OBJECT_TUNING;
  const L = grid.layers!;
  const w = grid.width, h = grid.height, n = w * h;
  const cell = grid.cell_m;
  const [ox, oz] = grid.origin;
  const maxSlab = Math.max(1, Math.round(T.slabMaxM / L.dy_m));
  const maxSteps = Math.max(1, Math.round(T.slabReachM / cell));
  const cellBox = (b: { minX: number; maxX: number; minZ: number; maxZ: number }) => ({
    c0: Math.round((b.minX - ox) / cell), c1: Math.round((b.maxX - ox) / cell) - 1,
    r0: Math.round((b.minZ - oz) / cell), r1: Math.round((b.maxZ - oz) / cell) - 1,
  });
  const byId = new Map(objs.map(o => [o.id, o]));
  type Side = 'minX' | 'maxX' | 'minZ' | 'maxZ';
  const found: { from: number; to: number; piece: LiftPiece }[] = [];
  for (const a of objs) {
    const A = cellBox(a.box);
    for (const nb of plan.boxes) {
      if (nb.id === a.id) continue;
      const B = cellBox(nb);
      for (const side of ['minX', 'maxX', 'minZ', 'maxZ'] as Side[]) {
        const alongX = side === 'minZ' || side === 'maxZ';
        // The neighbour must start right at this side and share some of its length
        const touch = side === 'minX' ? B.c1 === A.c0 - 1 : side === 'maxX' ? B.c0 === A.c1 + 1 : side === 'minZ' ? B.r1 === A.r0 - 1 : B.r0 === A.r1 + 1;
        if (!touch) continue;
        const s0 = alongX ? Math.max(A.c0, B.c0) : Math.max(A.r0, B.r0);
        const s1 = alongX ? Math.min(A.c1, B.c1) : Math.min(A.r1, B.r1);
        if (s1 - s0 < 2) continue;
        const dir = side === 'minX' || side === 'minZ' ? -1 : 1;
        const edge = side === 'minX' ? A.c0 : side === 'maxX' ? A.c1 : side === 'minZ' ? A.r0 : A.r1;
        const idx = (k: number, s: number) => (alongX ? k * w + s : s * w + k);
        const at = (l: number, k: number, s: number) => (bitAt(bytes, l * n + idx(k, s)) === 1 ? 1 : 0);
        // The cells along the edge column that the flat part covers, per layer
        const layerFill = (k: number, l: number, ss: number[]) => {
          let f = 0;
          for (const s of ss) f += at(l, k, s);
          return ss.length ? f / ss.length : 0;
        };
        const all: number[] = [];
        for (let s = s0; s <= s1; s++) all.push(s);
        // Thin band of filled layers on the edge column, above the floor and under the object top
        let best: [number, number] | null = null;
        const lMin = Math.max(1, Math.ceil((T.slabMinY - L.y0_m) / L.dy_m));
        for (let l = lMin; l <= a.l1; l++) {
          if (layerFill(edge, l, all) < T.slabFill) continue;
          let e = l;
          while (e + 1 <= a.l1 && layerFill(edge, e + 1, all) >= T.slabFill) e++;
          if (e - l + 1 <= maxSlab) best = [l, e];
          l = e;
        }
        if (!best) continue;
        const [la, lb] = best;
        // Along the side: the cells the flat part fills on the edge column
        const span = all.filter(s => { for (let l = la; l <= lb; l++) if (at(l, edge, s)) return true; return false; });
        if (span.length < 3) continue;
        const sa = span[0], sb = span[span.length - 1];
        const ss = all.filter(s => s >= sa && s <= sb);
        let steps = 0;
        for (let k = edge + dir; steps < maxSteps; k += dir, steps++) {
          if (k < 0 || k >= (alongX ? h : w)) break;
          let fill = 0;
          for (let l = la; l <= lb; l++) fill = Math.max(fill, layerFill(k, l, ss));
          const below = la - 1 >= 1 ? layerFill(k, la - 1, ss) : 0;
          const above = lb + 1 < L.count ? layerFill(k, lb + 1, ss) : 0;
          if (fill < T.slabFill || below > T.slabClear || above > T.slabClear) break;
        }
        if (steps < 1) continue;
        const k0 = dir < 0 ? edge - steps : edge + 1;
        const k1 = dir < 0 ? edge - 1 : edge + steps;
        const piece: LiftPiece = alongX
          ? { minX: ox + sa * cell, maxX: ox + (sb + 1) * cell, minZ: oz + k0 * cell, maxZ: oz + (k1 + 1) * cell, y0: L.y0_m + la * L.dy_m - 0.05, y1: L.y0_m + (lb + 2) * L.dy_m }
          : { minX: ox + k0 * cell, maxX: ox + (k1 + 1) * cell, minZ: oz + sa * cell, maxZ: oz + (sb + 1) * cell, y0: L.y0_m + la * L.dy_m - 0.05, y1: L.y0_m + (lb + 2) * L.dy_m };
        found.push({ from: a.id, to: nb.id, piece });
      }
    }
  }
  // Two pieces reaching into each other's boxes at the same height: one flat part seen from both
  // sides (a chair seat pushed under a table). It lies mostly in the box of the object that reaches
  // less far into the other, so that piece stays and the other is dropped (a tie drops both).
  const depth = (p: LiftPiece) => Math.min(p.maxX - p.minX, p.maxZ - p.minZ);
  for (const f of found) {
    const rival = found.find(g => g.from === f.to && g.to === f.from && g.piece.y0 < f.piece.y1 && f.piece.y0 < g.piece.y1);
    if (rival && depth(f.piece) >= depth(rival.piece) - 1e-9) continue;
    byId.get(f.from)!.extra.push(f.piece);
    byId.get(f.to)?.cut.push(f.piece);
  }
}

/**
 * A box minus some pieces, as boxes that do not overlap (at most six per piece). Used to lift and
 * hide an object without the parts of it that belong to a neighbour.
 */
export function boxMinus(box: LiftPiece, cuts: readonly LiftPiece[]): LiftPiece[] {
  let parts: LiftPiece[] = [box];
  for (const c of cuts) {
    const next: LiftPiece[] = [];
    for (const p of parts) {
      const ix0 = Math.max(p.minX, c.minX), ix1 = Math.min(p.maxX, c.maxX);
      const iz0 = Math.max(p.minZ, c.minZ), iz1 = Math.min(p.maxZ, c.maxZ);
      const iy0 = Math.max(p.y0, c.y0), iy1 = Math.min(p.y1, c.y1);
      if (ix0 >= ix1 || iz0 >= iz1 || iy0 >= iy1) { next.push(p); continue; }
      const add = (q: LiftPiece) => { if (q.maxX > q.minX && q.maxZ > q.minZ && q.y1 > q.y0) next.push(q); };
      add({ ...p, maxX: ix0 });
      add({ ...p, minX: ix1 });
      add({ ...p, minX: ix0, maxX: ix1, maxZ: iz0 });
      add({ ...p, minX: ix0, maxX: ix1, minZ: iz1 });
      add({ minX: ix0, maxX: ix1, minZ: iz0, maxZ: iz1, y0: p.y0, y1: iy0 });
      add({ minX: ix0, maxX: ix1, minZ: iz0, maxZ: iz1, y0: iy1, y1: p.y1 });
    }
    parts = next;
  }
  return parts;
}
