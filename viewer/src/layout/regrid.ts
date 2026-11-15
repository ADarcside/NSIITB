/**
 * Namma Space: patch the walkable grid after furniture moves (Rearrange)
 *
 * Never rebuilds the whole grid: the published walkable bits stay everywhere except within
 * PATCH_M of the old and new footprints (the browser lacks the opacity sums pipeline/grid.py
 * uses, so a full rebuild would change paths with nothing moved). With no moves the result is the
 * published grid itself. Height layers are patched too, so climbing and flying follow the move.
 * A move is always from the original position (never chained). Pure: unit-tested on K-720.
 */

import type { NavGrid } from '../contracts/types.js';
import { decodeBase64ToBytes, distanceToCells } from '../collision/grid.js';
import type { MovableObject } from './objects.js';

export interface Move {
  /** MovableObject id (plan box id) */
  id: number;
  /** Slide on the floor from the original spot (m) */
  dx: number;
  dz: number;
  /** Turn about the lifted box centre, degrees (positive = counter-clockwise seen from above) */
  turnDeg: number;
}

/** Cells farther than this from both footprints keep their published walkable bit */
export const PATCH_M = 0.3;
/** Walking body height band, as pipeline/grid.py (height_band_m) */
const BAND_LO_M = 0.2;
const BAND_HI_M = 1.7;

const bitAt = (bytes: Uint8Array, i: number): number => (bytes[i >> 3] >> (7 - (i & 7))) & 1;

export function unpackBits(b64: string, count: number): Uint8Array {
  const bytes = decodeBase64ToBytes(b64);
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) out[i] = (i >> 3) < bytes.length ? bitAt(bytes, i) : 0;
  return out;
}

export function packBits(bits: Uint8Array): string {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) if (bits[i]) bytes[i >> 3] |= 0x80 >> (i & 7);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Normalised turn in [0, 360) */
const normTurn = (deg: number): number => ((deg % 360) + 360) % 360;

export function isIdentityMove(m: Move): boolean {
  const t = normTurn(m.turnDeg);
  return Math.abs(m.dx) < 1e-6 && Math.abs(m.dz) < 1e-6 && (t < 1e-6 || 360 - t < 1e-6);
}

