/**
 * Namma Space relay: Cloudflare Worker entry + one Durable Object per room code.
 *   GET /room/<CODE>   (WebSocket upgrade)  -> that room's Durable Object
 *   GET /health                               -> "ok"
 * The viewer connects only when the page has ?room=CODE. Rooms keep nothing on disk.
 */

import { Room, type RelaySocket } from './room.js';
import { parseRoomCode } from '../../../viewer/src/net/protocol.js';

export interface Env {
  ROOMS: DurableObjectNamespace;
  /** Comma-separated list of page origins allowed to connect (empty = any) */
  ALLOWED_ORIGINS?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok');
    const m = url.pathname.match(/^\/room\/([^/]+)$/);
    if (!m) return new Response('Not found', { status: 404 });
    const code = parseRoomCode(m[1]);
    if (!code) return new Response('Bad room code', { status: 400 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') ?? '';
    // Local testing (vite dev on this machine) is always allowed
    const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    if (allowed.length > 0 && !local && !allowed.includes(origin)) return new Response('Origin not allowed', { status: 403 });
    const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
    return stub.fetch(request);
  },
};

export class RoomObject implements DurableObject {
  private readonly _room = new Room();
  private _sweepTimer: ReturnType<typeof setInterval> | null = null;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_state: DurableObjectState, _env: Env) {}

  async fetch(): Promise<Response> {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    const sock: RelaySocket = server;
    this._room.connect(sock);
    server.addEventListener('message', ev => {
      this._room.message(sock, typeof ev.data === 'string' ? ev.data : '');
    });
    const gone = () => {
      this._room.disconnect(sock);
      if (this._room.size === 0 && this._sweepTimer) {
        clearInterval(this._sweepTimer);
        this._sweepTimer = null;
      }
    };
    server.addEventListener('close', gone);
    server.addEventListener('error', gone);
    if (!this._sweepTimer) this._sweepTimer = setInterval(() => this._room.sweep(), 5000);
    return new Response(null, { status: 101, webSocket: client });
  }
}
