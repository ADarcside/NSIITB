/**
 * Namma Space: fill the floor where a moved object stood (Rearrange, phase 2)
 *
 * The floor under furniture was barely seen by the camera, so the old spot shows a dark smear.
 * The fill hides the old spot down through the floor and lays a made floor there (synthFloor): a
 * regular grid of flat splats coloured by blending the real floor just outside the hole's sides.
 * planFloorFill first checks that the room has clean floor near the hole to take from (no furniture,
 * no low clutter, even brightness), and picks a source patch for a later textured fill; with none,
 * the hole is left as scanned rather than hidden. Pure: no renderer, unit-tested with hand-made arrays.
 */

import type { NavGrid } from '../contracts/types.js';
import { decodeBase64ToBytes, distanceToCells } from '../collision/grid.js';
import { halfTable, type FloorBox, type PackedSource } from './lift.js';

export const FILL_TUNING = {
  /** The hide reaches down to here under a filled hole (m), taking the noisy under-floor splats */
  hideLo: -0.15,
  /** Low clutter: opaque splats from lowFromM to lowTopM above the floor; a grid cell with at least
   *  lowSplats of them is not clean */
  lowFromM: 0.08,
  lowTopM: 0.35,
  lowSplats: 3,
  /** Each step of patch brightness spread (0 to 1) costs this much (keeps clutter out of the source) */
  spreadCost: 2,
  /** Heights used to call a floor cell clean (m): nothing in the layers from 0.1 m up to this */
  clutterTopM: 1.6,
  /** The source keeps this far from other furniture (m) */
  avoidMarginM: 0.05,
  /** Offsets tried, up to this far (m), on the grid's cells */
  searchM: 3.0,
  /** At most this share of the source may be unclean */
  maxDirty: 0.02,
  /** Floor ring around the hole compared for the look (m) */
  ringM: 0.1,
  /** Colour raster cell (m) */
  rasterM: 0.02,
  /** Square patch sizes tried when no source as big as the hole is clean (m), largest first */
  patchesM: [0.9, 0.6, 0.45, 0.3],
  /** Each metre of offset costs this much look difference (keeps the source near) */
  distCost: 1.5,
  /** Colour scale limits */
  scaleMin: 0.75,
  scaleMax: 1.35,
  /** A splat counts for the colour raster when its opacity is at least this */
  minAlpha: 0.25,
};

/** Mean floor colour per raster cell, from the scan's floor splats */
export interface FloorRaster {
  x0: number;
  z0: number;
  res: number;
  w: number;
  h: number;
  /** Opaque splats just above the floor per cell: low clutter (shoes, bags) the grid can't see */
  low: Uint32Array;
  /** Per cell: the most solid floor splat (opacity x footprint), or -1 */
  best: Int32Array;
  /** Sum of r, g, b and count per cell */
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  n: Uint32Array;
}

export function floorRaster(src: PackedSource, m: ArrayLike<number>, grid: NavGrid): FloorRaster {
  const T = FILL_TUNING;
  const res = T.rasterM;
  const [x0, z0] = grid.origin;
  const w = Math.ceil((grid.width * grid.cell_m) / res), h = Math.ceil((grid.height * grid.cell_m) / res);
  const R = new Float32Array(w * h), G = new Float32Array(w * h), B = new Float32Array(w * h), N = new Uint32Array(w * h);
  const low = new Uint32Array(w * h);
  const best = new Int32Array(w * h).fill(-1);
  const bestW = new Float32Array(w * h);
  const half = halfTable();
  const P = src.packedArray;
  const aMin = Math.round(T.minAlpha * 255);
  for (let i = 0; i < src.numSplats; i++) {
    const w0 = P[i * 4];
    if (w0 >>> 24 < aMin) continue;
    const w1 = P[i * 4 + 1], w2 = P[i * 4 + 2];
    const lx = half[w1 & 0xffff], ly = half[w1 >>> 16], lz = half[w2 & 0xffff];
    const y = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
    if (y < -0.04 || y >= T.lowTopM) continue;
    const x = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
    const z = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
    const c = Math.floor((x - x0) / res), r = Math.floor((z - z0) / res);
    if (c < 0 || r < 0 || c >= w || r >= h) continue;
    const k = r * w + c;
    if (y >= T.lowFromM) { low[k]++; continue; }
    if (y >= 0.04) continue;
    const w3 = P[i * 4 + 3];
    const foot = (w0 >>> 24) * Math.exp(((w3 & 0xff) + ((w3 >>> 16) & 0xff)) * 0.05);
    if (foot > bestW[k]) { bestW[k] = foot; best[k] = i; }
    R[k] += w0 & 0xff;
    G[k] += (w0 >>> 8) & 0xff;
    B[k] += (w0 >>> 16) & 0xff;
    N[k]++;
  }
  return { x0, z0, res, w, h, low, best, r: R, g: G, b: B, n: N };
}

