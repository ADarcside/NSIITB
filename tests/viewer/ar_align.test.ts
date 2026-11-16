/**
 * Namma Space AR: two-point alignment, checked against three.js transforms
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  TapSampler,
  TAP_STEADY_MS,
  arToScene,
  checkTaps,
  flipAlignment,
  sceneToAr,
  solveAlignment,
  type Vec3,
} from '../../viewer/src/ar/align.js';
import { wrapAngle } from '../../viewer/src/net/interp.js';

/** Scene -> AR with a three.js group (rotation.y = theta, position = t), like sceneRoot in AR */
function viaThree(theta: number, t: Vec3, p: Vec3): Vec3 {
  const g = new THREE.Group();
  g.rotation.y = theta;
  g.position.set(t.x, t.y, t.z);
  g.updateMatrixWorld(true);
  const v = new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(g.matrixWorld);
  return { x: v.x, y: v.y, z: v.z };
}

const sA = { x: 1.2, z: -0.4 };
const sB = { x: 2.9, z: 0.65 }; // ~2.0 m from A

describe('AR alignment maths', () => {
  it('sceneToAr matches a three.js group with rotation.y = theta and position = t', () => {
    for (const theta of [0, 0.7, -2.1, 3.0]) {
      const al = { theta, t: { x: 0.3, y: -1.4, z: 2.2 } };
      const p = { x: 1.1, y: 0.5, z: -3.3 };
      const ours = sceneToAr(al, p);
      const three = viaThree(theta, al.t, p);
      expect(ours.x).toBeCloseTo(three.x, 9);
      expect(ours.y).toBeCloseTo(three.y, 9);
      expect(ours.z).toBeCloseTo(three.z, 9);
      const back = arToScene(al, ours);
      expect(back.x).toBeCloseTo(p.x, 9);
      expect(back.z).toBeCloseTo(p.z, 9);
    }
  });

  it('recovers a known rotation and shift exactly', () => {
    for (const theta of [0, 0.9, -1.7, 2.8, Math.PI]) {
      const t = { x: -0.8, y: -1.35, z: 1.9 };
      const aA = viaThree(theta, t, { x: sA.x, y: 0, z: sA.z });
      const aB = viaThree(theta, t, { x: sB.x, y: 0, z: sB.z });
      const al = solveAlignment(sA, sB, aA, aB);
      expect(wrapAngle(al.theta - theta)).toBeCloseTo(0, 9);
      expect(al.t.x).toBeCloseTo(t.x, 9);
      expect(al.t.y).toBeCloseTo(t.y, 9);
      expect(al.t.z).toBeCloseTo(t.z, 9);
    }
  });

  it('taps in swapped order give a 180 degree result, and Flip corrects it', () => {
    const theta = 0.6;
    const t = { x: 0.2, y: -1.3, z: -0.5 };
    const aA = viaThree(theta, t, { x: sA.x, y: 0, z: sA.z });
    const aB = viaThree(theta, t, { x: sB.x, y: 0, z: sB.z });
    const swapped = solveAlignment(sA, sB, aB, aA);
    expect(Math.abs(wrapAngle(swapped.theta - theta))).toBeCloseTo(Math.PI, 9);
    const fixed = flipAlignment(sA, sB, aB, aA);
    expect(wrapAngle(fixed.theta - theta)).toBeCloseTo(0, 9);
    expect(fixed.t.x).toBeCloseTo(t.x, 9);
    expect(fixed.t.z).toBeCloseTo(t.z, 9);
  });

  it('noisy taps (2 cm) keep a point 3 m away within 10 cm', () => {
    const theta = -1.1;
    const t = { x: 1, y: -1.4, z: 0.4 };
    const far = { x: 4.5, y: 0, z: 2.5 };
    let worst = 0;
    for (let i = 0; i < 200; i++) {
      const n = () => (Math.random() * 2 - 1) * 0.02;
      const aA = viaThree(theta, t, { x: sA.x + n(), y: n(), z: sA.z + n() });
      const aB = viaThree(theta, t, { x: sB.x + n(), y: n(), z: sB.z + n() });
      expect(checkTaps(sA, sB, aA, aB).ok).toBe(true);
      const al = solveAlignment(sA, sB, aA, aB);
      const want = viaThree(theta, t, far);
      const got = sceneToAr(al, far);
      worst = Math.max(worst, Math.hypot(got.x - want.x, got.z - want.z));
    }
    expect(worst).toBeLessThan(0.1);
  });

  it('rejects a wrong distance with the measured value, and taps at different heights', () => {
    const aA = { x: 0, y: -1.3, z: 0 };
    const short = checkTaps(sA, sB, aA, { x: 1.82, y: -1.3, z: 0 });
    expect(short).toMatchObject({ ok: false, reason: 'distance' });
    if (!short.ok && short.reason === 'distance') {
      expect(short.tappedM).toBeCloseTo(1.82, 6);
      expect(short.expectedM).toBeCloseTo(Math.hypot(1.7, 1.05), 6);
    }
    // 4 cm off on a 2 m pair is inside the 5 cm tolerance
    const d = Math.hypot(1.7, 1.05);
    expect(checkTaps(sA, sB, aA, { x: d - 0.04, y: -1.3, z: 0 }).ok).toBe(true);
    expect(checkTaps(sA, sB, aA, { x: d, y: -1.15, z: 0 })).toMatchObject({ ok: false, reason: 'height' });
  });
});

describe('AR tap sampler', () => {
  it('gives the averaged point only after the ring has been still for the steady time', () => {
    const s = new TapSampler();
    let t = 0;
    for (; t < TAP_STEADY_MS - 200; t += 16) s.push(t, { x: 1 + (t % 32 ? 0.01 : -0.01), y: -1.3, z: 2 });
    expect(s.steadyPoint(t)).toBeNull();
    for (; t <= TAP_STEADY_MS + 50; t += 16) s.push(t, { x: 1 + (t % 32 ? 0.01 : -0.01), y: -1.3, z: 2 });
    const p = s.steadyPoint(t - 16);
    expect(p).not.toBeNull();
    expect(p!.x).toBeCloseTo(1, 1);
    expect(p!.z).toBeCloseTo(2, 6);
  });

  it('is not steady while the ring sweeps across the floor, or after a gap', () => {
    const s = new TapSampler();
    let t = 0;
    for (; t <= 800; t += 16) s.push(t, { x: t / 1000, y: -1.3, z: 0 }); // 1 m/s sweep
    expect(s.steadyPoint(t - 16)).toBeNull();
    const g = new TapSampler();
    for (t = 0; t <= 800; t += 16) g.push(t, { x: 0, y: -1.3, z: 0 });
    g.push(816, null);
    expect(g.steadyPoint(816)).toBeNull();
  });

  it('keeps going through a dropped floor hit and one jumpy frame', () => {
    const s = new TapSampler();
    let t = 0;
    for (; t <= 600; t += 16) {
      if (t === 320) s.push(t, null); // one frame without a floor hit
      else if (t === 400) s.push(t, { x: 0.3, y: -1.3, z: 0 }); // one jump of 30 cm
      else s.push(t, { x: 0, y: -1.3, z: 0 });
    }
    const p = s.steadyPoint(t - 16);
    expect(p).not.toBeNull();
    expect(Math.abs(p!.x)).toBeLessThan(0.02);
  });
});
