/**
 * Namma Space: Walk feel settings (laptops, outside tag mode)
 * A small "Walk feel" section at the bottom of the Help card: head bob on/off, tilt and shake on/off
 * (for anyone who gets motion sick), mouse sensitivity and Walk field of view. Saved on this device.
 */

import { DEFAULT_FEEL_SETTINGS, type WalkFeelSettings } from '../controls/movement.js';

const STORAGE_KEY = 'namma.walkFeel';
export const FOV_RANGE = { min: 50, max: 90 } as const;
export const SENSITIVITY_RANGE = { min: 0.3, max: 2.5 } as const;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Reads saved settings; anything missing or broken falls back to the defaults. */
export function loadFeelSettings(storage: Pick<Storage, 'getItem'> | null = safeStorage()): WalkFeelSettings {
  const out = { ...DEFAULT_FEEL_SETTINGS };
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return out;
    const s = JSON.parse(raw) as Partial<WalkFeelSettings>;
    if (typeof s.headBob === 'boolean') out.headBob = s.headBob;
    if (typeof s.tiltShake === 'boolean') out.tiltShake = s.tiltShake;
    if (typeof s.fovDeg === 'number' && Number.isFinite(s.fovDeg)) out.fovDeg = clamp(s.fovDeg, FOV_RANGE.min, FOV_RANGE.max);
    if (typeof s.sensitivity === 'number' && Number.isFinite(s.sensitivity)) {
      out.sensitivity = clamp(s.sensitivity, SENSITIVITY_RANGE.min, SENSITIVITY_RANGE.max);
    }
  } catch {
    /* bad JSON or blocked storage: defaults */
  }
  return out;
}

export function saveFeelSettings(s: WalkFeelSettings, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* not saved (private mode) */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Adds the Walk feel section to the Help card (before its close button).
 * onChange gets the full settings after every change; they are saved here.
 */
export function mountFeelSettings(
  card: HTMLElement,
  initial: WalkFeelSettings,
  onChange: (s: WalkFeelSettings) => void
): void {
  let current = { ...initial };
  const section = document.createElement('section');
  section.className = 'feel-settings';
  section.setAttribute('aria-labelledby', 'feel-settings-title');
  section.innerHTML = `
    <h3 id="feel-settings-title">Walk feel</h3>
    <label class="feel-row"><span>Head bob</span><input type="checkbox" data-k="headBob"></label>
    <label class="feel-row"><span>Tilt &amp; shake</span><input type="checkbox" data-k="tiltShake"></label>
    <label class="feel-row"><span>Mouse speed <output data-o="sensitivity"></output></span>
      <input type="range" data-k="sensitivity" min="${SENSITIVITY_RANGE.min}" max="${SENSITIVITY_RANGE.max}" step="0.1"></label>
    <label class="feel-row"><span>Field of view <output data-o="fovDeg"></output></span>
      <input type="range" data-k="fovDeg" min="${FOV_RANGE.min}" max="${FOV_RANGE.max}" step="1"></label>
    <button type="button" class="feel-reset">Reset to defaults</button>
  `;
  const input = (k: keyof WalkFeelSettings) => section.querySelector<HTMLInputElement>(`[data-k="${k}"]`)!;
  const output = (k: keyof WalkFeelSettings) => section.querySelector<HTMLOutputElement>(`[data-o="${k}"]`)!;

  const show = () => {
    input('headBob').checked = current.headBob;
    input('tiltShake').checked = current.tiltShake;
    input('sensitivity').value = String(current.sensitivity);
    input('fovDeg').value = String(current.fovDeg);
    output('sensitivity').textContent = `${current.sensitivity.toFixed(1)}x`;
    output('fovDeg').textContent = `${Math.round(current.fovDeg)}°`;
  };
  const commit = () => {
    show();
    saveFeelSettings(current);
    onChange({ ...current });
  };

  input('headBob').addEventListener('change', () => { current.headBob = input('headBob').checked; commit(); });
  input('tiltShake').addEventListener('change', () => { current.tiltShake = input('tiltShake').checked; commit(); });
  input('sensitivity').addEventListener('input', () => { current.sensitivity = Number(input('sensitivity').value); commit(); });
  input('fovDeg').addEventListener('input', () => { current.fovDeg = Number(input('fovDeg').value); commit(); });
  section.querySelector('.feel-reset')!.addEventListener('click', () => {
    current = { ...DEFAULT_FEEL_SETTINGS };
    commit();
  });
  // Keys pressed on these controls stay out of the game (no WASD, H closing help, etc.)
  for (const type of ['keydown', 'keyup'] as const) {
    section.addEventListener(type, e => {
      if ((e as KeyboardEvent).key !== 'Escape') e.stopPropagation();
    });
  }

  show();
  const closeBtn = card.querySelector('#close-help-btn');
  card.insertBefore(section, closeBtn);
  injectStyles();
}

let stylesDone = false;
function injectStyles(): void {
  if (stylesDone || typeof document === 'undefined') return;
  stylesDone = true;
  const style = document.createElement('style');
  style.textContent = `
    .feel-settings {
      border-top: 1px solid var(--ns-border);
      padding-top: var(--ns-space-4);
      margin-bottom: 20px;
      display: grid;
      gap: var(--ns-space-2);
    }
    .feel-settings h3 {
      margin: 0 0 var(--ns-space-1) 0;
      font-size: var(--ns-fs-md);
      font-weight: 700;
      color: var(--ns-accent);
      letter-spacing: var(--ns-heading-ls);
    }
    .feel-row {
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: center;
      gap: var(--ns-space-4);
      font-size: var(--ns-fs-md);
      color: var(--ns-text-muted);
      cursor: pointer;
    }
    .feel-row output { color: var(--ns-text); margin-left: 6px; font-variant-numeric: tabular-nums; }
    .feel-row input[type='range'] { width: 160px; accent-color: var(--ns-accent); }
    .feel-row input[type='checkbox'] { width: 18px; height: 18px; accent-color: var(--ns-accent); }
    .feel-reset {
      justify-self: start;
      background: none;
      border: none;
      padding: 0;
      font: inherit;
      font-size: var(--ns-fs-sm);
      color: var(--ns-text-muted);
      text-decoration: underline;
      cursor: pointer;
    }
    .feel-reset:hover, .feel-reset:focus-visible { color: var(--ns-accent); }
  `;
  document.head.appendChild(style);
}