/** One piece of the fill: the dest box takes the floor from dest minus (dx, dz) */
export interface FillTile {
  box: FloorBox;
  dx: number;
  dz: number;
}

export interface FillPlan {
  /** The hole (world box on the floor) */
  hole: FloorBox;
  /**
   * The pieces covering the hole. One piece when a clean source as big as the hole is near;
   * otherwise the hole is tiled with copies of one clean patch (a regular pattern).
   */
  tiles: FillTile[];
  /** Colour scale for the copy (r, g, b) */
  scale: [number, number, number];
  /** Share of the source that is clean (1 = all) */
  clean: number;
}

const bitAt = (bytes: Uint8Array, i: number): number => (bytes[i >> 3] >> (7 - (i & 7))) & 1;

/**
 * Picks the source for each hole. floor = 1 inside the room (floor plan masks); avoid = boxes the
 * source must stay clear of (every object, moved or not, at its original spot). Tries the whole
 * hole first, then smaller square patches (FILL_TUNING.patchesM) tiled across it. Null for a hole
 * with no usable source.
 */
export function planFloorFill(
  grid: NavGrid,
  floor: Uint8Array,
  raster: FloorRaster,
  holes: FloorBox[],
  avoid: FloorBox[]
): (FillPlan | null)[] {
  const T = FILL_TUNING;
  const w = grid.width, h = grid.height, n = w * h, cell = grid.cell_m;
  const [ox, oz] = grid.origin;
  // Clean cells: nothing standing on them (floor) or the band along a wall, clear of every object
  const L = grid.layers;
  const bytes = L ? decodeBase64ToBytes(L.occupied_bits_b64) : null;
  const top = L ? Math.min(L.count - 1, Math.floor((T.clutterTopM - L.y0_m) / L.dy_m)) : -1;
  const clean = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!floor[i]) continue;
    let busy = false;
    if (bytes) for (let l = 0; l <= top && !busy; l++) busy = bitAt(bytes, l * n + i) === 1;
    if (!busy) clean[i] = 1;
  }
  {
    const per = Math.max(1, Math.round(cell / raster.res));
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      let k = 0;
      for (let rr = r * per; rr < (r + 1) * per && rr < raster.h; rr++) {
        for (let cc = c * per; cc < (c + 1) * per && cc < raster.w; cc++) k += raster.low[rr * raster.w + cc];
      }
      if (k >= T.lowSplats) clean[r * w + c] = 0;
    }
  }
  for (const a of avoid) {
    const c0 = Math.max(0, Math.floor((a.minX - T.avoidMarginM - ox) / cell)), c1 = Math.min(w - 1, Math.floor((a.maxX + T.avoidMarginM - ox) / cell));
    const r0 = Math.max(0, Math.floor((a.minZ - T.avoidMarginM - oz) / cell)), r1 = Math.min(h - 1, Math.floor((a.maxZ + T.avoidMarginM - oz) / cell));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) clean[r * w + c] = 0;
  }
  const S = Math.round(T.searchM / cell);
  // Brightness per grid cell (from the raster), as running sums, for the spread of a patch
  const I1 = new Float64Array((w + 1) * (h + 1)), I2 = new Float64Array((w + 1) * (h + 1)), IN = new Float64Array((w + 1) * (h + 1));
  {
    const per = Math.max(1, Math.round(cell / raster.res));
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        let sum = 0, k = 0;
        for (let rr = r * per; rr < (r + 1) * per && rr < raster.h; rr++) {
          for (let cc = c * per; cc < (c + 1) * per && cc < raster.w; cc++) {
            const q = rr * raster.w + cc;
            if (raster.n[q]) { sum += (raster.r[q] + raster.g[q] + raster.b[q]) / (3 * raster.n[q]); k++; }
          }
        }
        const v = k ? sum / k / 255 : 0;
        const at = (r + 1) * (w + 1) + c + 1;
        I1[at] = v + I1[at - 1] + I1[at - w - 1] - I1[at - w - 2];
        I2[at] = v * v + I2[at - 1] + I2[at - w - 1] - I2[at - w - 2];
        IN[at] = (k ? 1 : 0) + IN[at - 1] + IN[at - w - 1] - IN[at - w - 2];
      }
    }
  }
  const rect = (I: Float64Array, c0: number, r0: number, cw: number, rh: number) => {
    const a = r0 * (w + 1) + c0, b = (r0 + rh) * (w + 1) + c0;
    return I[b + cw] - I[b] - I[a + cw] + I[a];
  };
  const spread = (c0: number, r0: number, cw: number, rh: number): number => {
    const k = rect(IN, c0, r0, cw, rh);
    if (k < 2) return 0;
    const m1 = rect(I1, c0, r0, cw, rh) / k;
    return Math.sqrt(Math.max(0, rect(I2, c0, r0, cw, rh) / k - m1 * m1));
  };

  return holes.map(hole => {
    const c0 = Math.max(0, Math.floor((hole.minX - ox) / cell)), c1 = Math.min(w - 1, Math.ceil((hole.maxX - ox) / cell) - 1);
    const r0 = Math.max(0, Math.floor((hole.minZ - oz) / cell)), r1 = Math.min(h - 1, Math.ceil((hole.maxZ - oz) / cell) - 1);
    if (c1 < c0 || r1 < r0) return null;
    const ring = ringCells(raster, hole, T.ringM);
    const ringMean = meanColour(raster, ring, 0, 0);
    const holeW = c1 - c0 + 1, holeH = r1 - r0 + 1;
    const sizes = [Math.max(holeW, holeH), ...T.patchesM.map(m => Math.round(m / cell))];
    for (const size of sizes) {
      const pw = Math.min(size, holeW), ph = Math.min(size, holeH);
      const whole = pw === holeW && ph === holeH;
      const allow = Math.floor(pw * ph * T.maxDirty);
      // Patch = the hole's first pw x ph cells shifted back by (dc, dr)
      let best: { score: number; dc: number; dr: number; dirty: number } | null = null;
      for (let dr = -S; dr <= S; dr++) {
        for (let dc = -S; dc <= S; dc++) {
          if (!dr && !dc) continue;
          const pr0 = r0 - dr, pc0 = c0 - dc;
          if (pr0 < 0 || pc0 < 0 || pr0 + ph > h || pc0 + pw > w) continue;
          let dirty = 0;
          for (let r = 0; r < ph && dirty <= allow; r++) {
            for (let c = 0; c < pw; c++) {
              if (!clean[(pr0 + r) * w + pc0 + c] && ++dirty > allow) break;
            }
          }
          if (dirty > allow) continue;
          let look: number | null;
          if (whole) look = ringDiff(raster, ring, dc * cell, dr * cell);
          else {
            const m = meanColour(raster, rasterCells(raster, { minX: ox + pc0 * cell, maxX: ox + (pc0 + pw) * cell, minZ: oz + pr0 * cell, maxZ: oz + (pr0 + ph) * cell }), 0, 0);
            look = m && ringMean ? Math.abs(lum(m) - lum(ringMean)) / 255 : null;
          }
          if (look === null) continue;
          const score = look + T.distCost * Math.hypot(dc, dr) * cell + T.spreadCost * spread(pc0, pr0, pw, ph);
          if (!best || score < best.score) best = { score, dc, dr, dirty };
        }
      }
      if (!best) continue;
      const pdx = best.dc * cell, pdz = best.dr * cell;
      const patch = { minX: ox + c0 * cell - pdx, minZ: oz + r0 * cell - pdz };
      const tiles: FillTile[] = [];
      const tw = pw * cell, th = ph * cell;
      for (let z = hole.minZ; z < hole.maxZ - 1e-6; z += th) {
        for (let x = hole.minX; x < hole.maxX - 1e-6; x += tw) {
          // Tiles start on the hole's corner; each one takes the patch from its own corner
          const box = { minX: x, maxX: Math.min(hole.maxX, x + tw), minZ: z, maxZ: Math.min(hole.maxZ, z + th) };
          const ax = x === hole.minX ? hole.minX - (ox + c0 * cell) : 0;
          const az = z === hole.minZ ? hole.minZ - (oz + r0 * cell) : 0;
          tiles.push({ box, dx: x - (patch.minX + ax), dz: z - (patch.minZ + az) });
        }
      }
      const srcMean = whole ? meanColour(raster, ring, pdx, pdz) : meanColour(raster, rasterCells(raster, { minX: patch.minX, maxX: patch.minX + tw, minZ: patch.minZ, maxZ: patch.minZ + th }), 0, 0);
      return { hole, tiles, scale: scaleOf(ringMean, srcMean), clean: 1 - best.dirty / (pw * ph) };
    }
    return null;
  });
}

