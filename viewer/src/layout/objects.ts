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
  gapM: 0.5,
  /** Never lift closer than this to the ceiling */
  ceilingMarginM: 0.2,
  /** A layer at least this full across the room floor counts as the ceiling */
  ceilingShare: 0.5,
  /** Fallback height when the grid has no height layers */
  noLayersHeightM: 1.0,
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

    // Height: from the floor up to the first empty gap of gapM across the whole footprint
    let y1 = T.noLayersHeightM;
    let l0 = -1, l1 = -1;
    if (L && bytes) {
      const gapLayers = Math.max(1, Math.round(T.gapM / L.dy_m));
      let top = -1, empty = 0;
      for (let l = 0; l < L.count; l++) {
        if (L.y0_m + l * L.dy_m >= cap) break;
        let hit = false;
        for (let r = r0; r <= r1 && !hit; r++) {
          for (let c = c0; c <= c1 && !hit; c++) hit = bitAt(bytes, l * n + r * w + c) === 1;
        }
        if (hit) { top = l; empty = 0; } else if (top >= 0 && ++empty >= gapLayers) break;
      }
      if (top < 0) continue; // nothing in the layers: not an object
      l0 = 0;
      l1 = top;
      y1 = Math.min(cap, L.y0_m + (top + 1) * L.dy_m + 0.05);
    }
    out.push({ id: b.id, box: { minX: b.minX, minZ: b.minZ, maxX: b.maxX, maxZ: b.maxZ }, lift, reach, y0: T.floorM, y1, l0, l1 });
  }
  return out;
}
