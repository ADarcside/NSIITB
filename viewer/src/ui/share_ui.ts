/**
 * Namma Space: Share a place (loaded on demand with the QR encoder, so visitors who never share
 * don't download it). Shows a QR code to print or scan, the link, Copy and the phone's own share
 * sheet where there is one.
 */

import { ensureTokens, icon, trapTab } from './tokens.js';

const STYLE_ID = 'namma-share-style';
const CSS = `
#share-dialog { z-index: 210; font-family: var(--ns-font); color: var(--ns-text); }
.share-card { max-width: 340px; text-align: center; }
.share-sub { margin: calc(-1 * var(--ns-space-3)) 0 var(--ns-space-4); color: var(--ns-text-muted); font-size: var(--ns-fs-sm); }
.share-qr {
  display: block;
  width: min(220px, 60vw);
  height: auto;
  margin: 0 auto var(--ns-space-4);
  border-radius: var(--ns-radius);
  background: #ffffff;
  padding: 10px;
}
.share-link { width: 100%; margin-bottom: var(--ns-space-3); text-overflow: ellipsis; }
.share-actions { display: flex; gap: var(--ns-space-2); }
.share-actions .ns-btn { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
`;

/** QR code as an SVG string: dark squares on white, readable by any phone camera. */
export function qrSvg(url: string, matrix: boolean[][]): string {
  const n = matrix.length;
  let d = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) if (matrix[y][x]) d += `M${x} ${y}h1v1h-1z`;
  }
  const label = url.replace(/[<>&"']/g, '');
  return `<svg class="share-qr" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="QR code for ${label}"><path fill="#0a0a0c" d="${d}"/></svg>`;
}

export interface ShareOptions {
  /** Shown in the heading, e.g. the place name */
  title: string;
  /** Second line, e.g. "Opens the route from Entrance" */
  subtitle?: string;
  url: string;
}

/** Opens the share dialog; resolves when it closes. */
export async function openShareDialog(o: ShareOptions): Promise<void> {
  ensureTokens();
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  if (document.pointerLockElement) document.exitPointerLock();
  const { encode } = await import('uqr');
  const qr = encode(o.url, { ecc: 'M', border: 0 });
  const returnFocus = document.activeElement as HTMLElement | null;

  return new Promise(resolve => {
    const scrim = document.createElement('div');
    scrim.className = 'ns-scrim ns-ui';
    scrim.id = 'share-dialog';
    const card = document.createElement('div');
    card.className = 'ns-dialog share-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'share-title');

    const h = document.createElement('h2');
    h.id = 'share-title';
    h.className = 'ns-dialog-title';
    h.textContent = `Share ${o.title}`;
    card.append(h);
    if (o.subtitle) {
      const sub = document.createElement('p');
      sub.className = 'share-sub';
      sub.textContent = o.subtitle;
      card.append(sub);
    }
    const qrWrap = document.createElement('div');
    qrWrap.innerHTML = qrSvg(o.url, qr.data);
    card.append(qrWrap);

    const link = document.createElement('input');
    link.className = 'ns-input share-link';
    link.readOnly = true;
    link.value = o.url;
    link.setAttribute('aria-label', 'Link to this place');
    link.addEventListener('focus', () => link.select());
    card.append(link);

    const actions = document.createElement('div');
    actions.className = 'share-actions';
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'ns-btn ns-btn-primary ns-press';
    copyBtn.textContent = 'Copy link';
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(o.url);
        copyBtn.textContent = 'Copied';
      } catch {
        link.focus();
        link.select();
        copyBtn.textContent = 'Press Ctrl+C';
      }
      setTimeout(() => (copyBtn.textContent = 'Copy link'), 1800);
    });
    actions.append(copyBtn);
    if (typeof navigator.share === 'function') {
      const shareBtn = document.createElement('button');
      shareBtn.type = 'button';
      shareBtn.className = 'ns-btn ns-press';
      shareBtn.innerHTML = `${icon('share', 15)}<span>Share…</span>`;
      shareBtn.addEventListener('click', () => {
        navigator.share({ title: o.title, url: o.url }).catch(() => {
          /* the visitor closed the share sheet */
        });
      });
      actions.append(shareBtn);
    }
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ns-btn ns-press';
    closeBtn.textContent = 'Close';
    actions.append(closeBtn);
    card.append(actions);
    scrim.append(card);

    const done = () => {
      window.removeEventListener('keydown', onKey, true);
      scrim.remove();
      returnFocus?.focus?.();
      resolve();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        done();
      }
    };
    closeBtn.addEventListener('click', done);
    scrim.addEventListener('click', e => {
      if (e.target === scrim) done();
    });
    // Keys stay in the dialog, not in the walk controls
    scrim.addEventListener('keydown', e => {
      trapTab(card, e);
      e.stopPropagation();
    });
    window.addEventListener('keydown', onKey, true);
    document.body.appendChild(scrim);
    copyBtn.focus();
  });
}
