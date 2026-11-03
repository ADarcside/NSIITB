/**
 * Namma Space relay: one room's logic, independent of Cloudflare so it can be unit tested.
 * Holds the connected players, enforces the cap, rate limit and idle drop, and rebroadcasts.
 * Nothing is written anywhere; when the last player leaves the room is empty and forgets its scene.
 */

import {
  PROTOCOL_VERSION,
  RATE_LIMIT_PER_S,
  IDLE_DROP_MS,
  MAX_ROOM_CAP,
  parseClientMsg,
  type ServerMsg,
  type PeerInfo,
  type Pose5,
  type ErrorCode,
} from '../../../viewer/src/net/protocol.js';

export interface RelaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface Player {
  id: string;
  sock: RelaySocket;
  info: PeerInfo | null; // null until hello
  lastSeen: number;
  windowStart: number;
  windowCount: number;
}

export class Room {
  private readonly _players = new Map<RelaySocket, Player>();
  private _scene: string | null = null;
  private _cap = 0;
  private _nextId = 1;
  private readonly _now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this._now = now;
  }

  get size(): number {
    let n = 0;
    for (const p of this._players.values()) if (p.info) n++;
    return n;
  }

  get scene(): string | null {
    return this._scene;
  }

  get cap(): number {
    return this._cap;
  }

  connect(sock: RelaySocket): void {
    const t = this._now();
    this._players.set(sock, {
      id: `p${this._nextId++}`,
      sock,
      info: null,
      lastSeen: t,
      windowStart: t,
      windowCount: 0,
    });
  }

  disconnect(sock: RelaySocket): void {
    const p = this._players.get(sock);
    if (!p) return;
    this._players.delete(sock);
    if (p.info) this._broadcast({ t: 'left', id: p.id }, p);
    if (this.size === 0) {
      // Empty room: forget everything, a new creator starts fresh
      this._scene = null;
      this._cap = 0;
    }
  }

  message(sock: RelaySocket, raw: string): void {
    const p = this._players.get(sock);
    if (!p) return;
    const t = this._now();
    p.lastSeen = t;
    if (t - p.windowStart >= 1000) {
      p.windowStart = t;
      p.windowCount = 0;
    }
    if (++p.windowCount > RATE_LIMIT_PER_S) {
      this._reject(p, 'rate', 'Too many messages');
      return;
    }
    const m = parseClientMsg(raw);
    if (!m) {
      if (!p.info) this._reject(p, 'bad', 'Bad first message');
      return; // ignore a malformed message from a joined player
    }
    if (!p.info) {
      if (m.t !== 'hello') return this._reject(p, 'bad', 'Say hello first');
      if (m.v !== PROTOCOL_VERSION) return this._reject(p, 'version', 'Please reload the page');
      if (this.size === 0) {
        if (!m.create) return this._reject(p, 'not_found', 'This room is closed or the link is wrong');
        this._scene = m.scene;
        this._cap = Math.min(m.cap, MAX_ROOM_CAP);
      } else if (this.size >= this._cap) {
        return this._reject(p, 'full', `This room is full (${this._cap} people)`);
      }
      const slot = this._freeSlot();
      p.info = { id: p.id, name: m.name, look: m.look, slot };
      const peers = [...this._players.values()].filter(o => o.info && o !== p).map(o => o.info!);
      this._send(p, { t: 'welcome', you: p.id, slot, scene: this._scene!, cap: this._cap, peers });
      this._broadcast({ t: 'join', peer: p.info }, p);
      return;
    }
    switch (m.t) {
      case 'hello':
        return;
      case 'hb':
        return;
      case 's': {
        p.info.p = m.p as Pose5;
        p.info.e = m.e;
        p.info.f = m.f;
        const out: ServerMsg = { t: 's', id: p.id, p: m.p };
        if (m.e !== undefined) out.e = m.e;
        if (m.f !== undefined) out.f = m.f;
        return this._broadcast(out, p);
      }
      case 'look':
        p.info.look = m.look;
        return this._broadcast({ t: 'look', id: p.id, look: m.look }, p);
      case 'ping':
        return this._broadcast({ t: 'ping', id: p.id, x: m.x, y: m.y, z: m.z, label: m.label }, p);
      case 'rtc': {
        const to = [...this._players.values()].find(o => o.info && o.id === m.to);
        if (to) this._send(to, { t: 'rtc', from: p.id, data: m.data });
        return;
      }
    }
  }

  /** Drops sockets silent for IDLE_DROP_MS; call every few seconds. Returns how many were dropped. */
  sweep(): number {
    const t = this._now();
    let n = 0;
    for (const p of [...this._players.values()]) {
      if (t - p.lastSeen > IDLE_DROP_MS) {
        n++;
        try {
          p.sock.close(4000, 'idle');
        } catch {
          /* already closed */
        }
        this.disconnect(p.sock);
      }
    }
    return n;
  }

  private _freeSlot(): number {
    const used = new Set([...this._players.values()].filter(o => o.info).map(o => o.info!.slot));
    for (let i = 0; i < MAX_ROOM_CAP; i++) if (!used.has(i)) return i;
    return 0;
  }

  private _reject(p: Player, code: ErrorCode, message: string): void {
    this._send(p, { t: 'error', code, message });
    try {
      p.sock.close(4001, code);
    } catch {
      /* already closed */
    }
    this.disconnect(p.sock);
  }

  private _send(p: Player, msg: ServerMsg): void {
    try {
      p.sock.send(JSON.stringify(msg));
    } catch {
      /* closing */
    }
  }

  private _broadcast(msg: ServerMsg, except: Player): void {
    const data = JSON.stringify(msg);
    for (const o of this._players.values()) {
      if (o === except || !o.info) continue;
      try {
        o.sock.send(data);
      } catch {
        /* closing */
      }
    }
  }
}
