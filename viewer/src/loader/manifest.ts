/**
 * Namma Space: Scene Manifest & Asset Loader
 * Follows SPEC.md Section 7:
 * - Reads ?scene= from URL
 * - Fetches manifest.json from configurable base URL
 * - Validates schema with TS validator (rejects unknown schema_version)
 * - Verifies asset SHA-256 checksum on load
 * - Maps errors to E_MANIFEST, E_ASSET, E_WEBGL, E_SPZ with human-readable messages
 * - Offers lite asset fallback when full asset fails
 */

import { validateSceneManifest } from '../contracts/validator.js';
import type { SceneManifest, Asset } from '../contracts/types.js';
import { ViewerError } from '../types.js';

export function parseSceneParam(searchOrUrl?: string): string | null {
  try {
    let search = searchOrUrl;
    if (!search && typeof window !== 'undefined' && window.location) {
      search = window.location.search;
    }
    if (!search) return null;

    if (search.startsWith('http://') || search.startsWith('https://') || search.includes('?')) {
      const parsedUrl = new URL(search, 'http://localhost');
      return parsedUrl.searchParams.get('scene') || null;
    }

    const params = new URLSearchParams(search);
    return params.get('scene') || null;
  } catch {
    return null;
  }
}

export function resolveManifestUrl(sceneId: string, baseUrl = ''): string {
  if (sceneId.startsWith('http://') || sceneId.startsWith('https://')) {
    return sceneId;
  }

  const cleanBase = baseUrl.replace(/\/+$/, '');
  const cleanScene = sceneId.replace(/^\/+|\/+$/g, '');

  if (!cleanScene) {
    return cleanBase ? `${cleanBase}/manifest.json` : 'manifest.json';
  }

  if (cleanScene.endsWith('.json')) {
    return cleanBase ? `${cleanBase}/${cleanScene}` : (sceneId.startsWith('/') ? `/${cleanScene}` : cleanScene);
  }

  return cleanBase ? `${cleanBase}/${cleanScene}/manifest.json` : `${cleanScene}/manifest.json`;
}

/**
 * Resolves a relative asset URI against the manifest URL directory.
 * Absolute http(s) URIs stay as they are.
 */