const lum = (c: [number, number, number]): number => (c[0] + c[1] + c[2]) / 3;

function scaleOf(want: [number, number, number] | null, have: [number, number, number] | null): [number, number, number] {
  const T = FILL_TUNING;
  if (!want || !have) return [1, 1, 1];
  const s = (k: number) => (have[k] > 0 ? Math.min(T.scaleMax, Math.max(T.scaleMin, want[k] / have[k])) : 1);
  return [s(0), s(1), s(2)];
}

/** Raster cells inside a box */
function rasterCells(R: FloorRaster, b: FloorBox): number[] {
  const out: number[] = [];
  const c0 = Math.max(0, Math.floor((b.minX - R.x0) / R.res)), c1 = Math.min(R.w - 1, Math.ceil((b.maxX - R.x0) / R.res) - 1);
  const r0 = Math.max(0, Math.floor((b.minZ - R.z0) / R.res)), r1 = Math.min(R.h - 1, Math.ceil((b.maxZ - R.z0) / R.res) - 1);
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push(r * R.w + c);
  return out;
}

/** Mean colour of the cells (shifted back by the offset), or null with no data */
function meanColour(R: FloorRaster, cells: number[], dx: number, dz: number): [number, number, number] | null {
  const sc = Math.round(dx / R.res), sr = Math.round(dz / R.res);
  const a = [0, 0, 0];
  let k = 0;
  for (const i of cells) {
    const c = (i % R.w) - sc, r = Math.floor(i / R.w) - sr;
    if (c < 0 || r < 0 || c >= R.w || r >= R.h) continue;
    const j = r * R.w + c;
    if (!R.n[j]) continue;
    a[0] += R.r[j] / R.n[j]; a[1] += R.g[j] / R.n[j]; a[2] += R.b[j] / R.n[j];
    k++;
  }
  return k ? [a[0] / k, a[1] / k, a[2] / k] : null;
}

