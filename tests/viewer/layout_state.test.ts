/**
 * Namma Space: Rearrange layout data (viewer/src/layout/layout.ts), on the live K-720 grid and tags
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildFloorPlanWithMasks } from '../../viewer/src/nav/floorplan.js';
import { movableObjects } from '../../viewer/src/layout/objects.js';
import { backToOriginal } from '../../viewer/src/layout/regrid.js';
import {
  LayoutHistory, normalizeMoves, movePoint, followers, layoutPois, blockedCellsFor, checkDrop,
  keepClearSpots, loadMoves, saveMoves, storageKey, type Move,
} from '../../viewer/src/layout/layout.js';
import type { NavGrid, PoiSet } from '../../viewer/src/contracts/types.js';

const read = (p: string) => JSON.parse(readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8'));
const grid = read('../../sample/test-capture/scn_hostelroomac/grid.json') as NavGrid;
const pois = (read('../../sample/test-capture/pois.json') as PoiSet).pois;
const built = buildFloorPlanWithMasks(grid)!;
const objects = movableObjects(grid, built.plan, built.masks);
const ctx = { grid, floor: built.masks.floor, objects };

describe('history', () => {
  it('undo and redo walk the steps; a new step clears redo; equal layouts add no step', () => {
    const h = new LayoutHistory();
    const a: Move[] = [{ id: 1, dx: 0.1, dz: 0, turnDeg: 0 }];
    const b: Move[] = [{ id: 1, dx: 0.2, dz: 0, turnDeg: 0 }];
    expect(h.push(a)).toBe(true);
    expect(h.push(a.map(m => ({ ...m })))).toBe(false);
    h.push(b);
    expect(h.undo()).toEqual(a);
    expect(h.undo()).toEqual([]);
    expect(h.undo()).toBeNull();
    expect(h.redo()).toEqual(a);
    h.push([]);
    expect(h.canRedo).toBe(false);
  });

  it('keeps at most the limit', () => {
    const h = new LayoutHistory([], 3);
    for (let i = 1; i <= 6; i++) h.push([{ id: 0, dx: i, dz: 0, turnDeg: 0 }]);
    let k = 0;
    while (h.undo()) k++;
    expect(k).toBe(3);
  });
});

describe('moves', () => {
  it('normalize drops identities and unknown ids, keeps one move per object', () => {
    const o = objects[0].id;
    const out = normalizeMoves([
      { id: o, dx: 0.1, dz: 0, turnDeg: 0 },
      { id: o, dx: 0.2, dz: 0, turnDeg: 375 },
      { id: 999, dx: 1, dz: 0, turnDeg: 0 },
      { id: objects[1].id, dx: 0, dz: 0, turnDeg: 360 },
    ], objects);
    expect(out).toEqual([{ id: o, dx: 0.2, dz: 0, turnDeg: 15 }]);
  });

  it('movePoint is the inverse of backToOriginal', () => {
    const o = objects[0];
    const m: Move = { id: o.id, dx: 0.3, dz: -0.1, turnDeg: 30 };
    const p = movePoint(o, m, -1, -1);
    const [x, z] = backToOriginal(o, m)(p.x, p.z);
    expect(x).toBeCloseTo(-1, 9);
    expect(z).toBeCloseTo(-1, 9);
  });
});

describe('tags follow', () => {
  const follow = followers(objects, pois);

  it('only tags inside a real box follow; the door, window and Posters never do', () => {
    const name = (id: string) => pois.find(p => p.poi_id === id)!.name;
    const names = [...follow.keys()].map(name);
    expect(names).not.toContain('Front door');
    expect(names).not.toContain('Window');
    expect(names).not.toContain('Posters');
    expect(names.length).toBeGreaterThan(0);
  });

  it('a follower slides with its object; others stay put; no moves returns the same list', () => {
    expect(layoutPois(pois, objects, [], follow)).toBe(pois);
    const [poiId, objId] = [...follow.entries()][0];
    const moved = layoutPois(pois, objects, [{ id: objId, dx: 0.4, dz: 0, turnDeg: 0 }], follow);
    const before = pois.find(p => p.poi_id === poiId)!;
    const after = moved.find(p => p.poi_id === poiId)!;
    expect(after.position.x).toBeCloseTo(before.position.x + 0.4, 9);
    const door = moved.find(p => p.name === 'Front door')!;
    expect(door.position).toEqual(pois.find(p => p.name === 'Front door')!.position);
  });
});

describe('drop rules', () => {
  // Table 3 area: a small low box (see the phase 0 dump): pick the smallest object
  const small = [...objects].sort((a, b) =>
    (a.lift.maxX - a.lift.minX) * (a.lift.maxZ - a.lift.minZ) - (b.lift.maxX - b.lift.minX) * (b.lift.maxZ - b.lift.minZ))[0];
  const blocked = blockedCellsFor(ctx, [], small.id);

  it('its own spot is free once it is lifted (no move is always fine)', () => {
    expect(checkDrop(ctx, blocked, { id: small.id, dx: 0, dz: 0, turnDeg: 0 }, [], 1).ok).toBe(true);
  });

  it('refuses a drop outside the room', () => {
    const v = checkDrop(ctx, blocked, { id: small.id, dx: 20, dz: 0, turnDeg: 0 }, [], 1);
    expect(v).toEqual({ ok: false, reason: 'outside' });
  });

  it('refuses a drop onto another object', () => {
    const other = objects.find(o => o.id !== small.id && (o.lift.maxX - o.lift.minX) > 0.8)!;
    const cx = (o: typeof small) => (o.lift.minX + o.lift.maxX) / 2;
    const cz = (o: typeof small) => (o.lift.minZ + o.lift.maxZ) / 2;
    const v = checkDrop(ctx, blocked, { id: small.id, dx: cx(other) - cx(small), dz: cz(other) - cz(small), turnDeg: 0 }, [], 1);
    expect(v.ok).toBe(false);
  });

  it('refuses a drop on the start spot or the visitor', () => {
    const cx = (small.lift.minX + small.lift.maxX) / 2, cz = (small.lift.minZ + small.lift.maxZ) / 2;
    const spots = keepClearSpots({ x: cx + 0.2, z: cz }, [], null, 0.25);
    expect(checkDrop(ctx, blocked, { id: small.id, dx: 0.2, dz: 0, turnDeg: 0 }, spots, 1)).toEqual({ ok: false, reason: 'start' });
    const you = keepClearSpots({ x: 99, z: 99 }, [], { x: cx + 0.2, z: cz }, 0.25);
    expect(checkDrop(ctx, blocked, { id: small.id, dx: 0.2, dz: 0, turnDeg: 0 }, you, 1)).toEqual({ ok: false, reason: 'you' });
  });

  it('refuses more than the moved-object limit', () => {
    expect(checkDrop(ctx, blocked, { id: small.id, dx: 0.05, dz: 0, turnDeg: 0 }, [], 9)).toEqual({ ok: false, reason: 'limit' });
  });

  it('the door tag is a keep-clear spot', () => {
    const spots = keepClearSpots({ x: 0, z: 0 }, pois, null, 0.25);
    expect(spots.some(s => s.reason === 'door')).toBe(true);
  });
});

describe('private storage', () => {
  beforeEach(() => {
    try { localStorage.clear(); } catch { /* no storage in this runtime */ }
  });

  it('round-trips moves per scene and grid, and survives blocked storage', () => {
    const m: Move[] = [{ id: 2, dx: 0.1, dz: -0.2, turnDeg: 15 }];
    saveMoves('scn_x', 'abcdef0123456789zz', m);
    expect(loadMoves('scn_x', 'abcdef0123456789zz')).toEqual(m);
    expect(loadMoves('scn_x', 'ffffffffffffffff')).toEqual([]);
    expect(storageKey('scn_x', 'abcdef0123456789zz')).toBe('ns-rearrange:scn_x:abcdef0123456789');
    saveMoves('scn_x', 'abcdef0123456789zz', []);
    expect(loadMoves('scn_x', 'abcdef0123456789zz')).toEqual([]);
  });
});

