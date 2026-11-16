/**
 * Namma Space AR: floor marks in the tag data
 */

import { describe, it, expect } from 'vitest';
import { findMarkPairs, isFloorMark, marksFromParam, visiblePlaces } from '../../viewer/src/ar/marks.js';
import { searchPois } from '../../viewer/src/nav/search.js';
import type { POI } from '../../viewer/src/contracts/types.js';
import k720 from '../../sample/test-capture/pois.json';

function tag(name: string, x: number, z: number, category = 'other'): POI {
  return { schema_version: 1, poi_id: `poi_${name.replace(/\W/g, '')}`, scene_id: 's', name, category, position: { x, y: 0.1, z } };
}

describe('AR floor marks', () => {
  it('finds marks by name (any case and spacing) or the anchor category', () => {
    expect(isFloorMark(tag('Mark 1A', 0, 0))).toBe(true);
    expect(isFloorMark(tag('mark2b', 0, 0))).toBe(true);
    expect(isFloorMark(tag('Floor X', 0, 0, 'anchor'))).toBe(true);
    expect(isFloorMark(tag('Bookmark 1A shelf', 0, 0))).toBe(false);
    expect(isFloorMark(tag('Bunk 1', 0, 0))).toBe(false);
  });

  it('pairs marks by number, lowest first', () => {
    const { pairs, problems } = findMarkPairs([
      tag('Mark 2B', 5, 2),
      tag('Bunk 1', 1, 1),
      tag('Mark 1A', 0, 0),
      tag('Mark 2A', 5, 0),
      tag('Mark 1B', 2, 0),
    ]);
    expect(problems).toEqual([]);
    expect(pairs.map(p => p.n)).toEqual([1, 2]);
    expect(pairs[0]).toMatchObject({ labelA: '1A', labelB: '1B', a: { x: 0, z: 0 }, b: { x: 2, z: 0 }, distanceM: 2 });
  });

  it('says clearly when marks are missing or broken', () => {
    expect(findMarkPairs([tag('Bunk 1', 1, 1)])).toEqual({ pairs: [], problems: [] });
    const r = findMarkPairs([tag('Mark 1A', 0, 0), tag('Mark 3A', 0, 0), tag('Mark 3A', 1, 0), tag('Mark 3B', 3, 0)]);
    expect(r.pairs).toEqual([]);
    expect(r.problems).toEqual(['Mark 1A has no Mark 1B', 'More than one tag is named Mark 3A']);
    expect(findMarkPairs([tag('Mark 1A', 0, 0), tag('Mark 1B', 0.2, 0)]).problems[0]).toMatch(/only 0.20 m apart/);
  });

  it('keeps marks out of what visitors see and search', () => {
    const pois = [tag('Bunk 1', 1, 1, 'sleep'), tag('Mark 1A', 0, 0), tag('Mark 1B', 2, 0)];
    const visible = visiblePlaces(pois);
    expect(visible.map(p => p.name)).toEqual(['Bunk 1']);
    expect(searchPois(visible, 'mark').length).toBe(0);
    // No marks: the same array comes back untouched
    const plain = [tag('Bunk 1', 1, 1, 'sleep'), tag('Window', 2, 2, 'utility')];
    expect(visiblePlaces(plain)).toBe(plain);
    // The real K-720 tags (with or without saved marks): no mark ever reaches visitors
    const k = visiblePlaces((k720 as { pois: POI[] }).pois);
    expect(k.some(isFloorMark)).toBe(false);
    expect(k.length).toBeGreaterThanOrEqual(10);
  });

  it('reads test marks from a link', () => {
    expect(marksFromParam('1,2,3,2')).toMatchObject({ a: { x: 1, z: 2 }, b: { x: 3, z: 2 }, distanceM: 2 });
    expect(marksFromParam('1,2,3')).toBeNull();
    expect(marksFromParam('a,b,c,d')).toBeNull();
    expect(marksFromParam(null)).toBeNull();
  });
});
