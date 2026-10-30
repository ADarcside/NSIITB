/**
 * Namma Space: Viewer Main Orchestrator
 * Follows SPEC.md Section 7:
 * - Reads ?scene= from URL (defaults to 'dev' synthetic scene if not specified)
 * - Fetches manifest.json from configurable base URL and validates schema
 * - Checks WebGL2, initializes Three.js PerspectiveCamera & SparkSceneRenderer
 * - Default collision provider is GhostCollisionProvider (with optional GridCollisionProvider toggle)
 * - FirstPersonMovementController with wall sliding, bounds clamping, 0.15s smoothing, pitch clamping
 * - Real FPS measurement and performance display
 * - Offers lite asset fallback when full asset fails
 * - Permanent "DEV SYNTHETIC SCENE" label when running synthetic dev scene
 */

import * as THREE from 'three';
import { SparkSceneRenderer } from './renderer/spark_adapter.js';
import { GhostCollisionProvider } from './collision/ghost.js';
import { GridCollisionProvider } from './collision/grid.js';
import { FirstPersonMovementController, BASE_FOV_DEG, type MoveMode } from './controls/movement.js';
import { Footsteps } from './controls/footsteps.js';
import { VanillaAppUI } from './ui/app_ui.js';
import {
  parseSceneParam,
  fetchAndValidateManifest,
  loadSceneSplatAsset,
  fetchAssetWithVerification,
} from './loader/manifest.js';
import { ViewerError } from './types.js';
import type { NavGrid } from './contracts/types.js';

