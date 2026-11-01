/**
 * Namma Space: No-Framework Vanilla DOM UI
 * Follows SPEC.md Section 7:
 * - Progress bar (streaming downloads with percentage fill)
 * - Help overlay (toggleable via H key or button)
 * - Reset button (or R key)
 * - Real FPS counter
 * - Mode indicator (always shows Ghost or Grid)
 * - Error panel mapping codes (E_MANIFEST, E_ASSET, E_WEBGL, E_SPZ) with lite retry
 * - Permanent "DEV SYNTHETIC SCENE" banner when running dev synthetic scene
 *
 * The loading screen takes its feel from techfest.org (near-black dusk, gold, a symmetric glowing
 * gate that traces the real download progress); everything else uses the shared tokens from tokens.ts.
 */

import type { AppUI, ViewerErrorCode } from '../types.js';
import { ensureTokens, icon } from './tokens.js';

/**
 * Returns true when the event target is an interactive text input element or contentEditable.
 * Used to avoid game shortcuts (WASD, F, M, Space, H, etc.) triggering while the user is typing in a search box.
 */
export function isTypingTarget(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName ? el.tagName.toLowerCase() : '';
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (el.isContentEditable) return true;
  return false;
}

/** Display name and kind for a scene id on the loading screen. Unknown scenes show their id. */
export function roomLabel(sceneId: string): { name: string; kind: string } {
  const known: Record<string, { name: string; kind: string }> = {
    scn_hostelroomac: { name: 'K-720', kind: 'Hostel room' },
  };
  if (known[sceneId]) return known[sceneId];
  if (sceneId === 'dev' || sceneId.startsWith('scn_dev')) return { name: 'Dev room', kind: 'Synthetic test scene' };
  return { name: sceneId.replace(/^scn_/, ''), kind: 'Scene' };
}

/** Loading stage for a progress value, matching the steps main.ts reports. */
export function loadingStage(p: number): string {
  if (p < 0.25) return 'Reading the scene manifest…';
  if (p < 0.9) return 'Downloading the room…';
  if (p < 1) return 'Building the 3D scene…';
  return 'Ready';
}

const DESKTOP_TIPS = ['Press / to search', 'N opens the map', 'Click a label to navigate'];
const TOUCH_TIPS = ['Tap the search bar to find a place', 'Map opens the floor plan', 'Tap a label to navigate'];
const TIP_INTERVAL_MS = 4000;

export interface AppUIOptions {
  container?: HTMLElement;
  isDevScene?: boolean;
  isTagMode?: boolean;
  /** Scene id from ?scene=, shown as the room name on the loading screen */
  sceneId?: string;
  initialMode?: 'Ghost' | 'Grid';
  onReset?: () => void;
  onModeToggle?: () => void;
  /** Walk / Free roam switch (F) */
  onMoveToggle?: () => void;
  initialMoveLabel?: string;
  /** Footstep volume slider (Walk mode): value 0..1 while dragging, and on release */
  initialVolume?: number;
  onVolumeChange?: (v: number) => void;
  onVolumeCommit?: () => void;
  /** Floor-plan minimap toggle (N) */
  onMinimapToggle?: () => void;
}

export class VanillaAppUI implements AppUI {
  private readonly _root: HTMLElement;
  private readonly _progressContainer: HTMLElement;
  private readonly _progressBar: SVGElement;
  private readonly _progressTrack: HTMLElement;
  private readonly _progressPct: HTMLElement;
  private readonly _progressStage: HTMLElement;
  private readonly _roomName: HTMLElement;
  private readonly _roomKind: HTMLElement;
  private readonly _tipText: HTMLElement;
  private readonly _errorPanel: HTMLElement;
  private readonly _errorCode: HTMLElement;
  private readonly _errorMessage: HTMLElement;
  private readonly _errorActions: HTMLElement;
  private readonly _helpOverlay: HTMLElement;
  private readonly _helpBtn: HTMLButtonElement;
  private readonly _fpsValue: HTMLElement;
  private readonly _modeValue: HTMLElement;
  private readonly _moveValue: HTMLElement;
  private readonly _resetButton: HTMLElement;
  private readonly _moveButton: HTMLElement;
  private readonly _volumeBox: HTMLElement;
  private readonly _volumeIcon: HTMLElement;
  private readonly _volumeSlider: HTMLInputElement;

  private _isHelpVisible = false;
  private _helpReturnFocus: HTMLElement | null = null;
  private _mode: 'Ghost' | 'Grid' = 'Ghost';
  private readonly _onReset?: () => void;
  private readonly _onModeToggle?: () => void;

  private readonly _tips: string[];
  private _tipIndex = 0;
  private _tipTimer: number | null = null;
  private _hideTimer: number | null = null;

