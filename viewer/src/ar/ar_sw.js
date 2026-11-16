/**
 * Namma Space AR: offline copy of the AR page (AR build spec, "Offline").
 *
 * Registered by ar.html with the scope "./ar", so it controls only the AR page and never the
 * normal viewer (index.html is outside that scope and is never touched). For the AR page it goes
 * to the network first and keeps a copy of every answer (the page, its scripts and styles, and
 * the small scene files: manifest, tags, floor map). With no connection it answers from that copy,
 * so a route still works in flight mode after one visit online. Tags are therefore fresh whenever
 * there is a connection.
 *
 * If the AR page is gone from the site (a build without AR), the worker removes itself and its copy.
 * Plain script, copied as-is to ar-sw.js next to ar.html by the build (vite.config.ts).
 */

const CACHE = 'namma-ar-v1';

/** True for the AR page itself: …/ar.html or …/ar */
function isArPage(url) {
  return /\/ar(\.html)?$/.test(new URL(url).pathname);
}

/** Requests the worker handles: plain GETs over http(s); everything else goes straight through */
function handles(request) {
  return request.method === 'GET' && /^https?:$/.test(new URL(request.url).protocol);
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request);
    if (request.mode === 'navigate' && isArPage(request.url) && res.status === 404) {
      // The AR page was taken off the site: stop serving a copy of it
      await caches.delete(CACHE);
      await self.registration.unregister();
      return res;
    }
    if (res.ok && (res.type === 'basic' || res.type === 'cors')) await cache.put(request, res.clone());
    return res;
  } catch (err) {
    // Offline: the stored copy. ignoreVary because module scripts send an Origin header that the
    // stored copy was not fetched with; the link's query (such as ?to=) does not change the file.
    const hit =
      (await cache.match(request, { ignoreVary: true })) ||
      (await cache.match(request, { ignoreVary: true, ignoreSearch: true }));
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (!handles(event.request)) return;
  event.respondWith(networkFirst(event.request));
});

// For the unit test (tests/viewer/ar_sw.test.ts); harmless in the browser
self.__nammaArSw = { CACHE, isArPage, handles };
