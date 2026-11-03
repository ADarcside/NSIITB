/**
 * Namma Space multiplayer: one remote player's avatar in the 3D scene.
 * Cartoon look: toon shading plus a dark outline, a name tag that stays readable through walls,
 * and a ring on the tag while the player talks. Walking, idle bob and head turn are done here
 * from named parts (body, head, arm_L, arm_R, leg_L, leg_R, hat_socket), so models edited in
 * Blender keep animating as long as those names stay.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  STANCE_MASK,
  STANCE_CROUCH,
  STANCE_SLIDE,
  FLAG_AIR,
  type AvatarLook,
  type BodyState,
  type Pose5,
} from '../net/protocol.js';
import { listCharacters, type CharacterDef } from './catalog.js';
import { buildPlaceholder } from './placeholder.js';
import { buildHat } from './hats.js';

/** Figure height in metres (feet to top of head) */
export const AVATAR_HEIGHT_M = 1.55;
const OUTLINE_PX = 0.007;
const RECOLOR = ['main', 'second', 'accent'];
/** Head radius the hats in hats.ts are modelled for */
const HAT_HEAD_RADIUS_M = 0.14;

let gradientMap: THREE.DataTexture | null = null;
function toonGradient(): THREE.DataTexture {
  if (gradientMap) return gradientMap;
  const data = new Uint8Array([90, 170, 255]);
  gradientMap = new THREE.DataTexture(data, 3, 1, THREE.RedFormat);
  gradientMap.minFilter = THREE.NearestFilter;
  gradientMap.magFilter = THREE.NearestFilter;
  gradientMap.needsUpdate = true;
  return gradientMap;
}

