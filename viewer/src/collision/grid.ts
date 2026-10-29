/**
 * Namma Space: Grid Collision Provider
 * Decodes NavGrid 2D binary occupancy bitmap (free_bits_b64) and provides cell lookup.
 * Follows SPEC.md Section 7 & Section 9.
 * With height layers, setFlight(eyeY) switches to a small flying body (FLY_BELOW_M under the eye to
 * FLY_ABOVE_M over it, FLY_RADIUS_M wide) that is only blocked by what is at that height, so the
 * camera can rise over a bunk or crouch through the gap between bunks.
 */

import type { CollisionProvider, Bounds } from '../types.js';
import type { NavGrid } from '../contracts/types.js';

export function decodeBase64ToBytes(b64: string): Uint8Array {
  // Strip whitespace/newlines if present
  const cleanB64 = b64.replace(/\s+/g, '');
  if (typeof atob === 'function') {
    const binary = atob(cleanB64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } else if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(cleanB64, 'base64'));
  }
  throw new Error('No base64 decoding mechanism available in this runtime');
}

/** 1D squared Euclidean distance transform (Felzenszwalb & Huttenlocher), in cell units. */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/** Distance (in cells) from every cell centre to the nearest cell where target(cell) is true. */
export function distanceToCells(width: number, height: number, target: (i: number) => boolean): Float64Array {
  const BIG = 1e12;
  const grid = new Float64Array(width * height);
  for (let i = 0; i < grid.length; i++) grid[i] = target(i) ? 0 : BIG;
  const n = Math.max(width, height);
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  for (let c = 0; c < width; c++) {
    for (let r = 0; r < height; r++) f[r] = grid[r * width + c];
    edt1d(f, height, d, v, z);
    for (let r = 0; r < height; r++) grid[r * width + c] = d[r];
  }
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) f[c] = grid[r * width + c];
    edt1d(f, width, d, v, z);
    for (let c = 0; c < width; c++) grid[r * width + c] = Math.sqrt(d[c]);
  }
  return grid;
}

export const FLY_BELOW_M = 0.2;
export const FLY_ABOVE_M = 0.1;
export const FLY_RADIUS_M = 0.2;

/** Signed distance in metres from the free/blocked boundary of a cell mask: > 0 in free cells. */
function signedField(width: number, height: number, cell: number, free: Uint8Array): Float64Array {
  const toBlocked = distanceToCells(width, height, i => free[i] === 0);
  const toFree = distanceToCells(width, height, i => free[i] === 1);
  const field = new Float64Array(free.length);
  for (let i = 0; i < free.length; i++) {
    // Zero lies halfway between a free and a blocked cell centre
    field[i] = (free[i] ? Math.min(toBlocked[i], 1e6) - 0.5 : 0.5 - Math.min(toFree[i], 1e6)) * cell;
  }
  return field;
}

export class GridCollisionProvider implements CollisionProvider {
  private readonly _navgrid: NavGrid;
  private readonly _bytes: Uint8Array;
  private readonly _bounds: Bounds;
  private readonly _bitOrderMsb: boolean;

  constructor(navgrid: NavGrid, options?: { bitOrder?: 'msb' | 'lsb' }) {
    this._navgrid = navgrid;
    this._bytes = decodeBase64ToBytes(navgrid.free_bits_b64);
    this._bitOrderMsb = (options?.bitOrder ?? 'msb') === 'msb';
    this._layerBytes = navgrid.layers ? decodeBase64ToBytes(navgrid.layers.occupied_bits_b64) : null;

    const minX = navgrid.origin[0];
    const minZ = navgrid.origin[1];
    const maxX = minX + navgrid.width * navgrid.cell_m;
    const maxZ = minZ + navgrid.height * navgrid.cell_m;

    this._bounds = {
      minX: Math.min(minX, maxX),
      maxX: Math.max(minX, maxX),
      minZ: Math.min(minZ, maxZ),
      maxZ: Math.max(minZ, maxZ),
    };
  }

  isFree(x: number, z: number): boolean {
    if (this._flightY !== null) return this.clearance(x, z) > 0;
    return this._walkBit(x, z);
  }