/** Maps a world point at the new spot back to where it was before the move */
export function backToOriginal(o: MovableObject, m: Move): (x: number, z: number) => [number, number] {
  const cx = (o.lift.minX + o.lift.maxX) / 2;
  const cz = (o.lift.minZ + o.lift.maxZ) / 2;
  const a = (-normTurn(m.turnDeg) * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  return (x, z) => {
    const px = x - cx - m.dx, pz = z - cz - m.dz;
    // Rotation about +Y by angle a, in the x/z plane (three.js convention: x' = x cos + z sin)
    return [cx + px * cos + pz * sin, cz - px * sin + pz * cos];
  };
}

export interface PatchResult {
  grid: NavGrid;
  /** Cells the patch looked at (within PATCH_M of a footprint) */
  region: Uint8Array;
  /** Old and new footprints (cells), for checks and drawing */
  oldFootprint: Uint8Array;
  newFootprint: Uint8Array;
}

/**
 * Returns the walkable grid with the moves applied. Moves that are identities or name unknown
 * objects are skipped, so no moves (or only identities) returns the published grid unchanged.
 */
export function patchGrid(grid: NavGrid, objects: MovableObject[], moves: Move[]): PatchResult {
  const w = grid.width, h = grid.height, n = w * h, cell = grid.cell_m;
  const [ox, oz] = grid.origin;
  const byId = new Map(objects.map(o => [o.id, o]));
  const active = moves.filter(m => byId.has(m.id) && !isIdentityMove(m));
  const oldFp = new Uint8Array(n), newFp = new Uint8Array(n), region = new Uint8Array(n);
  if (!active.length) return { grid, region, oldFootprint: oldFp, newFootprint: newFp };

  const L = grid.layers;
  const layers = L ? unpackBits(L.occupied_bits_b64, L.count * n) : null;
  const free = unpackBits(grid.free_bits_b64, n);
  const cx = (c: number) => ox + (c + 0.5) * cell;
  const cz = (r: number) => oz + (r + 0.5) * cell;
  const cellOf = (x: number, z: number): number => {
    const c = Math.floor((x - ox) / cell), r = Math.floor((z - oz) / cell);
    return c < 0 || r < 0 || c >= w || r >= h ? -1 : r * w + c;
  };
  const inLift = (o: MovableObject, x: number, z: number) =>
    x >= o.lift.minX && x < o.lift.maxX && z >= o.lift.minZ && z < o.lift.maxZ;
  // The reach adds the wall end that the grid had hidden in the wall band: it blocks at the new spot
  const inReach = (o: MovableObject, x: number, z: number) =>
    x >= o.reach.minX && x < o.reach.maxX && z >= o.reach.minZ && z < o.reach.maxZ;

  // 1. Take every moved object's layer bits out (all first, so two objects can swap places)
  const saved = new Map<number, Uint8Array>();
  for (const m of active) {
    const o = byId.get(m.id)!;
    const bits = new Uint8Array(layers ? L!.count * n : 0);
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        if (!inLift(o, cx(c), cz(r))) continue;
        const i = r * w + c;
        oldFp[i] = 1;
        if (layers && o.l0 >= 0) {
          for (let l = o.l0; l <= o.l1; l++) {
            bits[l * n + i] = layers[l * n + i];
            layers[l * n + i] = 0;
          }
        }
      }
    }
    saved.set(m.id, bits);
  }

  // 2. Write them at the new spot, sampling back from the original cells (a turned box has no holes)
  for (const m of active) {
    const o = byId.get(m.id)!;
    const back = backToOriginal(o, m);
    const bits = saved.get(m.id)!;
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const [sx, sz] = back(cx(c), cz(r));
        if (!inReach(o, sx, sz)) continue;
        const i = r * w + c;
        newFp[i] = 1;
        const src = cellOf(sx, sz);
        if (layers && o.l0 >= 0 && src >= 0 && inLift(o, sx, sz)) {
          for (let l = o.l0; l <= o.l1; l++) if (bits[l * n + src]) layers[l * n + i] = 1;
        }
      }
    }
  }

  // 3. Walkable bits, only near the footprints
  const radius = grid.agent_radius_m / cell; // cells
  const patchCells = PATCH_M / cell;
  const dOld = distanceToCells(w, h, i => oldFp[i] === 1);
  const dNew = distanceToCells(w, h, i => newFp[i] === 1);
  for (let i = 0; i < n; i++) region[i] = dOld[i] <= patchCells || dNew[i] <= patchCells ? 1 : 0;

  // Other obstacles in the walking band, from the patched layers (without layers: none known)
  let dOther: Float64Array | null = null;
  if (L && layers) {
    const eps = 1e-6;
    const lo = Math.max(0, Math.ceil((BAND_LO_M - L.y0_m) / L.dy_m - eps));
    const hi = Math.min(L.count - 1, Math.floor((BAND_HI_M - L.y0_m) / L.dy_m + eps) - 1);
    const occ = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (newFp[i]) continue; // the moved objects are handled by dNew
      for (let l = lo; l <= hi && !occ[i]; l++) occ[i] = layers[l * n + i];
    }
    dOther = distanceToCells(w, h, i => occ[i] === 1);
  }
  // Cells inside the scene bounds (the grid adds the body radius on every side as wall)
  const pad = Math.round(grid.agent_radius_m / cell);
  const inside = (i: number) => {
    const c = i % w, r = (i - c) / w;
    return c >= pad && r >= pad && c < w - pad && r < h - pad;
  };

  const out = free.slice();
  const freed: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!region[i]) continue;
    if (dNew[i] <= radius) { out[i] = 0; continue; }
    if (free[i]) continue;
    // Blocked before: free it only when the old object was the reason and nothing else is near
    if (dOld[i] <= radius + 0.5 && inside(i) && (dOther === null || dOther[i] > radius)) freed.push(i);
  }
  // Freed cells count only when joined (4-way) to walkable floor, so no pocket opens inside furniture
  for (const i of freed) out[i] = 2;
  const stack: number[] = [];
  for (const i of freed) {
    const c = i % w, r = (i - c) / w;
    const near = [c > 0 ? i - 1 : -1, c < w - 1 ? i + 1 : -1, r > 0 ? i - w : -1, r < h - 1 ? i + w : -1];
    if (near.some(j => j >= 0 && out[j] === 1)) { out[i] = 1; stack.push(i); }
  }
  while (stack.length) {
    const i = stack.pop()!;
    const c = i % w, r = (i - c) / w;
    for (const j of [c > 0 ? i - 1 : -1, c < w - 1 ? i + 1 : -1, r > 0 ? i - w : -1, r < h - 1 ? i + w : -1]) {
      if (j >= 0 && out[j] === 2) { out[j] = 1; stack.push(j); }
    }
  }
  for (const i of freed) if (out[i] === 2) out[i] = 0;

  const patched: NavGrid = { ...grid, free_bits_b64: packBits(out) };
  if (L && layers) patched.layers = { ...L, occupied_bits_b64: packBits(layers) };
  return { grid: patched, region, oldFootprint: oldFp, newFootprint: newFp };
}
