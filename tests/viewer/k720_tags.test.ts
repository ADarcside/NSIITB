/**
 * Namma Space: the real K-720 tags (sample/test-capture/pois.json) stay valid and the README's search examples keep working
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validatePoiSet, POI_CATEGORIES } from '../../viewer/src/nav/pois.js';
import { searchPois } from '../../viewer/src/nav/search.js';
import type { PoiSet } from '../../viewer/src/contracts/types.js';

const set = JSON.parse(readFileSync(fileURLToPath(new URL('../../sample/test-capture/pois.json', import.meta.url)), 'utf8')) as PoiSet;
const top = (q: string) => searchPois(set.pois, q)[0]?.poi.name;

describe('K-720 tags', () => {
  it('are a valid set with known categories and aliases on every tag', () => {
    expect(validatePoiSet(set)).toEqual([]);
    for (const p of set.pois) {
      expect(POI_CATEGORIES).toContain(p.category);
      expect(p.aliases?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });

  it('answer the README search examples', () => {
    expect(top('almirah')).toMatch(/^Cupboard/);
    expect(top('dor')).toBe('Front door');
    expect(top('table 4')).toBe('Tables 4 & 5');
    expect(searchPois(set.pois, 'sleep').slice(0, 3).map(h => h.poi.name).sort()).toEqual(['Bunk 1', 'Bunk 2', 'Bunk 3']);
  });
});
