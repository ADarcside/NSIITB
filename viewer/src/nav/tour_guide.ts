/**
 * Namma Space voice guide: the cue picker. Given where the walker is on the route each frame, it
 * decides which line (if any) to say now, following the approved plan's table and drift rules.
 * No screen, sound or browser code here, so it is unit tested with a fake clock; the AR page and
 * the browser viewer both feed it (see voice_guide.ts).
 *
 * Lines, most urgent first: arrived, turn now, turn around, new route, turn coming, start,
 * distance left. Directions only: places along the way are not named (user's choice, 15 Nov).
 */

import type { NextMove } from './route_follower.js';
import { guidePhrase, spokenMetres, turnWords, walkTimePhrase, type GuideLang } from './guide_phrases.js';

/** Corner this close or nearer: "Turn left" (m) */
export const TURN_NOW_M = 2;
/** Corner in this window: "In 5 metres, turn left" (m) */
export const COMING_MIN_M = 4;
export const COMING_MAX_M = 8;
/** Facing away for this long before "Turn around" (ms), and at most this often after (ms) */
export const FACING_HOLD_MS = 1500;
export const TURN_AROUND_REPEAT_MS = 8000;
/** "Finding a new way" at most this often (ms) */
export const NEW_ROUTE_REPEAT_MS = 10000;
/** Quiet time between lines, except Arrived and Turn now (ms) */
export const QUIET_MS = 3000;
/** Distance-left marks (m) */
export const DISTANCE_MARKS = [50, 20, 10, 5] as const;
/** A mark is said only on the way past it: dropped once the route left is this far (or 30%) below it (m) */
const MARK_LATE_M = 3;
/** Corners within this of one already spoken count as the same corner (route replans move them a little) */
export const SAME_CORNER_M = 1.5;

export type CueKind = 'arrived' | 'turnNow' | 'turnAround' | 'newRoute' | 'turnComing' | 'start' | 'distance' | 'lost';

/** Lower is more urgent; a more urgent line cuts off a less urgent one */
export const CUE_PRIORITY: Readonly<Record<CueKind, number>> = {
  arrived: 1,
  turnNow: 2,
  lost: 2,
  turnAround: 3,
  newRoute: 4,
  turnComing: 5,
  start: 6,
  distance: 8,
};

export interface Cue {
  kind: CueKind;
  text: string;
  priority: number;
}

/** What the page knows about the walker this frame */
export interface GuideInput {
  /** Route length left (m) */
  remainingM: number;
  /** Next move from route_follower's nextMove(), or null with no route */
  next: NextMove | null;
  /** The walker faces well away from the way to go (raw, this frame; the guide waits FACING_HOLD_MS) */
  facingAway: boolean;
  /** No walkable route from here */
  noRoute: boolean;
  /** A fresh route was planned this frame because the walker left the old one */
  rerouted: boolean;
}

interface SpokenCorner {
  x: number;
  z: number;
  coming: boolean;
  now: boolean;
}

export class TourGuide {
  private lang: GuideLang;
  private active = false;
  private arrived = false;
  private lost = false;
  private place = '';
  private startLengthM = 0;
  private lastSpokeAt = -Infinity;
  private corners: SpokenCorner[] = [];
  private marksSaid = new Set<number>();
  private facingSince: number | null = null;
  private lastTurnAroundAt = -Infinity;
  private lastNewRouteAt = -Infinity;
  /** The next step at the last update, to tell whether a new route changed it */
  private lastStepKey = '';

  constructor(lang: GuideLang = 'en') {
    this.lang = lang;
  }

  get language(): GuideLang {
    return this.lang;
  }

  setLang(lang: GuideLang): void {
    this.lang = lang;
  }

  get isActive(): boolean {
    return this.active;
  }

  get hasArrived(): boolean {
    return this.arrived;
  }

  /** True while the AR page has lost the room (the guide stays quiet) */
  get isLost(): boolean {
    return this.lost;
  }

  get placeName(): string {
    return this.place;
  }

