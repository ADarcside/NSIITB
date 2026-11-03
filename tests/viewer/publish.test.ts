import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  parseTarget,
  saveConfigFromEnv,
  updateManifestText,
  poiSetText,
  savePoisLive,
  SaveError,
} from '../../viewer/src/nav/publish.js';
import { makePoi } from '../../viewer/src/nav/pois.js';

const SCENE = 'scn_hostelroomac';

const manifest = {
  schema_version: 1,
  scene_id: SCENE,
  assets: { full: 'ast_hostelroomfl', pois: 'ast_hostelroomps' },
  asset_table: {
    ast_hostelroomfl: { asset_id: 'ast_hostelroomfl', kind: 'splat_full', uri: 'full.spz', sha256: 'aa', bytes: 1 },
    ast_hostelroomps: { asset_id: 'ast_hostelroomps', kind: 'pois', format: 'json', uri: 'pois.json', sha256: 'old', bytes: 2 },
  },
};
const manifestText = JSON.stringify(manifest, null, 2) + '\n';

/** Tiny fake of the GitHub REST endpoints savePoisLive uses; records every write */
function fakeGitHub(opts: { status?: number; moveOnce?: boolean } = {}) {
  const writes: { method: string; url: string; body: any }[] = [];
  let moved = !opts.moveOnce;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).replace('https://api.github.com', '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (opts.status) return json({ message: 'nope' }, opts.status);
    if (method !== 'GET') writes.push({ method, url, body });
    if (url.includes('/contents/')) return json({ content: Buffer.from(manifestText).toString('base64'), encoding: 'base64' });
    if (url.includes('/git/ref/heads/')) return json({ object: { sha: 'head1' } });
    if (url.includes('/git/commits/')) return json({ tree: { sha: 'tree1' } });
    if (url.endsWith('/git/trees')) return json({ sha: 'tree2' });
    if (url.endsWith('/git/commits')) return json({ sha: `commit-${writes.length}` });
    if (method === 'PATCH') {
      if (!moved) {
        moved = true;
        return json({ message: 'Update is not a fast forward' }, 422);
      }
      return json({ object: { sha: body.sha } });
    }
    return json({ message: 'unexpected ' + url }, 500);
  }) as typeof fetch;
  return { fetchImpl, writes };
}

const config = {
  live: { owner: 'ADarcside', repo: 'namma-space', branch: 'main', path: `round2/${SCENE}` },
  source: { owner: 'ADarcside', repo: 'NSIITB', branch: 'round-2', path: 'sample/test-capture/pois.json' },
};
const pois = [makePoi(SCENE, 'Bunk 1', 1, 2), makePoi(SCENE, 'Study table', -1, 0.5)];

describe('Save to live', () => {
  it('parses targets and needs VITE_SAVE_LIVE to be on', () => {
    expect(parseTarget('ADarcside/namma-space@main:round2/scn_hostelroomac/')).toEqual(config.live);
    expect(parseTarget('nonsense')).toBeNull();
    expect(saveConfigFromEnv({})).toBeNull();
    const c = saveConfigFromEnv({
      VITE_SAVE_LIVE: 'ADarcside/namma-space@main:round2/scn_hostelroomac',
      VITE_SAVE_SOURCE: 'ADarcside/NSIITB@round-2:sample/test-capture/pois.json',
    });
    expect(c).toEqual(config);
  });

  it('rewrites only the pois hash and size in the manifest', () => {
    const out = JSON.parse(updateManifestText(manifestText, 'abc', 42));
    expect(out.asset_table.ast_hostelroomps).toMatchObject({ sha256: 'abc', bytes: 42, uri: 'pois.json' });
    expect(out.asset_table.ast_hostelroomfl).toEqual(manifest.asset_table.ast_hostelroomfl);
  });

  it('commits pois.json + matching manifest to live, and pois.json to the source repo', async () => {
    const { fetchImpl, writes } = fakeGitHub();
    const res = await savePoisLive(config, 'tok', SCENE, pois, fetchImpl);
    expect(res.liveCommit).toBeTruthy();
    expect(res.sourceCommit).toBeTruthy();

    const trees = writes.filter(w => w.url.endsWith('/git/trees'));
    expect(trees.map(t => t.url)).toEqual([
      '/repos/ADarcside/namma-space/git/trees',
      '/repos/ADarcside/NSIITB/git/trees',
    ]);
    const liveFiles = Object.fromEntries(trees[0].body.tree.map((f: any) => [f.path, f.content]));
    expect(Object.keys(liveFiles).sort()).toEqual([`round2/${SCENE}/manifest.json`, `round2/${SCENE}/pois.json`]);
    const poisText = liveFiles[`round2/${SCENE}/pois.json`];
    expect(JSON.parse(poisText).pois.map((p: any) => p.name)).toEqual(['Bunk 1', 'Study table']);
    const m = JSON.parse(liveFiles[`round2/${SCENE}/manifest.json`]);
    expect(m.asset_table.ast_hostelroomps.sha256).toBe(createHash('sha256').update(poisText).digest('hex'));
    expect(m.asset_table.ast_hostelroomps.bytes).toBe(Buffer.byteLength(poisText));
    expect(trees[1].body.tree.map((f: any) => f.path)).toEqual(['sample/test-capture/pois.json']);
    expect(trees[1].body.tree[0].content).toBe(poisText);
    expect(writes.filter(w => w.method === 'PATCH').every(w => w.body.force === false)).toBe(true);
  });

  it('retries once when the branch moved during the save', async () => {
    const { fetchImpl, writes } = fakeGitHub({ moveOnce: true });
    await savePoisLive({ live: config.live }, 'tok', SCENE, pois, fetchImpl);
    expect(writes.filter(w => w.method === 'PATCH')).toHaveLength(2);
  });

  it('flags a refused key so the UI can ask again', async () => {
    const { fetchImpl } = fakeGitHub({ status: 401 });
    await expect(savePoisLive(config, 'bad', SCENE, pois, fetchImpl)).rejects.toMatchObject({ badToken: true });
    await expect(savePoisLive(config, 'bad', SCENE, pois, fetchImpl)).rejects.toBeInstanceOf(SaveError);
  });

  it('writes the same text as Export', () => {
    expect(poiSetText(SCENE, pois).endsWith('\n')).toBe(true);
    expect(JSON.parse(poiSetText(SCENE, pois)).scene_id).toBe(SCENE);
  });
});