  constructor(options: AppUIOptions = {}) {
    this._onReset = options.onReset;
    this._onModeToggle = options.onModeToggle;
    this._mode = options.initialMode ?? 'Ghost';

    const parent = options.container ?? document.body;
    const isTouch = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    this._tips = isTouch ? TOUCH_TIPS : DESKTOP_TIPS;

    this._root = document.createElement('div');
    this._root.id = 'namma-ui-root';
    this._root.className = 'namma-ui-layer ns-ui';

    ensureTokens();
    this._injectStyles();

    // 1. Permanent DEV banner if dev synthetic scene
    if (options.isDevScene) {
      const devBanner = document.createElement('div');
      devBanner.id = 'dev-synthetic-banner';
      devBanner.className = 'dev-banner';
      devBanner.textContent = 'DEV SYNTHETIC SCENE (Synthetic test scene — not a real room reconstruction)';
      this._root.appendChild(devBanner);
      document.documentElement.style.setProperty('--ns-hud-top', 'calc(40px + env(safe-area-inset-top))');
    }

    // 2. Top-Right HUD: status group (FPS, Mode, Move, volume) and action group (Reset, Map, Help)
    const topHud = document.createElement('div');
    topHud.className = 'hud-top-right';

    if (options.isTagMode) {
      const tagBadge = document.createElement('div');
      tagBadge.id = 'tag-mode-badge';
      tagBadge.className = 'hud-tag-badge';
      tagBadge.textContent = 'Tag mode';
      topHud.appendChild(tagBadge);
    }

    const statusGroup = document.createElement('div');
    statusGroup.className = 'hud-group';

    const fpsBadge = document.createElement('div');
    fpsBadge.id = 'fps-counter';
    fpsBadge.className = 'hud-chip fps-badge';
    fpsBadge.innerHTML = '<span class="hud-chip-k">FPS</span><span class="hud-chip-v ns-num">--</span>';
    this._fpsValue = fpsBadge.querySelector('.hud-chip-v') as HTMLElement;
    statusGroup.appendChild(fpsBadge);

    const modeBadge = document.createElement('button');
    modeBadge.id = 'mode-indicator';
    modeBadge.className = 'hud-chip hud-chip-btn ns-press';
    modeBadge.title = 'Click to toggle collision mode (Ghost / Grid)';
    modeBadge.innerHTML = '<span class="hud-chip-k">Mode</span><span class="hud-chip-v"></span>';
    this._modeValue = modeBadge.querySelector('.hud-chip-v') as HTMLElement;
    this._modeValue.textContent = this._mode;
    modeBadge.addEventListener('click', () => {
      this._onModeToggle?.();
    });
    statusGroup.appendChild(modeBadge);

    this._moveButton = document.createElement('button');
    this._moveButton.id = 'move-mode-btn';
    this._moveButton.className = 'hud-chip hud-chip-btn ns-press';
    this._moveButton.title = 'Switch between Walk (fixed height) and Free roam (fly) (F)';
    this._moveButton.innerHTML = '<span class="hud-chip-k">Move</span><span class="hud-chip-v"></span>';
    this._moveValue = this._moveButton.querySelector('.hud-chip-v') as HTMLElement;
    this._moveValue.textContent = options.initialMoveLabel ?? 'Free roam';
    this._moveButton.addEventListener('click', () => {
      this._moveButton.blur(); // Space (jump) must not press it again
      options.onMoveToggle?.();
    });
    statusGroup.appendChild(this._moveButton);

    // Footstep volume (shown in Walk mode only). Keys and clicks on it stay out of the game.
    this._volumeBox = document.createElement('label');
    this._volumeBox.id = 'footstep-volume';
    this._volumeBox.className = 'hud-chip volume-box hidden';
    this._volumeBox.title = 'Footstep volume (M mutes)';
    this._volumeIcon = document.createElement('span');
    this._volumeIcon.className = 'volume-icon';
    this._volumeSlider = document.createElement('input');
    this._volumeSlider.type = 'range';
    this._volumeSlider.min = '0';
    this._volumeSlider.max = '100';
    this._volumeSlider.setAttribute('aria-label', 'Footstep volume');
    this._volumeBox.append(this._volumeIcon, this._volumeSlider);
    for (const type of ['pointerdown', 'keydown', 'keyup'] as const) {
      this._volumeSlider.addEventListener(type, e => e.stopPropagation());
    }
    this._volumeSlider.addEventListener('input', () => {
      const v = Number(this._volumeSlider.value) / 100;
      this._showVolume(v, false);
      options.onVolumeChange?.(v);
    });
    this._volumeSlider.addEventListener('change', () => {
      this._volumeSlider.blur(); // WASD go back to the game
      options.onVolumeCommit?.();
    });
    this._showVolume(options.initialVolume ?? 0.6, false);
    statusGroup.appendChild(this._volumeBox);
    topHud.appendChild(statusGroup);

    const actionGroup = document.createElement('div');
    actionGroup.className = 'hud-group';

    const makeAction = (id: string, iconName: string, label: string, key: string, title: string) => {
      const btn = document.createElement('button');
      btn.id = id;
      btn.className = 'hud-button ns-press';
      btn.title = title;
      btn.setAttribute('aria-label', `${label} (${key})`);
      btn.innerHTML = `${icon(iconName, 16)}<span class="hud-label">${label}</span><kbd class="ns-kbd" aria-hidden="true">${key}</kbd>`;
      actionGroup.appendChild(btn);
      return btn;
    };

    this._resetButton = makeAction('reset-btn', 'reset', 'Reset', 'R', 'Reset camera pose (R)');
    this._resetButton.addEventListener('click', () => {
      this._onReset?.();
    });

    const mapBtn = makeAction('minimap-toggle-btn', 'map', 'Map', 'N', 'Toggle Minimap (N)');
    mapBtn.addEventListener('click', () => {
      mapBtn.blur();
      options.onMinimapToggle?.();
    });

    this._helpBtn = makeAction('help-toggle-btn', 'help', 'Help', 'H', 'Toggle Controls Help (H)');
    this._helpBtn.setAttribute('aria-controls', 'help-overlay');
    this._helpBtn.setAttribute('aria-expanded', 'false');
    this._helpBtn.addEventListener('click', () => this.toggleHelp());

    topHud.appendChild(actionGroup);
    this._root.appendChild(topHud);

    // 3. Loading screen (real download progress, room name, one rotating tip)
    const room = roomLabel(options.sceneId ?? '');
    this._progressContainer = document.createElement('div');
    this._progressContainer.id = 'loading-overlay';
    this._progressContainer.className = 'loading-overlay';
    this._progressContainer.innerHTML = `
      <div class="ld-sky" aria-hidden="true"></div>
      <div class="ld-stage-wrap">
        <div class="ld-gate" role="progressbar" aria-label="Scene download progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
          <svg class="ld-gate-svg" viewBox="0 0 200 200" fill="none" aria-hidden="true" focusable="false">
            <path class="ld-gate-track" pathLength="100" d="M70 8 H130 L192 70 V130 L130 192 H70 L8 130 V70 Z"/>
            <path class="ld-gate-fill" pathLength="100" d="M100 8 H130 L192 70 V130 L130 192 H70 L8 130 V70 L70 8 Z"/>
            <g class="ld-gate-spin">
              <path class="ld-gate-inner" d="M100 34 L124 58 L166 100 L124 142 L100 166 L76 142 L34 100 L76 58 Z"/>
              <path class="ld-gate-inner ld-gate-inner-b" d="M100 52 L148 100 L100 148 L52 100 Z"/>
              <path class="ld-gate-ray" d="M100 20 V60 M100 140 V180 M20 100 H60 M140 100 H180"/>
            </g>
            <circle class="ld-gate-core" cx="100" cy="100" r="11"/>
            <path class="ld-gate-tick" d="M70 8 h-6 M130 8 h6 M70 192 h-6 M130 192 h6 M8 70 v-6 M192 70 v-6 M8 130 v6 M192 130 v6"/>
          </svg>
          <span class="ld-pct-wrap"><span class="ld-pct ns-num">0</span><span class="ld-pct-unit">%</span></span>
        </div>
        <div class="ld-panel">
          <h1 class="ld-room" translate="no"></h1>
          <p class="ld-kind"></p>
          <p class="ld-stage" aria-live="polite"></p>
          <p class="ld-tip"><span class="ld-tip-tag">Tip</span><span class="ld-tip-text"></span></p>
        </div>
      </div>
      <p class="ld-credit">Namma Space · Team NoGrass · Techfest IIT Bombay 2026, Round 2</p>
    `;
    const q = (sel: string) => this._progressContainer.querySelector(sel) as HTMLElement;
    this._roomName = q('.ld-room');
    this._roomKind = q('.ld-kind');
    this._progressBar = this._progressContainer.querySelector('.ld-gate-fill') as SVGElement;
    this._progressTrack = q('.ld-gate');
    this._progressPct = q('.ld-pct');
    this._progressStage = q('.ld-stage');
    this._tipText = q('.ld-tip-text');
    this.setRoomName(room.name, room.kind);
    this._progressStage.textContent = loadingStage(0);
    this._tipText.textContent = this._tips[0];
    this._root.appendChild(this._progressContainer);
    this._startTips();

    // 4. Error Panel (E_MANIFEST, E_ASSET, E_WEBGL, E_SPZ)
    this._errorPanel = document.createElement('div');
    this._errorPanel.id = 'error-panel';
    this._errorPanel.className = 'error-panel hidden';
    this._errorPanel.setAttribute('role', 'alert');

    this._errorCode = document.createElement('div');
    this._errorCode.className = 'error-code';
    this._errorPanel.appendChild(this._errorCode);

    this._errorMessage = document.createElement('div');
    this._errorMessage.className = 'error-message';
    this._errorPanel.appendChild(this._errorMessage);

    this._errorActions = document.createElement('div');
    this._errorActions.className = 'error-actions';
    this._errorPanel.appendChild(this._errorActions);

    this._root.appendChild(this._errorPanel);

    // 5. Help Overlay
    this._helpOverlay = document.createElement('div');
    this._helpOverlay.id = 'help-overlay';
    this._helpOverlay.className = 'help-overlay hidden';
    const tagRow = options.isTagMode ? '<div><kbd>P</kbd></div><div>Tag mode: add place here</div>' : '';
    this._helpOverlay.innerHTML = `
      <div class="help-card" role="dialog" aria-modal="true" aria-labelledby="help-title">
        <h2 id="help-title">Controls & navigation</h2>
        <div class="help-grid">
          <div><kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd></div><div>Walk (Forward, Left, Back, Right)</div>
          <div><kbd>Shift</kbd></div><div>Fast Walk (2.5 m/s)</div>
          <div><kbd>F</kbd></div><div>Switch Walk (person height, game feel) / Free roam</div>
          <div><kbd>E</kbd> / <kbd>Q</kbd></div><div>Free roam: fly up / down (over or between furniture; R walks again)</div>
          <div><kbd>Space</kbd></div><div>Walk: jump</div>
          <div><kbd>M</kbd></div><div>Walk: footstep sound on / off (slider sets the volume)</div>
          <div><kbd>/</kbd></div><div>Search places</div>
          <div><kbd>Esc</kbd></div><div>Close search / release mouse</div>
          <div><kbd>N</kbd></div><div>Toggle minimap</div>
          ${tagRow}
          <div><kbd>Mouse</kbd></div><div>Look around (Yaw & Pitch +/-85&deg;)</div>
          <div><kbd>Click</kbd></div><div>Lock mouse cursor to look</div>
          <div><kbd>Esc</kbd></div><div>Release mouse cursor</div>
          <div><kbd>R</kbd></div><div>Reset to start pose</div>
          <div><kbd>H</kbd></div><div>Toggle this help overlay</div>
        </div>
        <button id="close-help-btn" class="ns-btn ns-btn-primary ns-press">Got it</button>
      </div>
    `;

    const closeBtn = this._helpOverlay.querySelector('#close-help-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.toggleHelp());
    }
    // Click on the dimmed backdrop closes help
    this._helpOverlay.addEventListener('click', e => {
      if (e.target === this._helpOverlay && this._isHelpVisible) this.toggleHelp();
    });

    this._root.appendChild(this._helpOverlay);

    // 6. Global keyboard listeners for H, N, and Esc (closes help)
    window.addEventListener('keydown', (e: KeyboardEvent) => {
      if (isTypingTarget(e)) return;
      if (e.code === 'KeyH' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        this.toggleHelp();
      }
      if (e.code === 'KeyN' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        options.onMinimapToggle?.();
      }
      if (e.key === 'Escape' && this._isHelpVisible) {
        this.toggleHelp();
      }
    });

    parent.appendChild(this._root);
  }

