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
} from '../../viewer/src/controls/movement.js';
import { GhostCollisionProvider } from '../../viewer/src/collision/ghost.js';
import { GridCollisionProvider } from '../../viewer/src/collision/grid.js';
import type { NavGrid } from '../../viewer/src/contracts/types.js';
import type { Bounds, Pose3D, Vec2 } from '../../viewer/src/types.js';

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
