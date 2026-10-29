/**
 * Namma Space: Collision Providers Unit Tests
 * Tests GhostCollisionProvider and GridCollisionProvider (free_bits_b64 decoding,
 * cell coordinate indexing, out-of-bounds behavior, MSB/LSB bit order).
 */

import { describe, it, expect } from 'vitest';
import { GhostCollisionProvider } from '../../viewer/src/collision/ghost.js';
import { GridCollisionProvider, decodeBase64ToBytes } from '../../viewer/src/collision/grid.js';
import type { NavGrid } from '../../viewer/src/contracts/types.js';
import { step } from '../../viewer/src/controls/movement.js';

describe('GhostCollisionProvider', () => {
  const bounds = { minX: -2.5, maxX: 2.5, minZ: -3.0, maxZ: 3.0 };
  const provider = new GhostCollisionProvider(bounds);

  it('reports isFree=true for coordinates inside bounds', () => {
    expect(provider.isFree(0, 0)).toBe(true);
    expect(provider.isFree(-2.5, 3.0)).toBe(true);
    expect(provider.isFree(2.5, -3.0)).toBe(true);
    expect(provider.isFree(1.2, -0.8)).toBe(true);
  });

  it('reports isFree=false for coordinates outside bounds', () => {
    expect(provider.isFree(-2.51, 0)).toBe(false);
    expect(provider.isFree(2.51, 0)).toBe(false);
    expect(provider.isFree(0, -3.01)).toBe(false);
    expect(provider.isFree(0, 3.01)).toBe(false);
    expect(provider.isFree(10.0, 10.0)).toBe(false);
  });

  it('returns clean normalized bounds', () => {
    // Inverted input bounds should be normalized
    const inverted = new GhostCollisionProvider({ minX: 5, maxX: -5, minZ: 3, maxZ: -3 });
    expect(inverted.bounds()).toEqual({ minX: -5, maxX: 5, minZ: -3, maxZ: 3 });
  });
});

