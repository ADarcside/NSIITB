/**
 * Namma Space: Walk game feel tests (laptop Walk mode: sprint, tactical sprint, crouch, slide,
 * tilt, landing, zoom, climbing, Take me there slow-down, settings). With game feel off, Walk
 * mode and Free roam must behave exactly as before.
 */

import { describe, it, expect } from 'vitest';
import {
  FirstPersonMovementController,
  WALK_SPEED,
  SPRINT_SPEED,
  BASE_FOV_DEG,
  TAC_SPEED,
  TAC_DURATION_S,
  CROUCH_EYE_M,
  CROUCH_SPEED,
  SLIDE_DURATION_S,
  ZOOM_FOV_DEG,
  LAND_DIP_M,
  FEEL_SPRINT_FOV_ADD,
  ARRIVE_MIN_SPEED,
  DEFAULT_FEEL_SETTINGS,
} from '../../viewer/src/controls/movement.js';
import { GhostCollisionProvider } from '../../viewer/src/collision/ghost.js';
import { GridCollisionProvider } from '../../viewer/src/collision/grid.js';
import { loadFeelSettings, saveFeelSettings } from '../../viewer/src/ui/walk_feel_settings.js';
import type { NavGrid } from '../../viewer/src/contracts/types.js';

const EYE = 1.6;
const DT = 1 / 60;
const room = new GhostCollisionProvider({ minX: -10, maxX: 10, minZ: -10, maxZ: 10 });

function makeController(feel: boolean, col = room as ConstructorParameters<typeof FirstPersonMovementController>[0]['collision'], z = 0) {
  const c = new FirstPersonMovementController({
    startPose: { x: 0, z, yaw_deg: 0 },
    eyeHeightM: EYE,
    collision: col,
    mode: 'walk',
  });
  c.setGameFeel(feel);
  return c;
}

function run(c: FirstPersonMovementController, seconds: number) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) c.update(DT);
}

/**
 * 4 m x 4 m room (10 cm cells, origin -2,-2) with a 0.6 m high table in front of the start
 * (x -0.5..0.5, z -1.2..-0.6). Height layers every 10 cm from 0.1 m; walking body kept 0.2 m off it.
 */
function tableGrid(tableTopLayers = 5, withLayers = true): NavGrid {
  const W = 40, H = 40, n = W * H, count = 25;
  const free = new Uint8Array(Math.ceil(n / 8));
  const occ = new Uint8Array(Math.ceil((n * count) / 8));
  const setBit = (arr: Uint8Array, bit: number) => (arr[bit >> 3] |= 0x80 >> (bit & 7));
  for (let r = 0; r < H; r++) {
    for (let col = 0; col < W; col++) {
      const blocked = r >= 6 && r <= 15 && col >= 13 && col <= 26;
      if (!blocked) setBit(free, r * W + col);
      const table = r >= 8 && r <= 13 && col >= 15 && col <= 24;
      if (table) for (let l = 0; l < tableTopLayers; l++) setBit(occ, l * n + r * W + col);
    }
  }
  const b64 = (a: Uint8Array) => Buffer.from(a).toString('base64');
  return {
    schema_version: 1,
    nav_id: 'nav_23j7x72k3w3c',
    transform_scene: 'scn_23j7x56k3y7a',
    cell_m: 0.1,
    origin: [-2, -2],
    width: W,
    height: H,
    agent_radius_m: 0.2,
    free_bits_b64: b64(free),
    ...(withLayers ? { layers: { y0_m: 0.1, dy_m: 0.1, count, occupied_bits_b64: b64(occ) } } : {}),
  };
}

