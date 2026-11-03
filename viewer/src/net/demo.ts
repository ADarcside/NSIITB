/**
 * Namma Space multiplayer: ?mpdemo=1 shows scripted fake players walking loops in the scene,
 * with no relay. Used to check how avatars look and blend with the splats, and the frame rate.
 */

import type { SceneManifest } from '../contracts/types.js';
import type { PeerManager } from '../avatars/peers.js';
import { listCharacters } from '../avatars/catalog.js';
import { HATS } from '../avatars/catalog.js';
import { STANCE_CROUCH, STANCE_SLIDE, FLAG_AIR, type Pose5 } from './protocol.js';

export function startDemoPeers(peers: PeerManager, manifest: SceneManifest): { update: (dt: number) => void } {
  const chars = listCharacters();
  const names = ['Asha', 'Ravi', 'Meera', 'Kabir', 'Zoya'];
  const b = manifest.bounds;
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  const rMax = Math.max(0.4, Math.min(b.maxX - b.minX, b.maxZ - b.minZ) * 0.3);
  const count = Math.min(5, chars.length);
  for (let i = 0; i < count; i++) {
    const c = chars[i];
    peers.add({
      id: `demo${i}`,
      name: names[i],
      slot: i + 1,
      look: { char: c.id, colors: [...c.colors] as [string, string, string], hat: HATS[(i + 1) % HATS.length].id },
    });
  }
  let t = 0;
  let sendT = 0;
  return {
    update: dt => {
      t += dt;
      sendT += dt;
      // Feed poses at 10 Hz like the real relay, so smoothing is exercised too
      if (sendT >= 0.1) {
        sendT = 0;
        for (let i = 0; i < count; i++) {
          const r = rMax * (0.45 + 0.15 * i);
          const speed = (i % 2 === 0 ? 1 : -1) * (0.9 / r) * (i === 2 ? 0 : 1); // demo2 stands still
          const a = t * speed + (i * Math.PI * 2) / count;
          const x = cx + Math.cos(a) * r;
          const z = cz + Math.sin(a) * r;
          // Face the walking direction (tangent); camera yaw convention: yaw 0 looks at -Z
          const dx = -Math.sin(a) * speed;
          const dz = Math.cos(a) * speed;
          const yaw = speed === 0 ? t * 0.5 : Math.atan2(-dx, -dz);
          const pitch = Math.sin(t + i) * 0.3;
          // Cycle Walk moves every 3 s so the body poses can be checked: stand, crouch, slide, jump
          const phase = (Math.floor(t / 3) + i) % 4;
          const eye = manifest.eye_height_m;
          const jumpH = phase === 3 ? Math.max(0, Math.sin(((t % 1) / 1) * Math.PI)) * 0.45 : 0;
          const e = phase === 1 ? 1.0 : phase === 2 ? 0.85 : eye;
          const f = phase === 1 ? STANCE_CROUCH : phase === 2 ? STANCE_SLIDE : jumpH > 0.01 ? FLAG_AIR : 0;
          const p: Pose5 = [x, e + jumpH, z, yaw, pitch];
          peers.pose(`demo${i}`, p, undefined, { e, f });
        }
      }
      peers.update(dt);
    },
  };
}
