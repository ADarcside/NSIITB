/**
 * Namma Space: Rearrange controller (move furniture, visitor mode)
 *
 * Holds the layout in use and its undo/redo, and applies it everywhere: the walkable grid for
 * movement, routes and the minimap, the tags that follow their object, and the lifted copies in the
 * 3D scene. The original room is never edited: no moves = the scan as it is. Any error while
 * applying falls back to the original room with a one-line notice.
 *
 * Three modes:
 *  - view: the published layout (layout.json, the owner's) as it is, nothing to edit
 *  - visitor: the published layout plus private moves kept on this device only; Reset goes back to
 *    the published layout, and private moves made on an older published layout are dropped
 *  - admin (tag mode): edits the published layout itself; Save for everyone commits it
 */

import type * as THREE from 'three';
import type { SplatMesh } from '@sparkjsdev/spark';
import type { NavGrid, POI } from '../contracts/types.js';
import { buildFloorPlanWithMasks, type FloorPlan } from '../nav/floorplan.js';
import { NavPlanner } from '../nav/astar.js';
import { movableObjects, applyBoxEdits, cleanBoxEdits, type MovableObject, type BoxEdit } from './objects.js';
import { patchGrid } from './regrid.js';
import { LiftedFurniture } from './lift_scene.js';
import {
  LayoutHistory, LAYOUT_LIMITS, normalizeMoves, followers, layoutPois, blockedCellsFor, checkDrop,
  keepClearSpots, loadPrivate, saveMoves, clearMoves, sameMoves, type DropContext, type DropVerdict, type Move,
} from './layout.js';

export type RearrangeMode = 'view' | 'visitor' | 'admin';

/** The layout every visitor starts from (from layout.json; none = the room as scanned) */
export interface BaseLayout {
  moves: Move[];
  locked: number[];
  /** The owner's fixes to the detected furniture boxes */
  boxes?: BoxEdit[];
  /** updated_at of layout.json; null when there is none */
  updatedAt: string | null;
}

export interface RearrangeHost {
  sceneId: string;
  /** sha256 of grid.json: a layout is tied to the scan it was made on */
  gridHash: string;
  /** The published grid (never edited) */
  grid: NavGrid;
  start: { x: number; z: number };
  scene: THREE.Scene;
  getMesh: () => SplatMesh | null;
  worldFromSplat: ArrayLike<number>;
  getPose: () => { x: number; z: number };
  /** The tags as published */
  getPois: () => POI[];
  /** Puts a grid in use for walking, routes and the minimap (the original or a patched one) */
  applyGrid: (grid: NavGrid) => void;
  /** Puts the tags as they appear with the layout in use */
  applyPois: (pois: POI[]) => void;
  /** Tells the minimap where moved objects are drawn */
  applyPlanMoves: (objects: MovableObject[], moves: Move[], movedPoiIds: Set<string>) => void;
  toast: (msg: string) => void;
  /** ?layout=off: start from the original, never load the published or private layout */
  layoutOff?: boolean;
  /** Default visitor */
  mode?: RearrangeMode;
  /** The published layout (default: none) */
  published?: BaseLayout;
}

const REASON: Record<Exclude<DropVerdict, { ok: true }>['reason'], string> = {
  blocked: 'Not enough space there',
  outside: 'That spot is outside the room',
  start: 'Keep the starting spot clear',
  door: 'Keep the door clear',
  you: 'You are standing there',
  limit: `At most ${LAYOUT_LIMITS.maxMoved} pieces can be moved`,
};

const NO_LAYOUT: BaseLayout = { moves: [], locked: [], updatedAt: null };

export class RearrangeController {
  /** The movable objects (rebuilt when the admin fixes a box) */
  objects: MovableObject[];
  /** The floor plan with the owner's box fixes */
  plan: FloorPlan;
  /** The floor plan as detected from the scan (the box tool shows what was changed) */
  readonly detected: FloorPlan;
  readonly mode: RearrangeMode;
  private _ctx: DropContext;
  private readonly _history: LayoutHistory;
  private _lift: LiftedFurniture;
  private readonly _masks: NonNullable<ReturnType<typeof buildFloorPlanWithMasks>>['masks'];
  private _boxes: BoxEdit[];
  private _follow = new Map<string, number>();
  private _paused = false;
  private _drag: { id: number; blocked: Uint8Array; move: Move; verdict: DropVerdict } | null = null;
  private _listeners: (() => void)[] = [];
  /** The published layout (cleaned); visitors reset to it and see it while paused */
  private _base: BaseLayout;
  private _locked: Set<number>;
  private _startNote: string | null = null;

