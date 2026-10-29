/**
 * Namma Space: Viewer Core Interfaces and Types (SPEC.md Section 7)
 */

import type { PerspectiveCamera } from 'three';
import type { Asset, Mat4 } from './contracts/types.js';

export type Matrix4Tuple = [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number
];

export type AssetRef = Pick<Asset, 'uri'> & Partial<Asset> & { buffer?: ArrayBuffer; fileName?: string };

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface Pose3D {
  x: number;
  y: number;
  z: number;
  yaw: number;   // radians
  pitch: number; // radians
}

export interface Vec2 {
  x: number;
  z: number;
}

/**
 * 1. SceneRenderer interface: loads asset and renders through camera.
 */
export interface SceneRenderer {
  load(asset: AssetRef, onProgress: (p: number) => void): Promise<void>;
  setWorldFromSplat(m: Matrix4Tuple | Mat4): void;
  render(camera: PerspectiveCamera): void;
  dispose(): void;
}

/**
 * 2. CollisionProvider interface: ghost (default) or grid.
 */
export interface CollisionProvider {
  isFree(x: number, z: number): boolean;
  bounds(): Bounds;
  /** Optional smooth signed clearance in metres (> 0 walkable); enables gliding along edges. */
  clearance?(x: number, z: number): number;
  /**
   * Optional height-aware collision. setFlight(eyeY) switches to a small flying body around that
   * eye height (null = walking with the full-body grid); clearanceAt tests a height before moving to it.
   */
  setFlight?(eyeY: number | null): void;
  clearanceAt?(x: number, z: number, eyeY: number): number;
}

/**
 * 3. MovementController interface: first-person WASD + mouse-look.
 */
export interface MovementController {
  update(dt: number): void;
  reset(): void; // to manifest.start_pose
  readonly pose: Pose3D;
}

/**
 * 4. AppUI interface: progress bar, error panel, help overlay, fps counter.
 */
export interface AppUI {
  showProgress(p: number): void;
  showError(code: ViewerErrorCode, msg: string, onRetryLite?: () => void): void;
  toggleHelp(): void;
  setFps(v: number): void;
}

/**
 * Standard Viewer Error Codes per SPEC.md Section 7
 */
export type ViewerErrorCode = 'E_MANIFEST' | 'E_ASSET' | 'E_WEBGL' | 'E_SPZ';

export class ViewerError extends Error {
  readonly code: ViewerErrorCode;
  readonly recoverableWithLite: boolean;

  constructor(code: ViewerErrorCode, message: string, recoverableWithLite = false) {
    super(`[${code}] ${message}`);
    this.name = 'ViewerError';
    this.code = code;
    this.recoverableWithLite = recoverableWithLite;
  }
}
