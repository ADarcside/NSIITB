/**
 * Namma Space: Movement Controller & Wall-Sliding Step
 * Implements SPEC.md Section 7:
 * - Frame-independent movement with dt clamped to 0.05s
 * - Wall sliding movement step
 * - Yaw/pitch look with pitch clamped to +/- 85 degrees
 * - Speeds 1.4 m/s (walk) and 2.5 m/s (sprint) with 0.15s smoothing
 * - Camera Y locked to eye_height_m
 * - Position clamped to bounds
 * - Reset to start_pose
 * - Key state cleared on blur or pointer-lock loss
 * - Two movement modes: 'free' (free roam: Q/E fly, the original behaviour) and 'walk'
 *   (fixed eye height, heavier start/stop, head bob, sprint FOV kick, footstep events, Space jumps)
 * - Walk "game feel" (setGameFeel(true): laptops outside tag mode only): shooter-style movement with
 *   snappier starts and stops, weighty sprint, double-tap Shift tactical sprint, C to crouch or slide,
 *   strafe tilt, heavier landings, right-mouse zoom and climbing onto low furniture. With game feel
 *   off, Walk mode behaves exactly as before (tag mode and phones keep it off).
 */

import type { CollisionProvider, MovementController, Pose3D, Vec2, Bounds } from '../types.js';
import type { Pose2D } from '../contracts/types.js';
import type { Point2 } from '../nav/astar.js';
import { isTypingTarget } from '../ui/app_ui.js';

export const WALK_SPEED = 1.4;
export const SPRINT_SPEED = 2.5;
export const MAX_DT = 0.05;
/**
 * Q/E change camera height (m/s), kept between MIN_EYE_M and MAX_EYE_M above the floor.
 * The first height change starts flying: with a layered grid the camera then collides only with
 * what is at its height (over a bunk, through the gap between bunks) until Reset.
 */
export const VERTICAL_SPEED = 0.8;
/** Lowest eye height: the video was filmed from waist height up, so views lower than this show the floor edge-on as fuzz */
export const MIN_EYE_M = 0.7;
export const MAX_EYE_M = 2.7;
export const SMOOTHING_TIME_S = 0.15;
export const MAX_PITCH_RAD = (85 * Math.PI) / 180;

/** 'free' = free roam (Q/E fly, unchanged); 'walk' = person-height character with game feel. */
export type MoveMode = 'free' | 'walk';
export const BASE_FOV_DEG = 60;
/** Walk mode: speed-up and slow-down time constants (free roam keeps SMOOTHING_TIME_S) */
export const WALK_ACCEL_S = 0.25;
export const WALK_DECEL_S = 0.12;
/** Walk mode head bob (metres, camera only) and step rate (steps/s at walk and sprint speed) */
export const BOB_Y_M = 0.025;
export const BOB_SIDE_M = 0.012;
export const STEPS_PER_S_WALK = 1.8;
export const STEPS_PER_S_SPRINT = 2.4;
export const SPRINT_FOV_DEG = 66;
/** Walk mode jump: take-off speed (m/s up) and gravity; about 0.46 m high, 0.6 s in the air */
export const JUMP_SPEED = 3.0;
export const GRAVITY = 9.81;
/** Camera dip on landing (m), easing back over about 0.15 s */
export const LAND_DIP_M = 0.04;
// ---- Walk game feel (only when setGameFeel(true); all numbers to tune live here) ----
/** Speed-up time constants (walk, and up to sprint speed) and the stop time constant */
export const FEEL_ACCEL_S = 0.1;
export const FEEL_SPRINT_ACCEL_S = 0.2;
export const FEEL_DECEL_S = 0.07;
/** Sprint: FOV opens by this much over the base FOV, and the camera dips forward a little */
export const FEEL_SPRINT_FOV_ADD = 10;
export const SPRINT_PITCH_DIP_RAD = (1.5 * Math.PI) / 180;
/** Tactical sprint (double-tap Shift): speed, how long it lasts, cooldown, tap window, extra FOV */
export const TAC_SPEED = 3.5;
export const TAC_DURATION_S = 3;
export const TAC_COOLDOWN_S = 2;
export const TAC_DOUBLE_TAP_S = 0.3;
export const TAC_FOV_ADD = 14;
/** Crouch (hold C): eye height and speed */
export const CROUCH_EYE_M = 1.0;
export const CROUCH_SPEED = 0.8;
/** Eye height eases between standing, crouch and slide with this time constant */
export const EYE_EASE_S = 0.1;
/** Slide (C while sprinting): eye height, length, speed boost at the start, top speed, tilt */
export const SLIDE_EYE_M = 0.85;
export const SLIDE_DURATION_S = 0.7;
export const SLIDE_BOOST = 1.25;
export const SLIDE_MAX_SPEED = 4;
export const SLIDE_ROLL_RAD = (3 * Math.PI) / 180;
/** Lean while strafing (A / D) at walking speed */
export const STRAFE_ROLL_RAD = (2.5 * Math.PI) / 180;
/** Landing: dip grows with time in the air up to HEAVY_LAND_DIP_M, plus a short shake */
export const HEAVY_LAND_DIP_M = 0.1;
export const LAND_SHAKE_S = 0.25;
export const LAND_SHAKE_M = 0.008;
export const LAND_SHAKE_ROLL_RAD = (0.8 * Math.PI) / 180;
/** Zoom (hold right mouse): FOV, mouse speed and head bob while fully zoomed */
export const ZOOM_FOV_DEG = 35;
export const ZOOM_SENSITIVITY = 0.5;
export const ZOOM_BOB = 0.3;
/** Climb (Space facing something low): height range above your feet, reach and climb time */
export const MANTLE_MIN_M = 0.3;
export const MANTLE_MAX_M = 0.95;
export const MANTLE_REACH_M = 0.7;
export const MANTLE_TIME_S = 0.4;
/** Take me there slows down over the last ARRIVE_SLOW_M metres, to at least ARRIVE_MIN_SPEED */
export const ARRIVE_SLOW_M = 1.0;
export const ARRIVE_MIN_SPEED = 0.5;
/** Lean into turns while auto-walking (radians of roll per rad/s of turning), capped at STRAFE_ROLL_RAD */
const TURN_ROLL_PER_RAD_S = 0.02;

/** Walk game feel settings (the Settings section in Help); saved per device by main.ts */
export interface WalkFeelSettings {
  headBob: boolean;
  /** Strafe and slide tilt, landing shake */
  tiltShake: boolean;
  /** Walk mode base field of view (degrees) */
  fovDeg: number;
  /** Mouse speed multiplier */
  sensitivity: number;
}
export const DEFAULT_FEEL_SETTINGS: WalkFeelSettings = {
  headBob: true,
  tiltShake: true,
  fovDeg: BASE_FOV_DEG,
  sensitivity: 1,
};

interface SlideState {
  t: number;
  dirX: number;
  dirZ: number;
  speed0: number;
}

interface MantleState {
  t: number;
  fromX: number;
  fromZ: number;
  fromY: number;
  toX: number;
  toZ: number;
  toH: number;
}

