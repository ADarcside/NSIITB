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
import { TouchControls } from './controls/touch_controls.js';
import { isTouchDevice } from './ui/device.js';
import { NavPlanner, type Point2 } from './nav/astar.js';
import { validatePoiSet, PoiDraftStore, poiGoal } from './nav/pois.js';
import { saveConfigFromEnv, saveLayoutLive, SaveError } from './nav/publish.js';
import { shareUrl, resolvePoiRef } from './nav/share.js';
import { activeRoute, arGuideLoader, registerArGuide } from './nav/active_route.js';
import { loadVoiceOn, saveVoiceOn, primeSpeechOnFirstGesture } from './nav/voice_pref.js';
import { visiblePlaces } from './ar/marks.js';
import type { TagUI } from './ui/tag_ui.js';
import { loadFeelSettings, mountFeelSettings } from './ui/walk_feel_settings.js';
import {
  parseSceneParam,
  fetchAndValidateManifest,
  loadSceneSplatAsset,
  fetchAssetWithVerification,
  resolveManifestUrl,
  resolveAssetUrl,
} from './loader/manifest.js';
import { parseLayout, type PublishedLayout } from './layout/layout_file.js';
import { ViewerError } from './types.js';
import { preventPageZoom, resetPageZoom } from './ui/no_page_zoom.js';
import type { NavGrid, POI } from './contracts/types.js';

// AR guide (VITE_AR=1 builds only): the route card's AR button opens ar.html; loaded on demand
if (import.meta.env.VITE_AR === '1') registerArGuide(() => import('./ar/ar_entry.js').then(m => m.arGuide));

