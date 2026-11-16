/**
 * AR route guidance (viewer/src/nav/route_follower.ts): turn sides, the turn table, progress along the
 * route, re-route when off it, arrival once, and routes on the real K-720 grid staying on floor.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import {
  ARRIVE_HOLD_MS,
  RouteFollower,
  nextMove,
  projectOnRoute,
  signedTurnDeg,
  turnFor,
} from '../../viewer/src/nav/route_follower.js';
import { NavPlanner, type Point2 } from '../../viewer/src/nav/astar.js';
import type { NavGrid, PoiSet } from '../../viewer/src/contracts/types.js';

describe('AR guidance: turn side', () => {
  it('walking toward -Z, a leg toward +X is a right turn (three.js camera convention)', () => {
    // three.js: a camera looking down -Z has +X on its right
    const cam = new THREE.PerspectiveCamera();
    cam.lookAt(0, 0, -1);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    expect(right.x).toBeCloseTo(1, 6);
    expect(signedTurnDeg({ x: 0, z: -1 }, { x: 1, z: 0 })).toBeCloseTo(90, 6);
    expect(turnFor(signedTurnDeg({ x: 0, z: -1 }, { x: 1, z: 0 }))).toBe('right');
    expect(turnFor(signedTurnDeg({ x: 0, z: -1 }, { x: -1, z: 0 }))).toBe('left');
  });

  it('is not mirrored for other headings', () => {
    // Walking +X, then turning toward +Z: facing +X, right is (-d.z, d.x) = (0, 1) = +Z
    expect(turnFor(signedTurnDeg({ x: 1, z: 0 }, { x: 0, z: 1 }))).toBe('right');
    expect(turnFor(signedTurnDeg({ x: 1, z: 0 }, { x: 0, z: -1 }))).toBe('left');
  });

  it('follows the spec table', () => {
    expect(turnFor(10)).toBe('straight');
    expect(turnFor(-29)).toBe('straight');
    expect(turnFor(45)).toBe('slight-right');
    expect(turnFor(-45)).toBe('slight-left');
    expect(turnFor(90)).toBe('right');
    expect(turnFor(-120)).toBe('left');
    expect(turnFor(150)).toBe('around');
    expect(turnFor(-170)).toBe('around');
  });
});

describe('AR guidance: progress and next move', () => {
  // An L: 4 m toward -Z, then 3 m toward +X (a right turn)
  const L: Point2[] = [
    { x: 0, z: 0 },
    { x: 0, z: -4 },
    { x: 3, z: -4 },
  ];

  it('projects onto the route and measures what is left', () => {
    const pr = projectOnRoute(L, { x: 0.3, z: -1 });
    expect(pr.seg).toBe(0);
    expect(pr.offM).toBeCloseTo(0.3, 6);
    expect(pr.remainingM).toBeCloseTo(3 + 3, 6);
  });

  it('names the corner ahead and its distance', () => {
    const m = nextMove(L, projectOnRoute(L, { x: 0, z: -1 }));
    expect(m.toGoal).toBe(false);
    expect(m.turn).toBe('right');
    expect(m.distM).toBeCloseTo(3, 6);
    expect([m.x, m.z]).toEqual([0, -4]);
    expect(m.dirX).toBeCloseTo(1, 6);
  });

  it('after the corner, arrows only while they fit before the goal ring', () => {
    // 2.5 m left: 1.5 m ahead + 1.2 m of arrows + 0.3 m clear does not fit
    const near = nextMove(L, projectOnRoute(L, { x: 0.5, z: -4 }));
    expect(near.toGoal).toBe(true);
    expect(near.distM).toBeCloseTo(2.5, 6);
    expect(near.arrows).toBe(false);
    // A long last straight: arrows start 3 m ahead and end before the ring
    const long: Point2[] = [
      { x: 0, z: 0 },
      { x: 0, z: -8 },
    ];
    const far = nextMove(long, projectOnRoute(long, { x: 0, z: 0 }));
    expect(far.arrows).toBe(true);
    expect(far.z).toBeCloseTo(-3, 6);
    // 3.5 m left: start at 3.5 - 1.2 - 0.3 = 2 m ahead
    const mid = nextMove(long, projectOnRoute(long, { x: 0, z: -4.5 }));
    expect(mid.arrows).toBe(true);
    expect(mid.z).toBeCloseTo(-6.5, 6);
  });

  it('a corner almost underfoot moves the arrows onto the next leg', () => {
    const longL: Point2[] = [
      { x: 0, z: 0 },
      { x: 0, z: -4 },
      { x: 6, z: -4 },
    ];
    const m = nextMove(longL, projectOnRoute(longL, { x: 0, z: -3.6 }));
    expect(m.turn).toBe('right');
    expect(m.distM).toBeCloseTo(0.4, 6);
    // ARROW_MIN_AHEAD_M (1.5 m) along the route: 0.4 m to the corner, then 1.1 m along the +X leg
    expect(m.x).toBeCloseTo(1.1, 6);
    expect(m.z).toBeCloseTo(-4, 6);
    expect(m.dirX).toBeCloseTo(1, 6);
    expect(m.arrows).toBe(true);
  });

  it('small bends are not corners', () => {
    const bend: Point2[] = [
      { x: 0, z: 0 },
      { x: 0, z: -3 },
      { x: 0.5, z: -6 }, // about 9 degrees
      { x: 3.5, z: -6 }, // then a real right turn
    ];
    const m = nextMove(bend, projectOnRoute(bend, { x: 0, z: -1 }));
    expect([m.x, m.z]).toEqual([0.5, -6]);
    expect(m.turn).toBe('right');
  });
});

describe('AR guidance: follower', () => {
  const straight = (from: Point2): Point2[] => [{ ...from }, { x: from.x, z: from.z - 5 }];

  it('re-routes when the walker leaves the route, not while on it', () => {
    let calls = 0;
    const f = new RouteFollower(from => {
      calls++;
      return straight(from);
    });
    f.update(0, { x: 0, z: 0 }, { x: 0, z: -1 });
    expect(calls).toBe(1);
    // Walk along it, small sway: no new route
    for (let t = 16, z = 0; t < 2000; t += 16, z -= 0.01) f.update(t, { x: 0.2, z }, { x: 0, z: -1 });
    expect(calls).toBe(1);
    // Step 1.5 m to the side: a new route at the next upkeep
    f.update(2600, { x: 1.5, z: -1.5 }, { x: 0, z: -1 });
    expect(calls).toBe(2);
  });

  it('keeps the old route when a new one cannot be found', () => {
    let ok = true;
    const f = new RouteFollower(from => (ok ? straight(from) : null));
    f.update(0, { x: 0, z: 0 }, null);
    ok = false;
    const s = f.update(1000, { x: 2, z: -1 }, null);
    expect(s.noRoute).toBe(false);
    expect(f.points?.length).toBe(2);
  });

  it('says no route when none was ever found', () => {
    const f = new RouteFollower(() => null);
    expect(f.update(0, { x: 0, z: 0 }, null).noRoute).toBe(true);
  });

  it('arrives once, after holding under 1 m for half a second', () => {
    const goal = { x: 0, z: -5 };
    const f = new RouteFollower(from => [{ ...from }, goal]);
    f.update(0, { x: 0, z: 0 }, { x: 0, z: -1 });
    let fired = 0;
    let t = 16;
    for (; t < 3000; t += 16) {
      const z = Math.max(-4.5, -t / 500);
      if (f.update(t, { x: 0, z }, { x: 0, z: -1 }).arrivedNow) fired++;
    }
    expect(fired).toBe(1);
    expect(f.hasArrived).toBe(true);
    // A brief dip under 1 m does not count
    const g = new RouteFollower(from => [{ ...from }, goal]);
    g.update(0, { x: 0, z: 0 }, null);
    g.update(100, { x: 0, z: -4.2 }, null);
    expect(g.update(100 + ARRIVE_HOLD_MS - 50, { x: 0, z: -4.2 }, null).arrivedNow).toBe(false);
    g.update(100 + ARRIVE_HOLD_MS + 50, { x: 0, z: -3 }, null);
    expect(g.hasArrived).toBe(false);
  });

  it('says turn around when the phone faces away from the way to go', () => {
    const f = new RouteFollower(straight);
    expect(f.update(0, { x: 0, z: 0 }, { x: 0, z: 1 }).facingAway).toBe(true);
    expect(f.update(16, { x: 0, z: 0 }, { x: 0.3, z: -1 }).facingAway).toBe(false);
  });
});

describe('AR guidance on the real K-720 grid', () => {
  const read = (f: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../sample/test-capture/${f}`, import.meta.url)), 'utf8'));
  const grid = read('scn_hostelroomac/grid.json') as NavGrid;
  const set = read('pois.json') as PoiSet;
  const planner = new NavPlanner(grid);

  it('routes from the door to every place stay on walkable floor, corners included', () => {
    const door = set.pois.find(p => p.name === 'Front door')!;
    const start = { x: door.position.x + 0.6, z: door.position.z };
    let checked = 0;
    for (const p of set.pois) {
      const path = planner.findPath(start, { x: p.position.x, z: p.position.z });
      if (!path) continue;
      const pts = path.points;
      for (let i = 0; i + 1 < pts.length; i++) {
        const n = Math.ceil(Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z) / 0.02);
        for (let k = 0; k <= n; k++) {
          const x = pts[i].x + ((pts[i + 1].x - pts[i].x) * k) / Math.max(1, n);
          const z = pts[i].z + ((pts[i + 1].z - pts[i].z) * k) / Math.max(1, n);
          // The first point is the walker's own spot; everything after it is on the floor map
          if (i === 0 && k === 0) continue;
          expect(planner.isWalkable(x, z)).toBe(true);
        }
      }
      // The follower finds a next move on each of them
      const f = new RouteFollower(from => planner.findPath(from, { x: p.position.x, z: p.position.z })?.points ?? null);
      const s = f.update(0, start, { x: 1, z: 0 });
      expect(s.noRoute).toBe(false);
      expect(s.next).not.toBeNull();
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(10);
  });
});
