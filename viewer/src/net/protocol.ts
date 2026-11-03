/**
 * Namma Space multiplayer: wire protocol shared by the viewer and the relay (multiplayer/relay).
 * Small JSON messages over one WebSocket per player. The relay keeps nothing on disk.
 *
 * Client -> relay:
 *   hello   join or create a room (first message on a socket)
 *   s       my pose [x, y, z, yaw, pitch], about 10 a second while moving
 *   hb      keep-alive when standing still
 *   look    my avatar changed (character, colours, hat)
 *   ping    point at a spot so everyone sees a marker
 *   rtc     voice-chat setup data for one other player (WebRTC offer/answer/ICE)
 * Relay -> client:
 *   welcome you are in: your id, the room's scene and cap, who is already here
 *   join / left / s / look / ping / rtc   another player's event
 *   error   full, not_found, bad, rate
 */

export const PROTOCOL_VERSION = 1;

/** Room size bounds the relay enforces whatever a client asks for */
export const MIN_ROOM_CAP = 2;
export const MAX_ROOM_CAP = 6;
export const MAX_NAME_LEN = 20;
/** Messages per second one socket may send before the relay drops it */
export const RATE_LIMIT_PER_S = 40;
/** A socket that sends nothing for this long is dropped */
export const IDLE_DROP_MS = 15_000;
export const HEARTBEAT_MS = 5_000;

/** Unambiguous code alphabet: no 0/O, 1/I/L */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LEN = 6;

export type Pose5 = [x: number, y: number, z: number, yaw: number, pitch: number];

export interface AvatarLook {
  /** Character id from the catalogue, or a drop-in file name */
  char: string;
  /** Main, second and accent colours as #rrggbb */
  colors: [string, string, string];
  /** Hat / accessory id, or 'none' */
  hat: string;
}

/**
 * Body state flags sent with each pose (Walk mode moves):
 * bits 0-1 stance (0 stand, 1 crouch, 2 slide), bit 2 in the air, bit 3 climbing.
 */
export const STANCE_MASK = 0b11;
export const STANCE_CROUCH = 1;
export const STANCE_SLIDE = 2;
export const FLAG_AIR = 0b100;
export const FLAG_CLIMB = 0b1000;

/** Extra body state with a pose: e = eye height above the feet (m), f = flags above */
export interface BodyState {
  e?: number;
  f?: number;
}

export interface PeerInfo extends BodyState {
  id: string;
  name: string;
  look: AvatarLook;
  /** Colour index 0..5 for name tag, path and markers */
  slot: number;
  p?: Pose5;
}

export type ClientMsg =
  | { t: 'hello'; v: number; name: string; look: AvatarLook; scene: string; cap: number; create: boolean }
  | ({ t: 's'; p: Pose5 } & BodyState)
  | { t: 'hb' }
  | { t: 'look'; look: AvatarLook }
  | { t: 'ping'; x: number; y: number; z: number; label?: string }
  | { t: 'rtc'; to: string; data: unknown };

export type ErrorCode = 'full' | 'not_found' | 'bad' | 'rate' | 'version';

export type ServerMsg =
  | { t: 'welcome'; you: string; slot: number; scene: string; cap: number; peers: PeerInfo[] }
  | { t: 'join'; peer: PeerInfo }
  | { t: 'left'; id: string }
  | ({ t: 's'; id: string; p: Pose5 } & BodyState)
  | { t: 'look'; id: string; look: AvatarLook }
  | { t: 'ping'; id: string; x: number; y: number; z: number; label?: string }
  | { t: 'rtc'; from: string; data: unknown }
  | { t: 'error'; code: ErrorCode; message?: string };

// ---------------------------------------------------------------------------------------------
// Validation (the relay trusts nobody's JSON shape, the viewer trusts the relay)
// ---------------------------------------------------------------------------------------------

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const HEX = /^#[0-9a-fA-F]{6}$/;
const ID_LIKE = /^[A-Za-z0-9_.-]{1,40}$/;

