/**
 * Namma Space multiplayer: lobby card (name, character, colours, hat, Create / Join) and the
 * in-room panel (invite link, who is here, mic, point, take me to a friend, leave).
 */

import * as THREE from 'three';
import { ensureTokens } from './tokens.js';
import { isTypingTarget } from './app_ui.js';
import { HATS, SLOT_COLORS, type CharacterDef } from '../avatars/catalog.js';
import { Avatar } from '../avatars/avatar.js';
import { MAX_NAME_LEN, formatRoomCode, type AvatarLook } from '../net/protocol.js';
import type { MicState } from '../net/voice.js';

export interface LobbyResult {
  name: string;
  look: AvatarLook;
}

export interface RosterEntry {
  id: string;
  name: string;
  slot: number;
  speaking: boolean;
  me: boolean;
}

export interface MpUIOptions {
  characters: CharacterDef[];
  initialName: string;
  initialLook: AvatarLook;
  /** Room code from the link, or null when the player will create one */
  joinCode: string | null;
  onEnter: (r: LobbyResult) => void;
  onLookChange: (look: AvatarLook) => void;
  onNameChange: (name: string) => void;
  onCopyInvite: () => void;
  onToggleMic: () => void;
  onPoint: () => void;
  onGoTo: (id: string) => void;
  onLeave: () => void;
  /** Round 2 page: Close is offered in the lobby too and goes back to exploring alone */
  closable?: boolean;
  onClose?: () => void;
}

