/**
 * Namma Space: links that open the viewer already routing to a place (Round 2/3).
 *   ?to=<poi id or name>               route from wherever the visitor starts
 *   ?to=<poi>&from=<poi>               route between two places (e.g. a QR code at the entrance)
 * Ids are what Share writes (they survive renames); names are accepted so people can type links.
 */

import type { POI } from '../contracts/types.js';
import { searchPois, tokens } from './search.js';

/** Viewer-session switches a shared link must not carry over */
const DROP_PARAMS = ['tag', 'room', 'mp', 'mpdemo', 'pois', 'quality', 'format', 'ply', 'to', 'from'];

/** Link to this viewer page that opens routing to `to` (from `from`, when given). */
export function shareUrl(href: string, to: POI, from?: POI | null): string {
  const u = new URL(href);
  for (const p of DROP_PARAMS) u.searchParams.delete(p);
  u.hash = '';
  if (from) u.searchParams.set('from', from.poi_id);
  u.searchParams.set('to', to.poi_id);
  return u.toString();
}

/** Score a fuzzy match must reach before a typed name in a link counts as that place */
const LINK_MATCH_SCORE = 0.7;

/** Place named by a link: an exact id, else an exact name or alias, else a confident search match. */
export function resolvePoiRef(pois: POI[], ref: string | null | undefined): POI | null {
  const r = (ref ?? '').trim();
  if (!r) return null;
  const byId = pois.find(p => p.poi_id === r);
  if (byId) return byId;
  const key = tokens(r).join(' ');
  if (!key) return null;
  const exact = pois.find(p => [p.name, ...(p.aliases ?? [])].some(n => tokens(n).join(' ') === key));
  if (exact) return exact;
  const [best] = searchPois(pois, r, 1);
  return best && best.score >= LINK_MATCH_SCORE ? best.poi : null;
}
