/**
 * Namma Space AR: links between the AR page and the normal viewer.
 *   ar.html?scene=<scene id>&to=<place id>   opens AR for that room (going to that place)
 * Exit goes back to the viewer page next to ar.html with the same room and place, so the visitor
 * lands where they left. The route card's AR button and the printed QR codes go the other way.
 * Pure functions, unit tested.
 */

/** Link parameters the two pages share; everything else stays behind */
const KEEP_PARAMS = ['scene', 'to', 'from'];

/** The normal viewer's address for this AR page address, keeping only scene, to and from. */
export function viewerUrlFromAr(href: string): string {
  const u = new URL(href);
  // ar.html, or "ar" where the host serves pages without the extension
  u.pathname = u.pathname.replace(/\/ar(\.html)?$/, '/');
  const kept = new URLSearchParams();
  for (const p of KEEP_PARAMS) {
    const v = u.searchParams.get(p);
    if (v) kept.set(p, v);
  }
  u.search = kept.toString();
  u.hash = '';
  return u.toString();
}

/** The place the AR page was opened for (?to=), or null */
export function arTarget(href: string): string | null {
  return new URL(href).searchParams.get('to')?.trim() || null;
}

/** Switches the viewer passes on to the AR page: the room, and the test switches for phone tests */
const TO_AR_PARAMS = ['scene', 'marks', 'pois', 'debug'];

/** The AR page next to this viewer page, going to `placeId` (the route card's AR button). */
export function arUrlFromViewer(href: string, placeId: string): string {
  const u = new URL(href);
  u.pathname = /\/(index\.html)?$/.test(u.pathname)
    ? u.pathname.replace(/\/(index\.html)?$/, '/ar.html')
    : `${u.pathname}/ar.html`;
  const kept = new URLSearchParams();
  for (const p of TO_AR_PARAMS) {
    const v = u.searchParams.get(p);
    if (v) kept.set(p, v);
  }
  kept.set('to', placeId);
  u.search = kept.toString();
  u.hash = '';
  return u.toString();
}

/** A clean link to this AR page for printing as a QR code: the room only, plus the place when given. */
export function arPlaceUrl(arHref: string, placeId: string | null): string {
  const u = new URL(arHref);
  const scene = u.searchParams.get('scene');
  const kept = new URLSearchParams();
  if (scene) kept.set('scene', scene);
  if (placeId) kept.set('to', placeId);
  u.search = kept.toString();
  u.hash = '';
  return u.toString();
}