/** Raster cells in a ring just outside the box */
function ringCells(R: FloorRaster, b: FloorBox, width: number): number[] {
  const out: number[] = [];
  const c0 = Math.max(0, Math.floor((b.minX - width - R.x0) / R.res)), c1 = Math.min(R.w - 1, Math.floor((b.maxX + width - R.x0) / R.res));
  const r0 = Math.max(0, Math.floor((b.minZ - width - R.z0) / R.res)), r1 = Math.min(R.h - 1, Math.floor((b.maxZ + width - R.z0) / R.res));
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const x = R.x0 + (c + 0.5) * R.res, z = R.z0 + (r + 0.5) * R.res;
      if (x >= b.minX && x < b.maxX && z >= b.minZ && z < b.maxZ) continue;
      out.push(r * R.w + c);
    }
  }
  return out;
}

const lumAt = (R: FloorRaster, k: number): number => (R.r[k] + R.g[k] + R.b[k]) / (3 * R.n[k]);

/** Mean brightness difference between the ring and the same ring shifted back by the offset */
function ringDiff(R: FloorRaster, ring: number[], dx: number, dz: number): number | null {
  const sc = Math.round(dx / R.res), sr = Math.round(dz / R.res);
  let sum = 0, k = 0;
  for (const i of ring) {
    if (!R.n[i]) continue;
    const c = (i % R.w) - sc, r = Math.floor(i / R.w) - sr;
    if (c < 0 || r < 0 || c >= R.w || r >= R.h) continue;
    const j = r * R.w + c;
    if (!R.n[j]) continue;
    sum += Math.abs(lumAt(R, i) - lumAt(R, j));
    k++;
  }
  return k >= Math.max(8, ring.length * 0.1) ? sum / k / 255 : null;
}

/** Scales the base colour of packed splats in place (opacity and angle-dependent colour unchanged) */
export function scaleColours(packed: Uint32Array, count: number, scale: [number, number, number]): void {
  const [sr, sg, sb] = scale;
  for (let j = 0; j < count; j++) {
    const w0 = packed[j * 4];
    const r = Math.min(255, Math.round((w0 & 0xff) * sr));
    const g = Math.min(255, Math.round(((w0 >>> 8) & 0xff) * sg));
    const b = Math.min(255, Math.round(((w0 >>> 16) & 0xff) * sb));
    packed[j * 4] = ((w0 & 0xff000000) | (b << 16) | (g << 8) | r) >>> 0;
  }
}

/** Spark's setPackedSplat (passed in, so this file stays free of the renderer) */
export type SetSplat = (
  packed: Uint32Array, index: number, x: number, y: number, z: number,
  sx: number, sy: number, sz: number, qx: number, qy: number, qz: number, qw: number,
  opacity: number, r: number, g: number, b: number
) => void;

export const SYNTH_TUNING = {
  /** Spacing of the made floor splats (m); each is a flat disc a little wider than the spacing */
  stepM: 0.02,
  sizeM: 0.016,
  thickM: 0.002,
  /** Height of the made floor (m), just above the scanned floor plane */
  y: 0.004,
  /** Colour smoothing radius, in raster cells (wide: the copied pattern's blotches repeated badly) */
  blur: 5,
};

