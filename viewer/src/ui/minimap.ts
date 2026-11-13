/**
 * Namma Space: Floor-plan Minimap (Round 2)
 *
 * Draws a dark floor plan worked out from grid.json (nav/floorplan.ts): gold walls with a door gap
 * and a window, furniture as boxes, same-kind boxes at one size. The plan is cached to an offscreen
 * canvas and only redrawn when the size or the tags change, so the per-frame cost stays small.
 * ?map=grid, or a grid that gives no plan, draws the walking grid instead (free light, blocked dark).
 *
 * Displays:
 * - Dynamic walker arrow (showing camera yaw, North is up)
 * - Tagged POIs as dots with their first letter, drawn on their object's box (real spot while adjusting)
 * - Active navigation route as cyan polyline
 * - Shift-click to relocate selected POI in tag mode (?tag=1); in Adjust mode drag a dot to move it
 * - Click POI dot to open its POI info card
 * - Toggled with N key and HUD button
 */

import type { NavGrid, POI } from '../contracts/types.js';
import type { Pose3D } from '../types.js';
import type { Point2 } from '../nav/astar.js';
import { decodeBase64ToBytes } from '../collision/grid.js';
import { buildFloorPlanWithMasks, layoutTags, type FloorPlan, type PlanLayout, type PlanMasks } from '../nav/floorplan.js';
import { ensureTokens, THEME } from './tokens.js';
import { isPhone, isTouchDevice } from './device.js';
import MINIMAP_CSS from './minimap.css?raw';

export interface MinimapMapping {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  extentX: number;
  extentZ: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  drawW: number;
  drawH: number;
}

/**
 * Calculates world-to-pixel linear mapping for a NavGrid with North-up orientation.
 * Ensures aspect ratio is preserved and the grid is centered with padding.
 */
export function calculateMinimapMapping(
  grid: NavGrid,
  canvasWidth: number,
  canvasHeight: number,
  padding = 10
): MinimapMapping {
  const minX = grid.origin[0];
  const minZ = grid.origin[1];
  const maxX = minX + grid.width * grid.cell_m;
  const maxZ = minZ + grid.height * grid.cell_m;
  const extentX = Math.max(1e-4, maxX - minX);
  const extentZ = Math.max(1e-4, maxZ - minZ);

  const availW = Math.max(1, canvasWidth - 2 * padding);
  const availH = Math.max(1, canvasHeight - 2 * padding);
  const scale = Math.min(availW / extentX, availH / extentZ);

  const drawW = extentX * scale;
  const drawH = extentZ * scale;
  const offsetX = padding + (availW - drawW) / 2;
  const offsetY = padding + (availH - drawH) / 2;

  return {
    minX,
    maxX,
    minZ,
    maxZ,
    extentX,
    extentZ,
    scale,
    offsetX,
    offsetY,
    drawW,
    drawH,
  };
}

/**
 * Maps world (x, z) coordinates to canvas pixel (px, py) coordinates.
 * North (-Z) maps to smaller py (top of canvas).
 */
export function worldToPixel(x: number, z: number, m: MinimapMapping): { px: number; py: number } {
  const px = m.offsetX + (x - m.minX) * m.scale;
  const py = m.offsetY + (z - m.minZ) * m.scale;
  return { px, py };
}

/**
 * Maps canvas pixel (px, py) coordinates back to world (x, z) coordinates.
 */
export function pixelToWorld(px: number, py: number, m: MinimapMapping): { x: number; z: number } {
  const x = m.minX + (px - m.offsetX) / m.scale;
  const z = m.minZ + (py - m.offsetY) / m.scale;
  return { x, z };
}

export interface MinimapOptions {
  container?: HTMLElement;
  isTagMode?: boolean;
}

export class MinimapUI {
  private readonly _root: HTMLElement;
  private readonly _canvas: HTMLCanvasElement;
  private readonly _ctx: CanvasRenderingContext2D | null;
  private readonly _isTagMode: boolean;

  private _cachedGridCanvas: HTMLCanvasElement | null = null;
  /** Floor plan from the grid; null draws the walking grid (?map=grid, or no plan found) */
  private _plan: { plan: FloorPlan; masks: PlanMasks } | null = null;
  private readonly _forceGrid: boolean;
  private _layout: PlanLayout | null = null;
  private _layoutKey = '';
  private _planCanvas: HTMLCanvasElement | null = null;
  private _planCanvasKey = '';
  private _grid: NavGrid | null = null;
  private _mapping: MinimapMapping | null = null;
  private _size = 220;
  /** Canvas height; equals _size except on phones, where the map is cropped to the room's shape */
  private _height = 220;
  private _isVisible = true;

