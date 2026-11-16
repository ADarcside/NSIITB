/**
 * Namma Space AR: floor marks (the tape crosses) in the tag data.
 *
 * A mark is an ordinary tag named "Mark 1A", "Mark 1B", "Mark 2A"... (any category; the spec's
 * `anchor` category also counts). Tag mode's category list is left unchanged, so the name is what
 * marks a tag. The normal viewer hides marks from search, labels, the place list and the minimap;
 * tag mode still shows them so they can be moved.
 */

import type { POI } from '../contracts/types.js';

const MARK_NAME = /^mark\s*(\d+)\s*([ab])$/i;

/** True for a floor-mark tag (by name, or the `anchor` category). */
export function isFloorMark(poi: POI): boolean {
  return poi.category === 'anchor' || MARK_NAME.test(poi.name.trim());
}

/** The places a visitor sees: every tag except floor marks. */
export function visiblePlaces(pois: POI[]): POI[] {
  return pois.some(isFloorMark) ? pois.filter(p => !isFloorMark(p)) : pois;
}

export interface MarkPair {
  /** Pair number: 1 for Mark 1A + Mark 1B */
  n: number;
  /** Labels shown to the person, e.g. "1A" and "1B" */
  labelA: string;
  labelB: string;
  /** Scene floor positions (x, z in metres) */
  a: { x: number; z: number };
  b: { x: number; z: number };
  /** Distance between the two marks in the scene (m) */
  distanceM: number;
}

export interface MarkScan {
  pairs: MarkPair[];
  /** Plain-language problems with the mark tags (a missing partner, a duplicate name) */
  problems: string[];
}

/** Finds the mark tags and pairs them by number, lowest number first. */
export function findMarkPairs(pois: POI[]): MarkScan {
  const byNumber = new Map<number, { a: POI[]; b: POI[] }>();
  for (const p of pois) {
    const m = MARK_NAME.exec(p.name.trim());
    if (!m) continue;
    const n = Number(m[1]);
    const slot = byNumber.get(n) ?? { a: [], b: [] };
    (m[2].toLowerCase() === 'a' ? slot.a : slot.b).push(p);
    byNumber.set(n, slot);
  }
  const pairs: MarkPair[] = [];
  const problems: string[] = [];
  for (const n of [...byNumber.keys()].sort((x, y) => x - y)) {
    const { a, b } = byNumber.get(n)!;
    if (a.length > 1) problems.push(`More than one tag is named Mark ${n}A`);
    if (b.length > 1) problems.push(`More than one tag is named Mark ${n}B`);
    if (a.length === 0) problems.push(`Mark ${n}B has no Mark ${n}A`);
    if (b.length === 0) problems.push(`Mark ${n}A has no Mark ${n}B`);
    if (a.length !== 1 || b.length !== 1) continue;
    const pa = { x: a[0].position.x, z: a[0].position.z };
    const pb = { x: b[0].position.x, z: b[0].position.z };
    const distanceM = Math.hypot(pb.x - pa.x, pb.z - pa.z);
    if (distanceM < 0.5) {
      problems.push(`Mark ${n}A and Mark ${n}B are only ${distanceM.toFixed(2)} m apart (use 2 m)`);
      continue;
    }
    pairs.push({ n, labelA: `${n}A`, labelB: `${n}B`, a: pa, b: pb, distanceM });
  }
  return { pairs, problems };
}

/**
 * Marks from a link, for testing before the crosses are tagged:
 *   ?marks=ax,az,bx,bz   (scene metres)  -> pair 1
 */
export function marksFromParam(value: string | null): MarkPair | null {
  if (!value) return null;
  const nums = value.split(',').map(s => Number(s.trim()));
  if (nums.length !== 4 || nums.some(v => !Number.isFinite(v))) return null;
  const [ax, az, bx, bz] = nums;
  const distanceM = Math.hypot(bx - ax, bz - az);
  if (distanceM < 0.5) return null;
  return { n: 1, labelA: '1A', labelB: '1B', a: { x: ax, z: az }, b: { x: bx, z: bz }, distanceM };
}