describe('Walk game feel: off keeps the old Walk mode', () => {
  it('feel off: no pitch / roll in the camera offset, C and zoom do nothing', () => {
    const c = makeController(false);
    c.handleKeyDown('KeyC');
    c.setZoom(true);
    c.handleKeyDown('KeyD');
    run(c, 0.5);
    expect(c.feelActive).toBe(false);
    expect(c.crouching).toBe(false);
    expect(c.pose.y).toBeCloseTo(EYE, 5);
    expect(c.cameraOffset.fov).toBe(BASE_FOV_DEG);
    expect('roll' in c.cameraOffset).toBe(false);
    expect('pitch' in c.cameraOffset).toBe(false);
  });

  it('Free roam moves the same with game feel on or off', () => {
    const a = makeController(false);
    const b = makeController(true);
    a.setMode('free');
    b.setMode('free');
    for (const c of [a, b]) {
      c.handleKeyDown('KeyW');
      c.handleKeyDown('ShiftLeft');
      c.handleKeyDown('KeyC');
      c.handleMouseMove(30, 10);
    }
    run(a, 1);
    run(b, 1);
    expect(b.pose).toEqual(a.pose);
    expect(b.cameraOffset).toEqual(a.cameraOffset);
  });

  it('turning game feel off on top of a table drops back to the floor', () => {
    const c = makeController(true, new GridCollisionProvider(tableGrid()), -0.3);
    c.handleKeyDown('Space');
    run(c, 0.6);
    expect(c.groundHeight).toBeGreaterThan(0.5);
    c.setGameFeel(false);
    expect(c.groundHeight).toBe(0);
    expect(c.pose.y).toBeCloseTo(EYE, 5);
  });
});

