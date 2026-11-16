/**
 * Namma Space: route following (AR build spec, "Guidance algorithm"), shared by the AR page and the
 * voice guide. Pure maths, no WebXR or drawing, so it is unit tested.
 *
 * Coordinates are scene floor metres (x, z), +Y up, right-handed like three.js: a walker facing
 * -Z has +X on their right. For a heading d, "right" is (-d.z, d.x), so a turn from leg d1 to leg
 * d2 is to the right when the signed angle atan2(d1.x * d2.z - d1.z * d2.x, d1 . d2) is positive.
 */

import type { Point2 } from './astar.js';

/** Turns smaller than this are "go straight", and are not corners (degrees) */
export const CORNER_MIN_DEG = 30;
/** Leaving the route by more than this triggers a new route (m) */
export const OFF_ROUTE_M = 0.8;
/** Route upkeep at most this often (ms), or sooner after moving REPLAN_MOVE_M */
export const UPKEEP_MS = 500;
export const REPLAN_MOVE_M = 0.3;
/** Arrived: remaining route under this for ARRIVE_HOLD_MS (m, ms) */
export const ARRIVE_M = 1.0;
export const ARRIVE_HOLD_MS = 500;
/** Start facing: the first leg this far from where the phone faces means "turn around" (degrees) */
export const TURN_AROUND_START_DEG = 100;
/** Arrows sit this far ahead on a straight run with no corner coming (m) */
export const STRAIGHT_AHEAD_M = 3;
/** The first arrow is never closer than this along the route, so it is not under the walker's feet (m) */
export const ARROW_MIN_AHEAD_M = 1.5;
/** Length of the three arrows on the floor, first to last (m); matches ar_scene.ts */
export const ARROW_SPAN_M = 1.2;
/** On the last straight the arrows end at least this far before the goal ring (m) */
export const GOAL_CLEAR_M = 0.3;

export type Turn = 'straight' | 'slight-left' | 'slight-right' | 'left' | 'right' | 'around';

/** Signed turn from heading d1 to heading d2, in degrees: positive is right, negative is left. */
export function signedTurnDeg(d1: Point2, d2: Point2): number {
  const cross = d1.x * d2.z - d1.z * d2.x;
  const dot = d1.x * d2.x + d1.z * d2.z;
  return (Math.atan2(cross, dot) * 180) / Math.PI;
}

/** The spec's turn table for a signed angle (degrees, positive right). */
export function turnFor(deg: number): Turn {
  const a = Math.abs(deg);
  if (a < CORNER_MIN_DEG) return 'straight';
  if (a > 135) return 'around';
  const right = deg > 0;
  if (a <= 60) return right ? 'slight-right' : 'slight-left';
  return right ? 'right' : 'left';
}

/** Where a point lies against a route: the nearest spot on it, and how far along that is */
export interface RouteProjection {
  /** Segment index (from points[seg] to points[seg + 1]) */
  seg: number;
  /** Nearest spot on the route */
  x: number;
  z: number;
  /** Distance from the point to the route (m) */
  offM: number;
  /** Route length left after the nearest spot (m) */
  remainingM: number;
}

/** Nearest spot on the route to p, and the length left from there. */
export function projectOnRoute(points: Point2[], p: Point2): RouteProjection {
  let best: RouteProjection = { seg: 0, x: points[0].x, z: points[0].z, offM: Infinity, remainingM: 0 };
  let bestT = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2)) : 0;
    const x = a.x + t * dx;
    const z = a.z + t * dz;
    const off = Math.hypot(p.x - x, p.z - z);
    // Ties go to the later segment, so standing on a corner counts as past it
    if (off <= best.offM + 1e-9) {
      best = { seg: i, x, z, offM: off, remainingM: 0 };
      bestT = t;
    }
  }
  if (points.length === 1) best.offM = Math.hypot(p.x - points[0].x, p.z - points[0].z);
  let rest = 0;
  if (points.length > 1) {
    const a = points[best.seg];
    const b = points[best.seg + 1];
    rest = (1 - bestT) * Math.hypot(b.x - a.x, b.z - a.z);
    for (let i = best.seg + 1; i + 1 < points.length; i++) rest += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].z - points[i].z);
  }
  best.remainingM = rest;
  return best;
}

