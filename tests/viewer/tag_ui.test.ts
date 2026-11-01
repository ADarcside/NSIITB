import { describe, it, expect, beforeEach } from 'vitest';
import { PoiDraftStore, makePoi, makePoiSet, validatePoiSet, POI_CATEGORIES } from '../../viewer/src/nav/pois.js';
import { isTypingTarget } from '../../viewer/src/ui/app_ui.js';

describe('PoiDraftStore and Tag Mode Logic', () => {
  const sceneId = 'scn_testroomaa34';
  let storageMap: Map<string, string>;

  beforeEach(() => {
    storageMap = new Map<string, string>();
    const mockStorage = {
      getItem: (k: string) => storageMap.get(k) ?? null,
      setItem: (k: string, v: string) => storageMap.set(k, String(v)),
      removeItem: (k: string) => storageMap.delete(k),
      clear: () => storageMap.clear(),
      get length() {
        return storageMap.size;
      },
      key: (i: number) => Array.from(storageMap.keys())[i] ?? null,
    };
    Object.defineProperty(globalThis, 'localStorage', {
      value: mockStorage,
      writable: true,
      configurable: true,
    });
  });

  it('saves and loads a valid POI draft from localStorage', () => {
    const store = new PoiDraftStore(sceneId);
    expect(store.load()).toBeNull();

    const p1 = makePoi(sceneId, 'Desk', 1.25, 2.75, { category: 'furniture', aliases: ['table'] });
    const p2 = makePoi(sceneId, 'Exit', -0.5, 3.0, { category: 'exit' });

    store.save([p1, p2]);

    const loaded = store.load();
    expect(loaded).not.toBeNull();
    expect(loaded?.length).toBe(2);
    expect(loaded?.[0].name).toBe('Desk');
    expect(loaded?.[0].category).toBe('furniture');
    expect(loaded?.[0].aliases).toEqual(['table']);
    expect(loaded?.[1].name).toBe('Exit');
  });

  it('clears the draft from localStorage', () => {
    const store = new PoiDraftStore(sceneId);
    const p1 = makePoi(sceneId, 'Desk', 1.0, 2.0);
    store.save([p1]);
    expect(store.load()).toHaveLength(1);

    store.clear();
    expect(store.load()).toBeNull();
  });

  it('rejects corrupted JSON in localStorage draft gracefully', () => {
    const store = new PoiDraftStore(sceneId);
    storageMap.set(`namma-pois-draft:${sceneId}`, '{ corrupt json ...');
    expect(store.load()).toBeNull();
  });

  it('rejects invalid schema in draft', () => {
    const store = new PoiDraftStore(sceneId);
    storageMap.set(
      `namma-pois-draft:${sceneId}`,
      JSON.stringify({ schema_version: 2, scene_id: sceneId, pois: [] })
    );
    expect(store.load()).toBeNull();
  });

  it('makePoi sets RFC base32 poi_id, correct coordinates and categories', () => {
    const poi = makePoi(sceneId, '  Study Table  ', 1.23456, 4.56789, {
      category: 'furniture',
      aliases: ['desk', 'workplace'],
      yaw_deg: 90.2,
    });

    expect(poi.poi_id).toMatch(/^poi_[a-z2-7]{12}$/);
    expect(poi.name).toBe('Study Table');
    expect(poi.category).toBe('furniture');
    expect(poi.position.x).toBe(1.235);
    expect(poi.position.y).toBe(1.2);
    expect(poi.position.z).toBe(4.568);
    expect(poi.yaw_deg).toBe(90);
    expect(poi.aliases).toEqual(['desk', 'workplace']);

    const poiSet = makePoiSet(sceneId, [poi]);
    expect(validatePoiSet(poiSet)).toHaveLength(0);
  });

  it('contains expected categories in POI_CATEGORIES', () => {
    expect(POI_CATEGORIES).toContain('room');
    expect(POI_CATEGORIES).toContain('furniture');
    expect(POI_CATEGORIES).toContain('exit');
    expect(POI_CATEGORIES).toContain('facility');
    expect(POI_CATEGORIES).toContain('item');
    expect(POI_CATEGORIES).toContain('other');
  });

  it('isTypingTarget returns true for text inputs and select elements', () => {
    expect(isTypingTarget({ target: { tagName: 'INPUT' } } as unknown as KeyboardEvent)).toBe(true);
    expect(isTypingTarget({ target: { tagName: 'select' } } as unknown as KeyboardEvent)).toBe(true);
    expect(isTypingTarget({ target: { tagName: 'textarea' } } as unknown as KeyboardEvent)).toBe(true);
    expect(isTypingTarget({ target: { tagName: 'div' } } as unknown as KeyboardEvent)).toBe(false);
  });
});
