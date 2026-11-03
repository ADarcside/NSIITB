/**
 * Namma Space multiplayer: WebSocket connection to the relay.
 * Reconnects with backoff after a drop (Wi-Fi blip), re-sending hello as a joiner. Sends a
 * heartbeat when nothing else went out, so the relay does not drop a player who stands still.
 */

import {
  PROTOCOL_VERSION,
  HEARTBEAT_MS,
  type AvatarLook,
  type ClientMsg,
  type ServerMsg,
} from './protocol.js';

export type ConnState = 'connecting' | 'online' | 'offline' | 'closed';

export interface MpClientOptions {
  /** Relay base URL, e.g. wss://namma-mp.example.workers.dev */
  relayUrl: string;
  room: string;
  scene: string;
  cap: number;
  name: string;
  look: AvatarLook;
  /** true for the person who pressed Create room (first connect only) */
  create: boolean;
  onMessage: (m: ServerMsg) => void;
  onState: (s: ConnState, detail?: string) => void;
  /** WebSocket constructor (tests) */
  WebSocketImpl?: typeof WebSocket;
}

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
/** Errors that make retrying pointless */
const FATAL = new Set(['full', 'not_found', 'version', 'bad']);

export class MpClient {
  private readonly _opts: MpClientOptions;
  private _ws: WebSocket | null = null;
  private _attempt = 0;
  private _closed = false;
  private _welcomed = false;
  private _lastSend = 0;
  private _hbTimer: ReturnType<typeof setInterval> | null = null;
  private _retryTimer: ReturnType<typeof setTimeout> | null = null;
  private _create: boolean;
  private _wasEverWelcomed = false;
  private _look: AvatarLook;

  constructor(opts: MpClientOptions) {
    this._opts = opts;
    this._create = opts.create;
    this._look = opts.look;
  }

  get online(): boolean {
    return this._welcomed && this._ws?.readyState === 1;
  }

  connect(): void {
    if (this._closed) return;
    const WS = this._opts.WebSocketImpl ?? WebSocket;
    const base = this._opts.relayUrl.replace(/\/+$/, '');
    this._opts.onState('connecting');
    let ws: WebSocket;
    try {
      ws = new WS(`${base}/room/${this._opts.room}`);
    } catch (err) {
      this._scheduleRetry(String(err));
      return;
    }
    this._ws = ws;
    this._welcomed = false;
    ws.onopen = () => {
      this._rawSend({
        t: 'hello',
        v: PROTOCOL_VERSION,
        name: this._opts.name,
        look: this._look,
        scene: this._opts.scene,
        cap: this._opts.cap,
        create: this._create,
      });
    };
    ws.onmessage = ev => {
      let m: ServerMsg;
      try {
        m = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as ServerMsg;
      } catch {
        return;
      }
      if (m.t === 'welcome') {
        this._welcomed = true;
        this._attempt = 0;
        this._opts.onState('online');
      }
      if (m.t === 'error' && FATAL.has(m.code)) {
        if (m.code === 'not_found' && this._wasEverWelcomed) {
          // Everyone dropped at once and the room was forgotten: the relay closes this socket,
          // and the retry recreates the room with this player as its first member
          this._create = true;
          return;
        }
        this._closed = true;
        this._opts.onState('closed', m.code);
      }
      if (m.t === 'welcome') this._wasEverWelcomed = true;
      this._opts.onMessage(m);
    };
    ws.onclose = () => {
      this._welcomed = false;
      if (this._ws !== ws) return;
      this._ws = null;
      if (this._closed) return;
      this._scheduleRetry('connection lost');
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    if (!this._hbTimer) {
      this._hbTimer = setInterval(() => {
        if (this.online && performance.now() - this._lastSend > HEARTBEAT_MS - 500) this.send({ t: 'hb' });
      }, 1000);
    }
  }

  private _scheduleRetry(detail: string): void {
    if (this._closed) return;
    this._opts.onState('offline', detail);
    const wait = BACKOFF_MS[Math.min(this._attempt, BACKOFF_MS.length - 1)];
    this._attempt++;
    this._retryTimer = setTimeout(() => this.connect(), wait);
  }

  /** Sends when online; returns false if dropped */
  send(m: ClientMsg): boolean {
    if (!this.online) return false;
    if (m.t === 'look') this._look = m.look;
    return this._rawSend(m);
  }

  /** Keeps the look for the next hello even while offline */
  setLook(look: AvatarLook): void {
    this._look = look;
    this.send({ t: 'look', look });
  }

  private _rawSend(m: ClientMsg): boolean {
    const ws = this._ws;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(m));
    this._lastSend = performance.now();
    return true;
  }

  close(): void {
    this._closed = true;
    if (this._hbTimer) clearInterval(this._hbTimer);
    if (this._retryTimer) clearTimeout(this._retryTimer);
    this._ws?.close(1000, 'bye');
    this._ws = null;
    this._opts.onState('closed');
  }
}
