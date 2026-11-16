/**
 * Namma Space AR: the three.js side of the camera view. The background stays transparent, so the
 * real room from the camera shows behind everything.
 *
 * - The floor ring (aiming) and the tap dots live in AR space.
 * - Everything placed from the scan (mark crosses, preview pins, the destination pin, the turn
 *   arrows) lives in `sceneRoot`, written in plain scene coordinates. Alignment only sets
 *   sceneRoot's turn and shift (spec, "Apply").
 */

import * as THREE from 'three';
import { THEME } from '../ui/tokens.js';
import type { Alignment, FloorPoint, Vec3 } from './align.js';

/** Height of a preview pin's ball above the floor (m) */
const PIN_TOP_M = 1.1;
/** Destination pin: height above the floor (m), and the distance at which it is drawn at size 1 */
const DEST_HEIGHT_M = 1.6;
const DEST_REF_DIST_M = 2.5;
/** Turn arrows lie flat on the floor, just above it so they do not flicker into it (m) */
const ARROW_HEIGHT_M = 0.02;
/** Spacing between the three chevrons (m), and their size on the floor (1 = 34 cm wide); the set is
 * about 1.2 m long, ARROW_SPAN_M in nav/route_follower.ts */
const ARROW_GAP_M = 0.4;
const ARROW_SCALE = 1.2;

export interface PinSpec {
  name: string;
  x: number;
  z: number;
}

