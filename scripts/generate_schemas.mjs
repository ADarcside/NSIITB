#!/usr/bin/env node
/**
 * Schema Definition Script for Namma Space (Phase 1)
 * Writes hand-maintained JSON Schemas into pipeline/schemas/ matching
 * the canonical TypeScript contract definitions in viewer/src/contracts/types.ts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const schemasDir = path.resolve(rootDir, 'pipeline/schemas');

if (!fs.existsSync(schemasDir)) {
  fs.mkdirSync(schemasDir, { recursive: true });
}

// 12 lowercase base32 characters (RFC 4648 alphabet: a-z and 2-7)
const ID_PATTERN = '^(spc|flr|rom|cap|job|ast|scn|poi|nav)_[a-z2-7]{12}$';

const captureSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://nammaspace.org/schemas/capture.schema.json',
  title: 'Capture',
  description: 'Schema for phone video room capture and calibration metadata.',
  type: 'object',
  required: [
    'schema_version',
    'capture_id',
    'space_name',
    'device_model',
    'os_version',
    'resolution',
    'fps',
    'captured_at',
    'operator',
    'sop_version',
    'lighting',
    'scale_pairs',
    'consent'
  ],
  properties: {
    schema_version: {
      type: 'integer',
      const: 1,
      description: 'Schema version must be 1.'
    },
    capture_id: {
      type: 'string',
      pattern: '^cap_[a-z2-7]{12}$',
      description: 'Unique capture ID with cap_ prefix and 12 base32 [a-z2-7] characters.'
    },
    space_id: {
      type: 'string',
      pattern: '^spc_[a-z2-7]{12}$',
      description: 'Optional associated space ID with spc_ prefix and 12 base32 [a-z2-7] characters.'
    },
    space_name: {
      type: 'string',
      minLength: 1,
      description: 'Human-readable name of the space/room.'
    },
    device_model: {
      type: 'string',
      minLength: 1,
      description: 'Smartphone make and model (e.g. iPhone 15 Pro, Pixel 8).'
    },
    os_version: {
      type: 'string',
      minLength: 1,
      description: 'Operating system version.'
    },
    resolution: {
      type: 'object',
      required: ['w', 'h'],
      properties: {
        w: { type: 'integer', minimum: 1 },
        h: { type: 'integer', minimum: 1 }
      },
      additionalProperties: false
    },
    fps: {
      type: 'number',
      exclusiveMinimum: 0,
      description: 'Capture video frame rate (e.g. 30.0 or 60.0).'
    },
    captured_at: {
      type: 'string',
      format: 'date-time',
      description: 'ISO 8601 recording timestamp.'
    },
    operator: {
      type: 'string',
      minLength: 1,
      description: 'Name or identifier of capture operator.'
    },
    sop_version: {
      type: 'string',
      minLength: 1,
      description: 'Standard Operating Procedure version used for capture.'
    },
    lighting: {
      type: 'string',
      minLength: 1,
      description: 'Lighting conditions description (e.g. uniform indoor diffuse).'
    },
    scale_pairs: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['a', 'b', 'distance_m', 'role'],
        properties: {
          a: { type: 'string', minLength: 1 },
          b: { type: 'string', minLength: 1 },
          distance_m: { type: 'number', exclusiveMinimum: 0 },
          role: { type: 'string', enum: ['scale', 'check'] }
        },
        additionalProperties: false
      }
    },
    room_dims_m: {
      type: 'object',
      required: ['width', 'length', 'height'],
      properties: {
        width: { type: 'number', exclusiveMinimum: 0 },
        length: { type: 'number', exclusiveMinimum: 0 },
        height: { type: 'number', exclusiveMinimum: 0 }
      },
      additionalProperties: false
    },
    consent: {
      type: 'object',
      required: ['granted', 'reference'],
      properties: {
        granted: { type: 'boolean' },
        reference: { type: 'string', minLength: 1 }
      },
      additionalProperties: false
    },
    notes: {
      type: 'string'
    }
  },
  additionalProperties: false
};

const manifestSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://nammaspace.org/schemas/manifest.schema.json',
  title: 'SceneManifest',
  description: 'Viewer entry point manifest listing scene assets, hashes, camera bounds, and coordinate transform.',
  type: 'object',
  required: [
    'schema_version',
    'scene_id',
    'space_id',
    'version',
    'created_at',
    'job_id',
    'assets',
    'asset_table',
    'transform',
    'start_pose',
    'eye_height_m',
    'bounds'
  ],
  properties: {
    schema_version: {
      type: 'integer',
      const: 1
    },
    scene_id: {
      type: 'string',
      pattern: '^scn_[a-z2-7]{12}$'
    },
    space_id: {
      type: 'string',
      pattern: '^spc_[a-z2-7]{12}$'
    },
    version: {
      type: 'integer',
      minimum: 1
    },
    created_at: {
      type: 'string',
      format: 'date-time'
    },
    job_id: {
      type: 'string',
      pattern: '^job_[a-z2-7]{12}$'
    },
    assets: {
      type: 'object',
      required: ['full'],
      properties: {
        full: { type: 'string', pattern: '^ast_[a-z2-7]{12}$' },
        lite: { type: 'string', pattern: '^ast_[a-z2-7]{12}$' },
        grid: { type: 'string', pattern: '^ast_[a-z2-7]{12}$' }
      },
      additionalProperties: false
    },
    asset_table: {
      type: 'object',
      propertyNames: {
        pattern: ID_PATTERN
      },
      additionalProperties: {
        type: 'object',
        required: ['schema_version', 'asset_id', 'kind', 'format', 'uri', 'sha256', 'bytes'],
        properties: {
          schema_version: { type: 'integer', const: 1 },
          asset_id: { type: 'string', pattern: '^ast_[a-z2-7]{12}$' },
          kind: {
            type: 'string',
            enum: ['splat_full', 'splat_lite', 'grid', 'video', 'report']
          },
          format: {
            type: 'string',
            enum: ['spz', 'ply', 'json', 'mp4']
          },
          uri: { type: 'string', minLength: 1 },
          sha256: {
            type: 'string',
            pattern: '^[a-f0-9]{64}$'
          },
          bytes: { type: 'integer', minimum: 0 },
          gaussians: { type: 'integer', minimum: 0 }
        },
        additionalProperties: false
      }
    },
    transform: {
      type: 'object',
      required: ['world_from_splat', 'scale', 'method', 'residuals'],
      properties: {
        world_from_splat: {
          type: 'array',
          items: { type: 'number' },
          minItems: 16,
          maxItems: 16
        },
        scale: { type: 'number', exclusiveMinimum: 0 },
        method: { type: 'string', const: 'floor_ransac+tape_pair' },
        residuals: {
          type: 'object',
          required: ['floor_rms_m', 'scale_check_error_pct'],
          properties: {
            floor_rms_m: { type: 'number', minimum: 0 },
            scale_check_error_pct: { type: ['number', 'null'], minimum: 0 }
          },
          additionalProperties: false
        }
      },
      additionalProperties: false
    },
    start_pose: {
      type: 'object',
      required: ['x', 'z', 'yaw_deg'],
      properties: {
        x: { type: 'number' },
        z: { type: 'number' },
        yaw_deg: { type: 'number' }
      },
      additionalProperties: false
    },
    eye_height_m: {
      type: 'number',
      exclusiveMinimum: 0
    },
    bounds: {
      type: 'object',
      required: ['minX', 'maxX', 'minZ', 'maxZ'],
      properties: {
        minX: { type: 'number' },
        maxX: { type: 'number' },
        minZ: { type: 'number' },
        maxZ: { type: 'number' }
      },
      additionalProperties: false
    }
  },
  additionalProperties: false
};

const navGridSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://nammaspace.org/schemas/navgrid.schema.json',
  title: 'NavGrid',
  description: '2D binary occupancy navigation grid for collision testing and walkable area representation.',
  type: 'object',
  required: [
    'schema_version',
    'nav_id',
    'transform_scene',
    'cell_m',
    'origin',
    'width',
    'height',
    'agent_radius_m',
    'free_bits_b64'
  ],
  properties: {
    schema_version: {
      type: 'integer',
      const: 1
    },
    nav_id: {
      type: 'string',
      pattern: '^nav_[a-z2-7]{12}$'
    },
    transform_scene: {
      type: 'string',
      pattern: '^scn_[a-z2-7]{12}$'
    },
    cell_m: {
      type: 'number',
      exclusiveMinimum: 0
    },
    origin: {
      type: 'array',
      items: { type: 'number' },
      minItems: 2,
      maxItems: 2
    },
    width: {
      type: 'integer',
      minimum: 1
    },
    height: {
      type: 'integer',
      minimum: 1
    },
    agent_radius_m: {
      type: 'number',
      exclusiveMinimum: 0
    },
    free_bits_b64: {
      type: 'string',
      pattern: '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'
    }
  },
  additionalProperties: false
};

fs.writeFileSync(path.join(schemasDir, 'capture.schema.json'), JSON.stringify(captureSchema, null, 2) + '\n');
fs.writeFileSync(path.join(schemasDir, 'manifest.schema.json'), JSON.stringify(manifestSchema, null, 2) + '\n');
fs.writeFileSync(path.join(schemasDir, 'navgrid.schema.json'), JSON.stringify(navGridSchema, null, 2) + '\n');

console.log('Successfully wrote JSON schemas into pipeline/schemas/:');
console.log(' - capture.schema.json');
console.log(' - manifest.schema.json');
console.log(' - navgrid.schema.json');
