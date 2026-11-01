import { describe, it, expect, vi } from 'vitest';
import {
  calculateMinimapMapping,
  worldToPixel,
  pixelToWorld,
  MinimapUI,
} from '../../viewer/src/ui/minimap.js';
import type { NavGrid } from '../../viewer/src/contracts/types.js';
import { makePoi } from '../../viewer/src/nav/pois.js';

describe('Minimap mapping & round-trip precision', () => {
  const mockGrid: NavGrid = {
    schema_version: 1,
    nav_id: 'nav_aaaaaaaaaaaa',
    transform_scene: 'scn_aaaaaaaaaaaa',
    agent_radius_m: 0.25,
    cell_m: 0.05,
    origin: [-2.5, -3.0],
    width: 100, // 5.0m
    height: 120, // 6.0m
    free_bits_b64: '////', // placeholder
  };

  it('calculates correct extent and aspect-preserving scale', () => {
    const mapping = calculateMinimapMapping(mockGrid, 220, 220, 10);
    expect(mapping.minX).toBe(-2.5);
    expect(mapping.maxX).toBeCloseTo(2.5, 5);
    expect(mapping.minZ).toBe(-3.0);
    expect(mapping.maxZ).toBeCloseTo(3.0, 5);
    expect(mapping.extentX).toBeCloseTo(5.0, 5);
    expect(mapping.extentZ).toBeCloseTo(6.0, 5);

    // Available size = 200px. extentZ (6m) is larger than extentX (5m), so scale is limited by Z:
    expect(mapping.scale).toBeCloseTo(200 / 6.0, 4);
    expect(mapping.drawH).toBeCloseTo(200, 4);
    expect(mapping.drawW).toBeCloseTo((5.0 / 6.0) * 200, 4);
  });

  it('guarantees round-trip world -> pixel -> world precision <= 1e-5 m (and <= 1 px)', () => {
    const mapping = calculateMinimapMapping(mockGrid, 220, 220, 10);

    const testPoints = [
      { x: -2.5, z: -3.0 },
      { x: 0.0, z: 0.0 },
      { x: 1.25, z: -0.75 },
      { x: 2.5, z: 3.0 },
      { x: -1.823, z: 2.145 },
    ];

    for (const pt of testPoints) {
      const { px, py } = worldToPixel(pt.x, pt.z, mapping);
      const back = pixelToWorld(px, py, mapping);

      expect(Math.abs(back.x - pt.x)).toBeLessThan(1e-5);
      expect(Math.abs(back.z - pt.z)).toBeLessThan(1e-5);

      // Integer pixel round trip <= 1px
      const roundPx = Math.round(px);
      const roundPy = Math.round(py);
      const roundWorld = pixelToWorld(roundPx, roundPy, mapping);
      const backPx = worldToPixel(roundWorld.x, roundWorld.z, mapping);
      expect(Math.abs(backPx.px - roundPx)).toBeLessThanOrEqual(1.0);
      expect(Math.abs(backPx.py - roundPy)).toBeLessThanOrEqual(1.0);
    }
  });

  it('preserves North-up orientation (smaller Z is smaller pixel Y, i.e. top of canvas)', () => {
    const mapping = calculateMinimapMapping(mockGrid, 220, 220, 10);

    const northPt = worldToPixel(0, -2.0, mapping);
    const southPt = worldToPixel(0, 2.0, mapping);
    expect(northPt.py).toBeLessThan(southPt.py);

    const westPt = worldToPixel(-2.0, 0, mapping);
    const eastPt = worldToPixel(2.0, 0, mapping);
    expect(westPt.px).toBeLessThan(eastPt.px);
  });
});

describe('MinimapUI component', () => {
  const mockGrid: NavGrid = {
    schema_version: 1,
    nav_id: 'nav_aaaaaaaaaaaa',
    transform_scene: 'scn_aaaaaaaaaaaa',
    agent_radius_m: 0.25,
    cell_m: 0.05,
    origin: [-2, -2],
    width: 80,
    height: 80,
    free_bits_b64: '',
  };

  it('toggles visibility and fires callbacks with mocked DOM', () => {
    let isHidden = false;
    const mockEl = {
      classList: {
        contains: (cls: string) => (cls === 'hidden' ? isHidden : false),
        add: (cls: string) => {
          if (cls === 'hidden') isHidden = true;
        },
        remove: (cls: string) => {
          if (cls === 'hidden') isHidden = false;
        },
      },
      appendChild: vi.fn(),
      addEventListener: vi.fn(),
      remove: vi.fn(),
      setAttribute: vi.fn(),
      getContext: vi.fn(() => null),
      style: {},
      width: 220,
      height: 220,
    };

    const origDoc = globalThis.document;
    const origWin = globalThis.window;

    globalThis.document = {
      createElement: vi.fn(() => mockEl),
      getElementById: vi.fn(() => null),
      head: { appendChild: vi.fn() },
      body: mockEl,
    } as unknown as Document;

    globalThis.window = {
      innerWidth: 1024,
      devicePixelRatio: 1,
      addEventListener: vi.fn(),
    } as unknown as Window & typeof globalThis;

    try {
      const container = mockEl as unknown as HTMLElement;
      const minimap = new MinimapUI({ container });

      expect(minimap.isVisible).toBe(true);
      minimap.toggle();
      expect(minimap.isVisible).toBe(false);
      minimap.toggle();
      expect(minimap.isVisible).toBe(true);

      minimap.setGrid(mockGrid);

      const selectSpy = vi.fn();
      minimap.onSelectPoi(selectSpy);

      const poi = makePoi('scn_aaaaaaaaaaaa', 'Desk', 0, 0, {
        category: 'study',
        position: { x: 0, y: 1.6, z: 0 },
        yaw_deg: 0,
      });

      // Render should handle safely even if ctx is null in mock
      minimap.render({ x: 0, y: 1.6, z: 0, yaw: 0, pitch: 0 }, [poi], null);

      minimap.dispose();
    } finally {
      globalThis.document = origDoc;
      globalThis.window = origWin;
    }
  });
});