describe('routes after a move', () => {
  it('a path never crosses the moved piece, and no moves gives the same path as today', async () => {
    const { NavPlanner } = await import('../../viewer/src/nav/astar.js');
    const { patchGrid } = await import('../../viewer/src/layout/regrid.js');
    const o = objects.find(ob => ob.id === 9)!; // Table 3 by the +z wall
    const m: Move = { id: 9, dx: -0.1, dz: -0.4, turnDeg: 15 };
    const patched = patchGrid(grid, objects, [m]);
    const from = { x: 0.12, z: 0.132 };
    const to = { x: -2.2, z: 0.5 };
    const before = new NavPlanner(grid).findPath(from, to)!;
    expect(new NavPlanner(patchGrid(grid, objects, []).grid).findPath(from, to)).toEqual(before);
    const after = new NavPlanner(patched.grid).findPath(from, to);
    expect(after).not.toBeNull();
    const w = grid.width, cell = grid.cell_m, [ox, oz] = grid.origin;
    for (let k = 1; k < after!.points.length; k++) {
      const a = after!.points[k - 1], b = after!.points[k];
      const steps = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / (cell / 2));
      for (let s = 0; s <= steps; s++) {
        const x = a.x + ((b.x - a.x) * s) / steps, z = a.z + ((b.z - a.z) * s) / steps;
        const i = Math.floor((z - oz) / cell) * w + Math.floor((x - ox) / cell);
        expect(patched.newFootprint[i]).toBe(0);
      }
    }
    expect(o).toBeDefined();
  });
});