  private _lastPois: POI[] = [];
  private readonly _selectPoiCallbacks: ((poi: POI) => void)[] = [];
  private readonly _relocateCallbacks: ((x: number, z: number) => void)[] = [];
  private _placeMode = false;
  private readonly _dragCallbacks: ((poi: POI, x: number, z: number, done: boolean) => void)[] = [];
  private _drag: { poi: POI; id: number; moved: boolean; sx: number; sy: number } | null = null;
  private _suppressClick = false;

  constructor(options: MinimapOptions = {}) {
    this._isTagMode = Boolean(options.isTagMode);
    this._forceGrid = typeof location !== 'undefined' && new URLSearchParams(location.search).get('map') === 'grid';
    const parent = options.container ?? document.body;

    this._root = document.createElement('div');
    this._root.id = 'namma-minimap-container';
    this._root.className = 'namma-minimap-container ns-ui';
    this._root.setAttribute('role', 'region');
    this._root.setAttribute('aria-label', 'Floor plan minimap');

    this._canvas = document.createElement('canvas');
    this._canvas.className = 'namma-minimap-canvas';
    this._ctx = this._canvas.getContext('2d');

    this._root.appendChild(this._canvas);
    ensureTokens();
    this._injectStyles();
    parent.appendChild(this._root);

    this._updateSize();
    this._setupEvents();
    // Phones: start with the map closed so the room isn't crowded; the Map button (N) opens it
    if (isPhone() && !this._isTagMode) this.hide();
  }

  get isVisible(): boolean {
    return this._isVisible;
  }

  show(): void {
    this._isVisible = true;
    this._root.classList.remove('hidden');
  }

  hide(): void {
    this._isVisible = false;
    this._root.classList.add('hidden');
  }

  toggle(): void {
    if (this._isVisible) {
      this.hide();
    } else {
      this.show();
    }
  }

  onSelectPoi(cb: (poi: POI) => void): void {
    this._selectPoiCallbacks.push(cb);
  }

  /** Tag mode Adjust: POI dots can be dragged to a new spot */
  setPlaceMode(on: boolean): void {
    this._placeMode = on;
    this._canvas.style.cursor = on ? 'grab' : '';
    this._canvas.style.touchAction = on ? 'none' : '';
  }

  /** Fires while a dot is dragged (done=false) and once on release (done=true), with world x, z */
  onDragPoi(cb: (poi: POI, x: number, z: number, done: boolean) => void): void {
    this._dragCallbacks.push(cb);
  }

  /** Nearest POI dot within the click radius of a canvas pixel, or null */
  private _poiAt(px: number, py: number): POI | null {
    let closestPoi: POI | null = null;
    // 12 px click radius with a mouse, 20 px with a finger
    let minDist = isTouchDevice() ? 20 : 12;
    const spots = this._dotPixels(this._lastPois);
    for (const poi of this._lastPois) {
      const pt = spots.get(poi.poi_id)!;
      const d = Math.hypot(pt.px - px, pt.py - py);
      if (d < minDist) {
        minDist = d;
        closestPoi = poi;
      }
    }
    return closestPoi;
  }

  onRelocate(cb: (x: number, z: number) => void): void {
    this._relocateCallbacks.push(cb);
  }

  setGrid(grid: NavGrid): void {
    this._grid = grid;
    this._updateMapping();
    this._cacheGridRender(grid);
    this._plan = null;
    this._layout = null;
    this._layoutKey = '';
    this._planCanvasKey = '';
    if (!this._forceGrid) {
      try {
        this._plan = buildFloorPlanWithMasks(grid);
      } catch (err) {
        console.warn('[minimap] floor plan failed, drawing the walking grid', err);
      }
    }
  }

