/**
 * Namma Space: save tag mode edits straight to the live site (Round 2).
 *
 * The live site is static (GitHub Pages), so "saving" means committing the new pois.json through the
 * GitHub API from the browser. The owner pastes a fine-grained GitHub token once; it stays in this
 * browser's localStorage and is never part of the built site. Targets come from build-time env:
 *
 *   VITE_SAVE_LIVE   = owner/repo@branch:dir       (dir holds manifest.json + pois.json of the scene)
 *   VITE_SAVE_SOURCE = owner/repo@branch:path      (optional: a copy of pois.json in the source repo)
 *
 * Without VITE_SAVE_LIVE the Save button is not shown. The live commit also rewrites the manifest's
 * pois asset sha256/bytes, because the viewer verifies every asset against the manifest.
 */

import type { Id, POI } from '../contracts/types.js';
import { makePoiSet } from './pois.js';

export interface SaveTarget {
  owner: string;
  repo: string;
  branch: string;
  /** Folder for the live target, file path for the source target */
  path: string;
}

export interface SaveConfig {
  live: SaveTarget;
  source?: SaveTarget;
}

export interface SaveResult {
  liveCommit: string;
  sourceCommit?: string;
}

const TOKEN_KEY = 'namma-save-token';
const API = 'https://api.github.com';

/** "owner/repo@branch:path" -> SaveTarget, or null when malformed. */
export function parseTarget(spec: string | undefined): SaveTarget | null {
  if (!spec) return null;
  const m = /^([\w.-]+)\/([\w.-]+)@([\w./-]+):(.+)$/.exec(spec.trim());
  if (!m) return null;
  return { owner: m[1], repo: m[2], branch: m[3], path: m[4].replace(/^\/+|\/+$/g, '') };
}

/** Save targets from the build env, or null when saving is not configured for this build. */
export function saveConfigFromEnv(env: Record<string, unknown>): SaveConfig | null {
  const live = parseTarget(env.VITE_SAVE_LIVE as string | undefined);
  if (!live) return null;
  const source = parseTarget(env.VITE_SAVE_SOURCE as string | undefined) ?? undefined;
  return { live, source };
}

export const tokenStore = {
  get(): string | null {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(token: string): void {
    try {
      localStorage.setItem(TOKEN_KEY, token.trim());
    } catch {
      // Private mode: the token still works for this page
    }
  },
  clear(): void {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      // ignore
    }
  },
};

export class SaveError extends Error {
  constructor(
    message: string,
    /** True when the token was refused (wrong, expired or missing access) */
    readonly badToken = false
  ) {
    super(message);
  }
}

async function sha256Hex(text: string): Promise<{ sha256: string; bytes: number }> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const sha256 = Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return { sha256, bytes: data.byteLength };
}

/** pois.json text exactly as Export writes it */
export function poiSetText(sceneId: Id, pois: POI[]): string {
  return JSON.stringify(makePoiSet(sceneId, pois), null, 2) + '\n';
}

/** New manifest text with the pois asset's sha256/bytes updated (and the asset added if missing). */
export function updateManifestText(manifestText: string, sha256: string, bytes: number): string {
  const m = JSON.parse(manifestText) as {
    scene_id: string;
    assets: Record<string, string>;
    asset_table: Record<string, Record<string, unknown>>;
  };
  let id = m.assets.pois;
  if (!id || !m.asset_table[id]) {
    id = id || `ast_${m.scene_id.slice(4, 14)}ps`;
    m.assets.pois = id;
    m.asset_table[id] = { schema_version: 1, asset_id: id, kind: 'pois', format: 'json', uri: 'pois.json' };
  }
  m.asset_table[id] = { ...m.asset_table[id], sha256, bytes };
  return JSON.stringify(m, null, 2) + '\n';
}

type Fetch = typeof fetch;

class GitHub {
  constructor(
    private readonly _token: string,
    private readonly _fetch: Fetch
  ) {}

  async call<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await this._fetch(`${API}${url}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this._token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    if (res.status === 401) throw new SaveError('GitHub refused the key (wrong or expired).', true);
    if (res.status === 403 || res.status === 404) {
      throw new SaveError(`The key can't reach ${url.split('/').slice(2, 4).join('/')} (check its repository access).`, true);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new SaveError(`GitHub error ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
    }
    return (await res.json()) as T;
  }

  /** Text of a file at the branch head (raw, uncached) */
  async readText(t: SaveTarget, path: string): Promise<string> {
    const r = await this.call<{ content: string; encoding: string }>(
      'GET',
      `/repos/${t.owner}/${t.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(t.branch)}`
    );
    const bin = atob(r.content.replace(/\n/g, ''));
    return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
  }

  /** One commit on t.branch that writes all files; retries once if the branch moved meanwhile. */
  async commitFiles(t: SaveTarget, files: Record<string, string>, message: string): Promise<string> {
    const repo = `/repos/${t.owner}/${t.repo}`;
    for (let attempt = 0; ; attempt++) {
      const ref = await this.call<{ object: { sha: string } }>('GET', `${repo}/git/ref/heads/${encodePath(t.branch)}`);
      const head = await this.call<{ tree: { sha: string } }>('GET', `${repo}/git/commits/${ref.object.sha}`);
      const tree = await this.call<{ sha: string }>('POST', `${repo}/git/trees`, {
        base_tree: head.tree.sha,
        tree: Object.entries(files).map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })),
      });
      const commit = await this.call<{ sha: string }>('POST', `${repo}/git/commits`, {
        message,
        tree: tree.sha,
        parents: [ref.object.sha],
      });
      try {
        await this.call('PATCH', `${repo}/git/refs/heads/${encodePath(t.branch)}`, { sha: commit.sha, force: false });
        return commit.sha;
      } catch (err) {
        if (attempt >= 1 || (err instanceof SaveError && err.badToken)) throw err;
      }
    }
  }
}

function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

/**
 * Commit the places to the live site (pois.json + manifest) and, if configured, to the source repo.
 * The live site updates once GitHub Pages redeploys (about a minute).
 */
export async function savePoisLive(
  config: SaveConfig,
  token: string,
  sceneId: Id,
  pois: POI[],
  fetchImpl: Fetch = fetch.bind(globalThis)
): Promise<SaveResult> {
  const gh = new GitHub(token, fetchImpl);
  const text = poiSetText(sceneId, pois);
  const { sha256, bytes } = await sha256Hex(text);
  const message = `tags: update ${pois.length} places`;

  const dir = config.live.path;
  const manifestPath = `${dir}/manifest.json`;
  const manifestText = await gh.readText(config.live, manifestPath);
  const manifestScene = (JSON.parse(manifestText) as { scene_id?: string }).scene_id;
  if (manifestScene !== sceneId) {
    throw new SaveError(`The live manifest is for ${manifestScene}, not ${sceneId}.`);
  }
  const liveCommit = await gh.commitFiles(
    config.live,
    { [`${dir}/pois.json`]: text, [manifestPath]: updateManifestText(manifestText, sha256, bytes) },
    message
  );

  let sourceCommit: string | undefined;
  if (config.source) {
    sourceCommit = await gh.commitFiles(config.source, { [config.source.path]: text }, message);
  }
  return { liveCommit, sourceCommit };
}
