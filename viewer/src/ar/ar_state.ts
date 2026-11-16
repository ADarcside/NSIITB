/**
 * Namma Space AR: the AR page's state machine (AR build spec, "Screens and states").
 *
 * Each state has one job and fixed exits, so the page can never sit in a mixed state. This module
 * is pure (no camera, no drawing) and every transition is unit tested in tests/viewer/ar_state.test.ts.
 *
 * Phase 1 uses check -> unsupported | ready -> find-floor -> align-a. The later states are listed
 * now so the table stays in one place as the phases land.
 */

export type ArState =
  | 'check'
  | 'unsupported'
  | 'ready'
  | 'find-floor'
  | 'align-a'
  | 'align-b'
  | 'confirm'
  | 'navigate'
  | 'tracking-lost'
  | 'arrived';

export type ArEvent =
  /** Support check finished: this phone can run AR */
  | 'supported'
  /** Support check finished: it cannot */
  | 'unsupported'
  /** Start AR tapped and the camera session is running */
  | 'session-started'
  /** The floor ring has been steady for a moment (floor.ts STEADY_MS) */
  | 'floor-steady'
  /** Tap on cross A */
  | 'tap-a'
  /** Tap on cross B and the distance check passed */
  | 'tap-b-ok'
  /** Tap on cross B and the distance check failed (back to A with the reason) */
  | 'tap-b-bad'
  /** After a distance miss, keep the two taps anyway (the marks' tags are slightly off) */
  | 'use-anyway'
  /** "Do the pins sit in the right spots?" Yes */
  | 'confirm-yes'
  /** Redo the two taps */
  | 'redo'
  | 'arrive'
  | 'tracking-lost'
  | 'tracking-back'
  | 'realign'
  /** Another place picked after arriving */
  | 'new-destination'
  /** The camera session ended (Exit, the Android back button, or the browser closed it) */
  | 'session-ended';

/** States in which the camera session is running */
export const IN_SESSION: ReadonlySet<ArState> = new Set<ArState>([
  'find-floor',
  'align-a',
  'align-b',
  'confirm',
  'navigate',
  'tracking-lost',
  'arrived',
]);

/** Every allowed transition: state -> event -> next state. Anything not listed is ignored. */
export const TRANSITIONS: Readonly<Record<ArState, Partial<Record<ArEvent, ArState>>>> = {
  check: { supported: 'ready', unsupported: 'unsupported' },
  unsupported: {},
  ready: { 'session-started': 'find-floor' },
  'find-floor': { 'floor-steady': 'align-a', 'session-ended': 'ready' },
  'align-a': { 'tap-a': 'align-b', 'use-anyway': 'confirm', 'session-ended': 'ready' },
  'align-b': { 'tap-b-ok': 'confirm', 'tap-b-bad': 'align-a', 'session-ended': 'ready' },
  confirm: { 'confirm-yes': 'navigate', redo: 'align-a', 'session-ended': 'ready' },
  navigate: { arrive: 'arrived', 'tracking-lost': 'tracking-lost', realign: 'align-a', 'session-ended': 'ready' },
  'tracking-lost': { 'tracking-back': 'navigate', realign: 'align-a', 'session-ended': 'ready' },
  arrived: { 'new-destination': 'navigate', 'session-ended': 'ready' },
};

/** Next state for `event`, or null when the event is not allowed in `state` (the caller ignores it). */
export function nextState(state: ArState, event: ArEvent): ArState | null {
  return TRANSITIONS[state][event] ?? null;
}

type Listener = (state: ArState, prev: ArState, event: ArEvent) => void;

/** Holds the current state and tells listeners about every real change. */
export class ArMachine {
  private _state: ArState = 'check';
  private readonly _listeners = new Set<Listener>();

  get state(): ArState {
    return this._state;
  }

  /** Applies `event`; returns true when the state changed, false when the event was ignored. */
  send(event: ArEvent): boolean {
    const next = nextState(this._state, event);
    if (next === null) return false;
    const prev = this._state;
    this._state = next;
    for (const cb of this._listeners) cb(next, prev, event);
    return true;
  }

  onChange(cb: Listener): () => void {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }
}

/** Why this phone cannot run AR, or 'ok' */
export type SupportResult = 'ok' | 'insecure' | 'no-webxr' | 'no-ar';

/**
 * Support check outcome from what the browser reports. WebXR only exists on secure pages (https or
 * localhost), so a missing navigator.xr on a plain http page is reported as 'insecure', which has a
 * different fix from a browser that has no WebXR at all.
 */
export function classifySupport(env: { secure: boolean; hasXr: boolean; arSupported: boolean }): SupportResult {
  if (!env.secure) return 'insecure';
  if (!env.hasXr) return 'no-webxr';
  return env.arSupported ? 'ok' : 'no-ar';
}
