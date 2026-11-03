/**
 * Namma Space multiplayer: hats and accessories, built in metres and attached at hat_socket.
 * Coloured with the player's accent / second colours.
 */

import * as THREE from 'three';

function m(name: string, color: string | number): THREE.MeshStandardMaterial {
  const x = new THREE.MeshStandardMaterial({ color });
  x.name = name;
  return x;
}

export function buildHat(id: string, colors: [string, string, string]): THREE.Group | null {
  const g = new THREE.Group();
  g.name = `hat_${id}`;
  const [, second, accent] = colors;
  switch (id) {
    case 'cap': {
      const dome = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), m('hat', accent));
      dome.position.y = -0.04;
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.015, 16, 1, false, -Math.PI / 2, Math.PI), m('hat', accent));
      brim.position.set(0, -0.035, 0.1);
      brim.scale.set(1, 1, 0.9);
      g.add(dome, brim);
      break;
    }
    case 'crown': {
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.06, 16, 1, true), m('hat', '#ffd700'));
      g.add(band);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const spike = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.06, 6), m('hat', '#ffd700'));
        spike.position.set(Math.sin(a) * 0.095, 0.055, Math.cos(a) * 0.095);
        g.add(spike);
      }
      const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.02), m('hat', '#e63946'));
      gem.position.set(0, 0, 0.1);
      g.add(gem);
      break;
    }
    case 'party': {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.22, 16), m('hat', accent));
      cone.position.y = 0.08;
      const pom = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6), m('hat', second));
      pom.position.y = 0.2;
      g.add(cone, pom);
      break;
    }
    case 'headphones': {
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.018, 6, 20, Math.PI), m('hat', '#222831'));
      band.position.y = -0.08;
      g.add(band);
      for (const sx of [-1, 1]) {
        const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.04, 12), m('hat', accent));
        cup.rotation.z = Math.PI / 2;
        cup.position.set(sx * 0.17, -0.09, 0);
        g.add(cup);
      }
      break;
    }
    case 'propeller': {
      const dome = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), m('hat', second));
      dome.position.y = -0.04;
      const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.07, 6), m('hat', '#222831'));
      stick.position.y = 0.1;
      const blades = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.008, 0.035), m('hat', accent));
      blades.position.y = 0.135;
      blades.name = 'propeller';
      g.add(dome, stick, blades);
      break;
    }
    default:
      return null;
  }
  return g;
}
