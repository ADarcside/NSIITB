import { describe, it, expect } from 'vitest';
import { parseRooms, roomHref, roomsUrl } from '../../viewer/src/ui/room_picker.js';

const ROOMS = [
  { scene_id: 'scn_hostelroomac', name: 'K-720', kind: 'Hostel room' },
  { scene_id: 'scn_hostelroom3f', name: 'Room 3' },
];

describe('room picker', () => {
  it('reads valid rooms and skips bad rows', () => {
    expect(parseRooms({ rooms: [...ROOMS, { scene_id: 'bad', name: 'x' }, { scene_id: 'scn_hostelroom3f', name: 'dup' }, { name: 'no id' }] }))
      .toEqual(ROOMS);
    expect(parseRooms(null)).toEqual([]);
    expect(roomsUrl('')).toBe('rooms.json');
    expect(roomsUrl('https://x/y/')).toBe('https://x/y/rooms.json');
  });

  it('keeps view options and drops links into the old room', () => {
    const href = roomHref('https://s/round2/?scene=scn_hostelroomac&tag=1&to=poi_aaaaaaaaaaaa&room=ABC123&quality=lite#x', 'scn_hostelroom3f');
    const u = new URL(href);
    expect(u.searchParams.get('scene')).toBe('scn_hostelroom3f');
    expect(u.searchParams.get('tag')).toBe('1');
    expect(u.searchParams.get('quality')).toBe('lite');
    expect(u.searchParams.has('to')).toBe(false);
    expect(u.searchParams.has('room')).toBe(false);
    expect(u.hash).toBe('');
  });
});
