/**
 * Dev tool for avatars.html: every character in a row, drawn exactly like in the viewer
 * (toon shading, outline, name tag), with a walk cycle on every other one.
 */

import * as THREE from 'three';
import { Avatar } from './avatar.js';
import { listCharacters, SLOT_COLORS } from './catalog.js';
import { STANCE_CROUCH, STANCE_SLIDE, FLAG_AIR, type BodyState } from '../net/protocol.js';

const params = new URLSearchParams(window.location.search);
const hat = params.get('hat') ?? 'none';
const turn = params.get('turn') !== '0';
// ?poses=1: stand, crouch, slide, jump, walk across the row (checks the Walk-move body poses)
const poses = params.get('poses') === '1';
const EYE = 1.5;
const POSES: { label: string; body: BodyState; jump?: boolean; walk?: boolean }[] = [
  { label: 'Stand', body: { e: EYE, f: 0 } },
  { label: 'Crouch', body: { e: 1.0, f: STANCE_CROUCH } },
  { label: 'Slide', body: { e: 0.85, f: STANCE_SLIDE } },
  { label: 'Jump', body: { e: EYE, f: FLAG_AIR }, jump: true },
  { label: 'Walk', body: { e: EYE, f: 0 }, walk: true },
];
const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color('#0d1220');
scene.add(new THREE.HemisphereLight(0xffffff, 0x554466, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(2, 5, 3);
scene.add(sun);
const floor = new THREE.Mesh(new THREE.CircleGeometry(6, 48), new THREE.MeshBasicMaterial({ color: '#1a2238' }));
floor.rotation.x = -Math.PI / 2;
scene.add(floor);

const chars = listCharacters();
const spacing = 1.1;
const avatars = chars.map((c, i) => {
  const label = poses ? POSES[i % POSES.length].label : c.label;
  const a = new Avatar(label, { char: c.id, colors: [...c.colors] as [string, string, string], hat }, SLOT_COLORS[i % SLOT_COLORS.length], 0);
  scene.add(a.group);
  const pose = poses ? POSES[i % POSES.length] : null;
  return { a, x: (i - (chars.length - 1) / 2) * spacing, walk: pose ? !!pose.walk : i % 2 === 1, pose };
});

const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50);
const width = chars.length * spacing;
camera.position.set(0, 1.5, Math.max(4.5, width * 1.15));
camera.lookAt(0, 0.85, 0);

let t = 0;
let last = performance.now();
const loop = (now: number) => {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  t += dt;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * renderer.getPixelRatio())) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  for (const { a, x, walk, pose } of avatars) {
    // Walkers tread on the spot: feed a pose that moves forward and back by a tiny amount
    const wobble = walk ? Math.sin(t * 6) * 0.07 : 0;
    const yaw = Math.PI + (turn ? Math.sin(t * 0.6) * 0.6 : 0);
    if (pose) {
      // Eye y = feet (0) + eye above feet (+ a jump arc); the avatar puts its feet back on y = 0
      const e = pose.body.e ?? EYE;
      const jumpH = pose.jump ? 0.35 : 0;
      a.update([x, e + jumpH, wobble, yaw - (turn ? 0 : 0.6), 0], dt, t, pose.body);
    } else {
      a.update([x, 0, wobble, yaw, 0], dt, t);
    }
  }
  renderer.render(scene, camera);
};
requestAnimationFrame(loop);