  setMode(mode: 'Ghost' | 'Grid'): void {
    this._mode = mode;
    this._modeValue.textContent = this._mode;
  }

  setMoveMode(label: string): void {
    this._moveValue.textContent = label;
  }

  /** Room name and kind on the loading screen (e.g. "K-720", "Hostel room") */
  setRoomName(name: string, kind = ''): void {
    this._roomName.textContent = name;
    this._roomName.classList.toggle('is-long', name.length > 8);
    this._roomKind.textContent = kind;
    this._roomKind.classList.toggle('hidden', !kind);
  }

  /** Show or hide the footstep volume slider (Walk mode only) */
  setVolumeVisible(visible: boolean): void {
    this._volumeBox.classList.toggle('hidden', !visible);
  }

  /** Update the slider from code; muted shows 0 and the muted icon */
  setVolume(v: number, muted: boolean): void {
    this._showVolume(v, muted);
  }

  private _showVolume(v: number, muted: boolean): void {
    const shown = muted ? 0 : v;
    this._volumeSlider.value = String(Math.round(shown * 100));
    this._volumeIcon.innerHTML = icon(shown <= 0 ? 'mute' : 'volume', 15);
  }

  showProgress(p: number): void {
    const clamped = Math.max(0, Math.min(1.0, p));
    const percent = Math.round(clamped * 100);
    // The gate frame has pathLength 100, so the dash offset is the share still to download
    this._progressBar.style.strokeDashoffset = String(100 - clamped * 100);
    this._progressPct.textContent = String(percent);
    this._progressTrack.setAttribute('aria-valuenow', String(percent));
    const stage = loadingStage(clamped);
    if (this._progressStage.textContent !== stage) this._progressStage.textContent = stage;

    if (this._hideTimer !== null) {
      window.clearTimeout(this._hideTimer);
      this._hideTimer = null;
    }

    if (clamped >= 1.0) {
      // Short beat at 100%, then fade out (the fade is 0 ms under reduced motion)
      this._hideTimer = window.setTimeout(() => {
        this._progressContainer.classList.add('hidden');
        this._stopTips();
        this._hideTimer = null;
      }, 200);
    } else {
      this._progressContainer.classList.remove('hidden');
      this._startTips();
    }
  }

