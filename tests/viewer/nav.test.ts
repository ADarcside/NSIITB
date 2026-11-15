/**
 * Namma Space: Round 2 path planner and POI search tests
 */

import { describe, it, expect } from 'vitest';
import { NavPlanner } from '../../viewer/src/nav/astar.js';
import { searchPois } from '../../viewer/src/nav/search.js';
import { makePoi, validatePoiSet, makePoiSet, approachFor, poiGoal } from '../../viewer/src/nav/pois.js';
import type { NavGrid } from '../../viewer/src/contracts/types.js';

/** NavGrid from rows of '.' (free) and '#' (blocked); row 0 is the smallest z. */
function gridFrom(rows: string[], cell = 0.1): NavGrid {
  const width = rows[0].length, height = rows.length;
  const bytes = new Uint8Array(Math.ceil((width * height) / 8));
  rows.forEach((row, r) => [...row].forEach((ch, c) => {
    const i = r * width + c;
    if (ch === '.') bytes[i >> 3] |= 0x80 >> (i & 7);
  }));
  return {
    schema_version: 1, nav_id: 'nav_aaaaaaaaaaaa', transform_scene: 'scn_aaaaaaaaaaaa',
    cell_m: cell, origin: [0, 0], width, height, agent_radius_m: 0.25,
    free_bits_b64: Buffer.from(bytes).toString('base64'),
  };
}

const ROOM = [
  '....................',
  '....................',
  '..........#.........',
  '..........#.........',
  '..........#.........',
  '..........#.........',
  '..........#.........',
  '..........#.........',
  '..........#.........',
  '..........#.........',
];

describe('NavPlanner', () => {
  it('routes around a wall without crossing blocked cells', () => {
    const p = new NavPlanner(gridFrom(ROOM));
    const path = p.findPath({ x: 0.55, z: 0.85 }, { x: 1.55, z: 0.85 })!;
    expect(path).not.toBeNull();
    for (let k = 1; k < path.points.length; k++) {
      const a = path.points[k - 1], b = path.points[k];
      for (let u = 0; u <= 1; u += 0.02) expect(p.isWalkable(a.x + (b.x - a.x) * u, a.z + (b.z - a.z) * u)).toBe(true);
    }
    expect(path.lengthM).toBeGreaterThan(1.0); // longer than the straight line through the wall
  });

  it('snaps a goal inside furniture to the nearest walkable cell', () => {
    const p = new NavPlanner(gridFrom(ROOM));
    const path = p.findPath({ x: 0.15, z: 0.15 }, { x: 1.05, z: 0.55 })!;
    const end = path.points[path.points.length - 1];
    expect(p.isWalkable(end.x, end.z)).toBe(true);
    expect(Math.hypot(end.x - 1.05, end.z - 0.55)).toBeLessThan(0.15);
  });

  it('returns null when the goal is unreachable', () => {
    const closed = ['.....#.....', '.....#.....', '.....#.....'];
    expect(new NavPlanner(gridFrom(closed)).findPath({ x: 0.15, z: 0.15 }, { x: 0.95, z: 0.15 })).toBeNull();
  });

  it('routes to a tag placed off the floor map (e.g. on a bunk 3 m away) via the nearest floor cell', () => {
    const p = new NavPlanner(gridFrom(ROOM));
    const tag = { x: 1.0, z: 3.5 }; // 2.5 m beyond the grid's last row
    const path = p.findPath({ x: 0.15, z: 0.15 }, tag)!;
    expect(path).not.toBeNull();
    const end = path.points[path.points.length - 1];
    expect(p.isWalkable(end.x, end.z)).toBe(true);
    expect(end.z).toBeGreaterThan(0.85); // ends on the row closest to the tag
    expect(p.findPath({ x: 0.15, z: 0.15 }, tag, 2.0)).toBeNull(); // the old 2 m snap could not reach it
  });

  it('routes a tag on furniture to the floor you can reach, not into a closed-off pocket', () => {
    // A cupboard (#) with a sealed pocket behind it; the tag sits on the cupboard, nearer the pocket
    const rows = [
      '..........',
      '..........',
      '..........',
      '##########',
      '##########',
      '####...###',
      '##########',
    ];
    const p = new NavPlanner(gridFrom(rows));
    const tag = { x: 0.55, z: 0.45 }; // on the cupboard: 0.1 m from the pocket, 0.2 m from the room
    const path = p.findPath({ x: 0.15, z: 0.15 }, tag)!;
    expect(path).not.toBeNull();
    const end = path.points[path.points.length - 1];
    expect(end.z).toBeLessThan(0.3); // ends in the open room, not inside the pocket
  });

  it('reuses its work when the walker moves along a route (same answer as a fresh planner)', () => {
    const p = new NavPlanner(gridFrom(ROOM));
    const goal = { x: 1.55, z: 0.85 };
    const starts = [{ x: 0.55, z: 0.85 }, { x: 0.65, z: 0.55 }, { x: 0.95, z: 0.15 }, { x: 1.85, z: 0.15 }, { x: 0.15, z: 0.95 }];
    for (const s of starts) {
      const reused = p.findPath(s, goal)!;
      const fresh = new NavPlanner(gridFrom(ROOM)).findPath(s, goal)!;
      expect(reused.lengthM).toBeCloseTo(fresh.lengthM, 6);
      expect(reused.points).toEqual(fresh.points);
    }
    // A second goal in between (a place card's distance) and back again
    p.findPath(starts[0], { x: 0.15, z: 0.15 });
    expect(p.findPath(starts[1], goal)!.lengthM).toBeCloseTo(new NavPlanner(gridFrom(ROOM)).findPath(starts[1], goal)!.lengthM, 6);
  });

  it('gives a straight two-point path across open floor', () => {
    const open = Array.from({ length: 20 }, () => '.'.repeat(20));
    const path = new NavPlanner(gridFrom(open)).findPath({ x: 0.5, z: 0.5 }, { x: 1.55, z: 1.55 })!;
    expect(path.points.length).toBe(2);
  });
});

