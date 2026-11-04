/**
 * The warning shown before the Round 2 page switches into multiplayer: the mic turns on in a room
 * and anyone with the invite link can join. Small and always in the main bundle; the multiplayer
 * code itself only downloads after Continue.
 */

import { ensureTokens } from './tokens.js';

const STYLE_ID = 'namma-mp-switch';
const CSS = `
  .mps-scrim { position: fixed; inset: 0; z-index: 200; display: grid; place-items: center; padding: 16px;
    background: var(--ns-scrim); font-family: var(--ns-font); color: var(--ns-text); }
  .mps-card { width: min(460px, 100%); max-height: calc(100dvh - 32px); overflow: auto; overscroll-behavior: contain; background: var(--ns-surface-strong); border: 1px solid var(--ns-border-strong);
    border-radius: var(--ns-radius-lg); box-shadow: var(--ns-shadow); padding: var(--ns-space-5); display: grid; gap: var(--ns-space-3); }
  .mps-card h2 { font-size: var(--ns-fs-xl); color: var(--ns-accent); letter-spacing: var(--ns-heading-ls); text-transform: uppercase; }
  .mps-card p { font-size: var(--ns-fs-md); color: var(--ns-text-muted); line-height: 1.5; }
  .mps-card ul { display: grid; gap: 8px; padding-left: 18px; font-size: var(--ns-fs-md); line-height: 1.45; }
  .mps-card li::marker { color: var(--ns-accent); }
  .mps-actions { display: flex; gap: var(--ns-space-2); justify-content: flex-end; margin-top: var(--ns-space-2); }
  .mps-btn { font: inherit; font-size: var(--ns-fs-md); font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; cursor: pointer;
    border-radius: var(--ns-radius-sm); padding: 10px 16px; border: 1px solid var(--ns-border-strong); background: var(--ns-row); color: var(--ns-text); }
  .mps-btn:hover { background: var(--ns-row-hover); }
  .mps-btn.primary { background: var(--ns-primary); color: var(--ns-on-accent); border: none; box-shadow: var(--ns-glow); }
  .mps-btn.primary:hover { background: var(--ns-primary-hover); }
  .mps-btn:focus-visible { outline: 2px solid var(--ns-focus); outline-offset: 2px; }
`;

export interface SwitchWarningOptions {
  /** Room code from an invite link, or null when the player is about to create a room */
  joinCode: string | null;
}

/** Resolves true on Continue, false on Cancel, Escape or a click outside the card */
export function confirmMultiplayerSwitch(o: SwitchWarningOptions): Promise<boolean> {
  ensureTokens();
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  if (document.pointerLockElement) document.exitPointerLock();

  return new Promise(resolve => {
    const scrim = document.createElement('div');
    scrim.className = 'mps-scrim';
    scrim.id = 'mp-switch-warning';
    const joining = o.joinCode !== null;
    scrim.innerHTML = `
      <div class="mps-card" role="alertdialog" aria-modal="true" aria-labelledby="mps-title" aria-describedby="mps-body">
        <h2 id="mps-title">${joining ? 'Join a friend’s room?' : 'Switch to multiplayer?'}</h2>
        <div id="mps-body">
          <p>${joining ? 'A friend invited you to walk this space together.' : 'You will pick a character, create a room and get an invite link for your friends.'}</p>
          <ul>
            <li><b>Your microphone turns on</b> when you enter the room, and everyone in it hears you. Press V to mute.</li>
            <li>Anyone with the invite link can join while the room is open (2 to 6 people, depending on the room size).</li>
            <li>Search, places and paths keep working. Leave the room any time to go back to exploring alone.</li>
          </ul>
        </div>
        <div class="mps-actions">
          <button type="button" class="mps-btn" data-act="cancel">Cancel</button>
          <button type="button" class="mps-btn primary" data-act="ok">Continue</button>
        </div>
      </div>`;
    const done = (ok: boolean) => {
      window.removeEventListener('keydown', onKey, true);
      scrim.remove();
      resolve(ok);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        done(false);
      }
    };
    scrim.addEventListener('click', e => {
      const act = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-act]')?.dataset.act : undefined;
      if (act) done(act === 'ok');
      else if (e.target === scrim) done(false);
    });
    // Keys stay in the dialog, not in the walk controls
    scrim.addEventListener('keydown', e => e.stopPropagation());
    window.addEventListener('keydown', onKey, true);
    document.body.appendChild(scrim);
    scrim.querySelector<HTMLButtonElement>('[data-act="ok"]')?.focus();
  });
}
