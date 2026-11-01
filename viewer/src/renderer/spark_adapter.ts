/**
 * Namma Space: Spark SceneRenderer Adapter
 * Implements SceneRenderer using Spark 2.3.1 and Three.js 0.186.1.
 * Follows SPEC.md Section 7 and Hard Rule 8:
 * - Checks WebGL2 before initialization (throws E_WEBGL on failure).
 * - Creates WebGLRenderer with antialias: false (recommended by Spark docs for performance).
 * - Handles webglcontextlost cleanly.
 * - Applies world_from_splat transformation at runtime to the SplatMesh (never rewriting file).
 * - Disposes renderer, spark, and GPU meshes on reset/reload.
 */

import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import type { SceneRenderer, Matrix4Tuple, AssetRef } from '../types.js';
import type { Mat4 } from '../contracts/types.js';
import { assertWebGL2 } from '../loader/manifest.js';
import { ViewerError } from '../types.js';
import { THEME } from '../ui/tokens.js';

export interface SparkSceneRendererOptions {
  canvas?: HTMLCanvasElement;
  container?: HTMLElement;
  onContextLost?: () => void;
  onContextRestored?: () => void;
}

export class SparkSceneRenderer implements SceneRenderer {
  private readonly _canvas: HTMLCanvasElement;
  private readonly _renderer: THREE.WebGLRenderer;
  private readonly _scene: THREE.Scene;
  private readonly _spark: SparkRenderer;

  private _splatMesh: SplatMesh | null = null;
  private _worldFromSplat: Matrix4Tuple | Mat4 | null = null;
  private _isDisposed = false;

  private readonly _onContextLostHandler: (e: Event) => void;
  private readonly _onContextRestoredHandler: (e: Event) => void;

  constructor(options: SparkSceneRendererOptions = {}) {
    // 1. WebGL 2.0 validation
    const canvas = options.canvas || (typeof document !== 'undefined' ? document.createElement('canvas') : null);
    if (!canvas) {
      throw new ViewerError('E_WEBGL', 'No HTMLCanvasElement available for WebGL2 rendering');
    }
    assertWebGL2(canvas);
    this._canvas = canvas;

    // 2. Three.js WebGLRenderer with antialias: false per Spark specification
    this._renderer = new THREE.WebGLRenderer({
      canvas: this._canvas,
      antialias: false, // Critical: Spark documentation specifies antialias: false for 3DGS performance
      powerPreference: 'high-performance',
      alpha: false,
    });
    const pixelRatio = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
    this._renderer.setPixelRatio(Math.min(pixelRatio || 1, 2));
    // Clear to the page colour, so the frames before the first splats draw match the loading screen
    this._renderer.setClearColor(THEME.bg, 1);

    // 3. WebGL Context Loss Handling
    this._onContextLostHandler = (e: Event) => {
      e.preventDefault();
      console.warn('[SparkSceneRenderer] WebGL context lost');
      options.onContextLost?.();
    };

    this._onContextRestoredHandler = () => {
      console.info('[SparkSceneRenderer] WebGL context restored');
      options.onContextRestored?.();
    };

    this._canvas.addEventListener('webglcontextlost', this._onContextLostHandler);
    this._canvas.addEventListener('webglcontextrestored', this._onContextRestoredHandler);

    // 4. Scene and Spark setup
    this._scene = new THREE.Scene();
    this._spark = new SparkRenderer({ renderer: this._renderer });
    this._scene.add(this._spark);

    if (options.container && !this._canvas.parentElement) {
      options.container.appendChild(this._canvas);
      this.resize(options.container.clientWidth, options.container.clientHeight);
    }
  }

  get canvas(): HTMLCanvasElement {
    return this._canvas;
  }

  get renderer(): THREE.WebGLRenderer {
    return this._renderer;
  }

  get scene(): THREE.Scene {
    return this._scene;
  }

  /** Render resolution scale (1 = CSS pixels). Lower values trade sharpness for speed on weak GPUs. */
  setPixelRatio(ratio: number): void {
    if (this._isDisposed) return;
    this._renderer.setPixelRatio(ratio);
  }

  get pixelRatio(): number {
    return this._renderer.getPixelRatio();
  }

  resize(width: number, height: number): void {
    if (this._isDisposed) return;
    this._renderer.setSize(width, height, false);
  }

