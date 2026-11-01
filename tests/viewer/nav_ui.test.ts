import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { isTypingTarget } from '../../viewer/src/ui/app_ui.js';
import { projectLabel } from '../../viewer/src/nav/route_view.js';
import { searchPois } from '../../viewer/src/nav/search.js';
import type { POI } from '../../viewer/src/contracts/types.js';

describe('isTypingTarget', () => {
  it('returns true for interactive text elements', () => {
    expect(isTypingTarget({ target: { tagName: 'INPUT' } } as unknown as KeyboardEvent)).toBe(true);
    expect(isTypingTarget({ target: { tagName: 'textarea' } } as unknown as KeyboardEvent)).toBe(true);
    expect(isTypingTarget({ target: { tagName: 'Select' } } as unknown as KeyboardEvent)).toBe(true);
    expect(
      isTypingTarget({ target: { tagName: 'DIV', isContentEditable: true } } as unknown as KeyboardEvent)
    ).toBe(true);
  });

  it('returns false for non-text game targets', () => {
    expect(isTypingTarget({ target: { tagName: 'DIV' } } as unknown as KeyboardEvent)).toBe(false);
    expect(isTypingTarget({ target: { tagName: 'BUTTON' } } as unknown as KeyboardEvent)).toBe(false);
    expect(isTypingTarget({ target: { tagName: 'CANVAS' } } as unknown as KeyboardEvent)).toBe(false);
    expect(isTypingTarget({ target: null } as unknown as KeyboardEvent)).toBe(false);
    expect(isTypingTarget({} as unknown as KeyboardEvent)).toBe(false);
  });
});

describe('projectLabel', () => {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100);
  camera.position.set(0, 1.2, 0);
  camera.lookAt(0, 1.2, -10);
  camera.updateMatrixWorld();

  const width = 1920;
  const height = 1080;

  it('projects points in front of the camera onto the screen', () => {
    const inFront = { x: 0, y: 1.2, z: -4 };
    const res = projectLabel(inFront, camera, width, height, 12);
    expect(res.visible).toBe(true);
    expect(res.x).toBeCloseTo(width / 2, 0);
    expect(res.y).toBeCloseTo(height / 2, 0);
    expect(res.distance).toBeCloseTo(4, 1);
  });

  it('marks points behind the camera as not visible', () => {
    const behind = { x: 0, y: 1.2, z: 4 };
    const res = projectLabel(behind, camera, width, height, 12);
    expect(res.visible).toBe(false);
  });

  it('marks points at the camera plane as not visible', () => {
    const onPlane = { x: 0, y: 1.2, z: 0 };
    const res = projectLabel(onPlane, camera, width, height, 12);
    expect(res.visible).toBe(false);
  });

  it('hides points beyond maxDistance unless highlighted', () => {
    const far = { x: 0, y: 1.2, z: -15 };
    const normal = projectLabel(far, camera, width, height, 12, false);
    expect(normal.visible).toBe(false);

    const highlighted = projectLabel(far, camera, width, height, 12, true);
    expect(highlighted.visible).toBe(true);
  });
});

describe('searchPois for NavUI', () => {
  const samplePois: POI[] = [
    {
      schema_version: 1,
      poi_id: 'poi_111111111111',
      scene_id: 'scn_111111111111',
      name: 'Study desk',
      category: 'furniture',
      aliases: ['table', 'workspace'],
      position: { x: 1.2, y: 1.2, z: -0.85 },
    },
    {
      schema_version: 1,
      poi_id: 'poi_222222222222',
      scene_id: 'scn_111111111111',
      name: 'Exit door',
      category: 'exit',
      aliases: ['doorway'],
      position: { x: -0.5, y: 1.2, z: 2.1 },
    },
    {
      schema_version: 1,
      poi_id: 'poi_333333333333',
      scene_id: 'scn_111111111111',
      name: 'Bunk bed',
      category: 'furniture',
      position: { x: -1.0, y: 1.2, z: -1.5 },
    },
  ];

  it('empty query lists all POIs alphabetically by name', () => {
    const hits = searchPois(samplePois, '');
    expect(hits).toHaveLength(3);
    expect(hits.map(h => h.poi.name)).toEqual(['Bunk bed', 'Exit door', 'Study desk']);
  });

  it('matches by name, alias, and typo', () => {
    expect(searchPois(samplePois, 'desk')[0].poi.name).toBe('Study desk');
    expect(searchPois(samplePois, 'table')[0].poi.name).toBe('Study desk');
    expect(searchPois(samplePois, 'studyy')[0].poi.name).toBe('Study desk');
  });
});
