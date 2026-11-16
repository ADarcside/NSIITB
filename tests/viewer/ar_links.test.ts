/**
 * Namma Space AR: links between ar.html and the normal viewer, and the phrase tables
 */

import { describe, it, expect } from 'vitest';
import { arTarget, viewerUrlFromAr } from '../../viewer/src/ar/links.js';
import { PHRASES, phrase } from '../../viewer/src/ar/phrases.js';

describe('AR links', () => {
  it('Exit goes to the viewer next to ar.html with the same room and place', () => {
    expect(viewerUrlFromAr('https://adarcside.github.io/namma-space/round2/ar.html?scene=scn_x&to=poi_1')).toBe(
      'https://adarcside.github.io/namma-space/round2/?scene=scn_x&to=poi_1'
    );
    expect(viewerUrlFromAr('http://localhost:5173/ar.html')).toBe('http://localhost:5173/');
    expect(viewerUrlFromAr('https://h.example/site/ar?to=Bunk%201#x')).toBe('https://h.example/site/?to=Bunk+1');
  });

  it('drops AR-only and session switches, keeps from', () => {
    const u = new URL(viewerUrlFromAr('https://h.example/ar.html?scene=s&from=a&to=b&tag=1&room=r&debug=1'));
    expect([...u.searchParams.keys()].sort()).toEqual(['from', 'scene', 'to']);
  });

  it('does not rewrite a path that only ends in "ar"', () => {
    expect(viewerUrlFromAr('https://h.example/radar/index.html?scene=s')).toBe('https://h.example/radar/index.html?scene=s');
  });

  it('reads the target place', () => {
    expect(arTarget('https://h.example/ar.html?to=%20poi_9%20')).toBe('poi_9');
    expect(arTarget('https://h.example/ar.html?to=')).toBeNull();
    expect(arTarget('https://h.example/ar.html')).toBeNull();
  });
});

describe('AR phrases', () => {
  it('has every English line in Hindi, with the same placeholders', () => {
    const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const key of Object.keys(PHRASES.en) as Array<keyof typeof PHRASES.en>) {
      expect(PHRASES.hi[key], key).toBeTruthy();
      expect(holes(PHRASES.hi[key]), key).toEqual(holes(PHRASES.en[key]));
    }
  });

  it('fills placeholders and leaves unknown ones visible', () => {
    expect(phrase('en', 'heightAbove', { m: '1.30' })).toBe('Phone is 1.30 m above the ring');
    expect(phrase('hi', 'readyTitleTo', { place: 'Bunk 1' })).toBe('Bunk 1 तक AR गाइड');
    expect(phrase('en', 'readyTitleTo')).toBe('AR guide to {place}');
  });
});
