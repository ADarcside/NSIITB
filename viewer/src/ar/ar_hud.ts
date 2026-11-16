/**
 * Namma Space AR: the flat overlay (cards, buttons, messages). It only shows what it is told;
 * the words come from phrases.ts via ar_main.ts, so switching language is one re-render.
 *
 * The root element is also the WebXR DOM overlay root, so the same buttons work before and
 * inside the camera view.
 */

import { ensureTokens } from '../ui/tokens.js';
import HUD_CSS from './ar_hud.css?raw';

/** What the overlay shows; ar_main.ts builds one of these per state */
export type HudView =
  | { kind: 'checking'; message: string }
  | { kind: 'unsupported'; title: string; detail: string; back: string; lang: string }
  | {
      kind: 'ready';
      kicker: string;
      title: string;
      lines: string[];
      error: string | null;
      start: string;
      busy: boolean;
      safety: string;
      back: string;
      lang: string;
    }
  | {
      kind: 'session';
      message: string;
      detail: string;
      note: string;
      /** Extra buttons above the bar (Yes / Flip / Redo); the first one is the main action */
      actions: HudAction[];
      /** Small buttons in the bottom bar before the language switch (for example a speaker button) */
      extra?: HudAction[];
      /** The place picker, shown over the camera view while open */
      picker?: HudPicker;
      exit: string;
      lang: string;
    };

/** Search box and a short list of places, to change the place without leaving AR */
export interface HudPicker {
  title: string;
  placeholder: string;
  query: string;
  results: HudAction[];
  empty: string;
  cancel: string;
}

export interface HudAction {
  id: string;
  label: string;
}

