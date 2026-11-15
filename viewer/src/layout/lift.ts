/**
 * Namma Space: pick the splats of lifted objects, and build their copies (Rearrange)
 *
 * Reads the main scan's packed splats directly (4 words per splat: colour+opacity, centre as
 * float16, quaternion and log scales). One pass over the scan finds the splats of every lifted
 * box. The copy is either the base words only (base colour, the same as Spark's pushSplat or
 * extractSplats) or the base words plus the angle-dependent colour (sh1 to sh3), so the two can be
 * compared by eye. Pure: no renderer, unit-tested with hand-made arrays.
 */

/** A world-space box, axis-aligned, to lift */
export interface LiftBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  y0: number;
  y1: number;
}

/** What the scan holds, in Spark's PackedSplats layout */
export interface PackedSource {
  packedArray: Uint32Array;
  numSplats: number;
  /** sh1 (2 words per splat), sh2 and sh3 (4 words per splat) when the file has them */
  extra: Record<string, unknown>;
  splatEncoding: { lnScaleMin?: number; lnScaleMax?: number };
}

export const LIFT_TUNING = {
  /** The copy test uses the box shrunk by this much, so a splat on the face is hidden, never doubled */
  copyShrinkM: 0.001,
  /** A splat wider than this (2 sigma, world metres) that crosses a box face stays out of the copy */
  straddleWidthM: 0.3,
};

let HALF: Float32Array | null = null;
/** float16 bits to float, as a table (65536 entries) */
export function halfTable(): Float32Array {
  if (HALF) return HALF;
  const t = new Float32Array(65536);
  for (let u = 0; u < 65536; u++) {
    const s = u & 0x8000 ? -1 : 1;
    const e = (u >> 10) & 0x1f;
    const f = u & 0x3ff;
    t[u] = e === 0 ? s * 2 ** -14 * (f / 1024) : e === 31 ? (f ? NaN : s * Infinity) : s * 2 ** (e - 15) * (1 + f / 1024);
  }
  HALF = t;
  return t;
}

export interface Selection {
  /** Per box: splats whose centre is in the box (these are hidden in the scan) */
  hidden: number[];
  /** Per box: the splats copied into the lifted object (hidden minus wide splats on a face) */
  copied: Uint32Array[];
  /** Milliseconds the pass took */
  ms: number;
}

/**
 * One pass over the scan. m = world_from_splat, column-major 4x4 (as in the manifest).
 */
export function selectSplats(src: PackedSource, m: ArrayLike<number>, boxes: LiftBox[]): Selection {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const half = halfTable();
  const P = src.packedArray;
  const N = src.numSplats;
  const lnMin = src.splatEncoding.lnScaleMin ?? -12;
  const lnStep = ((src.splatEncoding.lnScaleMax ?? 9) - lnMin) / 254;
  const worldScale = Math.cbrt(Math.abs(
    m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2])
  ));
  const shrink = LIFT_TUNING.copyShrinkM;
  const straddleR = LIFT_TUNING.straddleWidthM / 2;
  // Whole-scene bounds of all boxes, for a cheap first test
  let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity, by0 = Infinity, by1 = -Infinity;
  for (const b of boxes) {
    bx0 = Math.min(bx0, b.minX); bx1 = Math.max(bx1, b.maxX);
    bz0 = Math.min(bz0, b.minZ); bz1 = Math.max(bz1, b.maxZ);
    by0 = Math.min(by0, b.y0); by1 = Math.max(by1, b.y1);
  }
  const hidden = boxes.map(() => 0);
  const lists: number[][] = boxes.map(() => []);
  for (let i = 0; i < N; i++) {
    const w1 = P[i * 4 + 1], w2 = P[i * 4 + 2];
    const lx = half[w1 & 0xffff], ly = half[w1 >>> 16], lz = half[w2 & 0xffff];
    const x = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
    const z = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
    if (x < bx0 || x >= bx1 || z < bz0 || z >= bz1) continue;
    const y = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
    if (y < by0 || y >= by1) continue;
    for (let b = 0; b < boxes.length; b++) {
      const B = boxes[b];
      if (x < B.minX || x >= B.maxX || z < B.minZ || z >= B.maxZ || y < B.y0 || y >= B.y1) continue;
      hidden[b]++;
      // Inner box for the copy
      const face = Math.min(x - B.minX, B.maxX - x, z - B.minZ, B.maxZ - z, y - B.y0, B.y1 - y);
      if (face < shrink) break;
      // 2 sigma radius of the widest axis, in world metres
      const w3 = P[i * 4 + 3];
      const u = Math.max(w3 & 0xff, (w3 >>> 8) & 0xff, (w3 >>> 16) & 0xff);
      const r = u === 0 ? 0 : 2 * Math.exp(lnMin + (u - 1) * lnStep) * worldScale;
      if (r > straddleR && face < r) break;
      lists[b].push(i);
      break;
    }
  }
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { hidden, copied: lists.map(l => Uint32Array.from(l)), ms: t1 - t0 };
}

/** Texture-friendly size: Spark lays splats in rows of 2048 */
const ROW = 2048;
const roundUp = (k: number): number => Math.max(ROW, Math.ceil(k / ROW) * ROW);

export interface CopyData {
  packedArray: Uint32Array;
  numSplats: number;
  extra: Record<string, Uint32Array>;
  splatEncoding: PackedSource['splatEncoding'];
}