describe('Walk game feel: movement', () => {
  it('starts faster than the old Walk mode (snappier)', () => {
    const plain = makeController(false);
    const feel = makeController(true);
    plain.handleKeyDown('KeyW');
    feel.handleKeyDown('KeyW');
    run(plain, 0.15);
    run(feel, 0.15);
    expect(feel.currentSpeed).toBeGreaterThan(plain.currentSpeed);
    expect(feel.currentSpeed).toBeGreaterThan(WALK_SPEED * 0.7);
  });

  it('stops faster than the old Walk mode', () => {
    const plain = makeController(false);
    const feel = makeController(true);
    for (const c of [plain, feel]) {
      c.handleKeyDown('KeyW');
      run(c, 1);
      c.handleKeyUp('KeyW');
      run(c, 0.1);
    }
    expect(feel.currentSpeed).toBeLessThan(plain.currentSpeed);
  });

  it('sprint opens the FOV by FEEL_SPRINT_FOV_ADD and dips the camera forward', () => {
    const c = makeController(true);
    c.handleKeyDown('KeyW');
    c.handleKeyDown('ShiftLeft');
    run(c, 1.5);
    expect(c.currentSpeed).toBeCloseTo(SPRINT_SPEED, 1);
    expect(c.cameraOffset.fov).toBeCloseTo(BASE_FOV_DEG + FEEL_SPRINT_FOV_ADD, 0);
    expect(c.cameraOffset.pitch!).toBeLessThan(0);
  });

  it('double-tap Shift gives a tactical sprint that ends after TAC_DURATION_S', () => {
    const c = makeController(true);
    c.handleKeyDown('KeyW');
    c.handleKeyDown('ShiftLeft');
    c.handleKeyUp('ShiftLeft');
    run(c, 0.1);
    c.handleKeyDown('ShiftLeft');
    expect(c.tacticalSprinting).toBe(true);
    run(c, 1.5);
    expect(c.currentSpeed).toBeGreaterThan(SPRINT_SPEED + 0.5);
    expect(c.currentSpeed).toBeLessThanOrEqual(TAC_SPEED + 1e-6);
    run(c, TAC_DURATION_S);
    expect(c.tacticalSprinting).toBe(false);
    run(c, 1);
    expect(c.currentSpeed).toBeCloseTo(SPRINT_SPEED, 1);
  });

  it('held Shift (key repeat) and slow taps do not start a tactical sprint', () => {
    const c = makeController(true);
    c.handleKeyDown('KeyW');
    c.handleKeyDown('ShiftLeft');
    c.handleKeyDown('ShiftLeft'); // auto-repeat
    run(c, 0.1);
    c.handleKeyDown('ShiftLeft');
    expect(c.tacticalSprinting).toBe(false);
    c.handleKeyUp('ShiftLeft');
    run(c, 0.5);
    c.handleKeyDown('ShiftLeft');
    expect(c.tacticalSprinting).toBe(false);
  });

  it('hold C to crouch: lower eye, slower walk; release stands up', () => {
    const c = makeController(true);
    c.handleKeyDown('KeyC');
    c.handleKeyDown('KeyW');
    run(c, 1);
    expect(c.crouching).toBe(true);
    expect(c.pose.y).toBeCloseTo(CROUCH_EYE_M, 2);
    expect(c.currentSpeed).toBeCloseTo(CROUCH_SPEED, 2);
    c.handleKeyUp('KeyC');
    run(c, 1);
    expect(c.pose.y).toBeCloseTo(EYE, 2);
    expect(c.currentSpeed).toBeCloseTo(WALK_SPEED, 2);
  });

  it('C while sprinting slides forward, low, then ends', () => {
    const c = makeController(true);
    c.handleKeyDown('KeyW');
    c.handleKeyDown('ShiftLeft');
    run(c, 1);
    const z0 = c.pose.z;
    c.handleKeyDown('KeyC');
    expect(c.sliding).toBe(true);
    run(c, SLIDE_DURATION_S * 0.5);
    expect(c.pose.y).toBeLessThan(1.2);
    expect(c.cameraOffset.roll!).toBeGreaterThan(0);
    run(c, SLIDE_DURATION_S);
    expect(c.sliding).toBe(false);
    expect(z0 - c.pose.z).toBeGreaterThan(1.5);
    // Still holding C: crouched after the slide
    expect(c.crouching).toBe(true);
  });

  it('C while walking (not sprinting) only crouches', () => {
    const c = makeController(true);
    c.handleKeyDown('KeyW');
    run(c, 1);
    c.handleKeyDown('KeyC');
    expect(c.sliding).toBe(false);
    expect(c.crouching).toBe(true);
  });

  it('strafing leans the camera; the Tilt & shake setting turns it off', () => {
    const c = makeController(true);
    c.handleKeyDown('KeyD');
    run(c, 0.5);
    expect(c.cameraOffset.roll!).toBeLessThan(-0.02);
    c.setFeelSettings({ tiltShake: false });
    run(c, 0.5);
    expect(Math.abs(c.cameraOffset.roll!)).toBeLessThan(1e-3);
  });

  it('landing dips deeper than the old Walk mode', () => {
    let maxDip = 0;
    const c = makeController(true);
    c.handleKeyDown('Space');
    for (let i = 0; i < 60; i++) {
      c.update(DT);
      maxDip = Math.max(maxDip, -c.cameraOffset.y);
    }
    expect(maxDip).toBeGreaterThan(LAND_DIP_M * 1.5);
  });

  it('head bob setting off: no bob while walking', () => {
    const c = makeController(true);
    c.setFeelSettings({ headBob: false });
    c.handleKeyDown('KeyW');
    let maxBob = 0;
    for (let i = 0; i < 120; i++) {
      c.update(DT);
      maxBob = Math.max(maxBob, Math.abs(c.cameraOffset.y), Math.abs(c.cameraOffset.side));
    }
    expect(maxBob).toBeLessThan(1e-6);
  });

  it('zoom narrows the FOV and slows the mouse; FOV setting changes the base', () => {
    const c = makeController(true);
    c.setFeelSettings({ fovDeg: 75 });
    run(c, 1);
    expect(c.cameraOffset.fov).toBeCloseTo(75, 1);
    c.setZoom(true);
    run(c, 1);
    expect(c.cameraOffset.fov).toBeCloseTo(ZOOM_FOV_DEG, 0);
    const yaw0 = c.pose.yaw;
    c.handleMouseMove(100, 0);
    const zoomedTurn = yaw0 - c.pose.yaw;
    c.setZoom(false);
    run(c, 0.6);
    const yaw1 = c.pose.yaw;
    c.handleMouseMove(100, 0);
    expect(yaw1 - c.pose.yaw).toBeCloseTo(zoomedTurn * 2, 5);
  });

  it('mouse speed setting scales turning', () => {
    const c = makeController(true);
    c.setFeelSettings({ sensitivity: 2 });
    c.handleMouseMove(100, 0);
    expect(c.pose.yaw).toBeCloseTo(-100 * 0.002 * 2, 6);
  });
});

