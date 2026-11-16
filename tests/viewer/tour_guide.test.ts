/**
 * Voice guide cue picker (viewer/src/nav/tour_guide.ts): the plan's line table and drift rules,
 * on made-up routes walked with a fake clock, with and without 1 m of jitter.
 */
import { describe, it, expect } from 'vitest';
import type { Point2 } from '../../viewer/src/nav/astar.js';
import { TourGuide, QUIET_MS, type Cue } from '../../viewer/src/nav/tour_guide.js';
import { isOffRoute, viewerInput } from '../../viewer/src/nav/voice_guide.js';
import { GUIDE_PHRASES, spokenMetres, walkTimePhrase } from '../../viewer/src/nav/guide_phrases.js';
import { pointAlong, projectOnRoute } from '../../viewer/src/nav/route_follower.js';

/** Walk -Z for 10 m, then a right turn (+X) for 8 m */
const L_ROUTE: Point2[] = [
  { x: 0, z: 0 },
  { x: 0, z: -10 },
  { x: 8, z: -10 },
];

/** Small seeded random numbers, so the jitter test is the same every run */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

interface Said {
  t: number;
  cue: Cue;
}

/**
 * Walks `route` at 1.2 m/s in 100 ms steps, the walker's reported position shifted by up to
 * `jitterM` each frame, and returns every line the guide chose.
 */
function walk(route: Point2[], jitterM = 0, seed = 1): Said[] {
  const g = new TourGuide('en');
  const rand = rng(seed);
  const said: Said[] = [];
  const at = (d: number): Point2 => {
    const p = pointAlong(route, projectOnRoute(route, route[0]), d);
    return { x: p.x + (rand() * 2 - 1) * jitterM, z: p.z + (rand() * 2 - 1) * jitterM };
  };
  const total = projectOnRoute(route, route[0]).remainingM;
  said.push({ t: 0, cue: g.start(0, 'Desk', viewerInput(route, route[0], 0, false, false)) });
  for (let t = 100, d = 0.12; d < total; t += 100, d += 0.12) {
    const p = at(d);
    const input = viewerInput(route, p, 0, false, false);
    const remaining = total - d;
    const cue = remaining < 0.6 ? g.arrive(t) : g.update(t, input);
    if (cue) said.push({ t, cue });
    if (g.hasArrived) break;
  }
  return said;
}

