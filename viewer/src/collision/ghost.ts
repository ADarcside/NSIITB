/**
 * Namma Space: Ghost Collision Provider
 * Allows free movement within room bounds; prevents exiting the room bounds.
 * Default collision provider per SPEC.md Section 1 and Section 7.
 */

import type { CollisionProvider, Bounds } from '../types.js';

export class GhostCollisionProvider implements CollisionProvider {
  private readonly _bounds: Bounds;

  constructor(bounds: Bounds) {
    this._bounds = {
      minX: Math.min(bounds.minX, bounds.maxX),
      maxX: Math.max(bounds.minX, bounds.maxX),
      minZ: Math.min(bounds.minZ, bounds.maxZ),
      maxZ: Math.max(bounds.minZ, bounds.maxZ),
    };
  }

  isFree(x: number, z: number): boolean {
    return (
      x >= this._bounds.minX &&
      x <= this._bounds.maxX &&
      z >= this._bounds.minZ &&
      z <= this._bounds.maxZ
    );
  }

  bounds(): Bounds {
    return { ...this._bounds };
  }
}
