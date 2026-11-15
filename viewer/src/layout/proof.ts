/**
 * Namma Space: Rearrange phase 0 proof (dev builds only, ?rearrange=proof)
 *
 * Throwaway harness that proves the Spark parts on the real scene before any UI is built:
 * lift every movable box out of the scan (hide by a box edit attached to the scan only, copy into
 * a second splat object), slide and turn a copy, and patch the walkable grid. Driven from the
 * browser console or a Playwright script through window.__rearrange.
 */

import * as THREE from 'three';
import { PackedSplats, SplatEdit, SplatEditSdf, SplatEditSdfType, SplatEditRgbaBlendMode, SplatMesh } from '@sparkjsdev/spark';
import type { NavGrid } from '../contracts/types.js';
import { buildFloorPlanWithMasks } from '../nav/floorplan.js';
import { movableObjects, type MovableObject } from './objects.js';
import { selectSplats, buildCopy, fitWalls, type PackedSource } from './lift.js';
import { patchGrid, unpackBits, type Move } from './regrid.js';
import { buildFloorFills, buildWallFills, type BuiltFill } from './lift_scene.js';
import { floorRaster, FILL_TUNING } from './fill.js';

export interface ProofDeps {
  scene: THREE.Scene;
  getMesh: () => SplatMesh | null;
  getGrid: () => NavGrid | null;
  worldFromSplat: ArrayLike<number>;
}

interface Lifted {
  obj: MovableObject;
  pivot: THREE.Group;
  mesh: SplatMesh;
  sdf: SplatEditSdf;
  hidden: number;
  copied: number;
}