export function resolveAssetUrl(assetUri: string, manifestUrl: string): string {
  if (assetUri.startsWith('http://') || assetUri.startsWith('https://')) {
    return assetUri;
  }

  const isAbsolute = manifestUrl.startsWith('http://') || manifestUrl.startsWith('https://');
  const base = isAbsolute
    ? new URL(manifestUrl)
    : new URL(manifestUrl.startsWith('/') ? manifestUrl : `/${manifestUrl}`, 'http://localhost');

  const resolved = new URL(assetUri, base);

  if (isAbsolute) {
    return resolved.href;
  }
  // A relative manifest URL (no leading slash) keeps its assets relative too, so the viewer
  // also works when hosted under a sub-path such as https://user.github.io/repo/
  const path = resolved.pathname + resolved.search;
  return manifestUrl.startsWith('/') ? path : path.replace(/^\//, '');
}

/**
 * Resolves all asset URIs in a manifest asset_table in-place against the manifest URL.
 */
export function resolveManifestAssetUris(manifest: SceneManifest, manifestUrl: string): SceneManifest {
  if (manifest.asset_table) {
    for (const asset of Object.values(manifest.asset_table)) {
      if (asset && typeof asset.uri === 'string') {
        asset.uri = resolveAssetUrl(asset.uri, manifestUrl);
      }
    }
  }
  return manifest;
}

export async function fetchAndValidateManifest(
  sceneId: string,
  baseUrl = ''
): Promise<SceneManifest> {
  const url = resolveManifestUrl(sceneId, baseUrl);

  let response: Response;
  try {
    response = await fetch(url);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ViewerError(
      'E_MANIFEST',
      `Failed to connect to manifest server at "${url}": ${msg}`
    );
  }

  if (!response.ok) {
    throw new ViewerError(
      'E_MANIFEST',
      `Failed to fetch manifest from "${url}": HTTP ${response.status} (${response.statusText})`
    );
  }

  // Check Content-Type and response body for HTML (e.g. Vite dev server 200 fallback to index.html)
  const contentType = response.headers?.get?.('content-type') || '';
  if (contentType.toLowerCase().includes('text/html')) {
    throw new ViewerError(
      'E_MANIFEST',
      `Scene not found: the server returned a web page instead of manifest.json at ${url}`
    );
  }

  let text: string | undefined;
  if (typeof response.text === 'function') {
    text = await response.text();
    const trimmed = text.trimStart().toLowerCase();
    if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')) {
      throw new ViewerError(
        'E_MANIFEST',
        `Scene not found: the server returned a web page instead of manifest.json at ${url}`
      );
    }
  }

  let data: unknown;
  try {
    if (text !== undefined) {
      data = JSON.parse(text);
    } else {
      data = await response.json();
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ViewerError(
      'E_MANIFEST',
      `Manifest at "${url}" contains invalid JSON: ${msg}`
    );
  }

  if (!data || typeof data !== 'object') {
    throw new ViewerError(
      'E_MANIFEST',
      `Manifest at "${url}" must be a JSON object`
    );
  }

  const raw = data as Record<string, unknown>;
  if (raw.schema_version !== 1) {
    throw new ViewerError(
      'E_MANIFEST',
      `Unsupported schema version: ${String(raw.schema_version)}. Only schema_version 1 is supported.`
    );
  }

  const validation = validateSceneManifest(data);
  if (!validation.valid) {
    throw new ViewerError(
      'E_MANIFEST',
      `Manifest validation failed for "${url}": ${validation.errors.join('; ')}`
    );
  }

  const manifest = data as SceneManifest;
  resolveManifestAssetUris(manifest, url);
  return manifest;
}

export async function computeSha256Hex(buffer: ArrayBuffer): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('Web Cryptography API (crypto.subtle) is not available');
  }

  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function fetchAssetWithVerification(
  asset: Asset,
  onProgress?: (progress: number) => void,
  canFallbackToLite = false
): Promise<ArrayBuffer> {
  let response: Response;
  try {
    response = await fetch(asset.uri);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ViewerError(
      'E_ASSET',
      `Network failure loading asset "${asset.asset_id}" (${asset.uri}): ${msg}`,
      canFallbackToLite
    );
  }

  if (!response.ok) {
    throw new ViewerError(
      'E_ASSET',
      `Failed to download asset "${asset.asset_id}" from "${asset.uri}": HTTP ${response.status} (${response.statusText})`,
      canFallbackToLite
    );
  }

  // Defensive check 1: Response Content-Type header is text/html
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/html')) {
    throw new ViewerError(
      'E_ASSET',
      `Server returned an HTML page instead of the asset (wrong URL?): "${asset.uri}"`,
      canFallbackToLite
    );
  }

  let buffer: ArrayBuffer;

  // Stream with progress if body reader is available
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const totalBytes = Number(response.headers.get('content-length')) || asset.bytes || 0;
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        receivedBytes += value.length;
        if (totalBytes > 0 && onProgress) {
          onProgress(Math.min(1.0, receivedBytes / totalBytes));
        }
      }
    }

    const merged = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    buffer = merged.buffer;
  } else {
    buffer = await response.arrayBuffer();
    if (onProgress) onProgress(1.0);
  }

  // Defensive check 2: First bytes look like HTML (<!doctype or <html)
  const headLength = Math.min(buffer.byteLength, 128);
  const headText = new TextDecoder().decode(new Uint8Array(buffer, 0, headLength)).trim().toLowerCase();
  if (headText.startsWith('<!doctype') || headText.startsWith('<html')) {
    throw new ViewerError(
      'E_ASSET',
      `Server returned an HTML page instead of the asset (wrong URL?): "${asset.uri}"`,
      canFallbackToLite
    );
  }

  // Verify SHA-256 checksum
  const calculatedHex = await computeSha256Hex(buffer);
  const expectedHex = asset.sha256.toLowerCase();

  if (calculatedHex !== expectedHex) {
    throw new ViewerError(
      'E_ASSET',
      `SHA-256 checksum mismatch for asset "${asset.asset_id}". Expected ${expectedHex}, got ${calculatedHex}`,
      canFallbackToLite
    );
  }

  // 3. Defensive check: SPZ version and container magic bytes (must be gzip-wrapped SPZ v2/v3)
  if (asset.format === 'spz' || asset.uri.endsWith('.spz')) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
      let found = 'insufficient bytes';
      if (bytes.length >= 4 && bytes[0] === 0x4e && bytes[1] === 0x47 && bytes[2] === 0x53 && bytes[3] === 0x50) {
        found = 'uncompressed NGSP (SPZ v4)';
      } else if (bytes.length > 0) {
        found = `bytes [${Array.from(bytes.slice(0, Math.min(bytes.length, 4))).map(b => b.toString(16).padStart(2, '0')).join(' ')}]`;
      }
      throw new ViewerError(
        'E_SPZ',
        `Unsupported SPZ version (found ${found}, expected gzip-compressed SPZ v2/v3 starting with 1f 8b): "${asset.uri}"`,
        canFallbackToLite
      );
    }
  }

  return buffer;
}