describe('searchPois', () => {
  const s = 'scn_aaaaaaaaaaaa';
  const pois = [
    makePoi(s, 'Meeting Room 4', 1, 1, { category: 'room', aliases: ['MR4'] }),
    makePoi(s, 'Meeting Room 14', 2, 2, { category: 'room' }),
    makePoi(s, 'Top bunk', 3, 3, { category: 'furniture' }),
    makePoi(s, 'Exit door', 4, 4, { category: 'exit' }),
  ];
  const top = (q: string) => searchPois(pois, q)[0]?.poi.name;

  it('finds exact, reordered, prefix, number-word and typo queries', () => {
    expect(top('Meeting Room 4')).toBe('Meeting Room 4');
    expect(top('room 4 meeting')).toBe('Meeting Room 4');
    expect(top('meeting room four')).toBe('Meeting Room 4');
    expect(top('meting room 4')).toBe('Meeting Room 4');
    expect(top('bunk')).toBe('Top bunk');
    expect(top('mr4')).toBe('Meeting Room 4');
    expect(top('exit')).toBe('Exit door');
    expect(top('dor')).toBe('Exit door');
    expect(top('bnk')).toBe('Top bunk');
  });

  it('does not confuse room 4 with room 14', () => {
    expect(searchPois(pois, 'room 4').map(h => h.poi.name)).not.toContain('Meeting Room 14');
  });

  it('validates a POI set', () => {
    expect(validatePoiSet(makePoiSet(s, pois))).toEqual([]);
    expect(validatePoiSet({ schema_version: 1, scene_id: s, pois: [{ name: '' }] }).length).toBeGreaterThan(0);
  });
});

describe('standing spot (approach)', () => {
  // A wall at x = 1.0 splits two rooms joined by a door at the far end
  const ROOMS = [
    '..........#..........',
    '..........#..........',
    '..........#..........',
    '..........#..........',
    '.....................',
  ];
  const p = new NavPlanner(gridFrom(ROOMS));
  const walk = (x: number, z: number) => p.isWalkable(x, z);

  it('is only set for a tag off the floor, from a nearby editor standing on the floor', () => {
    expect(approachFor({ x: 0.5, z: 0.15 }, { x: 0.3, z: 0.15 }, walk)).toBeUndefined(); // tag on floor
    expect(approachFor({ x: 1.05, z: 0.15 }, { x: 0.75, z: 0.15 }, walk)).toEqual({ x: 0.75, z: 0.15 });
    expect(approachFor({ x: 1.05, z: 0.15 }, { x: 1.05, z: 0.25 }, walk)).toBeUndefined(); // editor in the wall
    expect(approachFor({ x: 1.05, z: 0.15 }, { x: 1.05, z: 0.15 + 5 }, () => true)).toBeUndefined(); // too far
  });

  it('routes to the side of the wall the tag was made from', () => {
    // Tag on the wall, a hair nearer the right-hand room, tagged by someone standing in the left room
    const poi = makePoi('scn_aaaaaaaaaaaa', 'Whiteboard', 1.07, 0.15);
    const start = { x: 0.25, z: 0.15 };
    const plain = p.findPath(start, poiGoal(poi))!;
    expect(plain.points[plain.points.length - 1].x).toBeGreaterThan(1.0); // goes round to the right room
    poi.approach = approachFor(poi.position, { x: 0.85, z: 0.15 }, walk);
    const viaSpot = p.findPath(start, poiGoal(poi))!;
    expect(viaSpot.points[viaSpot.points.length - 1].x).toBeLessThan(1.0);
    expect(viaSpot.lengthM).toBeLessThan(plain.lengthM);
  });

  it('is validated when present', () => {
    const poi = { ...makePoi('scn_aaaaaaaaaaaa', 'Desk', 0, 0), approach: { x: 1 } };
    expect(validatePoiSet(makePoiSet('scn_aaaaaaaaaaaa', [poi as never])).join()).toMatch(/approach/);
  });
});

