/**
 * Namma Space AR: floor finding (which hits count as floor, and when the floor counts as found)
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { FloorWatch, STEADY_MS, DROPOUT_GRACE_MS, isFloorFacing, upDot } from '../../viewer/src/ar/floor.js';

function quat(axis: [number, number, number], deg: number): THREE.Quaternion {
  return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis).normalize(), (deg * Math.PI) / 180);
}

describe('AR floor facing', () => {
  it('matches three.js: upDot is the world-up part of the pose +Y axis', () => {
    for (const [axis, deg] of [
      [[1, 0, 0], 0],
      [[1, 0, 0], 37],
      [[0, 0, 1], 90],
      [[1, 0, 1], 145],
      [[0, 1, 0], 70],
      [[0.3, 0.8, -0.5], 61],
    ] as Array<[[number, number, number], number]>) {
      const q = quat(axis, deg);
      const want = new THREE.Vector3(0, 1, 0).applyQuaternion(q).y;
      expect(upDot(q.x, q.y, q.z, q.w)).toBeCloseTo(want, 9);
    }
  });

  it('accepts a level or slightly tilted floor and any heading, rejects walls and ceilings', () => {
    const ok = (q: THREE.Quaternion) => isFloorFacing(q.x, q.y, q.z, q.w);
    expect(ok(quat([1, 0, 0], 0))).toBe(true);
    expect(ok(quat([0, 1, 0], 123))).toBe(true); // turned around the vertical: still floor
    expect(ok(quat([1, 0, 0], 15))).toBe(true);
    expect(ok(quat([0, 0, 1], 25))).toBe(false);
    expect(ok(quat([1, 0, 0], 90))).toBe(false); // wall
    expect(ok(quat([1, 0, 0], 180))).toBe(false); // ceiling
  });
});

describe('AR floor watch', () => {
  it('counts the floor as found after a steady second of hits', () => {
    const w = new FloorWatch();
    let found = false;
    for (let t = 0; t <= STEADY_MS + 20; t += 16) found = w.update(t, true);
    expect(found).toBe(true);
  });

  it('is not found before the steady time has passed', () => {
    const w = new FloorWatch();
    let found = false;
    for (let t = 0; t < STEADY_MS - 20; t += 16) found = w.update(t, true);
    expect(found).toBe(false);
  });

  it('rides over a short flicker but restarts after a real gap', () => {
    const w = new FloorWatch();
    for (let t = 0; t <= 500; t += 16) w.update(t, true);
    // 100 ms flicker: keeps counting
    for (let t = 516; t <= 600; t += 16) w.update(t, false);
    let found = false;
    for (let t = 616; t <= STEADY_MS + 50; t += 16) found = w.update(t, true);
    expect(found).toBe(true);

    const v = new FloorWatch();
    for (let t = 0; t <= 600; t += 16) v.update(t, true);
    for (let t = 616; t <= 616 + DROPOUT_GRACE_MS + 100; t += 16) v.update(t, false);
    found = false;
    for (let t = 1000; t <= 1000 + STEADY_MS - 50; t += 16) found = v.update(t, true);
    expect(found).toBe(false);
  });

  it('starts over after reset', () => {
    const w = new FloorWatch();
    for (let t = 0; t <= STEADY_MS + 50; t += 16) w.update(t, true);
    w.reset();
    expect(w.update(STEADY_MS + 100, true)).toBe(false);
  });
});
