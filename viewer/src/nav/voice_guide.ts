/**
 * Namma Space voice guide: the one guide both pages use. It joins the cue picker (tour_guide.ts),
 * the phrases and the speaker. A page tells it where the walker is each frame; it speaks the line
 * the picker chooses and gives the page a text line to show (text is always on, voice can be muted).
 *
 * The AR page feeds it RouteFollower's state; the browser viewer, which plans its own routes,
 * builds the same input with viewerInput().
 */

import { nextMove, projectOnRoute, signedTurnDeg, OFF_ROUTE_M, TURN_AROUND_START_DEG } from './route_follower.js';
import type { Point2 } from './astar.js';
import { TourGuide, type Cue, type GuideInput } from './tour_guide.js';
import { guidePhrase, type GuideLang } from './guide_phrases.js';
import { Speaker } from './speaker.js';

export type { GuideInput } from './tour_guide.js';

export class VoiceGuide {
  readonly speaker = new Speaker();
  private readonly guide: TourGuide;
  /** The last line said (shown by pages that have room for it, and used by tests) */
  lastCue: Cue | null = null;
  /** Set once when the language has no voice on this device; the page shows it as a note */
  noVoiceNote: string | null = null;
  private noVoiceShown = new Set<GuideLang>();

  constructor(lang: GuideLang = 'en') {
    this.guide = new TourGuide(lang);
  }

  get lang(): GuideLang {
    return this.guide.language;
  }

  setLang(lang: GuideLang): void {
    if (lang === this.guide.language) return;
    this.guide.setLang(lang);
    this.speaker.cancel();
  }

  get isActive(): boolean {
    return this.guide.isActive;
  }

  get voiceOn(): boolean {
    return this.speaker.on;
  }

  /** Mute or unmute; returns the new state */
  toggleVoice(): boolean {
    this.speaker.setOn(!this.speaker.on);
    return this.speaker.on;
  }

  /** A route to `place` starts */
  begin(now: number, place: string, input: GuideInput): void {
    this.speaker.cancel();
    this.say(this.guide.start(now, place, input));
  }

  update(now: number, input: GuideInput): void {
    this.say(this.guide.update(now, input));
  }

  arrive(now: number): void {
    this.say(this.guide.arrive(now));
  }

  trackingLost(now: number): void {
    this.say(this.guide.trackingLost(now));
  }

  trackingBack(): void {
    this.guide.trackingBack();
  }

  /** The route ended. Speech stops, unless it is the arrival line. */
  end(): void {
    if (!this.guide.hasArrived) this.speaker.cancel();
    this.guide.stop();
  }

  line(input: GuideInput, now: number): { instruction: string | null; left: string } {
    return this.guide.line(input, now);
  }

  /** The speaker button's hover text for the current state and language */
  voiceLabel(): string {
    return guidePhrase(this.lang, this.speaker.on ? 'voiceOn' : 'voiceOff');
  }

  /** The speaker button's short text ("🔊 Voice on"), for the AR bottom bar */
  voiceButtonText(): string {
    return guidePhrase(this.lang, this.speaker.on ? 'voiceBtnOn' : 'voiceBtnOff');
  }

  private say(cue: Cue | null): void {
    if (!cue) return;
    this.lastCue = cue;
    const lang = this.guide.language;
    if (this.speaker.on && this.speaker.hasVoice(lang) === false) {
      if (!this.noVoiceShown.has(lang) && this.speaker.available) {
        this.noVoiceShown.add(lang);
        this.noVoiceNote = guidePhrase(lang, 'noVoice');
      }
      return;
    }
    this.speaker.say(cue.text, lang, cue.priority);
  }
}

/** True when `walker` is further than OFF_ROUTE_M from `points` (the viewer then says a new route was found) */
export function isOffRoute(points: readonly Point2[] | null, walker: Point2): boolean {
  if (!points || points.length === 0) return false;
  const pts = points.length === 1 ? [points[0], points[0]] : (points as Point2[]);
  return projectOnRoute(pts, walker).offM > OFF_ROUTE_M;
}

/**
 * The guide's input in the browser viewer: the route main.ts is showing, the walker's floor
 * position and camera yaw (three.js: yaw 0 looks down -Z). "Facing away" counts only while the
 * walker is moving, so looking around while standing still never triggers "Turn around".
 */
export function viewerInput(
  points: readonly Point2[] | null,
  walker: Point2,
  yaw: number,
  moving: boolean,
  rerouted: boolean
): GuideInput {
  if (!points || points.length === 0) return { remainingM: 0, next: null, facingAway: false, noRoute: true, rerouted };
  const pts = points.length === 1 ? [points[0], points[0]] : (points as Point2[]);
  const pr = projectOnRoute(pts, walker);
  const next = nextMove(pts, pr);
  let facingAway = false;
  if (moving) {
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const wx = next.x - walker.x;
    const wz = next.z - walker.z;
    const l = Math.hypot(wx, wz);
    if (l > 0.3) facingAway = Math.abs(signedTurnDeg({ x: fx, z: fz }, { x: wx / l, z: wz / l })) > TURN_AROUND_START_DEG;
  }
  return { remainingM: pr.remainingM, next, facingAway, noRoute: false, rerouted };
}
