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
import { isPhoneTouch, isTouchDevice } from './device.js';
import APP_UI_CSS from './app_ui.css?raw';

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

/** Help on phones and tablets: the on-screen controls instead of keys */
const TOUCH_HELP = `
        <div class="help-grid">
          <div><kbd>Stick</kbd></div><div>Move (bottom left). Tilt a little to creep, pull past the ring to run</div>
          <div><kbd>Drag</kbd></div><div>Drag anywhere on the view to look around</div>
          <div><kbd>&#9650;</kbd> <kbd>&#9660;</kbd></div><div>Free roam: fly up / down (bottom right)</div>
          <div><kbd>Jump</kbd></div><div>Walk: jump (bottom right)</div>
          <div><kbd>Walk</kbd></div><div>Top bar: switch Walk (person height) / Free roam</div>
          <div><kbd>Grid</kbd></div><div>Top bar: walls solid (Grid) or walk through them (Ghost)</div>
          <div><kbd>Tags</kbd></div><div>Show / hide the place labels</div>
          <div><kbd>Map</kbd></div><div>Show / hide the floor plan</div>
          <div><kbd>Search</kbd></div><div>Find a place, then Navigate or Take me there</div>
          <div><kbd>Reset</kbd></div><div>Back to the start spot</div>
        </div>`;

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
  /** Show / hide the place labels in the view (L) */
  onLabelsToggle?: () => void;
  /** Scene quality chip (Lite / HD): tap to switch */
  onQualityToggle?: () => void;
  initialLabelsVisible?: boolean;
  /**
   * Round 2 page: a "Play with friends" button opens multiplayer. Reset and the collision mode then
   * move into a "More" menu so the top bar stays one tidy row. Off: the top bar is exactly as before.
   */
  showFriendsButton?: boolean;
  onFriendsClick?: () => void;
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
  private _friendsBtn: HTMLButtonElement | null = null;
  private readonly _moveButton: HTMLElement;
  private readonly _volumeBox: HTMLElement;
  private readonly _volumeIcon: HTMLElement;
  private readonly _volumeSlider: HTMLInputElement;

  private _isHelpVisible = false;
  private _helpReturnFocus: HTMLElement | null = null;
  private _labelsBtn!: HTMLButtonElement;
  private _qualityBtn!: HTMLButtonElement;
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
    const isTouch = isTouchDevice();
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

    // Scene quality: Lite (fast first load) or HD (full scene). Hidden until a scene has both.
    this._qualityBtn = document.createElement('button');
    this._qualityBtn.id = 'quality-btn';
    this._qualityBtn.className = 'hud-chip hud-chip-btn ns-press hidden';
    this._qualityBtn.innerHTML = '<span class="hud-chip-k">Quality</span><span class="hud-chip-v"></span>';
    this._qualityBtn.addEventListener('click', () => {
      this._qualityBtn.blur();
      options.onQualityToggle?.();
    });
    statusGroup.appendChild(this._qualityBtn);

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
    const useMenu = Boolean(options.showFriendsButton);
    if (!useMenu) statusGroup.appendChild(modeBadge);

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

    const makeAction = (id: string, iconName: string, label: string, key: string, title: string, parentEl: HTMLElement = actionGroup) => {
      const btn = document.createElement('button');
      btn.id = id;
      btn.className = 'hud-button ns-press';
      btn.title = title;
      btn.setAttribute('aria-label', `${label} (${key})`);
      btn.innerHTML = `${icon(iconName, 16)}<span class="hud-label">${label}</span><kbd class="ns-kbd" aria-hidden="true">${key}</kbd>`;
      parentEl.appendChild(btn);
      return btn;
    };

    // Round 2 page: Reset and Mode live in the "More" menu (built below)
    const menuList = document.createElement('div');
    this._resetButton = makeAction('reset-btn', 'reset', 'Reset', 'R', 'Reset camera pose (R)', useMenu ? menuList : actionGroup);
    this._resetButton.addEventListener('click', () => {
      this._onReset?.();
    });

    const mapBtn = makeAction('minimap-toggle-btn', 'map', 'Map', 'N', 'Toggle Minimap (N)');
    mapBtn.addEventListener('click', () => {
      mapBtn.blur();
      options.onMinimapToggle?.();
    });

    this._labelsBtn = makeAction('labels-toggle-btn', 'tag', 'Tags', 'L', 'Show or hide place tags (L)');
    this._labelsBtn.setAttribute('aria-pressed', 'true');
    this._labelsBtn.addEventListener('click', () => {
      this._labelsBtn.blur();
      options.onLabelsToggle?.();
    });
    this.setLabelsVisible(options.initialLabelsVisible ?? true);

    this._helpBtn = makeAction('help-toggle-btn', 'help', 'Help', 'H', 'Toggle Controls Help (H)');
    this._helpBtn.setAttribute('aria-controls', 'help-overlay');
    this._helpBtn.setAttribute('aria-expanded', 'false');
    this._helpBtn.addEventListener('click', () => this.toggleHelp());

    if (useMenu) {
      // "More" menu: Reset (R) and the collision mode (Ghost / Grid), same buttons and ids as before
      const more = document.createElement('div');
      more.className = 'hud-more';
      const moreBtn = document.createElement('button');
      moreBtn.id = 'more-menu-btn';
      moreBtn.className = 'hud-button ns-press';
      moreBtn.title = 'More options';
      moreBtn.setAttribute('aria-label', 'More options');
      moreBtn.setAttribute('aria-haspopup', 'true');
      moreBtn.setAttribute('aria-expanded', 'false');
      moreBtn.innerHTML = icon('more', 16);
      menuList.className = 'hud-menu hidden';
      menuList.setAttribute('role', 'menu');
      modeBadge.title = 'Collision mode: Ghost walks through everything, Grid stops at walls';
      menuList.appendChild(modeBadge);
      // Phones: fps, scene quality and footstep volume move into this menu too, so the HUD row
      // fits the screen without scrolling (search, Move, Play with friends, Map, Tags, Help, More)
      if (isPhoneTouch()) {
        topHud.classList.add('hud-compact');
        menuList.append(this._qualityBtn, this._volumeBox, fpsBadge);
        this._qualityBtn.setAttribute('role', 'menuitem');
      }
      for (const item of [this._resetButton, modeBadge]) item.setAttribute('role', 'menuitem');
      const setOpen = (open: boolean) => {
        menuList.classList.toggle('hidden', !open);
        moreBtn.setAttribute('aria-expanded', String(open));
      };
      moreBtn.addEventListener('click', e => {
        e.stopPropagation();
        moreBtn.blur();
        setOpen(menuList.classList.contains('hidden'));
      });
      menuList.addEventListener('click', e => {
        e.stopPropagation();
        if (e.target instanceof Element && e.target.closest('#reset-btn')) setOpen(false);
      });
      document.addEventListener('click', () => setOpen(false));
      window.addEventListener('keydown', e => {
        if (e.key === 'Escape') setOpen(false);
      });
      more.append(moreBtn, menuList);
      actionGroup.appendChild(more);

      // Its own pill, so it reads as the way into multiplayer
      const friendsGroup = document.createElement('div');
      friendsGroup.className = 'hud-group hud-friends';
      const friendsBtn = document.createElement('button');
      friendsBtn.id = 'friends-btn';
      friendsBtn.className = 'hud-button hud-friends-btn ns-press';
      friendsBtn.title = 'Multiplayer: create a room and invite friends to walk this space with you';
      friendsBtn.setAttribute('aria-label', 'Play with friends');
      friendsBtn.innerHTML = `${icon('users', 16)}<span class="hud-friends-label">Play with friends</span>`;
      friendsBtn.addEventListener('click', () => {
        friendsBtn.blur();
        options.onFriendsClick?.();
      });
      friendsGroup.appendChild(friendsBtn);
      this._friendsBtn = friendsBtn;
      topHud.appendChild(friendsGroup);
    }

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
      ${import.meta.env.VITE_MP_URL ? '' : '<p class="ld-credit">Namma Space · Team NoGrass · Techfest IIT Bombay 2026, Round 2</p>'}
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
    // Walk game feel keys (laptops outside tag mode; tag mode keeps the plain Walk mode)
    const feelRows = options.isTagMode ? '' : `
          <div><kbd>Shift</kbd> <kbd>Shift</kbd></div><div>Walk: double-tap for a tactical sprint (3 s burst)</div>
          <div><kbd>C</kbd></div><div>Walk: hold to crouch; press while sprinting to slide</div>
          <div><kbd>Right mouse</kbd></div><div>Walk: hold to zoom in (mouse locked)</div>
          <div><kbd>Space</kbd></div><div>Walk: facing a low bed or table, climb onto it</div>`;
    this._helpOverlay.innerHTML = `
      <div class="help-card" role="dialog" aria-modal="true" aria-labelledby="help-title">
        <h2 id="help-title">Controls & navigation</h2>
        ${isTouch ? TOUCH_HELP : `        <div class="help-grid">
          <div><kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd></div><div>Walk (Forward, Left, Back, Right)</div>
          <div><kbd>Shift</kbd></div><div>Fast Walk (2.5 m/s)</div>
          <div><kbd>F</kbd></div><div>Switch Walk (person height, game feel) / Free roam</div>
          <div><kbd>E</kbd> / <kbd>Q</kbd></div><div>Free roam: fly up / down (over or between furniture; R walks again)</div>
          <div><kbd>Space</kbd></div><div>Walk: jump</div>${feelRows}
          <div><kbd>M</kbd></div><div>Walk: footstep sound on / off (slider sets the volume)</div>
          <div><kbd>/</kbd></div><div>Search places</div>
          <div><kbd>Esc</kbd></div><div>Close search / release mouse</div>
          <div><kbd>N</kbd></div><div>Toggle minimap</div>
          <div><kbd>L</kbd></div><div>Show / hide place tags</div>
          ${tagRow}
          <div><kbd>Mouse</kbd></div><div>Look around (Yaw & Pitch +/-85&deg;)</div>
          <div><kbd>Click</kbd></div><div>Lock mouse cursor to look</div>
          <div><kbd>Esc</kbd></div><div>Release mouse cursor</div>
          <div><kbd>R</kbd></div><div>Reset to start pose</div>
          <div><kbd>H</kbd></div><div>Toggle this help overlay</div>
        </div>`}
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
      if (e.code === 'KeyL' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.repeat) {
        options.onLabelsToggle?.();
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

  /** Hides the "Play with friends" button while the multiplayer lobby or a room is open */
  setFriendsButtonVisible(visible: boolean): void {
    this._friendsBtn?.closest('.hud-friends')?.classList.toggle('hidden', !visible);
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

  /** Quality chip: lite, loading the full scene, or HD */
  setQuality(state: 'lite' | 'loading' | 'hd'): void {
    this._qualityBtn.classList.remove('hidden');
    const v = this._qualityBtn.querySelector('.hud-chip-v') as HTMLElement;
    v.textContent = state === 'hd' ? 'HD' : state === 'loading' ? 'HD…' : 'Lite';
    this._qualityBtn.classList.toggle('loading', state === 'loading');
    this._qualityBtn.title = state === 'hd'
      ? 'Full-quality scene. Tap for Lite (faster)'
      : state === 'loading' ? 'Loading the full-quality scene…' : 'Lite scene. Tap for HD (full quality)';
  }

  /** Tags button state: pressed while the place labels are shown */
  setLabelsVisible(visible: boolean): void {
    this._labelsBtn.setAttribute('aria-pressed', String(visible));
    this._labelsBtn.classList.toggle('off', !visible);
    const svg = this._labelsBtn.querySelector('svg');
    if (svg) svg.outerHTML = icon(visible ? 'tag' : 'tagOff', 16);
    this._labelsBtn.title = visible ? 'Hide place tags (L)' : 'Show place tags (L)';
  }

  toggleHelp(): void {
    this._isHelpVisible = !this._isHelpVisible;
    document.documentElement.classList.toggle('ns-help-open', this._isHelpVisible);
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
    style.textContent = APP_UI_CSS;
    document.head.appendChild(style);
  }
}