/**
 * Makes a clean floor for a hole: a regular grid of flat, opaque splats coloured by blending the
 * real floor just outside its four sides (the most solid floor splats there), so it meets the
 * floor around it with no seam. Copying the planned source patch repeated its shading and
 * blotches tile by tile; the plan still decides that the hole is clear to fill. The
 * scanned floor near furniture is a mix of noisy splats; copying them looked like grey speckle.
 * Returns packed splats in world space (rows of 2048).
 */
export function synthFloor(raster: FloorRaster, srcPacked: Uint32Array, plan: FillPlan, set: SetSplat, shade: (x: number, z: number) => number = () => 1): { packed: Uint32Array; count: number } {
  const T = SYNTH_TUNING;
  const hole = plan.hole;
  const nx = Math.max(1, Math.round((hole.maxX - hole.minX) / T.stepM));
  const nz = Math.max(1, Math.round((hole.maxZ - hole.minZ) / T.stepM));
  const sx = (hole.maxX - hole.minX) / nx, sz = (hole.maxZ - hole.minZ) / nz;
  const count = nx * nz;
  const packed = new Uint32Array(Math.max(2048, Math.ceil(count / 2048) * 2048) * 4);
  const ring = ringCells(raster, hole, FILL_TUNING.ringM);
  const fallback = meanColour(raster, ring, 0, 0) ?? [180, 180, 180];
  const R = raster;
  // Mean colour of the most solid floor splats around a raster cell (blur), or null with no data.
  // The solid splats are the ones you see; the mean of all floor splats came out too dark.
  const P = srcPacked;
  const around = (c: number, r: number): [number, number, number] | null => {
    let a = 0, g = 0, b = 0, k = 0;
    for (let rr = r - T.blur; rr <= r + T.blur; rr++) {
      for (let cc = c - T.blur; cc <= c + T.blur; cc++) {
        if (cc < 0 || rr < 0 || cc >= R.w || rr >= R.h) continue;
        const i = R.best[rr * R.w + cc];
        if (i < 0) continue;
        const w0 = P[i * 4];
        a += w0 & 0xff; g += (w0 >>> 8) & 0xff; b += (w0 >>> 16) & 0xff; k++;
      }
    }
    return k ? [a / k, g / k, b / k] : null;
  };
  // The floor just outside each side of the hole, along that side (null where nothing was seen)
  const side = (x: number, z: number): [number, number, number] | null =>
    around(Math.floor((x - R.x0) / R.res), Math.floor((z - R.z0) / R.res));
  const d = (T.blur + 1) * R.res;
  const lumOf = (c: [number, number, number]) => c[0] + c[1] + c[2];
  let j = 0;
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const x = hole.minX + (ix + 0.5) * sx, z = hole.minZ + (iz + 0.5) * sz;
      // Blend the four sides by closeness, so the made floor meets the real floor on every side
      // without a seam. A side much darker than the others (a wall base, a shadowed corner) is left out.
      const cand: [[number, number, number] | null, number][] = [
        [side(hole.minX - d, z), x - hole.minX],
        [side(hole.maxX + d, z), hole.maxX - x],
        [side(x, hole.minZ - d), z - hole.minZ],
        [side(x, hole.maxZ + d), hole.maxZ - z],
      ];
      const seen = cand.filter((q): q is [[number, number, number], number] => q[0] !== null);
      const top = seen.length ? Math.max(...seen.map(q => lumOf(q[0]))) : 0;
      let a = 0, g = 0, b = 0, wsum = 0;
      for (const [col, dist] of seen) {
        if (lumOf(col) < 0.88 * top) continue;
        const wgt = 1 / (dist + 0.05) ** 2;
        a += col[0] * wgt; g += col[1] * wgt; b += col[2] * wgt; wsum += wgt;
      }
      const col: [number, number, number] = wsum ? [a / wsum, g / wsum, b / wsum] : fallback;
      const f = shade(x, z) * grain(x, z) * SHADE_TUNING.floorGain;
      set(packed, j++, x, T.y, z, T.sizeM, T.thickM, T.sizeM, 0, 0, 0, 1, 1, Math.min(1, (col[0] * f) / 255), Math.min(1, (col[1] * f) / 255), Math.min(1, (col[2] * f) / 255));
    }
  }
  return { packed, count };
}

// -----------------------------------------------------------------------------
// Wall behind an object that stood against an outer wall
// -----------------------------------------------------------------------------

/** The wall strip an object hid: on the plane of the wall's front, along the object's side */
export interface WallStrip {
  /** The wall's normal is along x (a minX / maxX side), else along z */
  normalX: boolean;
  /** -1 for a min side, +1 for a max side (outwards, into the wall) */
  dir: number;
  /** Where the wall surface starts (world m, on the normal axis) */
  front: number;
  /** Extent along the wall (world m, on the other axis) and height */
  a0: number;
  a1: number;
  y0: number;
  y1: number;
}

