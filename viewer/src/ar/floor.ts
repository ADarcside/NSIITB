/**
 * Namma Space AR: deciding when the phone has found the floor. Pure maths, no WebXR calls.
 *
 * A WebXR hit test result is a pose whose +Y axis is the surface normal. A floor (or any surface
 * facing up) has that axis close to world up; walls and ceilings do not. The floor counts as found
 * once a floor hit has been seen without a real gap for STEADY_MS.
 */

/** Largest tilt of the surface normal from straight up that still counts as floor (degrees) */
export const MAX_FLOOR_TILT_DEG = 20;
/** How long the floor hit must last before the floor counts as found (ms) */
export const STEADY_MS = 600;
/** A floor hit may drop out this long without restarting the count (hit tests flicker) (ms) */
export const DROPOUT_GRACE_MS = 200;

/**
 * World-up component of the pose's +Y axis for a unit quaternion (x, y, z, w): 1 for a surface
 * facing straight up, 0 for a wall, -1 for a ceiling.
 */
export function upDot(x: number, _y: number, z: number, _w: number): number {
  // Second column, Y row, of the rotation matrix of q: 1 - 2(x^2 + z^2)
  return 1 - 2 * (x * x + z * z);
}

/** True when a hit pose with orientation (x, y, z, w) is a surface facing up (floor, not wall). */
export function isFloorFacing(x: number, y: number, z: number, w: number, maxTiltDeg = MAX_FLOOR_TILT_DEG): boolean {
  return upDot(x, y, z, w) >= Math.cos((maxTiltDeg * Math.PI) / 180);
}

/** Tracks how long a floor hit has lasted; call update() once per camera frame. */
export class FloorWatch {
  private since: number | null = null;
  private lastSeen = -Infinity;

  /** Feeds one frame; returns true once a floor hit has lasted STEADY_MS. `now` is in ms. */
  update(now: number, floorHit: boolean): boolean {
    if (floorHit) {
      if (this.since === null || now - this.lastSeen > DROPOUT_GRACE_MS) this.since = now;
      this.lastSeen = now;
    } else if (now - this.lastSeen > DROPOUT_GRACE_MS) {
      this.since = null;
    }
    return this.since !== null && now - this.since >= STEADY_MS;
  }

  reset(): void {
    this.since = null;
    this.lastSeen = -Infinity;
  }
}
