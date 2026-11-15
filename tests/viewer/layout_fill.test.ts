/**
 * Namma Space: floor fill for the old spot of a moved object (viewer/src/layout/fill.ts)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildFloorPlanWithMasks } from '../../viewer/src/nav/floorplan.js';
import { movableObjects } from '../../viewer/src/layout/objects.js';
import { planFloorFill, scaleColours, synthFloor, synthWall, wallStripFor, wallHideBox, type FloorRaster } from '../../viewer/src/layout/fill.js';
import type { NavGrid } from '../../viewer/src/contracts/types.js';

const read = (p: string) => JSON.parse(readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8'));
const grid = read('../../sample/test-capture/grid.json') as NavGrid;
const built = buildFloorPlanWithMasks(grid)!;
const objects = movableObjects(grid, built.plan, built.masks);

/** A raster over the grid with a brightness given per point */
function raster(lum: (x: number, z: number) => number): FloorRaster {
  const res = 0.02, [x0, z0] = grid.origin;
  const w = Math.ceil((grid.width * grid.cell_m) / res), h = Math.ceil((grid.height * grid.cell_m) / res);
  const R = new Float32Array(w * h), G = new Float32Array(w * h), B = new Float32Array(w * h), N = new Uint32Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const k = r * w + c, v = lum(x0 + (c + 0.5) * res, z0 + (r + 0.5) * res);
    R[k] = G[k] = B[k] = v; N[k] = 1;
  }
  return { x0, z0, res, w, h, low: new Uint32Array(w * h), best: new Int32Array(w * h).fill(-1), r: R, g: G, b: B, n: N };
}

describe('floor fill plan', () => {
  const bunk = objects.find(o => o.id === 0)!;
  const avoid = objects.map(o => o.reach);
  const area = (b: { minX: number; maxX: number; minZ: number; maxZ: number }) => (b.maxX - b.minX) * (b.maxZ - b.minZ);

  it("covers Bunk 1's old spot exactly, with floor taken clear of every piece of furniture", () => {
    const [p] = planFloorFill(grid, built.masks.floor, raster(() => 200), [bunk.reach], avoid);
    expect(p).not.toBeNull();
    expect(p!.clean).toBeGreaterThanOrEqual(0.98);
    expect(p!.tiles.reduce((s, t) => s + area(t.box), 0)).toBeCloseTo(area(bunk.reach), 6);
    for (const t of p!.tiles) {
      const src = { minX: t.box.minX - t.dx, maxX: t.box.maxX - t.dx, minZ: t.box.minZ - t.dz, maxZ: t.box.maxZ - t.dz };
      for (const o of objects) {
        const a = o.lift;
        const overlap = Math.max(0, Math.min(a.maxX, src.maxX) - Math.max(a.minX, src.minX)) * Math.max(0, Math.min(a.maxZ, src.maxZ) - Math.max(a.minZ, src.minZ));
        expect(overlap).toBeLessThan(0.01);
      }
    }
    expect(p!.scale).toEqual([1, 1, 1]);
  });

  it('a small hole in open floor takes one piece from nearby', () => {
    const hole = { minX: 0.0, maxX: 0.3, minZ: 0.3, maxZ: 0.6 };
    const [p] = planFloorFill(grid, built.masks.floor, raster(() => 200), [hole], avoid);
    expect(p!.tiles.length).toBe(1);
    expect(Math.hypot(p!.tiles[0].dx, p!.tiles[0].dz)).toBeLessThan(0.5);
  });

  it('scales the colour to the floor around the hole', () => {
    // Floor 150 near the hole, 200 elsewhere: the copy is darkened towards 150 (within limits)
    const hole = { minX: 0.0, maxX: 0.3, minZ: 0.3, maxZ: 0.6 };
    const near = (x: number, z: number) => x > -0.12 && x < 0.42 && z > 0.18 && z < 0.72;
    const [p] = planFloorFill(grid, built.masks.floor, raster((x, z) => (near(x, z) ? 150 : 200)), [hole], avoid);
    expect(p!.scale[0]).toBeLessThan(1);
    expect(p!.scale[0]).toBeGreaterThanOrEqual(0.75);
  });
});

describe('scaleColours', () => {
  it('scales rgb, keeps opacity, clamps at 255', () => {
    const a = Uint32Array.from([0x80_64_32_c8, 0, 0, 0]); // a=0x80, b=0x64, g=0x32, r=0xc8
    scaleColours(a, 1, [1.5, 2, 1]);
    expect(a[0] >>> 24).toBe(0x80);
    expect(a[0] & 0xff).toBe(255);
    expect((a[0] >>> 8) & 0xff).toBe(100);
    expect((a[0] >>> 16) & 0xff).toBe(100);
  });
});