export const WALL_TUNING = {
  /** Wall splats: from this far in front of the wall front to this far behind it (m) */
  inM: 0.02,
  outM: 0.06,
  /** The made wall sits this far behind the front (m): just in front, so its faded edge lies over the real wall */
  atM: -0.005,
  /** The real wall this far on each side of the strip gives the paint colour (m) */
  sideM: 0.6,
  /** The paint brightness: this quantile of the wall's splat colours beside the strip (0.85 matched
   *  the lit wall but looked freshly painted) */
  paintQuantile: 0.75,
  /** A colour counts as paint within this share of the paint brightness */
  paintBand: 0.1,
  /** Row colours are smoothed over this many 5 cm rows each way */
  blurRows: 3,
  /** The made wall fades out over this band past the strip's sides and top (m) */
  fadeM: 0.08,
  /** Splat spacing and size (m) */
  stepM: 0.02,
  sizeM: 0.016,
  thickM: 0.002,
  minAlpha: 0.6,
  /** The object's splats this close in front of the wall (m) decide how high it hid the wall */
  nearM: 0.25,
  /** The made wall reaches this far above them (m) */
  topMarginM: 0.05,
};

/** The wall strip behind an object's side: the object's reach along the wall, floor to its top */
export function wallStripFor(reach: FloorBox, side: 'minX' | 'maxX' | 'minZ' | 'maxZ', front: number, y1: number): WallStrip {
  const normalX = side.endsWith('X');
  return {
    normalX,
    dir: side.startsWith('min') ? -1 : 1,
    front,
    a0: normalX ? reach.minZ : reach.minX,
    a1: normalX ? reach.maxZ : reach.maxX,
    y0: 0,
    y1,
  };
}

/** The slab the wall fill hides: from the object's reach to behind the wall front */
export function wallHideBox(strip: WallStrip, reachFace: number): { minX: number; maxX: number; minZ: number; maxZ: number; y0: number; y1: number } {
  const far = strip.front + strip.dir * WALL_TUNING.outM;
  const n0 = Math.min(reachFace, far), n1 = Math.max(reachFace, far);
  return strip.normalX
    ? { minX: n0, maxX: n1, minZ: strip.a0, maxZ: strip.a1, y0: strip.y0, y1: strip.y1 }
    : { minX: strip.a0, maxX: strip.a1, minZ: n0, maxZ: n1, y0: strip.y0, y1: strip.y1 };
}

/**
 * Makes a clean wall over the strip: a regular grid of thin splats on the wall plane. Each height
 * takes the paint colour of the real wall on both sides of the strip at that height (posters,
 * shelves and shadows dropped as outliers), so the light falls off the way it does on the wall
 * around it. The outer band fades out over the real wall, so there is no hard edge. Behind
 * furniture the scan saw the wall poorly, so it shows blur and glare.
 */
