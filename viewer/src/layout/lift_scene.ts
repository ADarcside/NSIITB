/**
 * Namma Space: lifted furniture in the 3D scene (Rearrange)
 *
 * Keeps the scan's hide edit and the lifted copies in step with a layout. Only moved objects (and
 * the one being dragged) are lifted; one pass over the scan lifts all of them. The hide is a
 * hard-edged box edit attached to the scan only (mesh.edits), so it never touches the copies or a
 * fill. On sides against the outer wall it reaches to just in front of the wall surface, so a
 * bunk's wall end goes too. Copies carry the angle-dependent colour (the user's pick, method B). When the scan is
 * swapped (Lite and HD), sync() notices and lifts again from the new scan.
 */

import * as THREE from 'three';
import { PackedSplats, setPackedSplat, SplatEdit, SplatEditSdf, SplatEditSdfType, SplatEditRgbaBlendMode, SplatMesh } from '@sparkjsdev/spark';
import { boxMinus, type MovableObject } from './objects.js';
import { selectSplats, buildCopy, fitWalls, type FloorBox, type PackedSource, type WallFront } from './lift.js';
import type { Move } from './regrid.js';
import type { NavGrid } from '../contracts/types.js';
import { floorRaster, planFloorFill, synthFloor, floorShade, synthWall, wallStripFor, wallHideBox, FILL_TUNING, type FloorRaster, type FillPlan } from './fill.js';

/** What the floor fill needs to know about the room */
export interface FillContext {
  grid: NavGrid;
  /** 1 = inside the room (floor plan masks.floor) */
  floor: Uint8Array;
}

export interface BuiltFill {
  /** The floor plan, or null for a wall fill */
  plan: FillPlan | null;
  group: THREE.Group;
  meshes: SplatMesh[];
}

/**
 * Floor fills for the holes: a made floor (regular grid of flat splats) coloured from the planned
 * clean source, piece by piece, and colour-matched. Holes with no usable source get no fill (and keep their
 * floor, so the floor is never hidden without something in its place).
 */
export function buildFloorFills(
  src: PackedSource,
  ctx: FillContext,
  raster: FloorRaster,
  holes: FloorBox[],
  avoid: FloorBox[]
): (BuiltFill | null)[] {
  const plans = planFloorFill(ctx.grid, ctx.floor, raster, holes, avoid);
  const shade = floorShade(ctx.grid, ctx.floor, holes);
  return plans.map(plan => {
    if (!plan) return null;
    const made = synthFloor(raster, src.packedArray, plan, setPackedSplat, shade);
    const mesh = new SplatMesh({
      packedSplats: new PackedSplats({ packedArray: made.packed, numSplats: made.count }),
      editable: false,
    });
    const group = new THREE.Group();
    group.add(mesh);
    group.updateMatrixWorld(true);
    return { plan, group, meshes: [mesh] };
  });
}

/**
 * Wall fills: for each outer wall found behind a lifted object, a made wall over the strip the
 * object hid (floor to its top), plus the box that hides the scanned wall there.
 */
export function buildWallFills(
  src: PackedSource,
  worldFromSplat: ArrayLike<number>,
  items: { obj: MovableObject; reach: FloorBox; walls: WallFront[] }[]
): { group: THREE.Group; meshes: SplatMesh[]; hide: { minX: number; maxX: number; minZ: number; maxZ: number; y0: number; y1: number }[] } {
  const group = new THREE.Group();
  const meshes: SplatMesh[] = [];
  const hide: { minX: number; maxX: number; minZ: number; maxZ: number; y0: number; y1: number }[] = [];
  for (const it of items) {
    for (const w of it.walls) {
      const strip = wallStripFor(it.reach, w.side, w.front, it.obj.y1);
      const made = synthWall(src, worldFromSplat, strip, setPackedSplat);
      const mesh = new SplatMesh({ packedSplats: new PackedSplats({ packedArray: made.packed, numSplats: made.count }), editable: false });
      group.add(mesh);
      meshes.push(mesh);
      hide.push(wallHideBox(made.strip, it.reach[w.side]));
    }
  }
  group.updateMatrixWorld(true);
  return { group, meshes, hide };
}

