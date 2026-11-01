/**
 * Namma Space: Route & POI View (Three.js & DOM overlay) (Round 2)
 * Renders the active walkable navigation path as an animated cyan ribbon with a pulsing goal ring,
 * and projects POI labels as HTML pills over the canvas.
 * Under prefers-reduced-motion the ribbon appears at once and the ring and dashes stay still.
 */

import * as THREE from 'three';
import type { POI } from '../contracts/types.js';
import type { Point2 } from './astar.js';
import { ensureTokens, THEME } from '../ui/tokens.js';

export interface ProjectedLabel {
  x: number;
  y: number;
  visible: boolean;
  distance: number;
}

/**
 * Projects a 3D world position onto 2D screen coordinates.
 * When behind the camera (camera local z >= -0.01 or NDC z > 1), visible is false.
 */
export function projectLabel(
  pos: { x: number; y: number; z: number },
  camera: THREE.Camera,
  width: number,
  height: number,
  maxDistance = 12,
  isHighlight = false
): ProjectedLabel {
  const v = new THREE.Vector3(pos.x, pos.y, pos.z);
  const distance = camera.position.distanceTo(v);

  // Check camera-local space (Three.js camera faces -Z)
  const vCam = v.clone().applyMatrix4(camera.matrixWorldInverse);
  if (vCam.z >= -0.01) {
    return { x: 0, y: 0, visible: false, distance };
  }

  // Project to NDC [-1, 1]
  v.project(camera);
  if (v.z > 1.0) {
    return { x: 0, y: 0, visible: false, distance };
  }

  const x = ((v.x + 1) * 0.5) * width;
  const y = ((-v.y + 1) * 0.5) * height;

  const inFrustum = v.x >= -1.2 && v.x <= 1.2 && v.y >= -1.2 && v.y <= 1.2;
  const inRange = isHighlight || distance <= maxDistance;

  return {
    x,
    y,
    visible: inFrustum && inRange,
    distance,
  };
}

/** Creates a gold gradient texture (theme route colours) with chevron dashes flowing along the length. */
function createPathTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    // Base gold
    ctx.fillStyle = THEME.gold;
    ctx.fillRect(0, 0, 64, 128);

    // Flowing gradient
    const grad = ctx.createLinearGradient(0, 0, 0, 128);
    const [c0, c1, c2, c3] = THEME.routeTexture;
    grad.addColorStop(0.0, c0);
    grad.addColorStop(0.35, c1);
    grad.addColorStop(0.7, c2);
    grad.addColorStop(1.0, c3);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 128);

    // Chevron arrow pointing towards +V
    ctx.fillStyle = THEME.white;
    ctx.beginPath();
    ctx.moveTo(32, 25);
    ctx.lineTo(54, 55);
    ctx.lineTo(44, 55);
    ctx.lineTo(32, 40);
    ctx.lineTo(20, 55);
    ctx.lineTo(10, 55);
    ctx.closePath();
    ctx.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  // Repeat every 0.35 m of path length
  texture.repeat.set(1, 1 / 0.35);
  return texture;
}

export class RouteView {
  private readonly _scene: THREE.Scene;
  private readonly _texture: THREE.CanvasTexture;
  private readonly _ribbonMat: THREE.MeshBasicMaterial;

  private _ribbonMesh: THREE.Mesh | null = null;
  private _ringMesh: THREE.Mesh | null = null;

  private _pois: POI[] = [];
  private _highlightId: string | null = null;
  private readonly _labelContainer: HTMLElement;
  private readonly _labelElements = new Map<string, HTMLElement>();
  private readonly _pickCallbacks: ((poi: POI) => void)[] = [];
  private readonly _pillDownCallbacks: ((poi: POI, e: PointerEvent) => boolean)[] = [];
  private _suppressClick = false;

  private _pulseTime = 0;
  private _fullPoints: Point2[] | null = null;
  private _isGrowing = false;
  private _growElapsed = 0;
  private readonly _growDuration = 0.5;
  private readonly _reduceMotion: MediaQueryList | null;