describe('made floor', () => {
  it('covers the hole with a regular grid of solid splats coloured like the floor around it', () => {
    // Every raster cell's most solid splat is splat 0 (colour 200, 150, 100), except the hole itself
    const R = raster(() => 0);
    const hole = { minX: 0.0, maxX: 0.3, minZ: 0.3, maxZ: 0.6 };
    for (let k = 0; k < R.best.length; k++) {
      const c = k % R.w, r = Math.floor(k / R.w);
      const x = R.x0 + (c + 0.5) * R.res, z = R.z0 + (r + 0.5) * R.res;
      R.best[k] = x >= hole.minX && x < hole.maxX && z >= hole.minZ && z < hole.maxZ ? -1 : 0;
    }
    const src = Uint32Array.from([0xff_64_96_c8, 0, 0, 0]);
    const calls: number[][] = [];
    const plan = { hole, tiles: [{ box: hole, dx: 1, dz: 0 }], scale: [1, 1, 1] as [number, number, number], clean: 1 };
    const out = synthFloor(R, src, plan, (_p, _i, x, y, z, _sx, _sy, _sz, _qx, _qy, _qz, _qw, o, r, g, b) => calls.push([x, y, z, o, r, g, b]));
    expect(out.count).toBe(15 * 15);
    expect(calls.length).toBe(out.count);
    for (const [x, , z, o, r, g, b] of calls) {
      expect(x).toBeGreaterThan(hole.minX); expect(x).toBeLessThan(hole.maxX);
      expect(z).toBeGreaterThan(hole.minZ); expect(z).toBeLessThan(hole.maxZ);
      expect(o).toBe(1);
      // The floor colour with grain (within 10 %), hue kept
      expect(r / (200 / 255)).toBeGreaterThan(0.88); expect(r / (200 / 255)).toBeLessThan(1.1);
      expect(g / r).toBeCloseTo(150 / 200, 2); expect(b / r).toBeCloseTo(100 / 200, 2);
    }
  });
});

describe('made wall', () => {
  const toHalf = (f: number): number => {
    const b = new DataView(new ArrayBuffer(4));
    b.setFloat32(0, f);
    const x = b.getUint32(0);
    if (f === 0) return 0;
    const sign = (x >>> 16) & 0x8000, e = ((x >>> 23) & 0xff) - 127 + 15;
    return sign | (e << 10) | ((x >>> 13) & 0x3ff);
  };
  const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  // A wall at z = -2 (a minZ side), painted (200, 190, 160) beside the strip x 0..1, with a dark
  // poster at x -0.3 and the object (a pillow) in front of the strip up to y 1.2
  function scene() {
    const pts: [number, number, number, number][] = [];
    for (let k = 0; k < 3000; k++) {
      const x = -0.6 + (k % 23) * 0.1, y = 0.05 + ((k * 7) % 40) * 0.06;
      if (x >= 0 && x < 1) continue;
      const poster = Math.abs(x + 0.3) < 0.06 && y > 1.2 && y < 1.6;
      pts.push([x, y, -2.0, poster ? 0x202020 : 0xa0bec8]);
    }
    for (let k = 0; k < 200; k++) pts.push([0.05 + (k % 9) * 0.1, 0.3 + ((k * 3) % 12) * 0.1, -1.9, 0x808080]);
    const packed = new Uint32Array(pts.length * 4);
    pts.forEach(([x, y, z, bgr], i) => {
      packed[i * 4] = (0xff000000 | bgr) >>> 0;
      packed[i * 4 + 1] = toHalf(x) | (toHalf(y) << 16);
      packed[i * 4 + 2] = toHalf(z);
      packed[i * 4 + 3] = 100 | (100 << 8) | (100 << 16);
    });
    return { packedArray: packed, numSplats: pts.length, extra: {}, splatEncoding: { lnScaleMin: -12, lnScaleMax: 9 } };
  }

  it('paints the strip in the wall colour beside it, up to where the object hid it, fading at the edges', () => {
    const strip = wallStripFor({ minX: 0, maxX: 1, minZ: -1.98, maxZ: 0 }, 'minZ', -2.0, 2.2);
    const calls: number[][] = [];
    const out = synthWall(scene(), IDENTITY, strip, (_p, _i, x, y, z, _sx, _sy, _sz, _qx, _qy, _qz, _qw, o, r, g, b) => calls.push([x, y, z, o, r, g, b]));
    expect(calls.length).toBe(out.count);
    expect(out.strip.y1).toBeCloseTo(1.25, 2);
    for (const [x, y, z, o, r, g, b] of calls) {
      expect(z).toBeCloseTo(-1.995, 3);
      if (x > 0 && x < 1 && y < out.strip.y1) {
        expect(o).toBe(1);
        // The paint colour with grain, darker towards the floor
        const k = r / (0xc8 / 255);
        expect(k).toBeLessThan(1.1);
        expect(k).toBeGreaterThan(y > 0.8 ? 0.9 : 0.65);
        expect(g / r).toBeCloseTo(0xbe / 0xc8, 2); expect(b / r).toBeCloseTo(0xa0 / 0xc8, 2);
      }
      if (x < -0.07 || x > 1.07) expect(o).toBeLessThan(0.15);
    }
    const hide = wallHideBox(out.strip, -1.98);
    expect(hide.minZ).toBeCloseTo(-2.06, 6);
    expect(hide.maxZ).toBeCloseTo(-1.98, 6);
    expect(hide.y1).toBe(out.strip.y1);
  });
});
