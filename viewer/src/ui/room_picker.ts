/**
 * Namma Space: room picker. A small dropdown under the search box that switches between the rooms
 * published on this site. The list comes from rooms.json next to the scene folders:
 *
 *   { "schema_version": 1, "rooms": [ { "scene_id": "scn_…", "name": "K-720", "kind": "Hostel room" }, … ] }
 *
 * Picking a room reloads the page on ?scene=<id>, keeping view options (tag mode, quality, move) and
 * dropping links that belong to the old room (place links, multiplayer room code). No rooms.json, or
 * fewer than two rooms, means no picker.
 */

import ROOM_PICKER_CSS from './room_picker.css?raw';

export interface RoomEntry {
  scene_id: string;
  name: string;
  kind?: string;
}

/** URL parameters that point into one room and must not follow the visitor to another */
const ROOM_BOUND_PARAMS = ['to', 'from', 'room', 'pois'];

export function roomsUrl(baseUrl: string): string {
  const clean = baseUrl.replace(/\/+$/, '');
  return clean ? `${clean}/rooms.json` : 'rooms.json';
}

/** Valid room entries of a rooms.json document (bad rows are skipped, never thrown). */
export function parseRooms(doc: unknown): RoomEntry[] {
  const rows = (doc as { rooms?: unknown })?.rooms;
  if (!Array.isArray(rows)) return [];
  const out: RoomEntry[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const id = (r as RoomEntry)?.scene_id;
    const name = (r as RoomEntry)?.name;
    if (typeof id !== 'string' || !/^scn_[a-z2-7]{12}$/.test(id) || seen.has(id)) continue;
    if (typeof name !== 'string' || !name.trim()) continue;
    seen.add(id);
    const kind = (r as RoomEntry).kind;
    out.push({ scene_id: id, name: name.trim(), ...(typeof kind === 'string' ? { kind } : {}) });
  }
  return out;
}

export async function loadRooms(baseUrl: string): Promise<RoomEntry[]> {
  try {
    const res = await fetch(roomsUrl(baseUrl), { cache: 'no-cache' });
    if (!res.ok) return [];
    return parseRooms(await res.json());
  } catch {
    return [];
  }
}

/** The page URL for another room: same page and view options, new ?scene=, room-bound links dropped. */
export function roomHref(current: string, sceneId: string): string {
  const url = new URL(current);
  for (const k of ROOM_BOUND_PARAMS) url.searchParams.delete(k);
  url.searchParams.set('scene', sceneId);
  url.hash = '';
  return url.toString();
}

/**
 * Mounts the picker when there are at least two rooms. currentScene is the scene this page loaded; when it
 * is not in the list (a test scene), the picker is still shown with that room on top.
 */
export function mountRoomPicker(rooms: RoomEntry[], currentScene: string,
                                go: (href: string) => void = href => window.location.assign(href)): HTMLElement | null {
  if (rooms.length < 2 && !(rooms.length === 1 && rooms[0].scene_id !== currentScene)) return null;
  if (!document.getElementById('room-picker-style')) {
    const style = document.createElement('style');
    style.id = 'room-picker-style';
    style.textContent = ROOM_PICKER_CSS;
    document.head.appendChild(style);
  }
  const wrap = document.createElement('label');
  wrap.className = 'room-picker hud-group';
  wrap.title = 'Switch room';
  const key = document.createElement('span');
  key.className = 'hud-chip-k room-picker-k';
  key.textContent = 'Room';
  const select = document.createElement('select');
  select.className = 'room-picker-select';
  select.setAttribute('aria-label', 'Switch room');
  const list = rooms.some(r => r.scene_id === currentScene)
    ? rooms
    : [{ scene_id: currentScene, name: currentScene.replace(/^scn_/, '') }, ...rooms];
  for (const r of list) {
    const opt = document.createElement('option');
    opt.value = r.scene_id;
    opt.textContent = r.name;
    if (r.kind) opt.title = r.kind;
    select.append(opt);
  }
  select.value = currentScene;
  select.addEventListener('change', () => {
    if (select.value && select.value !== currentScene) go(roomHref(window.location.href, select.value));
  });
  // Keys typed into the dropdown must not walk the camera
  select.addEventListener('keydown', e => e.stopPropagation());
  wrap.append(key, select);
  document.body.append(wrap);
  return wrap;
}
