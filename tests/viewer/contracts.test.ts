import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateCapture,
  assertValidCapture,
  validateSceneManifest,
  assertValidSceneManifest,
  validateNavGrid,
  assertValidNavGrid,
  ValidationError,
  type Capture,
  type SceneManifest,
  type NavGrid,
  type ReconJob,
  type POI,
  type Route,
} from '../../viewer/src/contracts/index.js';
import { validatePoiSet } from '../../viewer/src/nav/pois.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.resolve(__dirname, '../fixtures');

function loadJson(filename: string): unknown {
  const filePath = path.join(fixturesDir, filename);
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

interface ExpectedItem {
  fixture: string;
  contract: 'Capture' | 'SceneManifest' | 'NavGrid' | 'PoiSet';
  expected_valid: boolean;
  check_layer: 'schema' | 'semantic' | null;
  description: string;
}

describe('Phase 1 Contracts: Cross-Validator Parity via expected.json', () => {
  const expectedList = loadJson('expected.json') as ExpectedItem[];

  it('contains expected fixture definitions', () => {
    expect(expectedList.length).toBeGreaterThanOrEqual(15);
  });

  expectedList.forEach(item => {
    it(`evaluates ${item.fixture} as ${item.expected_valid ? 'VALID' : 'INVALID'} (${item.contract})`, () => {
      const data = loadJson(item.fixture);
      let isValid = false;

      if (item.contract === 'Capture') {
        const res = validateCapture(data);
        isValid = res.valid;
      } else if (item.contract === 'SceneManifest') {
        const res = validateSceneManifest(data);
        isValid = res.valid;
      } else if (item.contract === 'NavGrid') {
        const res = validateNavGrid(data);
        isValid = res.valid;
      } else if (item.contract === 'PoiSet') {
        const errors = validatePoiSet(data);
        isValid = errors.length === 0;
      }

      expect(isValid).toBe(item.expected_valid);
    });
  });
});

describe('Phase 1 Contracts: Capture', () => {
  it('validates a correct capture payload', () => {
    const data = loadJson('capture_valid.json');
    const result = validateCapture(data);
    expect(result.valid).toBe(true);
    if (result.valid) {
      const capture: Capture = result.value;
      expect(capture.capture_id).toBe('cap_23j7x42k7z5b');
      expect(capture.schema_version).toBe(1);
    }
    expect(() => assertValidCapture(data)).not.toThrow();
  });

  it('rejects capture with invalid schema_version', () => {
    const data = loadJson('capture_invalid_version.json');
    const result = validateCapture(data);
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors?.some(e => e.includes('schema_version'))).toBe(true);
    expect(() => assertValidCapture(data)).toThrow(ValidationError);
  });

  it('rejects capture with malformed capture_id (characters 0, 1, 8, 9 outside RFC 4648 base32 [a-z2-7])', () => {
    const data = loadJson('capture_invalid_id.json');
    const result = validateCapture(data);
    expect(result.valid).toBe(false);
    expect(result.errors?.some(e => e.includes('capture_id'))).toBe(true);
    expect(() => assertValidCapture(data)).toThrow(ValidationError);
  });

  it('rejects capture missing mandatory fields', () => {
    const data = loadJson('capture_invalid_missing_fields.json');
    const result = validateCapture(data);
    expect(result.valid).toBe(false);
    expect(result.errors?.length).toBeGreaterThan(0);
    expect(() => assertValidCapture(data)).toThrow(ValidationError);
  });
});

describe('Phase 1 Contracts: SceneManifest', () => {
  it('validates a correct SceneManifest payload', () => {
    const data = loadJson('manifest_valid.json');
    const result = validateSceneManifest(data);
    expect(result.valid).toBe(true);
    if (result.valid) {
      const manifest: SceneManifest = result.value;
      expect(manifest.scene_id).toBe('scn_23j7x56k3y7a');
      expect(manifest.assets.full).toBe('ast_23j7x62k4x7c');
      expect(manifest.transform.world_from_splat.length).toBe(16);
    }
    expect(() => assertValidSceneManifest(data)).not.toThrow();
  });

  it('validates a correct SceneManifest payload with null scale_check_error_pct', () => {
    const data = loadJson('manifest_valid_null_scale_check.json');
    const result = validateSceneManifest(data);
    expect(result.valid).toBe(true);
    if (result.valid) {
      const manifest: SceneManifest = result.value;
      expect(manifest.transform.residuals.scale_check_error_pct).toBeNull();
    }
    expect(() => assertValidSceneManifest(data)).not.toThrow();
  });

  it('rejects manifest where asset_table is missing referenced assets.full (semantic check)', () => {
    const data = loadJson('manifest_invalid_assets.json');
    const result = validateSceneManifest(data);
    expect(result.valid).toBe(false);
    expect(result.errors?.some(e => e.includes('asset_table is missing'))).toBe(true);
    expect(() => assertValidSceneManifest(data)).toThrow(ValidationError);
  });

  it('rejects manifest where asset_table is missing referenced assets.lite (semantic check)', () => {
    const data = loadJson('manifest_invalid_missing_lite_asset.json');
    const result = validateSceneManifest(data);
    expect(result.valid).toBe(false);
    expect(result.errors?.some(e => e.includes('assets.lite'))).toBe(true);
    expect(() => assertValidSceneManifest(data)).toThrow(ValidationError);
  });

  it('rejects manifest with non-16 world_from_splat matrix (schema check)', () => {
    const data = loadJson('manifest_invalid_transform.json');
    const result = validateSceneManifest(data);
    expect(result.valid).toBe(false);
    expect(result.errors?.some(e => e.includes('world_from_splat'))).toBe(true);
    expect(() => assertValidSceneManifest(data)).toThrow(ValidationError);
  });

  it('rejects manifest with inverted bounds (semantic check)', () => {
    const data = loadJson('manifest_invalid_bounds.json');
    const result = validateSceneManifest(data);
    expect(result.valid).toBe(false);
    expect(result.errors?.some(e => e.includes('bounds.minX'))).toBe(true);
    expect(() => assertValidSceneManifest(data)).toThrow(ValidationError);
  });

  it('rejects manifest with bad sha256 checksum (schema check)', () => {
    const data = loadJson('manifest_invalid_sha256.json');
    const result = validateSceneManifest(data);
    expect(result.valid).toBe(false);
    expect(result.errors?.some(e => e.includes('sha256'))).toBe(true);
    expect(() => assertValidSceneManifest(data)).toThrow(ValidationError);
  });

  it('rejects manifest with bad asset kind (schema check)', () => {
    const data = loadJson('manifest_invalid_asset_kind.json');
    const result = validateSceneManifest(data);
    expect(result.valid).toBe(false);
    expect(result.errors?.some(e => e.includes('kind'))).toBe(true);
    expect(() => assertValidSceneManifest(data)).toThrow(ValidationError);
  });

  it('rejects manifest with start_pose outside bounds (semantic check)', () => {
    const data = loadJson('manifest_invalid_start_pose_bounds.json');
    const result = validateSceneManifest(data);
    expect(result.valid).toBe(false);
    expect(result.errors?.some(e => e.includes('start_pose.x'))).toBe(true);
    expect(() => assertValidSceneManifest(data)).toThrow(ValidationError);
  });
});

