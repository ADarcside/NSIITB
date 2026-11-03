import { describe, it, expect } from 'vitest';
import {
  newRoomCode,
  parseRoomCode,
  formatRoomCode,
  parseClientMsg,
  cleanName,
  clampCap,
  ROOM_CODE_ALPHABET,
} from '../../viewer/src/net/protocol.js';
import { PoseBuffer, PoseSender, lerpAngle, wrapAngle, SEND_INTERVAL_MS } from '../../viewer/src/net/interp.js';
import { roomCapForArea, walkableAreaM2 } from '../../viewer/src/net/capacity.js';
import type { NavGrid } from '../../viewer/src/contracts/types.js';

describe('room codes', () => {
  it('makes 6-character codes from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const c = newRoomCode();
      expect(c).toHaveLength(6);
      for (const ch of c) expect(ROOM_CODE_ALPHABET).toContain(ch);
      expect(c).not.toMatch(/[01OIL]/);
    }
  });
  it('parses typed codes and rejects bad ones', () => {
    expect(parseRoomCode(' k7q-x2m ')).toBe('K7QX2M');
    expect(parseRoomCode('K7QX2')).toBeNull();
    expect(parseRoomCode('K7QX2O')).toBeNull();
    expect(parseRoomCode(null)).toBeNull();
    expect(formatRoomCode('K7QX2M')).toBe('K7Q-X2M');
  });
});

describe('protocol validation', () => {
  const look = { char: 'kid', colors: ['#ff0000', '#00ff00', '#0000ff'], hat: 'cap' };
  it('accepts a good hello and cleans the name', () => {
    const m = parseClientMsg(JSON.stringify({ t: 'hello', v: 1, name: ' <i>Asha</i>  ', look, scene: 'scn_x', cap: 9, create: true }));
    expect(m).toMatchObject({ t: 'hello', name: 'iAsha/i', cap: 6, create: true });
  });
  it('rejects bad looks, poses and unknown types', () => {
    expect(parseClientMsg(JSON.stringify({ t: 'hello', v: 1, name: 'A', look: { ...look, colors: ['red', '#000000', '#000000'] }, scene: 's', cap: 4, create: true }))).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: 's', p: [1, 2, 3, 4] }))).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: 's', p: [1, 2, 3, 4, 'x'] }))).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: 'nope' }))).toBeNull();
    expect(parseClientMsg('{')).toBeNull();
  });
  it('keeps valid body state on poses and drops odd values', () => {
    expect(parseClientMsg(JSON.stringify({ t: 's', p: [1, 1, 1, 0, 0], e: 1.0, f: 1 }))).toEqual({ t: 's', p: [1, 1, 1, 0, 0], e: 1, f: 1 });
    expect(parseClientMsg(JSON.stringify({ t: 's', p: [1, 1, 1, 0, 0], e: 9, f: 99 }))).toEqual({ t: 's', p: [1, 1, 1, 0, 0] });
    expect(parseClientMsg(JSON.stringify({ t: 's', p: [1, 1, 1, 0, 0], f: 1.5 }))).toEqual({ t: 's', p: [1, 1, 1, 0, 0] });
  });
  it('limits names and caps', () => {
    expect(cleanName('')).toBe('Guest');
    expect(cleanName('x'.repeat(50))).toHaveLength(20);
    expect(clampCap(1)).toBe(2);
    expect(clampCap(100)).toBe(6);
    expect(clampCap('4')).toBe(4);
  });
});

describe('pose smoothing', () => {
  it('wraps and interpolates angles the short way', () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(lerpAngle(3, -3, 0.5)).toBeCloseTo(Math.PI, 1);
  });
  it('interpolates between snapshots with a delay', () => {
    const b = new PoseBuffer(100);
    b.push([0, 1.5, 0, 0, 0], 1000);
    b.push([1, 1.5, 0, 0, 0], 1100);
    expect(b.sample(1150)![0]).toBeCloseTo(0.5);
    expect(b.sample(1000)![0]).toBe(0);
  });
  it('extrapolates briefly, then holds', () => {
    const b = new PoseBuffer(100);
    b.push([0, 1.5, 0, 0, 0], 1000);
    b.push([1, 1.5, 0, 0, 0], 1100);
    expect(b.sample(1250)![0]).toBeCloseTo(1.5);
    expect(b.sample(5000)![0]).toBeCloseTo(3); // capped at 200 ms of extrapolation
  });
  it('snaps on a teleport instead of sliding across the room', () => {
    const b = new PoseBuffer(100);
    b.push([0, 1.5, 0, 0, 0], 1000);
    b.push([10, 1.5, 0, 0, 0], 1100);
    expect(b.sample(1150)![0]).toBe(10);
  });
});

describe('pose sending', () => {
  it('throttles to the send interval and skips unchanged poses', () => {
    const s = new PoseSender();
    expect(s.next([0, 1.5, 0, 0, 0], 0)).not.toBeNull();
    expect(s.next([1, 1.5, 0, 0, 0], SEND_INTERVAL_MS / 2)).toBeNull();
    expect(s.next([1, 1.5, 0, 0, 0], SEND_INTERVAL_MS)).not.toBeNull();
    expect(s.next([1, 1.5, 0, 0, 0], SEND_INTERVAL_MS * 3)).toBeNull();
    // A stance change sends even when standing still
    expect(s.next([1, 1.5, 0, 0, 0], SEND_INTERVAL_MS * 4, '1|1')).not.toBeNull();
    expect(s.next([1, 1.5, 0, 0, 0], SEND_INTERVAL_MS * 5, '1|1')).toBeNull();
    s.reset();
    expect(s.next([1, 1.5, 0, 0, 0], SEND_INTERVAL_MS * 6, '1|1')).not.toBeNull();
  });
});

describe('room capacity', () => {
  const grid = (w: number, h: number, freeCells: number): NavGrid => {
    const bytes = new Uint8Array(Math.ceil((w * h) / 8));
    for (let i = 0; i < freeCells; i++) bytes[i >> 3] |= 0x80 >> (i & 7);
    return {
      schema_version: 1,
      nav_id: 'nav_x',
      transform_scene: 'scn_x',
      cell_m: 0.1,
      origin: [0, 0],
      width: w,
      height: h,
      agent_radius_m: 0.2,
      free_bits_b64: Buffer.from(bytes).toString('base64'),
    };
  };
  it('measures walkable area from the grid', () => {
    expect(walkableAreaM2(grid(10, 10, 50))).toBeCloseTo(0.5);
  });
  it('gives K-720 four people and scales with area, between 2 and 6', () => {
    const k720 = 8;
    expect(roomCapForArea(8, k720)).toBe(4);
    expect(roomCapForArea(10, k720)).toBe(5);
    expect(roomCapForArea(1, k720)).toBe(2);
    expect(roomCapForArea(100, k720)).toBe(6);
    expect(roomCapForArea(null, k720)).toBe(4);
    expect(roomCapForArea(50, null)).toBe(4);
  });
});