  constructor(scene: THREE.Scene, container?: HTMLElement) {
    this._scene = scene;
    this._texture = createPathTexture();
    this._reduceMotion =
      typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

    this._ribbonMat = new THREE.MeshBasicMaterial({
      color: THEME.gold,
      map: this._texture,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const parent = container ?? document.body;
    this._labelContainer = document.createElement('div');
    this._labelContainer.id = 'namma-poi-labels';
    this._labelContainer.className = 'namma-poi-labels-container ns-ui';
    parent.appendChild(this._labelContainer);

    ensureTokens();
    this._injectStyles();
  }

  onPick(cb: (poi: POI) => void): void {
    this._pickCallbacks.push(cb);
  }

  /** Tag mode: lets main.ts start a drag when a label is pressed. Return true to take over. */
  onPillPointerDown(cb: (poi: POI, e: PointerEvent) => boolean): void {
    this._pillDownCallbacks.push(cb);
  }

  /** Swallows the click that follows a finished drag so it doesn't open the POI card */
  suppressNextClick(): void {
    this._suppressClick = true;
    setTimeout(() => (this._suppressClick = false), 0);
  }

  /** Grab cursor on labels while tags can be dragged */
  setDraggable(on: boolean): void {
    this._labelContainer.classList.toggle('draggable', on);
  }

  setPois(pois: POI[]): void {
    this._pois = pois;
    this._labelElements.forEach(el => el.remove());
    this._labelElements.clear();

    for (const poi of pois) {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'namma-poi-pill';
      pill.textContent = poi.name;
      pill.title = `${poi.name}: show details`;
      pill.dataset.poiId = poi.poi_id;

      // Click/tap to open POI card (only active when pointer is unlocked)
      pill.addEventListener('pointerdown', (e: PointerEvent) => {
        if (document.pointerLockElement || e.button !== 0) return;
        for (const cb of this._pillDownCallbacks) {
          if (cb(poi, e)) {
            e.preventDefault();
            return;
          }
        }
      });
      pill.addEventListener('click', (e: MouseEvent) => {
        if (document.pointerLockElement) return;
        e.stopPropagation();
        if (this._suppressClick) return;
        for (const cb of this._pickCallbacks) {
          cb(poi);
        }
      });

      this._labelContainer.appendChild(pill);
      this._labelElements.set(poi.poi_id, pill);
    }
  }

  setHighlight(poiId: string | null): void {
    this._highlightId = poiId;
    for (const [id, el] of this._labelElements) {
      if (id === poiId) {
        el.classList.add('highlight');
      } else {
        el.classList.remove('highlight');
      }
    }
  }

  setPath(points: Point2[] | null, animate = true): void {
    this._clearMeshes();

    if (!points || points.length < 2) {
      this._fullPoints = null;
      this._isGrowing = false;
      return;
    }

    this._fullPoints = points;
    if (animate && !this._reduceMotion?.matches) {
      this._isGrowing = true;
      this._growElapsed = 0;
      const initial = this._interpolatePathFraction(points, 0.02);
      this._rebuildRibbonMesh(initial);
    } else {
      this._isGrowing = false;
      this._rebuildRibbonMesh(points);
      this._buildGoalRing(points[points.length - 1]);
    }
  }

  private _clearMeshes(): void {
    if (this._ribbonMesh) {
      this._scene.remove(this._ribbonMesh);
      this._ribbonMesh.geometry.dispose();
      this._ribbonMesh = null;
    }
    if (this._ringMesh) {
      this._scene.remove(this._ringMesh);
      this._ringMesh.geometry.dispose();
      (this._ringMesh.material as THREE.Material).dispose();
      this._ringMesh = null;
    }
  }

  private _rebuildRibbonMesh(points: Point2[]): void {
    if (this._ribbonMesh) {
      this._scene.remove(this._ribbonMesh);
      this._ribbonMesh.geometry.dispose();
      this._ribbonMesh = null;
    }
    if (points.length < 2) return;
    const ribbonGeo = this._buildRibbonGeometry(points, 0.12, 0.03);
    this._ribbonMesh = new THREE.Mesh(ribbonGeo, this._ribbonMat);
    this._ribbonMesh.renderOrder = 10;
    this._scene.add(this._ribbonMesh);
  }

  private _buildGoalRing(goal: Point2): void {
    if (this._ringMesh) {
      this._scene.remove(this._ringMesh);
      this._ringMesh.geometry.dispose();
      (this._ringMesh.material as THREE.Material).dispose();
      this._ringMesh = null;
    }
    const ringGeo = new THREE.RingGeometry(0.27, 0.35, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: THEME.gold,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this._ringMesh = new THREE.Mesh(ringGeo, ringMat);
    this._ringMesh.rotation.x = -Math.PI / 2;
    this._ringMesh.position.set(goal.x, 0.03, goal.z);
    this._ringMesh.renderOrder = 10;
    this._scene.add(this._ringMesh);
  }

  private _interpolatePathFraction(points: Point2[], fraction: number): Point2[] {
    if (points.length < 2) return [...points];
    if (fraction <= 0) {
      return [
        points[0],
        {
          x: points[0].x + 0.001 * (points[1].x - points[0].x),
          z: points[0].z + 0.001 * (points[1].z - points[0].z),
        },
      ];
    }
    if (fraction >= 1) return [...points];

    let totalLen = 0;
    for (let i = 1; i < points.length; i++) {
      totalLen += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
    }
    const targetDist = fraction * totalLen;

    const result: Point2[] = [points[0]];
    let accum = 0;

    for (let i = 1; i < points.length; i++) {
      const p0 = points[i - 1];
      const p1 = points[i];
      const segLen = Math.hypot(p1.x - p0.x, p1.z - p0.z);

      if (accum + segLen >= targetDist) {
        const remain = targetDist - accum;
        const t = segLen > 1e-6 ? remain / segLen : 0;
        result.push({
          x: p0.x + (p1.x - p0.x) * t,
          z: p0.z + (p1.z - p0.z) * t,
        });
        break;
      } else {
        result.push(p1);
        accum += segLen;
      }
    }
    if (result.length < 2 && points.length >= 2) {
      result.push(points[1]);
    }
    return result;
  }

  update(camera: THREE.Camera, dtS: number): void {
    camera.updateMatrixWorld();

    // Growing animation or dash scrolling
    if (this._isGrowing && this._fullPoints) {
      this._growElapsed += dtS;
      const progress = Math.min(1.0, this._growElapsed / this._growDuration);
      const easedProgress = 0.5 * (1 - Math.cos(Math.PI * progress));
      const subPoints = this._interpolatePathFraction(this._fullPoints, Math.max(0.01, easedProgress));
      this._rebuildRibbonMesh(subPoints);

      if (progress >= 1.0) {
        this._isGrowing = false;
        this._buildGoalRing(this._fullPoints[this._fullPoints.length - 1]);
      }
    } else if (this._ribbonMesh && !this._reduceMotion?.matches) {
      // Animate path dashes towards goal
      this._texture.offset.y -= 1.4 * dtS;
    }

    // Pulse goal ring
    if (this._ringMesh && !this._reduceMotion?.matches) {
      this._pulseTime += dtS;
      const pulse = (Math.sin(this._pulseTime * 4.0) + 1) * 0.5;
      const scale = 1.0 + 0.12 * pulse;
      this._ringMesh.scale.set(scale, scale, 1);
      (this._ringMesh.material as THREE.MeshBasicMaterial).opacity = 0.6 + 0.35 * pulse;
    }

    // Project and position POI labels
    const w = window.innerWidth;
    const h = window.innerHeight;

    for (const poi of this._pois) {
      const el = this._labelElements.get(poi.poi_id);
      if (!el) continue;

      const isHighlight = poi.poi_id === this._highlightId;
      const proj = projectLabel(poi.position, camera, w, h, 12, isHighlight);

      if (proj.visible) {
        el.style.display = 'block';
        el.style.transform = `translate(-50%, -50%) translate3d(${Math.round(proj.x)}px, ${Math.round(proj.y)}px, 0)`;
        if (isHighlight) {
          el.classList.add('highlight');
          el.style.opacity = '1';
        } else {
          el.classList.remove('highlight');
          const fade = proj.distance <= 6 ? 1 : Math.max(0, 1 - (proj.distance - 6) / 6);
          el.style.opacity = fade.toFixed(2);
        }
      } else {
        el.style.display = 'none';
      }
    }
  }

  dispose(): void {
    this.setPath(null);
    this._ribbonMat.dispose();
    this._texture.dispose();
    this._labelContainer.remove();
    this._labelElements.clear();
  }

  private _buildRibbonGeometry(points: Point2[], width: number, y: number): THREE.BufferGeometry {
    const hw = width * 0.5;
    const numPoints = points.length;

    // Calculate cumulative distances
    const dists: number[] = [0];
    for (let i = 1; i < numPoints; i++) {
      const d = Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
      dists.push(dists[i - 1] + d);
    }

    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    // Helper to add vertex
    const addVertex = (px: number, py: number, pz: number, u: number, v: number): number => {
      const idx = positions.length / 3;
      positions.push(px, py, pz);
      normals.push(0, 1, 0);
      uvs.push(u, v);
      return idx;
    };

    // 1. Quads for each segment
    for (let i = 0; i < numPoints - 1; i++) {
      const p0 = points[i];
      const p1 = points[i + 1];
      const dx = p1.x - p0.x;
      const dz = p1.z - p0.z;
      const len = Math.hypot(dx, dz);
      if (len < 1e-4) continue;

      const nx = (-dz / len) * hw;
      const nz = (dx / len) * hw;

      const s0 = dists[i];
      const s1 = dists[i + 1];

      const v0 = addVertex(p0.x + nx, y, p0.z + nz, 0, s0);
      const v1 = addVertex(p0.x - nx, y, p0.z - nz, 1, s0);
      const v2 = addVertex(p1.x + nx, y, p1.z + nz, 0, s1);
      const v3 = addVertex(p1.x - nx, y, p1.z - nz, 1, s1);

      indices.push(v0, v1, v2, v2, v1, v3);
    }

    // 2. Round caps and joins at each waypoint
    const segments = 16;
    for (let i = 0; i < numPoints; i++) {
      const p = points[i];
      const s = dists[i];
      const centerIdx = addVertex(p.x, y, p.z, 0.5, s);

      const circleStart = positions.length / 3;
      for (let j = 0; j < segments; j++) {
        const angle = (j / segments) * Math.PI * 2;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        addVertex(p.x + cos * hw, y, p.z + sin * hw, 0.5 + 0.5 * cos, s + (sin * hw) / width);
      }

      for (let j = 0; j < segments; j++) {
        const next = (j + 1) % segments;
        indices.push(centerIdx, circleStart + j, circleStart + next);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    return geo;
  }

  private _injectStyles(): void {
    if (document.getElementById('namma-poi-labels-style')) return;
    const style = document.createElement('style');
    style.id = 'namma-poi-labels-style';
    style.textContent = `
      .namma-poi-labels-container {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        overflow: hidden;
        z-index: 50;
        font-family: var(--ns-font);
      }
      .namma-poi-pill {
        position: absolute;
        top: 0;
        left: 0;
        transform: translate(-50%, -50%);
        margin: 0;
        background: var(--ns-pill-bg);
        border: 1px solid var(--ns-pill-border);
        border-radius: var(--ns-radius-sm);
        padding: 4px 10px;
        font-family: var(--ns-font);
        font-size: var(--ns-fs-xs);
        font-weight: 600;
        line-height: 1.3;
        color: var(--ns-text);
        white-space: nowrap;
        letter-spacing: 0.02em;
        box-shadow: var(--ns-shadow-sm);
        /* transform is written every frame, so it is never transitioned (labels would trail the camera) */
        transition: background-color var(--ns-dur-fast) ease, border-color var(--ns-dur-fast) ease,
          box-shadow var(--ns-dur-fast) ease;
        display: none;
        pointer-events: auto;
        cursor: pointer;
        user-select: none;
      }
      .namma-poi-pill::before {
        content: "";
        position: absolute;
        inset: -6px -4px;
      }
      @media (pointer: coarse) {
        .namma-poi-pill { font-size: var(--ns-fs-sm); padding: 5px 12px; }
        .namma-poi-pill::before { inset: -10px -6px; }
      }
      @media (hover: hover) and (pointer: fine) {
        .namma-poi-pill:hover {
          background: var(--ns-pill-bg-hover);
          border-color: var(--ns-pill-border-hover);
          box-shadow: var(--ns-shadow-sm), 0 0 0 3px var(--ns-accent-soft);
        }
      }
      .namma-poi-labels-container.draggable .namma-poi-pill { cursor: grab; touch-action: none; }
      .namma-poi-labels-container.draggable .namma-poi-pill.dragging { cursor: grabbing; }
      .namma-poi-pill.highlight {
        background: var(--ns-pill-highlight-bg);
        border: 1.5px solid var(--ns-route);
        color: var(--ns-on-accent);
        font-size: var(--ns-fs-sm);
        font-weight: 700;
        box-shadow: var(--ns-shadow-sm), var(--ns-glow-strong);
      }
    `;
    document.head.appendChild(style);
  }
}