export interface HudHandlers {
  onStart(): void;
  onExit(): void;
  onBack(): void;
  onLang(): void;
  onAction(id: string): void;
  /** Text typed into the place picker's search box */
  onPickerInput?(query: string): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class ArHud {
  readonly root: HTMLElement;

  constructor(
    host: HTMLElement,
    private readonly handlers: HudHandlers
  ) {
    ensureTokens();
    const style = document.createElement('style');
    style.textContent = HUD_CSS;
    document.head.appendChild(style);
    this.root = host;
    // A tap on an overlay button (or the picker) must not also count as an AR tap on the floor
    this.root.addEventListener('beforexrselect', e => {
      if ((e.target as Element | null)?.closest('button, input, .ar-picker')) e.preventDefault();
    });
  }

  setLangAttr(lang: string): void {
    this.root.lang = lang;
  }

  render(view: HudView): void {
    const r = this.root;
    r.replaceChildren();
    r.dataset.view = view.kind;
    switch (view.kind) {
      case 'checking': {
        const panel = el('div', 'ar-panel');
        panel.append(el('div', 'ar-line', view.message));
        r.append(panel);
        break;
      }
      case 'unsupported': {
        const panel = el('div', 'ar-panel');
        panel.setAttribute('role', 'alert');
        panel.append(el('div', 'ar-title', view.title), el('div', 'ar-line', view.detail));
        panel.append(this.row(this.button('ar-secondary', view.back, this.handlers.onBack), this.langButton(view.lang)));
        r.append(panel);
        break;
      }
      case 'ready': {
        const panel = el('div', 'ar-panel');
        panel.append(el('div', 'ar-kicker', view.kicker), el('div', 'ar-title', view.title));
        for (const line of view.lines) panel.append(el('div', 'ar-line', line));
        if (view.error) {
          const err = el('div', 'ar-error', view.error);
          err.setAttribute('role', 'alert');
          panel.append(err);
        }
        const start = this.button('ar-primary', view.start, this.handlers.onStart);
        start.disabled = view.busy;
        start.dataset.action = 'start';
        panel.append(start, el('div', 'ar-safety', view.safety));
        panel.append(this.row(this.button('ar-secondary', view.back, this.handlers.onBack), this.langButton(view.lang)));
        r.append(panel);
        break;
      }
      case 'session': {
        const top = el('div', 'ar-top');
        top.setAttribute('aria-live', 'polite');
        top.append(el('div', 'ar-message', view.message));
        const detail = el('div', 'ar-detail', view.detail);
        detail.hidden = !view.detail;
        top.append(detail);
        if (view.note) top.append(el('div', 'ar-note', view.note));
        const bottom = el('div', 'ar-bottom-wrap');
        if (view.actions.length > 0) {
          const acts = el('div', 'ar-actions');
          view.actions.forEach((a, i) => {
            const b = this.button(i === 0 ? 'ar-primary' : 'ar-secondary', a.label, () => this.handlers.onAction(a.id));
            b.dataset.action = a.id;
            acts.append(b);
          });
          bottom.append(acts);
        }
        const bar = el('div', 'ar-bottom');
        for (const a of view.extra ?? []) {
          const b = this.button('ar-secondary', a.label, () => this.handlers.onAction(a.id));
          b.dataset.action = a.id;
          bar.append(b);
        }
        const exit = this.button('ar-exit', view.exit, this.handlers.onExit);
        exit.dataset.action = 'exit';
        bar.append(this.langButton(view.lang), exit);
        bottom.append(bar);
        r.append(top, bottom);
        if (view.picker) r.append(this.picker(view.picker));
        break;
      }
    }
  }

  /**
   * Places the edge arrow (fractions of the screen, angle in degrees), or hides it with null.
   * Called every frame, so it only moves one element.
   */
  setEdgeArrow(a: { x: number; y: number; angleDeg: number } | null): void {
    let e = this.root.querySelector<HTMLElement>('.ar-edge');
    if (!a) {
      if (e) e.hidden = true;
      return;
    }
    if (!e) {
      e = el('div', 'ar-edge');
      e.setAttribute('aria-hidden', 'true');
      this.root.append(e);
    }
    e.hidden = false;
    e.style.left = `${(a.x * 100).toFixed(2)}%`;
    e.style.top = `${(a.y * 100).toFixed(2)}%`;
    e.style.transform = `translate(-50%, -50%) rotate(${a.angleDeg.toFixed(1)}deg)`;
  }

  /** Replaces only the picker's result list (typing must not re-render the search box). */
  setPickerResults(results: HudAction[], empty: string): void {
    const list = this.root.querySelector<HTMLElement>('.ar-picker-list');
    if (list) this.fillPickerList(list, results, empty);
  }

  /** Updates only the small detail line in the camera view (called often, so no re-render). */
  setDetail(text: string): void {
    const d = this.root.querySelector<HTMLElement>('.ar-detail');
    if (!d) return;
    if (d.textContent !== text) d.textContent = text;
    d.hidden = !text;
  }

  private button(cls: string, label: string, onClick: () => void): HTMLButtonElement {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  private langButton(label: string): HTMLButtonElement {
    const b = this.button('ar-secondary', label, this.handlers.onLang);
    b.dataset.action = 'lang';
    return b;
  }

  private picker(p: HudPicker): HTMLElement {
    const wrap = el('div', 'ar-picker');
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-label', p.title);
    wrap.append(el('div', 'ar-title', p.title));
    const input = el('input', 'ar-picker-input');
    input.type = 'search';
    input.placeholder = p.placeholder;
    input.value = p.query;
    input.setAttribute('aria-label', p.placeholder);
    input.addEventListener('input', () => this.handlers.onPickerInput?.(input.value));
    const list = el('div', 'ar-picker-list');
    this.fillPickerList(list, p.results, p.empty);
    const cancel = this.button('ar-secondary', p.cancel, () => this.handlers.onAction('picker-cancel'));
    cancel.dataset.action = 'picker-cancel';
    wrap.append(input, list, cancel);
    return wrap;
  }

  private fillPickerList(list: HTMLElement, results: HudAction[], empty: string): void {
    list.replaceChildren();
    if (results.length === 0) {
      list.append(el('div', 'ar-line', empty));
      return;
    }
    for (const r of results) {
      const b = this.button('ar-picker-item', r.label, () => this.handlers.onAction(r.id));
      b.dataset.action = r.id;
      list.append(b);
    }
  }

  private row(...children: HTMLElement[]): HTMLElement {
    const row = el('div', 'ar-row');
    row.append(...children);
    return row;
  }
}
