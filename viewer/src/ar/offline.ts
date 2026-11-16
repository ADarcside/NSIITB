/**
 * Namma Space AR: switches on the offline copy of the AR page (worker in ar_sw.js, copied to
 * ar-sw.js by an AR build). Built sites only; the dev server registers nothing.
 *
 * On the first visit the page and its scripts load before the worker starts, so once the worker
 * is ready and the room data is in, the files this page has loaded are stored as well. After that
 * one visit online, a route works in flight mode.
 */

/** Same name as CACHE in ar_sw.js (checked by a test) */
export const AR_CACHE = 'namma-ar-v1';

export function startOffline(roomLoaded: Promise<unknown>): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  void (async () => {
    try {
      // Scope "./ar": the worker controls only the AR page, never the normal viewer
      await navigator.serviceWorker.register('./ar-sw.js', { scope: './ar' });
      await navigator.serviceWorker.ready;
      await roomLoaded.catch(() => undefined);
      await storeLoadedFiles();
    } catch (err) {
      console.warn('[AR] Offline copy not available:', err);
    }
  })();
}

/** Stores the page and every same-site file it has loaded so far, unless already stored */
async function storeLoadedFiles(): Promise<void> {
  const urls = new Set<string>([window.location.href]);
  for (const e of performance.getEntriesByType('resource')) {
    if (new URL(e.name).origin === window.location.origin) urls.add(e.name);
  }
  const cache = await caches.open(AR_CACHE);
  await Promise.all(
    [...urls].map(async u => {
      if (await cache.match(u)) return;
      try {
        const res = await fetch(u);
        if (res.ok) await cache.put(u, res);
      } catch {
        // Offline already, or the file is gone: nothing to store
      }
    })
  );
}