/** The next real corner after segment `seg`: the first waypoint where the route turns 30° or more. */
export interface NextMove {
  /**
   * Where the first arrow goes (the others follow along dirX, dirZ), always a floor spot on the
   * route: the corner, or (when the corner is nearer than ARROW_MIN_AHEAD_M) that far along the
   * next leg, or up to STRAIGHT_AHEAD_M ahead on the last straight
   */
  x: number;
  z: number;
  /** False on the last few metres, where the arrows would crowd the walker or the goal ring */
  arrows: boolean;
  /** Route distance from the walker's spot on the route to that corner (m), or to the goal */
  distM: number;
  turn: Turn;
  /** Floor heading the arrows point (unit): the leg after the corner, or the leg they sit on */
  dirX: number;
  dirZ: number;
  /** True when no corner is left: the next thing is the goal itself */
  toGoal: boolean;
  /** The corner itself (or the route's end when toGoal), for the voice guide to tell corners apart */
  cx: number;
  cz: number;
}

/** The spot `d` metres further along the route from projection `pr`, and the heading of the leg it is on. */
export function pointAlong(points: Point2[], pr: RouteProjection, d: number): { x: number; z: number; dirX: number; dirZ: number } {
  let px = pr.x;
  let pz = pr.z;
  let left = Math.max(0, d);
  let dir = points.length > 1 ? unit(points[pr.seg + 1].x - points[pr.seg].x, points[pr.seg + 1].z - points[pr.seg].z) : { x: 0, z: -1 };
  for (let i = pr.seg + 1; i < points.length; i++) {
    const c = points[i];
    const len = Math.hypot(c.x - px, c.z - pz);
    if (len > 1e-9) dir = unit(c.x - px, c.z - pz);
    if (len >= left) return { x: px + dir.x * left, z: pz + dir.z * left, dirX: dir.x, dirZ: dir.z };
    left -= len;
    px = c.x;
    pz = c.z;
  }
  return { x: px, z: pz, dirX: dir.x, dirZ: dir.z };
}

function unit(dx: number, dz: number): Point2 {
  const l = Math.hypot(dx, dz);
  return l > 1e-9 ? { x: dx / l, z: dz / l } : { x: 0, z: -1 };
}

/** The next move from projection `pr` on `points`. */
export function nextMove(points: Point2[], pr: RouteProjection): NextMove {
  let dist = 0;
  let px = pr.x;
  let pz = pr.z;
  const n = points.length;
  for (let i = pr.seg + 1; i < n; i++) {
    const c = points[i];
    dist += Math.hypot(c.x - px, c.z - pz);
    px = c.x;
    pz = c.z;
    if (i === n - 1) break;
    const inDir = unit(c.x - points[i - 1].x, c.z - points[i - 1].z);
    const outDir = unit(points[i + 1].x - c.x, points[i + 1].z - c.z);
    const deg = signedTurnDeg(inDir, outDir);
    if (Math.abs(deg) >= CORNER_MIN_DEG) {
      const turn = turnFor(deg);
      if (dist >= ARROW_MIN_AHEAD_M)
        return { x: c.x, z: c.z, arrows: true, distM: dist, turn, dirX: outDir.x, dirZ: outDir.z, toGoal: false, cx: c.x, cz: c.z };
      // Corner almost underfoot: show the arrows a little way along the leg after it
      const spot = pointAlong(points, pr, Math.min(ARROW_MIN_AHEAD_M, pr.remainingM));
      const fits = pr.remainingM - ARROW_MIN_AHEAD_M >= ARROW_SPAN_M + GOAL_CLEAR_M;
      return { x: spot.x, z: spot.z, arrows: fits, distM: dist, turn, dirX: spot.dirX, dirZ: spot.dirZ, toGoal: false, cx: c.x, cz: c.z };
    }
  }
  // No corner left: straight on toward the route's end (the floor ring next to the place). The
  // arrows start between ARROW_MIN_AHEAD_M and STRAIGHT_AHEAD_M ahead and end before the ring;
  // when they do not fit, the ring and the ball show the way on their own.
  const start = Math.min(STRAIGHT_AHEAD_M, pr.remainingM - ARROW_SPAN_M - GOAL_CLEAR_M);
  const spot = pointAlong(points, pr, Math.max(0, start));
  return {
    x: spot.x,
    z: spot.z,
    arrows: start >= ARROW_MIN_AHEAD_M,
    distM: pr.remainingM,
    turn: 'straight',
    dirX: spot.dirX,
    dirZ: spot.dirZ,
    toGoal: true,
    cx: points[n - 1].x,
    cz: points[n - 1].z,
  };
}

