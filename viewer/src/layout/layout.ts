/**
 * Namma Space: Rearrange layout data (move furniture)
 *
 * A layout is a list of moves, each from the object's original spot (never chained). This file
 * holds the undo/redo history, the private per-device storage, where things end up after a move
 * (tags that follow their object), and the drop rules. Pure: no DOM besides localStorage access
 * (wrapped, so it works with storage blocked), unit-tested.
 */

import type { NavGrid, POI } from '../contracts/types.js';
import { kindOf } from '../nav/floorplan.js';
import type { MovableObject } from './objects.js';
import { patchGrid, unpackBits, backToOriginal, isIdentityMove, type Move } from './regrid.js';
import { cleanMoveList } from './layout_file.js';

export type { Move } from './regrid.js';
export { parseLayout, layoutText, LAYOUT_SCHEMA, type PublishedLayout } from './layout_file.js';

export const LAYOUT_LIMITS = {
  /** At most this many objects moved at once */
  maxMoved: 8,
  /** Undo steps kept */
  historySize: 50,
  /** Turn step for the rotate buttons and keys (degrees) */
  turnStepDeg: 15,
  /** A drop may overlap occupied cells by at most this share (scan noise) */
  overlapShare: 0.03,
  /** Keep-clear radius around the start spot and door tags (m) */
  keepClearM: 0.5,
  /** Keep-clear margin around the visitor (m), on top of the body radius */
  visitorMarginM: 0.25,
};

/** Drops identities and unknown ids; one move per object (the last one wins) */
export function normalizeMoves(moves: Move[], objects: MovableObject[]): Move[] {
  const known = new Set(objects.map(o => o.id));
  const byId = new Map<number, Move>();
  for (const m of moves) {
    if (!known.has(m.id)) continue;
    const t = ((m.turnDeg % 360) + 360) % 360;
    const clean = { id: m.id, dx: round(m.dx), dz: round(m.dz), turnDeg: round(t) };
    if (isIdentityMove(clean)) byId.delete(m.id);
    else byId.set(m.id, clean);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

const round = (v: number): number => Math.round(v * 1000) / 1000;

export const sameMoves = (a: Move[], b: Move[]): boolean =>
  a.length === b.length && a.every((m, i) => m.id === b[i].id && m.dx === b[i].dx && m.dz === b[i].dz && m.turnDeg === b[i].turnDeg);

/** Undo / redo over whole layouts. Every drop, turn and reset is one step */
export class LayoutHistory {
  private _past: Move[][] = [];
  private _future: Move[][] = [];
  private _current: Move[];

  constructor(initial: Move[] = [], private readonly _limit = LAYOUT_LIMITS.historySize) {
    this._current = initial.slice();
  }

  get current(): Move[] {
    return this._current.slice();
  }

  get canUndo(): boolean {
    return this._past.length > 0;
  }

  get canRedo(): boolean {
    return this._future.length > 0;
  }

  /** Records a new layout; returns false (no step) when it equals the current one */
  push(moves: Move[]): boolean {
    if (sameMoves(moves, this._current)) return false;
    this._past.push(this._current);
    if (this._past.length > this._limit) this._past.shift();
    this._current = moves.slice();
    this._future = [];
    return true;
  }

  undo(): Move[] | null {
    const prev = this._past.pop();
    if (!prev) return null;
    this._future.push(this._current);
    this._current = prev;
    return this.current;
  }

  redo(): Move[] | null {
    const next = this._future.pop();
    if (!next) return null;
    this._past.push(this._current);
    this._current = next;
    return this.current;
  }
}

// -----------------------------------------------------------------------------
// Private storage: this device only, per scene and grid (a new scan ignores an old layout)
// -----------------------------------------------------------------------------

export const storageKey = (sceneId: string, gridHash: string): string => `ns-rearrange:${sceneId}:${gridHash.slice(0, 16)}`;

/** In-memory fallback when localStorage is blocked: the layout lasts until the page closes */
const memoryStore = new Map<string, string>();

/** A private layout as stored: the moves, and the published layout they were made on top of */
export interface PrivateLayout {
  moves: Move[];
  /** updated_at of the published layout in use when these moves were made (null: there was none) */
  base: string | null;
}

/** The private layout on this device, or null when there is none */
export function loadPrivate(sceneId: string, gridHash: string): PrivateLayout | null {
  const key = storageKey(sceneId, gridHash);
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    raw = memoryStore.get(key) ?? null;
  }
  if (raw === null) raw = memoryStore.get(key) ?? null;
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as { moves?: unknown; base?: unknown };
    if (!Array.isArray(data.moves)) return null;
    return { moves: cleanMoveList(data.moves), base: typeof data.base === 'string' ? data.base : null };
  } catch {
    return null;
  }
}