interface Lifted {
  obj: MovableObject;
  pivot: THREE.Group;
  mesh: SplatMesh;
}

export class LiftedFurniture {
  private _lifted = new Map<number, Lifted>();
  private _edit: SplatEdit | null = null;
  private _from: SplatMesh | null = null;
  private _key = '';
  /** Reach boxes fitted to the walls of one scan (a Lite / HD swap fits again) */
  private _fit = new Map<number, { reach: FloorBox; walls: WallFront[] }>();
  private _fitFrom: SplatMesh | null = null;
  private _raster: FloorRaster | null = null;
  private _fills: BuiltFill[] = [];

  constructor(
    private readonly _scene: THREE.Scene,
    private readonly _getMesh: () => SplatMesh | null,
    private readonly _worldFromSplat: ArrayLike<number>,
    private readonly _objects: MovableObject[],
    private readonly _fillCtx: FillContext | null = null
  ) {}

  /**
   * Shows the layout: lifts the objects in `ids` (moved plus the one being dragged), places each
   * at its move. Cheap when the lifted set and the scan are unchanged (only the pivots move).
   */
  sync(moves: Move[], extraIds: number[] = []): void {
    const mesh = this._getMesh();
    const ids = [...new Set([...moves.map(m => m.id), ...extraIds])].sort((a, b) => a - b);
    const key = ids.join(',');
    if (mesh !== this._from || key !== this._key) this._relift(mesh, ids);
    const byId = new Map(moves.map(m => [m.id, m]));
    for (const l of this._lifted.values()) this._place(l, byId.get(l.obj.id));
  }

  /** Moves one lifted copy without touching the layout (live drag preview) */
  preview(move: Move): void {
    const l = this._lifted.get(move.id);
    if (l) this._place(l, move);
  }

  get liftedIds(): number[] {
    return [...this._lifted.keys()];
  }

  /** Puts everything back: the scan as scanned, no copies */
  clear(): void {
    if (this._from && this._edit) this._from.edits = (this._from.edits ?? []).filter(e => e !== this._edit);
    for (const l of this._lifted.values()) {
      this._scene.remove(l.pivot);
      l.mesh.dispose();
    }
    this._lifted.clear();
    for (const f of this._fills) {
      this._scene.remove(f.group);
      for (const m of f.meshes) m.dispose();
    }
    this._fills = [];
    this._edit = null;
    this._from = null;
    this._key = '';
  }

  dispose(): void {
    this.clear();
  }

