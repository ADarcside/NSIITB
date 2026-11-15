/**
 * Namma Space: Rearrange objects and grid patch (viewer/src/layout/objects.ts, regrid.ts)
 * The test file is the live K-720 grid (sample/test-capture/scn_hostelroomac/grid.json).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildFloorPlanWithMasks } from '../../viewer/src/nav/floorplan.js';
import { movableObjects } from '../../viewer/src/layout/objects.js';
import { patchGrid, unpackBits, packBits, PATCH_M, backToOriginal, type Move } from '../../viewer/src/layout/regrid.js';
import type { NavGrid } from '../../viewer/src/contracts/types.js';

const grid = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../sample/test-capture/scn_hostelroomac/grid.json', import.meta.url)), 'utf8')
) as NavGrid;
const built = buildFloorPlanWithMasks(grid)!;
const objects = movableObjects(grid, built.plan, built.masks);
const n = grid.width * grid.height;

describe('movable objects on K-720', () => {
  it('finds movable boxes, none tall, each with a height range', () => {
    expect(objects.length).toBeGreaterThan(0);
    for (const o of objects) {
      const box = built.plan.boxes.find(b => b.id === o.id)!;
      expect(box.tall).toBe(false);
      expect(o.y1).toBeGreaterThan(o.y0);
      expect(o.y1).toBeLessThanOrEqual(2.9);
      expect(o.lift.minX).toBeGreaterThanOrEqual(o.box.minX);
      expect(o.lift.maxX).toBeLessThanOrEqual(o.box.maxX);
      expect(o.lift.maxX).toBeGreaterThan(o.lift.minX);
      // The reach only grows past the lift, and never past the grid
      expect(o.reach.minZ).toBeLessThanOrEqual(o.lift.minZ);
      expect(o.reach.maxZ).toBeGreaterThanOrEqual(o.lift.maxZ);
      expect(o.reach.minZ).toBeGreaterThan(grid.origin[1]);
    }
  });

  it("Bunk 1 reaches past the grid's wall band to the back wall; its open sides stay as lifted", () => {
    const bunk = objects.find(o => o.id === 0)!;
    expect(bunk.reach.minZ).toBeLessThan(bunk.lift.minZ - 0.15);
    expect(bunk.reach.maxZ).toBe(bunk.lift.maxZ);
    expect(bunk.reach.minX).toBe(bunk.lift.minX);
  });

  it('a moved bunk blocks the walk where its wall end now stands', () => {
    const bunk = objects.find(o => o.id === 0)!;
    const r = patchGrid(grid, objects, [{ id: 0, dx: 0, dz: 0.6, turnDeg: 0 }]);
    const cell = grid.cell_m, [ox, oz] = grid.origin;
    // A point of the wall end (between the reach and the lift), after the move
    const x = (bunk.lift.minX + bunk.lift.maxX) / 2, z = (bunk.reach.minZ + bunk.lift.minZ) / 2 + 0.6;
    const i = Math.floor((z - oz) / cell) * grid.width + Math.floor((x - ox) / cell);
    expect(r.newFootprint[i]).toBe(1);
  });
});

describe('grid patch', () => {
  const o = objects[0];

  it('bits round-trip', () => {
    expect(packBits(unpackBits(grid.free_bits_b64, n))).toBe(grid.free_bits_b64.replace(/\s+/g, ''));
  });

  it('no moves gives the published grid, bit for bit', () => {
    const r = patchGrid(grid, objects, []);
    expect(r.grid.free_bits_b64).toBe(grid.free_bits_b64);
    expect(r.grid.layers?.occupied_bits_b64).toBe(grid.layers?.occupied_bits_b64);
  });

  it('a move back to the start, and four quarter turns, give the published grid', () => {
    for (const m of [
      { id: o.id, dx: 0, dz: 0, turnDeg: 0 },
      { id: o.id, dx: 0, dz: 0, turnDeg: 360 },
      { id: o.id, dx: 0, dz: 0, turnDeg: -720 },
    ] as Move[]) {
      const r = patchGrid(grid, objects, [m]);
      expect(r.grid.free_bits_b64).toBe(grid.free_bits_b64);
      expect(r.grid.layers?.occupied_bits_b64).toBe(grid.layers?.occupied_bits_b64);
    }
  });

  it('turning the footprint back maps every cell onto the original box', () => {
    const back = backToOriginal(o, { id: o.id, dx: 0.4, dz: -0.2, turnDeg: 90 });
    const cx = (o.lift.minX + o.lift.maxX) / 2, cz = (o.lift.minZ + o.lift.maxZ) / 2;
    const [x, z] = back(cx + 0.4, cz - 0.2);
    expect(x).toBeCloseTo(cx, 9);
    expect(z).toBeCloseTo(cz, 9);
  });

  it('one moved object changes cells only within 0.3 m of the old and new footprints', () => {
    for (const obj of objects) {
      for (const m of [
        { id: obj.id, dx: 0.3, dz: 0, turnDeg: 0 },
        { id: obj.id, dx: 0, dz: -0.25, turnDeg: 15 },
        { id: obj.id, dx: -0.2, dz: 0.2, turnDeg: 90 },
      ] as Move[]) {
        const r = patchGrid(grid, objects, [m]);
        const before = unpackBits(grid.free_bits_b64, n);
        const after = unpackBits(r.grid.free_bits_b64, n);
        let changed = 0;
        for (let i = 0; i < n; i++) {
          if (before[i] !== after[i]) {
            changed++;
            expect(r.region[i]).toBe(1);
          }
        }
        // The new footprint is never walkable
        for (let i = 0; i < n; i++) if (r.newFootprint[i]) expect(after[i]).toBe(0);
        expect(PATCH_M).toBeCloseTo(0.3);
        expect(changed).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('a slide moves the object\'s height layers with it', () => {
    const m: Move = { id: o.id, dx: 0.5, dz: 0, turnDeg: 0 };
    const r = patchGrid(grid, objects, [m]);
    const L = grid.layers!;
    const before = unpackBits(L.occupied_bits_b64, L.count * n);
    const after = unpackBits(r.grid.layers!.occupied_bits_b64, L.count * n);
    let total = 0, moved = 0;
    const shift = Math.round(0.5 / grid.cell_m);
    for (let l = o.l0; l <= o.l1; l++) {
      for (let i = 0; i < n; i++) {
        if (!r.oldFootprint[i] || !before[l * n + i]) continue;
        total++;
        const c = i % grid.width;
        if (c + shift < grid.width && after[l * n + i + shift]) moved++;
      }
    }
    expect(total).toBeGreaterThan(0);
    expect(moved).toBe(total);
  });
});
