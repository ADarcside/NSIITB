/**
 * Namma Space: Movement Controller & Wall Sliding Unit Tests
 * Tests movement step function, wall sliding, smoothing, bounds clamping,
 * pitch clamping (+/-85 deg), and key clearing.
 */

import { describe, it, expect } from 'vitest';
import {
  step,
  clampToBounds,
  FirstPersonMovementController,
  WALK_SPEED,
  SPRINT_SPEED,
  MAX_PITCH_RAD,
  BASE_FOV_DEG,
  SPRINT_FOV_DEG,
  JUMP_SPEED,
  GRAVITY,
  MAX_EYE_M,
} from '../../viewer/src/controls/movement.js';
import { GhostCollisionProvider } from '../../viewer/src/collision/ghost.js';
import { GridCollisionProvider } from '../../viewer/src/collision/grid.js';
import type { NavGrid } from '../../viewer/src/contracts/types.js';
import type { Bounds, CollisionProvider, Pose3D, Vec2 } from '../../viewer/src/types.js';

describe('Movement Step & Wall Sliding', () => {
  const roomBounds: Bounds = { minX: -2.0, maxX: 2.0, minZ: -2.0, maxZ: 2.0 };
  const ghostCol = new GhostCollisionProvider(roomBounds);

  it('moves freely when unobstructed within bounds', () => {
    const start: Pose3D = { x: 0, y: 1.5, z: 0, yaw: 0, pitch: 0 };
    const wish: Vec2 = { x: 1, z: 0 }; // Moving right (+X)
    const next = step(start, wish, WALK_SPEED, 0.016, ghostCol);

    expect(next.x).toBeCloseTo(0 + 1 * 1.4 * 0.016, 5);
    expect(next.z).toBe(0);
    expect(next.y).toBe(1.5);
  });

  it('clamps dt to MAX_DT (0.05s)', () => {
    const start: Pose3D = { x: 0, y: 1.5, z: 0, yaw: 0, pitch: 0 };
    const wish: Vec2 = { x: 0, z: -1 }; // Moving forward (-Z)
    // Pass large dt of 1.0s (e.g. tab was backgrounded)
    const next = step(start, wish, WALK_SPEED, 1.0, ghostCol);

    // Displacement must be capped to MAX_DT (0.05s) * 1.4 m/s = 0.07m
    expect(next.z).toBeCloseTo(-0.07, 5);
  });

  it('slides along wall (X-axis) when Z-axis is blocked against a synthetic grid', () => {
    // 3x3 synthetic NavGrid (each cell 1m x 1m)
    // Origin at [0, 0].
    // Row 0 (z in [0, 1)): all free (cells [0,0], [1,0], [2,0])
    // Row 1 (z in [1, 2)): row is BLOCKED (e.g. a wall)
    // Row 2 (z in [2, 3)): all free
    // In bits (MSB):
    // Row 0: 1, 1, 1
    // Row 1: 0, 0, 0
    // Row 2: 1, 1, 1
    // Total 9 bits: 11100011 10000000 -> byte0=0xE3, byte1=0x80
    // Base64 of bytes [0xE3, 0x80]:
    const bytes = new Uint8Array([0xe3, 0x80]);
    const b64 = Buffer.from(bytes).toString('base64');

    const navgrid: NavGrid = {
      schema_version: 1,
      nav_id: 'nav_23j7x72k3w3c',
      transform_scene: 'scn_23j7x56k3y7a',
      cell_m: 1.0,
      origin: [0, 0],
      width: 3,
      height: 3,
      agent_radius_m: 0.25,
      free_bits_b64: b64,
    };

    const gridCol = new GridCollisionProvider(navgrid);

    // Initial pose at (x=0.5, z=0.5) - inside free cell (col 0, row 0)
    expect(gridCol.isFree(0.5, 0.5)).toBe(true);
    // Moving diagonally: +X and +Z towards row 1 (which is blocked!)
    const current: Pose3D = { x: 0.5, y: 1.5, z: 0.8, yaw: 0, pitch: 0 };

    // nx = 0.5 + 1.4 * 0.05 = 0.57 (still in col 0 or 1, free in row 0)
    // nz = 0.8 + 1.4 * 0.05 = 0.87 (if it crosses into z >= 1.0, it enters row 1)
    // Test with a step that pushes Z into the wall (e.g. z -> 1.05)
    const next = step(current, { x: 0.5, z: 1.0 }, 10.0, 0.05, gridCol);

    // Diagonal (nx=0.75, nz=1.3) is in row 1 -> BLOCKED!
    // Slide check 1: (nx, p.z) = (0.75, 0.8) -> row 0 is FREE!
    // Result: X advances, Z remains at 0.8 (wall sliding!)
    expect(gridCol.isFree(next.x, 0.8)).toBe(true);
    expect(gridCol.isFree(next.x, 1.3)).toBe(false);
    expect(next.z).toBe(0.8);
    expect(next.x).toBeGreaterThan(0.5);
  });

  it('slides along wall (Z-axis) when X-axis is blocked', () => {
    // Wall along X=1.0. Inside room bounds [0, 0] to [1, 2].
    // Mock collision provider where x >= 1.0 is blocked, but z is free
    const mockCol = {
      isFree: (x: number, z: number) => x < 1.0 && z >= 0 && z <= 2.0,
      bounds: () => ({ minX: 0, maxX: 1, minZ: 0, maxZ: 2 }),
    };

    const current: Pose3D = { x: 0.9, y: 1.5, z: 1.0, yaw: 0, pitch: 0 };
    const wish: Vec2 = { x: 1, z: 1 }; // diagonal towards X wall
    const nextBlockedX = step(current, wish, 5.0, 0.05, mockCol);
    // nx = 0.9 + 0.25 = 1.15 (blocked)
    // nz = 1.0 + 0.25 = 1.25 (free)
    expect(nextBlockedX.x).toBe(0.9); // X stayed in place
    expect(nextBlockedX.z).toBeCloseTo(1.25, 4); // Z slid forward!
  });

  it('stays completely in place if both axes are blocked (corner trap)', () => {
    const trappedCol = {
      isFree: (x: number, z: number) => x === 0 && z === 0,
      bounds: () => ({ minX: -1, maxX: 1, minZ: -1, maxZ: 1 }),
    };

    const current: Pose3D = { x: 0, y: 1.5, z: 0, yaw: 0, pitch: 0 };
    const wish: Vec2 = { x: 1, z: 1 };
    const next = step(current, wish, 1.4, 0.05, trappedCol);

    expect(next.x).toBe(0);
    expect(next.z).toBe(0);
  });
});