/** Search step and radius when entering walk mode at a spot the walking body does not fit */
const LAND_STEP_M = 0.05;
const LAND_RADIUS_M = 2;

interface LookAtTransition {
  startYaw: number;
  diffYaw: number;
  startPitch: number;
  diffPitch: number;
  durationS: number;
  elapsedS: number;
}

interface AutoWalkState {
  points: Point2[];
  targetIndex: number;
  stuckTimerS: number;
  stuckSampleX: number;
  stuckSampleZ: number;
  stuck?: boolean;
  onArrive?: () => void;
  onCancel?: (stuck?: boolean) => void;
}

export interface CameraOffset {
  /** Added to the camera height */
  y: number;
  /** Shift along the camera's right vector */
  side: number;
  fov: number;
  /** Walk game feel only: extra camera pitch (sprint dip, climb) and roll (lean, shake), radians */
  pitch?: number;
  roll?: number;
}

/**
 * Pure wall-sliding movement step function per SPEC.md Section 7 line 139:
 * 1. Clamps dt to max 0.05s.
 * 2. Evaluates combined diagonal move.
 * 3. Falls back to sliding along X or Z if diagonal is blocked.
 * 4. Stays in place if both axes are blocked.
 */
export function step(
  p: Pose3D,
  wish: Vec2,
  speed: number,
  dt: number,
  col: CollisionProvider
): Pose3D {
  const d = Math.max(0, Math.min(dt, MAX_DT));
  const nx = p.x + wish.x * speed * d;
  const nz = p.z + wish.z * speed * d;

  if (col.clearance) {
    return glide(p, nx - p.x, nz - p.z, col as Required<CollisionProvider>);
  }

  if (col.isFree(nx, nz)) {
    return { ...p, x: nx, z: nz };
  }
  if (col.isFree(nx, p.z)) {
    return { ...p, x: nx };
  }
  if (col.isFree(p.x, nz)) {
    return { ...p, z: nz };
  }
  return p;
}

/**
 * Smooth collision against a clearance field: move freely while clearance stays positive;
 * on contact, drop the part of the move that points into the obstacle (along the clearance
 * gradient) and glide along the edge. Falls back to single-axis moves, then stays put.
 */
function glide(p: Pose3D, mx: number, mz: number, col: Required<CollisionProvider>): Pose3D {
  const ok = (x: number, z: number): boolean => col.clearance(x, z) > 0;
  if (ok(p.x + mx, p.z + mz)) return { ...p, x: p.x + mx, z: p.z + mz };

  const h = 0.02;
  let gx = col.clearance(p.x + h, p.z) - col.clearance(p.x - h, p.z);
  let gz = col.clearance(p.x, p.z + h) - col.clearance(p.x, p.z - h);
  const len = Math.hypot(gx, gz);
  if (len > 1e-9) {
    gx /= len;
    gz /= len;
    const into = mx * gx + mz * gz;
    if (into < 0) {
      const sx = mx - into * gx, sz = mz - into * gz;
      if (ok(p.x + sx, p.z + sz)) return { ...p, x: p.x + sx, z: p.z + sz };
    }
  }
  if (ok(p.x + mx, p.z)) return { ...p, x: p.x + mx };
  if (ok(p.x, p.z + mz)) return { ...p, z: p.z + mz };
  return p;
}

export function clampToBounds(p: Pose3D, bounds: Bounds): Pose3D {
  return {
    ...p,
    x: Math.max(bounds.minX, Math.min(bounds.maxX, p.x)),
    z: Math.max(bounds.minZ, Math.min(bounds.maxZ, p.z)),
  };
}

export interface KeyState {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  sprint: boolean;
}

export interface MovementControllerOptions {
  startPose: Pose2D;
  eyeHeightM: number;
  collision: CollisionProvider;
  mouseSensitivity?: number;
  mode?: MoveMode;
  /** Walk mode: called at each footfall (sprint = true when running) */
  onFootstep?: (sprint: boolean) => void;
  /** Walk mode: called when a jump lands */
  onLand?: () => void;
  onReset?: () => void;
}

export class FirstPersonMovementController implements MovementController {
  private readonly _startPose: Pose2D;
  private readonly _eyeHeight: number;
  private _collision: CollisionProvider;
  private _mouseSensitivity: number;

  private _pose: Pose3D;
  private _currentSpeed = 0;

  private _keys: KeyState = {
    forward: false,
    backward: false,
    left: false,
    right: false,
    sprint: false,
  };

  private _cleanupFns: (() => void)[] = [];
  /** On-screen joystick (phones): forward and right in -1..1, added to the keys */
  private _analog = { forward: 0, right: 0 };
  private _analogSprint = false;
  private _rise = false;
  private _sink = false;
  private _heightOffset = 0;
  private _flying = false;
  private _mode: MoveMode = 'free';
  private _bobPhase = 0;
  private _bobAmp = 0;
  private _offset: CameraOffset = { y: 0, side: 0, fov: BASE_FOV_DEG };
  onFootstep?: (sprint: boolean) => void;
  onLand?: () => void;
  private readonly _onReset?: () => void;
  private _jumpHeld = false;
  /** A new jump needs a fresh Space press: holding Space does not repeat */
  private _jumpArmed = true;
  private _jumpHeight = 0;
  private _vy = 0;
  private _landDip = 0;
  private _lookAtTransition: LookAtTransition | null = null;
  private _autoWalk: AutoWalkState | null = null;

  // Walk game feel state (unused while game feel is off)
  private _gameFeel = false;
  private _feel: WalkFeelSettings = { ...DEFAULT_FEEL_SETTINGS };
  private _clock = 0;
  private _crouchHeld = false;
  private _zoomHeld = false;
  private _zoomBlend = 0;
  /** Current eye height above the ground under you (eases for crouch and slide) */
  private _eyeNow: number;
  /** Height of what you stand on (0 = floor; > 0 after climbing onto furniture) */
  private _groundH = 0;
  private _tacT = 0;
  private _tacCooldown = 0;
  private _lastShiftPress = -Infinity;
  private _slide: SlideState | null = null;
  private _mantle: MantleState | null = null;
  private _roll = 0;
  private _pitchDip = 0;
  private _shakeT = 0;
  private _airTime = 0;
  /** True while falling off furniture toward the floor (collision stays height-aware until landing) */
  private _liftedFall = false;
  private _fovNow = BASE_FOV_DEG;

  constructor(options: MovementControllerOptions) {
    this._startPose = options.startPose;
    this._eyeHeight = options.eyeHeightM;
    this._collision = options.collision;
    this._mouseSensitivity = options.mouseSensitivity ?? 0.002;
    this._onReset = options.onReset;
    this.onFootstep = options.onFootstep;
    this.onLand = options.onLand;
    this._eyeNow = this._eyeHeight;

    this._pose = {
      x: this._startPose.x,
      y: this._eyeHeight,
      z: this._startPose.z,
      yaw: (this._startPose.yaw_deg * Math.PI) / 180,
      pitch: 0,
    };

    // Clamp initial pose to bounds
    this._pose = clampToBounds(this._pose, this._collision.bounds());
    if (options.mode === 'walk') this.setMode('walk');
  }

