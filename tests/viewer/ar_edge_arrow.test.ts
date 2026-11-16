/**
 * AR edge arrow (viewer/src/ar/edge_arrow.ts): hidden while the target is in view, otherwise on
 * the right edge of the screen and pointing the right way, including targets behind the phone.
 */

import { describe, it, expect } from 'vitest';
import { EDGE_INSET, edgeArrow } from '../../viewer/src/ar/edge_arrow.js';

describe('AR edge arrow', () => {
  it('is hidden while the target is in view', () => {
    expect(edgeArrow(0, 0, false)).toBeNull();
    expect(edgeArrow(0.8, -0.8, false)).toBeNull();
  });

  it('sits on the right edge pointing right for a target off to the right', () => {
    const a = edgeArrow(2, 0, false)!;
    expect(a.x).toBeCloseTo(1 - EDGE_INSET, 6);
    expect(a.y).toBeCloseTo(0.5, 6);
    expect(a.angleDeg).toBeCloseTo(0, 6);
  });

  it('points up for a target above, and left for one to the left', () => {
    const up = edgeArrow(0, 3, false)!;
    expect(up.y).toBeCloseTo(EDGE_INSET, 6);
    expect(up.angleDeg).toBeCloseTo(-90, 6);
    const left = edgeArrow(-5, 0, false)!;
    expect(left.x).toBeCloseTo(EDGE_INSET, 6);
    expect(Math.abs(left.angleDeg)).toBeCloseTo(180, 6);
  });

  it('flips a target behind the phone, so it points the way to turn', () => {
    // Behind and to the left projects to the right of the screen: the arrow must point left
    const a = edgeArrow(0.4, 0, true)!;
    expect(a.x).toBeLessThan(0.5);
    expect(Math.abs(a.angleDeg)).toBeCloseTo(180, 6);
  });

  it('a target straight behind gives a downward arrow', () => {
    const a = edgeArrow(0, 0, true)!;
    expect(a.angleDeg).toBeCloseTo(90, 6);
    expect(a.y).toBeCloseTo(1 - EDGE_INSET, 6);
  });

  it('stays inside the screen for any direction', () => {
    for (let k = 0; k < 36; k++) {
      const ang = (k * Math.PI) / 18;
      for (const behind of [false, true]) {
        const a = edgeArrow(Math.cos(ang) * 4, Math.sin(ang) * 4, behind)!;
        expect(a.x).toBeGreaterThanOrEqual(EDGE_INSET - 1e-9);
        expect(a.x).toBeLessThanOrEqual(1 - EDGE_INSET + 1e-9);
        expect(a.y).toBeGreaterThanOrEqual(EDGE_INSET - 1e-9);
        expect(a.y).toBeLessThanOrEqual(1 - EDGE_INSET + 1e-9);
      }
    }
  });
});