export function synthWall(src: PackedSource, m: ArrayLike<number>, stripIn: WallStrip, set: SetSplat): { packed: Uint32Array; count: number; strip: WallStrip } {
  const T = WALL_TUNING;
  const strip = { ...stripIn, y1: wallCoveredTop(src, m, stripIn) };
  const rowM = 0.05;
  const yTop = strip.y1 + T.fadeM;
  const rows = Math.ceil((yTop - strip.y0) / rowM);
  const seen: number[][][] = Array.from({ length: rows }, () => []);
  const best = new Map<number, number[]>();
  const half = halfTable();
  const P = src.packedArray;
  const aMin = Math.round(T.minAlpha * 255);
  for (let i = 0; i < src.numSplats; i++) {
    const w0 = P[i * 4];
    if (w0 >>> 24 < aMin) continue;
    const w1 = P[i * 4 + 1], w2 = P[i * 4 + 2];
    const lx = half[w1 & 0xffff], ly = half[w1 >>> 16], lz = half[w2 & 0xffff];
    const y = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
    if (y < strip.y0 || y >= yTop) continue;
    const x = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
    const z = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
    const n = ((strip.normalX ? x : z) - strip.front) * strip.dir;
    if (n < -T.inM || n >= T.outM) continue;
    const a = strip.normalX ? z : x;
    // The wall on both sides of the strip (not the strip: that is the poorly seen part)
    const out = a < strip.a0 ? strip.a0 - a : a >= strip.a1 ? a - strip.a1 : -1;
    if (out < 0 || out > T.sideM) continue;
    // Per 2 cm cell, the splat with the largest footprint (two largest log scales): the big flat
    // splats are the ones you see; the many small ones are darker detail and made the wall dull
    const w3 = P[i * 4 + 3];
    const s3 = [w3 & 0xff, (w3 >>> 8) & 0xff, (w3 >>> 16) & 0xff].sort((p, q) => q - p);
    const foot = s3[0] + s3[1];
    const key = Math.floor((y - strip.y0) / T.stepM) * 100000 + Math.floor((a - strip.a0 + T.sideM + 1) / T.stepM);
    const had = best.get(key);
    if (!had || foot > had[3]) best.set(key, [w0 & 0xff, (w0 >>> 8) & 0xff, (w0 >>> 16) & 0xff, foot, y]);
  }
  for (const c of best.values()) seen[Math.floor((c[4] - strip.y0) / rowM)].push(c);
  const lum = (c: number[]) => c[0] + c[1] + c[2];
  const all = seen.flat();
  const sorted = all.map(lum).sort((p, q) => p - q);
  // The lit paint: the wall reads brighter than the middle of its splats' base colours (their
  // angle-dependent colour adds light), so aim high in the range
  const paint = sorted.length ? sorted[Math.floor(sorted.length * T.paintQuantile)] : 0;
  // Per row: the colours near the wall's paint brightness (posters, shelves, shadows left out)
  const rowCol: ([number, number, number] | null)[] = seen.map(list => {
    const keep = list.filter(c => Math.abs(lum(c) - paint) <= T.paintBand * paint);
    if (keep.length < 3) return null;
    const sum = keep.reduce((acc, c) => [acc[0] + c[0], acc[1] + c[1], acc[2] + c[2]], [0, 0, 0]);
    const mean: [number, number, number] = [sum[0] / keep.length, sum[1] / keep.length, sum[2] / keep.length];
    return mean;
  });
  const keepAll = all.filter(c => Math.abs(lum(c) - paint) <= T.paintBand * paint);
  const base: [number, number, number] = keepAll.length
    ? (keepAll.reduce((acc, c) => [acc[0] + c[0], acc[1] + c[1], acc[2] + c[2]], [0, 0, 0]).map(v => v / keepAll.length) as [number, number, number])
    : [200, 195, 180];
  const colAt = (y: number): [number, number, number] => {
    const r0 = Math.floor((y - strip.y0) / rowM);
    let r = 0, g = 0, b = 0, k = 0;
    for (let q = Math.max(0, r0 - T.blurRows); q <= Math.min(rows - 1, r0 + T.blurRows); q++) {
      const c = rowCol[q];
      if (!c) continue;
      r += c[0]; g += c[1]; b += c[2]; k++;
    }
    return k ? [r / k, g / k, b / k] : base;
  };
  // The made wall covers the strip and fades out over a band around it (sides and top)
  const a0 = strip.a0 - T.fadeM, a1 = strip.a1 + T.fadeM;
  const na = Math.max(1, Math.round((a1 - a0) / T.stepM));
  const ny = Math.max(1, Math.round((yTop - strip.y0) / T.stepM));
  const sa = (a1 - a0) / na, sy = (yTop - strip.y0) / ny;
  const count = na * ny;
  const packed = new Uint32Array(Math.max(2048, Math.ceil(count / 2048) * 2048) * 4);
  const at = strip.front + strip.dir * T.atM;
  let j = 0;
  for (let iy = 0; iy < ny; iy++) {
    const y = strip.y0 + (iy + 0.5) * sy;
    const c = colAt(y);
    for (let ia = 0; ia < na; ia++) {
      const a = a0 + (ia + 0.5) * sa;
      const outside = Math.max(strip.a0 - a, a - strip.a1, y - strip.y1, 0);
      const opacity = Math.max(0, 1 - outside / T.fadeM);
      const [x, z] = strip.normalX ? [at, a] : [a, at];
      const [sx, sz] = strip.normalX ? [T.thickM, T.sizeM] : [T.sizeM, T.thickM];
      // Darker next to the floor, with grain; the faded edge keeps the plain colour to meet the wall
      const f = 1 + (grain(a, y) * (1 - SHADE_TUNING.wallAo * Math.exp(-y / SHADE_TUNING.wallAoM)) - 1) * opacity;
      set(packed, j++, x, y, z, sx, T.sizeM, sz, 0, 0, 0, 1, opacity, Math.min(1, (c[0] * f) / 255), Math.min(1, (c[1] * f) / 255), Math.min(1, (c[2] * f) / 255));
    }
  }
  return { packed, count, strip };
}

/**
 * How high the object hid the wall: the top of its splats close in front of the strip (a pillow,
 * a headboard), capped at the strip's top. Above that the wall was seen and is kept (a poster).
 */
