/**
 * Namma Space AR: state machine (AR build spec, "Screens and states"). Every transition in the
 * table, and nothing else.
 */

import { describe, it, expect } from 'vitest';
import {
  ArMachine,
  IN_SESSION,
  TRANSITIONS,
  classifySupport,
  nextState,
  type ArEvent,
  type ArState,
} from '../../viewer/src/ar/ar_state.js';

const STATES: ArState[] = [
  'check',
  'unsupported',
  'ready',
  'find-floor',
  'align-a',
  'align-b',
  'confirm',
  'navigate',
  'tracking-lost',
  'arrived',
];
const EVENTS: ArEvent[] = [
  'supported',
  'unsupported',
  'session-started',
  'floor-steady',
  'tap-a',
  'tap-b-ok',
  'tap-b-bad',
  'use-anyway',
  'confirm-yes',
  'redo',
  'arrive',
  'tracking-lost',
  'tracking-back',
  'realign',
  'new-destination',
  'session-ended',
];

/** The spec's table, written out by hand so a change to TRANSITIONS has to change this too */
const EXPECTED: Array<[ArState, ArEvent, ArState]> = [
  ['check', 'supported', 'ready'],
  ['check', 'unsupported', 'unsupported'],
  ['ready', 'session-started', 'find-floor'],
  ['find-floor', 'floor-steady', 'align-a'],
  ['align-a', 'tap-a', 'align-b'],
  ['align-b', 'tap-b-ok', 'confirm'],
  ['align-b', 'tap-b-bad', 'align-a'],
  ['align-a', 'use-anyway', 'confirm'],
  ['confirm', 'confirm-yes', 'navigate'],
  ['confirm', 'redo', 'align-a'],
  ['navigate', 'arrive', 'arrived'],
  ['navigate', 'tracking-lost', 'tracking-lost'],
  ['navigate', 'realign', 'align-a'],
  ['tracking-lost', 'tracking-back', 'navigate'],
  ['tracking-lost', 'realign', 'align-a'],
  ['arrived', 'new-destination', 'navigate'],
  // The camera session can end in any camera state (Exit, Android back button): back to Ready
  ['find-floor', 'session-ended', 'ready'],
  ['align-a', 'session-ended', 'ready'],
  ['align-b', 'session-ended', 'ready'],
  ['confirm', 'session-ended', 'ready'],
  ['navigate', 'session-ended', 'ready'],
  ['tracking-lost', 'session-ended', 'ready'],
  ['arrived', 'session-ended', 'ready'],
];

describe('AR state machine', () => {
  it('allows exactly the transitions in the spec table', () => {
    for (const s of STATES) {
      for (const e of EVENTS) {
        const want = EXPECTED.find(([from, ev]) => from === s && ev === e)?.[2] ?? null;
        expect(nextState(s, e), `${s} + ${e}`).toBe(want);
      }
    }
    const count = Object.values(TRANSITIONS).reduce((n, m) => n + Object.keys(m).length, 0);
    expect(count).toBe(EXPECTED.length);
  });

  it('starts in check, ignores events that are not allowed, and reports real changes', () => {
    const m = new ArMachine();
    const seen: string[] = [];
    m.onChange((s, prev, e) => seen.push(`${prev}>${s}:${e}`));
    expect(m.state).toBe('check');
    expect(m.send('floor-steady')).toBe(false);
    expect(m.send('supported')).toBe(true);
    expect(m.send('session-started')).toBe(true);
    expect(m.send('session-started')).toBe(false);
    expect(m.send('floor-steady')).toBe(true);
    expect(m.send('session-ended')).toBe(true);
    expect(m.state).toBe('ready');
    expect(seen).toEqual([
      'check>ready:supported',
      'ready>find-floor:session-started',
      'find-floor>align-a:floor-steady',
      'align-a>ready:session-ended',
    ]);
  });

  it('cannot leave Unsupported', () => {
    const m = new ArMachine();
    m.send('unsupported');
    for (const e of EVENTS) expect(m.send(e)).toBe(false);
    expect(m.state).toBe('unsupported');
  });

  it('marks only the camera states as in session', () => {
    for (const s of STATES) {
      expect(IN_SESSION.has(s), s).toBe(!['check', 'unsupported', 'ready'].includes(s));
    }
  });
});

describe('AR support check', () => {
  it('tells apart an insecure page, no WebXR, no AR, and OK', () => {
    expect(classifySupport({ secure: false, hasXr: false, arSupported: false })).toBe('insecure');
    expect(classifySupport({ secure: true, hasXr: false, arSupported: false })).toBe('no-webxr');
    expect(classifySupport({ secure: true, hasXr: true, arSupported: false })).toBe('no-ar');
    expect(classifySupport({ secure: true, hasXr: true, arSupported: true })).toBe('ok');
  });
});
