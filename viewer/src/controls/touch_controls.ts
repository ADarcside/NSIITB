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

/** True on phones and tablets, where there is no WASD and no mouse */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

const STICK_RADIUS = 52;
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
  style.textContent = `
    .touch-controls {
      position: absolute;
      left: var(--ns-hud-left);
      right: var(--ns-hud-right);
      bottom: calc(var(--ns-hud-bottom) + var(--ns-sheet-h, 0px) + var(--ns-nav-stack-h, 0px) + 8px);
      z-index: 85;
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      pointer-events: none;
      transition: bottom var(--ns-dur) var(--ns-ease-out);
    }
    html.ns-search-open .touch-controls, html.ns-help-open .touch-controls { display: none; }
    .tc-stick {
      position: relative;
      flex: none;
      width: ${STICK_RADIUS * 2 + 20}px;
      height: ${STICK_RADIUS * 2 + 20}px;
      border-radius: 50%;
      background: rgba(10, 10, 12, 0.38);
      border: 1.5px solid rgba(255, 255, 255, 0.28);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      pointer-events: auto;
      touch-action: none;
      -webkit-touch-callout: none;
      transition: border-color var(--ns-dur-fast) ease, box-shadow var(--ns-dur-fast) ease;
    }
    .tc-stick.active { border-color: var(--ns-accent); }
    .tc-stick.running { box-shadow: 0 0 0 4px var(--ns-accent-ring), 0 0 18px var(--ns-accent-ring); }
    .tc-knob {
      position: absolute;
      left: 50%;
      top: 50%;
      width: 50px;
      height: 50px;
      border-radius: 50%;
      transform: translate(-50%, -50%);
      background: rgba(255, 255, 255, 0.86);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45);
      pointer-events: none;
    }
    .tc-stick.active .tc-knob { background: var(--ns-accent); }
    .tc-arrow {
      position: absolute;
      width: 0;
      height: 0;
      border: 6px solid transparent;
      opacity: 0.7;
    }
    .tc-up { top: 7px; left: 50%; margin-left: -6px; border-bottom-color: #fff; border-top-width: 0; }
    .tc-down { bottom: 7px; left: 50%; margin-left: -6px; border-top-color: #fff; border-bottom-width: 0; }
    .tc-left { left: 7px; top: 50%; margin-top: -6px; border-right-color: #fff; border-left-width: 0; }
    .tc-right { right: 7px; top: 50%; margin-top: -6px; border-left-color: #fff; border-right-width: 0; }
    .tc-right-col { display: flex; flex-direction: column; align-items: flex-end; gap: 10px; }
    .tc-buttons { display: flex; flex-direction: column; gap: 10px; }
    .tc-buttons.hidden, .tc-jump.hidden { display: none; }
    .tc-btn {
      width: 54px;
      height: 54px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      border: 1.5px solid rgba(255, 255, 255, 0.28);
      background: rgba(10, 10, 12, 0.45);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      color: #fff;
      pointer-events: auto;
      touch-action: none;
      -webkit-touch-callout: none;
      -webkit-tap-highlight-color: transparent;
    }
    .tc-btn.active { background: var(--ns-accent); color: #0a0a0c; border-color: var(--ns-accent); }
    /* Short landscape phones: smaller pads so the view stays open */
    @media (pointer: coarse) and (max-height: 520px) {
      .touch-controls { bottom: calc(var(--ns-hud-bottom) + 4px); }
      .tc-stick { width: ${STICK_RADIUS * 2}px; height: ${STICK_RADIUS * 2}px; }
      .tc-btn { width: 46px; height: 46px; }
      /* Up / Down side by side, so they stay under the minimap */
      .tc-buttons { flex-direction: row; }
    }
  `;
  document.head.appendChild(style);
}