/** Strips tags and control characters and trims a display name; empty -> 'Guest' */
export function cleanName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : '';
  // eslint-disable-next-line no-control-regex
  const out = s.replace(/[<>&"'`]/g, '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return out.slice(0, MAX_NAME_LEN) || 'Guest';
}

export function isPose5(v: unknown): v is Pose5 {
  return Array.isArray(v) && v.length === 5 && v.every(isNum) && v.every(n => Math.abs(n) < 1e4);
}

export function isAvatarLook(v: unknown): v is AvatarLook {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    isStr(o.char, 40) &&
    ID_LIKE.test(o.char) &&
    Array.isArray(o.colors) &&
    o.colors.length === 3 &&
    o.colors.every(c => typeof c === 'string' && HEX.test(c)) &&
    isStr(o.hat, 40) &&
    ID_LIKE.test(o.hat)
  );
}

export function clampCap(cap: unknown): number {
  const n = isNum(cap) ? Math.round(cap) : 4;
  return Math.max(MIN_ROOM_CAP, Math.min(MAX_ROOM_CAP, n));
}

/** Parses and checks one client message; null if malformed. Size-limits rtc payloads. */
export function parseClientMsg(raw: string): ClientMsg | null {
  if (raw.length > 16_000) return null;
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  switch (o.t) {
    case 'hello':
      if (!isNum(o.v) || !isAvatarLook(o.look) || !isStr(o.scene, 80) || !ID_LIKE.test(o.scene as string)) return null;
      return {
        t: 'hello',
        v: o.v,
        name: cleanName(o.name),
        look: o.look,
        scene: o.scene as string,
        cap: clampCap(o.cap),
        create: o.create === true,
      };
    case 's': {
      if (!isPose5(o.p)) return null;
      const out: ClientMsg = { t: 's', p: o.p };
      // Optional body state; anything odd is dropped rather than rejecting the pose
      if (isNum(o.e) && o.e >= 0.2 && o.e <= 3) out.e = Math.round(o.e * 1000) / 1000;
      if (isNum(o.f) && Number.isInteger(o.f) && o.f >= 0 && o.f <= 15) out.f = o.f;
      return out;
    }
    case 'hb':
      return { t: 'hb' };
    case 'look':
      return isAvatarLook(o.look) ? { t: 'look', look: o.look } : null;
    case 'ping':
      if (![o.x, o.y, o.z].every(isNum)) return null;
      return {
        t: 'ping',
        x: o.x as number,
        y: o.y as number,
        z: o.z as number,
        label: typeof o.label === 'string' ? cleanName(o.label).slice(0, 40) : undefined,
      };
    case 'rtc':
      return typeof o.to === 'string' && ID_LIKE.test(o.to) && o.data !== undefined ? { t: 'rtc', to: o.to, data: o.data } : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Room codes
// ---------------------------------------------------------------------------------------------

/** New random room code (crypto random), e.g. 'K7QX2M' */
export function newRoomCode(rand: (n: number) => Uint8Array = n => crypto.getRandomValues(new Uint8Array(n))): string {
  const bytes = rand(ROOM_CODE_LEN * 2);
  let out = '';
  for (let i = 0; out.length < ROOM_CODE_LEN && i < bytes.length; i++) {
    // Rejection sampling keeps every letter equally likely
    if (bytes[i] < 248) out += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
  }
  while (out.length < ROOM_CODE_LEN) out += ROOM_CODE_ALPHABET[0];
  return out;
}

/** Normalises user input ('k7q-x2m ' -> 'K7QX2M'); null if not a valid code */
export function parseRoomCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.toUpperCase().replace(/[\s-]/g, '');
  if (s.length !== ROOM_CODE_LEN) return null;
  for (const ch of s) if (!ROOM_CODE_ALPHABET.includes(ch)) return null;
  return s;
}

/** 'K7QX2M' -> 'K7Q-X2M' */
export function formatRoomCode(code: string): string {
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}
