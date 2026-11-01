/**
 * Namma Space: Round 2 path planner and POI search tests
 */

import { describe, it, expect } from 'vitest';
import { NavPlanner } from '../../viewer/src/nav/astar.js';
import { searchPois } from '../../viewer/src/nav/search.js';
import { makePoi, validatePoiSet, makePoiSet } from '../../viewer/src/nav/pois.js';
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