/** Builds the copy of the picked splats. withSh = also copy the angle-dependent colour. */
export function buildCopy(src: PackedSource, indices: Uint32Array, withSh: boolean): CopyData {
  const k = indices.length;
  const size = roundUp(k);
  const packed = new Uint32Array(size * 4);
  const P = src.packedArray;
  for (let j = 0; j < k; j++) {
    const i = indices[j] * 4;
    packed[j * 4] = P[i];
    packed[j * 4 + 1] = P[i + 1];
    packed[j * 4 + 2] = P[i + 2];
    packed[j * 4 + 3] = P[i + 3];
  }
  const extra: Record<string, Uint32Array> = {};
  if (withSh) {
    for (const [key, words] of [['sh1', 2], ['sh2', 4], ['sh3', 4]] as const) {
      const from = src.extra[key];
      if (!(from instanceof Uint32Array)) break; // levels are nested: no sh2 without sh1
      const to = new Uint32Array(size * words);
      for (let j = 0; j < k; j++) {
        const i = indices[j] * words;
        for (let q = 0; q < words; q++) to[j * words + q] = from[i + q];
      }
      extra[key] = to;
    }
  }
  return { packedArray: packed, numSplats: k, extra, splatEncoding: { ...src.splatEncoding } };
}

/** A box on the floor (world metres) */
export interface FloorBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export const WALL_FIT = {
  /** Histogram step along the side's axis (m) */
  binM: 0.01,
  /** Look this far past the grid's reach for the wall surface (m) */
  beyondM: 0.15,
  /** The wall strip is this much wider than the box on both ends, so the wall shows plainly (m) */
  sideM: 0.3,
  /** Heights looked at (m): above floor clutter, below the ceiling */
  yLo: 0.3,
  yHi: 2.4,
  /** A splat counts when its opacity is at least this */
  minAlpha: 0.25,
  /** The wall bin must hold at least this many times the median bin, and this many splats */
  peakOverMedian: 3,
  minPeak: 30,
  /** The wall's front is where the count falls under this share of the peak */
  frontShare: 0.5,
  /** Stop this far in front of the wall's front (m) */
  gapM: 0.02,
};

/**
 * Narrows each object's reach on its outer-wall sides to just in front of the wall surface, found
 * as the densest thin layer of splats past the box face. A side where no clear wall shows keeps
 * the grid's guess. Returns new boxes; the inputs are not changed.
 */
export function fitReachToWalls(
  src: PackedSource,
  m: ArrayLike<number>,
  items: { lift: FloorBox; reach: FloorBox; y0: number; y1: number }[]
): FloorBox[] {
  return fitWalls(src, m, items).map(f => f.reach);
}

/** An outer wall found behind one side of an object: where its surface starts (world m) */
export interface WallFront {
  side: 'minX' | 'maxX' | 'minZ' | 'maxZ';
  front: number;
}

/** fitReachToWalls, plus the wall surfaces it found (for the wall fill) */
export function fitWalls(
  src: PackedSource,
  m: ArrayLike<number>,
  items: { lift: FloorBox; reach: FloorBox; y0: number; y1: number }[]
): { reach: FloorBox; walls: WallFront[] }[] {
  const T = WALL_FIT;
  type Side = 'minX' | 'maxX' | 'minZ' | 'maxZ';
  interface Job { k: number; side: Side; face: number; dir: number; alongX: boolean; lat0: number; lat1: number; y0: number; y1: number; bins: Uint32Array }
  const jobs: Job[] = [];
  items.forEach((it, k) => {
    for (const side of ['minX', 'maxX', 'minZ', 'maxZ'] as Side[]) {
      if (it.reach[side] === it.lift[side]) continue;
      const dir = side.startsWith('min') ? -1 : 1;
      const alongX = side.endsWith('X');
      const face = it.lift[side];
      const far = Math.abs(it.reach[side] - face) + T.beyondM;
      jobs.push({
        k, side, face, dir, alongX,
        lat0: (alongX ? it.reach.minZ : it.reach.minX) - T.sideM,
        lat1: (alongX ? it.reach.maxZ : it.reach.maxX) + T.sideM,
        y0: Math.max(T.yLo, it.y0), y1: Math.min(T.yHi, it.y1),
        bins: new Uint32Array(Math.ceil(far / T.binM)),
      });
    }
  });
  const out = items.map(it => ({ reach: { ...it.reach }, walls: [] as WallFront[] }));
  if (!jobs.length) return out;
  const half = halfTable();
  const P = src.packedArray;
  const aMin = Math.round(T.minAlpha * 255);
  for (let i = 0; i < src.numSplats; i++) {
    if (P[i * 4] >>> 24 < aMin) continue;
    const w1 = P[i * 4 + 1], w2 = P[i * 4 + 2];
    const lx = half[w1 & 0xffff], ly = half[w1 >>> 16], lz = half[w2 & 0xffff];
    const y = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
    if (y < T.yLo || y >= T.yHi) continue;
    const x = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
    const z = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
    for (const j of jobs) {
      if (y < j.y0 || y >= j.y1) continue;
      const lat = j.alongX ? z : x;
      if (lat < j.lat0 || lat >= j.lat1) continue;
      const d = ((j.alongX ? x : z) - j.face) * j.dir;
      if (d < 0) continue;
      const b = Math.floor(d / T.binM);
      if (b < j.bins.length) j.bins[b]++;
    }
  }
  for (const j of jobs) {
    const h = j.bins;
    let p = 0;
    for (let b = 1; b < h.length; b++) if (h[b] > h[p]) p = b;
    const median = Array.from(h).sort((a, b) => a - b)[h.length >> 1];
    if (h[p] < T.minPeak || h[p] < T.peakOverMedian * median) continue;
    let f = p;
    while (f > 0 && h[f - 1] >= T.frontShare * h[p]) f--;
    const d = Math.max(0, f * T.binM - T.gapM);
    out[j.k].reach[j.side] = j.face + j.dir * d;
    out[j.k].walls.push({ side: j.side, front: j.face + j.dir * f * T.binM });
  }
  return out;
}