describe('Bounds Clamping', () => {
  const bounds: Bounds = { minX: -2.0, maxX: 2.0, minZ: -1.0, maxZ: 3.0 };

  it('clamps coordinates strictly inside room bounds', () => {
    const pOut: Pose3D = { x: 5.0, y: 1.5, z: -4.0, yaw: 0, pitch: 0 };
    const clamped = clampToBounds(pOut, bounds);

    expect(clamped.x).toBe(2.0);
    expect(clamped.z).toBe(-1.0);
    expect(clamped.y).toBe(1.5);
  });

  it('leaves coordinates inside bounds unchanged', () => {
    const pIn: Pose3D = { x: 0.5, y: 1.5, z: 1.2, yaw: 0.5, pitch: 0.2 };
    const clamped = clampToBounds(pIn, bounds);

    expect(clamped.x).toBe(0.5);
    expect(clamped.z).toBe(1.2);
    expect(clamped.yaw).toBe(0.5);
  });
});

describe('FirstPersonMovementController', () => {
  const bounds: Bounds = { minX: -3.0, maxX: 3.0, minZ: -3.0, maxZ: 3.0 };
  const ghostCol = new GhostCollisionProvider(bounds);

  it('initializes pose from start_pose and eye_height_m', () => {
    const controller = new FirstPersonMovementController({
      startPose: { x: 1.0, z: -1.5, yaw_deg: 90.0 },
      eyeHeightM: 1.65,
      collision: ghostCol,
    });

    expect(controller.pose.x).toBe(1.0);
    expect(controller.pose.z).toBe(-1.5);
    expect(controller.pose.y).toBe(1.65);
    expect(controller.pose.yaw).toBeCloseTo(Math.PI / 2, 4);
    expect(controller.pose.pitch).toBe(0);
  });

  it('clamps pitch strictly to +/- 85 degrees', () => {
    const controller = new FirstPersonMovementController({
      startPose: { x: 0, z: 0, yaw_deg: 0 },
      eyeHeightM: 1.5,
      collision: ghostCol,
      mouseSensitivity: 0.1,
    });

    // Move mouse strongly upward (large positive deltaY)
    controller.handleMouseMove(0, 100);
    expect(controller.pose.pitch).toBeGreaterThanOrEqual(-MAX_PITCH_RAD);
    expect(controller.pose.pitch).toBeCloseTo(-MAX_PITCH_RAD, 2);

    // Move mouse strongly downward (large negative deltaY)
    controller.handleMouseMove(0, -500);
    expect(controller.pose.pitch).toBeLessThanOrEqual(MAX_PITCH_RAD);
    expect(controller.pose.pitch).toBeCloseTo(MAX_PITCH_RAD, 2);
  });

  it('smooths speed transitions between stopped, walk, and sprint', () => {
    const controller = new FirstPersonMovementController({
      startPose: { x: 0, z: 0, yaw_deg: 0 },
      eyeHeightM: 1.5,
      collision: ghostCol,
    });

    // Press W (walk forward)
    controller.handleKeyDown('KeyW');

    // First frame (0.016s) -> speed smoothly rises towards 1.4 m/s
    controller.update(0.016);
    expect(controller.currentSpeed).toBeGreaterThan(0);
    expect(controller.currentSpeed).toBeLessThan(WALK_SPEED);

    // After ~0.8s (several time constants of 0.15s), speed approaches 1.4 m/s
    for (let i = 0; i < 50; i++) {
      controller.update(0.016);
    }
    expect(controller.currentSpeed).toBeCloseTo(WALK_SPEED, 1);

    // Press Shift -> speed rises towards 2.5 m/s
    controller.handleKeyDown('ShiftLeft');
    for (let i = 0; i < 50; i++) {
      controller.update(0.016);
    }
    expect(controller.currentSpeed).toBeCloseTo(SPRINT_SPEED, 1);

    // Release all keys -> speed falls towards 0 (after ~1.2s)
    controller.handleKeyUp('KeyW');
    controller.handleKeyUp('ShiftLeft');
    for (let i = 0; i < 80; i++) {
      controller.update(0.016);
    }
    expect(controller.currentSpeed).toBeCloseTo(0, 2);
  });

  it('resets pose to start_pose and eye_height_m on R key or reset()', () => {
    const controller = new FirstPersonMovementController({
      startPose: { x: 0.5, z: 0.5, yaw_deg: 45.0 },
      eyeHeightM: 1.5,
      collision: ghostCol,
    });

    // Move away
    controller.handleKeyDown('KeyW');
    for (let i = 0; i < 20; i++) {
      controller.update(0.05);
    }
    controller.handleMouseMove(50, 20);

    expect(controller.pose.x !== 0.5 || controller.pose.z !== 0.5).toBe(true);

    // Press R to reset
    controller.handleKeyDown('KeyR');

    expect(controller.pose.x).toBe(0.5);
    expect(controller.pose.z).toBe(0.5);
    expect(controller.pose.y).toBe(1.5);
    expect(controller.pose.yaw).toBeCloseTo((45.0 * Math.PI) / 180, 4);
    expect(controller.pose.pitch).toBe(0);
    expect(controller.currentSpeed).toBe(0);
  });

  it('clears key state on blur or pointer-lock loss', () => {
    const controller = new FirstPersonMovementController({
      startPose: { x: 0, z: 0, yaw_deg: 0 },
      eyeHeightM: 1.5,
      collision: ghostCol,
    });

    controller.handleKeyDown('KeyW');
    controller.handleKeyDown('KeyA');
    controller.handleKeyDown('ShiftLeft');

    expect(controller.keys.forward).toBe(true);
    expect(controller.keys.left).toBe(true);
    expect(controller.keys.sprint).toBe(true);

    // Window lost focus or pointer-lock lost
    controller.clearKeys();

    expect(controller.keys.forward).toBe(false);
    expect(controller.keys.backward).toBe(false);
    expect(controller.keys.left).toBe(false);
    expect(controller.keys.right).toBe(false);
    expect(controller.keys.sprint).toBe(false);
  });
});

