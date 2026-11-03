/**
 * Namma Space multiplayer: all remote players in the scene (avatars, smoothing, markers).
 */

import * as THREE from 'three';
import { Avatar } from './avatar.js';
import { SLOT_COLORS } from './catalog.js';
import { PoseBuffer } from '../net/interp.js';
import type { AvatarLook, BodyState, PeerInfo, Pose5 } from '../net/protocol.js';

export interface RemotePeer {
  id: string;
  name: string;
  slot: number;
  avatar: Avatar;
  buffer: PoseBuffer;
  /** Pose drawn this frame (smoothed) */
  shown: Pose5 | null;
  /** Latest body state (eye height above feet, stance flags) */
  body: BodyState;
}

interface Marker {
  group: THREE.Group;
  until: number;
  ring: THREE.Mesh;
}

export const MARKER_LIFETIME_MS = 10_000;

export class PeerManager {
  readonly peers = new Map<string, RemotePeer>();
  private readonly _scene: THREE.Scene;
  private readonly _eyeHeight: number;
  private readonly _markers: Marker[] = [];
  /** Optional clamp for glitchy poses (e.g. outside the room) */
  clampPose: ((p: Pose5) => Pose5) | null = null;

  constructor(scene: THREE.Scene, eyeHeightM: number) {
    this._scene = scene;
    this._eyeHeight = eyeHeightM;
    // Splats carry their own light; these only light the avatar meshes and markers
    const hemi = new THREE.HemisphereLight(0xffffff, 0x554466, 1.6);
    hemi.name = 'mp_hemi';
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(2, 5, 3);
    sun.name = 'mp_sun';
    scene.add(hemi, sun);
  }

  add(info: PeerInfo, nowMs = performance.now()): RemotePeer {
    this.remove(info.id);
    const avatar = new Avatar(info.name, info.look, SLOT_COLORS[info.slot % SLOT_COLORS.length], this._eyeHeight);
    this._scene.add(avatar.group);
    const peer: RemotePeer = {
      id: info.id,
      name: info.name,
      slot: info.slot,
      avatar,
      buffer: new PoseBuffer(),
      shown: null,
      body: { e: info.e, f: info.f },
    };
    if (info.p) peer.buffer.push(info.p, nowMs);
    this.peers.set(info.id, peer);
    return peer;
  }

  remove(id: string): void {
    const p = this.peers.get(id);
    if (!p) return;
    p.avatar.dispose();
    this.peers.delete(id);
  }

  clear(): void {
    for (const id of [...this.peers.keys()]) this.remove(id);
  }

  pose(id: string, p: Pose5, nowMs = performance.now(), body?: BodyState): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    if (body) peer.body = body;
    peer.buffer.push(this.clampPose ? this.clampPose(p) : p, nowMs);
  }

  look(id: string, look: AvatarLook): void {
    void this.peers.get(id)?.avatar.setLook(look);
  }

  /** Shows a marker at a spot for a while, in the player's colour */
  addMarker(x: number, y: number, z: number, slot: number, label: string, nowMs = performance.now()): void {
    const color = new THREE.Color(SLOT_COLORS[slot % SLOT_COLORS.length]);
    const group = new THREE.Group();
    group.position.set(x, y, z);
    const pin = new THREE.Mesh(
      new THREE.ConeGeometry(0.09, 0.28, 12),
      new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 })
    );
    pin.rotation.x = Math.PI;
    pin.position.y = 0.55;
    pin.renderOrder = 9;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.18, 0.26, 32),
      new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.8, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    group.add(pin, ring);
    // Label sprite
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 96;
    const ctx = canvas.getContext('2d')!;
    ctx.font = '600 44px "Space Grotesk", system-ui, sans-serif';
    const w = Math.min(500, ctx.measureText(label).width + 40);
    ctx.fillStyle = 'rgba(10, 15, 30, 0.85)';
    ctx.beginPath();
    ctx.roundRect((512 - w) / 2, 8, w, 80, 20);
    ctx.fill();
    ctx.fillStyle = `#${color.getHexString()}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 256, 50, w - 30);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    sprite.scale.set(0.9, 0.17, 1);
    sprite.position.y = 0.85;
    sprite.renderOrder = 10;
    group.add(sprite);
    this._scene.add(group);
    this._markers.push({ group, until: nowMs + MARKER_LIFETIME_MS, ring });
  }

  update(dt: number, nowMs = performance.now()): void {
    const t = nowMs / 1000;
    for (const peer of this.peers.values()) {
      peer.shown = peer.buffer.sample(nowMs);
      peer.avatar.update(peer.shown, dt, t, peer.body);
    }
    for (let i = this._markers.length - 1; i >= 0; i--) {
      const mk = this._markers[i];
      const left = mk.until - nowMs;
      if (left <= 0) {
        this._scene.remove(mk.group);
        mk.group.traverse(o => {
          const me = o as THREE.Mesh;
          if (me.isMesh || (o as THREE.Sprite).isSprite) {
            me.geometry?.dispose();
            const mat = me.material as THREE.MeshBasicMaterial;
            mat.map?.dispose();
            mat.dispose();
          }
        });
        this._markers.splice(i, 1);
        continue;
      }
      const pulse = 1 + 0.25 * Math.sin(t * 6);
      mk.ring.scale.set(pulse, pulse, pulse);
      mk.group.children[0].position.y = 0.55 + 0.05 * Math.sin(t * 4);
      if (left < 1000) mk.group.visible = Math.floor(left / 120) % 2 === 0;
    }
  }
}
