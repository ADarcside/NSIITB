/**
 * Namma Space AR: two-point alignment (AR build spec, "Alignment algorithm"). Pure maths.
 *
 * The scene and the phone's AR space are both right-handed, +Y up, in metres, and the scene floor
 * is y = 0, so only a turn about the vertical (theta) and a shift (t) are unknown:
 *
 *     p_AR = R_y(theta) * p_scene + t
 *
 * R_y is three.js's Y rotation: (x, z) -> (x cos + z sin, -x sin + z cos). It turns a floor
 * direction with angle phi = atan2(z, x) into phi - theta, so theta = phiScene - phiAR. The unit
 * tests check this against three.js itself.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface FloorPoint {
  x: number;
  z: number;
}

/** p_AR = R_y(theta) * p_scene + t */
export interface Alignment {
  theta: number;
  t: Vec3;
}

/** Allowed difference between the tapped distance and the marks' distance: the larger of these */
export const DIST_TOL_M = 0.05;
export const DIST_TOL_FRAC = 0.03;
/** Largest height difference between the two taps (both are on the floor) (m) */
export const HEIGHT_TOL_M = 0.1;

export type TapCheck =
  | { ok: true; tappedM: number; expectedM: number }
  | { ok: false; reason: 'distance'; tappedM: number; expectedM: number }
  | { ok: false; reason: 'height'; heightDiffM: number };

/** Step 1: do the two taps match the two marks? */
export function checkTaps(sA: FloorPoint, sB: FloorPoint, aA: Vec3, aB: Vec3): TapCheck {
  const expectedM = Math.hypot(sB.x - sA.x, sB.z - sA.z);
  const tappedM = Math.hypot(aB.x - aA.x, aB.z - aA.z);
  const heightDiffM = Math.abs(aB.y - aA.y);
  if (heightDiffM > HEIGHT_TOL_M) return { ok: false, reason: 'height', heightDiffM };
  const tol = Math.max(DIST_TOL_M, DIST_TOL_FRAC * expectedM);
  if (Math.abs(tappedM - expectedM) > tol) return { ok: false, reason: 'distance', tappedM, expectedM };
  return { ok: true, tappedM, expectedM };
}

/**
 * Steps 2 and 3: the turn and shift that put scene marks sA, sB onto AR taps aA, aB. Midpoints are
 * matched (halves the tap error); height is the taps' average, since the scene floor is y = 0.
 * Writes into `out` (no allocation, so it can run every frame from anchors).
 */
export function solveAlignment(
  sA: FloorPoint,
  sB: FloorPoint,
  aA: Vec3,
  aB: Vec3,
  out: Alignment = { theta: 0, t: { x: 0, y: 0, z: 0 } }
): Alignment {
  const phiS = Math.atan2(sB.z - sA.z, sB.x - sA.x);
  const phiA = Math.atan2(aB.z - aA.z, aB.x - aA.x);
  const theta = wrapAngle(phiS - phiA);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const msx = (sA.x + sB.x) / 2;
  const msz = (sA.z + sB.z) / 2;
  out.theta = theta;
  out.t.x = (aA.x + aB.x) / 2 - (msx * c + msz * s);
  out.t.z = (aA.z + aB.z) / 2 - (-msx * s + msz * c);
  out.t.y = (aA.y + aB.y) / 2;
  return out;
}

/** Flip: the taps were made in the wrong order. Same as solving with the taps swapped. */
export function flipAlignment(sA: FloorPoint, sB: FloorPoint, aA: Vec3, aB: Vec3, out?: Alignment): Alignment {
  return solveAlignment(sA, sB, aB, aA, out);
}

/** Scene point -> AR point under `al`. */
export function sceneToAr(al: Alignment, p: Vec3, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const c = Math.cos(al.theta);
  const s = Math.sin(al.theta);
  const x = p.x * c + p.z * s + al.t.x;
  const z = -p.x * s + p.z * c + al.t.z;
  out.x = x;
  out.y = p.y + al.t.y;
  out.z = z;
  return out;
}