describe('Walk / Free roam modes', () => {
  const bounds: Bounds = { minX: -3.0, maxX: 3.0, minZ: -3.0, maxZ: 3.0 };
  const ghostCol = new GhostCollisionProvider(bounds);
  const make = (mode?: 'free' | 'walk', collision: CollisionProvider = ghostCol) =>
    new FirstPersonMovementController({ startPose: { x: 0, z: 0, yaw_deg: 30 }, eyeHeightM: 1.5, collision, mode });
  const run = (c: FirstPersonMovementController, frames: number) => {
    for (let i = 0; i < frames; i++) c.update(1 / 60);
  };

  it('free roam (default) matches the original behaviour: W, fly up, sprint-strafe, fly down', () => {
    const c = make();
    expect(c.mode).toBe('free');
    c.handleKeyDown('KeyW');
    c.handleKeyDown('KeyE');
    run(c, 40);
    c.handleKeyUp('KeyE');
    c.handleKeyDown('ShiftLeft');
    c.handleKeyDown('KeyD');
    run(c, 40);
    c.clearKeys();
    c.handleKeyDown('KeyQ');
    run(c, 20);
    // Golden values recorded from the controller before walk mode was added
    expect(c.pose.x).toBeCloseTo(0.0223084407386112, 10);
    expect(c.pose.y).toBeCloseTo(1.7666666666666666, 10);
    expect(c.pose.z).toBeCloseTo(-2.0970937359793864, 10);
    expect(c.cameraOffset).toEqual({ y: 0, side: 0, fov: BASE_FOV_DEG });
  });

  it('walk mode keeps the eye height fixed: E and Q do nothing', () => {
    const c = make('walk');
    c.handleKeyDown('KeyE');
    run(c, 60);
    expect(c.pose.y).toBe(1.5);
    c.handleKeyUp('KeyE');
    c.handleKeyDown('KeyQ');
    run(c, 60);
    expect(c.pose.y).toBe(1.5);
    expect(c.flying).toBe(false);
  });

  it('switching to walk while flying drops to eye height and stops flying', () => {
    const c = make('free');
    c.handleKeyDown('KeyE');
    run(c, 30);
    expect(c.flying).toBe(true);
    c.setMode('walk');
    expect(c.pose.y).toBe(1.5);
    expect(c.flying).toBe(false);
  });

  it('switching to walk over a blocked spot moves to the nearest free spot', () => {
    // Blocked disc of radius 0.5 m around the origin (like flying above a bunk)
    const disc: CollisionProvider = {
      isFree: (x, z) => Math.hypot(x, z) > 0.5,
      bounds: () => bounds,
    };
    const c = make('free', disc);
    c.setMode('walk');
    const r = Math.hypot(c.pose.x, c.pose.z);
    expect(r).toBeGreaterThan(0.5);
    expect(r).toBeLessThan(0.6);
  });

  it('head bob runs while walking and settles to zero after stopping', () => {
    const steps: boolean[] = [];
    const c = make('walk');
    c.onFootstep = sprint => steps.push(sprint);
    c.handleKeyDown('KeyW');
    run(c, 120);
    expect(steps.length).toBeGreaterThanOrEqual(2);
    let maxBob = 0;
    for (let i = 0; i < 30; i++) {
      c.update(1 / 60);
      maxBob = Math.max(maxBob, Math.abs(c.cameraOffset.y));
    }
    expect(maxBob).toBeGreaterThan(0.01);
    c.clearKeys();
    run(c, 60);
    expect(Math.abs(c.cameraOffset.y)).toBeLessThan(1e-3);
    expect(c.pose.y).toBe(1.5);
  });

  it('sprinting in walk mode widens the FOV, and it returns when walking', () => {
    const c = make('walk', new GhostCollisionProvider({ minX: -50, maxX: 50, minZ: -50, maxZ: 50 }));
    c.handleKeyDown('KeyW');
    c.handleKeyDown('ShiftLeft');
    run(c, 120);
    expect(c.cameraOffset.fov).toBeCloseTo(SPRINT_FOV_DEG, 1);
    c.handleKeyUp('ShiftLeft');
    run(c, 120);
    expect(c.cameraOffset.fov).toBe(BASE_FOV_DEG);
  });

  it('reset keeps walk mode', () => {
    const c = make('walk');
    c.reset();
    expect(c.mode).toBe('walk');
  });
});