async function bootstrap() {
  const canvas = document.getElementById('viewer-canvas') as HTMLCanvasElement;
  // Phones: the page never zooms (double tap, pinch, rotation, text boxes); see ui/no_page_zoom.ts
  if (isTouchDevice()) preventPageZoom();
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
  let onQualityToggle: (() => void) | null = null;

  // Movement mode: free roam (default, Q/E fly) or walk (fixed height, game feel); ?move=walk starts in walk
  let moveMode: MoveMode = searchParams.get('move') === 'walk' ? 'walk' : 'free';
  const moveLabel = (m: MoveMode) => (m === 'walk' ? 'Walk' : 'Free roam');
  const footsteps = new Footsteps();
  // Walk game feel: laptops only, never in tag mode (tag mode and phones keep the plain Walk mode)
  const gameFeel = !isTagMode && !isTouchDevice();
  const toggleMove = () => {
    moveMode = moveMode === 'walk' ? 'free' : 'walk';
    movementController?.setMode(moveMode);
    ui.setMoveMode(moveLabel(moveMode));
    ui.setVolumeVisible(moveMode === 'walk');
    touchControls?.setMode(moveMode);
    routeViewRef?.setFeel(gameFeel && moveMode === 'walk');
  };
  let touchControls: TouchControls | null = null;
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
  let routeViewRef: RouteView | null = null;

  // Tags button / L: show or hide the place labels; remembered on this device
  const LABELS_KEY = 'namma.labelsVisible';
  let labelsVisible = true;
  try {
    labelsVisible = window.localStorage.getItem(LABELS_KEY) !== '0';
  } catch {
    /* private mode: default on */
  }
  const toggleLabels = () => {
    labelsVisible = !labelsVisible;
    routeViewRef?.setLabelsVisible(labelsVisible);
    ui.setLabelsVisible(labelsVisible);
    try {
      window.localStorage.setItem(LABELS_KEY, labelsVisible ? '1' : '0');
    } catch {
      /* not saved */
    }
  };

  // Multiplayer entry. VITE_MP_BUTTON=1 (Round 2 page): a "Play with friends" button, behind a warning.
  // VITE_MP_BUTTON=0: kill switch, no multiplayer at all. Unset: the /multiplayer/ page opens the lobby
  // straight away, as before. Tag mode never has multiplayer.
  const mpButtonFlag = import.meta.env.VITE_MP_BUTTON as string | undefined;
  const mpButtonMode = !isTagMode && mpButtonFlag === '1' && Boolean(import.meta.env.VITE_MP_URL);
  let onFriendsClick: (() => void) | null = null;

  const ui = new VanillaAppUI({
    isDevScene,
    isTagMode,
    showFriendsButton: mpButtonMode,
    onFriendsClick: () => onFriendsClick?.(),
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
    onLabelsToggle: toggleLabels,
    onQualityToggle: () => onQualityToggle?.(),
    initialLabelsVisible: labelsVisible,
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
    routeViewRef = routeView;
    routeView.setLabelsVisible(labelsVisible);
    routeView.setFeel(gameFeel && moveMode === 'walk');
    /** Walk game feel: ring on the floor and a small camera settle when you reach a place */
    const celebrateArrival = (goal: Point2 | undefined) => {
      if (!goal || !movementController?.feelActive) return;
      routeView.playArrival(goal);
      movementController.settle();
    };
    const navUI = new NavUI();
    minimap = new MinimapUI({ isTagMode });

    let planner: NavPlanner | null = null;
    let loadedGrid: NavGrid | null = null;
    // Rearrange (move furniture, a private mode for every visitor): loaded on demand once the grid is in
    let rearrange: { update: () => void; refreshPois: () => void; setPaused: (on: boolean) => void } | null = null;
    /** True while the Rearrange panel is open (the 3D view then drags furniture instead of grabbing the mouse) */
    let rearrangeOpen = (): boolean => false;
    let targetPoi: POI | null = null;
    /** Start of the route when it is another place ("From" picker or ?from=); null = from the walker */
    let routeFrom: POI | null = null;
    let currentPathPoints: Point2[] | null = null;
    let lastPlanPose: { x: number; z: number } | null = null;
    let lastPlanTime = 0;

    // Voice guide (nav/voice_guide.ts): talks the walker along a route from where they stand, in
    // Take me there and when they walk it themselves (turns, distance left, arrival; directions
    // only). It loads on the first route, so the viewer download does not grow. Voice starts on
    // and the route card's speaker button mutes it; the card's live line shows the same words.
    // Not in tag mode, where routes jump around while tags are edited.
    type VoiceModule = typeof import('./nav/voice_guide.js');
    let voiceMod: VoiceModule | null = null;
    let voice: InstanceType<VoiceModule['VoiceGuide']> | null = null;
    let voiceLoading = false;
    /** The place the guide is talking the walker to, or null */
    let guidedId: string | null = null;
    /** The last replan happened because the walker left the route (for "Finding a new way") */
    let reroutePending = false;
    let voiceOn = loadVoiceOn();
    /** Walker speed sample, so "Turn around" only counts while moving */
    let moveSample = { x: 0, z: 0, t: 0 };
    let walkerMoving = false;
    const voiceAvailable = !isTagMode && 'speechSynthesis' in window;
    navUI.setVoiceAvailable(voiceAvailable);
    navUI.setVoiceOn(voiceOn);
    if (voiceAvailable) primeSpeechOnFirstGesture();
    navUI.onVoiceToggle(() => {
      if (voice) voiceOn = voice.toggleVoice();
      else {
        voiceOn = !voiceOn;
        saveVoiceOn(voiceOn);
      }
      navUI.setVoiceOn(voiceOn);
    });

    /** Starts, keeps or ends the voice guide to match the route on screen */
    const syncGuide = () => {
      const want = !isTagMode && targetPoi && !routeFrom && currentPathPoints ? targetPoi : null;
      if (!want) {
        if (guidedId !== null) {
          voice?.end();
          guidedId = null;
          navUI.setGuideLine(null);
        }
        return;
      }
      if (!voiceMod) {
        if (!voiceLoading) {
          voiceLoading = true;
          void import('./nav/voice_guide.js')
            .then(m => {
              voiceMod = m;
              voice = new m.VoiceGuide('en');
              voice.speaker.onSpeaking(on => footsteps.setDuck(on ? 0.3 : 1));
              syncGuide();
            })
            .catch(err => console.warn('[Viewer] voice guide unavailable:', err));
        }
        return;
      }
      if (!voice || !movementController || want.poi_id === guidedId) return;
      guidedId = want.poi_id;
      reroutePending = false;
      const pose = movementController.pose;
      voice.begin(performance.now(), want.name, voiceMod.viewerInput(currentPathPoints, { x: pose.x, z: pose.z }, pose.yaw, false, false));
    };

    /** The walker reached the guided place: the arrival line, before the route is cleared */
    const guideArrived = () => {
      if (guidedId !== null) voice?.arrive(performance.now());
    };

    const planRoute = (poi: POI, animate = true) => {
      targetPoi = poi;
      if (routeFrom?.poi_id === poi.poi_id) routeFrom = null;
      if (!movementController) return;
      const pose = movementController.pose;
      // A route from another place doesn't follow the walker, so it is never replanned as they move
      const start = routeFrom ? poiGoal(routeFrom) : { x: pose.x, z: pose.z };
      lastPlanPose = routeFrom ? null : { x: pose.x, z: pose.z };
      lastPlanTime = performance.now();
      // Replanned because the walker left the old route: the guide may say a new way was found
      if (voiceMod && guidedId === poi.poi_id && !routeFrom && voiceMod.isOffRoute(currentPathPoints, start)) reroutePending = true;

      let lengthM: number | null;
      if (planner) {
        const path = planner.findPath(start, poiGoal(poi));
        currentPathPoints = path ? path.points : null;
        lengthM = path ? path.lengthM : null;
        navUI.setRoute(poi.name, lengthM);
      } else {
        // If there is no grid (Ghost-only scene), draw a straight line and append "(straight line, no floor map)"
        const goal = poiGoal(poi);
        currentPathPoints = [start, goal];
        lengthM = Math.hypot(goal.x - start.x, goal.z - start.z);
        navUI.setRoute(poi.name, lengthM, ' (straight line, no floor map)');
      }
      routeView.setPath(currentPathPoints, animate);
      routeView.setHighlight(poi.poi_id);
      navUI.setFromChoices(activePois, routeFrom?.poi_id ?? null, poi.poi_id);
      activeRoute.set({ to: poi, from: routeFrom, points: currentPathPoints, lengthM });
      syncGuide();
    };

    /** Ends the route (cleared, or arrived) */
    const endRoute = () => {
      targetPoi = null;
      routeFrom = null;
      currentPathPoints = null;
      routeView.setPath(null);
      routeView.setHighlight(null);
      activeRoute.set(null);
      syncGuide();
    };

    const getDistanceToPoi = (poi: POI): number | null => {
      if (!movementController) return null;
      const pose = movementController.pose;
      if (planner) {
        const path = planner.findPath({ x: pose.x, z: pose.z }, poiGoal(poi));
        return path ? path.lengthM : null;
      }
      return Math.hypot(poi.position.x - pose.x, poi.position.z - pose.z);
    };

    // Spatial search: each result shows its walking distance from the visitor, nearest first on ties
    navUI.setDistanceSource(pois => {
      if (!movementController) return null;
      const pose = movementController.pose;
      if (planner) return planner.walkDistances({ x: pose.x, z: pose.z }, pois.map(poiGoal));
      return pois.map(p => Math.hypot(p.position.x - pose.x, p.position.z - pose.z));
    });

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
      if (routeFrom && targetPoi) {
        // Route from another place: go to its start first, facing the way, then walk it from there
        const [a, b] = currentPathPoints;
        movementController.setPose({ x: a.x, z: a.z, yaw: Math.atan2(-(b.x - a.x), -(b.z - a.z)), pitch: 0 });
        routeFrom = null;
        planRoute(targetPoi, false);
        if (!currentPathPoints || currentPathPoints.length < 2) return;
      }
      navUI.setAutoWalking(true);
      movementController.startAutoWalk(
        currentPathPoints,
        () => {
          navUI.setAutoWalking(false);
          if (targetPoi) {
            const arrivedName = targetPoi.name;
            const arrivedId = targetPoi.poi_id;
            celebrateArrival(currentPathPoints?.[currentPathPoints.length - 1]);
            guideArrived();
            endRoute();
            navUI.showArrived(arrivedName, arrivedId);
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
      endRoute();
      navUI.hidePoiCard();
    });

    // Route card: start from you or from another place
    navUI.onFromChange(id => {
      routeFrom = id ? (activePois.find(p => p.poi_id === id) ?? null) : null;
      if (targetPoi) planRoute(targetPoi, true);
    });

    // Place card: Share (link + QR code); the share dialog and QR encoder load only when used
    navUI.onShare(poi => {
      const from = targetPoi?.poi_id === poi.poi_id ? routeFrom : null;
      void import('./ui/share_ui.js').then(({ openShareDialog }) =>
        openShareDialog({
          title: poi.name,
          subtitle: from ? `Opens the route from ${from.name}` : 'Opens the room with the route to this place',
          url: shareUrl(window.location.href, poi, from),
        })
      );
    });

    // AR guidance slot: the button shows only once an AR guide is registered and this device can run it
    const loadAr = arGuideLoader();
    if (loadAr) {
      void loadAr()
        .then(async guide => {
          if (!(await guide.supported())) return;
          activeRoute.subscribe(r => navUI.setArAvailable(Boolean(r?.points)));
          navUI.onAr(() => void guide.start(activeRoute));
        })
        .catch(err => console.warn('[Viewer] AR guidance unavailable:', err));
    }

    /**
     * The room layout for everyone (layout.json next to the manifest, optional). Not a manifest asset,
     * so it is fetched fresh each visit and a missing file just means the room as scanned.
     */
    const layoutFile: Promise<string | null> = searchParams.get('layout') === 'off'
      ? Promise.resolve(null)
      : fetch(resolveAssetUrl('layout.json', resolveManifestUrl(sceneParam, baseUrl)), { cache: 'no-cache' })
        .then(res => (res.ok ? res.text() : null))
        .catch(() => null);

    /**
     * Rearrange: the layout in use is applied to the grid, the tags, the minimap and the scene.
     * Everyone gets the published layout and the private Rearrange mode (?rearrange=0 hides it), and tag
     * mode the admin one that saves the layout for everyone.
     */
    const startRearrange = async (gridData: NavGrid, gridHash: string) => {
      const text = await layoutFile;
      let published: PublishedLayout | null = null;
      if (text) {
        const parsed = parseLayout(text, manifest.scene_id, gridHash);
        if (parsed.warning && !text.trimStart().startsWith('<')) console.warn('[Viewer]', parsed.warning);
        published = parsed.layout;
      }
      const mode = isTagMode ? 'admin' : searchParams.get('rearrange') === '0' ? 'view' : 'visitor';
      if (mode === 'view' && !published?.moves.length) return;
      try {
        const [{ RearrangeController }, { RearrangeUI }, { movedCorners }] = await Promise.all([
          import('./layout/rearrange.js'),
          import('./ui/rearrange_ui.js'),
          import('./layout/layout.js'),
        ]);
        let rrUI: InstanceType<typeof RearrangeUI> | null = null;
        const rr = new RearrangeController({
          sceneId: manifest.scene_id,
          gridHash,
          grid: gridData,
          start: { x: manifest.start_pose.x, z: manifest.start_pose.z },
          scene: renderer.scene,
          getMesh: () => renderer.splatMesh,
          worldFromSplat: manifest.transform.world_from_splat,
          getPose: () => movementController?.pose ?? { x: manifest.start_pose.x, z: manifest.start_pose.z },
          // Tag mode owns the tags (an unsaved draft may differ from the live ones): admin leaves them as they are
          getPois: () => (mode === 'admin' ? activePois : manifestPois),
          applyGrid: g => {
            gridProvider = new GridCollisionProvider(g);
            planner = new NavPlanner(g);
            if (activeMode === 'Grid') movementController?.setCollision(gridProvider);
            if (targetPoi) planRoute(targetPoi, false);
          },
          applyPois: list => {
            if (mode === 'admin') return;
            activePois = list;
            navUI.setPois(activePois);
            routeView.setPois(activePois);
            if (targetPoi) targetPoi = activePois.find(p => p.poi_id === targetPoi!.poi_id) ?? targetPoi;
          },
          applyPlanMoves: (objects, moves, movedPois) => {
            const byId = new Map(objects.map(o => [o.id, o]));
            minimap?.setPlanMoves(new Map(moves.filter(m => byId.has(m.id)).map(m => [m.id, movedCorners(byId.get(m.id)!, m)])), movedPois);
          },
          toast: msg => rrUI?.toast(msg),
          layoutOff: searchParams.get('layout') === 'off',
          mode,
          published: published ? { moves: published.moves, locked: published.locked, boxes: published.boxes, updatedAt: published.updated_at } : undefined,
        });
        const saveConfig = saveConfigFromEnv(import.meta.env);
        /** Admin: Save for everyone (same GitHub key and live folder as the tags) */
        const saveLayout = async () => {
          const toast = (msg: string) => rrUI?.toast(msg);
          if (!saveConfig || !tagUI) return toast('Saving is not set up for this build');
          const cut = rr.unreachable();
          if (cut.length) return toast(`Not saved: ${cut.slice(0, 3).join(', ')}${cut.length > 3 ? ` and ${cut.length - 3} more` : ''} can't be reached`);
          const token = await tagUI.getKey();
          if (!token) return;
          const n = rr.moves.length;
          const ok = await tagUI.ask({
            title: n ? `Save this layout (${n} piece${n === 1 ? '' : 's'} moved) for everyone?` : 'Put the room back as scanned for everyone?',
            confirmLabel: 'Save for everyone',
          });
          if (!ok) return;
          const layout = { sceneId: manifest.scene_id, gridHash, moves: rr.moves, locked: rr.locked, boxes: rr.boxEdits };
          try {
            let res;
            try {
              res = await saveLayoutLive(saveConfig, token, layout, undefined, { expectedBase: rr.baseUpdatedAt });
            } catch (err) {
              if (!(err instanceof SaveError && err.conflict)) throw err;
              const overwrite = await tagUI.ask({ title: `${err.message} Replace it with yours?`, confirmLabel: 'Replace live layout', cancelLabel: 'Keep live layout' });
              if (!overwrite) return toast('Not saved. Reload the page to see the live layout.');
              res = await saveLayoutLive(saveConfig, token, layout, undefined, { force: true });
            }
            rr.markPublished(res.updatedAt);
            toast('Saved. The live site updates in about a minute.');
          } catch (err) {
            if (err instanceof SaveError && err.badToken) {
              tagUI.forgetKey();
              toast(`${err.message} Press Save to enter the key again.`);
            } else {
              toast(`Not saved: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        };
        if (mode !== 'view') {
          rrUI = new RearrangeUI(rr, {
            getPose: () => movementController?.pose ?? { x: 0, z: 0, yaw: 0 },
            onOpenChange: () => movementController?.clearKeys(),
            save: mode === 'admin' ? saveLayout : undefined,
          });
          // Laptop extra: drag a piece straight in the 3D view while the panel is open
          const ray = new THREE.Raycaster();
          rrUI.attach3D(canvas, (cx, cy) => {
            const rect = canvas.getBoundingClientRect();
            ray.setFromCamera(new THREE.Vector2(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1), camera);
            return { origin: ray.ray.origin, dir: ray.ray.direction };
          });
          rearrangeOpen = () => rrUI?.isOpen ?? false;
        }
        rr.start();
        rearrange = rr;
        if (import.meta.env.DEV) (window as unknown as { __rr?: unknown }).__rr = { rr, ui: rrUI };
        if (rrUI) {
          const tip = mode === 'admin' ? 'Move furniture for everyone' : 'Move furniture around (only you see it)';
          ui.addAction('rearrange-btn', 'rearrange', mode === 'admin' ? 'Layout' : 'Rearrange', '', tip, () => rrUI?.toggle());
        }
      } catch (err) {
        console.warn('[Viewer] Rearrange unavailable:', err);
      }
    };

    // If grid asset is defined in manifest, attempt to load it in background
    if (manifest.assets.grid && manifest.asset_table[manifest.assets.grid]) {
      const gridAsset = manifest.asset_table[manifest.assets.grid];
      fetchAssetWithVerification(gridAsset)
        .then(buf => {
          const text = new TextDecoder().decode(buf);
          const gridData = JSON.parse(text) as NavGrid;
          gridProvider = new GridCollisionProvider(gridData);
          planner = new NavPlanner(gridData);
          loadedGrid = gridData;
          minimap?.setGrid(gridData);
          if (targetPoi) {
            planRoute(targetPoi, false);
          }
          // Walls and furniture are solid by default once the walkable grid is in; the Mode button switches back to Ghost
          activeMode = 'Grid';
          movementController?.setCollision(gridProvider);
          ui.setMode(activeMode);
          void startRearrange(gridData, gridAsset.sha256);
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
    if (gameFeel) {
      const feel = loadFeelSettings();
      movementController.setGameFeel(true);
      movementController.setFeelSettings(feel);
      const helpCard = document.querySelector<HTMLElement>('#help-overlay .help-card');
      if (helpCard) mountFeelSettings(helpCard, feel, s => movementController?.setFeelSettings(s));
    }
    // Phones and tablets: joystick to move, drag to look, Up / Down (Free roam) or Jump (Walk)
    if (isTouchDevice()) {
      touchControls = new TouchControls({
        lookTarget: canvas,
        getTarget: () => movementController,
        initialMode: moveMode,
      });
    }
    // Dev builds only: lets screenshot scripts place the camera
    if (import.meta.env.DEV) {
      (window as unknown as { __movementController?: FirstPersonMovementController }).__movementController = movementController;
    }

    // 6b. Tag Mode UI & POIs Loading (Round 2)
    let tagUI: TagUI | null = null;
    let placeTag: ((x: number, z: number) => void) | null = null;
    /** Tag mode Adjust: Shift-click on the floor puts the selected tag there (true = click used) */
    let floorClickPlace: ((e: MouseEvent) => boolean) | null = null;
    /** The tag being dragged right now (its floor pin shows while dragging) */
    let draggingPoi: POI | null = null;
    let activePois: POI[] = [];
    let manifestPois: POI[] = [];

    const draftStore = new PoiDraftStore(manifest.scene_id);
    const initialDraft = isTagMode ? draftStore.load() : null;
    const initialDraftBase = isTagMode ? draftStore.loadBase() : undefined;

    if (isTagMode) {
      // Tag mode is for editors only, so its code loads on demand instead of for every visitor
      const { TagUI } = await import('./ui/tag_ui.js');
      // A tag may sit anywhere inside the room footprint, on or next to the floor map (walls,
      // windows and furniture tops are fine), but never out in the void past the walls.
      const TAG_FLOOR_REACH_M = 1.0;
      const isValidTagSpot = (x: number, z: number): boolean => {
        const b = manifest.bounds;
        if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) return false;
        return planner ? planner.nearestFreeCell(x, z, TAG_FLOOR_REACH_M) >= 0 : true;
      };

      tagUI = new TagUI({
        sceneId: manifest.scene_id,
        getPose: () => movementController!.pose,
        isWalkable: (x, z) => (planner ? planner.isWalkable(x, z) : true),
        isInsideRoom: isValidTagSpot,
        onPoisChange: pois => {
          activePois = pois;
          navUI.setPois(activePois);
          routeView.setPois(activePois);
        },
        onAdjustChange: on => {
          minimap?.setPlaceMode(on);
          routeView.setDraggable(on);
        },
        saveConfig: saveConfigFromEnv(import.meta.env),
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
        if (!isValidTagSpot(x, z)) {
          tagUI.showToast('That spot is outside the room');
          return;
        }
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
        draggingPoi = done ? null : poi;
        // Off the map: the dot stays at its last good spot
        if (isValidTagSpot(x, z)) {
          poi.position.x = x;
          poi.position.z = z;
        }
        if (done) dropTag(poi, poi.position.x, poi.position.z);
      });

      // Labels float at poi.position.y (about 1.2 m), so a drag must slide the tag along that
      // height. Projecting onto the floor (y = 0) instead sends the ray far past the label, often
      // outside the room, which made tags fly off towards the horizon and disappear.
      const dragRay = new THREE.Raycaster();
      const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      const pointOnPlane = (clientX: number, clientY: number, y: number): THREE.Vector3 | null => {
        const rect = canvas.getBoundingClientRect();
        const ndc = new THREE.Vector2(
          ((clientX - rect.left) / rect.width) * 2 - 1,
          -((clientY - rect.top) / rect.height) * 2 + 1
        );
        dragRay.setFromCamera(ndc, camera);
        dragPlane.constant = -y;
        return dragRay.ray.intersectPlane(dragPlane, new THREE.Vector3());
      };
      routeView.onPillPointerDown((poi, down) => {
        if (!tagUI?.adjustMode) return false;
        const start = { x: down.clientX, y: down.clientY, px: poi.position.x, pz: poi.position.z };
        const labelY = poi.position.y ?? manifest.eye_height_m;
        // Keep the spot you grabbed under your finger, so the tag doesn't jump on the first move
        const grab = pointOnPlane(down.clientX, down.clientY, labelY);
        const grabOffset = grab ? { x: start.px - grab.x, z: start.pz - grab.z } : { x: 0, z: 0 };
        let moved = false;
        const onMove = (e: PointerEvent) => {
          if (e.pointerId !== down.pointerId) return;
          if (!moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 4) return;
          moved = true;
          draggingPoi = poi;
          document.body.style.cursor = 'grabbing';
          const hit = pointOnPlane(e.clientX, e.clientY, labelY);
          if (!hit) return; // pointing above the label's height: hold the last good spot
          const x = hit.x + grabOffset.x;
          const z = hit.z + grabOffset.z;
          if (isValidTagSpot(x, z)) {
            poi.position.x = x;
            poi.position.z = z;
          }
        };
        const onUp = (e: PointerEvent) => {
          if (e.pointerId !== down.pointerId) return;
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onUp);
          document.body.style.cursor = '';
          draggingPoi = null;
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
            tagUI?.showToast('Drag inside the room to move a tag');
            return;
          }
          dropTag(poi, poi.position.x, poi.position.z);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
        return true;
      });

      // Adjust mode: Shift-click the floor to stand the selected tag exactly there (the floor pin shows
      // the spot). With the mouse locked it uses the middle of the screen, so you can aim at a tape cross.
      // Dragging a label slides it at label height, which can't be lined up with a mark on the floor.
      const FLOOR_PICK_MAX_M = 15;
      floorClickPlace = (e: MouseEvent): boolean => {
        if (!tagUI?.adjustMode || !e.shiftKey || tagUI.isFormOpen) return false;
        const locked = document.pointerLockElement === canvas;
        const rect = canvas.getBoundingClientRect();
        const cx = locked ? rect.left + rect.width / 2 : e.clientX;
        const cy = locked ? rect.top + rect.height / 2 : e.clientY;
        const hit = pointOnPlane(cx, cy, 0);
        const cam = camera.position;
        if (!hit || hit.distanceTo(cam) > FLOOR_PICK_MAX_M) {
          tagUI.showToast('Point at the floor to place the tag');
          return true;
        }
        placeTag?.(hit.x, hit.z);
        return true;
      };
    }

    /** updatedAt: the live pois.json's updated_at (null when the scene has none yet) */
    // Shared links: ?to=<place> opens the route to it (from ?from=<place>, or from where you start)
    let deepLinkDone = false;
    const openDeepLink = () => {
      if (deepLinkDone) return;
      deepLinkDone = true;
      const to = resolvePoiRef(activePois, searchParams.get('to'));
      if (!to) {
        if (searchParams.get('to')) console.warn('[Viewer] Link place not found:', searchParams.get('to'));
        return;
      }
      routeFrom = resolvePoiRef(activePois, searchParams.get('from'));
      navUI.showPoiCard(to, getDistanceToPoi(to));
      planRoute(to, true);
      lookAtPoi(to);
    };

    const applyPois = (poiList: POI[], updatedAt: string | null) => {
      manifestPois = poiList;
      if (tagUI) {
        if (initialDraft !== null) void tagUI.reconcileDraft(manifestPois, updatedAt, initialDraftBase);
        else tagUI.setManifestPois(manifestPois, updatedAt);
      }
      if (!isTagMode || initialDraft === null) {
        // AR floor marks ("Mark 1A"...) are for the AR page only; tag mode still shows them to edit
        activePois = isTagMode ? poiList : visiblePlaces(poiList);
        navUI.setPois(activePois);
        routeView.setPois(activePois);
        if (tagUI) {
          tagUI.setPois(activePois);
        }
      }
      rearrange?.refreshPois();
      openDeepLink();
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
          const { pois: poiList, updated_at } = data as { pois: POI[]; updated_at: string };
          console.info('[Viewer] Loaded POIs from manifest:', poiList.length);
          applyPois(poiList, updated_at);
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
          const { pois: poiList, updated_at } = data as { pois: POI[]; updated_at: string };
          console.info('[Viewer] Loaded POIs from manifest:', poiList.length);
          applyPois(poiList, updated_at);
        } else {
          // No places yet: tag mode still learns that the live site has none (for Save's check)
          applyPois([], null);
        }
      } catch (err) {
        console.warn('[Viewer] Optional POIs could not be loaded:', err);
      }
    };
    void loadPois();

    // 6c. Multiplayer: only on the multiplayer build (VITE_MP_URL), behind the Round 2 "Play with
    // friends" button, or with ?room= / ?mpdemo=1. Loaded as a separate chunk, so the solo viewer
    // never downloads or runs it until someone asks for it.
    let multiplayer: { update: (dt: number) => void; open?: () => void } | null = null;
    let mpStarting = false;
    const launchMultiplayer = (embedded: boolean) => {
      if (mpStarting) return;
      mpStarting = true;
      import('./net/multiplayer.js')
        .then(mp => {
          const { STANCE_SLIDE, STANCE_CROUCH, FLAG_AIR, FLAG_CLIMB } = mp;
          if (!embedded) rearrange?.setPaused(true);
          multiplayer = mp.startMultiplayer(
            {
              scene: renderer.scene,
              camera,
              manifest,
              sceneKey: sceneParam,
              getPose: () => movementController!.pose,
              getBody: () => {
                const mc = movementController!;
                const stance = mc.sliding ? STANCE_SLIDE : mc.crouching ? STANCE_CROUCH : 0;
                return { e: mc.eyeAboveFeet, f: stance | (mc.airborne ? FLAG_AIR : 0) | (mc.climbing ? FLAG_CLIMB : 0) };
              },
              setPose: p => movementController?.setPose(p),
              getPlanner: () => planner,
              getGrid: () => loadedGrid,
              getPois: () => activePois,
              routeTo: poi => planRoute(poi, false),
              getRouteTargetId: () => targetPoi?.poi_id ?? null,
            },
            undefined,
            embedded ? { embedded: true, onActiveChange: active => { ui.setFriendsButtonVisible(!active); rearrange?.setPaused(active); } } : {}
          );
          if (!multiplayer && embedded) {
            mpStarting = false;
            ui.setFriendsButtonVisible(true);
          }
        })
        .catch(err => {
          mpStarting = false;
          ui.setFriendsButtonVisible(true);
          console.warn('[Viewer] Multiplayer could not start:', err);
        });
    };

    if (mpButtonMode) {
      // Round 2 page: the warning comes first, then the lobby. Invite links (?room=) ask the same way.
      let asking = false;
      const askAndOpen = async (joinCode: string | null) => {
        if (asking) return;
        asking = true;
        const { confirmMultiplayerSwitch } = await import('./ui/mp_switch.js');
        const ok = await confirmMultiplayerSwitch({ joinCode });
        asking = false;
        if (!ok) {
          if (joinCode) {
            // Declined an invite: stay on the solo page without the room in the address bar
            const u = new URL(window.location.href);
            u.searchParams.delete('room');
            window.history.replaceState(null, '', u.toString());
          }
          return;
        }
        ui.setFriendsButtonVisible(false);
        if (multiplayer?.open) multiplayer.open();
        else launchMultiplayer(true);
      };
      onFriendsClick = () => void askAndOpen(null);
      const invite = searchParams.get('room');
      if (invite) void askAndOpen(invite);
    } else if (
      mpButtonFlag === undefined &&
      !isTagMode &&
      (Boolean(import.meta.env.VITE_MP_URL) || searchParams.has('room') || searchParams.get('mpdemo') === '1' || searchParams.get('mp') === '1')
    ) {
      launchMultiplayer(false);
    }

    // Pointer Lock click-to-lock
    canvas.addEventListener('click', (e: MouseEvent) => {
      if (floorClickPlace?.(e)) return;
      if (tagUI?.isFormOpen || rearrangeOpen()) return;
      // Touch screens look by dragging (iOS has no pointer lock)
      if (touchControls || typeof canvas.requestPointerLock !== 'function') return;
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
      // Laptops and desktops load the full scene directly. Phones and tablets stay on lite (about
      // 30% of the splats, merged so detail survives): the full scene is too slow there, and
      // swapping it back out froze iPhones, so they get no HD switch. ?quality=full or
      // ?quality=lite overrides on any device.
      const quality = searchParams.get('quality');
      const hasLite = Boolean(manifest.assets.lite && manifest.asset_table[manifest.assets.lite]);
      const isTouch = isTouchDevice();
      const liteFirst = hasLite && quality !== 'full' && (isTouch || quality === 'lite');
      // Touch devices: lite only (no HD chip, no automatic upgrade) unless ?quality=full
      const liteOnly = liteFirst && isTouch && quality !== 'full';
      const upgradeToFull = liteFirst && quality !== 'lite' && !liteOnly;

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
      // Render resolution per scene. Lite is light enough to draw at full sharpness (2x). On phones
      // the full scene's ~2M splats at 2x are too slow, so HD draws at 1.25x with slightly tighter
      // splat edges: every splat stays, so the detail stays, at a much smoother frame rate.
      const liteRatio = Math.min(window.devicePixelRatio || 1, 2);
      const fullRatio = isTouch ? Math.min(liteRatio, 1.25) : liteRatio;
      const useFullScene = () => {
        renderer.setPixelRatio(fullRatio);
        renderer.setFastSplats(isTouch);
      };
      const useLiteScene = () => {
        renderer.setPixelRatio(liteRatio);
        renderer.setFastSplats(false);
      };
      if (onFull) useFullScene();
      let upgradeState: 'waiting' | 'loading' | 'done' = upgradeToFull ? 'waiting' : 'done';
      let slowSamples = 0;
      let fastSamples = 0;
      const showQuality = () => {
        if (!hasLite || liteOnly) return; // one asset only, or a phone on lite: nothing to switch
        ui.setQuality(upgradeState === 'loading' ? 'loading' : onFull ? 'hd' : 'lite');
      };
      // Fetches the full scene and swaps it in. forced = the viewer tapped HD (no fallback to lite
      // from the FPS check after that, so their choice sticks)
      let userChoseQuality = false;
      const loadFull = () => {
        if (upgradeState === 'loading' || onFull) return;
        upgradeState = 'loading';
        showQuality();
        const fullAsset = manifest.asset_table[manifest.assets.full];
        fetchAssetWithVerification(fullAsset)
          .then(buffer => (upgradeState === 'loading' ? renderer.load({ ...fullAsset, buffer }, () => {}) : undefined))
          .then(() => {
            if (upgradeState === 'loading') {
              onFull = true;
              upgradeState = 'done';
              useFullScene();
              console.info('[Viewer] Full-quality scene loaded');
            }
            showQuality();
          })
          .catch(err => {
            upgradeState = 'done';
            showQuality();
            console.warn('[Viewer] Staying on the lite scene; full scene failed to load:', err);
          });
      };
      // tapped = the viewer chose Lite (back to full sharpness); otherwise the FPS check sent us here
      // and the lowered resolution stays
      const loadLite = (tapped = false) => {
        if (!onFull || !hasLite) return;
        onFull = false;
        upgradeState = 'done';
        void renderer.load(liteRef, () => {}).then(() => {
          if (tapped) useLiteScene();
          else renderer.setFastSplats(false);
        });
        showQuality();
      };
      onQualityToggle = () => {
        userChoseQuality = true;
        if (onFull) loadLite(true);
        else loadFull();
      };
      showQuality();
      adaptQuality = (fps: number) => {
        slowSamples = fps < 20 ? slowSamples + 1 : 0;
        fastSamples = fps >= 30 ? fastSamples + 1 : 0;
        if (slowSamples >= 6) {
          slowSamples = 0;
          const floor = onFull && hasLite ? 0.75 : 0.5;
          if (renderer.pixelRatio > floor) {
            renderer.setPixelRatio(renderer.pixelRatio > 1 ? 1 : Math.max(floor, renderer.pixelRatio * 0.75));
            console.info(`[Viewer] Slow device: render scale ${renderer.pixelRatio.toFixed(2)}`);
          } else if (onFull && hasLite && !userChoseQuality) {
            loadLite();
            console.info('[Viewer] Slow device: back to the lite scene');
          }
        } else if (fastSamples >= 4 && upgradeState === 'waiting' && !userChoseQuality) {
          loadFull();
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
        // Walk game feel adds a little pitch (sprint dip, climb) and roll (lean, landing shake)
        camera.rotation.set(pose.pitch + (off.pitch ?? 0), pose.yaw, off.roll ?? 0, 'YXZ');
        if (camera.fov !== off.fov) {
          camera.fov = off.fov;
          camera.updateProjectionMatrix();
        }

        // Route progress & arrival check
        if (targetPoi && !routeFrom) {
          if (currentPathPoints && currentPathPoints.length > 0) {
            const goal = currentPathPoints[currentPathPoints.length - 1];
            const distToGoal = Math.hypot(pose.x - goal.x, pose.z - goal.z);
            if (distToGoal < 0.6) {
              const arrivedName = targetPoi.name;
              const arrivedId = targetPoi.poi_id;
              celebrateArrival(goal);
              guideArrived();
              endRoute();
              navUI.showArrived(arrivedName, arrivedId);
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

      // Voice guide: one step per frame while it is guiding (the route block above may have just ended it)
      if (movementController && voice && voiceMod && guidedId !== null && currentPathPoints) {
        const pose = movementController.pose;
        if (currentTime - moveSample.t >= 250) {
          const sec = (currentTime - moveSample.t) / 1000;
          walkerMoving = sec < 1 && Math.hypot(pose.x - moveSample.x, pose.z - moveSample.z) / sec > 0.3;
          moveSample = { x: pose.x, z: pose.z, t: currentTime };
        }
        const input = voiceMod.viewerInput(currentPathPoints, { x: pose.x, z: pose.z }, pose.yaw, walkerMoving, reroutePending);
        reroutePending = false;
        voice.update(currentTime, input);
        navUI.setGuideLine(voice.line(input, currentTime).instruction);
      }

      multiplayer?.update(dt);
      rearrange?.update();

      // Update route ribbon animation and POI label overlays (Adjust mode: floor pin under the tag)
      if (tagUI) routeView.setFloorPin(tagUI.adjustMode ? (draggingPoi ?? tagUI.selectedPoi) : null);
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
    // Sized from the canvas box itself. Right after a phone rotation iOS can still report the old
    // window size, so measure again once the rotation has settled (and snap any page zoom back).
    let lastW = 0;
    let lastH = 0;
    const fitToScreen = () => {
      const w = canvas.clientWidth || window.innerWidth;
      const h = canvas.clientHeight || window.innerHeight;
      if (w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.resize(w, h);
    };
    const fitAfterRotation = () => {
      fitToScreen();
      for (const ms of [150, 400, 800]) {
        setTimeout(() => {
          if (isTouchDevice()) resetPageZoom();
          fitToScreen();
        }, ms);
      }
    };
    window.addEventListener('resize', fitAfterRotation);
    window.addEventListener('orientationchange', fitAfterRotation);
    window.visualViewport?.addEventListener('resize', fitToScreen);
    fitToScreen();
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
