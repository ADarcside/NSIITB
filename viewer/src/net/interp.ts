/**
 * Namma Space multiplayer: smoothing for remote players.
 * Poses arrive about 10 times a second; each remote avatar is drawn INTERP_DELAY_MS in the past
 * and interpolated between the two snapshots around that time, so motion looks fluid even when
 * packets arrive unevenly. Past the newest snapshot it extrapolates briefly, then holds.
 */

import type { Pose5 } from './protocol.js';

export const INTERP_DELAY_MS = 120;
export const MAX_EXTRAPOLATE_MS = 200;
const MAX_SNAPSHOTS = 30;

interface Snapshot {
  t: number;
  p: Pose5;
}

/** Wraps an angle to (-PI, PI] */
export function wrapAngle(a: number): number {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x <= -Math.PI) x += 2 * Math.PI;
  return x;
}

/** Interpolates angles along the shortest arc */
export function lerpAngle(a: number, b: number, k: number): number {
  return wrapAngle(a + wrapAngle(b - a) * k);
}

export function lerpPose(a: Pose5, b: Pose5, k: number): Pose5 {
  return [
    a[0] + (b[0] - a[0]) * k,
    a[1] + (b[1] - a[1]) * k,
    a[2] + (b[2] - a[2]) * k,
    lerpAngle(a[3], b[3], k),
    a[4] + (b[4] - a[4]) * k,
  ];
}

export class PoseBuffer {
  private readonly _snaps: Snapshot[] = [];
  private readonly _delay: number;

  constructor(delayMs = INTERP_DELAY_MS) {
    this._delay = delayMs;
  }

  get empty(): boolean {
    return this._snaps.length === 0;
  }

  /** Adds a pose received at local time nowMs. A big jump (teleport, reset) snaps instead of sliding. */
  push(p: Pose5, nowMs: number): void {
    const last = this._snaps[this._snaps.length - 1];
    if (last && Math.hypot(p[0] - last.p[0], p[2] - last.p[2]) > 4) this._snaps.length = 0;
    if (last && nowMs <= last.t) nowMs = last.t + 1;
    this._snaps.push({ t: nowMs, p });
    if (this._snaps.length > MAX_SNAPSHOTS) this._snaps.shift();
  }

  /** Pose to draw at local time nowMs, or null before the first snapshot */
  sample(nowMs: number): Pose5 | null {
    const s = this._snaps;
    if (s.length === 0) return null;
    const t = nowMs - this._delay;
    if (s.length === 1 || t <= s[0].t) return s[0].p.slice() as Pose5;
    for (let i = s.length - 1; i > 0; i--) {
      const a = s[i - 1];
      const b = s[i];
      if (t >= a.t && t <= b.t) return lerpPose(a.p, b.p, (t - a.t) / (b.t - a.t));
    }
    // Newer than the newest snapshot: continue the last motion a little, then hold
    const a = s[s.length - 2];
    const b = s[s.length - 1];
    const over = Math.min(t - b.t, MAX_EXTRAPOLATE_MS);
    // Snapshots far apart mean the sender stood still in between: no extrapolation then
    if (b.t - a.t > 400) return b.p.slice() as Pose5;
    return lerpPose(b.p, extrapolateTarget(a.p, b.p), over / (b.t - a.t));
  }
}

function extrapolateTarget(a: Pose5, b: Pose5): Pose5 {
  return [2 * b[0] - a[0], 2 * b[1] - a[1], 2 * b[2] - a[2], b[3] + wrapAngle(b[3] - a[3]), b[4]];
}

/**
 * Decides when to send my pose: at most every SEND_INTERVAL_MS, only when it changed enough,
 * plus a final send when I stop so others see where I really ended up.
 */
export const SEND_INTERVAL_MS = 100;
const POS_EPS = 0.01;
const ANG_EPS = 0.01;

export class PoseSender {
  private _lastSent: Pose5 | null = null;
  private _lastSentAt = -Infinity;

  private _lastKey = '';

  /** Returns the pose to send now, or null. key: body state (stance etc.); a change always sends. */
  next(p: Pose5, nowMs: number, key = ''): Pose5 | null {
    if (nowMs - this._lastSentAt < SEND_INTERVAL_MS) return null;
    const l = this._lastSent;
    if (
      key === this._lastKey &&
      l &&
      Math.abs(p[0] - l[0]) < POS_EPS &&
      Math.abs(p[1] - l[1]) < POS_EPS &&
      Math.abs(p[2] - l[2]) < POS_EPS &&
      Math.abs(wrapAngle(p[3] - l[3])) < ANG_EPS &&
      Math.abs(p[4] - l[4]) < ANG_EPS
    ) {
      return null;
    }
    const rounded = p.map(v => Math.round(v * 1000) / 1000) as Pose5;
    this._lastSent = rounded;
    this._lastSentAt = nowMs;
    this._lastKey = key;
    return rounded;
  }

  /** Forget the last pose (after a reconnect everyone needs a fresh one) */
  reset(): void {
    this._lastSent = null;
    this._lastSentAt = -Infinity;
    this._lastKey = '';
  }

  get lastSentAt(): number {
    return this._lastSentAt;
  }
}
