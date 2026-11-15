/**
 * Namma Space: Rearrange objects and grid patch (viewer/src/layout/objects.ts, regrid.ts)
 * The test file is the live K-720 grid (sample/test-capture/scn_hostelroomac/grid.json).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildFloorPlanWithMasks } from '../../viewer/src/nav/floorplan.js';
import { movableObjects, boxMinus } from '../../viewer/src/layout/objects.js';
import { patchGrid, unpackBits, packBits, PATCH_M, backToOriginal, type Move } from '../../viewer/src/layout/regrid.js';
import type { NavGrid } from '../../viewer/src/contracts/types.js';

const grid = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../sample/test-capture/scn_hostelroomac/grid.json', import.meta.url)), 'utf8')
) as NavGrid;
const built = buildFloorPlanWithMasks(grid)!;
const objects = movableObjects(grid, built.plan, built.masks);
const n = grid.width * grid.height;

describe('movable objects on K-720', () => {
  // Table 6 (tag at 2.21, -0.69): its top runs under the end of Bunk 2, and a shelf hangs on the wall above it
  const table6 = () => objects.find(o => o.box.minX <= 2.21 && o.box.maxX >= 2.21 && o.box.minZ <= -1 && o.box.maxZ >= -1)!;

  it('Table 6 leaves the wall shelf above it behind', () => {
    const t = table6();
    expect(t.y1).toBeGreaterThan(0.8);
    expect(t.y1).toBeLessThan(1.4);
  });

  it("Table 6 takes the end of its top that runs into Bunk 2's box, and Bunk 2 leaves it", () => {
    const t = table6();
    expect(t.extra.length).toBe(1);
    const p = t.extra[0];
    expect(p.maxX).toBeCloseTo(t.box.minX, 5);
    expect(t.box.minX - p.minX).toBeGreaterThanOrEqual(0.1);
    expect(p.y0).toBeGreaterThan(0.5);
    expect(p.y1).toBeLessThan(1.1);
    const bunk = objects.find(o => o.cut.includes(p))!;
    expect(bunk.box.maxX).toBeCloseTo(t.box.minX, 5);
    // The bunk's lift without the piece covers the same volume minus the piece
    const vol = (b: { minX: number; maxX: number; minZ: number; maxZ: number; y0: number; y1: number }) =>
      (b.maxX - b.minX) * (b.maxZ - b.minZ) * (b.y1 - b.y0);
    const whole = { ...bunk.reach, y0: bunk.y0, y1: bunk.y1 };
    const parts = boxMinus(whole, bunk.cut);
    expect(parts.reduce((a, q) => a + vol(q), 0)).toBeCloseTo(vol(whole) - bunk.cut.reduce((a, q) => a + vol(q), 0), 6);
  });

  it('every table takes the end of its top under a bunk, and nothing reaches the ceiling', () => {
    const tagAt = (x: number, z: number) => objects.find(o => x >= o.box.minX && x <= o.box.maxX && z >= o.box.minZ && z <= o.box.maxZ);
    // Table 1 and Table 2 both run under Bunk 1's ends
    for (const [x, z] of [[-2.0, -1.5], [0.08, -1.5]]) {
      const t = tagAt(x, z)!;
      expect(t.extra.some(p => p.y0 > 0.5 && p.y1 < 1.1)).toBe(true);
      expect(t.y1).toBeLessThan(1.2); // the wall rack and bookshelf above stay
    }
    // Bunks end under 2 m (nothing on the wall or near the ceiling goes with them)
    for (const id of [0, 1, 5]) expect(objects.find(o => o.id === id)!.y1).toBeLessThan(2.1);
  });

  it('floor-to-ceiling built-ins (cupboards, door frame) are not movable unless the owner fixes their box', () => {
    for (const [x, z] of [[-2.5, -1.1], [-2.5, 1.1], [-2.6, -0.6]]) {
      expect(objects.some(o => x >= o.box.minX && x <= o.box.maxX && z >= o.box.minZ && z <= o.box.maxZ)).toBe(false);
    }
    const cup = built.plan.boxes.find(b => -2.5 >= b.minX && -2.5 <= b.maxX && -1.1 >= b.minZ && -1.1 <= b.maxZ)!;
    expect(movableObjects(grid, built.plan, built.masks, new Set([cup.id])).some(o => o.id === cup.id)).toBe(true);
  });

  it('a chair seat pushed under a table goes with the chair, not the table', () => {
    const chair = objects.find(o => o.box.minX <= -1.6 && o.box.maxX >= -1.6 && o.box.minZ <= -1.0 && o.box.maxZ >= -1.0)!;
    const table1 = objects.find(o => o.box.minX <= -2.0 && o.box.maxX >= -2.0 && o.box.minZ <= -1.5 && o.box.maxZ >= -1.5)!;
    expect(chair.extra.some(p => p.y1 <= 0.7 && table1.cut.includes(p))).toBe(true);
    expect(table1.extra.every(p => !chair.cut.includes(p))).toBe(true);
  });

  it('box minus a piece gives boxes that do not overlap and leave the piece out', () => {
    const box = { minX: 0, maxX: 1, minZ: 0, maxZ: 1, y0: 0, y1: 2 };
    const cut = { minX: 0.8, maxX: 1.2, minZ: 0.2, maxZ: 0.6, y0: 0.6, y1: 0.9 };
    const parts = boxMinus(box, [cut]);
    const inside = (b: typeof box, x: number, z: number, y: number) => x >= b.minX && x < b.maxX && z >= b.minZ && z < b.maxZ && y >= b.y0 && y < b.y1;
    for (let i = 0; i < 2000; i++) {
      const x = Math.random(), z = Math.random(), y = Math.random() * 2;
      const k = parts.filter(p => inside(p, x, z, y)).length;
      expect(k).toBe(inside(cut, x, z, y) ? 0 : 1);
    }
    expect(boxMinus(box, [{ ...cut, minX: 2, maxX: 3 }])).toEqual([box]);
  });

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