describe('Walk mode jump', () => {
  const bounds: Bounds = { minX: -3.0, maxX: 3.0, minZ: -3.0, maxZ: 3.0 };
  const make = (mode: 'free' | 'walk', eyeHeightM = 1.5) =>
    new FirstPersonMovementController({
      startPose: { x: 0, z: 0, yaw_deg: 0 },
      eyeHeightM,
      collision: new GhostCollisionProvider(bounds),
      mode,
    });
  const run = (c: FirstPersonMovementController, frames: number) => {
    for (let i = 0; i < frames; i++) c.update(1 / 60);
  };

  it('Space jumps up and lands back at eye height', () => {
    const c = make('walk');
    let landings = 0;
    c.onLand = () => landings++;
    c.handleKeyDown('Space');
    run(c, 10);
    expect(c.pose.y).toBeGreaterThan(1.5);
    expect(c.airborne).toBe(true);
    run(c, 120);
    expect(c.pose.y).toBe(1.5);
    expect(landings).toBe(1);
  });

  it('peaks at about JUMP_SPEED^2 / 2g', () => {
    const c = make('walk');
    c.handleKeyDown('Space');
    let peak = 0;
    for (let i = 0; i < 60; i++) {
      c.update(1 / 60);
      peak = Math.max(peak, c.pose.y - 1.5);
    }
    expect(peak).toBeCloseTo((JUMP_SPEED * JUMP_SPEED) / (2 * GRAVITY), 1);
  });

  it('holding Space gives one jump; a fresh press jumps again', () => {
    const c = make('walk');
    let landings = 0;
    c.onLand = () => landings++;
    c.handleKeyDown('Space');
    run(c, 120);
    expect(landings).toBe(1);
    c.handleKeyUp('Space');
    c.handleKeyDown('Space');
    run(c, 120);
    expect(landings).toBe(2);
  });

  it('free roam ignores Space', () => {
    const c = make('free');
    c.handleKeyDown('Space');
    run(c, 20);
    expect(c.pose.y).toBe(1.5);
  });

  it('never rises above MAX_EYE_M under a low ceiling', () => {
    const c = make('walk', 2.5);
    c.handleKeyDown('Space');
    let top = 0;
    for (let i = 0; i < 120; i++) {
      c.update(1 / 60);
      top = Math.max(top, c.pose.y);
    }
    expect(top).toBeLessThanOrEqual(MAX_EYE_M + 1e-9);
    expect(c.pose.y).toBe(2.5);
  });

  it('reset and mode switches cancel a jump', () => {
    const c = make('walk');
    c.handleKeyDown('Space');
    run(c, 10);
    c.reset();
    expect(c.pose.y).toBe(1.5);
    expect(c.airborne).toBe(false);
    c.handleKeyUp('Space');
    c.handleKeyDown('Space');
    run(c, 10);
    c.setMode('free');
    expect(c.airborne).toBe(false);
  });

  it('no footsteps in the air, and the landing dip eases back to zero', () => {
    const c = make('walk');
    let steps = 0;
    c.onFootstep = () => steps++;
    c.handleKeyDown('KeyW');
    c.handleKeyDown('Space');
    run(c, 3);
    const before = steps;
    run(c, 25); // still in the air (about 0.6 s total)
    expect(c.airborne).toBe(true);
    expect(steps).toBe(before);
    c.clearKeys();
    run(c, 30);
    expect(c.airborne).toBe(false);
    run(c, 30);
    expect(Math.abs(c.cameraOffset.y)).toBeLessThan(1e-3);
  });
});
