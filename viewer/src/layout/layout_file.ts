/**
 * Namma Space: the published room layout file (layout.json next to the scene's manifest.json).
 * Tiny and dependency-free, so the viewer's main bundle and the Save code can read and write it
 * without loading the Rearrange code.
 */

import type { Move } from './regrid.js';

/** The owner's fix to one furniture box (saved in layout.json): a new outline, or not furniture */
export type BoxEdit =
  | { id: number; minX: number; minZ: number; maxX: number; maxZ: number; removed?: undefined }
  | { id: number; removed: true };

/** Ids of boxes the owner added start here (the detected ones are small numbers) */
export const ADDED_BOX_ID = 1000;

/** Cleans box edits read from a file (unknown shapes dropped, one edit per id) */
export function cleanBoxEdits(list: unknown): BoxEdit[] {
  if (!Array.isArray(list)) return [];
  const byId = new Map<number, BoxEdit>();
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    if (!Number.isInteger(r.id)) continue;
    const id = r.id as number;
    if (r.removed === true) byId.set(id, { id, removed: true });
    else if (['minX', 'minZ', 'maxX', 'maxZ'].every(k => Number.isFinite(r[k]))) {
      const mm = (k: string) => Math.round((r[k] as number) * 1000) / 1000;
      byId.set(id, { id, minX: mm('minX'), minZ: mm('minZ'), maxX: mm('maxX'), maxZ: mm('maxZ') });
    }
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}


export const LAYOUT_SCHEMA = 'namma-layout/1';

export interface PublishedLayout {
  schema: typeof LAYOUT_SCHEMA;
  scene_id: string;
  /** sha256 of the grid.json it was made on: a new scan ignores an old layout */
  grid_sha256: string;
  updated_at: string;
  moves: Move[];
  /** Pieces visitors can't move (the owner locked them) */
  locked: number[];
  /** The owner's fixes to the detected furniture boxes (optional) */
  boxes?: BoxEdit[];
}

/**
 * layout.json text -> the layout, or null with the reason when it can't be used here (wrong
 * scene, made on another scan, or not a layout file at all). A missing file is simply no layout.
 */
export function parseLayout(text: string, sceneId: string, gridHash: string): { layout: PublishedLayout | null; warning?: string } {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { layout: null, warning: 'layout.json is not JSON' };
  }
  if (!data || data.schema !== LAYOUT_SCHEMA) return { layout: null, warning: 'layout.json has an unknown schema' };
  if (data.scene_id !== sceneId) return { layout: null, warning: `layout.json is for ${String(data.scene_id)}, not ${sceneId}` };
  if (data.grid_sha256 !== gridHash) return { layout: null, warning: 'layout.json was made on another scan of this room, so it is ignored' };
  const moves = Array.isArray(data.moves) ? cleanMoveList(data.moves) : [];
  const locked = Array.isArray(data.locked) ? data.locked.filter((n): n is number => Number.isInteger(n)) : [];
  return {
    layout: {
      schema: LAYOUT_SCHEMA,
      scene_id: sceneId,
      grid_sha256: gridHash,
      updated_at: typeof data.updated_at === 'string' ? data.updated_at : '',
      moves,
      locked: [...new Set(locked)].sort((a, b) => a - b),
      boxes: cleanBoxEdits(data.boxes),
    },
  };
}

/** layout.json text as Save writes it */
export function layoutText(sceneId: string, gridHash: string, moves: Move[], locked: number[], updatedAt: string, boxes: BoxEdit[] = []): string {
  const layout: PublishedLayout = {
    schema: LAYOUT_SCHEMA,
    scene_id: sceneId,
    grid_sha256: gridHash,
    updated_at: updatedAt,
    moves,
    locked: [...new Set(locked)].sort((a, b) => a - b),
    ...(boxes.length ? { boxes: cleanBoxEdits(boxes) } : {}),
  };
  return JSON.stringify(layout, null, 2) + '\n';
}

export function cleanMoveList(list: unknown[]): Move[] {
  return list
    .filter((m): m is Move => !!m && typeof m === 'object' &&
      ['id', 'dx', 'dz', 'turnDeg'].every(k => Number.isFinite((m as Record<string, unknown>)[k])))
    .map(m => ({ id: m.id, dx: m.dx, dz: m.dz, turnDeg: m.turnDeg }));
}