/** AR point -> scene point under `al` (the walker's scene position from the phone's). */
export function arToScene(al: Alignment, p: Vec3, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const c = Math.cos(al.theta);
  const s = Math.sin(al.theta);
  const dx = p.x - al.t.x;
  const dz = p.z - al.t.z;
  // Inverse of R_y(theta) is R_y(-theta)
  out.x = dx * c - dz * s;
  out.y = p.y - al.t.y;
  out.z = dx * s + dz * c;
  return out;
}

export function wrapAngle(a: number): number {
  let r = a % (2 * Math.PI);
  if (r > Math.PI) r -= 2 * Math.PI;
  if (r <= -Math.PI) r += 2 * Math.PI;
  return r;
}

/** How long the ring must stay still on a cross before a tap counts (ms) */
export const TAP_STEADY_MS = 300;
/** "Still": the floor points in that time within this distance of their average (m) */
export const TAP_STEADY_RADIUS_M = 0.08;
/** Share of those points allowed outside the radius (jumpy frames in dim light) */
export const TAP_OUTLIER_FRAC = 0.25;

/**
 * Collects the floor point under the ring each frame and gives the averaged point once the ring
 * has been held still on one spot. Phone AR floor points jitter by a few cm frame to frame; a tap
 * uses the average of the last 0.3 s instead of one frame. Fixed buffer, no allocation.
 */
export class TapSampler {
  private static readonly CAP = 90;
  private readonly xs = new Float64Array(TapSampler.CAP);
  private readonly ys = new Float64Array(TapSampler.CAP);
  private readonly zs = new Float64Array(TapSampler.CAP);
  private readonly ts = new Float64Array(TapSampler.CAP);
  private head = 0;
  private count = 0;
  /** False while the ring is off the floor this frame */
  private onFloor = false;

  /**
   * Adds this frame's floor point, or a gap (null) when the ring is not on the floor. A short gap
   * (a frame or two without a floor hit, common in dim light) keeps the earlier points; the window
   * check in steadyPoint still needs the points to cover the whole time.
   */
  push(now: number, p: Vec3 | null): void {
    this.onFloor = Boolean(p);
    if (!p) return;
    this.xs[this.head] = p.x;
    this.ys[this.head] = p.y;
    this.zs[this.head] = p.z;
    this.ts[this.head] = now;
    this.head = (this.head + 1) % TapSampler.CAP;
    this.count = Math.min(this.count + 1, TapSampler.CAP);
  }

  /** The averaged floor point when the ring has been still for TAP_STEADY_MS, else null. */
  steadyPoint(now: number, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 | null {
    if (this.count === 0 || !this.onFloor) return null;
    let n = 0;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let oldest = now;
    for (let k = 0; k < this.count; k++) {
      const i = (this.head - 1 - k + TapSampler.CAP) % TapSampler.CAP;
      if (now - this.ts[i] > TAP_STEADY_MS) break;
      sx += this.xs[i];
      sy += this.ys[i];
      sz += this.zs[i];
      oldest = this.ts[i];
      n++;
    }
    // The samples must cover (almost) the whole window, not just the last frame or two
    if (n < 3 || now - oldest < TAP_STEADY_MS * 0.8) return null;
    const mx = sx / n;
    const mz = sz / n;
    // Jumpy frames are left out of the tap point, as long as there are only a few of them
    let kept = 0;
    let kx = 0;
    let ky = 0;
    let kz = 0;
    for (let k = 0; k < n; k++) {
      const i = (this.head - 1 - k + TapSampler.CAP) % TapSampler.CAP;
      if (Math.hypot(this.xs[i] - mx, this.zs[i] - mz) > TAP_STEADY_RADIUS_M) continue;
      kx += this.xs[i];
      ky += this.ys[i];
      kz += this.zs[i];
      kept++;
    }
    if (kept === 0 || n - kept > n * TAP_OUTLIER_FRAC) return null;
    out.x = kx / kept;
    out.y = ky / kept;
    out.z = kz / kept;
    return out;
  }

  reset(): void {
    this.count = 0;
    this.onFloor = false;
  }
}
