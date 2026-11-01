/**
 * Namma Space: Floor-plan Minimap (Round 2)
 *
 * Renders the 2D walking grid from grid.json (free light, blocked dark) to an offscreen canvas
 * cache once so per-frame redraw is cheap (<= 1 fps cost).
 *
 * Displays:
 * - Dynamic walker arrow (showing camera yaw, North is up)
 * - Tagged POIs as dots with their first letter
 * - Active navigation route as cyan polyline
 * - Shift-click to relocate selected POI in tag mode (?tag=1); in Adjust mode drag a dot to move it
 * - Click POI dot to open its POI info card
 * - Toggled with N key and HUD button
 */

import type { NavGrid, POI } from '../contracts/types.js';
import type { Pose3D } from '../types.js';
import type { Point2 } from '../nav/astar.js';
import { decodeBase64ToBytes } from '../collision/grid.js';
import { ensureTokens, THEME } from './tokens.js';

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
  private _grid: NavGrid | null = null;
  private _mapping: MinimapMapping | null = null;
  private _size = 220;
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
    let minDist = window.matchMedia?.('(pointer: coarse)').matches ? 20 : 12;
    for (const poi of this._lastPois) {
      const pt = this.worldToPixel(poi.position.x, poi.position.z);
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

    if (canvas.width !== Math.round(cssSize * dpr) || canvas.height !== Math.round(cssSize * dpr)) {
      canvas.width = Math.round(cssSize * dpr);
      canvas.height = Math.round(cssSize * dpr);
      canvas.style.width = `${cssSize}px`;
      canvas.style.height = `${cssSize}px`;
    }

    const ctx = this._ctx;
    ctx.save();
    ctx.scale(dpr, dpr);

    // Clear background
    ctx.fillStyle = THEME.mapBg;
    ctx.fillRect(0, 0, cssSize, cssSize);

    const m = this._mapping;

    // 1. Draw cached floor-plan grid (free light, blocked dark)
    if (this._cachedGridCanvas) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this._cachedGridCanvas, m.offsetX, m.offsetY, m.drawW, m.drawH);
    }

    // Grid outer border
    ctx.strokeStyle = THEME.mapBorder;
    ctx.lineWidth = 1;
    ctx.strokeRect(m.offsetX, m.offsetY, m.drawW, m.drawH);

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
    for (const poi of pois) {
      const pt = worldToPixel(poi.position.x, poi.position.z, m);
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
    if (!this._grid) return;
    this._mapping = calculateMinimapMapping(this._grid, this._size, this._size, 10);
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
    style.textContent = `
      .namma-minimap-container {
        position: absolute;
        bottom: var(--ns-hud-bottom);
        right: var(--ns-hud-right);
        z-index: 90;
        padding: 4px;
        background: var(--ns-surface-strong);
        border: 1px solid var(--ns-border);
        border-radius: var(--ns-radius-lg);
        box-shadow: var(--ns-shadow);
        pointer-events: auto;
        user-select: none;
        transform-origin: bottom right;
        transition: opacity var(--ns-dur) var(--ns-ease-out), scale var(--ns-dur) var(--ns-ease-out),
          display var(--ns-dur) allow-discrete;
        @starting-style { opacity: 0; scale: 0.96; }
      }
      .namma-minimap-container.hidden {
        display: none;
        opacity: 0;
        scale: 0.96;
        transition-duration: var(--ns-dur-fast);
      }
      .namma-minimap-canvas {
        display: block;
        border-radius: calc(var(--ns-radius-lg) - 4px);
        cursor: crosshair;
      }
      /* Narrow screens: top-right under the HUD row, clear of the bottom cards and the centre */
      @media (max-width: 900px) {
        .namma-minimap-container {
          top: calc(var(--ns-hud-top) + var(--ns-target) + 16px);
          bottom: auto;
          transform-origin: top right;
        }
      }
      @media (max-width: 760px) {
        .namma-minimap-container {
          top: calc(var(--ns-hud-top) + 2 * var(--ns-target) + 40px);
        }
      }
    `;
    document.head.appendChild(style);
  }
}