describe('tour guide: a clean walk', () => {
  const said = walk(L_ROUTE);
  const texts = said.map(s => s.cue.text);

  it('starts with the place, length and time', () => {
    expect(texts[0]).toBe('Going to Desk. 20 metres, about 15 seconds.');
  });

  it('says the corner coming once, then turn now once, on the right side', () => {
    expect(texts.filter(t => /^In \d+ metres, turn right\.$/.test(t))).toHaveLength(1);
    expect(texts.filter(t => t === 'Turn right.')).toHaveLength(1);
    expect(texts.some(t => /left/i.test(t))).toBe(false);
    expect(texts.indexOf('Turn right.')).toBeGreaterThan(texts.findIndex(t => t.startsWith('In ')));
  });

  it('says distance marks below the starting length, and arrives once', () => {
    expect(texts).toContain('5 metres to go.');
    expect(texts.some(t => t.startsWith('20 metres to go'))).toBe(false);
    expect(texts.filter(t => t.startsWith('You have arrived'))).toEqual(['You have arrived at Desk.']);
    expect(said[said.length - 1].cue.kind).toBe('arrived');
  });

  it('never names places it passes and never speaks a distance under 2 m', () => {
    for (const t of texts) {
      expect(t).not.toMatch(/passing/i);
      for (const m of t.matchAll(/(\d+) metres/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(2);
    }
  });

  it('keeps 3 s of quiet between lines except arrival and turn now', () => {
    for (let i = 1; i < said.length; i++) {
      const k = said[i].cue.kind;
      if (k === 'arrived' || k === 'turnNow') continue;
      expect(said[i].t - said[i - 1].t).toBeGreaterThanOrEqual(QUIET_MS);
    }
  });
});

describe('tour guide: 1 m of jitter', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    it(`each corner is spoken at most once in each form (seed ${seed})`, () => {
      const texts = walk(L_ROUTE, 1, seed).map(s => s.cue.text);
      expect(texts.filter(t => t === 'Turn right.').length).toBeLessThanOrEqual(1);
      expect(texts.filter(t => t === 'Turn left.').length).toBeLessThanOrEqual(1);
      expect(texts.filter(t => t.startsWith('In ')).length).toBeLessThanOrEqual(1);
      expect(texts.filter(t => t.startsWith('You have arrived'))).toHaveLength(1);
      for (const t of texts) for (const m of t.matchAll(/(\d+) metres/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(2);
    });
  }
});

describe('tour guide: other lines', () => {
  it('a route under 2 m just says it is here', () => {
    const g = new TourGuide('en');
    const r = [{ x: 0, z: 0 }, { x: 0, z: -1.5 }];
    expect(g.start(0, 'Bed', viewerInput(r, r[0], 0, false, false)).text).toBe('Going to Bed. It is just here.');
  });

  it('folds a near first corner into the start line and does not repeat it', () => {
    const g = new TourGuide('en');
    const r = [{ x: 0, z: 0 }, { x: 0, z: -2 }, { x: -6, z: -2 }];
    const cue = g.start(0, 'Door', viewerInput(r, r[0], 0, false, false));
    expect(cue.text).toBe('Going to Door. 8 metres, about 5 seconds. Turn left.');
    expect(g.update(4000, viewerInput(r, { x: 0, z: -1 }, 0, false, false))).toBeNull();
  });

  it('turn around waits 1.5 s facing away while moving, then repeats at most every 8 s', () => {
    const g = new TourGuide('en');
    const r = [{ x: 0, z: 0 }, { x: 0, z: -30 }];
    g.start(0, 'Hall', viewerInput(r, r[0], 0, false, false));
    // yaw = PI looks down +Z, away from the route
    const away = () => viewerInput(r, { x: 0, z: -1 }, Math.PI, true, false);
    const kinds: Array<[number, string]> = [];
    for (let t = 3100; t <= 20000; t += 100) {
      const c = g.update(t, away());
      if (c) kinds.push([t, c.kind]);
    }
    expect(kinds[0]).toEqual([4600, 'turnAround']);
    expect(kinds.map(k => k[1]).every(k => k === 'turnAround')).toBe(true);
    for (let i = 1; i < kinds.length; i++) expect(kinds[i][0] - kinds[i - 1][0]).toBeGreaterThanOrEqual(8000);
    // Standing still and looking back never counts
    const g2 = new TourGuide('en');
    g2.start(0, 'Hall', viewerInput(r, r[0], 0, false, false));
    for (let t = 3100; t <= 20000; t += 100) expect(g2.update(t, viewerInput(r, { x: 0, z: -1 }, Math.PI, false, false))).toBeNull();
  });

  it('a new route is announced only when it changes the next step', () => {
    const g = new TourGuide('en');
    const a = [{ x: 0, z: 0 }, { x: 0, z: -20 }, { x: 10, z: -20 }];
    g.start(0, 'Lab', viewerInput(a, a[0], 0, false, false));
    // Same corner after the re-route: nothing
    expect(g.update(5000, viewerInput(a, { x: 0.2, z: -1 }, 0, false, true))).toBeNull();
    // Different corner and side
    const b = [{ x: 0, z: -1 }, { x: 0, z: -14 }, { x: -10, z: -14 }];
    expect(g.update(10000, viewerInput(b, b[0], 0, false, true))?.kind).toBe('newRoute');
  });

  it('says "Hold on" once when AR loses the room, stays quiet, then carries on', () => {
    const g = new TourGuide('en');
    g.start(0, 'Lab', viewerInput(L_ROUTE, L_ROUTE[0], 0, false, false));
    expect(g.trackingLost(4000)?.text).toBe('Hold on, finding the room again.');
    expect(g.trackingLost(4100)).toBeNull();
    expect(g.update(9000, viewerInput(L_ROUTE, { x: 0, z: -4.5 }, 0, false, false))).toBeNull();
    g.trackingBack();
    expect(g.update(9100, viewerInput(L_ROUTE, { x: 0, z: -4.5 }, 0, false, false))?.kind).toBe('turnComing');
  });

  it('arrival is said once and the guide is silent after', () => {
    const g = new TourGuide('en');
    g.start(0, 'Lab', viewerInput(L_ROUTE, L_ROUTE[0], 0, false, false));
    expect(g.arrive(100)?.priority).toBe(1);
    expect(g.arrive(200)).toBeNull();
    expect(g.update(9000, viewerInput(L_ROUTE, { x: 0, z: -9 }, 0, false, false))).toBeNull();
  });

  it('the live line gives the next turn and the length left', () => {
    const g = new TourGuide('en');
    const input = viewerInput(L_ROUTE, { x: 0, z: -4 }, 0, false, false);
    g.start(0, 'Lab', input);
    expect(g.line(input, 100)).toEqual({ instruction: 'In 6 m, turn right', left: '14 m to go · about 10 s' });
    const near = viewerInput(L_ROUTE, { x: 0, z: -8.5 }, 0, false, false);
    expect(g.line(near, 200).instruction).toBe('Turn right now');
    const last = viewerInput(L_ROUTE, { x: 4, z: -10 }, 0, false, false);
    expect(g.line(last, 300)).toEqual({ instruction: null, left: '4.0 m to go · about 5 s' });
  });

  it('speaks Hindi when switched', () => {
    const g = new TourGuide('hi');
    const cue = g.start(0, 'Desk', viewerInput(L_ROUTE, L_ROUTE[0], 0, false, false));
    expect(cue.text).toBe('Desk की ओर चलें। 20 मीटर, लगभग 15 सेकंड।');
    expect(g.update(7000, viewerInput(L_ROUTE, { x: 0, z: -9 }, 0, false, false))?.text).toBe('दाएँ मुड़ें।');
  });
});

describe('guide phrases and helpers', () => {
  it('English and Hindi have the same lines, none empty', () => {
    expect(Object.keys(GUIDE_PHRASES.hi).sort()).toEqual(Object.keys(GUIDE_PHRASES.en).sort());
    for (const lang of ['en', 'hi'] as const) for (const v of Object.values(GUIDE_PHRASES[lang])) expect(v.trim()).not.toBe('');
  });

  it('rounds spoken distances: nearest metre under 10, nearest 5 above', () => {
    expect([2.4, 6.6, 9.4, 11, 13, 22.4].map(spokenMetres)).toEqual([2, 7, 9, 10, 15, 20]);
  });

  it('times', () => {
    expect(walkTimePhrase('en', 3, true)).toBe('about 5 seconds');
    expect(walkTimePhrase('en', 80, true)).toBe('about 1 minute');
    expect(walkTimePhrase('en', 300, false)).toBe('about 4 min');
  });

  it('off-route check for re-routes in the viewer', () => {
    expect(isOffRoute(L_ROUTE, { x: 0.5, z: -3 })).toBe(false);
    expect(isOffRoute(L_ROUTE, { x: 2, z: -3 })).toBe(true);
    expect(isOffRoute(null, { x: 2, z: -3 })).toBe(false);
  });
});