  /** Walking grid bit at (x, z): true = free for the full-height walking body. */
  private _walkBit(x: number, z: number): boolean {
    const relX = x - this._navgrid.origin[0];
    const relZ = z - this._navgrid.origin[1];

    if (relX < 0 || relZ < 0) return false;

    const col = Math.floor(relX / this._navgrid.cell_m);
    const row = Math.floor(relZ / this._navgrid.cell_m);

    if (col < 0 || col >= this._navgrid.width || row < 0 || row >= this._navgrid.height) {
      return false;
    }

    const index = row * this._navgrid.width + col;
    const byteIndex = index >> 3; // index / 8

    if (byteIndex >= this._bytes.length) {
      return false;
    }

    const byte = this._bytes[byteIndex];
    const bitOffset = index & 7; // index % 8

    if (this._bitOrderMsb) {
      // MSB bit order: bit 0 is at bit 7 (0x80)
      return ((byte >> (7 - bitOffset)) & 1) === 1;
    } else {
      // LSB bit order: bit 0 is at bit 0 (0x01)
      return ((byte >> bitOffset) & 1) === 1;
    }
  }

  /**
   * Signed clearance in metres, smooth between cells: > 0 walkable, <= 0 blocked.
   * Bilinear over cell-centre distances, so walls and furniture edges become smooth
   * contours instead of 5 cm steps (used by the movement step for gliding along edges).
   * While flying it is the clearance of the flying body at the flight height.
   */
  clearance(x: number, z: number): number {
    return this._sample(this._flightY === null ? this._walkField() : this._flyField(this._flightY), x, z);
  }

  /** Clearance of the flying body at eye height eyeY (walking clearance when the grid has no layers). */
  clearanceAt(x: number, z: number, eyeY: number): number {
    return this._sample(this._layerBytes ? this._flyField(eyeY) : this._walkField(), x, z);
  }

  /** null = walk with the full-body grid; a number = fly at that eye height (needs height layers). */
  setFlight(eyeY: number | null): void {
    this._flightY = eyeY !== null && this._layerBytes ? eyeY : null;
  }

  get flying(): boolean {
    return this._flightY !== null;
  }

  get hasLayers(): boolean {
    return this._layerBytes !== null;
  }

  private _flightY: number | null = null;
  private _field: Float64Array | null = null;
  private readonly _flyFields = new Map<string, Float64Array>();
  private readonly _layerBytes: Uint8Array | null;

  private _sample(field: Float64Array, x: number, z: number): number {
    const g = this._navgrid;
    const fx = (x - g.origin[0]) / g.cell_m - 0.5;
    const fz = (z - g.origin[1]) / g.cell_m - 0.5;
    const c0 = Math.floor(fx), r0 = Math.floor(fz);
    const tx = fx - c0, tz = fz - r0;
    const at = (r: number, c: number): number =>
      r < 0 || c < 0 || r >= g.height || c >= g.width ? -g.cell_m : field[r * g.width + c];
    const top = at(r0, c0) * (1 - tx) + at(r0, c0 + 1) * tx;
    const bottom = at(r0 + 1, c0) * (1 - tx) + at(r0 + 1, c0 + 1) * tx;
    return top * (1 - tz) + bottom * tz;
  }

  private _walkField(): Float64Array {
    if (this._field) return this._field;
    const g = this._navgrid;
    const free = new Uint8Array(g.width * g.height);
    for (let i = 0; i < free.length; i++) {
      free[i] = this._walkBit(g.origin[0] + ((i % g.width) + 0.5) * g.cell_m,
        g.origin[1] + (Math.floor(i / g.width) + 0.5) * g.cell_m) ? 1 : 0;
    }
    this._field = signedField(g.width, g.height, g.cell_m, free);
    return this._field;
  }

  /** Clearance field of the flying body at eye height eyeY: blocked by any layer it overlaps. */
  private _flyField(eyeY: number): Float64Array {
    const g = this._navgrid;
    const L = g.layers!;
    const bytes = this._layerBytes!;
    const clampLayer = (i: number): number => Math.max(0, Math.min(L.count - 1, i));
    const i0 = clampLayer(Math.floor((eyeY - FLY_BELOW_M - L.y0_m) / L.dy_m));
    const i1 = clampLayer(Math.floor((eyeY + FLY_ABOVE_M - L.y0_m) / L.dy_m));
    const key = `${i0}:${i1}`;
    const cached = this._flyFields.get(key);
    if (cached) return cached;
    const n = g.width * g.height;
    const free = new Uint8Array(n).fill(1);
    for (let layer = i0; layer <= i1; layer++) {
      for (let i = 0; i < n; i++) {
        const bit = layer * n + i;
        if ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1) free[i] = 0;
      }
    }
    const field = signedField(g.width, g.height, g.cell_m, free);
    for (let i = 0; i < n; i++) field[i] -= FLY_RADIUS_M;
    this._flyFields.set(key, field);
    return field;
  }

  bounds(): Bounds {
    return { ...this._bounds };
  }

  get navgrid(): NavGrid {
    return this._navgrid;
  }
}