  showError(code: ViewerErrorCode, msg: string, onRetryLite?: () => void): void {
    this._progressContainer.classList.add('hidden');
    this._stopTips();
    this._errorCode.textContent = `Error [${code}]`;
    this._errorMessage.textContent = msg;

    this._errorActions.innerHTML = '';
    if (onRetryLite) {
      const retryBtn = document.createElement('button');
      retryBtn.className = 'ns-btn ns-btn-primary ns-press';
      retryBtn.textContent = 'Retry with lite scene';
      retryBtn.addEventListener('click', () => {
        this._errorPanel.classList.add('hidden');
        onRetryLite();
      });
      this._errorActions.appendChild(retryBtn);
    }

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'ns-btn ns-press';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.addEventListener('click', () => {
      this._errorPanel.classList.add('hidden');
    });
    this._errorActions.appendChild(dismissBtn);

    this._errorPanel.classList.remove('hidden');
  }

  toggleHelp(): void {
    this._isHelpVisible = !this._isHelpVisible;
    this._helpBtn.setAttribute('aria-expanded', String(this._isHelpVisible));
    if (this._isHelpVisible) {
      this._helpReturnFocus = document.activeElement as HTMLElement | null;
      document.exitPointerLock?.();
      this._helpOverlay.classList.remove('hidden');
      (this._helpOverlay.querySelector('#close-help-btn') as HTMLElement | null)?.focus();
    } else {
      this._helpOverlay.classList.add('hidden');
      // Return focus to where it was (not to the canvas, which would grab pointer lock)
      if (this._helpReturnFocus && this._helpReturnFocus !== document.body && this._helpReturnFocus.tagName !== 'CANVAS') {
        this._helpReturnFocus.focus();
      } else {
        (document.activeElement as HTMLElement | null)?.blur();
      }
      this._helpReturnFocus = null;
    }
  }