export class ArScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /** Scene-coordinate content; hidden until aligned */
  readonly sceneRoot = new THREE.Group();
  private readonly ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private readonly dot: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  private readonly tmp = new THREE.Vector3();
  private readonly searchColor = new THREE.Color(THEME.white);
  private readonly foundColor = new THREE.Color(THEME.gold);
  private readonly tapGroup = new THREE.Group();
  private readonly marksGroup = new THREE.Group();
  private readonly pinsGroup = new THREE.Group();
  private readonly gold = new THREE.MeshBasicMaterial({ color: THEME.gold });
  private readonly white = new THREE.MeshBasicMaterial({ color: THEME.white });
  private readonly tapGeo = new THREE.CircleGeometry(0.03, 20).rotateX(-Math.PI / 2);
  private readonly poleGeo = new THREE.CylinderGeometry(0.008, 0.008, PIN_TOP_M, 8).translate(0, PIN_TOP_M / 2, 0);
  private readonly ballGeo = new THREE.SphereGeometry(0.045, 16, 12);
  private readonly barGeo = new THREE.BoxGeometry(0.34, 0.006, 0.03);
  /** Destination pin (scene coordinates); hidden until a destination is set */
  private readonly dest = new THREE.Group();
  private readonly destBall = new THREE.Mesh(new THREE.SphereGeometry(0.12, 24, 16), new THREE.MeshBasicMaterial({ color: THEME.gold }));
  private destLabel: THREE.Sprite | null = null;
  private destText = '';
  /** Three chevrons at the next corner, pointing along the next leg */
  private readonly arrows = new THREE.Group();
  private readonly chevronGeo = new THREE.BoxGeometry(0.05, 0.012, 0.26);
  private readonly chevronMats = [0, 1, 2].map(() => new THREE.MeshBasicMaterial({ color: THEME.gold, transparent: true, opacity: 1 }));
  /** Flat ring on the floor where the route ends, next to the place */
  private readonly goalSpot = new THREE.Mesh(
    new THREE.RingGeometry(0.22, 0.3, 40).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: THEME.gold, transparent: true, opacity: 0.9 })
  );

  constructor() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.xr.enabled = true;
    // Kept in the page like the three.js AR example; it is transparent and sits under the overlay
    Object.assign(this.renderer.domElement.style, { position: 'fixed', inset: '0', zIndex: '0' });
    document.body.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 60);

    // Flat ring lying on the floor; its pose comes straight from the hit test each frame
    const geometry = new THREE.RingGeometry(0.11, 0.15, 48).rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({ color: this.searchColor, transparent: true, opacity: 0.9 });
    this.ring = new THREE.Mesh(geometry, material);
    this.ring.matrixAutoUpdate = false;
    this.ring.visible = false;
    // Centre dot, so aiming at the middle of a tape cross is easy
    this.dot = new THREE.Mesh(new THREE.CircleGeometry(0.012, 16).rotateX(-Math.PI / 2), material);
    this.ring.add(this.dot);
    this.scene.add(this.ring, this.tapGroup, this.sceneRoot);
    this.sceneRoot.add(this.marksGroup, this.pinsGroup, this.dest, this.arrows, this.goalSpot);
    this.goalSpot.visible = false;
    this.sceneRoot.visible = false;

    this.dest.add(this.destBall);
    this.dest.visible = false;
    // Each chevron is a flat "V" whose point is local -Z, lying on the floor
    for (let k = 0; k < 3; k++) {
      const chev = new THREE.Group();
      for (const side of [1, -1]) {
        const bar = new THREE.Mesh(this.chevronGeo, this.chevronMats[k]);
        bar.rotation.y = side * (Math.PI / 4);
        bar.position.set(side * 0.085, 0, 0.085);
        chev.add(bar);
      }
      chev.position.z = -k * ARROW_GAP_M;
      this.arrows.add(chev);
    }
    this.arrows.scale.setScalar(ARROW_SCALE);
    this.arrows.visible = false;
  }

  /** Puts the ring at a hit pose (column-major 4x4 from WebXR), or hides it when `matrix` is null. */
  setRing(matrix: Float32Array | null, found: boolean): void {
    if (!matrix) {
      this.ring.visible = false;
      return;
    }
    this.ring.matrix.fromArray(matrix);
    this.ring.visible = true;
    this.ring.material.color.copy(found ? this.foundColor : this.searchColor);
  }

  /** A small white dot where a tap landed (AR space), so the person sees what was recorded. */
  addTapDot(p: Vec3): void {
    const m = new THREE.Mesh(this.tapGeo, this.white);
    m.position.set(p.x, p.y + 0.003, p.z);
    this.tapGroup.add(m);
  }

  clearTapDots(): void {
    this.tapGroup.clear();
  }

  /** Applies an alignment: scene coordinates inside sceneRoot land on the real room. */
  setAlignment(al: Alignment | null): void {
    if (!al) {
      this.sceneRoot.visible = false;
      return;
    }
    this.sceneRoot.rotation.set(0, al.theta, 0);
    this.sceneRoot.position.set(al.t.x, al.t.y, al.t.z);
    this.sceneRoot.visible = true;
  }

  /** Gold crosses on the floor where the scan says the tape crosses are, with their labels. */
  setMarks(a: FloorPoint, b: FloorPoint, labelA: string, labelB: string): void {
    this.clearGroup(this.marksGroup);
    for (const [p, label] of [
      [a, labelA],
      [b, labelB],
    ] as const) {
      const cross = new THREE.Group();
      const bar1 = new THREE.Mesh(this.barGeo, this.gold);
      const bar2 = new THREE.Mesh(this.barGeo, this.gold);
      bar1.rotation.y = Math.PI / 4;
      bar2.rotation.y = -Math.PI / 4;
      cross.add(bar1, bar2);
      cross.position.set(p.x, 0.004, p.z);
      const tag = this.label(label, 0.12);
      tag.position.set(0, 0.2, 0);
      cross.add(tag);
      this.marksGroup.add(cross);
    }
  }

  /** Preview pins standing on places from the tag data, with their names. */
  setPins(pins: PinSpec[]): void {
    this.clearGroup(this.pinsGroup);
    for (const p of pins) {
      const pin = new THREE.Group();
      pin.add(new THREE.Mesh(this.poleGeo, this.gold));
      const ball = new THREE.Mesh(this.ballGeo, this.gold);
      ball.position.y = PIN_TOP_M;
      pin.add(ball);
      const tag = this.label(p.name, 0.15);
      tag.position.y = PIN_TOP_M + 0.14;
      pin.add(tag);
      pin.position.set(p.x, 0, p.z);
      this.pinsGroup.add(pin);
    }
  }

  /** Shows the destination pin at a place (scene floor x, z), or hides it with null. */
  setDestination(p: FloorPoint | null): void {
    if (!p) {
      this.dest.visible = false;
      return;
    }
    this.dest.position.set(p.x, DEST_HEIGHT_M, p.z);
    this.dest.visible = true;
  }

  /**
   * Keeps the destination pin the same size on screen from near and far, and refreshes its label
   * ("Table 3 · 4 m") only when the text changes. `distM` is the straight distance to the phone.
   */
  updateDestination(distM: number, text: string): void {
    if (!this.dest.visible) return;
    const s = Math.min(6, Math.max(0.8, distM / DEST_REF_DIST_M));
    this.dest.scale.setScalar(s);
    if (text !== this.destText) {
      this.destText = text;
      if (this.destLabel) {
        this.dest.remove(this.destLabel);
        this.destLabel.material.map?.dispose();
        this.destLabel.material.dispose();
      }
      this.destLabel = this.label(text, 0.13);
      this.destLabel.position.y = 0.3;
      this.dest.add(this.destLabel);
    }
  }

  /**
   * Puts the three turn chevrons at a floor spot (scene x, z), pointing along (dirX, dirZ), or hides
   * them with null. `time` (ms) drives the ripple that runs along them toward the way to go.
   */
  setArrows(at: { x: number; z: number; dirX: number; dirZ: number } | null, time = 0): void {
    if (!at) {
      this.arrows.visible = false;
      return;
    }
    // rotation.y = h maps local -Z to (-sin h, 0, -cos h): pick h so that is (dirX, dirZ).
    // The first chevron sits on the spot and the others follow along the way to go.
    this.arrows.rotation.set(0, Math.atan2(-at.dirX, -at.dirZ), 0);
    this.arrows.position.set(at.x, ARROW_HEIGHT_M, at.z);
    for (let k = 0; k < 3; k++) {
      this.chevronMats[k].opacity = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(time / 180 - k * 1.3));
    }
    this.arrows.visible = true;
  }

  /** Puts the flat goal ring on the floor at the route's end (scene x, z), or hides it with null. */
  setGoalSpot(p: FloorPoint | null): void {
    if (!p) {
      this.goalSpot.visible = false;
      return;
    }
    this.goalSpot.position.set(p.x, 0.015, p.z);
    this.goalSpot.visible = true;
  }

  /**
   * Where a scene point (plain scene coordinates, inside sceneRoot) lands in the camera view:
   * normalised device coordinates (x right, y up, -1..1 on screen) and whether it is behind the
   * phone. Null before the first camera frame.
   */
  projectScenePoint(x: number, y: number, z: number): { x: number; y: number; behind: boolean } | null {
    const xr = this.renderer.xr.getCamera();
    const cam = xr.cameras.length > 0 ? xr.cameras[0] : xr;
    if (!cam.projectionMatrix.elements.some(v => v !== 0)) return null;
    const v = this.tmp.set(x, y, z);
    this.sceneRoot.localToWorld(v);
    v.applyMatrix4(cam.matrixWorldInverse);
    const behind = v.z > 0;
    v.applyMatrix4(cam.projectionMatrix);
    return { x: v.x, y: v.y, behind };
  }

  /** Hides or shows the preview pins (they stay during guidance, but can clutter) */
  setPinsVisible(on: boolean): void {
    this.pinsGroup.visible = on;
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.clearGroup(this.marksGroup);
    this.clearGroup(this.pinsGroup);
    this.clearTapDots();
    if (this.destLabel) {
      this.destLabel.material.map?.dispose();
      this.destLabel.material.dispose();
    }
    for (const g of [this.ring.geometry, this.dot.geometry, this.tapGeo, this.poleGeo, this.ballGeo, this.barGeo, this.destBall.geometry, this.chevronGeo, this.goalSpot.geometry])
      g.dispose();
    for (const m of [this.ring.material, this.gold, this.white, this.destBall.material, ...this.chevronMats, this.goalSpot.material]) m.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  /** Text label that always faces the phone; `heightM` is its height in the room. */
  private label(text: string, heightM: number): THREE.Sprite {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    const font = '600 44px "Space Grotesk", system-ui, sans-serif';
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(text).width) + 40;
    canvas.width = w;
    canvas.height = 72;
    ctx.font = font;
    ctx.fillStyle = 'rgba(10, 15, 30, 0.82)';
    ctx.beginPath();
    ctx.roundRect(0, 0, w, 72, 16);
    ctx.fill();
    ctx.fillStyle = THEME.white;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 20, 38);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    sprite.scale.set((heightM * w) / 72, heightM, 1);
    sprite.renderOrder = 2;
    return sprite;
  }

  /** Removes a group's children and frees their label textures (shared geometry stays). */
  private clearGroup(g: THREE.Group): void {
    g.traverse(o => {
      if (o instanceof THREE.Sprite) {
        o.material.map?.dispose();
        o.material.dispose();
      }
    });
    g.clear();
  }
}
