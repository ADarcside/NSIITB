/**
 * Namma Space multiplayer: built-in placeholder figure, used when a character's .glb is missing
 * or fails to load. Same part names and material slots as the Blender models (see AVATARS.md),
 * chibi proportions, faces +Z like a glTF export. About 400 triangles.
 */

import * as THREE from 'three';

function mat(name: string, color: number | string): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color });
  m.name = name;
  return m;
}

function pivot(name: string, x: number, y: number, z: number): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  g.position.set(x, y, z);
  return g;
}

function mesh(geo: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const me = new THREE.Mesh(geo, m);
  me.position.set(x, y, z);
  return me;
}

export function buildPlaceholder(char: string): THREE.Group {
  const main = mat('main', '#e63946');
  const second = mat('second', '#f1c453');
  const accent = mat('accent', '#2b59c3');
  const skin = mat('skin', '#f2c9a0');
  const dark = mat('dark', '#1d1b22');
  const white = mat('white', '#ffffff');

  const root = new THREE.Group();
  root.name = 'avatar';
  // Units: the figure is about 1.0 tall here; Avatar rescales to AVATAR_HEIGHT_M

  const body = pivot('body', 0, 0.3, 0);
  root.add(body);
  const torsoGeo = char === 'robot' ? new THREE.BoxGeometry(0.34, 0.3, 0.26) : new THREE.CapsuleGeometry(0.15, 0.14, 4, 10);
  body.add(mesh(torsoGeo, main, 0, 0.14, 0));
  // Belt / emblem in the accent colour
  body.add(mesh(new THREE.CylinderGeometry(0.155, 0.155, 0.04, 12), accent, 0, 0.05, 0));

  const head = pivot('head', 0, 0.33, 0);
  body.add(head);
  const headR = char === 'critter' ? 0.24 : 0.22;
  const headGeo = char === 'robot' ? new THREE.BoxGeometry(0.4, 0.34, 0.36) : new THREE.SphereGeometry(headR, 16, 12);
  const headMat = char === 'robot' || char === 'hero' || char === 'ninja' || char === 'critter' ? (char === 'ninja' ? main : char === 'critter' ? main : second) : skin;
  head.add(mesh(headGeo, headMat, 0, 0.2, 0));
  // Face: eyes on +Z
  const eyeGeo = new THREE.SphereGeometry(0.035, 8, 6);
  for (const sx of [-1, 1]) {
    const eyeWhite = mesh(new THREE.SphereGeometry(0.05, 10, 8), white, sx * 0.08, 0.23, 0.18);
    eyeWhite.scale.z = 0.5;
    eyeWhite.userData.noOutline = true;
    head.add(eyeWhite);
    const pupil = mesh(eyeGeo, dark, sx * 0.08, 0.23, 0.205);
    pupil.userData.noOutline = true;
    head.add(pupil);
  }
  if (char === 'ninja') {
    // Mask band across the face, headband tails
    const band = mesh(new THREE.CylinderGeometry(0.225, 0.225, 0.09, 16, 1, true), second, 0, 0.3, 0);
    band.material = second;
    head.add(band);
  } else if (char === 'hero') {
    head.add(mesh(new THREE.BoxGeometry(0.3, 0.08, 0.05), accent, 0, 0.24, 0.2));
  } else if (char === 'robot') {
    head.add(mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.14, 6), dark, 0, 0.44, 0));
    head.add(mesh(new THREE.SphereGeometry(0.035, 8, 6), accent, 0, 0.52, 0));
  } else if (char === 'critter') {
    for (const sx of [-1, 1]) {
      const ear = mesh(new THREE.ConeGeometry(0.08, 0.2, 8), second, sx * 0.15, 0.42, 0);
      ear.rotation.z = -sx * 0.4;
      head.add(ear);
    }
  } else {
    // Kid: spiky hair
    for (let i = 0; i < 5; i++) {
      const spike = mesh(new THREE.ConeGeometry(0.06, 0.14, 6), dark, (i - 2) * 0.07, 0.4, -0.02);
      spike.rotation.z = (i - 2) * -0.25;
      head.add(spike);
    }
  }
  const hatSocket = pivot('hat_socket', 0, char === 'robot' ? 0.37 : 0.4, 0);
  head.add(hatSocket);

  for (const [name, sx] of [
    ['arm_L', 1],
    ['arm_R', -1],
  ] as const) {
    const arm = pivot(name, sx * 0.2, 0.25, 0);
    body.add(arm);
    arm.add(mesh(new THREE.CapsuleGeometry(0.05, 0.14, 3, 8), main, 0, -0.1, 0));
    arm.add(mesh(new THREE.SphereGeometry(0.055, 8, 6), char === 'robot' ? second : skin, 0, -0.21, 0));
  }
  for (const [name, sx] of [
    ['leg_L', 1],
    ['leg_R', -1],
  ] as const) {
    const leg = pivot(name, sx * 0.08, 0.3, 0);
    root.add(leg);
    leg.add(mesh(new THREE.CapsuleGeometry(0.06, 0.12, 3, 8), char === 'kid' ? accent : second, 0, -0.14, 0));
    leg.add(mesh(new THREE.BoxGeometry(0.11, 0.06, 0.16), dark, 0, -0.27, 0.03));
  }
  if (char === 'critter') {
    const tail = mesh(new THREE.ConeGeometry(0.05, 0.28, 8), accent, 0, 0.42, -0.2);
    tail.rotation.x = -1.0;
    root.add(tail);
  }
  return root;
}