function wallCoveredTop(src: PackedSource, m: ArrayLike<number>, strip: WallStrip): number {
  const T = WALL_TUNING;
  const half = halfTable();
  const P = src.packedArray;
  const ys: number[] = [];
  for (let i = 0; i < src.numSplats; i++) {
    if (P[i * 4] >>> 24 < 128) continue;
    const w1 = P[i * 4 + 1], w2 = P[i * 4 + 2];
    const lx = half[w1 & 0xffff], ly = half[w1 >>> 16], lz = half[w2 & 0xffff];
    const y = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
    if (y < strip.y0 + 0.3 || y >= strip.y1) continue;
    const x = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
    const z = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
    const n = ((strip.normalX ? x : z) - strip.front) * strip.dir;
    if (n < -T.nearM || n >= -T.inM) continue;
    const a = strip.normalX ? z : x;
    if (a < strip.a0 || a >= strip.a1) continue;
    ys.push(y);
  }
  if (ys.length < 20) return strip.y1;
  ys.sort((p, q) => p - q);
  return Math.min(strip.y1, ys[Math.floor(ys.length * 0.97)] + T.topMarginM);
}

// -----------------------------------------------------------------------------
// Making the made patches look lived-in: soft shadows and grain
// -----------------------------------------------------------------------------

export const SHADE_TUNING = {
  /** Floor: darkening next to a wall or furniture, falling off over this distance (m) */
  floorAo: 0.15,
  floorAoM: 0.2,
  /** Wall: darkening next to the floor, falling off over this height (m) */
  wallAo: 0.25,
  wallAoM: 0.35,
  /** Grain: smooth blotches on this lattice (m), up to this share, plus a fine speckle */
  grainM: 0.12,
  grain: 0.06,
  speckle: 0.025,
  /** Overall brightness of the made floor against the floor it copies (0.95 with the shadows read too grey) */
  floorGain: 1.0,
};

/**
 * Soft shadow on the made floor: 1 in the open, darker next to walls and furniture still standing
 * (the moved pieces' old spots do not count: they are gone).
 */
export function floorShade(grid: NavGrid, floor: Uint8Array, gone: FloorBox[]): (x: number, z: number) => number {
  const S = SHADE_TUNING;
  const w = grid.width, h = grid.height, n = w * h, cell = grid.cell_m;
  const [ox, oz] = grid.origin;
  const L = grid.layers;
  const bytes = L ? decodeBase64ToBytes(L.occupied_bits_b64) : null;
  const hi = L ? Math.min(L.count - 1, Math.floor((1.0 - L.y0_m) / L.dy_m)) : -1;
  const inGone = (i: number) => {
    const x = ox + ((i % w) + 0.5) * cell, z = oz + (Math.floor(i / w) + 0.5) * cell;
    return gone.some(b => x >= b.minX && x < b.maxX && z >= b.minZ && z < b.maxZ);
  };
  const solid = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (inGone(i)) continue;
    if (!floor[i]) { solid[i] = 1; continue; }
    if (bytes) for (let l = 0; l <= hi && !solid[i]; l++) solid[i] = bitAt(bytes, l * n + i);
  }
  const d = distanceToCells(w, h, i => solid[i] === 1);
  return (x, z) => {
    const c = Math.floor((x - ox) / cell), r = Math.floor((z - oz) / cell);
    if (c < 0 || r < 0 || c >= w || r >= h) return 1 - S.floorAo;
    return 1 - S.floorAo * Math.exp(-(d[r * w + c] * cell) / S.floorAoM);
  };
}

/** Grain: a smooth blotch pattern plus a fine speckle, around 1 (same everywhere for one spot) */
export function grain(u: number, v: number): number {
  const S = SHADE_TUNING;
  const hash = (i: number, j: number) => {
    let k = (Math.imul(i, 374761393) + Math.imul(j, 668265263)) | 0;
    k = Math.imul(k ^ (k >>> 13), 1274126177);
    return ((k ^ (k >>> 16)) >>> 0) / 4294967295;
  };
  const gu = u / S.grainM, gv = v / S.grainM;
  const i = Math.floor(gu), j = Math.floor(gv), fu = gu - i, fv = gv - j;
  const su = fu * fu * (3 - 2 * fu), sv = fv * fv * (3 - 2 * fv);
  const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), e = hash(i + 1, j + 1);
  const smooth = a + (b - a) * su + (c - a) * sv + (a - b - c + e) * su * sv;
  const fine = hash(Math.floor(u / 0.02) + 7919, Math.floor(v / 0.02) - 104729);
  return 1 + S.grain * (smooth - 0.5) * 2 + S.speckle * (fine - 0.5) * 2;
}