describe('GridCollisionProvider', () => {
  it('correctly decodes base64 string to bytes', () => {
    const raw = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const b64 = Buffer.from(raw).toString('base64');
    const decoded = decodeBase64ToBytes(b64);
    expect(Array.from(decoded)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('decodes bitpacked occupancy grid and looks up cells correctly', () => {
    // 4 columns x 2 rows
    // cell_m = 0.5m, origin = [1.0, 2.0]
    // Row 0 (z in [2.0, 2.5)):
    //   col 0 (x in [1.0, 1.5)): 1 (free)
    //   col 1 (x in [1.5, 2.0)): 0 (blocked)
    //   col 2 (x in [2.0, 2.5)): 1 (free)
    //   col 3 (x in [2.5, 3.0)): 1 (free)
    // Row 1 (z in [2.5, 3.0)):
    //   col 0: 0 (blocked)
    //   col 1: 1 (free)
    //   col 2: 0 (blocked)
    //   col 3: 0 (blocked)
    // Bit sequence (MSB): 1, 0, 1, 1, 0, 1, 0, 0 -> 0b10110100 = 0xB4
    const b64 = Buffer.from([0xb4]).toString('base64');

    const navgrid: NavGrid = {
      schema_version: 1,
      nav_id: 'nav_23j7x72k3w3c',
      transform_scene: 'scn_23j7x56k3y7a',
      cell_m: 0.5,
      origin: [1.0, 2.0],
      width: 4,
      height: 2,
      agent_radius_m: 0.25,
      free_bits_b64: b64,
    };

    const provider = new GridCollisionProvider(navgrid);

    // Row 0 checks:
    expect(provider.isFree(1.2, 2.2)).toBe(true);  // col 0: free
    expect(provider.isFree(1.7, 2.2)).toBe(false); // col 1: blocked
    expect(provider.isFree(2.2, 2.2)).toBe(true);  // col 2: free
    expect(provider.isFree(2.7, 2.2)).toBe(true);  // col 3: free

    // Row 1 checks:
    expect(provider.isFree(1.2, 2.7)).toBe(false); // col 0: blocked
    expect(provider.isFree(1.7, 2.7)).toBe(true);  // col 1: free
    expect(provider.isFree(2.2, 2.7)).toBe(false); // col 2: blocked
    expect(provider.isFree(2.7, 2.7)).toBe(false); // col 3: blocked

    // Out of bounds checks:
    expect(provider.isFree(0.5, 2.2)).toBe(false); // X < origin[0]
    expect(provider.isFree(3.5, 2.2)).toBe(false); // X >= maxX
    expect(provider.isFree(1.2, 1.5)).toBe(false); // Z < origin[1]
    expect(provider.isFree(1.2, 3.5)).toBe(false); // Z >= maxZ
  });

  it('computes grid bounds matching origin + width/height * cell_m', () => {
    const navgrid: NavGrid = {
      schema_version: 1,
      nav_id: 'nav_23j7x72k3w3c',
      transform_scene: 'scn_23j7x56k3y7a',
      cell_m: 0.1,
      origin: [-2.0, -1.0],
      width: 50,
      height: 40,
      agent_radius_m: 0.25,
      free_bits_b64: 'AAAA',
    };

    const provider = new GridCollisionProvider(navgrid);
    expect(provider.bounds()).toEqual({
      minX: -2.0,
      maxX: -2.0 + 50 * 0.1, // 3.0
      minZ: -1.0,
      maxZ: -1.0 + 40 * 0.1, // 3.0
    });
  });
});

describe('GridCollisionProvider clearance and gliding', () => {
  // 20 x 20 cells of 0.1 m, origin (0, 0); everything free except a wall at columns >= 10
  const width = 20, height = 20;
  const bits = new Uint8Array(Math.ceil((width * height) / 8));
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < 10; c++) {
      const i = r * width + c;
      bits[i >> 3] |= 0x80 >> (i & 7);
    }
  }
  const grid: NavGrid = {
    schema_version: 1, nav_id: 'nav_aaaaaaaaaaaa', transform_scene: 'scn_aaaaaaaaaaaa',
    cell_m: 0.1, origin: [0, 0], width, height, agent_radius_m: 0.25,
    free_bits_b64: Buffer.from(bits).toString('base64'),
  };
  const provider = new GridCollisionProvider(grid);

  it('is positive in free space, about zero at the wall edge and negative inside', () => {
    expect(provider.clearance(0.5, 1.0)).toBeCloseTo(0.5, 2);
    expect(Math.abs(provider.clearance(1.0, 1.0))).toBeLessThan(0.01);
    expect(provider.clearance(1.3, 1.0)).toBeLessThan(0);
  });

  it('glides along the wall instead of stopping when walking into it at an angle', () => {
    let pose = { x: 0.9, y: 1.5, z: 1.0, yaw: 0, pitch: 0 };
    const wish = { x: Math.SQRT1_2, z: Math.SQRT1_2 };
    for (let i = 0; i < 20; i++) pose = step(pose, wish, 1.0, 0.02, provider);
    expect(pose.x).toBeLessThan(1.0);
    expect(pose.z).toBeGreaterThan(1.2);
  });
});

describe('GridCollisionProvider height layers (flying)', () => {
  // 40 x 40 cells of 0.1 m. A bunk fills cells 15-24 in both directions: the walking grid blocks it;
  // the layers hold its mattress (0.4-0.6 m) and top bunk (1.3-1.9 m) with a gap in between.
  const W = 40, H = 40, CELL = 0.1, COUNT = 27;
  const inBunk = (r: number, c: number): boolean => r >= 15 && r < 25 && c >= 15 && c < 25;
  const pack = (bits: boolean[]): string => {
    const bytes = new Uint8Array(Math.ceil(bits.length / 8));
    bits.forEach((b, i) => { if (b) bytes[i >> 3] |= 0x80 >> (i & 7); });
    return Buffer.from(bytes).toString('base64');
  };
  const free: boolean[] = [];
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) free.push(!inBunk(r, c));
  const occupied: boolean[] = [];
  for (let l = 0; l < COUNT; l++) {
    const y = 0.1 + l * 0.1 + 0.05;
    const solid = (y > 0.4 && y < 0.6) || (y > 1.3 && y < 1.9);
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) occupied.push(solid && inBunk(r, c));
  }
  const grid: NavGrid = {
    schema_version: 1, nav_id: 'nav_aaaaaaaaaaaa', transform_scene: 'scn_aaaaaaaaaaaa',
    cell_m: CELL, origin: [0, 0], width: W, height: H, agent_radius_m: 0.25,
    free_bits_b64: pack(free),
    layers: { y0_m: 0.1, dy_m: 0.1, count: COUNT, occupied_bits_b64: pack(occupied) },
  };

  it('walking: the bunk is solid', () => {
    const p = new GridCollisionProvider(grid);
    expect(p.hasLayers).toBe(true);
    expect(p.isFree(2.0, 2.0)).toBe(false);
    expect(p.clearance(2.0, 2.0)).toBeLessThan(0);
  });

  it('flying through the gap between mattress and top bunk, and over the top bunk', () => {
    const p = new GridCollisionProvider(grid);
    p.setFlight(0.95);
    expect(p.flying).toBe(true);
    expect(p.isFree(2.0, 2.0)).toBe(true);
    p.setFlight(2.35);
    expect(p.clearance(2.0, 2.0)).toBeGreaterThan(0);
    p.setFlight(1.5);
    expect(p.isFree(2.0, 2.0)).toBe(false);
    p.setFlight(null);
    expect(p.isFree(2.0, 2.0)).toBe(false);
  });

  it('clearanceAt tests a height without switching to it', () => {
    const p = new GridCollisionProvider(grid);
    expect(p.clearanceAt(2.0, 2.0, 0.95)).toBeGreaterThan(0);
    expect(p.clearanceAt(2.0, 2.0, 1.6)).toBeLessThan(0);
    expect(p.flying).toBe(false);
  });

  it('grids without layers ignore flight', () => {
    const { layers: _unused, ...flat } = grid;
    const p = new GridCollisionProvider(flat as NavGrid);
    p.setFlight(0.95);
    expect(p.flying).toBe(false);
    expect(p.isFree(2.0, 2.0)).toBe(false);
  });

  it('controller: E starts flying up to the cap; R walks again', async () => {
    const { FirstPersonMovementController } = await import('../../viewer/src/controls/movement.js');
    const ctl = new FirstPersonMovementController({ startPose: { x: 0.5, z: 0.5, yaw_deg: 0 }, eyeHeightM: 1.5, collision: new GridCollisionProvider(grid) });
    ctl.handleKeyDown('KeyE');
    for (let i = 0; i < 100; i++) ctl.update(0.05);
    expect(ctl.flying).toBe(true);
    expect(ctl.pose.y).toBeCloseTo(2.7, 5);
    ctl.reset();
    expect(ctl.flying).toBe(false);
    expect(ctl.pose.y).toBe(1.5);
  });

  it('controller: crouch beside the bunk, slide into the gap, cannot rise into the top bunk', async () => {
    const { FirstPersonMovementController } = await import('../../viewer/src/controls/movement.js');
    const ctl = new FirstPersonMovementController({ startPose: { x: 1.1, z: 2.0, yaw_deg: 0 }, eyeHeightM: 1.5, collision: new GridCollisionProvider(grid) });
    ctl.handleKeyDown('KeyQ');
    for (let i = 0; i < 14; i++) ctl.update(0.05);
    ctl.handleKeyUp('KeyQ');
    expect(ctl.pose.y).toBeCloseTo(0.94, 2);
    ctl.handleKeyDown('KeyD'); // +x, into the bunk
    for (let i = 0; i < 16; i++) ctl.update(0.05);
    ctl.handleKeyUp('KeyD');
    for (let i = 0; i < 10; i++) ctl.update(0.05); // coast to a stop
    expect(ctl.pose.x).toBeGreaterThan(1.7);
    expect(ctl.pose.x).toBeLessThan(2.3);
    ctl.handleKeyDown('KeyE');
    for (let i = 0; i < 40; i++) ctl.update(0.05);
    expect(ctl.pose.y).toBeLessThan(1.25);
  });
});
