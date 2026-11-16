/**
 * Touch controls for phones and tablets (Round 2).
 *
 * - Joystick (bottom left): move forward / back / left / right. Tilt sets the speed; pull the thumb
 *   past the ring to run.
 * - Drag anywhere on the view: look around (a full screen-width swipe turns about 180 degrees).
 * - Right-hand buttons: Up / Down in Free roam (like E / Q), Jump in Walk mode (like Space).
 *
 * Only created on touch screens ((pointer: coarse) or (any-pointer: coarse) without a fine pointer).
 * The joystick sits above the bottom cards: it reads --ns-nav-stack-h (published by NavUI) and
 * --ns-sheet-h (tag mode Places sheet).
 */

import type { MoveMode } from './movement.js';
import { ensureTokens } from '../ui/tokens.js';
import TOUCH_CSS from './touch_controls.css?raw';

export interface TouchMovementTarget {
  setAnalog(forward: number, right: number, sprint?: boolean): void;
  setVertical(rise: boolean, sink: boolean): void;
  setJump(held: boolean): void;
  handleMouseMove(deltaX: number, deltaY: number): void;
}

export interface TouchControlsOptions {
  /** Element that receives look drags (the WebGL canvas) */
  lookTarget: HTMLElement;
  getTarget: () => TouchMovementTarget | null;
  initialMode: MoveMode;
  /** Radians per pixel the controller applies in handleMouseMove (its mouse sensitivity) */
  mouseSensitivity?: number;
  container?: HTMLElement;
}

const STICK_RADIUS = 52;
/** Portrait: the pads hide while the bottom panels take more than this share of the height */
const TUCK_SHARE = 0.34;
/** Pulling the thumb this far past the centre (in radii) runs */
const RUN_PULL = 1.45;
/** Swipe across the whole screen width turns this many radians */
const LOOK_RAD_PER_SCREEN = Math.PI;

export class TouchControls {
  private readonly _root: HTMLDivElement;
  private readonly _stick: HTMLDivElement;
  private readonly _knob: HTMLDivElement;
  private readonly _flyGroup: HTMLDivElement;
  private readonly _jumpBtn: HTMLButtonElement;
  private readonly _getTarget: () => TouchMovementTarget | null;
  private readonly _sensitivity: number;
  private _stickPointer: number | null = null;
  private _stickCentre = { x: 0, y: 0 };
  private _lookPointer: number | null = null;
  private _lookLast = { x: 0, y: 0 };
  private _rise = false;
  private _sink = false;
  private _cleanup: (() => void)[] = [];

  constructor(options: TouchControlsOptions) {
    this._getTarget = options.getTarget;
    this._sensitivity = options.mouseSensitivity ?? 0.002;
    ensureTokens();
    injectStyles();

    this._root = document.createElement('div');
    this._root.id = 'touch-controls';
    this._root.className = 'touch-controls ns-ui';
    // Stick size comes from STICK_RADIUS, which the drag maths also uses
    this._root.style.setProperty('--tc-stick-d', `${STICK_RADIUS * 2}px`);

    // Joystick
    this._stick = document.createElement('div');
    this._stick.className = 'tc-stick';
    this._stick.setAttribute('role', 'application');
    this._stick.setAttribute('aria-label', 'Move: drag the stick. Pull past the ring to run.');
    this._stick.innerHTML = `
      <span class="tc-arrow tc-up" aria-hidden="true"></span>
      <span class="tc-arrow tc-down" aria-hidden="true"></span>
      <span class="tc-arrow tc-left" aria-hidden="true"></span>
      <span class="tc-arrow tc-right" aria-hidden="true"></span>`;
    this._knob = document.createElement('div');
    this._knob.className = 'tc-knob';
    this._stick.appendChild(this._knob);

    // Free roam: up / down (hold)
    this._flyGroup = document.createElement('div');
    this._flyGroup.className = 'tc-buttons';
    const upBtn = this._holdButton('tc-up-btn', 'Fly up', 'M6 15l6-6 6 6', on => {
      this._rise = on;
      this._getTarget()?.setVertical(this._rise, this._sink);
    });
    const downBtn = this._holdButton('tc-down-btn', 'Fly down', 'M6 9l6 6 6-6', on => {
      this._sink = on;
      this._getTarget()?.setVertical(this._rise, this._sink);
    });
    this._flyGroup.append(upBtn, downBtn);

    // Walk: jump (hold)
    this._jumpBtn = this._holdButton('tc-jump-btn', 'Jump', 'M12 19V6M6 11l6-6 6 6', on => {
      this._getTarget()?.setJump(on);
    });
    this._jumpBtn.classList.add('tc-jump');

    const right = document.createElement('div');
    right.className = 'tc-right-col';
    right.append(this._flyGroup, this._jumpBtn);

    this._root.append(this._stick, right);
    (options.container ?? document.body).appendChild(this._root);

    this._bindStick();
    this._bindLook(options.lookTarget);
    this.setMode(options.initialMode);
    this._watchRoom();
  }