export function checkWebGL2Support(canvas?: HTMLCanvasElement): boolean {
  try {
    const c = canvas || (typeof document !== 'undefined' ? document.createElement('canvas') : null);
    if (!c) return false;
    const gl = c.getContext('webgl2');
    return Boolean(gl);
  } catch {
    return false;
  }
}

export function assertWebGL2(canvas?: HTMLCanvasElement): void {
  if (!checkWebGL2Support(canvas)) {
    throw new ViewerError(
      'E_WEBGL',
      'WebGL 2.0 is not supported or is disabled in your browser. A WebGL2-compatible GPU/driver is required.'
    );
  }
}

export interface LoadedSceneAsset {
  asset: Asset;
  buffer: ArrayBuffer;
  isLite: boolean;
}

export interface LoadSceneOptions {
  preferLite?: boolean;
  onProgress?: (progress: number) => void;
  onOfferLite?: (error: ViewerError, retryLite: () => Promise<LoadedSceneAsset>) => void;
  manifestUrl?: string;
}

/**
 * Loads scene splat asset (full by default), with graceful fallback to lite asset.
 */
export async function loadSceneSplatAsset(
  manifest: SceneManifest,
  options: LoadSceneOptions = {}
): Promise<LoadedSceneAsset> {
  if (options.manifestUrl) {
    resolveManifestAssetUris(manifest, options.manifestUrl);
  }

  const fullAssetId = manifest.assets.full;
  const liteAssetId = manifest.assets.lite;
  const hasLite = Boolean(liteAssetId && manifest.asset_table[liteAssetId]);

  // If user requested lite directly and lite exists:
  if (options.preferLite && hasLite && liteAssetId) {
    const liteAsset = manifest.asset_table[liteAssetId];
    const buffer = await fetchAssetWithVerification(liteAsset, options.onProgress, false);
    return { asset: liteAsset, buffer, isLite: true };
  }

  const fullAsset = manifest.asset_table[fullAssetId];
  if (!fullAsset) {
    throw new ViewerError(
      'E_MANIFEST',
      `Full asset ID "${fullAssetId}" declared in assets not found in asset_table.`
    );
  }

  try {
    const buffer = await fetchAssetWithVerification(fullAsset, options.onProgress, hasLite);
    return { asset: fullAsset, buffer, isLite: false };
  } catch (err: unknown) {
    if (err instanceof ViewerError && err.code === 'E_ASSET' && hasLite && liteAssetId) {
      const liteAsset = manifest.asset_table[liteAssetId];
      const retryLiteFn = async () => {
        const liteBuf = await fetchAssetWithVerification(liteAsset, options.onProgress, false);
        return { asset: liteAsset, buffer: liteBuf, isLite: true };
      };

      if (options.onOfferLite) {
        options.onOfferLite(err, retryLiteFn);
        throw err;
      }

      // If no interactive handler attached, automatically fallback to lite
      return await retryLiteFn();
    }
    throw err;
  }
}