  /**
   * Applies world_from_splat transformation matrix directly to Three.js SplatMesh
   * at runtime without modifying original splat file (Hard Rule 8).
   */
  setWorldFromSplat(m: Matrix4Tuple | Mat4): void {
    this._worldFromSplat = m;
    if (this._splatMesh) {
      this._applyTransformToMesh(this._splatMesh, m);
    }
  }

  private _applyTransformToMesh(mesh: SplatMesh, m: Matrix4Tuple | Mat4): void {
    const mat4 = new THREE.Matrix4();
    mat4.fromArray(m);

    // Decompose matrix into position, quaternion, scale for accurate Three.js transform
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();

    mat4.decompose(pos, quat, scale);

    mesh.position.copy(pos);
    mesh.quaternion.copy(quat);
    mesh.scale.copy(scale);
    mesh.matrixAutoUpdate = true;
  }

  /**
   * Loads splat asset into the scene.
   * Passes verified buffer bytes directly (options.fileBytes) to avoid double download.
   * Awaits mesh.initialized (found in @sparkjsdev/spark/dist/types/SplatMesh.d.ts)
   * and maps decode failures to E_SPZ.
   */
  async load(asset: AssetRef, onProgress: (p: number) => void): Promise<void> {
    if (this._isDisposed) {
      throw new ViewerError('E_WEBGL', 'Renderer has been disposed.');
    }

    try {
      const meshOptions: {
        fileBytes?: ArrayBuffer | Uint8Array;
        fileName?: string;
        url?: string;
        onProgress?: (event: ProgressEvent) => void;
      } = {};

      if (asset.buffer) {
        // Option 'fileBytes' found in @sparkjsdev/spark/dist/types/SplatMesh.d.ts line 15
        meshOptions.fileBytes = asset.buffer;
        meshOptions.fileName = asset.uri || 'splat.spz';

        const isSpz = meshOptions.fileName.toLowerCase().endsWith('.spz');
        if (isSpz) {
          const bytes = new Uint8Array(asset.buffer);
          if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
            let found = 'insufficient bytes';
            if (bytes.length >= 4 && bytes[0] === 0x4e && bytes[1] === 0x47 && bytes[2] === 0x53 && bytes[3] === 0x50) {
              found = 'uncompressed NGSP (SPZ v4)';
            } else if (bytes.length > 0) {
              found = `bytes [${Array.from(bytes.slice(0, Math.min(bytes.length, 4))).map(b => b.toString(16).padStart(2, '0')).join(' ')}]`;
            }
            throw new ViewerError(
              'E_SPZ',
              `Unsupported SPZ version (found ${found}, expected gzip-compressed SPZ v2/v3 starting with 1f 8b)`
            );
          }
        }
      } else {
        meshOptions.url = asset.uri;
      }

      meshOptions.onProgress = (event: ProgressEvent) => {
        if (event.lengthComputable && event.total > 0) {
          onProgress(event.loaded / event.total);
        }
      };

      const mesh = new SplatMesh(meshOptions);

      // Property 'initialized: Promise<SplatMesh>' found in @sparkjsdev/spark/dist/types/SplatMesh.d.ts line 100
      await mesh.initialized;

      // Swap only once the new splat is decoded, so an upgrade (lite -> full) never shows a blank frame
      if (this._splatMesh) {
        this._scene.remove(this._splatMesh);
        this._splatMesh.dispose();
      }
      this._splatMesh = mesh;
      this._scene.add(mesh);

      // Apply pending transform if one was provided
      if (this._worldFromSplat) {
        this._applyTransformToMesh(mesh, this._worldFromSplat);
      }
    } catch (err: unknown) {
      if (err instanceof ViewerError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new ViewerError('E_SPZ', `Failed to decode Gaussian splat data: ${msg}`);
    }
  }

  render(camera: THREE.PerspectiveCamera): void {
    if (this._isDisposed) return;
    this._renderer.render(this._scene, camera);
  }

  dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;

    this._canvas.removeEventListener('webglcontextlost', this._onContextLostHandler);
    this._canvas.removeEventListener('webglcontextrestored', this._onContextRestoredHandler);

    if (this._splatMesh) {
      this._scene.remove(this._splatMesh);
      this._splatMesh.dispose();
      this._splatMesh = null;
    }

    this._spark.dispose();
    this._renderer.dispose();
  }
}