const STYLE_ID = 'namma-mp-ui';
const CSS = `
  /* Above the HUD, search, minimap and touch controls (z 85-95), so nothing shows through on phones */
  .mp-scrim { position: fixed; inset: 0; z-index: 200; display: grid; place-items: center; background: var(--ns-scrim);
    font-family: var(--ns-font); color: var(--ns-text); padding: 16px; }
  .mp-scrim[hidden] { display: none; }
  .mp-card { width: min(560px, 100%); max-height: calc(100vh - 32px); max-height: calc(100dvh - 32px); overflow: auto; overscroll-behavior: contain; background: var(--ns-surface-strong);
    border: 1px solid var(--ns-border-strong); border-radius: var(--ns-radius-lg); box-shadow: var(--ns-shadow);
    padding: var(--ns-space-5); display: grid; gap: var(--ns-space-4); }
  .mp-card h2 { font-size: var(--ns-fs-xl); color: var(--ns-accent); letter-spacing: var(--ns-heading-ls); text-transform: uppercase; }
  .mp-sub { font-size: var(--ns-fs-md); color: var(--ns-text-muted); line-height: 1.45; }
  .mp-row { display: grid; grid-template-columns: 180px 1fr; gap: var(--ns-space-4); align-items: start; }
  .mp-preview { width: 180px; height: 220px; border-radius: var(--ns-radius-md); background: radial-gradient(circle at 50% 40%, #26314f, #0d1220 70%);
    border: 1px solid var(--ns-border); }
  .mp-field { display: grid; gap: 6px; margin-bottom: var(--ns-space-3); }
  .mp-label { font-size: var(--ns-fs-xs); text-transform: uppercase; letter-spacing: var(--ns-label-ls); color: var(--ns-text-subtle); }
  .mp-input, .mp-select { font: inherit; font-size: var(--ns-fs-lg); color: var(--ns-text); background: var(--ns-input);
    border: 1px solid var(--ns-border-strong); border-radius: var(--ns-radius-sm); padding: 8px 10px; width: 100%; }
  .mp-select option { background: var(--ns-input-solid); }
  .mp-chars { display: flex; flex-wrap: wrap; gap: 6px; }
  .mp-chip { font: inherit; font-size: var(--ns-fs-sm); color: var(--ns-text); background: var(--ns-row); border: 1px solid var(--ns-row-border);
    border-radius: var(--ns-radius-pill); padding: 6px 10px; cursor: pointer; }
  .mp-chip:hover { background: var(--ns-row-hover); }
  .mp-chip[aria-pressed="true"] { background: var(--ns-accent-soft); border-color: var(--ns-accent); color: var(--ns-accent); }
  .mp-colors { display: flex; gap: 8px; }
  .mp-colors input { width: 44px; height: 32px; border: 1px solid var(--ns-border-strong); border-radius: var(--ns-radius-sm); background: none; padding: 2px; cursor: pointer; }
  .mp-note { font-size: var(--ns-fs-sm); color: var(--ns-text-subtle); line-height: 1.45; }
  .mp-actions { display: flex; gap: var(--ns-space-2); justify-content: flex-end; }
  .mp-btn { font: inherit; font-size: var(--ns-fs-md); font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; cursor: pointer;
    border-radius: var(--ns-radius-sm); padding: 10px 16px; border: 1px solid var(--ns-border-strong); background: var(--ns-row); color: var(--ns-text); }
  .mp-btn:hover { background: var(--ns-row-hover); }
  .mp-btn.primary { background: var(--ns-primary); color: var(--ns-on-accent); border: none; box-shadow: var(--ns-glow); }
  .mp-btn.primary:hover { background: var(--ns-primary-hover); }
  .mp-btn.small { padding: 5px 9px; font-size: var(--ns-fs-xs); }
  .mp-btn.danger { border-color: var(--ns-danger-border); color: var(--ns-danger-text); }
  .mp-btn:focus-visible, .mp-chip:focus-visible, .mp-input:focus-visible { outline: 2px solid var(--ns-focus); outline-offset: 2px; }

  .mp-panel { position: fixed; z-index: 40; right: var(--ns-hud-right, 16px); top: calc(var(--ns-hud-top, 16px) + 64px); width: 250px;
    font-family: var(--ns-font); color: var(--ns-text); background: var(--ns-surface); backdrop-filter: var(--ns-blur);
    border: 1px solid var(--ns-border); border-radius: var(--ns-radius-lg); padding: var(--ns-space-3); display: grid; gap: var(--ns-space-2); }
  .mp-panel[hidden] { display: none; }
  .mp-code { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .mp-code b { font-size: var(--ns-fs-lg); color: var(--ns-accent); letter-spacing: 0.12em; }
  .mp-status { font-size: var(--ns-fs-xs); color: var(--ns-text-subtle); text-transform: uppercase; letter-spacing: var(--ns-label-ls); }
  .mp-status.offline { color: var(--ns-warn-text); }
  .mp-roster { list-style: none; display: grid; gap: 4px; max-height: 210px; overflow: auto; }
  .mp-roster li { display: flex; align-items: center; gap: 8px; font-size: var(--ns-fs-md); background: var(--ns-row); border-radius: var(--ns-radius-sm); padding: 5px 8px; }
  .mp-dot { width: 10px; height: 10px; border-radius: 50%; flex: none; box-shadow: 0 0 0 0 transparent; transition: box-shadow var(--ns-dur-fast, .12s); }
  .mp-dot.speaking { box-shadow: 0 0 0 4px rgba(128, 237, 153, 0.55); }
  .mp-roster .mp-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mp-tools { display: flex; flex-wrap: wrap; gap: 6px; }
  .mp-toast { position: fixed; z-index: 210; left: 50%; top: calc(var(--ns-hud-top, 16px) + 64px); transform: translateX(-50%);
    font-family: var(--ns-font); font-size: var(--ns-fs-md); color: var(--ns-text); background: var(--ns-surface-strong);
    border: 1px solid var(--ns-border-strong); border-radius: var(--ns-radius-pill); padding: 8px 16px; pointer-events: none; }
  .mp-toast.warn { border-color: var(--ns-warn-border); color: var(--ns-warn-text); }
  .mp-toast[hidden] { display: none; }
  .ns-kbd-mp { font-size: 10px; opacity: .7; margin-left: 4px; }
  .mp-code-actions { display: flex; align-items: center; gap: 6px; }
  .mp-expand { display: none; width: 32px; height: 32px; padding: 0; place-items: center; border-radius: var(--ns-radius-sm);
    border: 1px solid var(--ns-border-strong); background: var(--ns-row); color: var(--ns-text); cursor: pointer; font: inherit; }
  .mp-expand svg { transition: transform var(--ns-dur-fast, .12s); }
  .mp-panel:not(.mp-collapsed) .mp-expand svg { transform: rotate(180deg); }
  /* Phones: the room panel is one slim glass row under the top bar, lined up with the search bar:
     ROOM code . Copy invite . arrow. The arrow opens players and the Mic / Point / Character / Leave tools */
  @media (max-width: 760px), (pointer: coarse) and (max-height: 520px) {
    .mp-expand { display: grid; width: 36px; height: 36px; border-radius: var(--ns-radius-sm); }
    .mp-panel { z-index: 91; left: var(--ns-hud-left, 16px); right: auto; width: auto;
      max-width: calc(100% - var(--ns-hud-left, 16px) - var(--ns-hud-right, 16px));
      padding: 3px 3px 3px var(--ns-space-3); gap: 0; overflow: auto; overscroll-behavior: contain;
      border-radius: var(--ns-radius-lg); box-shadow: var(--ns-shadow); }
    .mp-panel:not(.mp-collapsed) { width: 260px; padding: 3px var(--ns-space-3) var(--ns-space-3); gap: var(--ns-space-2); }
    .mp-panel.mp-collapsed .mp-roster, .mp-panel.mp-collapsed .mp-tools { display: none; }
    .mp-panel.mp-collapsed .mp-status:not(.offline) { display: none; }
    .mp-panel:not(.mp-collapsed) .mp-code { margin-right: calc(-1 * var(--ns-space-3) + 3px); }
    .mp-code { min-height: 38px; gap: var(--ns-space-3); }
    .mp-code > div:first-child { display: flex; align-items: baseline; gap: 8px; white-space: nowrap; }
    .mp-code .mp-label { font-size: 10px; }
    .mp-code b { font-size: var(--ns-fs-md); letter-spacing: 0.1em; }
    .mp-code-actions { gap: 4px; }
    .mp-code-actions .mp-btn.small { min-height: 36px; padding: 0 12px; box-shadow: none; white-space: nowrap; }
    .mp-tools { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .mp-tools .mp-btn.small { min-height: 36px; width: 100%; }
  }
  /* Portrait: under the top bar row; an open minimap moves down below it (--ns-mp-h) */
  @media (max-width: 760px) {
    .mp-panel { top: calc(var(--ns-hud-top, 16px) + 2 * var(--ns-target, 44px) + 32px);
      max-height: calc(100dvh - var(--ns-hud-top, 16px) - 2 * var(--ns-target, 44px) - 32px - 230px); }
  }
  /* Portrait: swipe the room bar left to tuck it into the screen edge (like a call pop-up);
     a small tab stays at the edge and a tap or a swipe right brings it back */
  .mp-tab { display: none; }
  @media (max-width: 760px) {
    .mp-panel { transition: translate var(--ns-dur, .2s) var(--ns-ease-out, ease-out), top var(--ns-dur, .2s) var(--ns-ease-out, ease-out); touch-action: pan-y; }
    /* Tucked, the tab sits in the empty left corner of the top bar row */
    .mp-panel.mp-tucked { top: calc(var(--ns-hud-top, 16px) + var(--ns-target, 44px) + 16px); }
    .mp-panel.mp-dragging { transition: none; }
    .mp-panel.mp-tucked { translate: calc(-100% - var(--ns-hud-left, 16px) + 30px) 0; overflow: visible; }
    .mp-panel.mp-auto-tuck { transition-duration: .55s; }
    /* After the room starts and the bar tucks itself away: about 1 s later the tab peeks out a little
       and slides back once, like a drawer, so the eye finds it. No text. */
    .mp-panel.mp-tucked.mp-hint { animation: mp-tab-nudge .9s cubic-bezier(.3, 0, .2, 1) 1; }
    @keyframes mp-tab-nudge {
      0%, 100% { translate: calc(-100% - var(--ns-hud-left, 16px) + 30px) 0; }
      40% { translate: calc(-100% - var(--ns-hud-left, 16px) + 52px) 0; }
    }
    @media (prefers-reduced-motion: reduce) { .mp-panel.mp-tucked.mp-hint { animation: none; } }
    .mp-panel.mp-tucked .mp-tab { display: grid; }
    .mp-panel.mp-tucked > :not(.mp-tab) { visibility: hidden; }
    .mp-tab { position: absolute; top: 0; right: 0; bottom: 0; width: 30px; place-items: center; padding: 0;
      border: 0; border-radius: 0 var(--ns-radius-lg) var(--ns-radius-lg) 0; background: var(--ns-input-solid, #0d1220); color: var(--ns-accent);
      cursor: pointer; font: inherit; }
  }
  /* Landscape: under the search bar on the left (the minimap is on the right) */
  @media (pointer: coarse) and (max-height: 520px) {
    .mp-panel { top: calc(var(--ns-hud-top, 16px) + var(--ns-target, 44px) + 14px);
      max-height: calc(100dvh - var(--ns-hud-top, 16px) - var(--ns-target, 44px) - 14px - var(--ns-hud-bottom, 16px)); }
    /* Short screens: while opened it may cover the joystick's top; the arrow folds it away again */
  }
  @media (max-width: 560px) { .mp-row { grid-template-columns: 1fr; } .mp-preview { width: 100%; height: 180px; } }
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Small spinning 3D preview of the chosen avatar */
class AvatarPreview {
  private readonly _renderer: THREE.WebGLRenderer | null = null;
  private readonly _scene = new THREE.Scene();
  private readonly _camera = new THREE.PerspectiveCamera(30, 180 / 220, 0.1, 20);
  private _avatar: Avatar | null = null;
  private _raf = 0;
  private _t = 0;

  constructor(canvas: HTMLCanvasElement, look: AvatarLook) {
    try {
      this._renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      this._renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    } catch {
      return;
    }
    this._camera.position.set(0, 1.0, 4.2);
    this._camera.lookAt(0, 0.85, 0);
    this._scene.add(new THREE.HemisphereLight(0xffffff, 0x554466, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(2, 5, 3);
    this._scene.add(sun);
    this._avatar = new Avatar('', look, '#ffd700', 0);
    this._avatar.group.children[1].visible = false; // no name tag in the preview
    this._scene.add(this._avatar.group);
  }

  setLook(look: AvatarLook): void {
    void this._avatar?.setLook(look);
  }

  start(): void {
    if (!this._renderer || this._raf) return;
    let last = performance.now();
    const loop = (now: number) => {
      this._raf = requestAnimationFrame(loop);
      const dt = (now - last) / 1000;
      last = now;
      this._t += dt;
      const canvas = this._renderer!.domElement;
      const w = canvas.clientWidth || 180;
      const h = canvas.clientHeight || 220;
      if (canvas.width !== Math.round(w * this._renderer!.getPixelRatio())) {
        this._renderer!.setSize(w, h, false);
        this._camera.aspect = w / h;
        this._camera.updateProjectionMatrix();
      }
      // Turn slowly, eyes at y = 0 so the figure stands on y = 0 - 0 = 0
      this._avatar?.update([0, 0, 0, Math.PI + Math.sin(this._t * 0.8) * 0.5, 0], dt, this._t);
      this._renderer!.render(this._scene, this._camera);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this._raf);
    this._raf = 0;
  }
}

export class MpUI {
  private readonly _o: MpUIOptions;
  private readonly _scrim: HTMLElement;
  private readonly _title: HTMLElement;
  private readonly _sub: HTMLElement;
  private readonly _name: HTMLInputElement;
  private readonly _chars: HTMLElement;
  private readonly _colors: HTMLInputElement[] = [];
  private readonly _hat: HTMLSelectElement;
  private readonly _enterBtn: HTMLButtonElement;
  private readonly _cancelBtn: HTMLButtonElement;
  private readonly _preview: AvatarPreview;
  private readonly _panel: HTMLElement;
  private readonly _codeLabel: HTMLElement;
  private _expandBtn!: HTMLButtonElement;
  private _publishH: () => void = () => {};
  private readonly _status: HTMLElement;
  private readonly _roster: HTMLElement;
  private readonly _micBtn: HTMLButtonElement;
  private readonly _toast: HTMLElement;
  private _toastTimer = 0;
  private _look: AvatarLook;
  private _inRoom = false;
  private _joinCode: string | null;

  constructor(o: MpUIOptions) {
    this._o = o;
    this._joinCode = o.joinCode;
    this._look = { ...o.initialLook, colors: [...o.initialLook.colors] as [string, string, string] };
    ensureTokens();
    if (!document.getElementById(STYLE_ID)) {
      const s = document.createElement('style');
      s.id = STYLE_ID;
      s.textContent = CSS;
      document.head.appendChild(s);
    }

    // ---- Lobby card
    this._scrim = el('div', 'mp-scrim');
    this._scrim.setAttribute('role', 'dialog');
    this._scrim.setAttribute('aria-modal', 'true');
    const card = el('div', 'mp-card');
    this._title = el('h2');
    this._sub = el('p', 'mp-sub');
    const row = el('div', 'mp-row');
    const canvas = el('canvas', 'mp-preview');
    const fields = el('div');

    const nameField = el('label', 'mp-field');
    nameField.append(el('span', 'mp-label', 'Your name'));
    this._name = el('input', 'mp-input');
    this._name.maxLength = MAX_NAME_LEN;
    this._name.value = o.initialName;
    this._name.placeholder = 'Shown above your character';
    this._name.setAttribute('autocomplete', 'nickname');
    nameField.append(this._name);

    const charField = el('div', 'mp-field');
    charField.append(el('span', 'mp-label', 'Character'));
    this._chars = el('div', 'mp-chars');
    for (const c of o.characters) {
      const b = el('button', 'mp-chip', c.label);
      b.type = 'button';
      b.dataset.id = c.id;
      b.addEventListener('click', () => {
        this._look = { ...this._look, char: c.id, colors: [...c.colors] as [string, string, string] };
        this._syncLookControls();
        this._lookChanged();
      });
      this._chars.append(b);
    }
    charField.append(this._chars);

    const colorField = el('div', 'mp-field');
    colorField.append(el('span', 'mp-label', 'Colours'));
    const colorRow = el('div', 'mp-colors');
    ['Main colour', 'Second colour', 'Accent colour'].forEach((label, i) => {
      const inp = el('input');
      inp.type = 'color';
      inp.title = label;
      inp.setAttribute('aria-label', label);
      inp.addEventListener('input', () => {
        const colors = [...this._look.colors] as [string, string, string];
        colors[i] = inp.value;
        this._look = { ...this._look, colors };
        this._lookChanged();
      });
      this._colors.push(inp);
      colorRow.append(inp);
    });
    colorField.append(colorRow);

    const hatField = el('label', 'mp-field');
    hatField.append(el('span', 'mp-label', 'Hat'));
    this._hat = el('select', 'mp-select');
    for (const h of HATS) {
      const opt = el('option', undefined, h.label);
      opt.value = h.id;
      this._hat.append(opt);
    }
    this._hat.addEventListener('change', () => {
      this._look = { ...this._look, hat: this._hat.value };
      this._lookChanged();
    });
    hatField.append(this._hat);

    fields.append(nameField, charField, colorField, hatField);
    row.append(canvas, fields);

    const note = el(
      'p',
      'mp-note',
      'Your mic turns on when you enter, and everyone in the room hears everyone. ' +
        'The room is invite only: anyone with the link can join while it is open, so share it only with friends.'
    );
    const actions = el('div', 'mp-actions');
    this._cancelBtn = el('button', 'mp-btn', 'Close');
    this._cancelBtn.type = 'button';
    this._cancelBtn.addEventListener('click', () => {
      const backToSolo = this._mode !== 'edit' && !this._inRoom;
      this.hideLobby();
      if (backToSolo) o.onClose?.();
    });
    this._enterBtn = el('button', 'mp-btn primary');
    this._enterBtn.type = 'button';
    this._enterBtn.addEventListener('click', () => this._enter());
    actions.append(this._cancelBtn, this._enterBtn);
    card.append(this._title, this._sub, row, note, actions);
    this._scrim.append(card);
    document.body.append(this._scrim);
    this._name.addEventListener('keydown', e => {
      if (e.key === 'Enter') this._enter();
    });
    this._preview = new AvatarPreview(canvas, this._look);

    // ---- Room panel
    this._panel = el('aside', 'mp-panel');
    this._panel.hidden = true;
    this._panel.setAttribute('aria-label', 'Multiplayer room');
    const codeRow = el('div', 'mp-code');
    const codeWrap = el('div');
    codeWrap.append(el('div', 'mp-label', 'Room'));
    this._codeLabel = el('b', undefined, '------');
    codeWrap.append(this._codeLabel);
    const copyBtn = el('button', 'mp-btn small primary', 'Copy invite');
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', () => o.onCopyInvite());
    const expandBtn = el('button', 'mp-expand');
    expandBtn.type = 'button';
    expandBtn.setAttribute('aria-label', 'Show players and room tools');
    expandBtn.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
    expandBtn.addEventListener('click', () => this._setCollapsed(!this._panel.classList.contains('mp-collapsed')));
    this._expandBtn = expandBtn;
    const codeActions = el('div', 'mp-code-actions');
    codeActions.append(copyBtn, expandBtn);
    codeRow.append(codeWrap, codeActions);
    this._status = el('div', 'mp-status', 'Connecting');
    this._roster = el('ul', 'mp-roster');
    const tools = el('div', 'mp-tools');
    this._micBtn = el('button', 'mp-btn small', 'Mic');
    this._micBtn.type = 'button';
    this._micBtn.addEventListener('click', () => o.onToggleMic());
    const pointBtn = el('button', 'mp-btn small');
    pointBtn.innerHTML = 'Point<span class="ns-kbd-mp">G</span>';
    pointBtn.type = 'button';
    pointBtn.title = 'Show everyone the spot in the middle of your screen';
    pointBtn.addEventListener('click', () => o.onPoint());
    const lookBtn = el('button', 'mp-btn small', 'Character');
    lookBtn.type = 'button';
    lookBtn.title = 'Change your character';
    lookBtn.addEventListener('click', () => this.showLobby('edit'));
    const leaveBtn = el('button', 'mp-btn small danger', 'Leave');
    leaveBtn.type = 'button';
    leaveBtn.addEventListener('click', () => o.onLeave());
    tools.append(this._micBtn, pointBtn, lookBtn, leaveBtn);
    this._panel.append(codeRow, this._status, this._roster, tools);
    document.body.append(this._panel);
    // Phones: publish the panel's height so the portrait minimap can sit below it
    if (typeof ResizeObserver !== 'undefined') {
      const publish = () => {
        // Tucked into the top bar row it no longer pushes the minimap down
        const h = this._panel.classList.contains('mp-tucked') ? 0 : this._panel.getBoundingClientRect().height;
        document.documentElement.style.setProperty('--ns-mp-h', `${Math.round(h)}px`);
      };
      this._publishH = publish;
      new ResizeObserver(publish).observe(this._panel);
    }

    const tab = el('button', 'mp-tab');
    tab.type = 'button';
    tab.setAttribute('aria-label', 'Show the room bar');
    tab.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
    tab.addEventListener('click', () => this._setTucked(false));
    this._panel.append(tab);
    this._setupTuckSwipe();

    this._toast = el('div', 'mp-toast');
    this._toast.hidden = true;
    this._toast.setAttribute('role', 'status');
    document.body.append(this._toast);

    window.addEventListener('keydown', e => {
      if (!this._inRoom || isTypingTarget(e) || e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;
      if (!this._scrim.hidden) return;
      if (e.code === 'KeyG') o.onPoint();
      if (e.code === 'KeyV') o.onToggleMic();
    });

    this._syncLookControls();
    this.showLobby(this._joinCode ? 'join' : 'create');
  }

  setJoinCode(code: string | null): void {
    this._joinCode = code;
  }

  get look(): AvatarLook {
    return this._look;
  }

  private _syncLookControls(): void {
    for (const b of this._chars.querySelectorAll<HTMLButtonElement>('.mp-chip')) {
      b.setAttribute('aria-pressed', String(b.dataset.id === this._look.char));
    }
    this._look.colors.forEach((c, i) => (this._colors[i].value = c));
    this._hat.value = this._look.hat;
    this._preview.setLook(this._look);
  }

  private _lookChanged(): void {
    this._preview.setLook(this._look);
    if (this._inRoom) this._o.onLookChange(this._look);
  }

  private _mode: 'create' | 'join' | 'edit' = 'create';

  showLobby(mode: 'create' | 'join' | 'edit'): void {
    this._mode = mode;
    if (document.pointerLockElement) document.exitPointerLock();
    if (mode === 'create') {
      this._title.textContent = 'Multiplayer room';
      this._sub.textContent = 'Pick your character, then create a room and send the invite link to your friends.';
      this._enterBtn.textContent = 'Create room';
    } else if (mode === 'join') {
      this._title.textContent = `Join room ${formatRoomCode(this._joinCode ?? '')}`;
      this._sub.textContent = 'A friend invited you. Pick your character and jump in.';
      this._enterBtn.textContent = 'Join room';
    } else {
      this._title.textContent = 'Your character';
      this._sub.textContent = 'Changes show for everyone straight away.';
      this._enterBtn.textContent = 'Done';
    }
    this._cancelBtn.hidden = mode !== 'edit' && !this._inRoom && !this._o.closable;
    this._scrim.hidden = false;
    this._preview.start();
    setTimeout(() => (mode === 'edit' ? this._enterBtn : this._name).focus(), 0);
  }

  hideLobby(): void {
    this._scrim.hidden = true;
    this._preview.stop();
  }

  private _enter(): void {
    const name = this._name.value.trim() || 'Guest';
    if (this._mode === 'edit') {
      this._o.onNameChange(name);
      this.hideLobby();
      return;
    }
    this.hideLobby();
    this._o.onEnter({ name, look: this._look });
  }

  enterRoom(code: string): void {
    this._inRoom = true;
    this._codeLabel.textContent = formatRoomCode(code);
    this._setCollapsed(true); // only matters on phones; desktop always shows the full panel
    this._panel.classList.remove('mp-tucked', 'mp-hint');
    this._panel.hidden = false;
    this._publishH();
    this._scheduleAutoTuck();
  }

  private _autoTuckTimer = 0;
  private _hintTimer = 0;

  /** Portrait phones: the full room box (code, invite, players, tools) shows briefly, then slides into the
   *  left edge by itself; a second later the tab nudges out and back once. Touching the box first keeps it open. */
  private _scheduleAutoTuck(): void {
    window.clearTimeout(this._autoTuckTimer);
    window.clearTimeout(this._hintTimer);
    if (!(window.matchMedia?.('(max-width: 760px)').matches ?? false)) return;
    this._setCollapsed(false);
    const cancel = () => window.clearTimeout(this._autoTuckTimer);
    this._panel.addEventListener('pointerdown', cancel, { once: true });
    this._autoTuckTimer = window.setTimeout(() => {
      this._panel.removeEventListener('pointerdown', cancel);
      if (!this._inRoom || this._panel.classList.contains('mp-tucked')) return;
      // Slide the whole box in first, then fold it once it is out of sight
      this._panel.classList.add('mp-auto-tuck', 'mp-tucked');
      this._publishH();
      window.setTimeout(() => this._panel.classList.contains('mp-tucked') && this._setCollapsed(true), 600);
      this._hintTimer = window.setTimeout(() => {
        this._panel.classList.remove('mp-auto-tuck');
        if (!this._panel.classList.contains('mp-tucked')) return;
        this._panel.classList.add('mp-hint');
        this._hintTimer = window.setTimeout(() => this._panel.classList.remove('mp-hint'), 1000);
      }, 1500);
    }, 1600);
  }

  private _setTucked(tucked: boolean): void {
    if (tucked) this._setCollapsed(true);
    else this._panel.classList.remove('mp-hint');
    this._panel.classList.toggle('mp-tucked', tucked);
    this._publishH();
  }

  /** Portrait phones: a left swipe on the room bar tucks it into the screen edge, a right swipe brings it back */
  private _setupTuckSwipe(): void {
    const panel = this._panel;
    const portrait = () => window.matchMedia?.('(max-width: 760px)').matches ?? false;
    let start: { x: number; y: number; id: number } | null = null;
    let dx = 0;
    let dragging = false;
    panel.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch' || !portrait()) return;
      start = { x: e.clientX, y: e.clientY, id: e.pointerId };
      dx = 0;
      dragging = false;
    });
    panel.addEventListener('pointermove', e => {
      if (!start || e.pointerId !== start.id) return;
      const mx = e.clientX - start.x;
      if (!dragging && Math.abs(mx) > 10 && Math.abs(mx) > Math.abs(e.clientY - start.y)) {
        dragging = true;
        panel.setPointerCapture?.(e.pointerId);
        panel.classList.add('mp-dragging');
      }
      if (!dragging) return;
      const tucked = panel.classList.contains('mp-tucked');
      dx = tucked ? Math.max(0, mx) : Math.min(0, mx);
      if (!tucked) panel.style.translate = `${dx}px 0`;
    });
    const end = (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return;
      start = null;
      panel.classList.remove('mp-dragging');
      panel.style.translate = '';
      if (!dragging) return;
      dragging = false;
      const tucked = panel.classList.contains('mp-tucked');
      if (!tucked && dx < -50) this._setTucked(true);
      else if (tucked && dx > 30) this._setTucked(false);
      swipedAt = performance.now();
    };
    // A swipe must not also press a button under the finger
    let swipedAt = -1e9;
    panel.addEventListener(
      'click',
      ev => {
        if (performance.now() - swipedAt < 350) {
          ev.stopPropagation();
          ev.preventDefault();
        }
      },
      { capture: true }
    );
    panel.addEventListener('pointerup', end);
    panel.addEventListener('pointercancel', end);
  }

  private _setCollapsed(collapsed: boolean): void {
    this._panel.classList.toggle('mp-collapsed', collapsed);
    this._expandBtn.setAttribute('aria-expanded', String(!collapsed));
  }

  leaveRoom(): void {
    this._inRoom = false;
    this._panel.hidden = true;
  }

  setStatus(text: string, offline = false): void {
    this._status.textContent = text;
    this._status.classList.toggle('offline', offline);
  }

  setMic(state: MicState): void {
    const label: Record<MicState, string> = {
      off: 'Mic off',
      on: 'Mute',
      muted: 'Unmute',
      denied: 'Mic blocked',
      unsupported: 'No voice',
    };
    this._micBtn.innerHTML = `${label[state]}<span class="ns-kbd-mp">V</span>`;
    this._micBtn.disabled = state === 'denied' || state === 'unsupported';
    this._micBtn.title =
      state === 'denied' ? 'The browser blocked the microphone. Allow it in the address bar, then reload.' : 'Mute or unmute your mic';
  }

  setRoster(entries: RosterEntry[]): void {
    this._roster.replaceChildren();
    for (const e of entries) {
      const li = el('li');
      const dot = el('span', 'mp-dot' + (e.speaking ? ' speaking' : ''));
      dot.style.background = SLOT_COLORS[e.slot % SLOT_COLORS.length];
      const name = el('span', 'mp-name', e.me ? `${e.name} (you)` : e.name);
      li.append(dot, name);
      if (!e.me) {
        const go = el('button', 'mp-btn small', 'Go');
        go.type = 'button';
        go.title = `Show the path to ${e.name}`;
        go.addEventListener('click', () => this._o.onGoTo(e.id));
        li.append(go);
      }
      this._roster.append(li);
    }
  }

  toast(text: string, warn = false, ms = 3500): void {
    this._toast.textContent = text;
    this._toast.classList.toggle('warn', warn);
    this._toast.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = window.setTimeout(() => (this._toast.hidden = true), ms);
  }
}
