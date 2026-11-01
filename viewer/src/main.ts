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
import { VanillaAppUI, isTypingTarget } from './ui/app_ui.js';
import { NavUI } from './ui/nav_ui.js';
import { RouteView } from './nav/route_view.js';
import { MinimapUI } from './ui/minimap.js';
import { NavPlanner, type Point2 } from './nav/astar.js';
import { validatePoiSet, PoiDraftStore } from './nav/pois.js';
import { TagUI } from './ui/tag_ui.js';
import {
  parseSceneParam,
  fetchAndValidateManifest,
  loadSceneSplatAsset,
  fetchAssetWithVerification,
} from './loader/manifest.js';
import { ViewerError } from './types.js';
import type { NavGrid, POI } from './contracts/types.js';

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

  const searchParams = new URLSearchParams(window.location.search);
  const isTagMode = searchParams.get('tag') === '1';

  // 2. UI Initialization
  let activeMode: 'Ghost' | 'Grid' = 'Ghost';
  let ghostProvider: GhostCollisionProvider | null = null;
  let gridProvider: GridCollisionProvider | null = null;
  let movementController: FirstPersonMovementController | null = null;
  let adaptQuality: ((fps: number) => void) | null = null;

  // Movement mode: free roam (default, Q/E fly) or walk (fixed height, game feel); ?move=walk starts in walk
  let moveMode: MoveMode = searchParams.get('move') === 'walk' ? 'walk' : 'free';
  const moveLabel = (m: MoveMode) => (m === 'walk' ? 'Walk' : 'Free roam');
  const footsteps = new Footsteps();
  const toggleMove = () => {
    moveMode = moveMode === 'walk' ? 'free' : 'walk';
    movementController?.setMode(moveMode);
    ui.setMoveMode(moveLabel(moveMode));
    ui.setVolumeVisible(moveMode === 'walk');
  };
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (isTypingTarget(e)) return;
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
    if (isTypingTarget(e)) return;
    if (e.code === 'Space') e.preventDefault();
  });

  let minimap: MinimapUI | null = null;

  const ui = new VanillaAppUI({
    isDevScene,
    isTagMode,
    sceneId: sceneParam,
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
    onMinimapToggle: () => {
      minimap?.toggle();
    },
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

    const routeView = new RouteView(renderer.scene);
    const navUI = new NavUI();
    minimap = new MinimapUI({ isTagMode });

    let planner: NavPlanner | null = null;
    let targetPoi: POI | null = null;
    let currentPathPoints: Point2[] | null = null;
    let lastPlanPose: { x: number; z: number } | null = null;
    let lastPlanTime = 0;

    const planRoute = (poi: POI, animate = true) => {
      targetPoi = poi;
      if (!movementController) return;
      const pose = movementController.pose;
      lastPlanPose = { x: pose.x, z: pose.z };
      lastPlanTime = performance.now();

      if (planner) {
        const path = planner.findPath(
          { x: pose.x, z: pose.z },
          { x: poi.position.x, z: poi.position.z }
        );
        if (path) {
          currentPathPoints = path.points;
          routeView.setPath(path.points, animate);
          navUI.setRoute(poi.name, path.lengthM);
          routeView.setHighlight(poi.poi_id);
        } else {
          currentPathPoints = null;
          routeView.setPath(null, animate);
          navUI.setRoute(poi.name, null);
          routeView.setHighlight(poi.poi_id);
        }
      } else {
        // If there is no grid (Ghost-only scene), draw a straight line and append "(straight line, no floor map)"
        const points: Point2[] = [
          { x: pose.x, z: pose.z },
          { x: poi.position.x, z: poi.position.z },
        ];
        const dist = Math.hypot(poi.position.x - pose.x, poi.position.z - pose.z);
        currentPathPoints = points;
        routeView.setPath(points, animate);
        navUI.setRoute(poi.name, dist, ' (straight line, no floor map)');
        routeView.setHighlight(poi.poi_id);
      }
    };

    const getDistanceToPoi = (poi: POI): number | null => {
      if (!movementController) return null;
      const pose = movementController.pose;
      if (planner) {
        const path = planner.findPath(
          { x: pose.x, z: pose.z },
          { x: poi.position.x, z: poi.position.z }
        );
        return path ? path.lengthM : null;
      }
      return Math.hypot(poi.position.x - pose.x, poi.position.z - pose.z);
    };

    const lookAtPoi = (poi: POI) => {
      movementController?.lookAt(
        poi.position.x,
        poi.position.y ?? manifest.eye_height_m,
        poi.position.z,
        0.6
      );
    };

    // On pick from search dropdown: opens card, starts route, and turns camera smoothly
    navUI.onPick(poi => {
      const dist = getDistanceToPoi(poi);
      navUI.showPoiCard(poi, dist);
      planRoute(poi, true);
      lookAtPoi(poi);
    });

    // Clicking POI label in 3D scene opens POI card
    routeView.onPick(poi => {
      targetPoi = poi;
      tagUI?.selectPoi(poi.poi_id);
      const dist = getDistanceToPoi(poi);
      navUI.showPoiCard(poi, dist);
      routeView.setHighlight(poi.poi_id);
    });

    // Clicking POI dot on minimap opens POI card
    minimap.onSelectPoi(poi => {
      targetPoi = poi;
      tagUI?.selectPoi(poi.poi_id);
      const dist = getDistanceToPoi(poi);
      navUI.showPoiCard(poi, dist);
      routeView.setHighlight(poi.poi_id);
    });

    // POI card: Navigate button
    navUI.onNavigate(poi => {
      planRoute(poi, true);
      lookAtPoi(poi);
    });

    // POI card: Look button
    navUI.onLook(poi => {
      lookAtPoi(poi);
    });

    // Route card: Take me there (auto-walk)
    navUI.onToggleAutoWalk(() => {
      if (!movementController) return;
      if (movementController.isAutoWalking) {
        movementController.stopAutoWalk(true);
        navUI.setAutoWalking(false);
        return;
      }
      if (!currentPathPoints || currentPathPoints.length < 2) return;
      navUI.setAutoWalking(true);
      movementController.startAutoWalk(
        currentPathPoints,
        () => {
          navUI.setAutoWalking(false);
          if (targetPoi) {
            const arrivedName = targetPoi.name;
            targetPoi = null;
            currentPathPoints = null;
            routeView.setPath(null);
            routeView.setHighlight(null);
            navUI.showArrived(arrivedName);
          }
        },
        (stuck?: boolean) => {
          navUI.setAutoWalking(false);
          if (stuck && targetPoi) {
            navUI.showBlocked(targetPoi.name);
          }
        }
      );
    });

    navUI.onClear(() => {
      if (movementController?.isAutoWalking) {
        movementController.stopAutoWalk(true);
        navUI.setAutoWalking(false);
      }
      targetPoi = null;
      currentPathPoints = null;
      routeView.setPath(null);
      routeView.setHighlight(null);
      navUI.hidePoiCard();
    });

    // If grid asset is defined in manifest, attempt to load it in background
    if (manifest.assets.grid && manifest.asset_table[manifest.assets.grid]) {
      const gridAsset = manifest.asset_table[manifest.assets.grid];
      fetchAssetWithVerification(gridAsset)
        .then(buf => {
          const text = new TextDecoder().decode(buf);
          const gridData = JSON.parse(text) as NavGrid;
          gridProvider = new GridCollisionProvider(gridData);
          planner = new NavPlanner(gridData);
          minimap?.setGrid(gridData);
          if (targetPoi) {
            planRoute(targetPoi, false);
          }
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
      onReset: () => {
        if (targetPoi) {
          planRoute(targetPoi, false);
        }
      },
    });
    movementController.attachDomListeners(canvas);
    // Dev builds only: lets screenshot scripts place the camera
    if (import.meta.env.DEV) {
      (window as unknown as { __movementController?: FirstPersonMovementController }).__movementController = movementController;
    }

    // 6b. Tag Mode UI & POIs Loading (Round 2)
    let tagUI: TagUI | null = null;
    let placeTag: ((x: number, z: number) => void) | null = null;
    let activePois: POI[] = [];
    let manifestPois: POI[] = [];

    const draftStore = new PoiDraftStore(manifest.scene_id);
    const initialDraft = isTagMode ? draftStore.load() : null;

    if (isTagMode) {
      tagUI = new TagUI({
        sceneId: manifest.scene_id,
        getPose: () => movementController!.pose,
        isWalkable: (x, z) => (planner ? planner.isWalkable(x, z) : true),
        onPoisChange: pois => {
          activePois = pois;
          navUI.setPois(activePois);
          routeView.setPois(activePois);
        },
        onAdjustChange: on => {
          minimap?.setPlaceMode(on);
          routeView.setDraggable(on);
        },
      });

      if (initialDraft !== null) {
        activePois = initialDraft;
        navUI.setPois(activePois);
        routeView.setPois(activePois);
        tagUI.setPois(activePois);
        tagUI.showToast(`Loaded draft (${initialDraft.length} places)`);
      }

      window.addEventListener('keydown', (e: KeyboardEvent) => {
        if (isTypingTarget(e)) return;
        if (e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;
        if (e.code === 'KeyP') {
          e.preventDefault();
          tagUI?.openAdd();
        } else if (e.code === 'KeyT' && !tagUI?.isFormOpen) {
          e.preventDefault();
          tagUI?.toggleAdjust();
        }
      });

      // Moves the selected tag (Adjust mode floor/map click, or Shift-click on the map)
      placeTag = (x: number, z: number) => {
        if (!tagUI) return;
        if (!tagUI.selectedPoi && targetPoi) tagUI.selectPoi(targetPoi.poi_id);
        const moved = tagUI.moveSelected(x, z);
        if (moved && targetPoi?.poi_id === moved.poi_id) {
          planRoute(moved, false);
          navUI.showPoiCard(moved, getDistanceToPoi(moved));
        }
      };
      minimap.onRelocate((x, z) => placeTag?.(x, z));

      // Adjust mode drags: the label follows live (labels are projected from poi.position each frame),
      // and the drop saves the draft and replans a route that goes to this tag.
      const dropTag = (poi: POI, x: number, z: number) => {
        if (!tagUI) return;
        tagUI.movePoi(poi, x, z);
        if (targetPoi?.poi_id === poi.poi_id) {
          planRoute(poi, false);
          navUI.showPoiCard(poi, getDistanceToPoi(poi));
        }
      };
      minimap.onDragPoi((poi, x, z, done) => {
        if (done) dropTag(poi, x, z);
        else {
          poi.position.x = x;
          poi.position.z = z;
        }
      });

      const floorRay = new THREE.Raycaster();
      const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      const floorAt = (clientX: number, clientY: number): THREE.Vector3 | null => {
        const rect = canvas.getBoundingClientRect();
        const ndc = new THREE.Vector2(
          ((clientX - rect.left) / rect.width) * 2 - 1,
          -((clientY - rect.top) / rect.height) * 2 + 1
        );
        floorRay.setFromCamera(ndc, camera);
        const hit = floorRay.ray.intersectPlane(floorPlane, new THREE.Vector3());
        return hit && hit.distanceTo(camera.position) <= 30 ? hit : null;
      };
      routeView.onPillPointerDown((poi, down) => {
        if (!tagUI?.adjustMode) return false;
        const start = { x: down.clientX, y: down.clientY, px: poi.position.x, pz: poi.position.z };
        let moved = false;
        const onMove = (e: PointerEvent) => {
          if (e.pointerId !== down.pointerId) return;
          if (!moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 4) return;
          moved = true;
          document.body.style.cursor = 'grabbing';
          const hit = floorAt(e.clientX, e.clientY);
          if (hit) {
            poi.position.x = hit.x;
            poi.position.z = hit.z;
          }
        };
        const onUp = (e: PointerEvent) => {
          if (e.pointerId !== down.pointerId) return;
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onUp);
          document.body.style.cursor = '';
          if (!moved) {
            // A plain press still opens the card, as before
            routeView.suppressNextClick();
            tagUI?.selectPoi(poi.poi_id);
            targetPoi = poi;
            navUI.showPoiCard(poi, getDistanceToPoi(poi));
            routeView.setHighlight(poi.poi_id);
            return;
          }
          routeView.suppressNextClick();
          if (poi.position.x === start.px && poi.position.z === start.pz) {
            tagUI?.showToast('Drag onto the floor to move a tag');
            return;
          }
          dropTag(poi, poi.position.x, poi.position.z);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
        return true;
      });
    }

    const applyPois = (poiList: POI[]) => {
      manifestPois = poiList;
      if (tagUI) {
        tagUI.setManifestPois(manifestPois);
      }
      if (!isTagMode || initialDraft === null) {
        activePois = poiList;
        navUI.setPois(activePois);
        routeView.setPois(activePois);
        if (tagUI) {
          tagUI.setPois(activePois);
        }
      }
    };

    const devPoisUrl = searchParams.get('pois');
    const loadPois = async () => {
      try {
        if (devPoisUrl) {
          // Dev-only switch: load POI JSON directly from ?pois=<url> without hash verification
          const res = await fetch(devPoisUrl);
          if (!res.ok) throw new Error(`HTTP ${res.status} fetching dev pois from "${devPoisUrl}"`);
          const data = (await res.json()) as unknown;
          const errs = validatePoiSet(data);
          if (errs.length > 0) {
            console.warn('[Viewer] Invalid dev pois.json:', errs);
            return;
          }
          const poiList = (data as { pois: POI[] }).pois;
          console.info('[Viewer] Loaded POIs from manifest:', poiList.length);
          applyPois(poiList);
        } else if (manifest.assets.pois && manifest.asset_table[manifest.assets.pois]) {
          const poisAsset = manifest.asset_table[manifest.assets.pois];
          const buf = await fetchAssetWithVerification(poisAsset);
          const text = new TextDecoder().decode(buf);
          const data = JSON.parse(text) as unknown;
          const errs = validatePoiSet(data);
          if (errs.length > 0) {
            console.warn('[Viewer] Invalid pois.json in manifest:', errs);
            return;
          }
          const poiList = (data as { pois: POI[] }).pois;
          console.info('[Viewer] Loaded POIs from manifest:', poiList.length);
          applyPois(poiList);
        }
      } catch (err) {
        console.warn('[Viewer] Optional POIs could not be loaded:', err);
      }
    };
    void loadPois();

    // Pointer Lock click-to-lock
    canvas.addEventListener('click', () => {
      if (tagUI?.isFormOpen) return;
      if (document.pointerLockElement !== canvas) {
        canvas.requestPointerLock();
      }
    });

    // Temporary dev diagnostic option: allow loading dev_full.ply directly via ?format=ply or ?ply=true
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
        if (!movementController.isAutoWalking && navUI.isAutoWalking) {
          navUI.setAutoWalking(false);
        }

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

        // Route progress & arrival check
        if (targetPoi) {
          if (currentPathPoints && currentPathPoints.length > 0) {
            const goal = currentPathPoints[currentPathPoints.length - 1];
            const distToGoal = Math.hypot(pose.x - goal.x, pose.z - goal.z);
            if (distToGoal < 0.6) {
              const arrivedName = targetPoi.name;
              targetPoi = null;
              currentPathPoints = null;
              routeView.setPath(null);
              routeView.setHighlight(null);
              navUI.showArrived(arrivedName);
            } else if (
              !movementController.isAutoWalking &&
              lastPlanPose &&
              currentTime - lastPlanTime >= 500 &&
              Math.hypot(pose.x - lastPlanPose.x, pose.z - lastPlanPose.z) > 0.25
            ) {
              planRoute(targetPoi, false);
            }
          } else if (
            !movementController.isAutoWalking &&
            lastPlanPose &&
            currentTime - lastPlanTime >= 500 &&
            Math.hypot(pose.x - lastPlanPose.x, pose.z - lastPlanPose.z) > 0.25
          ) {
            planRoute(targetPoi, false);
          }
        }
      }

      // Update route ribbon animation and POI label overlays
      routeView.update(camera, dt);

      // Update floor-plan minimap
      if (movementController && minimap) {
        minimap.render(
          movementController.pose,
          activePois,
          currentPathPoints,
          (tagUI?.adjustMode ? tagUI.selectedPoi?.poi_id : null) ?? targetPoi?.poi_id ?? null
        );
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