  /**
   * A route starts: returns the start line. When the first corner is already close, its
   * instruction is added to the start line (so it is not said twice, and the start line is not
   * cut off a moment later).
   */
  start(now: number, place: string, input: GuideInput): Cue {
    this.active = true;
    this.arrived = false;
    this.lost = false;
    this.place = place;
    this.startLengthM = input.noRoute ? 0 : input.remainingM;
    this.corners = [];
    this.marksSaid.clear();
    this.facingSince = null;
    this.lastTurnAroundAt = -Infinity;
    this.lastNewRouteAt = -Infinity;
    this.lastStepKey = stepKey(input.next);
    const L = this.lang;
    let text: string;
    if (input.noRoute) text = guidePhrase(L, 'lineNoRoute');
    else if (input.remainingM < TURN_NOW_M) text = guidePhrase(L, 'startNear', { place });
    else {
      const m = input.remainingM;
      text = guidePhrase(L, 'start', { place, d: spokenMetres(m), time: walkTimePhrase(L, m, true) });
      const nx = input.next;
      if (nx && !nx.toGoal && nx.turn !== 'straight' && nx.distM <= COMING_MAX_M) {
        const c = this.cornerFor(nx);
        if (nx.distM <= TURN_NOW_M + 1) {
          text += ' ' + guidePhrase(L, 'turnNow', { turn: turnWords(L, nx.turn) });
          c.now = true;
        } else {
          text += ' ' + guidePhrase(L, 'turnComing', { d: spokenMetres(nx.distM), turn: turnWords(L, nx.turn, true) });
        }
        c.coming = true;
      }
    }
    return this.emit(now, 'start', text);
  }

  /** One frame: the line to say now, or null. */
  update(now: number, input: GuideInput): Cue | null {
    if (!this.active || this.arrived || this.lost) return null;
    const L = this.lang;
    if (input.noRoute || !input.next) {
      this.facingSince = null;
      return null;
    }
    const nx = input.next;

    // Facing away: held for FACING_HOLD_MS, never in the last 2 m (arriving)
    if (input.facingAway && input.remainingM >= TURN_NOW_M) this.facingSince ??= now;
    else this.facingSince = null;

    const quiet = now - this.lastSpokeAt >= QUIET_MS;
    const step = stepKey(nx);
    const stepChanged = step !== this.lastStepKey;
    this.lastStepKey = step;

    // 2. Turn now
    if (!nx.toGoal && nx.turn !== 'straight' && nx.distM <= TURN_NOW_M) {
      const c = this.cornerFor(nx);
      if (!c.now) {
        c.now = true;
        c.coming = true;
        return this.emit(now, 'turnNow', guidePhrase(L, 'turnNow', { turn: turnWords(L, nx.turn) }));
      }
    }

    // 3. Turn around
    if (
      this.facingSince !== null &&
      now - this.facingSince >= FACING_HOLD_MS &&
      now - this.lastTurnAroundAt >= TURN_AROUND_REPEAT_MS &&
      quiet
    ) {
      this.lastTurnAroundAt = now;
      return this.emit(now, 'turnAround', guidePhrase(L, 'turnAround'));
    }

    // 4. New route, only when it changed the next step
    if (input.rerouted && stepChanged && now - this.lastNewRouteAt >= NEW_ROUTE_REPEAT_MS && quiet) {
      this.lastNewRouteAt = now;
      return this.emit(now, 'newRoute', guidePhrase(L, 'newRoute'));
    }

    // 5. Turn coming (a corner first seen nearer than COMING_MIN_M only gets "Turn now")
    if (!nx.toGoal && nx.turn !== 'straight' && nx.distM >= COMING_MIN_M && nx.distM <= COMING_MAX_M && quiet) {
      const c = this.cornerFor(nx);
      if (!c.coming) {
        c.coming = true;
        return this.emit(
          now,
          'turnComing',
          guidePhrase(L, 'turnComing', { d: spokenMetres(nx.distM), turn: turnWords(L, nx.turn, true) })
        );
      }
    }

    // 8. Distance left, on the way past each mark, if the route was longer than the mark to begin with
    for (const mark of DISTANCE_MARKS) {
      if (this.marksSaid.has(mark)) continue;
      if (this.startLengthM < mark + 2) {
        this.marksSaid.add(mark);
        continue;
      }
      if (input.remainingM > mark) continue;
      const late = input.remainingM < mark - Math.min(MARK_LATE_M, mark * 0.3);
      if (!late && !quiet) break; // wait for the quiet gap while still near the mark
      // Said now, or too late to say: this mark and every bigger one are done
      for (const m of DISTANCE_MARKS) if (m >= mark) this.marksSaid.add(m);
      if (!late) return this.emit(now, 'distance', guidePhrase(L, 'distanceLeft', { d: mark }));
      break;
    }
    return null;
  }

