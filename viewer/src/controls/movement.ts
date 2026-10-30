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
 */

import type { CollisionProvider, MovementController, Pose3D, Vec2, Bounds } from '../types.js';
import type { Pose2D } from '../contracts/types.js';

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
/** Search step and radius when entering walk mode at a spot the walking body does not fit */
const LAND_STEP_M = 0.05;
const LAND_RADIUS_M = 2;

export interface CameraOffset {
  /** Added to the camera height */
  y: number;
  /** Shift along the camera's right vector */
  side: number;
  fov: number;
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
  private _jumpHeld = false;
  /** A new jump needs a fresh Space press: holding Space does not repeat */
  private _jumpArmed = true;
  private _jumpHeight = 0;
  private _vy = 0;
  private _landDip = 0;

  constructor(options: MovementControllerOptions) {
    this._startPose = options.startPose;
    this._eyeHeight = options.eyeHeightM;
    this._collision = options.collision;
    this._mouseSensitivity = options.mouseSensitivity ?? 0.002;
    this.onFootstep = options.onFootstep;
    this.onLand = options.onLand;

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
    this._mode = mode;
    this._bobAmp = 0;
    this._cancelJump();
    this._offset = { y: 0, side: 0, fov: BASE_FOV_DEG };
    if (mode === 'free') return;
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

  clearKeys(): void {
    this._keys.forward = false;
    this._keys.backward = false;
    this._keys.left = false;
    this._keys.right = false;
    this._keys.sprint = false;
    this._rise = false;
    this._sink = false;
    this._jumpHeld = false;
    this._jumpArmed = true;
  }

  reset(): void {
    this.clearKeys();
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
    if (this._mode === 'walk') this._offset = { y: 0, side: 0, fov: BASE_FOV_DEG };
  }

  handleKeyDown(code: string): void {
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
        this._keys.sprint = true;
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
    // Mouse X controls horizontal yaw
    this._pose.yaw -= deltaX * this._mouseSensitivity;

    // Mouse Y controls vertical pitch
    this._pose.pitch -= deltaY * this._mouseSensitivity;

    // Clamp pitch to [-85 deg, +85 deg]
    this._pose.pitch = Math.max(-MAX_PITCH_RAD, Math.min(MAX_PITCH_RAD, this._pose.pitch));
  }

  attachDomListeners(targetElement: HTMLElement): void {
    const onKeyDown = (e: KeyboardEvent) => {
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

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    document.addEventListener('pointerlockchange', onPointerLockChange);
    document.addEventListener('mousemove', onMouseMove);

    this._cleanupFns.push(() => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      document.removeEventListener('mousemove', onMouseMove);
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

    // Calculate movement intent along camera axes
    let moveForward = 0;
    let moveRight = 0;

    if (this._keys.forward) moveForward += 1;
    if (this._keys.backward) moveForward -= 1;
    if (this._keys.right) moveRight += 1;
    if (this._keys.left) moveRight -= 1;

    const isMoving = moveForward !== 0 || moveRight !== 0;
    const targetSpeed = isMoving ? (this._keys.sprint ? SPRINT_SPEED : WALK_SPEED) : 0;

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
  private _updateWalkFeel(moved: number, dt: number): void {
    if (dt <= 0) return;
    const speed = moved / dt;
    const air = this.airborne;
    const sprinting = this._keys.sprint && speed > WALK_SPEED * 1.1;
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
}