/** What the follower says each frame */
export interface GuideState {
  /** No route can be found from here (the walker is off the floor map, or the goal is cut off) */
  noRoute: boolean;
  /** Route length left (m) */
  remainingM: number;
  next: NextMove | null;
  /** The phone faces more than TURN_AROUND_START_DEG away from the way to go */
  facingAway: boolean;
  /** True once, on the frame the walker arrives */
  arrivedNow: boolean;
  /** A new route was planned this frame (for the debug line and tests) */
  replanned: boolean;
}

/** Plans a route from the walker to the goal (NavPlanner.findPath in the app) */
export type RoutePlanner = (from: Point2) => Point2[] | null;

/**
 * Follows one route to one goal: keeps the route fresh (re-route when off it), finds the next
 * move, and says when the walker has arrived. Call update() every frame with the walker's floor
 * position and the floor direction the phone faces.
 */
export class RouteFollower {
  private route: Point2[] | null = null;
  private lastUpkeep = -Infinity;
  private lastUpkeepPos: Point2 = { x: Infinity, z: Infinity };
  private nearSince: number | null = null;
  private arrived = false;
  private readonly state: GuideState = { noRoute: false, remainingM: 0, next: null, facingAway: false, arrivedNow: false, replanned: false };
  /** Number of routes planned so far */
  plans = 0;

  constructor(private readonly plan: RoutePlanner) {}

  get points(): readonly Point2[] | null {
    return this.route;
  }

  get hasArrived(): boolean {
    return this.arrived;
  }

  /** Forgets the route and arrival (new goal, or after Re-align). */
  reset(): void {
    this.route = null;
    this.lastUpkeep = -Infinity;
    this.lastUpkeepPos = { x: Infinity, z: Infinity };
    this.nearSince = null;
    this.arrived = false;
  }

  update(now: number, walker: Point2, facing: Point2 | null): GuideState {
    const s = this.state;
    s.arrivedNow = false;
    s.replanned = false;
    const moved = Math.hypot(walker.x - this.lastUpkeepPos.x, walker.z - this.lastUpkeepPos.z);
    let pr = this.route && this.route.length > 0 ? projectOnRoute(this.route, walker) : null;
    if (!this.route || now - this.lastUpkeep >= UPKEEP_MS || moved >= REPLAN_MOVE_M) {
      this.lastUpkeep = now;
      this.lastUpkeepPos = { x: walker.x, z: walker.z };
      if (!pr || pr.offM > OFF_ROUTE_M) {
        const fresh = this.plan(walker);
        this.plans++;
        s.replanned = true;
        if (fresh && fresh.length > 0) {
          this.route = fresh.length === 1 ? [fresh[0], fresh[0]] : fresh;
          pr = projectOnRoute(this.route, walker);
        } else if (!this.route) {
          s.noRoute = true;
          s.next = null;
          s.facingAway = false;
          return s;
        }
      }
    }
    if (!this.route || !pr) {
      s.noRoute = true;
      s.next = null;
      return s;
    }
    s.noRoute = false;
    s.remainingM = pr.remainingM;
    s.next = nextMove(this.route, pr);
    // Way to go right now: along the current leg (or to the arrows on a straight run)
    if (facing && Math.hypot(facing.x, facing.z) > 1e-6) {
      const way = unit(s.next.x - walker.x, s.next.z - walker.z);
      s.facingAway = Math.abs(signedTurnDeg(unit(facing.x, facing.z), way)) > TURN_AROUND_START_DEG;
    } else {
      s.facingAway = false;
    }
    if (!this.arrived) {
      if (pr.remainingM < ARRIVE_M) {
        this.nearSince ??= now;
        if (now - this.nearSince >= ARRIVE_HOLD_MS) {
          this.arrived = true;
          s.arrivedNow = true;
        }
      } else {
        this.nearSince = null;
      }
    }
    return s;
  }
}
