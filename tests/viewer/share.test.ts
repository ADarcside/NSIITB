/**
 * Namma Space: share links (?to= / ?from=), walking time and the active-route slot
 */

import { describe, it, expect } from 'vitest';
import { shareUrl, resolvePoiRef } from '../../viewer/src/nav/share.js';
import { walkTime } from '../../viewer/src/ui/nav_ui.js';
import { qrSvg } from '../../viewer/src/ui/share_ui.js';
import { RouteBus } from '../../viewer/src/nav/active_route.js';
import { makePoi } from '../../viewer/src/nav/pois.js';
import { encode } from 'uqr';

const SCENE = 'scn_hostelroomac';
const door = makePoi(SCENE, 'Main door', 0, 0, { aliases: ['Entrance'] });
const mr4 = makePoi(SCENE, 'Meeting Room 4', 5, 2);
const mr14 = makePoi(SCENE, 'Meeting Room 14', 9, 2);
const pois = [door, mr4, mr14];

describe('share links', () => {
  it('links to the place by id and drops session-only switches', () => {
    const url = new URL(shareUrl('https://x.github.io/namma-space/round2/?scene=scn_hostelroomac&tag=1&room=K7QX2M&quality=full#a', mr4));
    expect(url.pathname).toBe('/namma-space/round2/');
    expect(url.searchParams.get('scene')).toBe(SCENE);
    expect(url.searchParams.get('to')).toBe(mr4.poi_id);
    for (const p of ['tag', 'room', 'quality', 'from']) expect(url.searchParams.has(p)).toBe(false);
    expect(url.hash).toBe('');
  });

  it('carries the start place when the route is from somewhere else', () => {
    const url = new URL(shareUrl('https://x.github.io/r/?to=old', mr4, door));
    expect(url.searchParams.get('from')).toBe(door.poi_id);
    expect(url.searchParams.get('to')).toBe(mr4.poi_id);
  });

  it('resolves ids, typed names, aliases and confident typos, never "4" for "14"', () => {
    expect(resolvePoiRef(pois, mr4.poi_id)).toBe(mr4);
    expect(resolvePoiRef(pois, 'meeting room 4')).toBe(mr4);
    expect(resolvePoiRef(pois, 'Meeting Room 14')).toBe(mr14);
    expect(resolvePoiRef(pois, 'entrance')).toBe(door);
    expect(resolvePoiRef(pois, 'meting room 4')).toBe(mr4);
    expect(resolvePoiRef(pois, 'cafeteria')).toBeNull();
    expect(resolvePoiRef(pois, '')).toBeNull();
    expect(resolvePoiRef(pois, null)).toBeNull();
  });

  it('draws a scannable QR code as one dark path on white', () => {
    const url = shareUrl('https://x.github.io/r/', mr4);
    const qr = encode(url, { ecc: 'M', border: 0 });
    const svg = qrSvg(url, qr.data);
    expect(svg).toContain(`viewBox="0 0 ${qr.size} ${qr.size}"`);
    expect(svg.match(/h1v1h-1z/g)!.length).toBe(qr.data.flat().filter(Boolean).length);
  });
});

describe('walking time', () => {
  it('rounds to 5 s under a minute, then to minutes', () => {
    expect(walkTime(1)).toBe('about 5 s');
    expect(walkTime(12)).toBe('about 10 s');
    expect(walkTime(30)).toBe('about 25 s');
    expect(walkTime(120)).toBe('about 2 min');
  });
});

describe('active route (AR slot)', () => {
  it('tells subscribers the current route at once and on every change', () => {
    const bus = new RouteBus();
    const seen: (string | null)[] = [];
    const off = bus.subscribe(r => seen.push(r ? r.to.name : null));
    bus.set({ to: mr4, from: null, points: [{ x: 0, z: 0 }, { x: 5, z: 2 }], lengthM: 5.4 });
    bus.set(null);
    off();
    bus.set({ to: door, from: null, points: null, lengthM: null });
    expect(seen).toEqual([null, 'Meeting Room 4', null]);
    expect(bus.current?.to).toBe(door);
  });
});