describe('Walk game feel: climbing onto low furniture', () => {
  it('Space facing a 0.6 m table climbs onto it, walking off the edge drops to the floor', () => {
    const c = makeController(true, new GridCollisionProvider(tableGrid()), -0.3);
    c.handleKeyDown('Space');
    c.update(DT);
    expect(c.climbing).toBe(true);
    run(c, 0.6);
    expect(c.climbing).toBe(false);
    expect(c.groundHeight).toBeCloseTo(0.6, 5);
    expect(c.pose.y).toBeCloseTo(0.6 + EYE, 2);
    expect(c.pose.z).toBeLessThan(-0.6);

    // Walk forward off the far edge
    c.handleKeyUp('Space');
    c.handleKeyDown('KeyW');
    run(c, 1.5);
    c.handleKeyUp('KeyW');
    run(c, 1);
    expect(c.groundHeight).toBe(0);
    expect(c.pose.y).toBeCloseTo(EYE, 2);
    expect(c.pose.z).toBeLessThan(-1.2);
  });

  it('something too tall is a normal jump', () => {
    const c = makeController(true, new GridCollisionProvider(tableGrid(14)), -0.3);
    c.handleKeyDown('Space');
    c.update(DT);
    expect(c.climbing).toBe(false);
    expect(c.airborne).toBe(true);
  });

  it('a grid without height layers is a normal jump', () => {
    const c = makeController(true, new GridCollisionProvider(tableGrid(5, false)), -0.3);
    c.handleKeyDown('Space');
    c.update(DT);
    expect(c.climbing).toBe(false);
    expect(c.airborne).toBe(true);
  });

  it('switching to Free roam on the table keeps the height', () => {
    const c = makeController(true, new GridCollisionProvider(tableGrid()), -0.3);
    c.handleKeyDown('Space');
    run(c, 0.6);
    const y = c.pose.y;
    c.setMode('free');
    c.update(DT);
    expect(c.pose.y).toBeCloseTo(y, 5);
    expect(c.flying).toBe(true);
  });

  it('topAt finds the table top, 0 on bare floor, Infinity when solid at maxY', () => {
    const g = new GridCollisionProvider(tableGrid());
    expect(g.topAt(0, -0.9, 1)).toBeCloseTo(0.6, 5);
    expect(g.topAt(0, 0, 1)).toBe(0);
    expect(g.topAt(0, -0.9, 0.4)).toBe(Infinity);
    expect(new GridCollisionProvider(tableGrid(5, false)).topAt).toBeUndefined();
  });
});

describe('Walk game feel: Take me there', () => {
  it('slows down near the end instead of stopping dead', () => {
    const c = makeController(true);
    let arrived = false;
    c.startAutoWalk([{ x: 0, z: 0 }, { x: 0, z: -4 }], () => (arrived = true));
    run(c, 1);
    expect(c.currentSpeed).toBeCloseTo(WALK_SPEED, 5);
    let minSpeed = Infinity;
    for (let i = 0; i < 600 && !arrived; i++) {
      c.update(DT);
      if (c.isAutoWalking) minSpeed = Math.min(minSpeed, c.currentSpeed);
    }
    expect(arrived).toBe(true);
    expect(minSpeed).toBeLessThan(WALK_SPEED * 0.8);
    expect(minSpeed).toBeGreaterThanOrEqual(ARRIVE_MIN_SPEED - 1e-9);
  });

  it('old Walk mode keeps a constant walking speed', () => {
    const c = makeController(false);
    c.startAutoWalk([{ x: 0, z: 0 }, { x: 0, z: -4 }]);
    let minSpeed = Infinity;
    for (let i = 0; i < 600 && c.isAutoWalking; i++) {
      c.update(DT);
      if (c.isAutoWalking) minSpeed = Math.min(minSpeed, c.currentSpeed);
    }
    expect(minSpeed).toBe(WALK_SPEED);
  });
});

describe('Walk feel settings storage', () => {
  it('round-trips and clamps bad values', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(loadFeelSettings(storage)).toEqual(DEFAULT_FEEL_SETTINGS);
    saveFeelSettings({ headBob: false, tiltShake: false, fovDeg: 200, sensitivity: -3 }, storage);
    expect(loadFeelSettings(storage)).toEqual({ headBob: false, tiltShake: false, fovDeg: 90, sensitivity: 0.3 });
    store.set('namma.walkFeel', '{not json');
    expect(loadFeelSettings(storage)).toEqual(DEFAULT_FEEL_SETTINGS);
  });
});
