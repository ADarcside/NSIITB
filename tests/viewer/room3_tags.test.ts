/**
 * Namma Space: the real Room 3 tags (sample/room3-capture) stay valid, search finds them, and a walkable route
 * exists between every pair of places on Room 3's own floor grid.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validatePoiSet, poiGoal } from '../../viewer/src/nav/pois.js';
import { searchPois } from '../../viewer/src/nav/search.js';
import { NavPlanner } from '../../viewer/src/nav/astar.js';
import type { NavGrid, PoiSet } from '../../viewer/src/contracts/types.js';

const read = (f: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../sample/room3-capture/scn_hostelroom3f/${f}`, import.meta.url)), 'utf8'));
const set = read('pois.json') as PoiSet;
const grid = read('grid.json') as NavGrid;
const top = (q: string) => searchPois(set.pois, q)[0]?.poi.name;

describe('Room 3 tags', () => {
  it('are a valid set with aliases on every tag', () => {
    expect(validatePoiSet(set)).toEqual([]);
    expect(set.pois.length).toBe(9);
    for (const p of set.pois) {
      expect(p.category, p.name).toBeTruthy();
      expect(p.aliases?.length ?? 0, p.name).toBeGreaterThanOrEqual(2);
    }
  });

  it('answer typo and alias searches', () => {
    expect(top('dor')).toBe('Door');
    expect(top('almirah')).toMatch(/^Cupboard/);
    expect(top('desk 2')).toBe('Desk 2');
    expect(searchPois(set.pois, 'sleep').slice(0, 2).map(h => h.poi.name).sort()).toEqual(['Bunk 1', 'Bunk 2']);
  });

  it('have a walkable route between every pair of places', () => {
    const planner = new NavPlanner(grid);
    let pairs = 0;
    for (const a of set.pois) {
      for (const b of set.pois) {
        if (a === b) continue;
        const path = planner.findPath(poiGoal(a), poiGoal(b));
        expect(path, `${a.name} -> ${b.name}`).not.toBeNull();
        const pts = path!.points;
        for (const p of pts.slice(1)) expect(planner.isWalkable(p.x, p.z), `${a.name} -> ${b.name}`).toBe(true);
        pairs++;
      }
    }
    expect(pairs).toBe(72);
  });
});
