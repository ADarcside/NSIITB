/**
 * Namma Space multiplayer: ties the relay client, remote avatars, voice chat and the room UI to
 * the viewer. main.ts calls startMultiplayer() only on the multiplayer build (VITE_MP_URL) or with
 * ?room= / ?mpdemo=1, so the normal viewer is unchanged.
 */

import * as THREE from 'three';
import type { NavGrid, POI, SceneManifest } from '../contracts/types.js';
import type { NavPlanner } from '../nav/astar.js';
import type { Pose3D } from '../types.js';
import { MpClient, type ConnState } from './client.js';
import { PoseSender } from './interp.js';
import { VoiceChat } from './voice.js';
import { roomCapForArea, walkableAreaM2 } from './capacity.js';
import { newRoomCode, parseRoomCode, type AvatarLook, type BodyState, type Pose5, type ServerMsg } from './protocol.js';
import { PeerManager } from '../avatars/peers.js';
import { listCharacters, defaultLook } from '../avatars/catalog.js';
import { MpUI, type RosterEntry } from '../ui/mp_ui.js';
import { startDemoPeers } from './demo.js';

export interface MpContext {
  scene: THREE.Scene;
  camera: THREE.Camera;
  manifest: SceneManifest;
  /** The ?scene= value this page loaded (the scene's folder); links and rooms use it */
  sceneKey: string;
  getPose: () => Pose3D;
  /** Body state for other players: eye height above the feet and stance flags (protocol.ts) */
  getBody?: () => BodyState;
  setPose: (p: Partial<Pose3D>) => void;
  getPlanner: () => NavPlanner | null;
  getGrid: () => NavGrid | null;
  getPois: () => POI[];
  /** Draws the Round 2 path to a target and shows the route card (Take me there works) */
  routeTo: (target: POI) => void;
  /** POI id the route currently goes to, or null */
  getRouteTargetId: () => string | null;
}

export interface MpHandle {
  update: (dt: number) => void;
  /** Round 2 page: opens the lobby again after the player went back to exploring alone */
  open?: () => void;
}

export interface MpOptions {
  /**
   * Round 2 page: multiplayer was opened from the "Play with friends" button. Close in the lobby and
   * Leave in a room go back to exploring alone instead of showing the lobby again.
   */
  embedded?: boolean;
  /** Called with true when the lobby or a room opens, false when the player is back to exploring alone */
  onActiveChange?: (active: boolean) => void;
}

const NAME_KEY = 'namma.mp.name';
const LOOK_KEY = 'namma.mp.look';
const FRIEND_PREFIX = 'mp_friend_';

function load<T>(key: string, fallback: T): T {
  try {
    const v = window.localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, v: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* private mode */
  }
}