  setFps(v: number): void {
    this._fpsValue.textContent = String(Math.round(v));
  }

  private _startTips(): void {
    if (this._tipTimer !== null || this._tips.length < 2) return;
    this._tipTimer = window.setInterval(() => {
      this._tipIndex = (this._tipIndex + 1) % this._tips.length;
      const el = this._tipText;
      el.classList.add('is-swapping');
      // Swap mid-fade (instant when reduced motion sets the duration to 0)
      window.setTimeout(() => {
        el.textContent = this._tips[this._tipIndex];
        el.classList.remove('is-swapping');
      }, 150);
    }, TIP_INTERVAL_MS);
  }

  private _stopTips(): void {
    if (this._tipTimer !== null) {
      window.clearInterval(this._tipTimer);
      this._tipTimer = null;
    }
  }

  private _injectStyles(): void {
    const style = document.createElement('style');
    style.textContent = `
      .namma-ui-layer {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        font-family: var(--ns-font);
        color: var(--ns-text);
        overflow: hidden;
      }
      .hidden { display: none !important; }
      .dev-banner {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        background: var(--ns-danger);
        color: var(--ns-on-fill);
        font-weight: 700;
        font-size: var(--ns-fs-md);
        letter-spacing: 0.5px;
        text-align: center;
        padding: calc(6px + env(safe-area-inset-top)) 12px 6px;
        z-index: 100;
        box-shadow: var(--ns-shadow-sm);
      }

      /* ---------- HUD ---------- */
      .hud-top-right {
        position: absolute;
        top: var(--ns-hud-top);
        right: var(--ns-hud-right);
        display: flex;
        align-items: center;
        gap: var(--ns-space-2);
        pointer-events: auto;
        z-index: 90;
      }
      .hud-group {
        display: flex;
        align-items: center;
        gap: 2px;
        padding: 3px;
        background: var(--ns-surface);
        backdrop-filter: var(--ns-blur);
        -webkit-backdrop-filter: var(--ns-blur);
        border: 1px solid var(--ns-border);
        border-radius: var(--ns-radius-lg);
        box-shadow: var(--ns-shadow);
      }
      .hud-chip, .hud-button {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-height: var(--ns-target);
        padding: 0 10px;
        border: 0;
        border-radius: var(--ns-radius-sm);
        background: transparent;
        color: var(--ns-text);
        font-size: var(--ns-fs-sm);
        font-weight: 700;
        letter-spacing: var(--ns-label-ls);
        text-transform: uppercase;
        white-space: nowrap;
      }
      .hud-chip-k {
        color: var(--ns-text-subtle);
        font-weight: 500;
      }
      .hud-chip-v { text-transform: none; letter-spacing: 0.02em; }
      .hud-chip-v { color: var(--ns-accent); }
      .fps-badge .hud-chip-v { min-width: 2.5ch; text-align: right; }
      .hud-chip-btn, .hud-button { cursor: pointer; }
      .hud-button { padding: 0 8px 0 10px; }
      .hud-button .ns-kbd { margin-left: 2px; }
      .hud-tag-badge {
        display: inline-flex;
        align-items: center;
        min-height: var(--ns-target);
        padding: 0 12px;
        border: 1px solid var(--ns-badge-border);
        border-radius: var(--ns-radius-lg);
        background: var(--ns-surface);
        backdrop-filter: var(--ns-blur);
        -webkit-backdrop-filter: var(--ns-blur);
        color: var(--ns-badge);
        font-size: var(--ns-fs-xs);
        font-weight: 900;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        box-shadow: var(--ns-shadow);
      }
      /* Hover: the label turns sky blue, like the site's sidebar items */
      @media (hover: hover) and (pointer: fine) {
        .hud-chip-btn:hover, .hud-button:hover { background: var(--ns-surface-hover); color: var(--ns-sky); }
      }
      .volume-box { gap: 6px; cursor: pointer; }
      .volume-icon { display: flex; color: var(--ns-accent); }
      .volume-box input[type='range'] {
        width: 90px;
        margin: 0;
        accent-color: var(--ns-accent);
        cursor: pointer;
      }

      /* Narrow desktop and tablet: action buttons go icon-only so search and HUD fit one row */
      @media (max-width: 1100px) {
        .hud-label { display: none; }
        .hud-button { padding: 0 8px; }
      }

      /* Phone: search takes the first row, the HUD a single scrollable second row */
      @media (max-width: 760px) {
        .hud-top-right {
          top: calc(var(--ns-hud-top) + var(--ns-target) + 16px);
          left: var(--ns-hud-left);
          right: var(--ns-hud-right);
          justify-content: flex-start;
          overflow-x: auto;
          scrollbar-width: none;
          gap: 6px;
        }
        .hud-top-right::-webkit-scrollbar { display: none; }
        .hud-group { flex: none; }
        /* Tag mode is shown in the Places sheet header on phones, so the HUD row keeps Map and Help */
        .hud-tag-badge { display: none; }
        .hud-label, .hud-chip-btn .hud-chip-k { display: none; }
        .hud-button { padding: 0; width: var(--ns-target); justify-content: center; }
        .hud-chip { padding: 0 8px; }
        .volume-box input[type='range'] { width: 72px; }
      }

      /* ---------- Loading screen (inspired by techfest.org: dark dusk, gold, a symmetric glowing gate) ---------- */
      .loading-overlay {
        --ld-base: var(--ns-bg);
        --ld-dusk: var(--ns-ld-dusk);
        --ld-plum: var(--ns-ld-plum);
        --ld-amber: var(--ns-ld-amber);
        --ld-gold: var(--ns-accent);
        --ld-gold-soft: var(--ns-ld-gold-soft);
        --ld-glass: var(--ns-ld-glass);
        --ld-cyan: var(--ns-sky);
        --ld-text-dim: var(--ns-ld-text-dim);
        --ld-out: 420ms;
        position: absolute;
        inset: 0;
        z-index: 120;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: max(32px, env(safe-area-inset-top)) max(24px, env(safe-area-inset-right))
          max(64px, calc(env(safe-area-inset-bottom) + 48px)) max(24px, env(safe-area-inset-left));
        overflow: hidden;
        pointer-events: auto;
        color: var(--ns-text-strong);
        background: var(--ld-base);
        font-family: var(--ns-font);
        transition: opacity var(--ld-out) var(--ns-ease-out), display var(--ld-out) allow-discrete;
      }
      .loading-overlay.hidden { opacity: 0; }
      @media (prefers-reduced-motion: reduce) {
        .loading-overlay { --ld-out: 0ms; }
      }

      /* Dusk sky: a linear horizon (indigo, plum, an amber band, ground) plus fine grain */
      .ld-sky {
        position: absolute;
        inset: -4% 0;
        pointer-events: none;
        background:
          linear-gradient(180deg, var(--ld-base) 0%, var(--ld-dusk) 38%, var(--ld-plum) 58%,
            color-mix(in srgb, var(--ld-amber) 70%, var(--ld-plum)) 68%, var(--ld-plum) 74%, var(--ld-base) 100%);
        opacity: 0.85;
        animation: ld-breathe 7s ease-in-out infinite alternate;
      }
      .ld-sky::after {
        content: "";
        position: absolute;
        inset: 0;
        opacity: 0.09;
        mix-blend-mode: overlay;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E");
      }
      @keyframes ld-breathe {
        from { opacity: 0.72; transform: translateY(0); }
        to { opacity: 0.92; transform: translateY(-1.5%); }
      }

      .ld-stage-wrap {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: clamp(20px, 4vh, 36px);
        width: 100%;
        max-width: 560px;
        transition: scale var(--ld-out) var(--ns-ease-out), filter var(--ld-out) var(--ns-ease-out);
        animation: ld-enter 600ms var(--ns-ease-out) backwards;
      }
      .loading-overlay.hidden .ld-stage-wrap { scale: 1.04; filter: blur(6px); }
      @keyframes ld-enter {
        from { opacity: 0; filter: blur(8px); scale: 0.98; }
      }

      /* Gate: the chamfered outer frame traces round as the download progresses */
      .ld-gate {
        position: relative;
        width: clamp(168px, 26vh, 236px);
        aspect-ratio: 1;
      }
      .ld-gate-svg { width: 100%; height: 100%; overflow: visible; }
      .ld-gate-track { stroke: var(--ns-ld-track); stroke-width: 2; }
      .ld-gate-fill {
        stroke: var(--ld-gold);
        stroke-width: 3;
        stroke-linecap: round;
        stroke-dasharray: 100 100;
        stroke-dashoffset: 100;
        filter: drop-shadow(0 0 6px var(--ns-ld-glow));
        transition: stroke-dashoffset var(--ns-dur-slow) var(--ns-ease-out);
      }
      .ld-gate-spin {
        transform-box: fill-box;
        transform-origin: center;
        animation: ld-spin 28s linear infinite;
      }
      .ld-gate-inner { stroke: var(--ns-ld-inner); stroke-width: 1.5; }
      .ld-gate-inner-b { stroke: var(--ns-ld-inner-b); }
      .ld-gate-ray { stroke: var(--ns-ld-ray); stroke-width: 1; stroke-dasharray: 2 4; }
      .ld-gate-core {
        fill: var(--ld-gold-soft);
        filter: drop-shadow(0 0 10px var(--ns-ld-core-glow)) drop-shadow(0 0 22px var(--ns-ld-glow));
        opacity: 0.9;
      }
      .ld-gate-tick { stroke: var(--ld-cyan); stroke-width: 2; stroke-linecap: round; }
      @keyframes ld-spin { to { rotate: 360deg; } }
      .ld-pct-wrap {
        position: absolute;
        left: 50%;
        bottom: -6px;
        translate: -50% 100%;
        display: flex;
        align-items: baseline;
        gap: 2px;
      }
      .ld-pct {
        font-size: 30px;
        font-weight: 700;
        line-height: 1;
        letter-spacing: -0.02em;
        color: var(--ld-gold);
        min-width: 2ch;
        text-align: right;
      }
      .ld-pct-unit { font-size: 15px; font-weight: 700; color: var(--ld-gold-soft); }

      /* Glass panel with chamfered corners and cyan corner ticks */
      .ld-panel {
        position: relative;
        width: 100%;
        margin-top: 28px;
        padding: 22px 28px 20px;
        text-align: center;
        /* Corner gradients draw the gold edge along each 14 px chamfer (the inset shadow does the straight edges) */
        --ld-edge: var(--ns-ld-edge);
        background:
          linear-gradient(to bottom right, transparent calc(50% - 1px), var(--ld-edge) 50%, transparent calc(50% + 1px)) top left / 14px 14px no-repeat,
          linear-gradient(to bottom left, transparent calc(50% - 1px), var(--ld-edge) 50%, transparent calc(50% + 1px)) top right / 14px 14px no-repeat,
          linear-gradient(to bottom left, transparent calc(50% - 1px), var(--ld-edge) 50%, transparent calc(50% + 1px)) bottom left / 14px 14px no-repeat,
          linear-gradient(to bottom right, transparent calc(50% - 1px), var(--ld-edge) 50%, transparent calc(50% + 1px)) bottom right / 14px 14px no-repeat,
          var(--ld-glass);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        clip-path: polygon(14px 0, calc(100% - 14px) 0, 100% 14px, 100% calc(100% - 14px),
          calc(100% - 14px) 100%, 14px 100%, 0 calc(100% - 14px), 0 14px);
        box-shadow: inset 0 0 0 1px var(--ld-edge);
      }
      .ld-panel::before, .ld-panel::after {
        content: "";
        position: absolute;
        width: 18px;
        height: 2px;
        background: var(--ld-cyan);
        top: 7px;
      }
      .ld-panel::before { left: 14px; }
      .ld-panel::after { right: 14px; }
      /* Room name in the display face, uppercase and widely tracked like the site's page titles */
      .ld-room {
        margin: 0;
        font-family: var(--ns-font-display);
        font-size: clamp(34px, 6vw, 56px);
        font-weight: 400;
        line-height: 1.05;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: var(--ns-text-strong);
        text-shadow: 0 0 24px var(--ns-ld-name-glow);
        overflow-wrap: anywhere;
        text-wrap: balance;
      }
      .ld-room.is-long { font-size: clamp(26px, 5vw, 40px); }
      .ld-kind {
        margin: 10px 0 0;
        font-size: var(--ns-fs-sm);
        font-weight: 700;
        letter-spacing: 0.24em;
        text-transform: uppercase;
        color: var(--ld-gold);
      }
      .ld-stage {
        margin: 16px 0 0;
        font-size: var(--ns-fs-md);
        color: var(--ld-text-dim);
      }
      .ld-tip {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        margin: 14px 0 0;
        padding-top: 14px;
        border-top: 1px solid var(--ns-ld-line);
        min-height: 24px;
        font-size: var(--ns-fs-md);
        color: var(--ns-text);
      }
      .ld-tip-tag {
        flex: none;
        font-size: var(--ns-fs-xs);
        font-weight: 700;
        letter-spacing: 0.24em;
        text-transform: uppercase;
        color: var(--ld-cyan);
      }
      .ld-tip-text { transition: opacity var(--ns-dur-fast) ease; }
      .ld-tip-text.is-swapping { opacity: 0; }
      .ld-credit {
        position: absolute;
        left: 0;
        right: 0;
        bottom: max(22px, env(safe-area-inset-bottom));
        margin: 0;
        padding: 0 20px;
        text-align: center;
        font-size: var(--ns-fs-xs);
        font-weight: 600;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: var(--ns-ld-credit);
      }
      @media (prefers-reduced-motion: reduce) {
        .ld-sky, .ld-gate-spin, .ld-stage-wrap { animation: none; }
      }
      @media (max-width: 760px) {
        .ld-panel { padding: 18px 18px 16px; }
        .ld-credit { letter-spacing: 0.1em; line-height: 1.6; }
      }

      /* ---------- Error panel ---------- */
      .error-panel {
        position: absolute;
        top: calc(var(--ns-hud-top) + 64px);
        left: 50%;
        transform: translateX(-50%);
        background: var(--ns-error-bg);
        border: 1px solid var(--ns-danger-border);
        border-radius: var(--ns-radius-md);
        padding: var(--ns-space-4) 20px;
        width: calc(100% - 2 * var(--ns-edge));
        max-width: 500px;
        pointer-events: auto;
        z-index: 125;
        box-shadow: var(--ns-shadow);
      }
      .error-code {
        font-weight: 700;
        font-size: var(--ns-fs-md);
        color: var(--ns-error-text);
        margin-bottom: var(--ns-space-1);
      }
      .error-message {
        font-size: var(--ns-fs-md);
        margin-bottom: var(--ns-space-3);
        line-height: 1.45;
        overflow-wrap: anywhere;
        color: var(--ns-text);
      }
      .error-actions {
        display: flex;
        gap: var(--ns-space-2);
        justify-content: flex-end;
      }

      /* ---------- Help ---------- */
      .help-overlay {
        position: absolute;
        inset: 0;
        background: var(--ns-scrim);
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: auto;
        z-index: 110;
        overscroll-behavior: contain;
        transition: opacity var(--ns-dur) var(--ns-ease-out), display var(--ns-dur) allow-discrete;
        @starting-style { opacity: 0; }
      }
      .help-overlay.hidden { opacity: 0; }
      .help-card {
        background: var(--ns-surface-strong);
        border: 1px solid var(--ns-border);
        border-radius: var(--ns-radius-lg);
        padding: var(--ns-space-5);
        width: calc(100% - 2 * var(--ns-edge));
        max-width: 460px;
        max-height: calc(100% - 2 * var(--ns-edge));
        overflow-y: auto;
        box-shadow: var(--ns-shadow);
      }
      .help-card h2 {
        margin: 0 0 var(--ns-space-4) 0;
        font-size: var(--ns-fs-xl);
        font-weight: 700;
        letter-spacing: var(--ns-heading-ls);
        color: var(--ns-accent);
        text-wrap: balance;
      }
      .help-grid {
        display: grid;
        grid-template-columns: 120px 1fr;
        gap: var(--ns-space-2) var(--ns-space-4);
        font-size: var(--ns-fs-md);
        color: var(--ns-text-muted);
        margin-bottom: 20px;
        align-items: center;
      }
      .help-card .ns-btn { width: 100%; }
      kbd {
        background: var(--ns-kbd-bg);
        border: 1px solid var(--ns-border-strong);
        border-bottom-width: 2px;
        padding: 2px 6px;
        border-radius: 4px;
        font-family: var(--ns-font);
        font-weight: 700;
        font-size: var(--ns-fs-xs);
        color: var(--ns-text);
      }
    `;
    document.head.appendChild(style);
  }
}
