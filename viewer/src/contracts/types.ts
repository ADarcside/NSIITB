/**
 * Namma Space: Core Data Contracts & Schema Types (Phase 1)
 * Source of truth for pipeline and browser viewer communication.
 *
 * Rules:
 * - Both pipeline and viewer exchange data solely through files/JSON with schema_version (Hard Rule 4).
 * - manifest.json is the primary entry point for the viewer (Hard Rule 5).
 * - All IDs adhere to the format: prefix (3 chars) + 12 lowercase base32 chars.
 */

export type IdPrefix = 'spc' | 'flr' | 'rom' | 'cap' | 'job' | 'ast' | 'scn' | 'poi' | 'nav';

/**
 * Unique identifier: prefix + 12 lowercase base32 characters [a-z2-7] (RFC 4648)
 * Valid prefixes: spc_, flr_, rom_, cap_, job_, ast_, scn_, poi_, nav_
 */
export type Id = string;

export const ID_REGEX = /^(spc|flr|rom|cap|job|ast|scn|poi|nav)_[a-z2-7]{12}$/;

/**
 * 4x4 matrix represented as 16 numbers in column-major order.
 */
export type Mat4 = number[];

export interface Resolution {
  w: number;
  h: number;
}

export interface ScalePair {
  a: string;
  b: string;
  distance_m: number;
  role: 'scale' | 'check';
}

export interface RoomDims {
  width: number;
  length: number;
  height: number;
}

export interface Consent {
  granted: boolean;
  reference: string;
}

/**
 * Capture metadata contract: records room recording metadata,
 * scale references, and operator consent.
 */
export interface Capture {
  schema_version: 1;
  capture_id: Id;
  space_id?: Id;
  space_name: string;
  device_model: string;
  os_version: string;
  resolution: Resolution;
  fps: number;
  captured_at: string;
  operator: string;
  sop_version: string;
  lighting: string;
  scale_pairs: ScalePair[];
  room_dims_m?: RoomDims;
  consent: Consent;
  notes?: string;
}

export type AssetKind = 'splat_full' | 'splat_lite' | 'grid' | 'video' | 'report';
export type AssetFormat = 'spz' | 'ply' | 'json' | 'mp4';

/**
 * Asset representation inside manifest asset table.
 */
export interface Asset {
  schema_version: 1;
  asset_id: Id;
  kind: AssetKind;
  format: AssetFormat;
  uri: string;
  sha256: string;
  bytes: number;
  gaussians?: number;
}

/**
 * Spatial transformation and scale alignment details.
 */
export interface SpatialTransform {
  world_from_splat: Mat4;
  scale: number;
  method: 'floor_ransac+tape_pair';
  residuals: {
    floor_rms_m: number;
    scale_check_error_pct: number | null;
  };
}

export interface Pose2D {
  x: number;
  z: number;
  yaw_deg: number;
}

export interface Bounds3D {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * SceneManifest contract: entry point manifest.json loaded by the viewer.
 */
export interface SceneManifest {
  schema_version: 1;
  scene_id: Id;
  space_id: Id;
  version: number;
  created_at: string;
  job_id: Id;
  assets: {
    full: Id;
    lite?: Id;
    grid?: Id;
  };
  asset_table: Record<Id, Asset>;
  transform: SpatialTransform;
  start_pose: Pose2D;
  eye_height_m: number;
  bounds: Bounds3D;
}

/**
 * NavGrid contract: 2D binary occupancy grid for collision detection.
 */
export interface NavGrid {
  schema_version: 1;
  nav_id: Id;
  transform_scene: Id;
  cell_m: number;
  origin: [number, number];
  width: number;
  height: number;
  agent_radius_m: number;
  free_bits_b64: string;
  /** Optional occupied cells per height slice (layer, row, column; MSB first), for flying/crouching. */
  layers?: NavGridLayers;
}

export interface NavGridLayers {
  y0_m: number;
  dy_m: number;
  count: number;
  occupied_bits_b64: string;
}

// =============================================================================
// Interfaces out of scope for Round 1 (defined as types only per SPEC.md Section 1/9)
// =============================================================================

export interface ReconJob {
  schema_version: 1;
  job_id: Id;
  capture_id: Id;
  status: 'queued' | 'running' | 'success' | 'failed';
  stages_completed: string[];
  created_at: string;
  updated_at: string;
  config?: Record<string, unknown>;
  error?: string;
  scene_id?: Id;
}

export interface POI {
  schema_version: 1;
  poi_id: Id;
  scene_id: Id;
  name: string;
  category?: string;
  description?: string;
  position: { x: number; y: number; z: number };
  yaw_deg?: number;
  metadata?: Record<string, unknown>;
}

export interface Route {
  schema_version: 1;
  route_id: Id;
  scene_id: Id;
  name?: string;
  waypoints: { x: number; y: number; z: number }[];
  total_distance_m: number;
  estimated_time_s?: number;
}