  get mode(): MoveMode {
    return this._mode;
  }

  /** Camera-only offsets (head bob, sprint FOV); all zero / BASE_FOV_DEG in free roam. */
  get cameraOffset(): CameraOffset {
    return { ...this._offset };
  }

  /**
   * Switch movement mode. Entering walk drops to eye height; if the walking body does not fit
   * there (e.g. flying over a bunk) it moves to the nearest spot that fits, else resets.
   */
  setMode(mode: MoveMode): void {
    // Standing on furniture in Walk: Free roam keeps that height (as if flown there)
    const liftedY = this._mode === 'walk' && this._groundH > 0 ? this._pose.y : null;
    this._resetFeelState();
    this._mode = mode;
    this._bobAmp = 0;
    this._cancelJump();
    this._offset = { y: 0, side: 0, fov: BASE_FOV_DEG };
    if (mode === 'free') {
      if (liftedY !== null) {
        this._heightOffset = Math.max(MIN_EYE_M, Math.min(MAX_EYE_M, liftedY)) - this._eyeHeight;
        this._flying = true;
        this._pose.y = this._eyeHeight + this._heightOffset;
        this._collision.setFlight?.(this._pose.y);
      }
      return;
    }
    this._rise = false;
    this._sink = false;
    this._heightOffset = 0;
    this._flying = false;
    this._collision.setFlight?.(null);
    this._pose.y = this._eyeHeight;
    const spot = this._nearestWalkable(this._pose.x, this._pose.z);
    if (spot) {
      this._pose.x = spot.x;
      this._pose.z = spot.z;
    } else {
      this.reset();
    }
  }

  /** True while a Walk-mode jump is in the air */
  get airborne(): boolean {
    return this._jumpHeight > 0 || this._vy > 0;
  }

  /**
   * Walk game feel on or off. main.ts turns it on for laptops outside tag mode; off keeps
   * Walk mode exactly as it was. Free roam never uses it.
   */
  setGameFeel(on: boolean): void {
    if (this._gameFeel === on) return;
    if (this._mode === 'walk' && this._groundH > 0) this._dropToFloor();
    this._resetFeelState();
    this._gameFeel = on;
    if (this._mode === 'walk') this._offset = { y: 0, side: 0, fov: BASE_FOV_DEG };
  }

  /** True when Walk mode is using the game feel */
  get feelActive(): boolean {
    return this._gameFeel && this._mode === 'walk';
  }

  setFeelSettings(s: Partial<WalkFeelSettings>): void {
    this._feel = { ...this._feel, ...s };
  }

  get feelSettings(): WalkFeelSettings {
    return { ...this._feel };
  }

  get crouching(): boolean {
    return this.feelActive && this._crouchHeld && !this._slide;
  }

  get sliding(): boolean {
    return this._slide !== null;
  }

  get climbing(): boolean {
    return this._mantle !== null;
  }

  get tacticalSprinting(): boolean {
    return this._tacT > 0;
  }

  /** Height of what you stand on (0 on the floor) */
  get groundHeight(): number {
    return this._groundH;
  }

  /**
   * Eye height above your own feet right now: lower while crouching or sliding, the plain eye
   * height otherwise. Multiplayer uses it so other players see your feet on the ground.
   */
  get eyeAboveFeet(): number {
    return this._mode === 'walk' ? this._eyeNow : this._eyeHeight;
  }

  /** Hold or release zoom (right mouse). Only does something with game feel on. */
  setZoom(held: boolean): void {
    this._zoomHeld = held && this.feelActive;
  }

  /** Small camera settle (arriving at a place) */
  settle(): void {
    if (this.feelActive) this._landDip = Math.max(this._landDip, 0.03);
  }

  private _resetFeelState(): void {
    this._crouchHeld = false;
    this._zoomHeld = false;
    this._zoomBlend = 0;
    this._eyeNow = this._eyeHeight;
    this._groundH = 0;
    this._tacT = 0;
    this._tacCooldown = 0;
    this._slide = null;
    this._mantle = null;
    this._roll = 0;
    this._pitchDip = 0;
    this._shakeT = 0;
    this._airTime = 0;
    this._liftedFall = false;
    this._fovNow = this._feel.fovDeg;
  }

  /** Off the furniture and back on the floor at the nearest spot the walking body fits */
  private _dropToFloor(): void {
    this._groundH = 0;
    this._mantle = null;
    this._liftedFall = false;
    this._cancelJump();
    this._collision.setFlight?.(null);
    this._pose.y = this._eyeHeight;
    const spot = this._nearestWalkable(this._pose.x, this._pose.z);
    if (spot) {
      this._pose.x = spot.x;
      this._pose.z = spot.z;
    }
  }

  private _cancelJump(): void {
    this._jumpHeight = 0;
    this._vy = 0;
    this._landDip = 0;
  }

