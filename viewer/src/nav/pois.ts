/**
 * Namma Space: points of interest (Round 2)
 * One pois.json per scene (PoiSet), listed in the manifest as a `pois` asset like the grid.
 * Tag mode keeps a local draft in the browser and exports the file for pipeline/pois.py to attach.
 */

import type { Id, POI, PoiSet } from '../contracts/types.js';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** New random id with the given prefix, e.g. newId('poi') -> 'poi_k3m...'. */
export function newId(prefix: string): Id {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, b => BASE32[b & 31]).join('')}`;
}

/** Farthest an editor may stand from a tag for that spot to become the tag's standing spot (m) */
export const APPROACH_MAX_M = 4.0;

/** Where routes to this place end: its standing spot when it has one, else the tag itself. */
export function poiGoal(poi: POI): { x: number; z: number } {
  return poi.approach ?? { x: poi.position.x, z: poi.position.z };
}

/**
 * Standing spot for a tag put at `spot` by an editor standing at `stand`, or undefined when the
 * tag needs none (it sits on walkable floor) or the editor is not a usable reference (off the floor
 * or too far away, e.g. dragging a dot on the minimap from across the room).
 */
export function approachFor(
  spot: { x: number; z: number },
  stand: { x: number; z: number },
  isWalkable: (x: number, z: number) => boolean
): { x: number; z: number } | undefined {
  if (isWalkable(spot.x, spot.z)) return undefined;
  if (!isWalkable(stand.x, stand.z)) return undefined;
  if (Math.hypot(stand.x - spot.x, stand.z - spot.z) > APPROACH_MAX_M) return undefined;
  return { x: round(stand.x), z: round(stand.z) };
}

/** Default label height above the floor for a POI dropped where the walker stands. */
export const LABEL_HEIGHT_M = 1.2;

export const POI_CATEGORIES = ['room', 'exit', 'sleep', 'study', 'storage', 'utility', 'facility', 'furniture', 'decor', 'item', 'other'] as const;

export function makePoi(sceneId: Id, name: string, x: number, z: number, opts: Partial<POI> = {}): POI {
  return {
    schema_version: 1,
    poi_id: newId('poi'),
    scene_id: sceneId,
    name: name.trim(),
    category: opts.category ?? 'other',
    ...(opts.aliases && opts.aliases.length ? { aliases: opts.aliases } : {}),
    ...(opts.description ? { description: opts.description } : {}),
    position: { x: round(x), y: opts.position?.y ?? LABEL_HEIGHT_M, z: round(z) },
    ...(opts.yaw_deg !== undefined ? { yaw_deg: Math.round(opts.yaw_deg) } : {}),
  };
}

export function makePoiSet(sceneId: Id, pois: POI[]): PoiSet {
  return {
    schema_version: 1,
    scene_id: sceneId,
    updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    pois,
  };
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Problems with a parsed pois.json (empty when valid). Mirrors pipeline/schemas/pois.schema.json. */
export function validatePoiSet(data: unknown): string[] {
  const errs: string[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isObj(data)) return ['pois.json must be an object'];
  if (data.schema_version !== 1) errs.push('schema_version must be 1');
  if (typeof data.scene_id !== 'string' || !/^scn_[a-z2-7]{12}$/.test(data.scene_id)) errs.push('scene_id must be a scene id');
  if (!Array.isArray(data.pois)) return [...errs, 'pois must be an array'];
  const seen = new Set<string>();
  data.pois.forEach((p, k) => {
    const at = `pois[${k}]`;
    if (!isObj(p)) {
      errs.push(`${at} must be an object`);
      return;
    }
    if (typeof p.poi_id !== 'string' || !/^poi_[a-z2-7]{12}$/.test(p.poi_id)) errs.push(`${at}.poi_id must be a poi id`);
    else if (seen.has(p.poi_id)) errs.push(`${at}.poi_id is repeated`);
    else seen.add(p.poi_id);
    if (typeof p.name !== 'string' || !p.name.trim()) errs.push(`${at}.name must be a non-empty string`);
    const pos = p.position;
    if (!isObj(pos) || !['x', 'y', 'z'].every(c => typeof pos[c] === 'number' && Number.isFinite(pos[c]))) {
      errs.push(`${at}.position must have numeric x, y, z`);
    }
    const ap = p.approach;
    if (ap !== undefined && !(isObj(ap) && ['x', 'z'].every(c => typeof ap[c] === 'number' && Number.isFinite(ap[c])))) {
      errs.push(`${at}.approach must have numeric x, z`);
    }
    if (p.aliases !== undefined && !(Array.isArray(p.aliases) && p.aliases.every(a => typeof a === 'string'))) {
      errs.push(`${at}.aliases must be a list of strings`);
    }
  });
  return errs;
}

/** Same places with the same content (order included), e.g. a draft that matches the live tags */
export function samePois(a: POI[], b: POI[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Local draft of tag mode, per scene, so a page reload doesn't lose tags before export.
 * It also remembers which live pois.json it was edited from (`base`, its updated_at), so tag mode
 * can tell when the live tags moved on since and never let an old draft wipe them silently.
 */
export class PoiDraftStore {
  /** updated_at of the live pois.json this draft started from; null = there was none; undefined = unknown */
  base: string | null | undefined = undefined;

  constructor(private readonly _sceneId: Id) {}

  private get _key(): string {
    return `namma-pois-draft:${this._sceneId}`;
  }

  load(): POI[] | null {
    try {
      const raw = localStorage.getItem(this._key);
      if (!raw) return null;
      const set = JSON.parse(raw) as PoiSet;
      return validatePoiSet(set).length === 0 ? set.pois : null;
    } catch {
      return null;
    }
  }

  /** Base of the stored draft (see `base`), undefined for none or for drafts saved before bases existed */
  loadBase(): string | null | undefined {
    try {
      const raw = localStorage.getItem(this._key);
      if (!raw) return undefined;
      const b = (JSON.parse(raw) as { base_updated_at?: unknown }).base_updated_at;
      return typeof b === 'string' || b === null ? b : undefined;
    } catch {
      return undefined;
    }
  }

  save(pois: POI[]): void {
    try {
      const draft: PoiSet & { base_updated_at?: string | null } = makePoiSet(this._sceneId, pois);
      if (this.base !== undefined) draft.base_updated_at = this.base;
      localStorage.setItem(this._key, JSON.stringify(draft));
    } catch {
      // Private mode or storage full: tags still live in the page until export
    }
  }

  clear(): void {
    try {
      localStorage.removeItem(this._key);
    } catch {
      // ignore
    }
  }
}

/** Ask the browser to save the POIs as pois.json. */
export function downloadPoiSet(sceneId: Id, pois: POI[]): void {
  const blob = new Blob([JSON.stringify(makePoiSet(sceneId, pois), null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'pois.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
