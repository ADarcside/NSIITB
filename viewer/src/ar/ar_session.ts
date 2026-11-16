/**
 * Namma Space AR: the WebXR camera session (AR build spec, "Browser AR calls").
 *
 * Follows the three.js "ar / hit test" example and the WebXR pages on MDN:
 *   - support: navigator.xr.isSessionSupported('immersive-ar')
 *   - session: requestSession('immersive-ar') with hit-test and dom-overlay required, anchors optional;
 *     the HUD element is the overlay root, so the normal page buttons stay usable in AR
 *   - drawing: renderer.xr with the 'local' reference space and renderer.setAnimationLoop
 *   - floor: a hit test source from the 'viewer' space gives the surface at the screen centre
 *
 * Only the oldest, most widely shipped WebXR calls are used. Nothing here allocates per frame.
 */

import type { ArScene } from './ar_scene.js';
import { classifySupport, type SupportResult } from './ar_state.js';
import { isFloorFacing, upDot } from './floor.js';
import type { Vec3 } from './align.js';

/** What the session reports each camera frame */
export interface ArFrameInfo {
  /** Time stamp from the frame loop (ms) */
  time: number;
  /** True while the phone knows where it is (a viewer pose exists) */
  tracking: boolean;
  /** Pose of the floor point at the screen centre (column-major 4x4), or null when there is none */
  floorMatrix: Float32Array | null;
  /** Height of the phone above that floor point (m), or null */
  heightAboveFloorM: number | null;
  /** Pose of the nearest surface of any kind at the screen centre, or null (aiming feedback) */
  anyMatrix: Float32Array | null;
  /** Debug: hit test results this frame, and the tilt of the nearest one from facing up (degrees) */
  hitCount: number;
  firstTiltDeg: number | null;
  /** The floor point at the screen centre (AR space, m), or null; same point as floorMatrix */
  floorPoint: Vec3 | null;
  /** Phone position in AR space (m), or null while tracking is lost */
  camera: Vec3 | null;
  /** Direction the phone's camera looks, in AR space (unit), or null while tracking is lost */
  cameraForward: Vec3 | null;
}

/** A WebXR anchor whose position is refreshed every camera frame */
export interface TrackedAnchor {
  /** Latest position in AR space (m) */
  readonly pos: Vec3;
  /** False in frames where the phone cannot place the anchor */
  readonly valid: boolean;
}

interface AnchorSlot {
  anchor: XRAnchor;
  pos: Vec3;
  valid: boolean;
}

export interface ArSessionHandlers {
  onFrame(info: ArFrameInfo): void;
  onEnd(): void;
  /** A tap on the camera view (not on an overlay button) */
  onSelect(): void;
}

export async function checkArSupport(): Promise<SupportResult> {
  const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
  let arSupported = false;
  if (xr) {
    try {
      arSupported = await xr.isSessionSupported('immersive-ar');
    } catch {
      // Blocked by a permissions policy or a browser bug: treat as not supported
      arSupported = false;
    }
  }
  return classifySupport({ secure: window.isSecureContext, hasXr: Boolean(xr), arSupported });
}

export class ArSession {
  private session: XRSession | null = null;
  private hitSource: XRHitTestSource | null = null;
  private refSpace: XRReferenceSpace | null = null;
  private readonly info: ArFrameInfo = {
    time: 0,
    tracking: false,
    floorMatrix: null,
    heightAboveFloorM: null,
    anyMatrix: null,
    hitCount: 0,
    firstTiltDeg: null,
    floorPoint: null,
    camera: null,
    cameraForward: null,
  };
  private readonly floorMatrix = new Float32Array(16);
  private readonly anyMatrix = new Float32Array(16);
  private readonly floorPoint: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly cameraPos: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly cameraFwd: Vec3 = { x: 0, y: 0, z: -1 };
  /** Anchor requests waiting for the next frame with a floor hit (hit results only work in their frame) */
  private anchorWaiters: Array<{ at: Vec3 | null; resolve: (a: XRAnchor | null) => void }> = [];
  private anchors: AnchorSlot[] = [];

  constructor(
    private readonly view: ArScene,
    private readonly handlers: ArSessionHandlers
  ) {}