  constructor(private readonly _host: RearrangeHost) {
    const built = buildFloorPlanWithMasks(_host.grid);
    if (!built) throw new Error('no floor plan for this grid');
    this.detected = built.plan;
    this._masks = built.masks;
    this.mode = _host.mode ?? 'visitor';
    const pub = _host.layoutOff ? NO_LAYOUT : (_host.published ?? NO_LAYOUT);
    this._boxes = cleanBoxEdits(pub.boxes ?? []);
    const fixed = applyBoxEdits(_host.grid, built.plan, this._boxes);
    this.plan = fixed.plan;
    this.objects = movableObjects(_host.grid, fixed.plan, built.masks, fixed.forced);
    this._ctx = { grid: _host.grid, floor: built.masks.floor, objects: this.objects };
    const known = new Set(this.objects.map(o => o.id));
    this._base = { moves: normalizeMoves(pub.moves, this.objects), locked: pub.locked.filter(id => known.has(id)), boxes: this._boxes, updatedAt: pub.updatedAt };
    this._locked = new Set(this._base.locked);
    let initial = this._base.moves;
    if (this.mode === 'visitor' && !_host.layoutOff) {
      const own = loadPrivate(_host.sceneId, _host.gridHash);
      if (own && own.base === this._base.updatedAt) {
        // Locked pieces always stand where the owner put them
        const keep = own.moves.filter(m => !this._locked.has(m.id));
        initial = normalizeMoves(keep.concat(this._base.moves.filter(m => this._locked.has(m.id))), this.objects);
      } else if (own) {
        // The owner changed the room since these moves were made: theirs wins, ours is dropped
        clearMoves(_host.sceneId, _host.gridHash);
        if (own.moves.length) this._startNote = 'The room layout was updated, so your own changes were cleared';
      }
    }
    this._history = new LayoutHistory(initial);
    this._lift = new LiftedFurniture(_host.scene, _host.getMesh, _host.worldFromSplat, this.objects, { grid: _host.grid, floor: built.masks.floor });
    this._follow = followers(this.objects, _host.getPois());
  }

  get moves(): Move[] {
    return this._history.current;
  }

  get canUndo(): boolean {
    return this._history.canUndo;
  }

  get canRedo(): boolean {
    return this._history.canRedo;
  }

  get paused(): boolean {
    return this._paused;
  }

  /** The published layout's moves (what Reset goes back to for a visitor) */
  get baseMoves(): Move[] {
    return this._base.moves.slice();
  }

  /** Visitors can't move a locked piece (the owner fixed it); admin can */
  isLocked(id: number): boolean {
    return this._locked.has(id);
  }

  get locked(): number[] {
    return [...this._locked].sort((a, b) => a - b);
  }

  /** Admin: the layout, the locks or the boxes differ from what is published */
  get dirty(): boolean {
    return !sameMoves(this.moves, this._base.moves) || this.locked.join() !== this._base.locked.join() ||
      JSON.stringify(this._boxes) !== JSON.stringify(this._base.boxes ?? []);
  }

  /** The owner's box fixes in use */
  get boxEdits(): BoxEdit[] {
    return this._boxes.map(b => ({ ...b }));
  }

  /**
   * Admin: replaces the box fixes and rebuilds the objects (and their lifted copies). Moves of a
   * removed box are dropped; a fixed box keeps its move, now applied to the new outline.
   */
  setBoxEdits(edits: BoxEdit[]): void {
    if (this.mode !== 'admin') return;
    const clean = cleanBoxEdits(edits);
    const fixed = applyBoxEdits(this._host.grid, this.detected, clean);
    const objects = movableObjects(this._host.grid, fixed.plan, this._masks, fixed.forced);
    const lift = new LiftedFurniture(this._host.scene, this._host.getMesh, this._host.worldFromSplat, objects, { grid: this._host.grid, floor: this._masks.floor });
    this._lift.dispose();
    this._lift = lift;
    this._boxes = clean;
    this.plan = fixed.plan;
    this.objects = objects;
    this._ctx = { grid: this._host.grid, floor: this._masks.floor, objects };
    const known = new Set(objects.map(o => o.id));
    for (const id of [...this._locked]) if (!known.has(id)) this._locked.delete(id);
    this._follow = followers(objects, this._host.getPois());
    this._drag = null;
    const kept = normalizeMoves(this.moves, objects);
    if (!sameMoves(kept, this.moves)) this._record(kept);
    this._apply(false);
  }