function relayUrl(params: URLSearchParams): string | null {
  const fromUrl = params.get('relay');
  if (fromUrl && /^wss?:\/\//.test(fromUrl)) return fromUrl;
  const env = import.meta.env.VITE_MP_URL as string | undefined;
  if (env) return env;
  return import.meta.env.DEV ? 'ws://127.0.0.1:8787' : null;
}

export function startMultiplayer(
  ctx: MpContext,
  params = new URLSearchParams(window.location.search),
  opts: MpOptions = {}
): MpHandle | null {
  const eye = ctx.manifest.eye_height_m;
  const peers = new PeerManager(ctx.scene, eye);
  const b = ctx.manifest.bounds;
  peers.clampPose = p => {
    // Glitchy or stale packets: keep avatars inside the room's footprint
    const x = Math.min(b.maxX, Math.max(b.minX, p[0]));
    const z = Math.min(b.maxZ, Math.max(b.minZ, p[2]));
    return x === p[0] && z === p[2] ? p : [x, p[1], z, p[3], p[4]];
  };

  // Dev builds only: lets test scripts add fake players
  if (import.meta.env.DEV) (window as unknown as { __mpPeers?: PeerManager }).__mpPeers = peers;

  if (params.get('mpdemo') === '1') {
    const demo = startDemoPeers(peers, ctx.manifest);
    return { update: dt => demo.update(dt) };
  }

  const url = relayUrl(params);
  if (!url) {
    console.warn('[Multiplayer] No relay URL (VITE_MP_URL); multiplayer is off');
    return null;
  }

  const characters = listCharacters();
  let name: string = load(NAME_KEY, '');
  let look: AvatarLook = load<AvatarLook | null>(LOOK_KEY, null) ?? defaultLook(characters);
  if (!characters.some(c => c.id === look.char)) look = defaultLook(characters);

  let joinCode = parseRoomCode(params.get('room'));
  let roomCode: string | null = null;
  let client: MpClient | null = null;
  let myId: string | null = null;
  let mySlot = 0;
  let cap = 0;
  let spawned = false;
  let mySpeaking = false;
  const speaking = new Set<string>();
  const sender = new PoseSender();
  let voiceTimer = 0;
  // "Take me to a friend": a moving target that the Round 2 route follows
  let follow: { id: string; poi: POI; lastPlan: { x: number; z: number }; lastAt: number } | null = null;

  const voice = new VoiceChat({
    signal: (to, data) => client?.send({ t: 'rtc', to, data }),
    onSpeaking: (id, on) => {
      if (id === 'me') mySpeaking = on;
      else {
        if (on) speaking.add(id);
        else speaking.delete(id);
        peers.peers.get(id)?.avatar.setSpeaking(on);
      }
      refreshRoster();
    },
  });

  if (import.meta.env.DEV) (window as unknown as { __mpVoice?: VoiceChat }).__mpVoice = voice;

  const ui = new MpUI({
    characters,
    initialName: name,
    initialLook: look,
    joinCode,
    onEnter: r => void enter(r.name, r.look),
    onLookChange: l => {
      look = l;
      save(LOOK_KEY, l);
      client?.setLook(l);
    },
    onNameChange: n => {
      // Names travel only in hello: a rename shows for others after the next reconnect or rejoin
      name = n;
      save(NAME_KEY, n);
    },
    onCopyInvite: () => void copyInvite(),
    onToggleMic: () => ui.setMic(voice.setMuted(!voice.muted)),
    onPoint: () => point(),
    onGoTo: id => goTo(id),
    onLeave: () => leave(),
    closable: opts.embedded,
    onClose: () => backToSolo(),
  });
  opts.onActiveChange?.(true);

  function backToSolo(): void {
    joinCode = null;
    ui.setJoinCode(null);
    const u = new URL(window.location.href);
    u.searchParams.delete('room');
    window.history.replaceState(null, '', u.toString());
    opts.onActiveChange?.(false);
  }

  function inviteLink(code: string): string {
    const u = new URL(window.location.href);
    u.search = '';
    u.searchParams.set('room', code);
    u.searchParams.set('scene', ctx.sceneKey);
    return u.toString();
  }

  async function copyInvite(): Promise<void> {
    if (!roomCode) return;
    const link = inviteLink(roomCode);
    try {
      await navigator.clipboard.writeText(link);
      ui.toast('Invite link copied. Send it to your friends.');
    } catch {
      window.prompt('Copy this invite link:', link);
    }
  }

  async function waitForGrid(ms: number): Promise<NavGrid | null> {
    const end = performance.now() + ms;
    while (!ctx.getGrid() && performance.now() < end) await new Promise(r => setTimeout(r, 100));
    return ctx.getGrid();
  }

  async function enter(n: string, l: AvatarLook): Promise<void> {
    name = n;
    look = l;
    save(NAME_KEY, n);
    save(LOOK_KEY, l);
    const create = joinCode === null;
    roomCode = roomCode ?? joinCode ?? newRoomCode();
    const u = new URL(window.location.href);
    u.searchParams.set('room', roomCode);
    u.searchParams.set('scene', ctx.sceneKey);
    window.history.replaceState(null, '', u.toString());
    ui.enterRoom(roomCode);
    ui.setStatus('Connecting');
    // Mic first, inside the click (browsers want a user gesture)
    // Joining does not wait for the mic: calls pick it up once the browser grants it
    void voice.start().then(state => {
      ui.setMic(state);
      if (state === 'denied') ui.toast('Microphone blocked: you can still listen. Allow it in the address bar and reload to talk.', true, 6000);
    });
    ui.setMic('off');
    const grid = create ? await waitForGrid(3000) : null;
    cap = roomCapForArea(grid ? walkableAreaM2(grid) : null);
    client = new MpClient({
      relayUrl: url!,
      room: roomCode,
      scene: ctx.sceneKey,
      cap,
      name,
      look,
      create,
      onMessage,
      onState,
    });
    client.connect();
    if (create) void copyInvite();
  }

  function onState(s: ConnState, detail?: string): void {
    if (s === 'online') return; // welcome sets the status
    if (s === 'connecting') ui.setStatus('Connecting');
    if (s === 'offline') {
      ui.setStatus('Offline, reconnecting', true);
      dropEveryone();
    }
    if (s === 'closed' && detail) {
      dropEveryone();
      const msg: Record<string, string> = {
        full: `This room is full. Ask your friend for a new link.`,
        not_found: 'This room is closed or the link is wrong. You can create a new room.',
        version: 'Your page is out of date. Please reload.',
        bad: 'Could not join the room. Please reload.',
      };
      ui.setStatus(detail === 'full' ? 'Room full' : 'Not connected', true);
      ui.toast(msg[detail] ?? 'Disconnected', true, 8000);
    }
    sender.reset();
  }

  function dropEveryone(): void {
    for (const id of [...peers.peers.keys()]) voice.hangUp(id);
    peers.clear();
    speaking.clear();
    refreshRoster();
  }

  function spawn(): void {
    // Stand next to the start point, each colour slot on its own side, on a walkable spot
    const sp = ctx.manifest.start_pose;
    const planner = ctx.getPlanner();
    for (let r = 0.9; r <= 2.5; r += 0.4) {
      for (let k = 0; k < 12; k++) {
        const a = ((mySlot * 60 + k * 30) * Math.PI) / 180;
        const x = sp.x + Math.sin(a) * r;
        const z = sp.z + Math.cos(a) * r;
        if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
        if (planner && !planner.isWalkable(x, z)) continue;
        ctx.setPose({ x, z });
        return;
      }
    }
  }

  function onMessage(m: ServerMsg): void {
    const now = performance.now();
    switch (m.t) {
      case 'welcome': {
        if (m.scene !== ctx.sceneKey) {
          // Everyone in a room loads the same scene: reopen with the room's scene
          const u = new URL(window.location.href);
          u.searchParams.set('scene', m.scene);
          window.location.replace(u.toString());
          return;
        }
        myId = m.you;
        mySlot = m.slot;
        cap = m.cap;
        if (!spawned && m.peers.length > 0) spawn();
        spawned = true;
        dropEveryone();
        for (const p of m.peers) {
          peers.add(p, now);
          voice.call(p.id); // the newcomer starts each call
        }
        sender.reset();
        ui.setStatus(`Online, room for ${cap}`);
        refreshRoster();
        return;
      }
      case 'join':
        peers.add(m.peer, now);
        ui.toast(`${m.peer.name} joined`);
        refreshRoster();
        return;
      case 'left': {
        const p = peers.peers.get(m.id);
        if (p) ui.toast(`${p.name} left`);
        voice.hangUp(m.id);
        peers.remove(m.id);
        speaking.delete(m.id);
        if (follow?.id === m.id) follow = null;
        refreshRoster();
        return;
      }
      case 's':
        peers.pose(m.id, m.p, now, { e: m.e, f: m.f });
        return;
      case 'look':
        peers.look(m.id, m.look);
        return;
      case 'ping': {
        const p = peers.peers.get(m.id);
        if (!p) return;
        peers.addMarker(m.x, m.y, m.z, p.slot, m.label ? `${p.name}: ${m.label}` : p.name, now);
        ui.toast(m.label ? `${p.name} points at ${m.label}` : `${p.name} is pointing somewhere`);
        return;
      }
      case 'rtc':
        void voice.handleSignal(m.from, m.data);
        return;
      case 'error':
        return; // handled through onState
    }
  }

  function refreshRoster(): void {
    const list: RosterEntry[] = [];
    if (myId) list.push({ id: myId, name, slot: mySlot, speaking: mySpeaking, me: true });
    for (const p of peers.peers.values()) list.push({ id: p.id, name: p.name, slot: p.slot, speaking: speaking.has(p.id), me: false });
    ui.setRoster(list);
    if (myId && client?.online) ui.setStatus(`Online, ${list.length} of ${cap} here`);
  }

  const ray = new THREE.Raycaster();
  const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  function point(): void {
    if (!client?.online) return;
    // The spot in the middle of the screen, on the floor; looking up points 3 m ahead instead
    ray.setFromCamera(new THREE.Vector2(0, 0), ctx.camera);
    const hit = ray.ray.intersectPlane(floor, new THREE.Vector3());
    const pose = ctx.getPose();
    let x: number, z: number;
    if (hit && Math.hypot(hit.x - pose.x, hit.z - pose.z) < 15) {
      x = hit.x;
      z = hit.z;
    } else {
      x = pose.x - Math.sin(pose.yaw) * 3;
      z = pose.z - Math.cos(pose.yaw) * 3;
    }
    x = Math.min(b.maxX, Math.max(b.minX, x));
    z = Math.min(b.maxZ, Math.max(b.minZ, z));
    // Name the nearest place within 1.2 m, if any
    let label: string | undefined;
    let best = 1.2;
    for (const poi of ctx.getPois()) {
      const d = Math.hypot(poi.position.x - x, poi.position.z - z);
      if (d < best) {
        best = d;
        label = poi.name;
      }
    }
    client.send({ t: 'ping', x, y: 0, z, label });
    peers.addMarker(x, 0, z, mySlot, label ? `You: ${label}` : 'You');
  }

  function goTo(id: string): void {
    const p = peers.peers.get(id);
    const pose = p?.shown;
    if (!p || !pose) {
      ui.toast('Waiting for their position');
      return;
    }
    const poi: POI = {
      schema_version: 1,
      poi_id: `${FRIEND_PREFIX}${id}`,
      scene_id: ctx.manifest.scene_id,
      name: p.name,
      category: 'friend',
      position: { x: pose[0], y: pose[1], z: pose[2] },
    };
    follow = { id, poi, lastPlan: { x: pose[0], z: pose[2] }, lastAt: performance.now() };
    ctx.routeTo(poi);
  }

  function leave(): void {
    client?.close();
    client = null;
    voice.stop();
    dropEveryone();
    follow = null;
    myId = null;
    roomCode = null;
    spawned = false;
    const u = new URL(window.location.href);
    u.searchParams.delete('room');
    window.history.replaceState(null, '', u.toString());
    ui.leaveRoom();
    // A fresh lobby creates a new room (the old link still works while friends are in it)
    joinCode = null;
    ui.setJoinCode(null);
    if (opts.embedded) {
      ui.toast('You left the room. Back to exploring alone.');
      backToSolo();
    } else {
      ui.toast('You left the room');
      ui.showLobby('create');
    }
  }

  return {
    open: () => {
      if (roomCode) return;
      opts.onActiveChange?.(true);
      ui.showLobby(joinCode ? 'join' : 'create');
    },
    update: (dt: number) => {
      const now = performance.now();
      if (client?.online) {
        const pose = ctx.getPose();
        const p: Pose5 = [pose.x, pose.y, pose.z, pose.yaw, pose.pitch];
        const body = ctx.getBody?.() ?? {};
        const e = body.e !== undefined ? Math.round(body.e * 100) / 100 : undefined;
        const out = sender.next(p, now, `${e ?? ''}|${body.f ?? ''}`);
        if (out) client.send({ t: 's', p: out, e, f: body.f });
      }
      peers.update(dt, now);
      if (now - voiceTimer > 100) {
        voiceTimer = now;
        voice.tick(now);
      }
      if (follow) {
        if (ctx.getRouteTargetId() !== follow.poi.poi_id) {
          follow = null; // route cleared or replaced
        } else {
          const shown = peers.peers.get(follow.id)?.shown;
          if (shown) {
            follow.poi.position.x = shown[0];
            follow.poi.position.z = shown[2];
            if (now - follow.lastAt > 500 && Math.hypot(shown[0] - follow.lastPlan.x, shown[2] - follow.lastPlan.z) > 0.5) {
              follow.lastPlan = { x: shown[0], z: shown[2] };
              follow.lastAt = now;
              ctx.routeTo(follow.poi);
            }
          }
        }
      }
    },
  };
}


// Body state flags, re-exported for main.ts (which loads this module lazily)
export { STANCE_SLIDE, STANCE_CROUCH, FLAG_AIR, FLAG_CLIMB } from './protocol.js';