  get running(): boolean {
    return this.session !== null;
  }

  /** True when the phone granted WebXR anchors (used from phase 2 to keep the alignment locked) */
  get hasAnchors(): boolean {
    return Boolean(this.session?.enabledFeatures?.includes('anchors'));
  }

  /**
   * How many times the phone has reset its AR space this session (ARCore lost the room and started
   * a new map). Points saved before a reset no longer match the room; anchors do follow it.
   */
  get resets(): number {
    return this.resetCount;
  }

  private resetCount = 0;
  private readonly handleReset = (): void => {
    this.resetCount++;
  };

  /**
   * Opens the camera view. Must be called straight from a tap (the browser needs the user's
   * gesture), before any other await. Throws the browser's error when the session cannot start.
   */
  async start(overlayRoot: HTMLElement): Promise<void> {
    if (this.session) return;
    const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
    if (!xr) throw new Error('WebXR is not available');
    const session = await xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test', 'dom-overlay'],
      optionalFeatures: ['anchors'],
      domOverlay: { root: overlayRoot },
    });
    this.session = session;
    session.addEventListener('end', this.handleEnd);
    session.addEventListener('select', this.handleSelect);
    try {
      const renderer = this.view.renderer;
      renderer.xr.setReferenceSpaceType('local');
      // Set the loop before the session: three.js stops its page-rate loop on 'sessionstart', but
      // setAnimationLoop() after it would start a second loop that runs without an XR frame
      renderer.setAnimationLoop(this.frame);
      await renderer.xr.setSession(session);
      this.refSpace = renderer.xr.getReferenceSpace();
      this.refSpace?.addEventListener?.('reset', this.handleReset);
      const viewerSpace = await session.requestReferenceSpace('viewer');
      this.hitSource = (await session.requestHitTestSource?.({ space: viewerSpace })) ?? null;
      if (!this.hitSource) throw new Error('This phone did not give a floor hit test');
    } catch (err) {
      // Half-started: close it so the page goes back to Ready cleanly
      void session.end().catch(() => undefined);
      throw err;
    }
  }

  /** Closes the camera view; resolves once the browser has ended the session. */
  async end(): Promise<void> {
    const s = this.session;
    if (!s) return;
    try {
      await s.end();
    } catch {
      // Already ending
    }
  }

  /**
   * Creates a WebXR anchor at the floor point under the ring in the next camera frame. Resolves
   * null when the phone has no anchors feature, no floor is under the ring, or creation fails;
   * alignment then stays fixed from the taps.
   */
  anchorAtRing(): Promise<TrackedAnchor | null> {
    return this.requestAnchor(null);
  }

  /**
   * Creates a WebXR anchor at an exact AR-space point in the next camera frame (the averaged tap
   * point, so no offset is needed). Resolves null when the phone cannot make free anchors.
   */
  anchorAt(p: Vec3): Promise<TrackedAnchor | null> {
    return this.requestAnchor({ x: p.x, y: p.y, z: p.z });
  }

  private requestAnchor(at: Vec3 | null): Promise<TrackedAnchor | null> {
    if (!this.hasAnchors) return Promise.resolve(null);
    return new Promise<XRAnchor | null>(resolve => this.anchorWaiters.push({ at, resolve })).then(anchor => {
      if (!anchor || !this.session) {
        anchor?.delete();
        return null;
      }
      const slot: AnchorSlot = { anchor, pos: { x: 0, y: 0, z: 0 }, valid: false };
      this.anchors.push(slot);
      return slot;
    });
  }

  /** Forgets every anchor (Redo, Re-align, session end). */
  clearAnchors(): void {
    for (const a of this.anchors) {
      try {
        a.anchor.delete();
      } catch {
        // Already gone with the session
      }
    }
    this.anchors = [];
  }

  private readonly frame = (time: number, frame?: XRFrame): void => {
    // Only camera frames count; a page-rate call (no XRFrame) would report "no tracking"
    if (!frame) return;
    const info = this.info;
    info.time = time;
    info.floorMatrix = null;
    info.heightAboveFloorM = null;
    info.tracking = false;
    info.anyMatrix = null;
    info.hitCount = 0;
    info.firstTiltDeg = null;
    info.floorPoint = null;
    info.camera = null;
    info.cameraForward = null;
    let floorHit: XRHitTestResult | null = null;
    if (this.refSpace) {
      const viewerPose = frame.getViewerPose(this.refSpace);
      // A pose with an emulated position means the phone only knows which way it is turned, not
      // where it is: for placing things in the room that is the same as no tracking
      info.tracking = Boolean(viewerPose) && !viewerPose!.emulatedPosition;
      if (viewerPose) {
        const c = viewerPose.transform.position;
        this.cameraPos.x = c.x;
        this.cameraPos.y = c.y;
        this.cameraPos.z = c.z;
        info.camera = this.cameraPos;
        // The camera looks down its own -Z axis (third column of the pose matrix, negated)
        const m = viewerPose.transform.matrix;
        this.cameraFwd.x = -m[8];
        this.cameraFwd.y = -m[9];
        this.cameraFwd.z = -m[10];
        info.cameraForward = this.cameraFwd;
      }
      const hits = this.hitSource ? frame.getHitTestResults(this.hitSource) : [];
      info.hitCount = hits.length;
      for (const hit of hits) {
        const pose = hit.getPose(this.refSpace);
        if (!pose) continue;
        const o = pose.transform.orientation;
        if (!info.anyMatrix) {
          this.anyMatrix.set(pose.transform.matrix);
          info.anyMatrix = this.anyMatrix;
          info.firstTiltDeg = (Math.acos(Math.max(-1, Math.min(1, upDot(o.x, o.y, o.z, o.w)))) * 180) / Math.PI;
        }
        // Only surfaces facing up count (floor, not walls); the first such hit is the nearest
        if (!isFloorFacing(o.x, o.y, o.z, o.w)) continue;
        this.floorMatrix.set(pose.transform.matrix);
        info.floorMatrix = this.floorMatrix;
        const fp = pose.transform.position;
        this.floorPoint.x = fp.x;
        this.floorPoint.y = fp.y;
        this.floorPoint.z = fp.z;
        info.floorPoint = this.floorPoint;
        floorHit = hit;
        if (viewerPose) info.heightAboveFloorM = viewerPose.transform.position.y - pose.transform.position.y;
        break;
      }
      for (const a of this.anchors) {
        const pose = frame.getPose(a.anchor.anchorSpace, this.refSpace);
        a.valid = Boolean(pose);
        if (pose) {
          a.pos.x = pose.transform.position.x;
          a.pos.y = pose.transform.position.y;
          a.pos.z = pose.transform.position.z;
        }
      }
    }
    if (this.anchorWaiters.length > 0) {
      const waiters = this.anchorWaiters;
      this.anchorWaiters = [];
      const refSpace = this.refSpace;
      for (const w of waiters) {
        let pending: Promise<XRAnchor> | undefined;
        try {
          if (w.at && refSpace && frame.createAnchor && typeof XRRigidTransform !== 'undefined')
            pending = frame.createAnchor(new XRRigidTransform({ x: w.at.x, y: w.at.y, z: w.at.z }), refSpace);
          else if (!w.at && floorHit?.createAnchor) pending = floorHit.createAnchor();
        } catch {
          pending = undefined;
        }
        if (!pending) w.resolve(null);
        else pending.then(w.resolve, () => w.resolve(null));
      }
    }
    this.handlers.onFrame(info);
    this.view.render();
  };

  private readonly handleEnd = (): void => {
    const s = this.session;
    s?.removeEventListener('end', this.handleEnd);
    s?.removeEventListener('select', this.handleSelect);
    this.refSpace?.removeEventListener?.('reset', this.handleReset);
    this.view.renderer.setAnimationLoop(null);
    for (const w of this.anchorWaiters) w.resolve(null);
    this.anchorWaiters = [];
    this.anchors = [];
    try {
      this.hitSource?.cancel();
    } catch {
      // The source ends with the session anyway
    }
    this.hitSource = null;
    this.refSpace = null;
    this.session = null;
    this.handlers.onEnd();
  };

  private readonly handleSelect = (): void => {
    this.handlers.onSelect();
  };
}
