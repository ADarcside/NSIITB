import { describe, it, expect, beforeEach } from 'vitest';
import { Room, type RelaySocket } from '../src/room.js';
import { PROTOCOL_VERSION, IDLE_DROP_MS, type ServerMsg } from '../../../viewer/src/net/protocol.js';

class FakeSock implements RelaySocket {
  sent: ServerMsg[] = [];
  closed: { code?: number; reason?: string } | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data) as ServerMsg);
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }
  last() {
    return this.sent[this.sent.length - 1];
  }
}

const look = { char: 'kid', colors: ['#ff0000', '#00ff00', '#0000ff'] as [string, string, string], hat: 'none' };
const hello = (name: string, create: boolean, cap = 4, scene = 'scn_hostelroomac') =>
  JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, name, look, scene, cap, create });

let now = 0;
let room: Room;
const join = (name: string, create = false, cap = 4) => {
  const s = new FakeSock();
  room.connect(s);
  room.message(s, hello(name, create, cap));
  return s;
};

beforeEach(() => {
  now = 1000;
  room = new Room(() => now);
});

describe('relay room', () => {
  it('creator gets welcome with scene and cap; joiners see each other', () => {
    const a = join('Asha', true, 3);
    expect(a.last()).toMatchObject({ t: 'welcome', you: 'p1', scene: 'scn_hostelroomac', cap: 3, peers: [] });
    const b = join('Ravi');
    expect(b.last()).toMatchObject({ t: 'welcome', peers: [{ name: 'Asha' }] });
    expect(a.last()).toMatchObject({ t: 'join', peer: { name: 'Ravi' } });
    expect(room.size).toBe(2);
  });

  it('refuses joining a room nobody created', () => {
    const a = join('Asha', false);
    expect(a.last()).toMatchObject({ t: 'error', code: 'not_found' });
    expect(a.closed).not.toBeNull();
    expect(room.size).toBe(0);
  });

  it('enforces the cap: 3rd refused when cap is 2, 7th when cap is 6', () => {
    join('A', true, 2);
    join('B');
    const c = join('C');
    expect(c.last()).toMatchObject({ t: 'error', code: 'full' });
    expect(room.size).toBe(2);

    room = new Room(() => now);
    join('A', true, 6);
    for (const n of ['B', 'C', 'D', 'E', 'F']) join(n);
    expect(join('G').last()).toMatchObject({ t: 'error', code: 'full' });
  });

  it('clamps an absurd cap to 2..6', () => {
    const a = join('A', true, 50);
    expect(a.sent[0]).toMatchObject({ t: 'welcome', cap: 6 });
    room = new Room(() => now);
    const b = join('B', true, 0);
    expect(b.sent[0]).toMatchObject({ t: 'welcome', cap: 2 });
  });

  it('relays poses, looks and pings to others but not back', () => {
    const a = join('A', true);
    const b = join('B');
    room.message(a, JSON.stringify({ t: 's', p: [1, 1.5, 2, 0.5, 0] }));
    expect(b.last()).toEqual({ t: 's', id: 'p1', p: [1, 1.5, 2, 0.5, 0] });
    expect(a.last()).toMatchObject({ t: 'join' });
    room.message(b, JSON.stringify({ t: 'ping', x: 1, y: 0, z: 2, label: '<b>Desk</b>' }));
    expect(a.last()).toMatchObject({ t: 'ping', id: 'p2', label: 'bDesk/b' });
    // A late joiner gets the last known pose
    const c = join('C');
    expect(c.last()).toMatchObject({ t: 'welcome', peers: [{ id: 'p1', p: [1, 1.5, 2, 0.5, 0] }, { id: 'p2' }] });
  });

  it('relays body state (crouch, eye height) and gives it to late joiners', () => {
    const a = join('A', true);
    const b = join('B');
    room.message(a, JSON.stringify({ t: 's', p: [1, 1.0, 2, 0, 0], e: 1.0, f: 1 }));
    expect(b.last()).toEqual({ t: 's', id: 'p1', p: [1, 1.0, 2, 0, 0], e: 1, f: 1 });
    room.message(a, JSON.stringify({ t: 's', p: [1, 1.5, 2, 0, 0] }));
    expect(b.last()).toEqual({ t: 's', id: 'p1', p: [1, 1.5, 2, 0, 0] });
    room.message(a, JSON.stringify({ t: 's', p: [1, 0.85, 2, 0, 0], e: 0.85, f: 2 }));
    const c = join('C');
    expect(c.last()).toMatchObject({ t: 'welcome', peers: [{ id: 'p1', e: 0.85, f: 2 }, { id: 'p2' }] });
  });

  it('routes rtc only to the addressed player', () => {
    const a = join('A', true);
    const b = join('B');
    const c = join('C');
    const before = c.sent.length;
    room.message(a, JSON.stringify({ t: 'rtc', to: 'p2', data: { sdp: 'x' } }));
    expect(b.last()).toEqual({ t: 'rtc', from: 'p1', data: { sdp: 'x' } });
    expect(c.sent.length).toBe(before);
  });

  it('tells others when someone leaves, and forgets an empty room', () => {
    const a = join('A', true);
    const b = join('B');
    room.disconnect(a);
    expect(b.last()).toEqual({ t: 'left', id: 'p1' });
    room.disconnect(b);
    expect(room.scene).toBeNull();
    expect(join('C', false).last()).toMatchObject({ t: 'error', code: 'not_found' });
  });

  it('gives each player a free colour slot, reused after leaving', () => {
    const a = join('A', true);
    join('B');
    room.disconnect(a);
    const c = join('C');
    expect(c.sent[0]).toMatchObject({ t: 'welcome', slot: 0 });
  });

  it('drops a silent socket after the idle timeout', () => {
    const a = join('A', true);
    const b = join('B');
    now += IDLE_DROP_MS - 1000;
    room.message(a, JSON.stringify({ t: 'hb' }));
    now += 2000;
    expect(room.sweep()).toBe(1);
    expect(b.closed).toMatchObject({ code: 4000 });
    expect(a.last()).toEqual({ t: 'left', id: 'p2' });
  });

  it('drops a socket that floods messages', () => {
    const a = join('A', true);
    for (let i = 0; i < 60; i++) room.message(a, JSON.stringify({ t: 'hb' }));
    expect(a.last()).toMatchObject({ t: 'error', code: 'rate' });
    expect(room.size).toBe(0);
  });

  it('rejects garbage and wrong versions', () => {
    const s = new FakeSock();
    room.connect(s);
    room.message(s, 'not json');
    expect(s.last()).toMatchObject({ t: 'error', code: 'bad' });
    const v = new FakeSock();
    room.connect(v);
    room.message(v, JSON.stringify({ t: 'hello', v: 99, name: 'x', look, scene: 's', cap: 4, create: true }));
    expect(v.last()).toMatchObject({ t: 'error', code: 'version' });
  });
});
