/**
 * Namma Space multiplayer: avatar catalogue.
 * Characters are .glb files in src/avatars/models/ (made with tools/avatars/build_avatars.py in
 * Blender, or by hand). Any .glb dropped in that folder shows up in the picker after a rebuild;
 * its file name is its id. See src/avatars/models/AVATARS.md for the part names a model needs.
 */

import type { AvatarLook } from '../net/protocol.js';

export interface CharacterDef {
  id: string;
  label: string;
  /** URL of the .glb, or null for the built-in placeholder figure */
  url: string | null;
  colors: [string, string, string];
}

/** Labels and default colours for the five original characters */
const BUILT_IN: Record<string, { label: string; colors: [string, string, string] }> = {
  kid: { label: 'Naughty kid', colors: ['#e63946', '#f1c453', '#2b59c3'] },
  robot: { label: 'Robot buddy', colors: ['#4cc9f0', '#f8f9fa', '#ffb703'] },
  hero: { label: 'Masked hero', colors: ['#7b2cbf', '#ffd60a', '#ef233c'] },
  ninja: { label: 'Ninja', colors: ['#2b2d42', '#e63946', '#8d99ae'] },
  critter: { label: 'Pocket critter', colors: ['#f4a261', '#fff1d6', '#e76f51'] },
};
const ORDER = ['kid', 'robot', 'hero', 'ninja', 'critter'];

// Vite lists the folder at build time: dropping in a new .glb needs no code change
const modelUrls = import.meta.glob('./models/*.glb', { query: '?url', import: 'default', eager: true }) as Record<string, string>;

function titleCase(id: string): string {
  return id.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function listCharacters(): CharacterDef[] {
  const files = new Map<string, string>();
  for (const [path, url] of Object.entries(modelUrls)) {
    const id = path.split('/').pop()!.replace(/\.glb$/i, '');
    if (/^[A-Za-z0-9_.-]{1,40}$/.test(id)) files.set(id, url);
  }
  const out: CharacterDef[] = [];
  for (const id of ORDER) {
    out.push({ id, label: BUILT_IN[id].label, url: files.get(id) ?? null, colors: BUILT_IN[id].colors });
    files.delete(id);
  }
  for (const [id, url] of [...files].sort()) {
    out.push({ id, label: titleCase(id), url, colors: ['#e63946', '#f1c453', '#2b59c3'] });
  }
  return out;
}

export interface HatDef {
  id: string;
  label: string;
}

export const HATS: HatDef[] = [
  { id: 'none', label: 'None' },
  { id: 'cap', label: 'Cap' },
  { id: 'crown', label: 'Crown' },
  { id: 'party', label: 'Party hat' },
  { id: 'headphones', label: 'Headphones' },
  { id: 'propeller', label: 'Propeller cap' },
];

/** Name tag / path / marker colour per room slot */
export const SLOT_COLORS = ['#ffd700', '#4cc9f0', '#ff6b9d', '#80ed99', '#ff9f1c', '#c77dff'];

export function defaultLook(chars: CharacterDef[] = listCharacters()): AvatarLook {
  const c = chars[Math.floor(Math.random() * Math.min(chars.length, ORDER.length))] ?? chars[0];
  return { char: c.id, colors: [...c.colors] as [string, string, string], hat: 'none' };
}