let outlineMat: THREE.MeshBasicMaterial | null = null;
function outlineMaterial(): THREE.MeshBasicMaterial {
  if (outlineMat) return outlineMat;
  outlineMat = new THREE.MeshBasicMaterial({ color: 0x15121a, side: THREE.BackSide });
  outlineMat.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>\n transformed += normalize(normal) * ${OUTLINE_PX.toFixed(4)};`
    );
  };
  return outlineMat;
}

const gltfCache = new Map<string, Promise<THREE.Group>>();
function loadModel(url: string): Promise<THREE.Group> {
  let p = gltfCache.get(url);
  if (!p) {
    p = new GLTFLoader().loadAsync(url).then(g => g.scene as THREE.Group);
    gltfCache.set(url, p);
  }
  return p.then(g => g.clone(true));
}

/** Material name (Blender material, glTF name) without Blender's .001 suffixes */
function baseName(name: string): string {
  return name.toLowerCase().replace(/\.\d+$/, '');
}

/**
 * Turns every mesh into toon shading with an outline, and returns the recolourable materials by
 * slot name (main / second / accent).
 */
export function cartoonify(root: THREE.Object3D): Map<string, THREE.MeshToonMaterial[]> {
  const slots = new Map<string, THREE.MeshToonMaterial[]>();
  const meshes: THREE.Mesh[] = [];
  root.traverse(o => {
    if ((o as THREE.Mesh).isMesh && !o.userData.outline) meshes.push(o as THREE.Mesh);
  });
  for (const mesh of meshes) {
    const src = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
    const name = baseName(src?.name ?? '');
    const toon = new THREE.MeshToonMaterial({
      color: src?.color ? src.color.clone() : new THREE.Color(0xffffff),
      map: src?.map ?? null,
      gradientMap: toonGradient(),
      emissive: src?.emissive ? src.emissive.clone() : new THREE.Color(0),
    });
    toon.name = name;
    mesh.material = toon;
    if (RECOLOR.includes(name)) {
      const list = slots.get(name) ?? [];
      list.push(toon);
      slots.set(name, list);
    }
    if (!mesh.userData.noOutline && mesh.geometry.attributes.normal) {
      const outline = new THREE.Mesh(mesh.geometry, outlineMaterial());
      outline.userData.outline = true;
      outline.raycast = () => {};
      mesh.add(outline);
    }
  }
  return slots;
}

function makeNameTag(name: string, color: string): { sprite: THREE.Sprite; setSpeaking: (on: boolean) => void } {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const draw = (speaking: boolean) => {
    ctx.clearRect(0, 0, 512, 128);
    ctx.font = '600 52px "Space Grotesk", system-ui, sans-serif';
    const w = Math.min(480, ctx.measureText(name).width + 72);
    const x = (512 - w) / 2;
    ctx.fillStyle = 'rgba(10, 15, 30, 0.82)';
    ctx.strokeStyle = speaking ? '#80ed99' : color;
    ctx.lineWidth = speaking ? 10 : 5;
    ctx.beginPath();
    ctx.roundRect(x, 20, w, 88, 44);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x + 36, 64, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, x + 56, 66, w - 70);
    tex.needsUpdate = true;
  };
  draw(false);
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.8, 0.2, 1);
  sprite.renderOrder = 10;
  sprite.raycast = () => {};
  let last = false;
  return {
    sprite,
    setSpeaking: on => {
      if (on !== last) {
        last = on;
        draw(on);
      }
    },
  };
}

interface Parts {
  body?: THREE.Object3D;
  head?: THREE.Object3D;
  armL?: THREE.Object3D;
  armR?: THREE.Object3D;
  legL?: THREE.Object3D;
  legR?: THREE.Object3D;
  hatSocket?: THREE.Object3D;
}

export class Avatar {
  readonly group = new THREE.Group();
  private readonly _figure = new THREE.Group();
  private _model: THREE.Object3D | null = null;
  private _parts: Parts = {};
  private _rest = new Map<THREE.Object3D, THREE.Euler>();
  private _bodyRestY = 0;
  private _slots = new Map<string, THREE.MeshToonMaterial[]>();
  private _hat: THREE.Object3D | null = null;
  private _look: AvatarLook;
  private readonly _tag: ReturnType<typeof makeNameTag>;
  private _walkPhase = 0;
  private _walkAmt = 0;
  private _last: Pose5 | null = null;
  private _loadToken = 0;
  private readonly _eyeHeight: number;
  private _speaking = false;
  /** Eased body state: eye height above feet, crouch / slide / in-air amounts 0..1 */
  private _eye = -1;
  private _crouch = 0;
  private _slide = 0;
  private _air = 0;

  constructor(name: string, look: AvatarLook, tagColor: string, eyeHeightM: number) {
    this._eyeHeight = eyeHeightM;
    this._look = look;
    this.group.add(this._figure);
    this._tag = makeNameTag(name, tagColor);
    this._tag.sprite.position.y = AVATAR_HEIGHT_M + 0.32;
    this.group.add(this._tag.sprite);
    this.group.visible = false;
    void this.setLook(look);
  }

  get look(): AvatarLook {
    return this._look;
  }

  async setLook(look: AvatarLook): Promise<void> {
    const sameChar = this._model && this._look.char === look.char;
    this._look = look;
    if (!sameChar) {
      const token = ++this._loadToken;
      const def: CharacterDef | undefined = listCharacters().find(c => c.id === look.char);
      let model: THREE.Object3D;
      try {
        model = def?.url ? await loadModel(def.url) : buildPlaceholder(look.char);
      } catch (err) {
        console.warn('[Avatar] Could not load', look.char, err);
        model = buildPlaceholder(look.char);
      }
      if (token !== this._loadToken) return;
      this._setModel(model);
    }
    this._applyColors();
    this._applyHat();
  }

  private _setModel(model: THREE.Object3D): void {
    if (this._model) this._figure.remove(this._model);
    // Normalise size: feet on y = 0, AVATAR_HEIGHT_M tall, facing -Z like the camera at yaw 0
    const box = new THREE.Box3().setFromObject(model);
    const h = Math.max(0.01, box.max.y - box.min.y);
    const s = AVATAR_HEIGHT_M / h;
    const holder = new THREE.Group();
    model.position.y -= box.min.y;
    holder.add(model);
    holder.scale.setScalar(s);
    // glTF characters face +Z; turn them to face the way the player looks
    holder.rotation.y = Math.PI;
    this._model = holder;
    this._figure.add(holder);
    this._slots = cartoonify(model);
    const find = (n: string) => model.getObjectByName(n) ?? undefined;
    this._parts = {
      body: find('body'),
      head: find('head'),
      armL: find('arm_L'),
      armR: find('arm_R'),
      legL: find('leg_L'),
      legR: find('leg_R'),
      hatSocket: find('hat_socket') ?? find('head'),
    };
    this._rest.clear();
    for (const p of Object.values(this._parts)) if (p) this._rest.set(p, p.rotation.clone());
    this._bodyRestY = this._parts.body?.position.y ?? 0;
    this._hat = null;
  }

  private _applyColors(): void {
    this._look.colors.forEach((c, i) => {
      for (const m of this._slots.get(RECOLOR[i]) ?? []) m.color.set(c);
    });
  }

  private _applyHat(): void {
    if (this._hat) {
      this._hat.parent?.remove(this._hat);
      this._hat = null;
    }
    const socket = this._parts.hatSocket;
    if (!socket || this._look.hat === 'none') return;
    const hat = buildHat(this._look.hat, this._look.colors);
    if (!hat) return;
    // Hats are built for a 0.14 m wide head radius; size them to this character's head
    const headObj = this._parts.head ?? socket;
    const box = new THREE.Box3().setFromObject(headObj);
    const groupScale = new THREE.Vector3();
    this.group.getWorldScale(groupScale);
    const headRadius = (box.max.x - box.min.x) / 2 / Math.max(1e-6, groupScale.x);
    const socketScale = new THREE.Vector3();
    socket.getWorldScale(socketScale);
    hat.scale.setScalar(Math.max(0.5, Math.min(4, headRadius / HAT_HEAD_RADIUS_M)) * (groupScale.x / Math.max(1e-6, socketScale.x)));
    cartoonify(hat);
    socket.add(hat);
    this._hat = hat;
  }

  setSpeaking(on: boolean): void {
    this._speaking = on;
    this._tag.setSpeaking(on);
  }

  get speaking(): boolean {
    return this._speaking;
  }

  /** Places the avatar for a pose (eye position) and animates; dt in seconds */
  update(p: Pose5 | null, dt: number, timeS: number, body: BodyState = {}): void {
    if (!p) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    // Feet sit below the eye by the sender's current eye height (lower while crouching or
    // sliding), eased so a stance change doesn't pop
    const k = Math.min(1, dt * 12);
    const eyeTarget = body.e ?? this._eyeHeight;
    this._eye = this._eye < 0 ? eyeTarget : this._eye + (eyeTarget - this._eye) * k;
    const stance = (body.f ?? 0) & STANCE_MASK;
    this._crouch += ((stance === STANCE_CROUCH ? 1 : 0) - this._crouch) * k;
    this._slide += ((stance === STANCE_SLIDE ? 1 : 0) - this._slide) * k;
    this._air += (((body.f ?? 0) & FLAG_AIR ? 1 : 0) - this._air) * Math.min(1, dt * 16);
    const feetY = p[1] - this._eye;
    this.group.position.set(p[0], feetY, p[2]);
    this.group.rotation.y = p[3];

    let speed = 0;
    if (this._last && dt > 0) speed = Math.hypot(p[0] - this._last[0], p[2] - this._last[2]) / dt;
    this._last = p;
    const target = Math.min(1, speed / 1.4);
    this._walkAmt += (target - this._walkAmt) * Math.min(1, dt * 8);
    this._walkPhase += dt * (5 + speed * 3);

    // Walking legs calm down while ducking, sliding or in the air
    const calm = 1 - Math.max(this._slide, this._air * 0.8, this._crouch * 0.4);
    const swing = Math.sin(this._walkPhase) * 0.65 * this._walkAmt * calm;
    const rot = (o: THREE.Object3D | undefined, x: number, z = 0) => {
      if (!o) return;
      const r = this._rest.get(o)!;
      o.rotation.set(r.x + x, r.y, r.z + z);
    };
    // Model is turned 180 degrees, so a positive X rotation swings a limb backwards
    // Legs forward (negative X) for a slide, knees up in the air, a little bent when crouching
    const legBase = -1.1 * this._slide - 0.55 * this._air - 0.35 * this._crouch;
    const armUp = 1.6 * this._air + 0.6 * this._slide; // arms out for balance
    rot(this._parts.legL, swing + legBase);
    rot(this._parts.legR, -swing + legBase * (this._air > 0.5 ? 0.6 : 1));
    rot(this._parts.armL, -swing * 0.9 - armUp * 0.4, 0.08 + armUp * 0.5);
    rot(this._parts.armR, swing * 0.9 - armUp * 0.4, -0.08 - armUp * 0.5);
    const idle = Math.sin(timeS * 2.2) * 0.012;
    if (this._parts.body) {
      this._parts.body.position.y = this._bodyRestY + Math.abs(Math.cos(this._walkPhase)) * 0.03 * this._walkAmt + idle;
    }
    // Head nods with the player's look pitch (camera pitch up = positive)
    rot(this._parts.head, -Math.max(-0.5, Math.min(0.5, p[4] * 0.6)));
    // Crouch: squash down and lean forward; slide: lean back low. The figure faces -Z, so a
    // negative X rotation tips the head forward.
    const squash = 1 - 0.28 * this._crouch - 0.2 * this._slide;
    this._figure.scale.set(1 + 0.06 * this._crouch, squash, 1 + 0.06 * this._crouch);
    // Free-roam players float above the floor: tilt slightly to read as "flying"
    const floating = feetY > 0.4 && this._air < 0.5 && body.e === undefined ? -0.08 : 0;
    this._figure.rotation.x = floating - 0.18 * this._crouch + 0.6 * this._slide;
    // Keep the tag above the head as the figure squashes
    this._tag.sprite.position.y = AVATAR_HEIGHT_M * squash + 0.32;
  }

  dispose(): void {
    this.group.parent?.remove(this.group);
    this.group.traverse(o => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !m.userData.outline) (m.material as THREE.Material).dispose();
    });
    (this._tag.sprite.material as THREE.SpriteMaterial).map?.dispose();
    this._tag.sprite.material.dispose();
  }
}
