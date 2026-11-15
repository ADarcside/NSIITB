/**
 * Namma Space: the published room layout (layout.json) and the three Rearrange modes
 * (view / visitor / admin), on the live K-720 grid and tags
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseLayout, layoutText, cleanBoxEdits } from '../../viewer/src/layout/layout_file.js';
import { applyBoxEdits, movableObjects, ADDED_BOX_ID } from '../../viewer/src/layout/objects.js';
import { buildFloorPlanWithMasks } from '../../viewer/src/nav/floorplan.js';
import { loadPrivate, saveMoves, type Move } from '../../viewer/src/layout/layout.js';
import { saveLayoutLive } from '../../viewer/src/nav/publish.js';
import type { NavGrid, PoiSet } from '../../viewer/src/contracts/types.js';

// The 3D side (Spark) is not part of these tests
vi.mock('../../viewer/src/layout/lift_scene.js', () => ({
  LiftedFurniture: class {
    sync(): void {}
    preview(): void {}
    clear(): void {}
    dispose(): void {}
  },
}));

const read = (p: string) => JSON.parse(readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8'));
const grid = read('../../sample/test-capture/scn_hostelroomac/grid.json') as NavGrid;
const pois = (read('../../sample/test-capture/pois.json') as PoiSet).pois;
const SCENE = 'scn_test';
const HASH = 'abcdef0123456789abcdef';

describe('layout.json', () => {
  it('round-trips, and is ignored for another scene or another scan', () => {
    const moves: Move[] = [{ id: 9, dx: -0.1, dz: -0.4, turnDeg: 15 }];
    const text = layoutText(SCENE, HASH, moves, [3, 2, 3], '2026-11-15T06:00:00Z');
    const ok = parseLayout(text, SCENE, HASH);
    expect(ok.warning).toBeUndefined();
    expect(ok.layout).toMatchObject({ moves, locked: [2, 3], updated_at: '2026-11-15T06:00:00Z' });
    expect(parseLayout(text, 'scn_other', HASH).layout).toBeNull();
    expect(parseLayout(text, SCENE, 'ffff').warning).toMatch(/another scan/);
    expect(parseLayout('<!doctype html>', SCENE, HASH).layout).toBeNull();
  });
});

async function controller(mode: 'view' | 'visitor' | 'admin', published?: { moves: Move[]; locked: number[]; updatedAt: string | null; boxes?: any[] }) {
  const THREE = await import('three');
  const { RearrangeController } = await import('../../viewer/src/layout/rearrange.js');
  const toasts: string[] = [];
  const rr = new RearrangeController({
    sceneId: SCENE,
    gridHash: HASH,
    grid,
    start: { x: 0.12, z: 0.132 },
    scene: new THREE.Scene(),
    getMesh: () => null,
    worldFromSplat: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    getPose: () => ({ x: 0.12, z: 0.132 }),
    getPois: () => pois,
    applyGrid: () => {},
    applyPois: () => {},
    applyPlanMoves: () => {},
    toast: m => toasts.push(m),
    mode,
    published,
  });
  rr.start();
  return { rr, toasts };
}

describe('Rearrange modes', () => {
  beforeEach(() => {
    try { localStorage.clear(); } catch { /* no storage in this runtime */ }
  });

  const pub = { moves: [{ id: 9, dx: -0.1, dz: -0.4, turnDeg: 15 }], locked: [5], updatedAt: '2026-11-15T06:00:00Z' };

  it('view: shows the published layout and edits nothing', async () => {
    const { rr } = await controller('view', pub);
    expect(rr.moves).toEqual(pub.moves);
    expect(rr.beginDrag(9)).toBe(false);
    rr.reset();
    expect(rr.moves).toEqual(pub.moves);
  });

  it('visitor: starts from the published layout, keeps private moves, resets to the published one', async () => {
    const { rr } = await controller('visitor', pub);
    expect(rr.moves).toEqual(pub.moves);
    expect(rr.isLocked(5)).toBe(true);
    expect(rr.beginDrag(5)).toBe(false);
    rr.turn(9, 15);
    expect(rr.moves[0].turnDeg).toBe(30);
    expect(loadPrivate(SCENE, HASH)).toEqual({ moves: rr.moves, base: pub.updatedAt });
    rr.reset();
    expect(rr.moves).toEqual(pub.moves);
    expect(loadPrivate(SCENE, HASH)).toBeNull();
  });

  it('visitor: private moves made on an older published layout are dropped with a note', async () => {
    saveMoves(SCENE, HASH, [{ id: 9, dx: 0, dz: -0.3, turnDeg: 0 }], '2026-11-01T00:00:00Z');
    const { rr, toasts } = await controller('visitor', pub);
    expect(rr.moves).toEqual(pub.moves);
    expect(toasts.join()).toMatch(/layout was updated/);
    expect(loadPrivate(SCENE, HASH)).toBeNull();
  });

  it('visitor: with no published layout it behaves as before (private only)', async () => {
    saveMoves(SCENE, HASH, [{ id: 9, dx: 0, dz: -0.3, turnDeg: 0 }]);
    const { rr } = await controller('visitor');
    expect(rr.moves).toEqual([{ id: 9, dx: 0, dz: -0.3, turnDeg: 0 }]);
    rr.reset();
    expect(rr.moves).toEqual([]);
  });

  it('admin: edits the published layout, locks pieces, stores nothing privately', async () => {
    const { rr } = await controller('admin', pub);
    expect(rr.dirty).toBe(false);
    expect(rr.beginDrag(5)).toBe(true); // admin may move a locked piece
    rr.cancelDrag();
    rr.toggleLock(5);
    expect(rr.isLocked(5)).toBe(false);
    expect(rr.dirty).toBe(true);
    rr.toggleLock(5);
    rr.reset(); // Original = the room as scanned
    expect(rr.moves).toEqual([]);
    expect(rr.dirty).toBe(true);
    expect(loadPrivate(SCENE, HASH)).toBeNull();
    expect(rr.unreachable()).toEqual([]);
    rr.markPublished('2026-11-15T07:00:00Z');
    expect(rr.dirty).toBe(false);
    expect(rr.baseUpdatedAt).toBe('2026-11-15T07:00:00Z');
  });

  it('paused (multiplayer) shows the published layout', async () => {
    const applied: number[] = [];
    const { rr } = await controller('visitor', pub);
    rr.turn(9, 15);
    (rr as unknown as { _host: { applyPlanMoves: (o: unknown, m: Move[]) => void } })._host.applyPlanMoves = (_o, m) => applied.push(m[0]?.turnDeg ?? 0);
    rr.setPaused(true);
    expect(applied.at(-1)).toBe(15);
  });
});

