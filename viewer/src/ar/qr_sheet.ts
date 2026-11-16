/**
 * Namma Space AR: a printable sheet of QR codes (ar.html?qr=1, AR build spec "direct link and QR").
 * One code opens AR with no place picked, then one per place opens AR going to that place.
 * Loaded on demand with the QR encoder, so the AR guide itself does not download it.
 */

import { encode } from 'uqr';
import type { POI } from '../contracts/types.js';
import { arPlaceUrl } from './links.js';
import { phrase, type Lang } from './phrases.js';

const STYLE = `
html, body { overflow: auto !important; height: auto !important; background: #ffffff !important; color: #0a0a0c; user-select: text !important; -webkit-user-select: text !important; }
.ar-qr-sheet { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; max-width: 960px; margin: 0 auto; padding: 24px 16px 48px; }
.ar-qr-sheet h1 { font-size: 24px; margin: 0 0 8px; }
.ar-qr-sheet .ar-qr-intro { margin: 0 0 16px; color: #444; font-size: 15px; line-height: 1.4; }
.ar-qr-sheet .ar-qr-print { min-height: 44px; padding: 0 20px; border-radius: 8px; border: 0; background: #0a0a0c; color: #ffd700; font-weight: 700; font-size: 16px; cursor: pointer; margin-bottom: 20px; }
.ar-qr-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px; }
.ar-qr-card { border: 2px solid #0a0a0c; border-radius: 12px; padding: 14px; text-align: center; break-inside: avoid; page-break-inside: avoid; }
.ar-qr-card svg { display: block; width: 100%; max-width: 180px; height: auto; margin: 0 auto 10px; }
.ar-qr-name { font-size: 18px; font-weight: 800; margin: 0 0 4px; }
.ar-qr-hint { font-size: 13px; color: #444; margin: 0 0 6px; }
.ar-qr-link { font-size: 10px; color: #666; word-break: break-all; margin: 0; }
@media print { .ar-qr-print { display: none; } .ar-qr-sheet { padding: 0; } }
`;

/** QR code as an SVG string (dark modules on white) */
export function qrSvg(text: string): string {
  const m = encode(text, { ecc: 'M', border: 2 }).data;
  const n = m.length;
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) d += `M${x} ${y}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-hidden="true"><rect width="${n}" height="${n}" fill="#fff"/><path fill="#0a0a0c" d="${d}"/></svg>`;
}

function card(name: string, hint: string, url: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'ar-qr-card';
  el.innerHTML = qrSvg(url);
  const h = document.createElement('p');
  h.className = 'ar-qr-name';
  h.textContent = name;
  const s = document.createElement('p');
  s.className = 'ar-qr-hint';
  s.textContent = hint;
  const l = document.createElement('p');
  l.className = 'ar-qr-link';
  l.textContent = url;
  el.append(h, s, l);
  return el;
}

/** Replaces the page with the QR sheet for `places` (null when the room data failed). */
export function showQrSheet(host: HTMLElement, lang: Lang, room: string, places: POI[] | null): void {
  const t = (k: Parameters<typeof phrase>[1], v: Record<string, string> = {}) => phrase(lang, k, v);
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.append(style);
  document.title = t('qrTitle', { room });

  const sheet = document.createElement('main');
  sheet.className = 'ar-qr-sheet';
  const h1 = document.createElement('h1');
  h1.textContent = t('qrTitle', { room });
  const intro = document.createElement('p');
  intro.className = 'ar-qr-intro';
  intro.textContent = places ? t('qrIntro') : t('qrFailed');
  sheet.append(h1, intro);

  if (places) {
    const print = document.createElement('button');
    print.type = 'button';
    print.className = 'ar-qr-print';
    print.textContent = t('qrPrint');
    print.addEventListener('click', () => window.print());
    const grid = document.createElement('div');
    grid.className = 'ar-qr-grid';
    const here = window.location.href;
    grid.append(card(t('qrStart'), t('qrStartHint'), arPlaceUrl(here, null)));
    for (const p of places) grid.append(card(p.name, t('qrScan'), arPlaceUrl(here, p.poi_id)));
    sheet.append(print, grid);
    if (places.length === 0) {
      const none = document.createElement('p');
      none.className = 'ar-qr-intro';
      none.textContent = t('qrNone');
      sheet.append(none);
    }
  }
  host.replaceWith(sheet);
}
