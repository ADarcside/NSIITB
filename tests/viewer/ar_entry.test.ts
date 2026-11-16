/**
 * AR phase 5: the route card's link into AR, the printable QR links, and the offline worker's
 * rules (it handles only plain GETs, knows the AR page, and shares its store name with the page).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decode } from 'node:querystring';
import { arPlaceUrl, arUrlFromViewer, viewerUrlFromAr } from '../../viewer/src/ar/links.js';
import { AR_CACHE } from '../../viewer/src/ar/offline.js';

describe('AR entry links', () => {
  it('the AR button opens ar.html next to the viewer, going to the place', () => {
    expect(arUrlFromViewer('https://adarcside.github.io/namma-space/round2/?scene=scn_x&to=poi_1&from=poi_0', 'poi_1')).toBe(
      'https://adarcside.github.io/namma-space/round2/ar.html?scene=scn_x&to=poi_1'
    );
    expect(arUrlFromViewer('http://localhost:4173/index.html#a', 'poi_2')).toBe('http://localhost:4173/ar.html?to=poi_2');
    expect(arUrlFromViewer('https://h.example/site', 'p')).toBe('https://h.example/site/ar.html?to=p');
  });

  it('passes on the phone-test switches but not viewer-only ones', () => {
    const u = new URL(arUrlFromViewer('https://h.example/?scene=s&marks=1,2,3,4&debug=1&tag=1&rearrange=1&layout=off', 'p'));
    expect([...u.searchParams.keys()].sort()).toEqual(['debug', 'marks', 'scene', 'to']);
  });

  it('Exit from AR comes back to the same room and place', () => {
    const ar = arUrlFromViewer('https://h.example/round2/?scene=s', 'poi_7');
    expect(viewerUrlFromAr(ar)).toBe('https://h.example/round2/?scene=s&to=poi_7');
  });

  it('QR links keep only the room and the place', () => {
    const here = 'https://h.example/round2/ar.html?scene=s&qr=1&debug=1#x';
    expect(arPlaceUrl(here, 'poi_3')).toBe('https://h.example/round2/ar.html?scene=s&to=poi_3');
    expect(arPlaceUrl(here, null)).toBe('https://h.example/round2/ar.html?scene=s');
    expect(decode(new URL(arPlaceUrl('https://h.example/ar.html?qr=1', 'a b')).search.slice(1))).toEqual({ to: 'a b' });
  });
});

describe('AR offline worker', () => {
  const code = readFileSync(fileURLToPath(new URL('../../viewer/src/ar/ar_sw.js', import.meta.url)), 'utf8');
  const listeners: Record<string, unknown> = {};
  const self: Record<string, unknown> = { addEventListener: (t: string, f: unknown) => (listeners[t] = f) };
  new Function('self', code)(self);
  const sw = self.__nammaArSw as {
    CACHE: string;
    isArPage(u: string): boolean;
    handles(r: { method: string; url: string }): boolean;
  };

  it('uses the same store name as the page', () => {
    expect(sw.CACHE).toBe(AR_CACHE);
  });

  it('knows the AR page, and nothing else, as the AR page', () => {
    expect(sw.isArPage('https://h.example/round2/ar.html?to=x')).toBe(true);
    expect(sw.isArPage('https://h.example/round2/ar')).toBe(true);
    expect(sw.isArPage('https://h.example/round2/')).toBe(false);
    expect(sw.isArPage('https://h.example/round2/index.html')).toBe(false);
    expect(sw.isArPage('https://h.example/radar')).toBe(false);
  });

  it('handles plain GETs only', () => {
    expect(sw.handles({ method: 'GET', url: 'https://h.example/round2/assets/ar-1.js' })).toBe(true);
    expect(sw.handles({ method: 'POST', url: 'https://h.example/x' })).toBe(false);
    expect(sw.handles({ method: 'GET', url: 'chrome-extension://abc/x.js' })).toBe(false);
  });

  it('listens for install, activate and fetch', () => {
    expect(Object.keys(listeners).sort()).toEqual(['activate', 'fetch', 'install']);
  });
});