describe('Save layout for everyone', () => {
  it('commits layout.json next to the manifest and the source pois.json, and stops on a conflict', async () => {
    const writes: { url: string; body: any }[] = [];
    let liveLayout: string | null = null;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input).replace('https://api.github.com', '');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (method !== 'GET') writes.push({ url, body });
      if (url.includes('/contents/') && url.includes('layout.json')) {
        return liveLayout ? json({ content: Buffer.from(liveLayout).toString('base64'), encoding: 'base64' }) : json({ message: 'Not Found' }, 404);
      }
      if (url.includes('/contents/')) return json({ content: Buffer.from(JSON.stringify({ scene_id: SCENE })).toString('base64'), encoding: 'base64' });
      if (url.includes('/git/ref/heads/')) return json({ object: { sha: 'head1' } });
      if (url.includes('/git/commits/')) return json({ tree: { sha: 'tree1' } });
      if (url.endsWith('/git/trees')) return json({ sha: 'tree2' });
      if (url.endsWith('/git/commits')) return json({ sha: `commit-${writes.length}` });
      if (method === 'PATCH') return json({ object: { sha: body.sha } });
      return json({ message: 'unexpected' }, 500);
    }) as typeof fetch;
    const config = {
      live: { owner: 'o', repo: 'site', branch: 'main', path: `round2/${SCENE}` },
      source: { owner: 'o', repo: 'src', branch: 'round-2', path: 'sample/test-capture/pois.json' },
    };
    const layout = { sceneId: SCENE, gridHash: HASH, moves: [{ id: 9, dx: -0.1, dz: -0.4, turnDeg: 15 }], locked: [5] };
    const res = await saveLayoutLive(config, 'tok', layout, fetchImpl, { expectedBase: null });
    const trees = writes.filter(w => w.url.endsWith('/git/trees')).map(w => w.body.tree[0]);
    expect(trees.map(t => t.path)).toEqual([`round2/${SCENE}/layout.json`, 'sample/test-capture/layout.json']);
    expect(parseLayout(trees[0].content, SCENE, HASH).layout).toMatchObject({ moves: layout.moves, locked: [5], updated_at: res.updatedAt });
    expect(trees.some(t => t.path.endsWith('manifest.json'))).toBe(false);

    liveLayout = layoutText(SCENE, HASH, [], [], '2026-11-15T09:00:00Z');
    await expect(saveLayoutLive(config, 'tok', layout, fetchImpl, { expectedBase: res.updatedAt })).rejects.toMatchObject({ conflict: true });
  });
});