export function loadMoves(sceneId: string, gridHash: string): Move[] {
  return loadPrivate(sceneId, gridHash)?.moves ?? [];
}

/** Stores the private layout; with no moves and no published base it is removed (the original room) */
export function saveMoves(sceneId: string, gridHash: string, moves: Move[], base: string | null = null): void {
  const key = storageKey(sceneId, gridHash);
  if (!moves.length && base === null) {
    clearMoves(sceneId, gridHash);
    return;
  }
  const raw = JSON.stringify({ v: 2, moves, base });
  memoryStore.set(key, raw);
  try {
    localStorage.setItem(key, raw);
  } catch {
    // Storage blocked (private window, preview): the in-memory copy keeps it for this page
  }
}

/** Forgets the private layout (this device follows the published layout again) */
export function clearMoves(sceneId: string, gridHash: string): void {
  const key = storageKey(sceneId, gridHash);
  memoryStore.delete(key);
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}


// -----------------------------------------------------------------------------
// Where things end up
// -----------------------------------------------------------------------------

/** World point after the move (the inverse of regrid's backToOriginal) */
export function movePoint(o: MovableObject, m: Move, x: number, z: number): { x: number; z: number } {
  const cx = (o.lift.minX + o.lift.maxX) / 2;
  const cz = (o.lift.minZ + o.lift.maxZ) / 2;
  const a = (m.turnDeg * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const px = x - cx, pz = z - cz;
  return { x: cx + m.dx + px * cos + pz * sin, z: cz + m.dz - px * sin + pz * cos };
}

/** The four corners of the object's reach after the move (for drawing a turned box) */
export function movedCorners(o: MovableObject, m: Move | undefined): { x: number; z: number }[] {
  const L = o.reach;
  const pts = [[L.minX, L.minZ], [L.maxX, L.minZ], [L.maxX, L.maxZ], [L.minX, L.maxZ]];
  return pts.map(([x, z]) => (m ? movePoint(o, m, x, z) : { x, z }));
}

/**
 * Tags that move with an object: the tag's floor spot is inside the object's real box, and it is
 * not a door (category exit) or a window. Wall tags outside the box never follow.
 */
export function followers(objects: MovableObject[], pois: POI[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of pois) {
    if (p.category === 'exit') continue;
    if ([p.name, ...(p.aliases ?? [])].some(s => /window|door/i.test(s))) continue;
    const o = objects.find(ob =>
      p.position.x >= ob.box.minX && p.position.x <= ob.box.maxX && p.position.z >= ob.box.minZ && p.position.z <= ob.box.maxZ);
    if (o) out.set(p.poi_id, o.id);
  }
  return out;
}

/**
 * Tags as they appear with the layout: followers slide and turn with their object; every tag's
 * approach spot is re-snapped to the nearest walkable cell when isWalkable says it is blocked.
 */
export function layoutPois(
  pois: POI[],
  objects: MovableObject[],
  moves: Move[],
  follow: Map<string, number>,
  snap?: (x: number, z: number) => { x: number; z: number } | null
): POI[] {
  if (!moves.length) return pois;
  const byObj = new Map(objects.map(o => [o.id, o]));
  const byMove = new Map(moves.map(m => [m.id, m]));
  return pois.map(p => {
    const id = follow.get(p.poi_id);
    const m = id !== undefined ? byMove.get(id) : undefined;
    const o = id !== undefined ? byObj.get(id) : undefined;
    let out = p;
    if (m && o) {
      const at = movePoint(o, m, p.position.x, p.position.z);
      const ap = p.approach ? movePoint(o, m, p.approach.x, p.approach.z) : undefined;
      out = {
        ...p,
        position: { ...p.position, x: at.x, z: at.z },
        ...(ap ? { approach: ap } : {}),
        ...(p.yaw_deg !== undefined ? { yaw_deg: p.yaw_deg + m.turnDeg } : {}),
      };
    }
    if (snap) {
      const goal = out.approach ?? out.position;
      const s = snap(goal.x, goal.z);
      if (s && (s.x !== goal.x || s.z !== goal.z)) out = { ...out, approach: s };
    }
    return out;
  });
}

// -----------------------------------------------------------------------------
// Drop rules
// -----------------------------------------------------------------------------

export interface DropContext {
  grid: NavGrid;
  /** 1 = inside the room (floor plan masks.floor) */
  floor: Uint8Array;
  objects: MovableObject[];
}

/**
 * Cells an object may not land on, for one drag: occupied (in the band from 0.2 m to the object's
 * top) with the object itself taken out and every other move applied, or outside the room.
 */
export function blockedCellsFor(ctx: DropContext, moves: Move[], id: number): Uint8Array {
  const { grid, floor, objects } = ctx;
  const o = objects.find(ob => ob.id === id);
  const n = grid.width * grid.height;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = floor[i] ? 0 : 1;
  if (!o || !grid.layers) return out;
  // Take the object out (moved far away), keep the others where they are now
  const others = moves.filter(m => m.id !== id);
  const r = patchGrid(grid, objects, [...others, { id, dx: 1e6, dz: 0, turnDeg: 0 }]);
  const L = r.grid.layers!;
  const bits = unpackBits(L.occupied_bits_b64, L.count * n);
  const lo = Math.max(0, Math.ceil((0.2 - L.y0_m) / L.dy_m - 1e-6));
  const hi = Math.min(L.count - 1, Math.max(o.l1, lo));
  for (let i = 0; i < n; i++) {
    if (out[i]) continue;
    for (let l = lo; l <= hi; l++) if (bits[l * n + i]) { out[i] = 1; break; }
  }
  return out;
}

export type DropVerdict = { ok: true } | { ok: false; reason: 'blocked' | 'outside' | 'start' | 'door' | 'you' | 'limit' };

/** Checks a drop against the blocked cells, the room, the keep-clear spots and the move limit */
export function checkDrop(
  ctx: DropContext,
  blocked: Uint8Array,
  move: Move,
  keepClear: { x: number; z: number; r: number; reason: 'start' | 'door' | 'you' }[],
  movedCount: number
): DropVerdict {
  const { grid, objects } = ctx;
  const o = objects.find(ob => ob.id === move.id);
  if (!o) return { ok: false, reason: 'blocked' };
  if (isIdentityMove(move)) return { ok: true };
  if (movedCount > LAYOUT_LIMITS.maxMoved) return { ok: false, reason: 'limit' };
  const w = grid.width, h = grid.height, cell = grid.cell_m;
  const [ox, oz] = grid.origin;
  const back = backToOriginal(o, move);
  const corners = movedCorners(o, move);
  const minX = Math.min(...corners.map(p => p.x)), maxX = Math.max(...corners.map(p => p.x));
  const minZ = Math.min(...corners.map(p => p.z)), maxZ = Math.max(...corners.map(p => p.z));
  if (minX < ox || minZ < oz || maxX > ox + w * cell || maxZ > oz + h * cell) return { ok: false, reason: 'outside' };
  let cells = 0, hits = 0, outside = 0;
  const c0 = Math.max(0, Math.floor((minX - ox) / cell)), c1 = Math.min(w - 1, Math.floor((maxX - ox) / cell));
  const r0 = Math.max(0, Math.floor((minZ - oz) / cell)), r1 = Math.min(h - 1, Math.floor((maxZ - oz) / cell));
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const x = ox + (c + 0.5) * cell, z = oz + (r + 0.5) * cell;
      const [sx, sz] = back(x, z);
      if (sx < o.reach.minX || sx >= o.reach.maxX || sz < o.reach.minZ || sz >= o.reach.maxZ) continue;
      const i = r * w + c;
      const inLift = sx >= o.lift.minX && sx < o.lift.maxX && sz >= o.lift.minZ && sz < o.lift.maxZ;
      // The wall end (reach outside the lift) may sit in the band along a wall, never on furniture
      if (!inLift && !ctx.floor[i]) continue;
      cells++;
      if (!ctx.floor[i]) outside++;
      else if (blocked[i]) hits++;
      for (const k of keepClear) {
        if (Math.hypot(x - k.x, z - k.z) < k.r) return { ok: false, reason: k.reason };
      }
    }
  }
  if (!cells) return { ok: false, reason: 'outside' };
  if (outside > cells * LAYOUT_LIMITS.overlapShare) return { ok: false, reason: 'outside' };
  if (hits > cells * LAYOUT_LIMITS.overlapShare) return { ok: false, reason: 'blocked' };
  return { ok: true };
}

/** Keep-clear spots: the scene's start, door (exit) tags, and the visitor */
export function keepClearSpots(
  start: { x: number; z: number },
  pois: POI[],
  visitor: { x: number; z: number } | null,
  bodyRadiusM: number
): { x: number; z: number; r: number; reason: 'start' | 'door' | 'you' }[] {
  const L = LAYOUT_LIMITS;
  const out: { x: number; z: number; r: number; reason: 'start' | 'door' | 'you' }[] = [
    { x: start.x, z: start.z, r: L.keepClearM, reason: 'start' },
  ];
  for (const p of pois) {
    if (p.category === 'exit' || kindOf(p).endsWith('|door') || /\bdoor\b/i.test(p.name)) {
      const at = p.approach ?? p.position;
      out.push({ x: at.x, z: at.z, r: L.keepClearM, reason: 'door' });
    }
  }
  if (visitor) out.push({ x: visitor.x, z: visitor.z, r: bodyRadiusM + L.visitorMarginM, reason: 'you' });
  return out;
}