  private _relift(mesh: SplatMesh | null, ids: number[]): void {
    this.clear();
    const packed = mesh?.packedSplats;
    if (!mesh || !packed?.packedArray || !ids.length) {
      this._from = mesh;
      this._key = ids.join(',');
      return;
    }
    const chosen = this._objects.filter(o => ids.includes(o.id));
    const src: PackedSource = {
      packedArray: packed.packedArray,
      numSplats: packed.numSplats,
      extra: packed.extra,
      splatEncoding: packed.splatEncoding,
    };
    if (this._fitFrom !== mesh) {
      this._fit.clear();
      this._raster = null;
      this._fitFrom = mesh;
    }
    const unfitted = chosen.filter(o => !this._fit.has(o.id));
    if (unfitted.length) {
      const fits = fitWalls(src, this._worldFromSplat, unfitted);
      unfitted.forEach((o, k) => this._fit.set(o.id, fits[k]));
    }
    const reach = chosen.map(o => this._fit.get(o.id)!.reach);
    // Each object's boxes: its own reach without the pieces that belong to a neighbour, plus the
    // pieces of it that run into a neighbour's box (a table top under a bunk's end)
    const parts = chosen.map((o, b) => [...boxMinus({ ...reach[b], y0: o.y0, y1: o.y1 }, o.cut), ...o.extra]);
    const flat = parts.flat();
    const owner = parts.flatMap((p, b) => p.map(() => b));
    const flatSel = selectSplats(src, this._worldFromSplat, flat);
    const copied = chosen.map((_, b) => {
      const lists = flatSel.copied.filter((_, k) => owner[k] === b);
      const out = new Uint32Array(lists.reduce((t, l) => t + l.length, 0));
      let at = 0;
      for (const l of lists) { out.set(l, at); at += l.length; }
      return out.sort();
    });
    const edit = new SplatEdit({ rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY, softEdge: 0, sdfSmooth: 0 });
    const sdfs: SplatEditSdf[] = [];
    mesh.updateMatrixWorld();
    const meshMatrix = mesh.matrixWorld.clone();
    // Floor fills first: where one exists, the hide reaches down through the floor as well
    let fills: (BuiltFill | null)[] = chosen.map(() => null);
    if (this._fillCtx) {
      this._raster ??= floorRaster(src, this._worldFromSplat, this._fillCtx.grid);
      const avoid = this._objects.map(o => this._fit.get(o.id)?.reach ?? o.reach);
      fills = buildFloorFills(src, this._fillCtx, this._raster, reach, avoid);
      for (const f of fills) if (f) {
        this._scene.add(f.group);
        this._fills.push(f);
      }
      // The wall each object stood against, where one was found
      const walls = buildWallFills(src, this._worldFromSplat, chosen.map(o => ({ obj: o, ...this._fit.get(o.id)! })));
      if (walls.meshes.length) {
        this._scene.add(walls.group);
        this._fills.push({ plan: null, group: walls.group, meshes: walls.meshes });
        for (const h of walls.hide) {
          const sdf = new SplatEditSdf({ type: SplatEditSdfType.BOX, opacity: 0, color: new THREE.Color(1, 1, 1) });
          sdf.position.set((h.minX + h.maxX) / 2, (h.y0 + h.y1) / 2, (h.minZ + h.maxZ) / 2);
          sdf.scale.set((h.maxX - h.minX) / 2, (h.y1 - h.y0) / 2, (h.maxZ - h.minZ) / 2);
          sdf.updateMatrixWorld();
          sdfs.push(sdf);
        }
      }
    }
    chosen.forEach((o, b) => {
      const y0 = fills[b] ? FILL_TUNING.hideLo : o.y0;
      for (const R of [...boxMinus({ ...reach[b], y0, y1: o.y1 }, o.cut), ...o.extra]) {
        const sdf = new SplatEditSdf({ type: SplatEditSdfType.BOX, opacity: 0, color: new THREE.Color(1, 1, 1) });
        sdf.position.set((R.minX + R.maxX) / 2, (R.y0 + R.y1) / 2, (R.minZ + R.maxZ) / 2);
        sdf.scale.set((R.maxX - R.minX) / 2, (R.y1 - R.y0) / 2, (R.maxZ - R.minZ) / 2);
        sdf.updateMatrixWorld();
        sdfs.push(sdf);
      }

      const data = buildCopy(src, copied[b], true);
      const copy = new SplatMesh({
        packedSplats: new PackedSplats({
          packedArray: data.packedArray,
          numSplats: data.numSplats,
          extra: data.extra,
          splatEncoding: data.splatEncoding,
        }),
        editable: false,
      });
      const inner = new THREE.Group();
      inner.position.set(-(o.lift.minX + o.lift.maxX) / 2, 0, -(o.lift.minZ + o.lift.maxZ) / 2);
      meshMatrix.decompose(copy.position, copy.quaternion, copy.scale);
      inner.add(copy);
      const pivot = new THREE.Group();
      pivot.add(inner);
      this._scene.add(pivot);
      this._lifted.set(o.id, { obj: o, pivot, mesh: copy });
    });
    edit.sdfs = sdfs;
    mesh.edits = [...(mesh.edits ?? []), edit];
    this._edit = edit;
    this._from = mesh;
    this._key = ids.join(',');
  }

  private _place(l: Lifted, m: Move | undefined): void {
    const cx = (l.obj.lift.minX + l.obj.lift.maxX) / 2;
    const cz = (l.obj.lift.minZ + l.obj.lift.maxZ) / 2;
    l.pivot.position.set(cx + (m?.dx ?? 0), 0, cz + (m?.dz ?? 0));
    l.pivot.rotation.set(0, ((m?.turnDeg ?? 0) * Math.PI) / 180, 0);
    l.pivot.updateMatrixWorld(true);
  }
}