describe('Box tool (owner fixes furniture boxes)', () => {
  const built = buildFloorPlanWithMasks(grid)!;
  const auto = movableObjects(grid, built.plan, built.masks);
  const fixedOnly = built.plan.boxes.find(b => !auto.some(o => o.id === b.id)) ?? built.plan.boxes.find(b => b.id !== 9)!;

  it('fixes snap to cells, a fixed or added box is always movable, a removed one is gone', () => {
    const t = auto.find(o => o.id === 9)!;
    const edits = cleanBoxEdits([
      { id: 9, removed: true },
      { id: fixedOnly.id, minX: fixedOnly.minX + 0.013, minZ: fixedOnly.minZ, maxX: fixedOnly.maxX, maxZ: fixedOnly.maxZ },
      { id: ADDED_BOX_ID, minX: t.box.minX, minZ: t.box.minZ, maxX: t.box.maxX, maxZ: t.box.maxZ },
      { id: 'x' },
    ]);
    expect(edits).toHaveLength(3);
    const { plan, forced } = applyBoxEdits(grid, built.plan, edits);
    const objs = movableObjects(grid, plan, built.masks, forced);
    expect(objs.some(o => o.id === 9)).toBe(false);
    expect(objs.some(o => o.id === ADDED_BOX_ID)).toBe(true);
    expect(objs.some(o => o.id === fixedOnly.id)).toBe(true);
    const fx = plan.boxes.find(b => b.id === fixedOnly.id)!;
    const cells = (fx.minX - grid.origin[0]) / grid.cell_m;
    expect(Math.abs(cells - Math.round(cells))).toBeLessThan(1e-6);
  });

  it('round-trips in layout.json', () => {
    const boxes = [{ id: 9, removed: true as const }, { id: ADDED_BOX_ID, minX: 0, minZ: 0, maxX: 0.5, maxZ: 0.4 }];
    const p = parseLayout(layoutText(SCENE, HASH, [], [], 'u', boxes), SCENE, HASH).layout!;
    expect(p.boxes).toEqual(boxes);
    expect(parseLayout(layoutText(SCENE, HASH, [], [], 'u'), SCENE, HASH).layout!.boxes).toEqual([]);
  });

  it('admin: removing a moved box drops its move; visitors get the fixed boxes', async () => {
    const { rr } = await controller('admin', { moves: [{ id: 9, dx: -0.1, dz: -0.4, turnDeg: 15 }], locked: [9], updatedAt: 'u1' });
    rr.setBoxEdits([{ id: 9, removed: true }]);
    expect(rr.moves).toEqual([]);
    expect(rr.locked).toEqual([]);
    expect(rr.objects.some(o => o.id === 9)).toBe(false);
    expect(rr.dirty).toBe(true);
    rr.setBoxEdits([{ id: ADDED_BOX_ID, minX: -0.5, minZ: -0.5, maxX: 0, maxZ: 0 }]);
    expect(rr.objects.some(o => o.id === 9)).toBe(true);
    const v = await controller('visitor', { moves: [], locked: [], updatedAt: 'u2', boxes: [{ id: 9, removed: true }] });
    expect(v.rr.objects.some(o => o.id === 9)).toBe(false);
    v.rr.setBoxEdits([]); // visitors can't change boxes
    expect(v.rr.objects.some(o => o.id === 9)).toBe(false);
  });
});