  /**
   * The pads step aside (fade out) while the bottom panels take a big part of a portrait screen
   * (a place card over an open Places sheet), so they never float high up over the room. They come
   * back as soon as the panels shrink. The Rearrange panel hides them by its own class.
   */
  private _watchRoom(): void {
    const root = document.documentElement;
    const px = (name: string) => parseFloat(root.style.getPropertyValue(name)) || 0;
    const check = () => {
      const portrait = window.innerHeight > window.innerWidth;
      const taken = px('--ns-sheet-h') + px('--ns-nav-stack-h');
      this._root.classList.toggle('tc-tucked', portrait && taken > window.innerHeight * TUCK_SHARE);
    };
    const obs = new MutationObserver(check);
    obs.observe(root, { attributes: true, attributeFilter: ['style'] });
    window.addEventListener('resize', check);
    this._cleanup.push(() => { obs.disconnect(); window.removeEventListener('resize', check); });
    check();
  }

  /** Free roam shows Up / Down, Walk shows Jump */
  setMode(mode: MoveMode): void {
    this._flyGroup.classList.toggle('hidden', mode !== 'free');
    this._jumpBtn.classList.toggle('hidden', mode !== 'walk');
    this._rise = this._sink = false;
    this._getTarget()?.setVertical(false, false);
    this._getTarget()?.setJump(false);
  }

  dispose(): void {
    for (const fn of this._cleanup) fn();
    this._cleanup = [];
    this._root.remove();
  }

  private _holdButton(id: string, label: string, path: string, onHold: (on: boolean) => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = id;
    btn.className = 'tc-btn';
    btn.setAttribute('aria-label', label);
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path d="${path}" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    let pointer: number | null = null;
    btn.addEventListener('pointerdown', e => {
      e.preventDefault();
      pointer = e.pointerId;
      btn.setPointerCapture?.(e.pointerId);
      btn.classList.add('active');
      onHold(true);
    });
    const release = (e: PointerEvent) => {
      if (pointer !== e.pointerId) return;
      pointer = null;
      btn.classList.remove('active');
      onHold(false);
    };
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('contextmenu', e => e.preventDefault());
    return btn;
  }

  private _bindStick(): void {
    const stick = this._stick;
    const move = (clientX: number, clientY: number) => {
      const dx = clientX - this._stickCentre.x;
      const dy = clientY - this._stickCentre.y;
      const dist = Math.hypot(dx, dy);
      const k = dist > STICK_RADIUS ? STICK_RADIUS / dist : 1;
      this._knob.style.transform = `translate(-50%, -50%) translate(${dx * k}px, ${dy * k}px)`;
      const run = dist > STICK_RADIUS * RUN_PULL;
      stick.classList.toggle('running', run);
      // Screen up is forward
      this._getTarget()?.setAnalog((-dy * k) / STICK_RADIUS, (dx * k) / STICK_RADIUS, run);
    };
    const end = (e: PointerEvent) => {
      if (this._stickPointer !== e.pointerId) return;
      this._stickPointer = null;
      stick.classList.remove('active', 'running');
      this._knob.style.transform = 'translate(-50%, -50%)';
      this._getTarget()?.setAnalog(0, 0);
    };
    stick.addEventListener('pointerdown', e => {
      if (this._stickPointer !== null) return;
      e.preventDefault();
      e.stopPropagation();
      this._stickPointer = e.pointerId;
      stick.setPointerCapture?.(e.pointerId);
      const r = stick.getBoundingClientRect();
      this._stickCentre = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      stick.classList.add('active');
      move(e.clientX, e.clientY);
    });
    stick.addEventListener('pointermove', e => {
      if (this._stickPointer !== e.pointerId) return;
      e.preventDefault();
      move(e.clientX, e.clientY);
    });
    stick.addEventListener('pointerup', end);
    stick.addEventListener('pointercancel', end);
    stick.addEventListener('lostpointercapture', end);
  }

  private _bindLook(target: HTMLElement): void {
    target.style.touchAction = 'none';
    const down = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' || this._lookPointer !== null) return;
      this._lookPointer = e.pointerId;
      this._lookLast = { x: e.clientX, y: e.clientY };
    };
    const moveLook = (e: PointerEvent) => {
      if (e.pointerId !== this._lookPointer) return;
      const dx = e.clientX - this._lookLast.x;
      const dy = e.clientY - this._lookLast.y;
      this._lookLast = { x: e.clientX, y: e.clientY };
      if (dx === 0 && dy === 0) return;
      // Convert screen pixels to the controller's "mouse pixels" so a full-width swipe turns ~180 deg
      const radPerPx = LOOK_RAD_PER_SCREEN / Math.max(320, window.innerWidth);
      const scale = radPerPx / this._sensitivity;
      this._getTarget()?.handleMouseMove(dx * scale, dy * scale);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId === this._lookPointer) this._lookPointer = null;
    };
    target.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', moveLook);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    // iOS: stop pinch zoom and double-tap zoom on the view
    const noGesture = (e: Event) => e.preventDefault();
    document.addEventListener('gesturestart', noGesture);
    this._cleanup.push(() => {
      target.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', moveLook);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.removeEventListener('gesturestart', noGesture);
    });
  }
}

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected || document.getElementById('namma-touch-style')) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.id = 'namma-touch-style';
  style.textContent = TOUCH_CSS;
  document.head.appendChild(style);
}
