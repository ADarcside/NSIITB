/**
 * Namma Space: TypeScript Contract Validators
 * Usable by viewer at runtime to validate manifests and data packages.
 */

import {
  Capture,
  SceneManifest,
  NavGrid,
  ID_REGEX,
} from './types.js';

export class ValidationError extends Error {
  public errors: string[];

  constructor(message: string, errors: string[] = []) {
    super(message);
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

export type ValidationResult<T> =
  | { valid: true; value: T; errors?: undefined }
  | { valid: false; value?: undefined; errors: string[] };

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function isValidIsoDate(str: unknown): boolean {
  if (typeof str !== 'string' || !str) return false;
  const d = new Date(str);
  return !isNaN(d.getTime());
}

function isValidBase64(str: unknown): boolean {
  if (typeof str !== 'string' || str.length === 0) return false;
  const base64Regex = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  return base64Regex.test(str.trim());
}

function isValidHexSha256(str: unknown): boolean {
  return typeof str === 'string' && /^[a-f0-9]{64}$/i.test(str);
}

// =============================================================================
// Capture Validator
// =============================================================================

export function validateCapture(data: unknown): ValidationResult<Capture> {
  const errors: string[] = [];

  if (!isObject(data)) {
    return { valid: false, errors: ['Capture must be a non-null object'] };
  }

  if (data.schema_version !== 1) {
    errors.push(`Invalid schema_version: expected 1, got ${data.schema_version}`);
  }

  if (typeof data.capture_id !== 'string' || !/^cap_[a-z2-7]{12}$/.test(data.capture_id)) {
    errors.push(`Invalid capture_id: expected prefix 'cap_' + 12 lowercase base32 characters [a-z2-7], got ${data.capture_id}`);
  }

  if (data.space_id !== undefined) {
    if (typeof data.space_id !== 'string' || !/^spc_[a-z2-7]{12}$/.test(data.space_id)) {
      errors.push(`Invalid space_id: expected prefix 'spc_' + 12 lowercase base32 characters [a-z2-7], got ${data.space_id}`);
    }
  }

  const stringFields = ['space_name', 'device_model', 'os_version', 'operator', 'sop_version', 'lighting'];
  for (const field of stringFields) {
    if (typeof data[field] !== 'string' || (data[field] as string).trim() === '') {
      errors.push(`Field '${field}' must be a non-empty string`);
    }
  }

  if (typeof data.fps !== 'number' || isNaN(data.fps) || data.fps <= 0) {
    errors.push(`Field 'fps' must be a positive number, got ${data.fps}`);
  }

  if (!isValidIsoDate(data.captured_at)) {
    errors.push(`Field 'captured_at' must be a valid ISO 8601 date string, got ${data.captured_at}`);
  }

  // Resolution
  if (!isObject(data.resolution)) {
    errors.push("Field 'resolution' must be an object with 'w' and 'h'");
  } else {
    if (typeof data.resolution.w !== 'number' || !Number.isInteger(data.resolution.w) || data.resolution.w <= 0) {
      errors.push(`resolution.w must be a positive integer, got ${data.resolution.w}`);
    }
    if (typeof data.resolution.h !== 'number' || !Number.isInteger(data.resolution.h) || data.resolution.h <= 0) {
      errors.push(`resolution.h must be a positive integer, got ${data.resolution.h}`);
    }
  }

  // Scale pairs
  if (!Array.isArray(data.scale_pairs) || data.scale_pairs.length === 0) {
    errors.push("Field 'scale_pairs' must be a non-empty array");
  } else {
    data.scale_pairs.forEach((sp, idx) => {
      if (!isObject(sp)) {
        errors.push(`scale_pairs[${idx}] must be an object`);
      } else {
        if (typeof sp.a !== 'string' || sp.a.trim() === '') errors.push(`scale_pairs[${idx}].a must be non-empty`);
        if (typeof sp.b !== 'string' || sp.b.trim() === '') errors.push(`scale_pairs[${idx}].b must be non-empty`);
        if (typeof sp.distance_m !== 'number' || sp.distance_m <= 0) {
          errors.push(`scale_pairs[${idx}].distance_m must be a positive number`);
        }
        if (sp.role !== 'scale' && sp.role !== 'check') {
          errors.push(`scale_pairs[${idx}].role must be 'scale' or 'check', got ${sp.role}`);
        }
      }
    });
  }

  // Room dims (optional)
  if (data.room_dims_m !== undefined) {
    if (!isObject(data.room_dims_m)) {
      errors.push("Field 'room_dims_m' must be an object with width, length, height");
    } else {
      const { width, length, height } = data.room_dims_m;
      if (typeof width !== 'number' || width <= 0) errors.push('room_dims_m.width must be a positive number');
      if (typeof length !== 'number' || length <= 0) errors.push('room_dims_m.length must be a positive number');
      if (typeof height !== 'number' || height <= 0) errors.push('room_dims_m.height must be a positive number');
    }
  }

  // Consent
  if (!isObject(data.consent)) {
    errors.push("Field 'consent' must be an object with granted (boolean) and reference (string)");
  } else {
    if (typeof data.consent.granted !== 'boolean') {
      errors.push('consent.granted must be a boolean');
    }
    if (typeof data.consent.reference !== 'string' || data.consent.reference.trim() === '') {
      errors.push('consent.reference must be a non-empty string');
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, value: data as unknown as Capture };
}

export function assertValidCapture(data: unknown): asserts data is Capture {
  const result = validateCapture(data);
  if (!result.valid) {
    throw new ValidationError(`Capture validation failed:\n- ${result.errors.join('\n- ')}`, result.errors);
  }
}

// =============================================================================
// SceneManifest Validator
// =============================================================================

function validateAsset(asset: unknown, path: string): string[] {
  const errs: string[] = [];
  if (!isObject(asset)) {
    return [`${path} must be an object`];
  }
  if (asset.schema_version !== 1) errs.push(`${path}.schema_version must be 1`);
  if (typeof asset.asset_id !== 'string' || !/^ast_[a-z2-7]{12}$/.test(asset.asset_id)) {
    errs.push(`${path}.asset_id must be 'ast_' + 12 base32 chars [a-z2-7]`);
  }
  const kinds = ['splat_full', 'splat_lite', 'grid', 'pois', 'video', 'report'];
  if (!kinds.includes(asset.kind as string)) {
    errs.push(`${path}.kind must be one of: ${kinds.join(', ')}`);
  }
  const formats = ['spz', 'ply', 'json', 'mp4'];
  if (!formats.includes(asset.format as string)) {
    errs.push(`${path}.format must be one of: ${formats.join(', ')}`);
  }
  if (typeof asset.uri !== 'string' || asset.uri.trim() === '') {
    errs.push(`${path}.uri must be a non-empty string`);
  }
  if (!isValidHexSha256(asset.sha256)) {
    errs.push(`${path}.sha256 must be a 64-character hexadecimal SHA-256 hash`);
  }
  if (typeof asset.bytes !== 'number' || !Number.isInteger(asset.bytes) || asset.bytes < 0) {
    errs.push(`${path}.bytes must be a non-negative integer`);
  }
  if (asset.gaussians !== undefined) {
    if (typeof asset.gaussians !== 'number' || !Number.isInteger(asset.gaussians) || asset.gaussians < 0) {
      errs.push(`${path}.gaussians must be a non-negative integer`);
    }
  }
  return errs;
}

export function validateSceneManifest(data: unknown): ValidationResult<SceneManifest> {
  const errors: string[] = [];

  if (!isObject(data)) {
    return { valid: false, errors: ['SceneManifest must be a non-null object'] };
  }

  if (data.schema_version !== 1) {
    errors.push(`Invalid schema_version: expected 1, got ${data.schema_version}`);
  }

  if (typeof data.scene_id !== 'string' || !/^scn_[a-z2-7]{12}$/.test(data.scene_id)) {
    errors.push(`Invalid scene_id: expected prefix 'scn_' + 12 base32 chars [a-z2-7], got ${data.scene_id}`);
  }

  if (typeof data.space_id !== 'string' || !/^spc_[a-z2-7]{12}$/.test(data.space_id)) {
    errors.push(`Invalid space_id: expected prefix 'spc_' + 12 base32 chars [a-z2-7], got ${data.space_id}`);
  }

  if (typeof data.job_id !== 'string' || !/^job_[a-z2-7]{12}$/.test(data.job_id)) {
    errors.push(`Invalid job_id: expected prefix 'job_' + 12 base32 chars [a-z2-7], got ${data.job_id}`);
  }

  if (typeof data.version !== 'number' || !Number.isInteger(data.version) || data.version < 1) {
    errors.push(`Field 'version' must be an integer >= 1, got ${data.version}`);
  }

  if (!isValidIsoDate(data.created_at)) {
    errors.push(`Field 'created_at' must be a valid ISO 8601 date string, got ${data.created_at}`);
  }

  // Assets and asset table
  if (!isObject(data.assets)) {
    errors.push("Field 'assets' must be an object with at least 'full'");
  } else {
    if (typeof data.assets.full !== 'string' || !/^ast_[a-z2-7]{12}$/.test(data.assets.full)) {
      errors.push("assets.full must be a valid asset id ('ast_' + 12 base32 chars [a-z2-7])");
    }
    if (data.assets.lite !== undefined) {
      if (typeof data.assets.lite !== 'string' || !/^ast_[a-z2-7]{12}$/.test(data.assets.lite)) {
        errors.push("assets.lite must be a valid asset id ('ast_' + 12 base32 chars [a-z2-7])");
      }
    }
    for (const ref of ['grid', 'pois'] as const) {
      if (data.assets[ref] !== undefined) {
        if (typeof data.assets[ref] !== 'string' || !/^ast_[a-z2-7]{12}$/.test(data.assets[ref] as string)) {
          errors.push(`assets.${ref} must be a valid asset id ('ast_' + 12 base32 chars [a-z2-7])`);
        }
      }
    }
  }

  if (!isObject(data.asset_table)) {
    errors.push("Field 'asset_table' must be an object mapping asset_id to Asset details");
  } else {
    for (const [id, item] of Object.entries(data.asset_table)) {
      if (!ID_REGEX.test(id)) {
        errors.push(`Key '${id}' in asset_table must be a valid Id`);
      }
      errors.push(...validateAsset(item, `asset_table['${id}']`));
    }

    if (isObject(data.assets) && typeof data.assets.full === 'string') {
      if (!data.asset_table[data.assets.full]) {
        errors.push(`asset_table is missing required entry for assets.full ('${data.assets.full}')`);
      }
    }
    if (isObject(data.assets) && typeof data.assets.lite === 'string') {
      if (!data.asset_table[data.assets.lite]) {
        errors.push(`asset_table is missing required entry for assets.lite ('${data.assets.lite}')`);
      }
    }
    for (const ref of ['grid', 'pois'] as const) {
      if (isObject(data.assets) && typeof data.assets[ref] === 'string') {
        if (!data.asset_table[data.assets[ref] as string]) {
          errors.push(`asset_table is missing required entry for assets.${ref} ('${data.assets[ref]}')`);
        }
      }
    }
  }

  // Transform
  if (!isObject(data.transform)) {
    errors.push("Field 'transform' must be an object with world_from_splat, scale, method, residuals");
  } else {
    const t = data.transform;
    if (!Array.isArray(t.world_from_splat) || t.world_from_splat.length !== 16 || t.world_from_splat.some(n => typeof n !== 'number' || isNaN(n))) {
      errors.push('transform.world_from_splat must be an array of exactly 16 numbers');
    }
    if (typeof t.scale !== 'number' || t.scale <= 0) {
      errors.push(`transform.scale must be a positive number, got ${t.scale}`);
    }
    if (t.method !== 'floor_ransac+tape_pair') {
      errors.push(`transform.method must be 'floor_ransac+tape_pair', got ${t.method}`);
    }
    if (!isObject(t.residuals)) {
      errors.push('transform.residuals must be an object with floor_rms_m and scale_check_error_pct');
    } else {
      if (typeof t.residuals.floor_rms_m !== 'number' || t.residuals.floor_rms_m < 0) {
        errors.push('transform.residuals.floor_rms_m must be a non-negative number');
      }
      if (
        t.residuals.scale_check_error_pct !== null &&
        (typeof t.residuals.scale_check_error_pct !== 'number' || t.residuals.scale_check_error_pct < 0)
      ) {
        errors.push('transform.residuals.scale_check_error_pct must be a non-negative number or null');
      }
    }
  }

  // Start pose
  if (!isObject(data.start_pose)) {
    errors.push("Field 'start_pose' must be an object with x, z, yaw_deg");
  } else {
    const { x, z, yaw_deg } = data.start_pose;
    if (typeof x !== 'number' || isNaN(x)) errors.push('start_pose.x must be a number');
    if (typeof z !== 'number' || isNaN(z)) errors.push('start_pose.z must be a number');
    if (typeof yaw_deg !== 'number' || isNaN(yaw_deg)) errors.push('start_pose.yaw_deg must be a number');
  }

  if (typeof data.eye_height_m !== 'number' || data.eye_height_m <= 0) {
    errors.push(`Field 'eye_height_m' must be a positive number, got ${data.eye_height_m}`);
  }

  // Bounds
  if (!isObject(data.bounds)) {
    errors.push("Field 'bounds' must be an object with minX, maxX, minZ, maxZ");
  } else {
    const { minX, maxX, minZ, maxZ } = data.bounds;
    if (typeof minX !== 'number') errors.push('bounds.minX must be a number');
    if (typeof maxX !== 'number') errors.push('bounds.maxX must be a number');
    if (typeof minZ !== 'number') errors.push('bounds.minZ must be a number');
    if (typeof maxZ !== 'number') errors.push('bounds.maxZ must be a number');
    if (typeof minX === 'number' && typeof maxX === 'number' && minX > maxX) {
      errors.push(`bounds.minX (${minX}) cannot be greater than bounds.maxX (${maxX})`);
    }
    if (typeof minZ === 'number' && typeof maxZ === 'number' && minZ > maxZ) {
      errors.push(`bounds.minZ (${minZ}) cannot be greater than bounds.maxZ (${maxZ})`);
    }

    // Cross-check: start_pose must fall within bounds
    if (isObject(data.start_pose)) {
      const { x, z } = data.start_pose;
      if (typeof minX === 'number' && typeof maxX === 'number' && typeof x === 'number') {
        if (x < minX || x > maxX) {
          errors.push(`start_pose.x (${x}) is outside bounds [minX: ${minX}, maxX: ${maxX}]`);
        }
      }
      if (typeof minZ === 'number' && typeof maxZ === 'number' && typeof z === 'number') {
        if (z < minZ || z > maxZ) {
          errors.push(`start_pose.z (${z}) is outside bounds [minZ: ${minZ}, maxZ: ${maxZ}]`);
        }
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, value: data as unknown as SceneManifest };
}

export function assertValidSceneManifest(data: unknown): asserts data is SceneManifest {
  const result = validateSceneManifest(data);
  if (!result.valid) {
    throw new ValidationError(`SceneManifest validation failed:\n- ${result.errors.join('\n- ')}`, result.errors);
  }
}

// =============================================================================
// NavGrid Validator
// =============================================================================

export function validateNavGrid(data: unknown): ValidationResult<NavGrid> {
  const errors: string[] = [];

  if (!isObject(data)) {
    return { valid: false, errors: ['NavGrid must be a non-null object'] };
  }

  if (data.schema_version !== 1) {
    errors.push(`Invalid schema_version: expected 1, got ${data.schema_version}`);
  }

  if (typeof data.nav_id !== 'string' || !/^nav_[a-z2-7]{12}$/.test(data.nav_id)) {
    errors.push(`Invalid nav_id: expected prefix 'nav_' + 12 base32 chars [a-z2-7], got ${data.nav_id}`);
  }

  if (typeof data.transform_scene !== 'string' || !/^scn_[a-z2-7]{12}$/.test(data.transform_scene)) {
    errors.push(`Invalid transform_scene: expected prefix 'scn_' + 12 base32 chars [a-z2-7], got ${data.transform_scene}`);
  }

  if (typeof data.cell_m !== 'number' || data.cell_m <= 0) {
    errors.push(`Field 'cell_m' must be a positive number, got ${data.cell_m}`);
  }

  if (!Array.isArray(data.origin) || data.origin.length !== 2 || data.origin.some(n => typeof n !== 'number' || isNaN(n))) {
    errors.push("Field 'origin' must be an array of exactly 2 numbers [x, z]");
  }

  if (typeof data.width !== 'number' || !Number.isInteger(data.width) || data.width <= 0) {
    errors.push(`Field 'width' must be a positive integer, got ${data.width}`);
  }

  if (typeof data.height !== 'number' || !Number.isInteger(data.height) || data.height <= 0) {
    errors.push(`Field 'height' must be a positive integer, got ${data.height}`);
  }

  if (typeof data.agent_radius_m !== 'number' || data.agent_radius_m <= 0) {
    errors.push(`Field 'agent_radius_m' must be a positive number, got ${data.agent_radius_m}`);
  }

  if (!isValidBase64(data.free_bits_b64)) {
    errors.push("Field 'free_bits_b64' must be a valid base64-encoded bitstring");
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, value: data as unknown as NavGrid };
}

export function assertValidNavGrid(data: unknown): asserts data is NavGrid {
  const result = validateNavGrid(data);
  if (!result.valid) {
    throw new ValidationError(`NavGrid validation failed:\n- ${result.errors.join('\n- ')}`, result.errors);
  }
}