describe('Phase 1 Contracts: NavGrid', () => {
  it('validates a correct NavGrid payload', () => {
    const data = loadJson('navgrid_valid.json');
    const result = validateNavGrid(data);
    expect(result.valid).toBe(true);
    if (result.valid) {
      const navgrid: NavGrid = result.value;
      expect(navgrid.nav_id).toBe('nav_23j7x72k3w3c');
      expect(navgrid.cell_m).toBe(0.05);
    }
    expect(() => assertValidNavGrid(data)).not.toThrow();
  });

  it('rejects NavGrid with invalid base64 bitstring', () => {
    const data = loadJson('navgrid_invalid_base64.json');
    const result = validateNavGrid(data);
    expect(result.valid).toBe(false);
    expect(result.errors?.some(e => e.includes('free_bits_b64'))).toBe(true);
    expect(() => assertValidNavGrid(data)).toThrow(ValidationError);
  });

  it('rejects NavGrid with origin array of invalid dimension', () => {
    const data = loadJson('navgrid_invalid_origin.json');
    const result = validateNavGrid(data);
    expect(result.valid).toBe(false);
    expect(result.errors?.some(e => e.includes('origin'))).toBe(true);
    expect(() => assertValidNavGrid(data)).toThrow(ValidationError);
  });
});

describe('Phase 1 Contracts: Types-Only (ReconJob, POI, Route)', () => {
  it('instantiates valid ReconJob adhering to contract types', () => {
    const job: ReconJob = {
      schema_version: 1,
      job_id: 'job_23j7x52k5m2b',
      capture_id: 'cap_23j7x42k7z5b',
      status: 'success',
      stages_completed: ['s01_validate', 's02_frames', 's03_poses', 's04_train', 's05_export', 's06_normalize', 's07_compress', 's08_manifest', 's09_publish'],
      created_at: '2026-10-17T14:35:00Z',
      updated_at: '2026-10-17T15:05:00Z',
      scene_id: 'scn_23j7x56k3y7a',
    };
    expect(job.schema_version).toBe(1);
    expect(job.status).toBe('success');
  });

  it('instantiates valid POI adhering to contract types', () => {
    const poi: POI = {
      schema_version: 1,
      poi_id: 'poi_23j7x74k2n4d',
      scene_id: 'scn_23j7x56k3y7a',
      name: 'Coffee Table Centerpiece',
      category: 'furniture',
      description: 'Center of living room meeting space',
      position: { x: 0.5, y: 0.45, z: -1.2 },
      yaw_deg: 180.0,
      metadata: { clickable: true },
    };
    expect(poi.schema_version).toBe(1);
    expect(poi.poi_id.startsWith('poi_')).toBe(true);
  });

  it('instantiates valid Route adhering to contract types', () => {
    const route: Route = {
      schema_version: 1,
      route_id: 'nav_23j7x75k3p5e',
      scene_id: 'scn_23j7x56k3y7a',
      name: 'Entrance to Desk Walkway',
      waypoints: [
        { x: 0.0, y: 1.5, z: 0.0 },
        { x: 1.2, y: 1.5, z: 2.5 },
      ],
      total_distance_m: 2.77,
      estimated_time_s: 1.98,
    };
    expect(route.schema_version).toBe(1);
    expect(route.waypoints.length).toBe(2);
  });
});

describe('Phase 2 Contracts: PoiSet', () => {
  it('validates a correct pois payload', () => {
    const data = loadJson('pois_valid.json');
    const errors = validatePoiSet(data);
    expect(errors).toHaveLength(0);
  });

  it('rejects an invalid POI name', () => {
    const data = loadJson('pois_invalid_name.json');
    const errors = validatePoiSet(data);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.includes('name'))).toBe(true);
  });
});
