/**
 * Namma Space: floor plan shapes for the minimap (viewer/src/nav/floorplan.ts)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildFloorPlan,
  buildFloorPlanWithMasks,
  layoutTags,
  matchTagsToBoxes,
  kindOf,
  type FloorPlan,
  type PlanBox,
} from '../../viewer/src/nav/floorplan.js';
import type { NavGrid, PoiSet } from '../../viewer/src/contracts/types.js';

const CELL = 0.05;
const RADIUS = 0.25; // 5 cells of margin, as the pipeline writes it
const LAYERS = 28; // 0.1 m slices from y = 0.1 m

const encode = (bits: Uint8Array): string => {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((v, i) => { if (v) bytes[i >> 3] |= 0x80 >> (i & 7); });
  return Buffer.from(bytes).toString('base64');
};

type Rect = { c0: number; r0: number; c1: number; r1: number };

/**
 * A grid w x h cells. `solid` rects are occupied in every slice (walls), `objects` only between
 * yLo and yHi. Walkable bits: inside the margin, at least the body radius from any obstacle.
 */
function makeGrid(w: number, h: number, opts: { solid?: Rect[]; objects?: (Rect & { yLo?: number; yHi?: number })[]; layers?: boolean } = {}): NavGrid {
  const n = w * h;
  const pad = Math.round(RADIUS / CELL);
  const occ = new Uint8Array(LAYERS * n);
  const any = new Uint8Array(n);
  const mark = (rect: Rect, l0: number, l1: number) => {
    for (let r = rect.r0; r <= rect.r1; r++) {
      for (let c = rect.c0; c <= rect.c1; c++) {
        any[r * w + c] = 1;
        for (let l = l0; l <= l1; l++) occ[l * n + r * w + c] = 1;
      }
    }
  };
  for (const s of opts.solid ?? []) mark(s, 0, LAYERS - 1);
  for (const o of opts.objects ?? []) {
    mark(o, Math.round(((o.yLo ?? 0.3) - 0.1) / 0.1), Math.round(((o.yHi ?? 1.6) - 0.1) / 0.1) - 1);
  }
  const free = new Uint8Array(n);
  for (let r = pad; r < h - pad; r++) {
    for (let c = pad; c < w - pad; c++) {
      let clear = true;
      for (let dr = -pad; dr <= pad && clear; dr++) {
        for (let dc = -pad; dc <= pad && clear; dc++) {
          const rr = r + dr, cc = c + dc;
          if (dr * dr + dc * dc > pad * pad || rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
          if (any[rr * w + cc]) clear = false;
        }
      }
      free[r * w + c] = clear ? 1 : 0;
    }
  }
  return {
    schema_version: 1,
    nav_id: 'nav_aaaaaaaaaaaa',
    transform_scene: 'scn_aaaaaaaaaaaa',
    cell_m: CELL,
    origin: [0, 0],
    width: w,
    height: h,
    agent_radius_m: RADIUS,
    free_bits_b64: encode(free),
    ...(opts.layers === false ? {} : { layers: { y0_m: 0.1, dy_m: 0.1, count: LAYERS, occupied_bits_b64: encode(occ) } }),
  };
}

const freeCells = (g: NavGrid): [number, number][] => {
  const bytes = Buffer.from(g.free_bits_b64, 'base64');
  const out: [number, number][] = [];
  for (let i = 0; i < g.width * g.height; i++) {
    if ((bytes[i >> 3] >> (7 - (i & 7))) & 1) out.push([i % g.width, Math.floor(i / g.width)]);
  }
  return out;
};

/** No box may cover a walkable cell (the route never runs under furniture on the map) */
function expectNoBoxOnFree(g: NavGrid, plan: FloorPlan): void {
  for (const [c, r] of freeCells(g)) {
    const x = g.origin[0] + (c + 0.5) * g.cell_m;
    const z = g.origin[1] + (r + 0.5) * g.cell_m;
    for (const b of plan.boxes) {
      const inside = x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ;
      expect(inside, `box ${b.id} covers walkable cell ${c},${r}`).toBe(false);
    }
  }
}

const cellsOf = (b: PlanBox) => ({
  c0: Math.round(b.minX / CELL), r0: Math.round(b.minZ / CELL),
  c1: Math.round(b.maxX / CELL) - 1, r1: Math.round(b.maxZ / CELL) - 1,
});

describe('buildFloorPlan', () => {
  it('traces a plain room as one rectangle on the scene bounds', () => {
    const g = makeGrid(80, 60);
    const plan = buildFloorPlan(g)!;
    expect(plan.source).toBe('layers');
    expect(plan.boxes).toEqual([]);
    expect(plan.outline).toHaveLength(1);
    const ring = plan.outline[0];
    expect(ring).toHaveLength(4);
    const xs = ring.map((p) => p.x), zs = ring.map((p) => p.z);
    expect(Math.min(...xs)).toBeCloseTo(0.25, 6);
    expect(Math.max(...xs)).toBeCloseTo(4 - 0.25, 6);
    expect(Math.min(...zs)).toBeCloseTo(0.25, 6);
    expect(Math.max(...zs)).toBeCloseTo(3 - 0.25, 6);
  });

  it('fits one piece of furniture with one box', () => {
    const g = makeGrid(80, 60, { objects: [{ c0: 30, r0: 25, c1: 49, r1: 36 }] });
    const plan = buildFloorPlan(g)!;
    expect(plan.boxes).toHaveLength(1);
    expect(cellsOf(plan.boxes[0])).toEqual({ c0: 30, r0: 25, c1: 49, r1: 36 });
    expect(plan.boxes[0].tall).toBe(false);
    expectNoBoxOnFree(g, plan);
  });

  it('snaps a box that stands near a wall onto the wall', () => {
    // 2 cells (0.1 m) of gap between the object and the wall at row 5
    const g = makeGrid(80, 60, { objects: [{ c0: 30, r0: 7, c1: 49, r1: 20 }] });
    const box = cellsOf(buildFloorPlan(g)!.boxes[0]);
    expect(box.r0).toBe(5);
    expect(box.r1).toBe(20);
  });

  it('splits two touching pieces into two boxes', () => {
    // A wide table against a long bed, touching along one side: one blob shaped like an L
    const g = makeGrid(100, 70, {
      objects: [
        { c0: 20, r0: 20, c1: 39, r1: 29 },
        { c0: 40, r0: 20, c1: 49, r1: 49 },
      ],
    });
    const plan = buildFloorPlan(g)!;
    expect(plan.boxes).toHaveLength(2);
    const boxes = plan.boxes.map(cellsOf).sort((a, b) => a.c0 - b.c0);
    expect(boxes[0]).toEqual({ c0: 20, r0: 20, c1: 39, r1: 29 });
    expect(boxes[1]).toEqual({ c0: 40, r0: 20, c1: 49, r1: 49 });
    expectNoBoxOnFree(g, plan);
  });

  it('separates a tall bunk from a low table beside it by height band', () => {
    const g = makeGrid(100, 70, {
      objects: [
        { c0: 20, r0: 20, c1: 39, r1: 49, yLo: 0.3, yHi: 1.7 }, // bunk
        { c0: 40, r0: 25, c1: 51, r1: 34, yLo: 0.6, yHi: 0.9 }, // table touching it
      ],
    });
    const boxes = buildFloorPlan(g)!.boxes.map(cellsOf).sort((a, b) => a.c0 - b.c0);
    expect(boxes).toEqual([
      { c0: 20, r0: 20, c1: 39, r1: 49 },
      { c0: 40, r0: 25, c1: 51, r1: 34 },
    ]);
  });

  it('marks a free-standing solid pillar as a tall box, not as wall', () => {
    const g = makeGrid(80, 60, { solid: [{ c0: 38, r0: 28, c1: 43, r1: 33 }] });
    const plan = buildFloorPlan(g)!;
    expect(plan.outline).toHaveLength(1);
    expect(plan.boxes).toHaveLength(1);
    expect(plan.boxes[0].tall).toBe(true);
  });

  it('traces an L-shaped room with six corners', () => {
    // A solid block fills the top-right quarter, joined to the outer wall
    const g = makeGrid(100, 80, { solid: [{ c0: 50, r0: 0, c1: 99, r1: 39 }] });
    const plan = buildFloorPlan(g)!;
    expect(plan.outline).toHaveLength(1);
    expect(plan.outline[0]).toHaveLength(6);
    expect(plan.boxes).toEqual([]);
  });

  it('falls back to the walkable bits when the grid has no height layers', () => {
    const g = makeGrid(80, 60, { objects: [{ c0: 30, r0: 25, c1: 49, r1: 36 }], layers: false });
    const plan = buildFloorPlan(g)!;
    expect(plan.source).toBe('free_bits');
    expect(plan.outline).toHaveLength(1);
    expect(plan.boxes).toHaveLength(1);
    // Grown back by the body radius, the box lands within a cell or two of the real object
    const b = cellsOf(plan.boxes[0]);
    expect(Math.abs(b.c0 - 30)).toBeLessThanOrEqual(2);
    expect(Math.abs(b.c1 - 49)).toBeLessThanOrEqual(2);
    expect(Math.abs(b.r0 - 25)).toBeLessThanOrEqual(2);
    expect(Math.abs(b.r1 - 36)).toBeLessThanOrEqual(2);
    expectNoBoxOnFree(g, plan);
  });

  it('returns null for an empty grid', () => {
    expect(buildFloorPlan({ ...makeGrid(10, 10), width: 0, height: 0 })).toBeNull();
    const nothing = makeGrid(40, 40, { layers: false });
    expect(buildFloorPlan({ ...nothing, free_bits_b64: encode(new Uint8Array(1600)) })).toBeNull();
  });
});

describe('buildFloorPlan on the real K-720 grid', () => {
  const read = (f: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../sample/test-capture/${f}`, import.meta.url)), 'utf8'));
  const grid = read('scn_hostelroomac/grid.json') as NavGrid;
  const pois = (read('pois.json') as PoiSet).pois;
  const plan = buildFloorPlan(grid)!;

  it('is one rectangular room from the height layers', () => {
    expect(plan.source).toBe('layers');
    expect(plan.outline).toHaveLength(1);
    expect(plan.outline[0]).toHaveLength(4);
  });

  it('draws a box under every bunk and every table', () => {
    const near = (x: number, z: number, b: PlanBox, slack: number) =>
      x >= b.minX - slack && x <= b.maxX + slack && z >= b.minZ - slack && z <= b.maxZ + slack;
    for (const p of pois.filter((q) => /^(Bunk|Table)/.test(q.name))) {
      const hit = plan.boxes.some((b) => near(p.position.x, p.position.z, b, 0.4));
      expect(hit, `${p.name} has a box`).toBe(true);
    }
  });

  it('never puts a box on a walkable cell', () => {
    expectNoBoxOnFree(grid, plan);
  });
});

describe('tags on the plan', () => {
  const tag = (poi_id: string, name: string, x: number, z: number, category = 'sleep') =>
    ({ poi_id, name, category, position: { x, z } });

  it('matches a tag to the box it is in, else the nearest within 1 m, else none', () => {
    const boxes: PlanBox[] = [
      { id: 0, minX: 0, minZ: 0, maxX: 1, maxZ: 2, tall: false },
      { id: 1, minX: 3, minZ: 0, maxX: 4, maxZ: 2, tall: false },
    ];
    const m = matchTagsToBoxes(boxes, [
      tag('a', 'Bunk 1', 0.5, 1), // inside box 0
      tag('b', 'Bunk 2', 4.6, 1), // 0.6 m from box 1
      tag('c', 'Lamp', 2, 5), // far from both
    ]);
    expect(m.get('a')).toBe(0);
    expect(m.get('b')).toBe(1);
    expect(m.has('c')).toBe(false);
  });

  it('groups numbered names of one category as one kind', () => {
    expect(kindOf(tag('a', 'Bunk 1', 0, 0))).toBe(kindOf(tag('b', 'Bunk 12', 0, 0)));
    expect(kindOf(tag('a', 'Bunk 1', 0, 0))).not.toBe(kindOf(tag('b', 'Table 1', 0, 0, 'study')));
  });

  it('gives same-kind boxes one size, puts dots on their boxes and opens the door', () => {
    // Two bunks against the top wall, one a little shorter and wider (the K-720 complaint)
    const g = makeGrid(120, 80, {
      objects: [
        { c0: 20, r0: 5, c1: 39, r1: 44 },
        { c0: 60, r0: 5, c1: 82, r1: 40 },
      ],
    });
    const fp = buildFloorPlanWithMasks(g)!;
    expect(fp.plan.boxes).toHaveLength(2);
    const tags = [
      tag('b1', 'Bunk 1', 1.5, 2.3),
      tag('b2', 'Bunk 2', 3.6, 2.1),
      tag('door', 'Front door', 0.3, 3.0, 'exit'),
    ];
    const lay = layoutTags(g, fp.plan, fp.masks, tags);
    const sizes = lay.boxes.map((b) => [+(b.maxX - b.minX).toFixed(3), +(b.maxZ - b.minZ).toFixed(3)]);
    expect(sizes[0]).toEqual(sizes[1]);
    // Wall edge stays on the wall
    for (const b of lay.boxes) expect(b.minZ).toBeCloseTo(0.25, 6);
    // Each bunk dot sits at its box centre
    for (const id of ['b1', 'b2']) {
      const b = lay.boxes[lay.boxOf.get(id)!];
      expect(lay.dots.get(id)).toEqual({ x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 });
    }
    // The door is a 0.9 m gap on the left wall (x = 0.25), opening into the room
    const door = lay.openings.find((o) => o.kind === 'door')!;
    expect(door.a.x).toBeCloseTo(0.25, 6);
    expect(door.b.x).toBeCloseTo(0.25, 6);
    expect(Math.abs(door.b.z - door.a.z)).toBeCloseTo(0.9, 6);
    expect(door.inward.x).toBeCloseTo(1, 6);
    expectNoBoxOnFree(g, { ...fp.plan, boxes: lay.boxes });
  });

  it('leaves an unmatched tag on its real spot and skips a window far from any wall', () => {
    const g = makeGrid(80, 60);
    const fp = buildFloorPlanWithMasks(g)!;
    const lay = layoutTags(g, fp.plan, fp.masks, [tag('w', 'Window', 2, 1.5, 'utility')]);
    expect(lay.dots.get('w')).toEqual({ x: 2, z: 1.5 });
    expect(lay.openings).toEqual([]);
  });
});

describe('K-720 tags on the plan', () => {
  const read = (f: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../sample/test-capture/${f}`, import.meta.url)), 'utf8'));
  const grid = read('scn_hostelroomac/grid.json') as NavGrid;
  const pois = (read('pois.json') as PoiSet).pois;
  const fp = buildFloorPlanWithMasks(grid)!;
  const lay = layoutTags(grid, fp.plan, fp.masks, pois);
  const byName = (n: string) => pois.find((p) => p.name === n)!;

  it('draws the three bunks at one size', () => {
    const sizes = ['Bunk 1', 'Bunk 2', 'Bunk 3'].map((n) => {
      const b = lay.boxes[lay.boxOf.get(byName(n).poi_id)!];
      const dx = b.maxX - b.minX, dz = b.maxZ - b.minZ;
      return [Math.max(dx, dz), Math.min(dx, dz)].map((v) => +v.toFixed(3));
    });
    expect(new Set(sizes.map((s) => s.join('x'))).size).toBe(1);
  });

  it('puts every bunk and table dot on a box', () => {
    for (const p of pois.filter((q) => /^(Bunk|Table)/.test(q.name))) {
      const id = lay.boxOf.get(p.poi_id);
      expect(id, `${p.name} has a box`).toBeDefined();
      const b = lay.boxes[id!];
      const d = lay.dots.get(p.poi_id)!;
      expect(d.x > b.minX && d.x < b.maxX && d.z > b.minZ && d.z < b.maxZ, `${p.name} dot on its box`).toBe(true);
    }
  });

  it('opens a door at the Front door and a window at the Window', () => {
    expect(lay.openings.find((o) => o.kind === 'door')?.poi_id).toBe(byName('Front door').poi_id);
    expect(lay.openings.find((o) => o.kind === 'window')?.poi_id).toBe(byName('Window').poi_id);
  });

  it('keeps every box off walkable cells after resizing', () => {
    expectNoBoxOnFree(grid, { ...fp.plan, boxes: lay.boxes });
  });
});