  /** updated_at of the published layout this one started from */
  get baseUpdatedAt(): string | null {
    return this._base.updatedAt;
  }

  /** Admin: locks or unlocks a piece for visitors */
  toggleLock(id: number): void {
    if (this.mode !== 'admin' || !this.objects.some(o => o.id === id)) return;
    if (this._locked.has(id)) this._locked.delete(id);
    else this._locked.add(id);
    this._emit();
  }

  /** Admin: the current layout was saved for everyone and is now the published one */
  markPublished(updatedAt: string): void {
    this._base = { moves: this.moves, locked: this.locked, boxes: this.boxEdits, updatedAt };
    this._emit();
  }

  /** Names of the tags that can't be reached from the start with the current layout */
  unreachable(): string[] {
    const moves = normalizeMoves(this.moves, this.objects);
    const patched = patchGrid(this._host.grid, this.objects, moves).grid;
    return this._cutOff(patched, moves);
  }

  get dragging(): { id: number; move: Move; ok: boolean } | null {
    return this._drag ? { id: this._drag.id, move: this._drag.move, ok: this._drag.verdict.ok } : null;
  }

  /** Called whenever the layout, the drag or the pause changes (the panel redraws) */
  onChange(cb: () => void): void {
    this._listeners.push(cb);
  }

  /** The published tags changed (loaded later than the grid, or edited) */
  refreshPois(): void {
    this._follow = followers(this.objects, this._host.getPois());
    this._apply(false);
  }

  /** Applies the saved layout once at start */
  start(): void {
    this._apply(false);
    if (this._startNote) this._host.toast(this._startNote);
    this._startNote = null;
  }

  /** Per frame: keeps the lifted copies in step (a Lite / HD swap lifts them again) */
  update(): void {
    if (this._paused) return;
    try {
      this._lift.sync(this.moves, this._drag ? [this._drag.id] : []);
      if (this._drag) this._lift.preview(this._drag.move);
    } catch (err) {
      this._fail(err);
    }
  }

  /** Multiplayer rooms: the private layout is paused (everyone sees the published one), not deleted */
  setPaused(on: boolean): void {
    if (on === this._paused) return;
    this._paused = on;
    this._drag = null;
    this._apply(false);
  }

  // --- Moving -----------------------------------------------------------------------------------

  /** Starts moving one object; its current move (or none) is the starting point */
  beginDrag(id: number): boolean {
    if (!this._canEdit(id)) return false;
    const current = this.moves.find(m => m.id === id) ?? { id, dx: 0, dz: 0, turnDeg: 0 };
    this._drag = { id, blocked: blockedCellsFor(this._ctx, this.moves, id), move: current, verdict: { ok: true } };
    this._emit();
    return true;
  }

  /** Live drag: where the object would go (the copy follows; green or red ghost from the verdict) */
  dragTo(move: Move): DropVerdict {
    if (!this._drag) return { ok: false, reason: 'blocked' };
    this._drag.move = { ...move, id: this._drag.id };
    this._drag.verdict = this._check(this._drag.move, this._drag.blocked);
    this._lift.preview(this._drag.move);
    this._emit();
    return this._drag.verdict;
  }

  /** Drops: a good spot becomes one undo step; a bad one snaps the object back */
  endDrag(): DropVerdict {
    const d = this._drag;
    if (!d) return { ok: false, reason: 'blocked' };
    this._drag = null;
    if (d.verdict.ok) this._record(this.moves.filter(m => m.id !== d.id).concat(d.move));
    else this._host.toast(`${REASON[d.verdict.reason]}. Moved back.`);
    this._apply(false);
    return d.verdict;
  }

  cancelDrag(): void {
    if (!this._drag) return;
    this._drag = null;
    this._apply(false);
  }

  /** Turns an object by a step (degrees, + = counter-clockwise seen from above) where it stands */
  turn(id: number, stepDeg: number): DropVerdict {
    if (!this._canEdit(id)) return { ok: false, reason: 'blocked' };
    const current = this.moves.find(m => m.id === id) ?? { id, dx: 0, dz: 0, turnDeg: 0 };
    const next = { ...current, turnDeg: current.turnDeg + stepDeg };
    const verdict = this._check(next, blockedCellsFor(this._ctx, this.moves, id));
    if (!verdict.ok) {
      this._host.toast(`${REASON[verdict.reason]} to turn it`);
      return verdict;
    }
    this._record(this.moves.filter(m => m.id !== id).concat(next));
    this._apply(false);
    return verdict;
  }