async function bootstrap() {
  const canvas = document.getElementById('viewer-canvas') as HTMLCanvasElement;
  if (!canvas) {
    throw new Error('Canvas element #viewer-canvas not found');
  }

  // 1. Scene URL parameter & DEV detection
  const sceneParam = parseSceneParam() || (import.meta.env.VITE_DEFAULT_SCENE as string) || 'dev';
  const isDevScene = sceneParam === 'dev' || sceneParam.startsWith('scn_dev');

  // Configurable base URL
  const baseUrl = (import.meta.env.VITE_PUBLIC_BASE_URL as string) || '';

  // 2. UI Initialization
  let activeMode: 'Ghost' | 'Grid' = 'Ghost';
  let ghostProvider: GhostCollisionProvider | null = null;
  let gridProvider: GridCollisionProvider | null = null;
  let movementController: FirstPersonMovementController | null = null;
  let adaptQuality: ((fps: number) => void) | null = null;

  // Movement mode: free roam (default, Q/E fly) or walk (fixed height, game feel); ?move=walk starts in walk
  let moveMode: MoveMode = new URLSearchParams(window.location.search).get('move') === 'walk' ? 'walk' : 'free';
  const moveLabel = (m: MoveMode) => (m === 'walk' ? 'Walk' : 'Free roam');
  const footsteps = new Footsteps();
  const toggleMove = () => {
    moveMode = moveMode === 'walk' ? 'free' : 'walk';
    movementController?.setMode(moveMode);
    ui.setMoveMode(moveLabel(moveMode));
    ui.setVolumeVisible(moveMode === 'walk');
  };
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;
    if (e.code === 'KeyF') toggleMove();
    if (e.code === 'KeyM') {
      footsteps.toggleMute();
      ui.setVolume(footsteps.volume, footsteps.muted);
    }
    // Space jumps in Walk mode; keep it from scrolling or pressing a focused HUD button
    if (e.code === 'Space') e.preventDefault();
  });
  window.addEventListener('keyup', (e: KeyboardEvent) => {
    if (e.code === 'Space') e.preventDefault();
  });

  const ui = new VanillaAppUI({
    isDevScene,
    initialMode: 'Ghost',
    onReset: () => {
      movementController?.reset();
    },
    initialMoveLabel: moveLabel(moveMode),
    onMoveToggle: toggleMove,
    initialVolume: footsteps.muted ? 0 : footsteps.volume,
    onVolumeChange: v => {
      if (footsteps.muted && v > 0) footsteps.toggleMute();
      footsteps.setVolume(v);
    },
    onVolumeCommit: () => footsteps.play(),
    onModeToggle: () => {
      if (!gridProvider) {
        alert('Grid collision data is not available for this scene. Running in Ghost mode.');
        return;
      }
      activeMode = activeMode === 'Ghost' ? 'Grid' : 'Ghost';
      const provider = activeMode === 'Grid' ? gridProvider : ghostProvider!;
      movementController?.setCollision(provider);
      ui.setMode(activeMode);
    },
  });

  ui.setVolumeVisible(moveMode === 'walk');

  try {
    ui.showProgress(0.1);

    // 3. Fetch and Validate Manifest
    const manifest = await fetchAndValidateManifest(sceneParam, baseUrl);
    ui.showProgress(0.25);

    // 4. Set up Camera and Renderer
    const camera = new THREE.PerspectiveCamera(
      BASE_FOV_DEG,
      window.innerWidth / window.innerHeight,
      0.01,
      1000
    );

    const renderer = new SparkSceneRenderer({
      canvas,
      onContextLost: () => {
        ui.showError('E_WEBGL', 'WebGL context was lost. Please reload the page.');
      },
      onContextRestored: () => {
        console.info('Context restored, re-initializing scene');
      },
    });

    // Size the drawing buffer to the window now; otherwise it stays at the 300x150 canvas default
    // and is stretched by CSS until the first window resize (blurry, blocky render)
    renderer.resize(window.innerWidth, window.innerHeight);

    // Apply transform at runtime on splat object (never rewriting file per Hard Rule 8)
    renderer.setWorldFromSplat(manifest.transform.world_from_splat);

    // 5. Collision Providers (Ghost is default)
    ghostProvider = new GhostCollisionProvider(manifest.bounds);

    // If grid asset is defined in manifest, attempt to load it in background
    if (manifest.assets.grid && manifest.asset_table[manifest.assets.grid]) {
      const gridAsset = manifest.asset_table[manifest.assets.grid];
      fetchAssetWithVerification(gridAsset)
        .then(buf => {
          const text = new TextDecoder().decode(buf);
          const gridData = JSON.parse(text) as NavGrid;
          gridProvider = new GridCollisionProvider(gridData);
          // Walls and furniture are solid by default once the walkable grid is in; the Mode button switches back to Ghost
          activeMode = 'Grid';
          movementController?.setCollision(gridProvider);
          ui.setMode(activeMode);
        })
        .catch(err => {
          console.warn('[Viewer] Optional NavGrid could not be loaded:', err);
        });
    }

    // 6. Movement Controller
    movementController = new FirstPersonMovementController({
      startPose: manifest.start_pose,
      eyeHeightM: manifest.eye_height_m,
      collision: gridProvider ?? ghostProvider,
      mode: moveMode,
      onFootstep: sprint => footsteps.play(sprint),
      onLand: () => footsteps.play(false, true),
    });
    movementController.attachDomListeners(canvas);

    // Pointer Lock click-to-lock
    canvas.addEventListener('click', () => {
      if (document.pointerLockElement !== canvas) {
        canvas.requestPointerLock();
      }
    });

    // Temporary dev diagnostic option: allow loading dev_full.ply directly via ?format=ply or ?ply=true
    const searchParams = new URLSearchParams(window.location.search);
    const forcePly = isDevScene && (searchParams.get('format') === 'ply' || searchParams.get('ply') === 'true');

    if (forcePly) {
      console.info('[Viewer] Diagnostic mode: loading dev_full.ply instead of SPZ to isolate decoder');
      const plyUri = '/dev/dev_full.ply';
      const plyRes = await fetch(plyUri);
      if (!plyRes.ok) {
        throw new ViewerError('E_ASSET', `Failed to load diagnostic PLY from "${plyUri}": HTTP ${plyRes.status}`);
      }
      const plyBuffer = await plyRes.arrayBuffer();
      await renderer.load({ uri: plyUri, fileName: 'dev_full.ply', buffer: plyBuffer }, p => {
        ui.showProgress(0.9 + p * 0.1);
      });
      ui.showProgress(1.0);
    } else {
      // 7. Load Scene Asset (with lite fallback support)
      // Laptops and desktops load the full scene directly. Touch devices load lite (about
      // 12% of the full download) and stay on it. ?quality=full or ?quality=lite overrides.
      const quality = searchParams.get('quality');
      const hasLite = Boolean(manifest.assets.lite && manifest.asset_table[manifest.assets.lite]);
      const isTouch = window.matchMedia?.('(pointer: coarse)').matches ?? false;
      const liteFirst = hasLite && quality !== 'full' && (isTouch || quality === 'lite');
      const upgradeToFull = liteFirst && quality !== 'lite' && !isTouch;

      const loadedAsset = await loadSceneSplatAsset(manifest, {
        preferLite: liteFirst,
        onProgress: p => {
          // Map 0.25 -> 0.90 for download progress
          ui.showProgress(0.25 + p * 0.65);
        },
        onOfferLite: (error, retryLite) => {
          (error as unknown as { handledByOffer: boolean }).handledByOffer = true;
          ui.showError(error.code, error.message, async () => {
            try {
              ui.showProgress(0.5);
              const liteResult = await retryLite();
              await renderer.load(
                { uri: liteResult.asset.uri, sha256: liteResult.asset.sha256, buffer: liteResult.buffer },
                p => ui.showProgress(0.5 + p * 0.5)
              );
              ui.showProgress(1.0);
            } catch (retryErr: unknown) {
              const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
              ui.showError('E_ASSET', `Failed to load lite asset: ${msg}`);
            }
          });
        },
      });

      // Pass resolved asset to renderer (URI already resolved inside loader)
      const assetRef = {
        ...loadedAsset.asset,
        buffer: loadedAsset.buffer,
      };

      await renderer.load(assetRef, p => {
        ui.showProgress(0.9 + p * 0.1);
      });

      ui.showProgress(1.0);

      // Adaptive quality, driven by the measured FPS (see the render loop):
      //  - slow (< 20 fps for 3 s): first lower the render resolution (down to 0.75, keeping the
      //    full scene's detail), and only then go back from full to lite and lower it further
      //  - fast on lite (>= 35 fps for 2 s at full resolution): fetch the full scene and swap it in
      const liteRef = { ...assetRef };
      let onFull = !loadedAsset.isLite;
      let upgradeState: 'waiting' | 'loading' | 'done' = upgradeToFull ? 'waiting' : 'done';
      let slowSamples = 0;
      let fastSamples = 0;
      adaptQuality = (fps: number) => {
        slowSamples = fps < 20 ? slowSamples + 1 : 0;
        fastSamples = fps >= 35 ? fastSamples + 1 : 0;
        if (slowSamples >= 6) {
          slowSamples = 0;
          const floor = onFull && hasLite ? 0.75 : 0.5;
          if (renderer.pixelRatio > floor) {
            renderer.setPixelRatio(renderer.pixelRatio > 1 ? 1 : Math.max(floor, renderer.pixelRatio * 0.75));
            console.info(`[Viewer] Slow device: render scale ${renderer.pixelRatio.toFixed(2)}`);
          } else if (onFull && hasLite) {
            onFull = false;
            upgradeState = 'done';
            void renderer.load(liteRef, () => {});
            console.info('[Viewer] Slow device: back to the lite scene');
          }
        } else if (fastSamples >= 4 && upgradeState === 'waiting' && renderer.pixelRatio >= 1) {
          upgradeState = 'loading';
          const fullAsset = manifest.asset_table[manifest.assets.full];
          fetchAssetWithVerification(fullAsset)
            .then(buffer => (upgradeState === 'loading' ? renderer.load({ ...fullAsset, buffer }, () => {}) : undefined))
            .then(() => {
              if (upgradeState === 'loading') {
                onFull = true;
                upgradeState = 'done';
                console.info('[Viewer] Full-quality scene loaded');
              }
            })
            .catch(err => {
              upgradeState = 'done';
              console.warn('[Viewer] Staying on the lite scene; full scene failed to load:', err);
            });
        }
      };
    }

    // 8. Animation & Render Loop with Real FPS Counter
    let lastTime = performance.now();
    let frameCount = 0;
    let lastFpsUpdate = performance.now();

    const animate = (currentTime: number) => {
      requestAnimationFrame(animate);

      const dt = Math.max(0, (currentTime - lastTime) / 1000);
      lastTime = currentTime;

      // Real FPS measurement (measured, never asserted)
      frameCount++;
      if (currentTime - lastFpsUpdate >= 500) {
        const measuredFps = (frameCount * 1000) / (currentTime - lastFpsUpdate);
        ui.setFps(measuredFps);
        adaptQuality?.(measuredFps);
        frameCount = 0;
        lastFpsUpdate = currentTime;
      }

      // Update movement physics & camera
      if (movementController) {
        movementController.update(dt);
        const pose = movementController.pose;
        // Walk mode head bob / sway / sprint FOV are camera-only (zero and BASE_FOV_DEG in free roam)
        const off = movementController.cameraOffset;
        camera.position.set(
          pose.x + Math.cos(pose.yaw) * off.side,
          pose.y + off.y,
          pose.z - Math.sin(pose.yaw) * off.side
        );
        camera.rotation.set(pose.pitch, pose.yaw, 0, 'YXZ');
        if (camera.fov !== off.fov) {
          camera.fov = off.fov;
          camera.updateProjectionMatrix();
        }
      }

      renderer.render(camera);
    };

    requestAnimationFrame(animate);

    // 9. Window Resize Handling
    window.addEventListener('resize', () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.resize(window.innerWidth, window.innerHeight);
    });
  } catch (err: unknown) {
    if ((err as unknown as { handledByOffer?: boolean })?.handledByOffer) {
      return;
    }
    console.error('[Viewer Error]', err);
    if (err instanceof ViewerError) {
      ui.showError(err.code, err.message);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      ui.showError('E_MANIFEST', `Viewer failed to start: ${msg}`);
    }
  }
}

window.addEventListener('DOMContentLoaded', bootstrap);