  /**
   * Canvas pixel of each dot. On the plan, dots that would overlap (two tags on one small box) are
   * pushed apart a little; real spots while adjusting are left exactly where they are.
   */
  private _dotPixels(pois: POI[]): Map<string, { px: number; py: number }> {
    const out = new Map<string, { px: number; py: number }>();
    for (const poi of pois) {
      const at = this._dotWorld(poi);
      out.set(poi.poi_id, this.worldToPixel(at.x, at.z));
    }
    if (!this._layout || (this._isTagMode && this._placeMode)) return out;
    const pts = [...out.values()];
    const gap = 15; // two 7 px dots plus a hairline
    for (let iter = 0; iter < 4; iter++) {
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const a = pts[i], b = pts[j];
          let dx = b.px - a.px, dy = b.py - a.py;
          let d = Math.hypot(dx, dy);
          if (d >= gap) continue;
          if (d < 1e-3) { dx = 1; dy = 0; d = 1; }
          const push = (gap - d) / 2;
          a.px -= (dx / d) * push; a.py -= (dy / d) * push;
          b.px += (dx / d) * push; b.py += (dy / d) * push;
        }
      }
    }
    return out;
  }

  /** Where a POI's dot is drawn: on its box, or its real spot while tags are being adjusted */
  private _dotWorld(poi: POI): { x: number; z: number } {
    if (this._isTagMode && this._placeMode) return { x: poi.position.x, z: poi.position.z };
    return this._layout?.dots.get(poi.poi_id) ?? { x: poi.position.x, z: poi.position.z };
  }

  /** Recomputes the tag layout when the tags change (added, moved, renamed) */
  private _updateLayout(pois: POI[]): void {
    if (!this._plan || !this._grid) return;
    const key = pois
      .map((p) => `${p.poi_id}|${p.name}|${p.category ?? ''}|${(p.aliases ?? []).join(',')}|${p.position.x.toFixed(3)}|${p.position.z.toFixed(3)}`)
      .join(';');
    if (key === this._layoutKey && this._layout) return;
    this._layoutKey = key;
    try {
      this._layout = layoutTags(this._grid, this._plan.plan, this._plan.masks, pois);
    } catch (err) {
      console.warn('[minimap] tag layout failed', err);
      this._layout = null;
    }
  }

  /** Draws floor, boxes and walls (with door and window) to the cached plan canvas */
  private _renderPlanCanvas(cssW: number, cssH: number, dpr: number): HTMLCanvasElement | null {
    if (!this._plan || !this._mapping || typeof document === 'undefined') return null;
    const key = `${cssW}x${cssH}@${dpr}|${this._layoutKey}`;
    if (this._planCanvas && key === this._planCanvasKey) return this._planCanvas;
    const canvas = this._planCanvas ?? document.createElement('canvas');
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const m = this._mapping;
    const P = (x: number, z: number) => worldToPixel(x, z, m);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const { plan } = this._plan;
    const boxes = this._layout?.boxes ?? plan.boxes;
    const openings = this._layout?.openings ?? [];

    // Floor (rings after the first are solid islands, cut out by the even-odd rule)
    ctx.beginPath();
    for (const ring of plan.outline) {
      ring.forEach((p, i) => {
        const q = P(p.x, p.z);
        if (i === 0) ctx.moveTo(q.px, q.py);
        else ctx.lineTo(q.px, q.py);
      });
      ctx.closePath();
    }
    ctx.fillStyle = THEME.planFloor;
    ctx.fill('evenodd');

    // Furniture boxes
    for (const b of boxes) {
      const a = P(b.minX, b.minZ);
      const c = P(b.maxX, b.maxZ);
      const x = a.px + 0.5, y = a.py + 0.5;
      const bw = Math.max(1, c.px - a.px - 1), bh = Math.max(1, c.py - a.py - 1);
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, bw, bh, Math.min(3, bw / 2, bh / 2));
      else ctx.rect(x, y, bw, bh);
      ctx.fillStyle = THEME.planBox;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = b.tall ? THEME.planBoxLineTall : THEME.planBoxLine;
      ctx.stroke();
    }

    // Walls, leaving a gap where a door is
    const wallW = isPhone() ? 2 : 3;
    const doors = openings.filter((o) => o.kind === 'door');
    ctx.strokeStyle = THEME.gold;
    ctx.lineWidth = wallW;
    ctx.lineCap = 'square';
    ctx.lineJoin = 'miter';
    ctx.beginPath();
    for (const ring of plan.outline) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        if (len < 1e-9) continue;
        const ux = (b.x - a.x) / len, uz = (b.z - a.z) / len;
        // Door intervals lying on this wall segment, as distances from a
        const gaps: [number, number][] = [];
        for (const d of doors) {
          const off = (q: { x: number; z: number }) => Math.abs((q.x - a.x) * uz - (q.z - a.z) * ux);
          if (off(d.a) > 1e-6 || off(d.b) > 1e-6) continue;
          const s0 = (d.a.x - a.x) * ux + (d.a.z - a.z) * uz;
          const s1 = (d.b.x - a.x) * ux + (d.b.z - a.z) * uz;
          const lo = Math.min(s0, s1), hi = Math.max(s0, s1);
          if (hi > 0 && lo < len) gaps.push([Math.max(0, lo), Math.min(len, hi)]);
        }
        gaps.sort((p, q) => p[0] - q[0]);
        let s = 0;
        const piece = (from: number, to: number) => {
          if (to - from < 1e-6) return;
          const p0 = P(a.x + ux * from, a.z + uz * from);
          const p1 = P(a.x + ux * to, a.z + uz * to);
          ctx.moveTo(p0.px, p0.py);
          ctx.lineTo(p1.px, p1.py);
        };
        for (const [lo, hi] of gaps) {
          piece(s, lo);
          s = Math.max(s, hi);
        }
        piece(s, len);
      }
    }
    ctx.stroke();

    // Door: a leaf line and a thin dashed swing arc into the room. Window: a sky segment on the wall
    for (const o of openings) {
      const pa = P(o.a.x, o.a.z);
      const pb = P(o.b.x, o.b.z);
      if (o.kind === 'window') {
        ctx.strokeStyle = THEME.sky;
        ctx.lineWidth = wallW + 1;
        ctx.lineCap = 'butt';
        ctx.beginPath();
        ctx.moveTo(pa.px, pa.py);
        ctx.lineTo(pb.px, pb.py);
        ctx.stroke();
        continue;
      }
      const r = Math.hypot(pb.px - pa.px, pb.py - pa.py);
      const start = Math.atan2(pb.py - pa.py, pb.px - pa.px);
      const leaf = Math.atan2(o.inward.z, o.inward.x);
      // Sweep the short way from the closed door (along the wall) to the open leaf
      let delta = leaf - start;
      while (delta > Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      ctx.strokeStyle = THEME.planDoorSwing;
      ctx.lineWidth = 1;
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.moveTo(pa.px, pa.py);
      ctx.lineTo(pa.px + Math.cos(leaf) * r, pa.py + Math.sin(leaf) * r);
      ctx.stroke();
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.arc(pa.px, pa.py, r, start, start + delta, delta < 0);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    this._planCanvas = canvas;
    this._planCanvasKey = key;
    return canvas;
  }

  worldToPixel(x: number, z: number): { px: number; py: number } {
    if (!this._mapping) return { px: 0, py: 0 };
    return worldToPixel(x, z, this._mapping);
  }

  pixelToWorld(px: number, py: number): { x: number; z: number } {
    if (!this._mapping) return { x: 0, z: 0 };
    return pixelToWorld(px, py, this._mapping);
  }

  render(
    pose: Pose3D,
    pois: POI[],
    route: Point2[] | null,
    selectedPoiId: string | null = null
  ): void {
    if (!this._isVisible || !this._ctx || !this._mapping) return;

    this._lastPois = pois;

    const dpr = window.devicePixelRatio || 1;
    const canvas = this._canvas;
    const cssSize = this._size;
    const cssH = this._height;

    if (canvas.width !== Math.round(cssSize * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssSize * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.width = `${cssSize}px`;
      canvas.style.height = `${cssH}px`;
    }

    const ctx = this._ctx;
    ctx.save();
    ctx.scale(dpr, dpr);

    // Clear background
    ctx.fillStyle = THEME.mapBg;
    ctx.fillRect(0, 0, cssSize, cssH);

    const m = this._mapping;

    // 1. Draw the cached floor plan, or the walking grid (free light, blocked dark) without one
    this._updateLayout(pois);
    const planCanvas = this._renderPlanCanvas(cssSize, cssH, dpr);
    if (planCanvas) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(planCanvas, 0, 0, cssSize, cssH);
    } else {
      if (this._cachedGridCanvas) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(this._cachedGridCanvas, m.offsetX, m.offsetY, m.drawW, m.drawH);
      }
      // Grid outer border
      ctx.strokeStyle = THEME.mapBorder;
      ctx.lineWidth = 1;
      ctx.strokeRect(m.offsetX, m.offsetY, m.drawW, m.drawH);
    }

    // 2. Draw route polyline (gold over a thin dark underlay, so it reads on the light floor)
    if (route && route.length >= 2) {
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i < route.length; i++) {
        const pt = worldToPixel(route[i].x, route[i].z, m);
        if (i === 0) {
          ctx.moveTo(pt.px, pt.py);
        } else {
          ctx.lineTo(pt.px, pt.py);
        }
      }
      ctx.strokeStyle = THEME.ink;
      ctx.lineWidth = 4.5;
      ctx.stroke();
      ctx.strokeStyle = THEME.gold;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    // 3. Draw POIs as dots with their first letter
    const spots = this._dotPixels(pois);
    for (const poi of pois) {
      const pt = spots.get(poi.poi_id)!;
      const isSelected = poi.poi_id === selectedPoiId;
      const radius = isSelected ? 8 : 7;

      ctx.beginPath();
      ctx.arc(pt.px, pt.py, radius, 0, Math.PI * 2);
      ctx.fillStyle = isSelected ? THEME.gold : THEME.mapDot;
      ctx.fill();

      ctx.lineWidth = isSelected ? 2 : 1.5;
      ctx.strokeStyle = isSelected ? THEME.ink : THEME.copper;
      ctx.stroke();

      const letter = (poi.name || '?').trim().charAt(0).toUpperCase();
      ctx.font = 'bold 9px "Space Grotesk", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.fillStyle = isSelected ? THEME.ink : THEME.white;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(letter, pt.px, pt.py + 0.5);
    }

    // 4. Draw walker arrow (showing yaw, North-up)
    const walkerPt = worldToPixel(pose.x, pose.z, m);
    const fx = -Math.sin(pose.yaw);
    const fy = -Math.cos(pose.yaw);
    const perpX = -fy;
    const perpY = fx;
    const L = 9;

    ctx.beginPath();
    // Tip
    ctx.moveTo(walkerPt.px + fx * L, walkerPt.py + fy * L);
    // Left corner
    ctx.lineTo(
      walkerPt.px - fx * (L * 0.6) - perpX * (L * 0.6),
      walkerPt.py - fy * (L * 0.6) - perpY * (L * 0.6)
    );
    // Rear notch
    ctx.lineTo(walkerPt.px - fx * (L * 0.15), walkerPt.py - fy * (L * 0.15));
    // Right corner
    ctx.lineTo(
      walkerPt.px - fx * (L * 0.6) + perpX * (L * 0.6),
      walkerPt.py - fy * (L * 0.6) + perpY * (L * 0.6)
    );
    ctx.closePath();

    ctx.fillStyle = THEME.sky;
    ctx.fill();
    ctx.strokeStyle = THEME.ink;
    ctx.lineWidth = 1.2;
    ctx.stroke();

    ctx.restore();
  }

  dispose(): void {
    this._root.remove();
  }

  private _updateSize(): void {
    // The large tag-mode map only fits beside the Places panel on wide screens
    if (this._isTagMode && window.innerWidth >= 900) {
      this._size = 360;
    } else if (isPhone()) {
      // Phones: a compact map, about 45% of the screen width (portrait) or 26% (landscape)
      // Phones: compact. Portrait about 42% of the width; landscape limited by the short height
      const portrait = window.innerHeight >= window.innerWidth;
      this._size = portrait
        ? Math.round(Math.max(130, Math.min(180, window.innerWidth * 0.42)))
        : Math.round(Math.max(110, Math.min(170, window.innerHeight * 0.5, window.innerWidth * 0.2)));
    } else if (window.innerWidth < 640) {
      this._size = 140;
    } else {
      this._size = 220;
    }

    if (this._grid) {
      this._updateMapping();
    }
  }

  private _updateMapping(): void {
    if (!this._grid) {
      this._height = this._size;
      return;
    }
    const g = this._grid;
    // Phones: crop the empty bands above and below a wide room so the map covers less of the view
    this._height = isPhone()
      ? Math.round(Math.max(80, Math.min(this._size, (this._size - 16) * (g.height / Math.max(1, g.width)) + 16)))
      : this._size;
    this._mapping = calculateMinimapMapping(g, this._size, this._height, 8);
  }

  private _cacheGridRender(grid: NavGrid): void {
    if (typeof document === 'undefined') return;

    const w = grid.width;
    const h = grid.height;
    const offscreen = document.createElement('canvas');
    offscreen.width = w;
    offscreen.height = h;

    const ctx = offscreen.getContext('2d');
    if (!ctx) return;

    const imgData = ctx.createImageData(w, h);
    const bytes = decodeBase64ToBytes(grid.free_bits_b64);
    const data = imgData.data;

    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const index = row * w + col;
        const byteIndex = index >> 3;
        const bitOffset = index & 7;

        let isFree = false;
        if (byteIndex < bytes.length) {
          isFree = ((bytes[byteIndex] >> (7 - bitOffset)) & 1) === 1;
        }

        const pIdx = index * 4;
        if (isFree) {
          // Free space: warm parchment (THEME.mapFree)
          data[pIdx + 0] = THEME.mapFree[0];
          data[pIdx + 1] = THEME.mapFree[1];
          data[pIdx + 2] = THEME.mapFree[2];
          data[pIdx + 3] = THEME.mapFree[3];
        } else {
          // Blocked space: page black (THEME.mapBlocked)
          data[pIdx + 0] = THEME.mapBlocked[0];
          data[pIdx + 1] = THEME.mapBlocked[1];
          data[pIdx + 2] = THEME.mapBlocked[2];
          data[pIdx + 3] = THEME.mapBlocked[3];
        }
      }
    }

    ctx.putImageData(imgData, 0, 0);
    this._cachedGridCanvas = offscreen;
  }

  private _setupEvents(): void {
    window.addEventListener('resize', () => {
      this._updateSize();
    });

    // Adjust mode: press a dot, drag, release
    const local = (e: PointerEvent) => {
      const r = this._canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    this._canvas.addEventListener('pointerdown', (e: PointerEvent) => {
      if (!this._isTagMode || !this._placeMode || document.pointerLockElement || e.button !== 0) return;
      const pt = local(e);
      const poi = this._poiAt(pt.x, pt.y);
      if (!poi) return;
      e.preventDefault();
      e.stopPropagation();
      this._drag = { poi, id: e.pointerId, moved: false, sx: pt.x, sy: pt.y };
      this._canvas.setPointerCapture(e.pointerId);
      this._canvas.style.cursor = 'grabbing';
    });
    this._canvas.addEventListener('pointermove', (e: PointerEvent) => {
      const d = this._drag;
      if (!d || e.pointerId !== d.id) return;
      const pt = local(e);
      if (!d.moved && Math.hypot(pt.x - d.sx, pt.y - d.sy) < 4) return;
      d.moved = true;
      const w = this.pixelToWorld(pt.x, pt.y);
      for (const cb of this._dragCallbacks) cb(d.poi, w.x, w.z, false);
    });
    const endDrag = (e: PointerEvent) => {
      const d = this._drag;
      if (!d || e.pointerId !== d.id) return;
      this._drag = null;
      this._canvas.style.cursor = this._placeMode ? 'grab' : '';
      if (!d.moved) return; // a plain press: the click handler selects the dot
      const pt = local(e);
      const w = this.pixelToWorld(pt.x, pt.y);
      for (const cb of this._dragCallbacks) cb(d.poi, w.x, w.z, true);
      this._suppressClick = true;
      setTimeout(() => (this._suppressClick = false), 0);
    };
    this._canvas.addEventListener('pointerup', endDrag);
    this._canvas.addEventListener('pointercancel', endDrag);

    this._canvas.addEventListener('click', (e: MouseEvent) => {
      if (document.pointerLockElement) return;
      e.stopPropagation();
      if (this._suppressClick) return;

      const rect = this._canvas.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;

      // In tag mode: Shift-click relocates the selected POI (Adjust mode drags dots instead)
      const relocate = () => {
        const world = this.pixelToWorld(clickX, clickY);
        for (const cb of this._relocateCallbacks) {
          cb(world.x, world.z);
        }
      };
      if (this._isTagMode && e.shiftKey) {
        relocate();
        return;
      }

      // Normal click: select POI dot if clicked
      const closestPoi = this._poiAt(clickX, clickY);
      if (closestPoi) {
        for (const cb of this._selectPoiCallbacks) {
          cb(closestPoi);
        }
      }
    });
  }

  private _injectStyles(): void {
    if (document.getElementById('namma-minimap-style')) return;
    const style = document.createElement('style');
    style.id = 'namma-minimap-style';
    style.textContent = MINIMAP_CSS;
    document.head.appendChild(style);
  }
}