describe('walkDistances (spatial search)', () => {
  it('gives walking distance around the wall, not straight-line distance', () => {
    const p = new NavPlanner(gridFrom(ROOM));
    const [near, behindWall] = p.walkDistances({ x: 0.55, z: 0.85 }, [{ x: 0.55, z: 0.25 }, { x: 1.55, z: 0.85 }]);
    expect(near).toBeCloseTo(0.6, 1);
    // Straight line is 1.0 m, but the walk goes up round the end of the wall
    expect(behindWall!).toBeGreaterThan(1.4);
    // The drawn route keeps away from the wall, so it is a little longer than the grid walk
    const path = p.findPath({ x: 0.55, z: 0.85 }, { x: 1.55, z: 0.85 })!;
    expect(behindWall!).toBeLessThanOrEqual(path.lengthM + 1e-9);
    expect(behindWall!).toBeGreaterThan(path.lengthM * 0.75);
  });

  it('gives null for a goal the walker cannot reach', () => {
    const closed = ['.....#.....', '.....#.....', '.....#.....'];
    const p = new NavPlanner(gridFrom(closed));
    expect(p.walkDistances({ x: 0.15, z: 0.15 }, [{ x: 0.95, z: 0.15 }, { x: 0.35, z: 0.15 }])).toEqual([null, expect.any(Number)]);
  });
});

describe('route start where the walker stands', () => {
  it('starts at the walker and the first leg does not cut furniture corners', () => {
    const block = ['..............', '..............', '..............', '.....####.....', '.....####.....',
      '.....####.....', '..............', '..............', '..............', '..............'];
    const p = new NavPlanner(gridFrom(block));
    const goals = [{ x: 0.15, z: 0.15 }, { x: 1.25, z: 0.85 }, { x: 0.65, z: 0.05 }, { x: 0.65, z: 0.75 }];
    let legs = 0, clipped = 0;
    for (let x = 0.01; x < 1.4; x += 0.023) {
      for (let z = 0.01; z < 1.0; z += 0.023) {
        if (!p.isWalkable(x, z)) continue;
        for (const goal of goals) {
          const path = p.findPath({ x, z }, goal);
          if (!path || path.points.length < 2) continue;
          expect(path.points[0]).toEqual({ x, z });
          const [a, b] = path.points;
          legs++;
          for (let u = 0; u <= 1; u += 0.01) {
            if (!p.isWalkable(a.x + (b.x - a.x) * u, a.z + (b.z - a.z) * u)) {
              clipped++;
              break;
            }
          }
        }
      }
    }
    // Swapping in the walker's spot without a check clipped about 3% of first legs; only hairline
    // touches on cell edges are left now
    expect(legs).toBeGreaterThan(5000);
    expect(clipped / legs).toBeLessThan(0.003);
  });
});

describe('searchPois with distances', () => {
  const pois = [
    makePoi('scn_aaaaaaaaaaaa', 'Bunk 1', 5, 0, { category: 'sleep' }),
    makePoi('scn_aaaaaaaaaaaa', 'Bunk 2', 1, 0, { category: 'sleep' }),
    makePoi('scn_aaaaaaaaaaaa', 'Door', 3, 0, { category: 'exit' }),
  ];
  const dist = (poi: { position: { x: number } }) => poi.position.x;

  it('puts the nearer place first when the text matches equally', () => {
    expect(searchPois(pois, 'sleep', 8, dist).map(h => h.poi.name)).toEqual(['Bunk 2', 'Bunk 1']);
    expect(searchPois(pois, 'sleep').map(h => h.poi.name)).toEqual(['Bunk 1', 'Bunk 2']);
  });

  it('lists the nearest places first for an empty query', () => {
    expect(searchPois(pois, '', 8, dist).map(h => h.poi.name)).toEqual(['Bunk 2', 'Door', 'Bunk 1']);
  });

  it('keeps a better text match ahead of a nearer place', () => {
    expect(searchPois(pois, 'bunk 1', 8, dist)[0].poi.name).toBe('Bunk 1');
  });
});
