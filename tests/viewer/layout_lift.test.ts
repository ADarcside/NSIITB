/**
 * Namma Space: picking lifted splats and building their copies (viewer/src/layout/lift.ts)
 */

import { describe, it, expect } from 'vitest';
import { selectSplats, buildCopy, fitReachToWalls, type PackedSource } from '../../viewer/src/layout/lift.js';

const toHalf = (f: number): number => {
  const b = new DataView(new ArrayBuffer(4));
  b.setFloat32(0, f);
  const x = b.getUint32(0);
  const sign = (x >>> 16) & 0x8000;
  const e = ((x >>> 23) & 0xff) - 127 + 15;
  if (f === 0) return sign;
  return sign | (e << 10) | ((x >>> 13) & 0x3ff);
};

/** Packed splats at the given centres; scaleByte sets all three log scales (1 = tiny) */
function makeSource(points: [number, number, number, number?][], sh = false): PackedSource {
  const packedArray = new Uint32Array(points.length * 4);
  points.forEach(([x, y, z, s = 1], i) => {
    packedArray[i * 4] = 0xff000000 | i;
    packedArray[i * 4 + 1] = toHalf(x) | (toHalf(y) << 16);
    packedArray[i * 4 + 2] = toHalf(z);
    packedArray[i * 4 + 3] = s | (s << 8) | (s << 16);
  });
  const extra: Record<string, unknown> = {};
  if (sh) {
    extra.sh1 = Uint32Array.from({ length: points.length * 2 }, (_, k) => 1000 + k);
    extra.sh2 = Uint32Array.from({ length: points.length * 4 }, (_, k) => 2000 + k);
    extra.sh3 = Uint32Array.from({ length: points.length * 4 }, (_, k) => 3000 + k);
  }
  return { packedArray, numSplats: points.length, extra, splatEncoding: { lnScaleMin: -12, lnScaleMax: 9 } };
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const BOX = { minX: 0, maxX: 1, minZ: 0, maxZ: 1, y0: 0.05, y1: 1 };

describe('selectSplats', () => {
  it('picks splats whose centre is inside the box, in world space', () => {
    const src = makeSource([[0.5, 0.5, 0.5], [1.5, 0.5, 0.5], [0.5, 0.01, 0.5], [0.25, 0.75, 0.75]]);
    const sel = selectSplats(src, IDENTITY, [BOX]);
    expect(sel.hidden[0]).toBe(2);
    expect(Array.from(sel.copied[0])).toEqual([0, 3]);
  });

  it('applies world_from_splat (a slide of 10 m moves the splats out of the box)', () => {
    const src = makeSource([[0.5, 0.5, 0.5]]);
    const m = IDENTITY.slice();
    m[12] = 10;
    expect(selectSplats(src, m, [BOX]).hidden[0]).toBe(0);
  });

  it('leaves a wide splat on a face out of the copy, but still counts it as hidden', () => {
    // scale byte 240: exp(-12 + 239 * 21 / 254) ≈ 2.4 m, far wider than 0.3 m
    const src = makeSource([[0.02, 0.5, 0.5, 240], [0.5, 0.5, 0.5, 1]]);
    const sel = selectSplats(src, IDENTITY, [BOX]);
    expect(sel.hidden[0]).toBe(2);
    expect(Array.from(sel.copied[0])).toEqual([1]);
  });

  it('assigns each splat to one box', () => {
    const src = makeSource([[0.5, 0.5, 0.5], [2.5, 0.5, 0.5]]);
    const sel = selectSplats(src, IDENTITY, [BOX, { ...BOX, minX: 2, maxX: 3 }]);
    expect(Array.from(sel.copied[0])).toEqual([0]);
    expect(Array.from(sel.copied[1])).toEqual([1]);
  });
});

describe('buildCopy', () => {
  const src = makeSource([[0.1, 0.5, 0.1], [0.2, 0.5, 0.2], [0.3, 0.5, 0.3]], true);

  it('copies the base words of the picked splats only', () => {
    const c = buildCopy(src, Uint32Array.from([2, 0]), false);
    expect(c.numSplats).toBe(2);
    expect(c.packedArray.length % (2048 * 4)).toBe(0);
    expect(Array.from(c.packedArray.subarray(0, 4))).toEqual(Array.from(src.packedArray.subarray(8, 12)));
    expect(Array.from(c.packedArray.subarray(4, 8))).toEqual(Array.from(src.packedArray.subarray(0, 4)));
    expect(Object.keys(c.extra)).toEqual([]);
  });

  it('with angle-dependent colour, copies sh1 to sh3 in the same order', () => {
    const c = buildCopy(src, Uint32Array.from([2, 0]), true);
    expect(Array.from(c.extra.sh1.subarray(0, 4))).toEqual([1004, 1005, 1000, 1001]);
    expect(Array.from(c.extra.sh2.subarray(0, 8))).toEqual([2008, 2009, 2010, 2011, 2000, 2001, 2002, 2003]);
    expect(Array.from(c.extra.sh3.subarray(0, 4))).toEqual([3008, 3009, 3010, 3011]);
  });
});

describe('fitReachToWalls', () => {
  // A box whose -z side faces a wall at z = -0.5; the grid guessed the reach out to z = -0.45
  const item = { lift: { minX: 0, maxX: 1, minZ: 0, maxZ: 1 }, reach: { minX: 0, maxX: 1, minZ: -0.45, maxZ: 1 }, y0: 0.05, y1: 1.5 };
  const points = (withWall: boolean): [number, number, number][] => {
    const pts: [number, number, number][] = [];
    // The object's own end, spread from the face to 18 cm past it
    for (let k = 0; k < 400; k++) pts.push([(k % 20) / 20, 0.5 + (k % 7) / 10, -((k * 7) % 180) / 1000]);
    // The wall surface: a thin, dense layer at z = -0.5 behind and beside the box
    if (withWall) for (let k = 0; k < 1500; k++) pts.push([-0.3 + (k % 160) / 100, 0.4 + (k % 9) / 10, -0.5 + ((k % 3) - 1) / 1000]);
    return pts;
  };

  it('stops just in front of the wall surface', () => {
    const [r] = fitReachToWalls(makeSource(points(true)), IDENTITY, [item]);
    expect(r.minZ).toBeGreaterThan(-0.5);
    expect(r.minZ).toBeLessThan(-0.45);
    expect(r.maxZ).toBe(1);
    expect(r.minX).toBe(0);
  });

  it("keeps the grid's guess when no wall shows, and leaves sides without a wall alone", () => {
    const [r] = fitReachToWalls(makeSource(points(false)), IDENTITY, [item]);
    expect(r).toEqual(item.reach);
    const [same] = fitReachToWalls(makeSource(points(true)), IDENTITY, [{ ...item, reach: item.lift }]);
    expect(same).toEqual(item.lift);
  });
});