  undo(): void {
    if (this._paused || this.mode === 'view' || !this._history.undo()) return;
    this._apply(true);
  }

  redo(): void {
    if (this._paused || this.mode === 'view' || !this._history.redo()) return;
    this._apply(true);
  }

  /** Visitor: back to the published layout. Admin: back to the room as scanned. One undo step. */
  reset(): void {
    if (this._paused || this.mode === 'view') return;
    if (this._record(this.mode === 'admin' ? [] : this._base.moves)) this._apply(true);
  }

  dispose(): void {
    this._lift.dispose();
    this._listeners = [];
  }

  // --- Internals --------------------------------------------------------------------------------

  private _check(move: Move, blocked: Uint8Array): DropVerdict {
    const moved = new Set(this.moves.map(m => m.id));
    moved.add(move.id);
    const spots = keepClearSpots(this._host.start, this._host.getPois(), this._host.getPose(), this._host.grid.agent_radius_m);
    return checkDrop(this._ctx, blocked, move, spots, moved.size);
  }

  private _canEdit(id: number): boolean {
    if (this._paused || this.mode === 'view' || !this.objects.some(o => o.id === id)) return false;
    if (this.mode === 'visitor' && this._locked.has(id)) {
      this._host.toast('This piece stays where it is');
      return false;
    }
    return true;
  }

  private _record(moves: Move[]): boolean {
    const clean = normalizeMoves(moves, this.objects);
    const changed = this._history.push(clean);
    if (changed) this._store();
    return changed;
  }

  /** Visitor only: keeps the private layout on this device (none when it equals the published one) */
  private _store(): void {
    if (this.mode !== 'visitor') return;
    const { sceneId, gridHash } = this._host;
    if (sameMoves(this.moves, this._base.moves)) clearMoves(sceneId, gridHash);
    else saveMoves(sceneId, gridHash, this.moves, this._base.updatedAt);
  }

  /** Puts the current layout (or the published one, while paused) in use everywhere */
  private _apply(fromHistory: boolean): void {
    // Undo may bring back a move of a box the admin removed since: only known objects count
    const moves = normalizeMoves(this._paused ? this._base.moves : this.moves, this.objects);
    if (fromHistory) this._store();
    try {
      const patched = patchGrid(this._host.grid, this.objects, moves).grid;
      this._host.applyGrid(patched);
      this._host.applyPois(layoutPois(this._host.getPois(), this.objects, moves, this._follow));
      this._host.applyPlanMoves(this.objects, moves, this._movedPoiIds(moves));
      this._lift.sync(moves, this._drag ? [this._drag.id] : []);
      if (moves.length && !fromHistory) this._warnUnreachable(patched, moves);
    } catch (err) {
      this._fail(err);
    }
    this._emit();
  }

  /** After a change: says which tags can no longer be reached from the start (a warning only) */
  private _warnUnreachable(grid: NavGrid, moves: Move[]): void {
    const cut = this._cutOff(grid, moves);
    if (cut.length) this._host.toast(`Path blocked: ${cut.slice(0, 3).join(', ')}${cut.length > 3 ? ` and ${cut.length - 3} more` : ''} can't be reached`);
  }

  private _cutOff(grid: NavGrid, moves: Move[]): string[] {
    const planner = new NavPlanner(grid);
    const pois = layoutPois(this._host.getPois(), this.objects, moves, this._follow);
    return pois.filter(p => !planner.findPath(this._host.start, p.approach ?? p.position)).map(p => p.name);
  }

  private _movedPoiIds(moves: Move[]): Set<string> {
    const ids = new Set(moves.map(m => m.id));
    return new Set([...this._follow].filter(([, obj]) => ids.has(obj)).map(([poi]) => poi));
  }

  private _fail(err: unknown): void {
    console.warn('[Rearrange] could not apply the layout, showing the original room', err);
    try {
      this._lift.clear();
      this._host.applyGrid(this._host.grid);
      this._host.applyPois(this._host.getPois());
      this._host.applyPlanMoves(this.objects, [], new Set());
    } catch {
      // Nothing more to undo
    }
    this._paused = true;
    this._host.toast('Rearrange hit a problem, so the original room is back');
  }

  private _emit(): void {
    for (const cb of this._listeners) cb();
  }
}
