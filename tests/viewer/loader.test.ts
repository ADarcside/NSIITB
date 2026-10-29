/**
 * Namma Space: Scene Manifest & Asset Loader Unit Tests
 * Tests mocked fetch for:
 * - Success
 * - HTTP 404
 * - Bad JSON
 * - Bad schema_version
 * - SHA-256 hash mismatch
 * - Lite fallback offering/recovery
 * - Error mapping to E_MANIFEST, E_ASSET, E_WEBGL, E_SPZ
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseSceneParam,
  resolveManifestUrl,
  resolveAssetUrl,
  resolveManifestAssetUris,
  fetchAndValidateManifest,
  fetchAssetWithVerification,
  loadSceneSplatAsset,
  computeSha256Hex,
} from '../../viewer/src/loader/manifest.js';
import { validateSceneManifest } from '../../viewer/src/contracts/validator.js';
import { ViewerError } from '../../viewer/src/types.js';
import type { SceneManifest, Asset } from '../../viewer/src/contracts/types.js';
import { getSplatFileType, SplatFileType, transcodeSpz } from '@sparkjsdev/spark';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('URL and Manifest Resolution', () => {
  it('parses ?scene= param from full URLs, search strings, and objects', () => {
    expect(parseSceneParam('http://localhost:5173/?scene=v001')).toBe('v001');
    expect(parseSceneParam('https://demo.nammaspace.org/viewer/?scene=scn_23j7x56k3y7a&debug=true')).toBe('scn_23j7x56k3y7a');
    expect(parseSceneParam('?scene=dev_scene')).toBe('dev_scene');
    expect(parseSceneParam('scene=test')).toBe('test');
    expect(parseSceneParam('?other=123')).toBe(null);
    expect(parseSceneParam('')).toBe(null);
  });

  it('resolves manifest URL with configurable base URL', () => {
    expect(resolveManifestUrl('v001', 'https://cdn.nammaspace.org')).toBe('https://cdn.nammaspace.org/v001/manifest.json');
    expect(resolveManifestUrl('v001/', 'https://cdn.nammaspace.org/')).toBe('https://cdn.nammaspace.org/v001/manifest.json');
    expect(resolveManifestUrl('v001')).toBe('v001/manifest.json');
    expect(resolveManifestUrl('', '/scenes')).toBe('/scenes/manifest.json');
  });

  it('validates generated viewer/public/dev/manifest.json with TypeScript contract validator', () => {
    const devManifestPath = path.resolve(__dirname, '../../viewer/public/dev/manifest.json');
    expect(fs.existsSync(devManifestPath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(devManifestPath, 'utf-8'));
    const validation = validateSceneManifest(data);
    expect(validation.valid).toBe(true);
    expect(validation.errors ?? []).toEqual([]);
    expect(data.schema_version).toBe(1);
    expect(data.scene_id).toMatch(/^scn_[a-z2-7]{12}$/);
    expect(data.assets.full).toMatch(/^ast_[a-z2-7]{12}$/);
  });
});

describe('fetchAndValidateManifest', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const validManifestPayload: SceneManifest = {
    schema_version: 1,
    scene_id: 'scn_23j7x56k3y7a',
    space_id: 'spc_23j7x37m5w2a',
    version: 1,
    created_at: '2026-10-17T15:00:00Z',
    job_id: 'job_23j7x52k5m2b',
    assets: {
      full: 'ast_23j7x62k4x7c',
      lite: 'ast_23j7x63k5y2d',
    },
    asset_table: {
      ast_23j7x62k4x7c: {
        schema_version: 1,
        asset_id: 'ast_23j7x62k4x7c',
        kind: 'splat_full',
        format: 'spz',
        uri: 'https://cdn.nammaspace.org/scenes/v001/splat_full.spz',
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        bytes: 48201948,
      },
      ast_23j7x63k5y2d: {
        schema_version: 1,
        asset_id: 'ast_23j7x63k5y2d',
        kind: 'splat_lite',
        format: 'spz',
        uri: 'https://cdn.nammaspace.org/scenes/v001/splat_lite.spz',
        sha256: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
        bytes: 18402910,
      },
    },
    transform: {
      world_from_splat: [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
      ],
      scale: 1.0,
      method: 'floor_ransac+tape_pair',
      residuals: {
        floor_rms_m: 0.02,
        scale_check_error_pct: 1.0,
      },
    },
    start_pose: {
      x: 0,
      z: 0,
      yaw_deg: 0,
    },
    eye_height_m: 1.5,
    bounds: {
      minX: -2.0,
      maxX: 2.0,
      minZ: -2.0,
      maxZ: 2.0,
    },
  };

  it('successfully fetches and validates a valid manifest', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => validManifestPayload,
    } as unknown as Response);

    const manifest = await fetchAndValidateManifest('v001', 'https://cdn.nammaspace.org');
    expect(manifest.scene_id).toBe('scn_23j7x56k3y7a');
    expect(manifest.assets.full).toBe('ast_23j7x62k4x7c');
  });

  it('fails with E_MANIFEST on HTTP 404', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    } as unknown as Response);

    await expect(fetchAndValidateManifest('missing_scene')).rejects.toThrowError(ViewerError);

    try {
      await fetchAndValidateManifest('missing_scene');
    } catch (err: unknown) {
      expect((err as ViewerError).code).toBe('E_MANIFEST');
      expect((err as ViewerError).message).toContain('HTTP 404');
    }
  });

  it('fails with E_MANIFEST when server returns HTML page instead of manifest.json', async () => {
    // Case 1: text/html Content-Type header
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      text: async () => '<!doctype html><html><head><title>Vite App</title></head><body></body></html>',
    } as unknown as Response);

    try {
      await fetchAndValidateManifest('missing_scene', 'http://localhost:5173');
      expect.fail('Should have thrown ViewerError');
    } catch (err: unknown) {
      expect((err as ViewerError).code).toBe('E_MANIFEST');
      expect((err as ViewerError).message).toContain(
        'Scene not found: the server returned a web page instead of manifest.json at http://localhost:5173/missing_scene/manifest.json'
      );
    }

    // Case 2: Body starting with <!doctype even without Content-Type header
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => '  <!doctype html><html><body>Fallback</body></html>',
    } as unknown as Response);

    try {
      await fetchAndValidateManifest('missing_scene', 'http://localhost:5173');
      expect.fail('Should have thrown ViewerError');
    } catch (err: unknown) {
      expect((err as ViewerError).code).toBe('E_MANIFEST');
      expect((err as ViewerError).message).toContain(
        'Scene not found: the server returned a web page instead of manifest.json at http://localhost:5173/missing_scene/manifest.json'
      );
    }
  });

  it('fails with E_MANIFEST on invalid JSON response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => '{ bad json: true ',
    } as unknown as Response);

    try {
      await fetchAndValidateManifest('corrupt_json');
      expect.fail('Should have thrown ViewerError');
    } catch (err: unknown) {
      expect((err as ViewerError).code).toBe('E_MANIFEST');
      expect((err as ViewerError).message).toContain('invalid JSON');
    }
  });

  it('fails with E_MANIFEST when schema_version is unsupported', async () => {
    const badVersion = { ...validManifestPayload, schema_version: 99 };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => badVersion,
    } as unknown as Response);

    try {
      await fetchAndValidateManifest('bad_version');
      expect.fail('Should have thrown ViewerError');
    } catch (err: unknown) {
      expect((err as ViewerError).code).toBe('E_MANIFEST');
      expect((err as ViewerError).message).toContain('Unsupported schema version: 99');
    }
  });

  it('fails with E_MANIFEST when schema validation fails (e.g. invalid bounds)', async () => {
    const badBounds = {
      ...validManifestPayload,
      bounds: { minX: 10, maxX: -10, minZ: 0, maxZ: 1 },
    };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => badBounds,
    } as unknown as Response);

    try {
      await fetchAndValidateManifest('bad_bounds');
      expect.fail('Should have thrown ViewerError');
    } catch (err: unknown) {
      expect((err as ViewerError).code).toBe('E_MANIFEST');
      expect((err as ViewerError).message).toContain('Manifest validation failed');
    }
  });
});

describe('Asset Loading, SHA-256 Checksum, and Lite Fallback', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const dummyData = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 5, 6, 7, 8]);

  it('verifies SHA-256 hash correctly for valid asset data', async () => {
    const hash = await computeSha256Hex(dummyData.buffer);

    const asset: Asset = {
      schema_version: 1,
      asset_id: 'ast_23j7x62k4x7c',
      kind: 'splat_full',
      format: 'spz',
      uri: 'https://cdn.nammaspace.org/splat.spz',
      sha256: hash,
      bytes: dummyData.length,
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(dummyData.length) }),
      arrayBuffer: async () => dummyData.buffer,
    } as unknown as Response);

    const loadedBuf = await fetchAssetWithVerification(asset);
    expect(loadedBuf.byteLength).toBe(dummyData.length);
  });

  it('throws E_ASSET on SHA-256 checksum mismatch', async () => {
    const asset: Asset = {
      schema_version: 1,
      asset_id: 'ast_23j7x62k4x7c',
      kind: 'splat_full',
      format: 'spz',
      uri: 'https://cdn.nammaspace.org/splat.spz',
      sha256: '0000000000000000000000000000000000000000000000000000000000000000',
      bytes: dummyData.length,
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(dummyData.length) }),
      arrayBuffer: async () => dummyData.buffer,
    } as unknown as Response);

    try {
      await fetchAssetWithVerification(asset);
      expect.fail('Should have thrown on checksum mismatch');
    } catch (err: unknown) {
      expect((err as ViewerError).code).toBe('E_ASSET');
      expect((err as ViewerError).message).toContain('checksum mismatch');
    }
  });

  it('falls back to lite asset when full asset download fails and lite is available', async () => {
    const fullHash = '1111111111111111111111111111111111111111111111111111111111111111';
    const liteData = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 42, 43, 44]);
    const liteHash = await computeSha256Hex(liteData.buffer);

    const manifest: SceneManifest = {
      schema_version: 1,
      scene_id: 'scn_23j7x56k3y7a',
      space_id: 'spc_23j7x37m5w2a',
      version: 1,
      created_at: '2026-10-17T15:00:00Z',
      job_id: 'job_23j7x52k5m2b',
      assets: {
        full: 'ast_full1234567',
        lite: 'ast_lite1234567',
      },
      asset_table: {
        ast_full1234567: {
          schema_version: 1,
          asset_id: 'ast_full1234567',
          kind: 'splat_full',
          format: 'spz',
          uri: 'https://cdn.nammaspace.org/full.spz',
          sha256: fullHash,
          bytes: 1000000,
        },
        ast_lite1234567: {
          schema_version: 1,
          asset_id: 'ast_lite1234567',
          kind: 'splat_lite',
          format: 'spz',
          uri: 'https://cdn.nammaspace.org/lite.spz',
          sha256: liteHash,
          bytes: liteData.length,
        },
      },
      transform: {
        world_from_splat: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        scale: 1.0,
        method: 'floor_ransac+tape_pair',
        residuals: { floor_rms_m: 0.02, scale_check_error_pct: 1.0 },
      },
      start_pose: { x: 0, z: 0, yaw_deg: 0 },
      eye_height_m: 1.5,
      bounds: { minX: -1, maxX: 1, minZ: -1, maxZ: 1 },
    };

    // Full asset fetch fails with 500, lite asset succeeds
    let liteFetchCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('full.spz')) {
        return {
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
        } as unknown as Response;
      }
      if (url.includes('lite.spz')) {
        liteFetchCount++;
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-length': String(liteData.length) }),
          arrayBuffer: async () => liteData.buffer,
        } as unknown as Response;
      }
      throw new Error(`Unexpected url: ${url}`);
    });

    const offerLiteCallback = vi.fn();

    // 1. Path with onOfferLite: offers lite via callback and throws error without auto-loading
    await expect(
      loadSceneSplatAsset(manifest, { onOfferLite: offerLiteCallback })
    ).rejects.toThrowError(ViewerError);

    expect(offerLiteCallback).toHaveBeenCalledTimes(1);
    expect(liteFetchCount).toBe(0); // Not loaded automatically!

    // When user triggers the retry action, lite asset loads exactly once
    const retryLiteFn = offerLiteCallback.mock.calls[0][1];
    const userResult = await retryLiteFn();
    expect(userResult.isLite).toBe(true);
    expect(userResult.asset.asset_id).toBe('ast_lite1234567');
    expect(userResult.buffer.byteLength).toBe(liteData.length);
    expect(liteFetchCount).toBe(1); // Loaded exactly once

    // 2. Path without onOfferLite: loads lite automatically exactly once
    liteFetchCount = 0;
    const autoResult = await loadSceneSplatAsset(manifest);
    expect(autoResult.isLite).toBe(true);
    expect(autoResult.asset.asset_id).toBe('ast_lite1234567');
    expect(autoResult.buffer.byteLength).toBe(liteData.length);
    expect(liteFetchCount).toBe(1); // Loaded exactly once
  });

  describe('Asset URL Resolution & HTML Response Handling', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('(a) resolves relative asset URIs to /dev/dev_full.spz when manifest is at /dev/manifest.json, leaving absolute URIs untouched', async () => {
      const requestedUrls: string[] = [];
      const dummyBuffer = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 10, 20, 30, 40]);
      const dummyHash = await computeSha256Hex(dummyBuffer.buffer);

      const mockManifest: SceneManifest = {
        schema_version: 1,
        scene_id: 'scn_23devsynthet',
        space_id: 'spc_23devsynthet',
        version: 1,
        created_at: '2026-10-18T00:00:00Z',
        job_id: 'job_23devsynthet',
        assets: {
          full: 'ast_23devsplatfl',
          lite: 'ast_23devsplatlt',
        },
        asset_table: {
          ast_23devsplatfl: {
            schema_version: 1,
            asset_id: 'ast_23devsplatfl',
            kind: 'splat_full',
            format: 'spz',
            uri: 'dev_full.spz',
            sha256: dummyHash,
            bytes: dummyBuffer.length,
          },
          ast_23devsplatlt: {
            schema_version: 1,
            asset_id: 'ast_23devsplatlt',
            kind: 'splat_lite',
            format: 'spz',
            uri: 'https://cdn.nammaspace.org/absolute_lite.spz',
            sha256: dummyHash,
            bytes: dummyBuffer.length,
          },
        },
        transform: {
          world_from_splat: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          scale: 1.0,
          method: 'floor_ransac+tape_pair',
          residuals: { floor_rms_m: 0.02, scale_check_error_pct: 1.0 },
        },
        start_pose: { x: 0, z: 0, yaw_deg: 0 },
        eye_height_m: 1.5,
        bounds: { minX: -5, maxX: 5, minZ: -5, maxZ: 5 },
      };

      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        requestedUrls.push(url);
        if (url === '/dev/manifest.json') {
          return {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => JSON.parse(JSON.stringify(mockManifest)),
          } as unknown as Response;
        }
        if (url === '/dev/dev_full.spz' || url === 'https://cdn.nammaspace.org/absolute_lite.spz') {
          return {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'application/octet-stream' }),
            arrayBuffer: async () => dummyBuffer.buffer,
          } as unknown as Response;
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      });

      // Verify standalone helper functions
      expect(resolveAssetUrl('dev_full.spz', '/dev/manifest.json')).toBe('/dev/dev_full.spz');
      expect(resolveAssetUrl('https://cdn.nammaspace.org/abs.spz', '/dev/manifest.json')).toBe('https://cdn.nammaspace.org/abs.spz');
      expect(resolveAssetUrl('full.spz', 'scn_x/manifest.json')).toBe('scn_x/full.spz');
      const cloned = JSON.parse(JSON.stringify(mockManifest)) as SceneManifest;
      resolveManifestAssetUris(cloned, '/dev/manifest.json');
      expect(cloned.asset_table.ast_23devsplatfl.uri).toBe('/dev/dev_full.spz');

      // 1. Fetch manifest from /dev/manifest.json
      const manifest = await fetchAndValidateManifest('/dev/manifest.json');

      // Assert that the relative asset URI was resolved against /dev/
      expect(manifest.asset_table.ast_23devsplatfl.uri).toBe('/dev/dev_full.spz');
      // Assert that the absolute URI remained completely untouched
      expect(manifest.asset_table.ast_23devsplatlt.uri).toBe('https://cdn.nammaspace.org/absolute_lite.spz');

      // 2. Load the full asset through loadSceneSplatAsset
      const fullLoaded = await loadSceneSplatAsset(manifest);
      expect(fullLoaded.asset.uri).toBe('/dev/dev_full.spz');
      expect(requestedUrls).toContain('/dev/dev_full.spz');

      // 3. Load the lite asset through loadSceneSplatAsset
      const liteLoaded = await loadSceneSplatAsset(manifest, { preferLite: true });
      expect(liteLoaded.asset.uri).toBe('https://cdn.nammaspace.org/absolute_lite.spz');
      expect(requestedUrls).toContain('https://cdn.nammaspace.org/absolute_lite.spz');
    });

    it('(b) throws E_ASSET with clear wrong-URL message when server returns an HTML page with status 200', async () => {
      const htmlContent = '<!doctype html>\n<html><head><title>Vite SPA</title></head><body><div id="app"></div></body></html>';
      const htmlBytes = new TextEncoder().encode(htmlContent);

      const asset: Asset = {
        schema_version: 1,
        asset_id: 'ast_23devsplatfl',
        kind: 'splat_full',
        format: 'spz',
        uri: '/dev_full.spz',
        sha256: 'f4915c30afae5d1a67571d6551460997924d765fa476a810c7daa1c70d143704',
        bytes: 3392,
      };

      // Case 1: Response header Content-Type is text/html
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
        arrayBuffer: async () => htmlBytes.buffer,
      } as unknown as Response);

      await expect(fetchAssetWithVerification(asset)).rejects.toSatisfy((err: unknown) => {
        const vErr = err as ViewerError;
        return (
          vErr.code === 'E_ASSET' &&
          vErr.message.includes('Server returned an HTML page instead of the asset (wrong URL?)') &&
          vErr.message.includes('/dev_full.spz') &&
          !vErr.message.includes('checksum mismatch')
        );
      });

      // Case 2: Content-Type header missing/octet-stream, but first bytes look like <!doctype html>
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/octet-stream' }),
        arrayBuffer: async () => htmlBytes.buffer,
      } as unknown as Response);

      await expect(fetchAssetWithVerification(asset)).rejects.toSatisfy((err: unknown) => {
        const vErr = err as ViewerError;
        return (
          vErr.code === 'E_ASSET' &&
          vErr.message.includes('Server returned an HTML page instead of the asset (wrong URL?)') &&
          vErr.message.includes('/dev_full.spz') &&
          !vErr.message.includes('checksum mismatch')
        );
      });
    });

    it('(c) end-to-end: loads and verifies real full and lite assets from local static HTTP server', async () => {
      const devDir = path.resolve(__dirname, '../../viewer/public/dev');
      expect(fs.existsSync(devDir)).toBe(true);

      // Simple local static HTTP server using Node http (no extra dependencies)
      const server = http.createServer((req, res) => {
        const reqPath = (req.url || '').split('?')[0].replace(/^\/+/, '');
        const filePath = path.join(devDir, reqPath);
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const ext = path.extname(filePath);
          const contentType = ext === '.json' ? 'application/json' : 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': contentType });
          res.end(fs.readFileSync(filePath));
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
        }
      });

      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${address.port}`;

      try {
        // Restore real Node/global fetch so requests go to the running HTTP server
        globalThis.fetch = originalFetch;

        // 1. Fetch and validate manifest from local static server
        const manifest = await fetchAndValidateManifest('manifest.json', baseUrl);
        expect(manifest.schema_version).toBe(1);

        // Verify that asset URIs were resolved to the static server URL
        const fullAsset = manifest.asset_table[manifest.assets.full];
        const liteAsset = manifest.asset_table[manifest.assets.lite!];
        expect(fullAsset.uri).toBe(`${baseUrl}/dev_full.spz`);
        expect(liteAsset.uri).toBe(`${baseUrl}/dev_lite.spz`);

        // 2. Load full asset and assert real SHA-256 verifies
        const fullLoaded = await loadSceneSplatAsset(manifest);
        expect(fullLoaded.isLite).toBe(false);
        expect(fullLoaded.buffer.byteLength).toBe(fullAsset.bytes);
        expect(fullLoaded.asset.asset_id).toBe(manifest.assets.full);
        const computedFullHash = await computeSha256Hex(fullLoaded.buffer);
        expect(computedFullHash).toBe(fullAsset.sha256);

        // 3. Load lite asset and assert real SHA-256 verifies
        const liteLoaded = await loadSceneSplatAsset(manifest, { preferLite: true });
        expect(liteLoaded.isLite).toBe(true);
        expect(liteLoaded.buffer.byteLength).toBe(liteAsset.bytes);
        expect(liteLoaded.asset.asset_id).toBe(manifest.assets.lite);
        const computedLiteHash = await computeSha256Hex(liteLoaded.buffer);
        expect(computedLiteHash).toBe(liteAsset.sha256);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('verifies every .spz in viewer/public/dev starts with gzip magic 1f 8b (SPZ v3 format required by Spark 2.3.1)', () => {
      const devDir = path.resolve(__dirname, '../../viewer/public/dev');
      expect(fs.existsSync(devDir)).toBe(true);

      const spzFiles = fs.readdirSync(devDir).filter(f => f.endsWith('.spz'));
      expect(spzFiles.length).toBeGreaterThanOrEqual(2);

      for (const spzFile of spzFiles) {
        const filePath = path.join(devDir, spzFile);
        const buffer = fs.readFileSync(filePath);
        expect(buffer.length).toBeGreaterThanOrEqual(4);
        expect(buffer[0]).toBe(0x1f);
        expect(buffer[1]).toBe(0x8b);
      }
    });

    it('throws E_SPZ with "Unsupported SPZ version" when asset starts with NGSP (SPZ v4) or non-gzip header', async () => {
      // 1. Uncompressed SPZ v4 (starts with "NGSP")
      const v4Header = new Uint8Array([0x4e, 0x47, 0x53, 0x50, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00]);
      const v4Hash = await computeSha256Hex(v4Header.buffer);
      const v4Asset: Asset = {
        schema_version: 1,
        asset_id: 'ast_v4test12345',
        kind: 'splat_full',
        format: 'spz',
        uri: '/dev/v4.spz',
        sha256: v4Hash,
        bytes: v4Header.length,
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/octet-stream' }),
        arrayBuffer: async () => v4Header.buffer,
      } as unknown as Response);

      await expect(fetchAssetWithVerification(v4Asset)).rejects.toSatisfy((err: unknown) => {
        const vErr = err as ViewerError;
        return (
          vErr.code === 'E_SPZ' &&
          vErr.message.includes('Unsupported SPZ version') &&
          vErr.message.includes('uncompressed NGSP (SPZ v4)')
        );
      });

      // 2. Non-gzip corrupted header
      const badHeader = new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44]);
      const badHash = await computeSha256Hex(badHeader.buffer);
      const badAsset: Asset = {
        schema_version: 1,
        asset_id: 'ast_bad12345678',
        kind: 'splat_lite',
        format: 'spz',
        uri: '/dev/bad.spz',
        sha256: badHash,
        bytes: badHeader.length,
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/octet-stream' }),
        arrayBuffer: async () => badHeader.buffer,
      } as unknown as Response);

      await expect(fetchAssetWithVerification(badAsset)).rejects.toSatisfy((err: unknown) => {
        const vErr = err as ViewerError;
        return (
          vErr.code === 'E_SPZ' &&
          vErr.message.includes('Unsupported SPZ version') &&
          vErr.message.includes('bytes [00 11 22 33]')
        );
      });
    });

    it('optional: verifies real dev SPZ files decode through Sparks real decoder in Node without GPU', async () => {
      const devDir = path.resolve(__dirname, '../../viewer/public/dev');
      const fullPath = path.join(devDir, 'dev_full.spz');
      const litePath = path.join(devDir, 'dev_lite.spz');

      expect(fs.existsSync(fullPath)).toBe(true);
      expect(fs.existsSync(litePath)).toBe(true);

      const fullBytes = new Uint8Array(fs.readFileSync(fullPath));
      const liteBytes = new Uint8Array(fs.readFileSync(litePath));

      // 1. Spark getSplatFileType detects SPZ via partial gzip decompression
      expect(getSplatFileType(fullBytes)).toBe(SplatFileType.SPZ);
      expect(getSplatFileType(liteBytes)).toBe(SplatFileType.SPZ);

      // 2. Spark transcodeSpz executes real Wasm/Rust SPZ decompression without GPU
      const fullTranscoded = await transcodeSpz({ inputs: [{ fileBytes: fullBytes }] });
      expect(fullTranscoded.fileBytes).toBeDefined();
      expect(fullTranscoded.fileBytes.length).toBeGreaterThan(0);

      const liteTranscoded = await transcodeSpz({ inputs: [{ fileBytes: liteBytes }] });
      expect(liteTranscoded.fileBytes).toBeDefined();
      expect(liteTranscoded.fileBytes.length).toBeGreaterThan(0);

      // Note: Full SplatMesh instantiation in Node throws ReferenceError: Worker is not defined
      // because SplatLoader delegates decoding to a browser Web Worker (WorkerWrapper).
      // Spark's core Wasm decoding functions (transcodeSpz, getSplatFileType) execute headlessly in Node.
    });
  });
});