export function mountRearrangeProof(deps: ProofDeps): void {
  let lifted: Lifted[] = [];
  let edit: SplatEdit | null = null;
  let objects: MovableObject[] = [];
  const moves = new Map<number, Move>();
  let outlines: THREE.LineSegments[] = [];
  let fills: BuiltFill[] = [];

  const clear = (): void => {
    const mesh = deps.getMesh();
    if (mesh && edit) mesh.edits = (mesh.edits ?? []).filter(e => e !== edit);
    for (const l of lifted) {
      deps.scene.remove(l.pivot);
      l.mesh.dispose();
    }
    lifted = [];
    for (const f of fills) {
      deps.scene.remove(f.group);
      for (const m of f.meshes) m.dispose();
    }
    fills = [];
    edit = null;
    moves.clear();
  };

  const placePivot = (l: Lifted, m: Move | undefined): void => {
    const cx = (l.obj.lift.minX + l.obj.lift.maxX) / 2;
    const cz = (l.obj.lift.minZ + l.obj.lift.maxZ) / 2;
    l.pivot.position.set(cx + (m?.dx ?? 0), 0, cz + (m?.dz ?? 0));
    l.pivot.rotation.set(0, ((m?.turnDeg ?? 0) * Math.PI) / 180, 0);
    l.pivot.updateMatrixWorld(true);
  };

  /** Lifts the given objects (default: every movable one). withSh = copy angle-dependent colour too */
  const lift = (opts: { withSh?: boolean; ids?: number[]; fill?: boolean; pad?: number; yLo?: number; yHi?: number } = {}) => {
    clear();
    const mesh = deps.getMesh();
    const grid = deps.getGrid();
    const packed = mesh?.packedSplats;
    if (!mesh || !grid || !packed?.packedArray) throw new Error('scene or grid not loaded');
    const built = buildFloorPlanWithMasks(grid);
    if (!built) throw new Error('no floor plan');
    objects = movableObjects(grid, built.plan, built.masks);
    const chosen = opts.ids ? objects.filter(o => opts.ids!.includes(o.id)) : objects;
    const t0 = performance.now();
    const src: PackedSource = {
      packedArray: packed.packedArray,
      numSplats: packed.numSplats,
      extra: packed.extra,
      splatEncoding: packed.splatEncoding,
    };
    const fits = fitWalls(src, deps.worldFromSplat, chosen);
    const reach = fits.map(f => f.reach);
    const sel = selectSplats(src, deps.worldFromSplat, chosen.map((o, b) => ({ ...reach[b], y0: o.y0, y1: o.y1 })));
    mesh.updateMatrixWorld();
    const built2 = opts.fill
      ? buildFloorFills(src, { grid, floor: built.masks.floor }, floorRaster(src, deps.worldFromSplat, grid), reach, objects.map(o => o.reach))
      : chosen.map(() => null);
    for (const f of built2) if (f) {
      deps.scene.add(f.group);
      fills.push(f);
      console.log('[Rearrange] fill', JSON.stringify({ tiles: f.plan?.tiles, scale: f.plan?.scale, clean: f.plan?.clean }));
    }
    const walls = opts.fill ? buildWallFills(src, deps.worldFromSplat, chosen.map((o, b) => ({ obj: o, ...fits[b] }))) : null;
    if (walls?.meshes.length) {
      deps.scene.add(walls.group);
      fills.push({ plan: null, group: walls.group, meshes: walls.meshes });
      console.log('[Rearrange] walls', JSON.stringify(fits.map(f => f.walls)));
    }
    const t1 = performance.now();

    // Hide: one edit on the scan only (never global, so copies and fill stay visible), hard edge
    edit = new SplatEdit({ rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY, softEdge: 0, sdfSmooth: 0 });
    const sdfs: SplatEditSdf[] = [];
    const meshMatrix = mesh.matrixWorld.clone();
    for (const h of walls?.hide ?? []) {
      const sdf = new SplatEditSdf({ type: SplatEditSdfType.BOX, opacity: 0, color: new THREE.Color(1, 1, 1) });
      sdf.position.set((h.minX + h.maxX) / 2, (h.y0 + h.y1) / 2, (h.minZ + h.maxZ) / 2);
      sdf.scale.set((h.maxX - h.minX) / 2, (h.y1 - h.y0) / 2, (h.maxZ - h.minZ) / 2);
      sdf.updateMatrixWorld();
      sdfs.push(sdf);
    }
    chosen.forEach((o, b) => {
      const sdf = new SplatEditSdf({ type: SplatEditSdfType.BOX, opacity: 0, color: new THREE.Color(1, 1, 1) });
      const R = reach[b];
      // Dev probes: pad / yLo / yHi widen the hide only (to find what is left at the old spot)
      const y0 = opts.yLo ?? (built2[b] ? FILL_TUNING.hideLo : o.y0);
      const y1 = opts.yHi ?? o.y1;
      const pad = opts.pad ?? 0;
      sdf.position.set((R.minX + R.maxX) / 2, (y0 + y1) / 2, (R.minZ + R.maxZ) / 2);
      sdf.scale.set((R.maxX - R.minX) / 2 + pad, (y1 - y0) / 2, (R.maxZ - R.minZ) / 2 + pad);
      sdf.updateMatrixWorld();
      sdfs.push(sdf);

      const data = buildCopy(src, sel.copied[b], opts.withSh ?? false);
      const copy = new SplatMesh({
        packedSplats: new PackedSplats({
          packedArray: data.packedArray,
          numSplats: data.numSplats,
          extra: data.extra,
          splatEncoding: data.splatEncoding,
        }),
        editable: false,
      });
      // Same splat-to-world transform as the scan, inside a pivot at the box centre on the floor
      const inner = new THREE.Group();
      const cx = (o.lift.minX + o.lift.maxX) / 2;
      const cz = (o.lift.minZ + o.lift.maxZ) / 2;
      inner.position.set(-cx, 0, -cz);
      meshMatrix.decompose(copy.position, copy.quaternion, copy.scale);
      inner.add(copy);
      const pivot = new THREE.Group();
      pivot.add(inner);
      deps.scene.add(pivot);
      const l: Lifted = { obj: o, pivot, mesh: copy, sdf, hidden: sel.hidden[b], copied: data.numSplats };
      placePivot(l, undefined);
      lifted.push(l);
    });
    edit.sdfs = sdfs;
    mesh.edits = [...(mesh.edits ?? []), edit];
    const t2 = performance.now();
    return {
      splats: packed.numSplats,
      sh: packed.getNumSh(),
      objects: chosen.length,
      selectMs: Math.round(t1 - t0),
      buildMs: Math.round(t2 - t1),
      totalMs: Math.round(t2 - t0),
      reach: chosen.map((o, b) => ({ id: o.id, ...reach[b] })),
      encoding: packed.splatEncoding,
      perObject: lifted.map(l => ({ id: l.obj.id, hidden: l.hidden, copied: l.copied })),
    };
  };

  /** Slides and turns one lifted object (from its original spot), and patches the grid */
  const move = (id: number, dx: number, dz: number, turnDeg = 0) => {
    const l = lifted.find(x => x.obj.id === id);
    if (!l) throw new Error(`object ${id} is not lifted`);
    const m: Move = { id, dx, dz, turnDeg };
    moves.set(id, m);
    placePivot(l, m);
    return gridCheck();
  };

  /** Patched grid vs published: identical with no moves, else changed cells all near a footprint */
  const gridCheck = () => {
    const grid = deps.getGrid();
    if (!grid) throw new Error('grid not loaded');
    const t0 = performance.now();
    const r = patchGrid(grid, objects, [...moves.values()]);
    const ms = performance.now() - t0;
    const n = grid.width * grid.height;
    const a = unpackBits(grid.free_bits_b64, n), b = unpackBits(r.grid.free_bits_b64, n);
    let changed = 0, outside = 0, freed = 0, blocked = 0;
    for (let i = 0; i < n; i++) {
      if (a[i] === b[i]) continue;
      changed++;
      if (!r.region[i]) outside++;
      if (b[i]) freed++; else blocked++;
    }
    return {
      identical: r.grid.free_bits_b64 === grid.free_bits_b64 && r.grid.layers?.occupied_bits_b64 === grid.layers?.occupied_bits_b64,
      changed, outsidePatch: outside, freed, blocked, ms: Math.round(ms),
    };
  };

  /** Wire boxes on the floor around every movable object (green) */
  const showBoxes = (on: boolean): void => {
    for (const line of outlines) line.parent?.remove(line);
    outlines = [];
    if (!on) return;
    for (const l of lifted) {
      const o = l.obj;
      const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(o.lift.maxX - o.lift.minX, o.y1 - o.y0, o.lift.maxZ - o.lift.minZ));
      const line = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x33ff66 }));
      line.position.set(0, (o.y0 + o.y1) / 2, 0);
      l.pivot.add(line);
      outlines.push(line);
    }
  };

  (window as unknown as { __rearrange: unknown }).__rearrange = {
    lift,
    move,
    gridCheck,
    clear,
    showBoxes,
    objects: () => objects,
    hideOnly: (on: boolean) => { for (const l of lifted) l.pivot.visible = !on; },
  };
  console.info('[Rearrange proof] ready: window.__rearrange');
}