  private _fits(x: number, z: number): boolean {
    const col = this._collision;
    const b = col.bounds();
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) return false;
    return col.clearance ? col.clearance(x, z) > 0 : col.isFree(x, z);
  }

  private _nearestWalkable(x: number, z: number): Vec2 | null {
    if (this._fits(x, z)) return { x, z };
    for (let r = LAND_STEP_M; r <= LAND_RADIUS_M + 1e-9; r += LAND_STEP_M) {
      const n = Math.max(8, Math.ceil((2 * Math.PI * r) / LAND_STEP_M));
      for (let i = 0; i < n; i++) {
        const a = (2 * Math.PI * i) / n;
        const px = x + r * Math.cos(a), pz = z + r * Math.sin(a);
        if (this._fits(px, pz)) return { x: px, z: pz };
      }
    }
    return null;
  }

  get pose(): Pose3D {
    return { ...this._pose };
  }

  setPose(p: Partial<Pose3D>): void {
    if (p.x !== undefined) this._pose.x = p.x;
    if (p.y !== undefined) this._pose.y = p.y;
    if (p.z !== undefined) this._pose.z = p.z;
    if (p.yaw !== undefined) this._pose.yaw = p.yaw;
    if (p.pitch !== undefined) this._pose.pitch = p.pitch;
  }

  /**
   * Smoothly turns camera yaw and pitch to face target world point (x, y, z) over durationS.
   * Eased with ease-in-out along shortest yaw direction across ±π, with pitch clamped.
   * Mouse movement during transition cancels it. Does not move position.
   */
  lookAt(x: number, y: number, z: number, durationS = 0.6): void {
    const dx = x - this._pose.x;
    const dy = y - this._pose.y;
    const dz = z - this._pose.z;

    const targetYaw = Math.atan2(-dx, -dz);
    const horizDist = Math.hypot(dx, dz);
    const rawTargetPitch = Math.atan2(dy, horizDist);
    const targetPitch = Math.max(-MAX_PITCH_RAD, Math.min(MAX_PITCH_RAD, rawTargetPitch));

    let diffYaw = targetYaw - this._pose.yaw;
    while (diffYaw > Math.PI) diffYaw -= 2 * Math.PI;
    while (diffYaw < -Math.PI) diffYaw += 2 * Math.PI;

    const diffPitch = targetPitch - this._pose.pitch;

    if (durationS <= 0) {
      this._pose.yaw += diffYaw;
      while (this._pose.yaw > Math.PI) this._pose.yaw -= 2 * Math.PI;
      while (this._pose.yaw < -Math.PI) this._pose.yaw += 2 * Math.PI;
      this._pose.pitch = targetPitch;
      this._lookAtTransition = null;
      return;
    }

    this._lookAtTransition = {
      startYaw: this._pose.yaw,
      diffYaw,
      startPitch: this._pose.pitch,
      diffPitch,
      durationS,
      elapsedS: 0,
    };
  }

  /**
   * Auto-walks the camera along the path waypoints at walking speed (1.4 m/s),
   * facing along the path with collision enabled. Any WASD key or mouse look cancels it.
   */
  startAutoWalk(points: Point2[], onArrive?: () => void, onCancel?: (stuck?: boolean) => void): void {
    if (!points || points.length < 2) return;
    this.clearKeys();
    this._lookAtTransition = null;
    if (this.feelActive) {
      if (this._groundH > 0) this._dropToFloor();
      this._slide = null;
      this._mantle = null;
      this._tacT = 0;
    }
    this._autoWalk = {
      points,
      targetIndex: 1,
      stuckTimerS: 0,
      stuckSampleX: this._pose.x,
      stuckSampleZ: this._pose.z,
      onArrive,
      onCancel,
    };
  }

  stopAutoWalk(canceled = false, stuck = false): void {
    if (!this._autoWalk) return;
    const wasStuck = stuck || (this._autoWalk.stuck ?? false);
    const cb = canceled ? this._autoWalk.onCancel : this._autoWalk.onArrive;
    this._autoWalk = null;
    this._currentSpeed = 0;
    cb?.(wasStuck);
  }

  get isAutoWalking(): boolean {
    return this._autoWalk !== null;
  }

  get currentSpeed(): number {
    return this._currentSpeed;
  }

  get keys(): Readonly<KeyState> {
    return { ...this._keys };
  }

  setCollision(col: CollisionProvider): void {
    this._collision = col;
    col.setFlight?.(this._flying ? this._pose.y : null);
  }

  /** True after Q/E changed the height (until Reset). */
  get flying(): boolean {
    return this._flying;
  }

  getCollision(): CollisionProvider {
    return this._collision;
  }

  /**
   * Touch joystick input: forward and right in -1..1 (length up to 1). The stick's tilt sets the
   * speed, from a slow creep up to walking pace; sprint = true runs (thumb pulled past the ring).
   */
  setAnalog(forward: number, right: number, sprint = false): void {
    const len = Math.hypot(forward, right);
    const k = len > 1 ? 1 / len : 1;
    const f = forward * k, r = right * k;
    if (this._autoWalk && len > 0.2) this.stopAutoWalk(true);
    this._analog.forward = f;
    this._analog.right = r;
    this._analogSprint = sprint && len > 0.2;
  }

  /** Touch buttons for Free roam up / down (same as holding E / Q) */
  setVertical(rise: boolean, sink: boolean): void {
    this._rise = rise;
    this._sink = sink;
  }

  /** Touch button for jump in Walk mode (same as Space) */
  setJump(held: boolean): void {
    this._jumpHeld = held;
    if (!held) this._jumpArmed = true;
  }

  clearKeys(): void {
    this._analog.forward = 0;
    this._analog.right = 0;
    this._analogSprint = false;
    this._keys.forward = false;
    this._keys.backward = false;
    this._keys.left = false;
    this._keys.right = false;
    this._keys.sprint = false;
    this._rise = false;
    this._sink = false;
    this._jumpHeld = false;
    this._jumpArmed = true;
    this._crouchHeld = false;
    this._zoomHeld = false;
  }

  reset(): void {
    this.clearKeys();
    this._lookAtTransition = null;
    if (this._autoWalk) this.stopAutoWalk(true);
    this._currentSpeed = 0;
    this._heightOffset = 0;
    this._flying = false;
    this._collision.setFlight?.(null);
    this._pose = {
      x: this._startPose.x,
      y: this._eyeHeight,
      z: this._startPose.z,
      yaw: (this._startPose.yaw_deg * Math.PI) / 180,
      pitch: 0,
    };
    this._pose = clampToBounds(this._pose, this._collision.bounds());
    this._bobAmp = 0;
    this._cancelJump();
    this._resetFeelState();
    if (this._mode === 'walk') this._offset = { y: 0, side: 0, fov: BASE_FOV_DEG };
    this._onReset?.();
  }

  handleKeyDown(code: string): void {
    if (this._autoWalk) {
      switch (code) {
        case 'KeyW':
        case 'ArrowUp':
        case 'KeyS':
        case 'ArrowDown':
        case 'KeyA':
        case 'ArrowLeft':
        case 'KeyD':
        case 'ArrowRight':
        case 'Space':
          this.stopAutoWalk(true);
          break;
      }
    }
    switch (code) {
      case 'KeyW':
      case 'ArrowUp':
        this._keys.forward = true;
        break;
      case 'KeyS':
      case 'ArrowDown':
        this._keys.backward = true;
        break;
      case 'KeyA':
      case 'ArrowLeft':
        this._keys.left = true;
        break;
      case 'KeyD':
      case 'ArrowRight':
        this._keys.right = true;
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        // A fresh press (not key repeat) twice within TAC_DOUBLE_TAP_S starts a tactical sprint
        if (this.feelActive && !this._keys.sprint) {
          if (this._clock - this._lastShiftPress <= TAC_DOUBLE_TAP_S && this._tacCooldown <= 0) {
            this._tacT = TAC_DURATION_S;
            this._lastShiftPress = -Infinity;
          } else {
            this._lastShiftPress = this._clock;
          }
        }
        this._keys.sprint = true;
        break;
      case 'KeyC':
        if (this.feelActive && !this._crouchHeld) {
          this._crouchHeld = true;
          this._tryStartSlide();
        }
        break;
      case 'KeyE':
        this._rise = true;
        break;
      case 'KeyQ':
        this._sink = true;
        break;
      case 'Space':
        this._jumpHeld = true;
        break;
      case 'KeyR':
        this.reset();
        break;
    }
  }

  handleKeyUp(code: string): void {
    switch (code) {
      case 'KeyW':
      case 'ArrowUp':
        this._keys.forward = false;
        break;
      case 'KeyS':
      case 'ArrowDown':
        this._keys.backward = false;
        break;
      case 'KeyA':
      case 'ArrowLeft':
        this._keys.left = false;
        break;
      case 'KeyD':
      case 'ArrowRight':
        this._keys.right = false;
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        this._keys.sprint = false;
        break;
      case 'KeyC':
        this._crouchHeld = false;
        break;
      case 'KeyE':
        this._rise = false;
        break;
      case 'KeyQ':
        this._sink = false;
        break;
      case 'Space':
        this._jumpHeld = false;
        this._jumpArmed = true;
        break;
    }
  }

  handleMouseMove(deltaX: number, deltaY: number): void {
    if (deltaX !== 0 || deltaY !== 0) {
      this._lookAtTransition = null;
      if (this._autoWalk) this.stopAutoWalk(true);
    }
    // Walk game feel: settings multiplier, slower while zoomed
    const sens = this.feelActive
      ? this._mouseSensitivity * this._feel.sensitivity * (1 - (1 - ZOOM_SENSITIVITY) * this._zoomBlend)
      : this._mouseSensitivity;

    // Mouse X controls horizontal yaw
    this._pose.yaw -= deltaX * sens;

    // Mouse Y controls vertical pitch
    this._pose.pitch -= deltaY * sens;

    // Clamp pitch to [-85 deg, +85 deg]
    this._pose.pitch = Math.max(-MAX_PITCH_RAD, Math.min(MAX_PITCH_RAD, this._pose.pitch));
  }

  attachDomListeners(targetElement: HTMLElement): void {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e)) return;
      // Don't intercept browser shortcuts if modifier keys other than Shift are held
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      this.handleKeyDown(e.code);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      this.handleKeyUp(e.code);
    };

    const onBlur = () => {
      this.clearKeys();
    };

    const onPointerLockChange = () => {
      if (document.pointerLockElement !== targetElement) {
        this.clearKeys();
      }
    };

    const onMouseMove = (e: MouseEvent) => {
      if (document.pointerLockElement === targetElement) {
        this.handleMouseMove(e.movementX, e.movementY);
      }
    };

    // Walk game feel: hold the right mouse button to zoom (only while the mouse is locked)
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 2 && document.pointerLockElement === targetElement) this.setZoom(true);
    };
    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 2) this.setZoom(false);
    };
    const onContextMenu = (e: MouseEvent) => {
      if (document.pointerLockElement === targetElement) e.preventDefault();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    document.addEventListener('pointerlockchange', onPointerLockChange);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('contextmenu', onContextMenu);

    this._cleanupFns.push(() => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('contextmenu', onContextMenu);
    });
  }

  dispose(): void {
    for (const cleanup of this._cleanupFns) {
      cleanup();
    }
    this._cleanupFns = [];
    this.clearKeys();
  }

  update(dt: number): void {
    const effectiveDt = Math.max(0, Math.min(dt, MAX_DT));
    if (this.feelActive) this._clock += effectiveDt;

    // 1. Smooth lookAt transition
    if (this._lookAtTransition) {
      this._lookAtTransition.elapsedS += effectiveDt;
      const t = Math.min(1.0, this._lookAtTransition.elapsedS / this._lookAtTransition.durationS);
      const ease = 0.5 * (1 - Math.cos(Math.PI * t));
      this._pose.yaw = this._lookAtTransition.startYaw + this._lookAtTransition.diffYaw * ease;
      this._pose.pitch = this._lookAtTransition.startPitch + this._lookAtTransition.diffPitch * ease;
      if (t >= 1.0) {
        this._pose.yaw = this._lookAtTransition.startYaw + this._lookAtTransition.diffYaw;
        while (this._pose.yaw > Math.PI) this._pose.yaw -= 2 * Math.PI;
        while (this._pose.yaw < -Math.PI) this._pose.yaw += 2 * Math.PI;
        this._pose.pitch = this._lookAtTransition.startPitch + this._lookAtTransition.diffPitch;
        this._lookAtTransition = null;
      }
    }

    // 2. Auto-walk along path points
    if (this._autoWalk) {
      const pts = this._autoWalk.points;
      let target = pts[this._autoWalk.targetIndex];
      let dx = target.x - this._pose.x;
      let dz = target.z - this._pose.z;
      let dist = Math.hypot(dx, dz);

      while (dist < 0.25 && this._autoWalk.targetIndex < pts.length - 1) {
        this._autoWalk.targetIndex++;
        target = pts[this._autoWalk.targetIndex];
        dx = target.x - this._pose.x;
        dz = target.z - this._pose.z;
        dist = Math.hypot(dx, dz);
      }

      const isFinalWaypoint = this._autoWalk.targetIndex === pts.length - 1;
      if (isFinalWaypoint && dist < 0.45) {
        this.stopAutoWalk(false);
      } else if (dist > 0.001) {
        const wishX = dx / dist;
        const wishZ = dz / dist;
        const wish: Vec2 = { x: wishX, z: wishZ };

        // Smoothly face along the path
        const targetYaw = Math.atan2(-wishX, -wishZ);
        let diffYaw = targetYaw - this._pose.yaw;
        while (diffYaw > Math.PI) diffYaw -= 2 * Math.PI;
        while (diffYaw < -Math.PI) diffYaw += 2 * Math.PI;
        const turnAlpha = 1 - Math.exp(-effectiveDt / 0.12);
        this._pose.yaw += diffYaw * turnAlpha;
        this._pose.pitch += (0 - this._pose.pitch) * turnAlpha;

        // Walk game feel: ease off over the last metre instead of stopping dead
        let walkSpeed = WALK_SPEED;
        if (this.feelActive) {
          let left = dist;
          for (let i = this._autoWalk.targetIndex + 1; i < pts.length; i++) {
            left += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
          }
          walkSpeed = Math.max(ARRIVE_MIN_SPEED, Math.min(WALK_SPEED, WALK_SPEED * Math.sqrt(left / ARRIVE_SLOW_M)));
        }

        const startX = this._pose.x, startZ = this._pose.z;
        const newPose = step(this._pose, wish, walkSpeed, effectiveDt, this._collision);
        this._pose.x = newPose.x;
        this._pose.z = newPose.z;

        const clamped = clampToBounds(this._pose, this._collision.bounds());
        this._pose.x = clamped.x;
        this._pose.z = clamped.z;
        this._currentSpeed = walkSpeed;

        // Stuck detection: if walker moves less than 0.05m in total over 1.5s while auto-walking, stop
        const distFromSample = Math.hypot(
          this._pose.x - this._autoWalk.stuckSampleX,
          this._pose.z - this._autoWalk.stuckSampleZ
        );
        if (distFromSample >= 0.05) {
          this._autoWalk.stuckSampleX = this._pose.x;
          this._autoWalk.stuckSampleZ = this._pose.z;
          this._autoWalk.stuckTimerS = 0;
        } else {
          this._autoWalk.stuckTimerS += effectiveDt;
          if (this._autoWalk.stuckTimerS >= 1.5) {
            this._autoWalk.stuck = true;
            this.stopAutoWalk(true);
            return;
          }
        }

        if (this.feelActive) {
          const moved = Math.hypot(this._pose.x - startX, this._pose.z - startZ);
          this._eyeNow += (this._eyeHeight - this._eyeNow) * (1 - Math.exp(-effectiveDt / EYE_EASE_S));
          this._pose.y = this._eyeNow;
          this._updateWalkFeel(moved, effectiveDt);
          // Lean into the turns along the path
          const yawRate = effectiveDt > 0 ? (diffYaw * turnAlpha) / effectiveDt : 0;
          const lean = Math.max(-STRAFE_ROLL_RAD, Math.min(STRAFE_ROLL_RAD, yawRate * TURN_ROLL_PER_RAD_S));
          this._feelCamera(moved, effectiveDt, lean, false);
          return;
        } else if (this._mode === 'walk') {
          this._updateJump(effectiveDt);
          this._pose.y = this._eyeHeight + this._jumpHeight;
          this._updateWalkFeel(Math.hypot(this._pose.x - startX, this._pose.z - startZ), effectiveDt);
          return;
        } else {
          this._pose.y = this._eyeHeight + this._heightOffset;
          return;
        }
      }
    }

    if (this.feelActive) {
      this._updateFeel(effectiveDt);
      return;
    }

    // Calculate movement intent along camera axes
    let moveForward = 0;
    let moveRight = 0;

    if (this._keys.forward) moveForward += 1;
    if (this._keys.backward) moveForward -= 1;
    if (this._keys.right) moveRight += 1;
    if (this._keys.left) moveRight -= 1;

    // Joystick: its tilt scales the speed (keys always go full walking pace)
    const keyMoving = moveForward !== 0 || moveRight !== 0;
    const stick = Math.hypot(this._analog.forward, this._analog.right);
    let speedScale = 1;
    let stickSprint = false;
    if (!keyMoving && stick > 0.08) {
      moveForward = this._analog.forward;
      moveRight = this._analog.right;
      speedScale = Math.min(1, 0.25 + stick);
      stickSprint = this._analogSprint;
    }

    const isMoving = moveForward !== 0 || moveRight !== 0;
    const sprinting = this._keys.sprint || stickSprint;
    const targetSpeed = isMoving ? (sprinting ? SPRINT_SPEED : WALK_SPEED * speedScale) : 0;

    // 0.15s smoothing filter (walk mode: slower speed-up, quicker stop)
    if (effectiveDt > 0) {
      const tau = this._mode === 'free' ? SMOOTHING_TIME_S
        : targetSpeed > this._currentSpeed ? WALK_ACCEL_S : WALK_DECEL_S;
      const alpha = 1 - Math.exp(-effectiveDt / tau);
      this._currentSpeed += (targetSpeed - this._currentSpeed) * alpha;
      if (targetSpeed === 0 && this._currentSpeed < 0.005) {
        this._currentSpeed = 0;
      }
    }

    const startX = this._pose.x, startZ = this._pose.z;
    if (this._currentSpeed > 0.001 && isMoving) {
      // In Three.js coordinates, camera forward at yaw=0 is (0, 0, -1) and right is (1, 0, 0)
      const sinYaw = Math.sin(this._pose.yaw);
      const cosYaw = Math.cos(this._pose.yaw);

      const fwdX = -sinYaw;
      const fwdZ = -cosYaw;
      const rgtX = cosYaw;
      const rgtZ = -sinYaw;

      let wishX = fwdX * moveForward + rgtX * moveRight;
      let wishZ = fwdZ * moveForward + rgtZ * moveRight;

      const len = Math.hypot(wishX, wishZ);
      if (len > 0) {
        wishX /= len;
        wishZ /= len;
      }

      const wish: Vec2 = { x: wishX, z: wishZ };
      const newPose = step(this._pose, wish, this._currentSpeed, effectiveDt, this._collision);
      this._pose.x = newPose.x;
      this._pose.z = newPose.z;
    }

    // Always keep position clamped to bounds
    const clamped = clampToBounds(this._pose, this._collision.bounds());
    this._pose.x = clamped.x;
    this._pose.z = clamped.z;

    // Walk mode: fixed eye height (Q/E ignored), camera-only bob and FOV
    if (this._mode === 'walk') {
      this._updateJump(effectiveDt);
      this._pose.y = this._eyeHeight + this._jumpHeight;
      this._updateWalkFeel(Math.hypot(this._pose.x - startX, this._pose.z - startZ), effectiveDt);
      return;
    }

    // Camera Y is eye_height_m plus the Q/E offset, kept within [MIN_EYE_M, MAX_EYE_M].
    // A height is only taken when the flying body fits there (no rising into a bunk or the ceiling).
    const vertical = (this._rise ? 1 : 0) - (this._sink ? 1 : 0);
    if (vertical !== 0) {
      const next = Math.max(MIN_EYE_M - this._eyeHeight,
        Math.min(MAX_EYE_M - this._eyeHeight, this._heightOffset + vertical * VERTICAL_SPEED * effectiveDt));
      const col = this._collision;
      const y = this._eyeHeight + next;
      if (!col.clearanceAt || col.clearanceAt(this._pose.x, this._pose.z, y) > 0) {
        this._heightOffset = next;
        this._flying = true;
      }
    }
    this._pose.y = this._eyeHeight + this._heightOffset;
    if (this._flying) this._collision.setFlight?.(this._pose.y);
  }

  /** Walk-mode jump: take off on a fresh Space press from the ground, fall with gravity, stop at the ceiling. */
  private _updateJump(dt: number): void {
    const maxHeight = MAX_EYE_M - this._eyeHeight;
    if (this._jumpHeld && this._jumpArmed && !this.airborne && maxHeight > 0) {
      this._vy = JUMP_SPEED;
      this._jumpArmed = false;
    }
    if (!this.airborne || dt <= 0) return;
    this._vy -= GRAVITY * dt;
    this._jumpHeight += this._vy * dt;
    if (this._jumpHeight >= maxHeight) {
      this._jumpHeight = maxHeight;
      this._vy = Math.min(this._vy, 0);
    }
    if (this._jumpHeight <= 0) {
      this._jumpHeight = 0;
      this._vy = 0;
      this._landDip = LAND_DIP_M;
      this.onLand?.();
    }
  }

  /** Head bob, sway, footfalls and sprint FOV from the distance actually moved this frame. */
  private _updateWalkFeel(moved: number, dt: number, noSteps = false): void {
    if (dt <= 0) return;
    const speed = moved / dt;
    const air = this.airborne || noSteps;
    const sprinting = speed > WALK_SPEED * 1.1;
    // No bob or footsteps in the air: the bob fades out during a jump
    const targetAmp = air ? 0 : Math.min(speed / WALK_SPEED, 1.3);
    this._bobAmp += (targetAmp - this._bobAmp) * (1 - Math.exp(-dt / 0.12));
    if (this._bobAmp < 0.002) this._bobAmp = 0;

    if (speed > 0.05 && !air) {
      const t = Math.min(1, Math.max(0, (speed - WALK_SPEED) / (SPRINT_SPEED - WALK_SPEED)));
      const stepsPerS = STEPS_PER_S_WALK + (STEPS_PER_S_SPRINT - STEPS_PER_S_WALK) * t;
      // One step per PI of phase; the camera is lowest (footfall) at PI/2 + k*PI
      const before = Math.floor(this._bobPhase / Math.PI - 0.5);
      this._bobPhase += Math.PI * stepsPerS * dt;
      const after = Math.floor(this._bobPhase / Math.PI - 0.5);
      if (after > before && this._bobAmp > 0.3) this.onFootstep?.(sprinting);
      if (this._bobPhase > 1e4) this._bobPhase %= 2 * Math.PI;
    }

    const fovTarget = sprinting ? SPRINT_FOV_DEG : BASE_FOV_DEG;
    const fov = this._offset.fov + (fovTarget - this._offset.fov) * (1 - Math.exp(-dt / 0.2));
    this._landDip *= Math.exp(-dt / 0.05);
    if (this._landDip < 1e-4) this._landDip = 0;
    this._offset = {
      y: BOB_Y_M * this._bobAmp * Math.cos(2 * this._bobPhase) - this._landDip,
      side: BOB_SIDE_M * this._bobAmp * Math.sin(this._bobPhase),
      fov: Math.abs(fov - fovTarget) < 0.01 ? fovTarget : fov,
    };
  }

  // ---------------------------------------------------------------------------
  // Walk game feel
  // ---------------------------------------------------------------------------

  /** Walk-mode frame with game feel: input, sprint / tactical / crouch / slide, climb, jump, camera. */
  private _updateFeel(dt: number): void {
    if (this._tacCooldown > 0) this._tacCooldown = Math.max(0, this._tacCooldown - dt);

    // A climb owns the body until it finishes
    if (this._mantle) {
      this._stepMantle(dt);
      this._updateWalkFeel(0, dt, true);
      this._feelCamera(0, dt, 0, false);
      return;
    }

    let moveForward = 0;
    let moveRight = 0;
    if (this._keys.forward) moveForward += 1;
    if (this._keys.backward) moveForward -= 1;
    if (this._keys.right) moveRight += 1;
    if (this._keys.left) moveRight -= 1;
    const isMoving = moveForward !== 0 || moveRight !== 0;
    const crouched = this._crouchHeld && !this._slide;

    // Tactical sprint: runs while Shift stays down and you keep going forward
    if (this._tacT > 0) {
      if (!this._keys.sprint || moveForward <= 0 || crouched) {
        this._tacT = 0;
        this._tacCooldown = TAC_COOLDOWN_S;
      } else {
        this._tacT -= dt;
        if (this._tacT <= 0) {
          this._tacT = 0;
          this._tacCooldown = TAC_COOLDOWN_S;
        }
      }
    }
    const sprinting = this._keys.sprint && !crouched;
    const targetSpeed = !isMoving ? 0
      : crouched ? CROUCH_SPEED
      : this._tacT > 0 ? TAC_SPEED
      : sprinting ? SPRINT_SPEED
      : WALK_SPEED;

    const startX = this._pose.x, startZ = this._pose.z;
    if (this._slide) {
      const sl = this._slide;
      sl.t += dt;
      const k = Math.min(1, sl.t / SLIDE_DURATION_S);
      const speed = sl.speed0 + (CROUCH_SPEED - sl.speed0) * k;
      const next = step(this._pose, { x: sl.dirX, z: sl.dirZ }, speed, dt, this._collision);
      const moved = Math.hypot(next.x - this._pose.x, next.z - this._pose.z);
      this._pose.x = next.x;
      this._pose.z = next.z;
      this._currentSpeed = speed;
      // Ends when time is up or a wall stops most of the slide
      if (k >= 1 || (dt > 0 && moved < 0.4 * speed * dt)) {
        this._slide = null;
        this._currentSpeed = Math.min(speed, this._crouchHeld ? CROUCH_SPEED : WALK_SPEED);
      }
    } else {
      if (dt > 0) {
        const tau = targetSpeed > this._currentSpeed
          ? (targetSpeed > WALK_SPEED ? FEEL_SPRINT_ACCEL_S : FEEL_ACCEL_S)
          : FEEL_DECEL_S;
        this._currentSpeed += (targetSpeed - this._currentSpeed) * (1 - Math.exp(-dt / tau));
        if (targetSpeed === 0 && this._currentSpeed < 0.005) this._currentSpeed = 0;
      }
      if (this._currentSpeed > 0.001 && isMoving) {
        const sinYaw = Math.sin(this._pose.yaw);
        const cosYaw = Math.cos(this._pose.yaw);
        let wishX = -sinYaw * moveForward + cosYaw * moveRight;
        let wishZ = -cosYaw * moveForward - sinYaw * moveRight;
        const len = Math.hypot(wishX, wishZ);
        if (len > 0) {
          wishX /= len;
          wishZ /= len;
        }
        const next = step(this._pose, { x: wishX, z: wishZ }, this._currentSpeed, dt, this._collision);
        this._pose.x = next.x;
        this._pose.z = next.z;
      }
    }

    const clamped = clampToBounds(this._pose, this._collision.bounds());
    this._pose.x = clamped.x;
    this._pose.z = clamped.z;

    this._checkSupport();
    this._updateJumpFeel(dt);

    const eyeTarget = Math.min(this._eyeHeight,
      this._slide ? SLIDE_EYE_M : this._crouchHeld ? CROUCH_EYE_M : this._eyeHeight);
    this._eyeNow += (eyeTarget - this._eyeNow) * (1 - Math.exp(-dt / EYE_EASE_S));
    if (this._mantle) return; // climb started this frame; it sets the height next frame
    this._pose.y = this._groundH + this._eyeNow + this._jumpHeight;
    if (this._groundH > 0 || this._liftedFall) {
      this._collision.setFlight?.(this._pose.y);
    }

    const moved = Math.hypot(this._pose.x - startX, this._pose.z - startZ);
    this._updateWalkFeel(moved, dt, this._slide !== null);
    const speedK = Math.min(1, this._currentSpeed / WALK_SPEED);
    const lean = (isMoving && !this._slide ? -moveRight * STRAFE_ROLL_RAD * speedK : 0)
      + (this._slide ? SLIDE_ROLL_RAD : 0);
    this._feelCamera(moved, dt, lean, sprinting && isMoving && !this._slide);
  }

  /** C while sprinting forward on the ground starts a slide */
  private _tryStartSlide(): void {
    if (this._slide || this._mantle || this.airborne || this._autoWalk) return;
    const fast = this._currentSpeed > WALK_SPEED * 1.15;
    if (!this._keys.sprint || !this._keys.forward || !fast) return;
    let dirX = -Math.sin(this._pose.yaw) * 1;
    let dirZ = -Math.cos(this._pose.yaw) * 1;
    if (this._keys.right) { dirX += Math.cos(this._pose.yaw); dirZ -= Math.sin(this._pose.yaw); }
    if (this._keys.left) { dirX -= Math.cos(this._pose.yaw); dirZ += Math.sin(this._pose.yaw); }
    const len = Math.hypot(dirX, dirZ);
    this._slide = {
      t: 0,
      dirX: dirX / len,
      dirZ: dirZ / len,
      speed0: Math.min(SLIDE_MAX_SPEED, this._currentSpeed * SLIDE_BOOST),
    };
    this._tacT = 0;
  }

  /** On furniture with nothing under your feet any more: fall to whatever is below */
  private _checkSupport(): void {
    const col = this._collision;
    if (this._groundH <= 0 || this.airborne || !col.topAt) return;
    const below = col.topAt(this._pose.x, this._pose.z, this._groundH + 0.2);
    if (below === Infinity || below >= this._groundH - 0.1) return;
    // Walked off the edge
    this._jumpHeight = this._groundH - below;
    this._vy = 0;
    this._airTime = 0;
    this._groundH = below;
    this._liftedFall = true;
  }

  /** Jump (or climb, when something low is right in front) with gravity and a landing scaled by air time */
  private _updateJumpFeel(dt: number): void {
    const capTop = Math.max(MAX_EYE_M, this._groundH + this._eyeHeight + 0.3);
    const maxHeight = Math.max(0, capTop - (this._groundH + this._eyeNow));
    if (this._jumpHeld && this._jumpArmed && !this.airborne && !this._slide) {
      this._jumpArmed = false;
      if (this._tryMantle()) return;
      if (maxHeight > 0) {
        this._vy = JUMP_SPEED;
        this._airTime = 0;
        this._crouchHeld = false; // jumping stands you up
      }
    }
    if (!this.airborne || dt <= 0) return;
    this._airTime += dt;
    this._vy -= GRAVITY * dt;
    this._jumpHeight += this._vy * dt;
    if (this._jumpHeight >= maxHeight) {
      this._jumpHeight = maxHeight;
      this._vy = Math.min(this._vy, 0);
    }
    if (this._jumpHeight <= 0) {
      this._jumpHeight = 0;
      this._vy = 0;
      const strength = Math.min(1, this._airTime / 0.6);
      this._landDip = LAND_DIP_M + (HEAVY_LAND_DIP_M - LAND_DIP_M) * strength;
      this._shakeT = LAND_SHAKE_S * strength;
      this._airTime = 0;
      if (this._liftedFall && this._groundH <= 0) {
        // Back on the floor: full walking body again, nudged clear of the furniture edge
        this._liftedFall = false;
        this._collision.setFlight?.(null);
        const spot = this._nearestWalkable(this._pose.x, this._pose.z);
        if (spot) {
          this._pose.x = spot.x;
          this._pose.z = spot.z;
        }
      } else if (this._groundH > 0) {
        this._liftedFall = false;
      }
      this.onLand?.();
    }
  }

  /** Space facing something knee-to-waist high with room on top: climb onto it instead of jumping */
  private _tryMantle(): boolean {
    const col = this._collision;
    if (!col.topAt || !col.clearanceAt || this._crouchHeld) return false;
    const fx = -Math.sin(this._pose.yaw), fz = -Math.cos(this._pose.yaw);
    const b = col.bounds();
    const inside = (x: number, z: number) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
    for (let d = 0.3; d <= MANTLE_REACH_M + 1e-9; d += 0.1) {
      const px = this._pose.x + fx * d, pz = this._pose.z + fz * d;
      const top = col.topAt(px, pz, this._groundH + MANTLE_MAX_M + 0.05);
      const rise = top - this._groundH;
      if (rise < MANTLE_MIN_M) continue; // nothing to climb yet, look a little further
      if (rise > MANTLE_MAX_M) return false; // too tall: a normal jump
      for (const extra of [0.25, 0.4]) {
        const tx = this._pose.x + fx * (d + extra), tz = this._pose.z + fz * (d + extra);
        if (!inside(tx, tz)) continue;
        if (Math.abs(col.topAt(tx, tz, top + 0.15) - top) > 0.12) continue;
        if (col.clearanceAt(tx, tz, top + this._eyeHeight) <= 0) continue;
        this._mantle = {
          t: 0,
          fromX: this._pose.x,
          fromZ: this._pose.z,
          fromY: this._pose.y,
          toX: tx,
          toZ: tz,
          toH: top,
        };
        this._slide = null;
        this._tacT = 0;
        this._currentSpeed = 0;
        return true;
      }
      return false;
    }
    return false;
  }

  private _stepMantle(dt: number): void {
    const m = this._mantle!;
    m.t += dt;
    const k = Math.min(1, m.t / MANTLE_TIME_S);
    const up = 1 - (1 - k) * (1 - k); // rise first
    const kf = Math.max(0, (k - 0.35) / 0.65);
    const fwd = kf * kf * (3 - 2 * kf); // then over the edge
    this._eyeNow += (this._eyeHeight - this._eyeNow) * (1 - Math.exp(-dt / EYE_EASE_S));
    this._pose.x = m.fromX + (m.toX - m.fromX) * fwd;
    this._pose.z = m.fromZ + (m.toZ - m.fromZ) * fwd;
    this._pose.y = m.fromY + (m.toH + this._eyeNow - m.fromY) * up;
    if (k >= 1) {
      this._groundH = m.toH;
      this._jumpHeight = 0;
      this._vy = 0;
      this._mantle = null;
      this._collision.setFlight?.(this._pose.y);
      this._landDip = LAND_DIP_M;
      this.onFootstep?.(false);
    }
  }

  /** Camera-only feel: FOV (base, sprint, tactical, zoom), sprint dip, lean, landing shake, bob settings */
  private _feelCamera(moved: number, dt: number, leanTarget: number, sprinting: boolean): void {
    if (dt <= 0) return;
    const ease = (tau: number) => 1 - Math.exp(-dt / tau);
    this._zoomBlend += ((this._zoomHeld ? 1 : 0) - this._zoomBlend) * ease(0.08);
    if (this._zoomBlend < 1e-3) this._zoomBlend = 0;

    const speed = moved / dt;
    const base = this._feel.fovDeg;
    let fovTarget = base;
    if (this._slide) fovTarget = base + FEEL_SPRINT_FOV_ADD * 0.6;
    else if (speed > WALK_SPEED * 1.1) fovTarget = base + (this._tacT > 0 ? TAC_FOV_ADD : FEEL_SPRINT_FOV_ADD);
    fovTarget += (ZOOM_FOV_DEG - fovTarget) * this._zoomBlend;
    let fov = this._fovNow + (fovTarget - this._fovNow) * ease(0.12);
    if (Math.abs(fov - fovTarget) < 0.01) fov = fovTarget;
    this._fovNow = fov;

    const climbDip = this._mantle ? -(4 * Math.PI / 180) * Math.sin(Math.PI * Math.min(1, this._mantle.t / MANTLE_TIME_S)) : 0;
    const pitchTarget = (sprinting && speed > WALK_SPEED * 1.1 ? -SPRINT_PITCH_DIP_RAD : 0) + climbDip;
    this._pitchDip += (pitchTarget - this._pitchDip) * ease(0.15);

    const tilt = this._feel.tiltShake;
    this._roll += ((tilt ? leanTarget : 0) - this._roll) * ease(0.12);

    let shakeY = 0, shakeRoll = 0;
    if (this._shakeT > 0) {
      this._shakeT = Math.max(0, this._shakeT - dt);
      if (tilt) {
        const a = this._shakeT / LAND_SHAKE_S;
        shakeY = LAND_SHAKE_M * a * Math.sin(this._clock * 55);
        shakeRoll = LAND_SHAKE_ROLL_RAD * a * Math.sin(this._clock * 47 + 1);
      }
    }

    const bob = this._feel.headBob ? 1 - (1 - ZOOM_BOB) * this._zoomBlend : 0;
    this._offset = {
      y: BOB_Y_M * this._bobAmp * bob * Math.cos(2 * this._bobPhase) - this._landDip + shakeY,
      side: BOB_SIDE_M * this._bobAmp * bob * Math.sin(this._bobPhase),
      fov,
      pitch: this._pitchDip,
      roll: this._roll + shakeRoll,
    };
  }
}
