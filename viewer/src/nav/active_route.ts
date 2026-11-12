/**
 * Namma Space: the route the viewer is showing right now, in one place.
 *
 * Everything that follows a route reads it from here: today the minimap and route line get it
 * straight from main.ts, and this is the entry point for AR guidance (phone camera with arrows
 * along the route, Round 3 bonus). An AR guide subscribes and gets the destination, the start and
 * the floor waypoints in world metres, updated as the walker moves and cleared on arrival.
 */

import type { POI } from '../contracts/types.js';
import type { Point2 } from './astar.js';

export interface ActiveRoute {
  /** Destination */
  to: POI;
  /** Start place, or null when the route starts from the walker */
  from: POI | null;
  /** Floor waypoints (world metres), start first; null when there is no walkable path */
  points: Point2[] | null;
  /** Walking length (m), or null when there is no walkable path */
  lengthM: number | null;
}

type Listener = (route: ActiveRoute | null) => void;

export class RouteBus {
  private _route: ActiveRoute | null = null;
  private readonly _listeners = new Set<Listener>();

  get current(): ActiveRoute | null {
    return this._route;
  }

  /** Calls `cb` now with the current route and on every change; returns an unsubscribe function. */
  subscribe(cb: Listener): () => void {
    this._listeners.add(cb);
    cb(this._route);
    return () => this._listeners.delete(cb);
  }

  set(route: ActiveRoute | null): void {
    this._route = route;
    for (const cb of this._listeners) cb(route);
  }
}

export const activeRoute = new RouteBus();

/**
 * AR guidance slot. An AR guide module, once written, registers a loader here; until then the AR
 * button never shows. The guide is loaded on demand (only when someone taps AR), so it adds
 * nothing to the normal viewer download.
 */
export interface ArGuide {
  /** True when this device can run it (camera, WebXR or motion sensors, as the guide needs) */
  supported(): Promise<boolean>;
  /** Opens the camera view and follows `routes` until stop() or the user closes it */
  start(routes: RouteBus): Promise<void>;
  stop(): void;
}

let arLoader: (() => Promise<ArGuide>) | null = null;

export function registerArGuide(loader: () => Promise<ArGuide>): void {
  arLoader = loader;
}

/** The registered AR guide's loader, or null when there is none (no AR button) */
export function arGuideLoader(): (() => Promise<ArGuide>) | null {
  return arLoader;
}