  /** The walker has arrived: the arrival line, said once (no side, since 1 m of drift can flip it). */
  arrive(now: number): Cue | null {
    if (!this.active || this.arrived) return null;
    this.arrived = true;
    return this.emit(now, 'arrived', guidePhrase(this.lang, 'arrived', { place: this.place }));
  }

  /** AR lost the room: "Hold on" once, then quiet until trackingBack(). */
  trackingLost(now: number): Cue | null {
    if (!this.active || this.arrived || this.lost) return null;
    this.lost = true;
    this.facingSince = null;
    return this.emit(now, 'lost', guidePhrase(this.lang, 'trackingLost'));
  }

  trackingBack(): void {
    this.lost = false;
  }

  /** The route ended (cleared or a new one is coming) */
  stop(): void {
    this.active = false;
    this.lost = false;
    this.facingSince = null;
  }

  /**
   * The live text line: the next instruction (null when there is nothing to say, e.g. on the last
   * straight in the browser viewer, whose card already shows the length) and the length left.
   */
  line(input: GuideInput, now: number): { instruction: string | null; left: string } {
    const L = this.lang;
    if (input.noRoute || !input.next) return { instruction: guidePhrase(L, 'lineNoRoute'), left: '' };
    const m = Math.max(0, input.remainingM);
    const left = guidePhrase(L, 'lineLeft', { d: m < 10 ? m.toFixed(1) : Math.round(m), time: walkTimePhrase(L, m, false) });
    const nx = input.next;
    let instruction: string | null = null;
    if (this.facingSince !== null && now - this.facingSince >= FACING_HOLD_MS) instruction = guidePhrase(L, 'lineTurnAround');
    else if (!nx.toGoal && nx.turn !== 'straight') {
      instruction =
        nx.distM <= TURN_NOW_M
          ? guidePhrase(L, 'lineTurnNow', { turn: turnWords(L, nx.turn) })
          : guidePhrase(L, 'lineTurnIn', { d: spokenMetres(nx.distM), turn: turnWords(L, nx.turn, true) });
    }
    return { instruction, left };
  }

  private emit(now: number, kind: CueKind, text: string): Cue {
    this.lastSpokeAt = now;
    return { kind, text, priority: CUE_PRIORITY[kind] };
  }

  /** The memory of the corner `nx` points at, a new one if no spoken corner is near it */
  private cornerFor(nx: NextMove): SpokenCorner {
    for (const c of this.corners) if (Math.hypot(c.x - nx.cx, c.z - nx.cz) <= SAME_CORNER_M) return c;
    const c: SpokenCorner = { x: nx.cx, z: nx.cz, coming: false, now: false };
    this.corners.push(c);
    return c;
  }
}

/** Identifies the next step loosely (corner snapped to 1.5 m cells plus the turn), to spot a changed route */
function stepKey(nx: NextMove | null): string {
  if (!nx) return 'none';
  if (nx.toGoal) return 'goal';
  return `${Math.round(nx.cx / SAME_CORNER_M)},${Math.round(nx.cz / SAME_CORNER_M)},${nx.turn}`;
}
