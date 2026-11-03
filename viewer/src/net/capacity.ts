/**
 * Namma Space multiplayer: how many people a scene's room allows.
 * Rule (from the project owner): K-720's walkable floor area divided by 4 is the space one person
 * gets. Any other scene allows (its walkable area / that space) people, at least 2 and at most 6.
 */

import type { NavGrid } from '../contracts/types.js';
import { MIN_ROOM_CAP, MAX_ROOM_CAP } from './protocol.js';
import { decodeBase64ToBytes } from '../collision/grid.js';

/**
 * Walkable floor area of the K-720 scene (scn_hostelroomac) in square metres, measured from its
 * published grid.json with walkableAreaM2() (2141 free cells of 5 cm, 3 Nov 2026). null would give
 * every scene DEFAULT_CAP.
 */
export const K720_WALKABLE_M2: number | null = 5.3525;
export const K720_PEOPLE = 4;
export const DEFAULT_CAP = 4;

/** Walkable floor area of a nav grid in square metres (free cells x cell area) */
export function walkableAreaM2(grid: NavGrid): number {
  const bytes = decodeBase64ToBytes(grid.free_bits_b64);
  const cells = grid.width * grid.height;
  let free = 0;
  for (let i = 0; i < cells; i++) {
    if ((bytes[i >> 3] ?? 0) & (0x80 >> (i & 7))) free++;
  }
  return free * grid.cell_m * grid.cell_m;
}

/** Room cap for a scene with this much walkable area (null = no grid) */
export function roomCapForArea(areaM2: number | null, k720AreaM2: number | null = K720_WALKABLE_M2): number {
  if (areaM2 === null || !k720AreaM2 || k720AreaM2 <= 0) return DEFAULT_CAP;
  const perPerson = k720AreaM2 / K720_PEOPLE;
  const n = Math.floor(areaM2 / perPerson + 1e-6);
  return Math.max(MIN_ROOM_CAP, Math.min(MAX_ROOM_CAP, n));
}
