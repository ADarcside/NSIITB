/**
 * Namma Space: Rearrange panel (move furniture, visitor mode), loaded on demand
 *
 * An enlarged floor plan: drag a piece to move it (green = fits, red = it will snap back), turn it
 * with the two buttons (or Q / E), Undo, Redo, Reset and Done. Works the same with a mouse and a
 * finger, so it does not fight the touch walk controls. A visitor's changes stay on this device
 * only. In tag mode (admin) the same panel edits the layout for everyone: Lock fixes a piece for
 * visitors, Original puts the room back as scanned, and Save for everyone commits it.
 */

import { ensureTokens, icon, THEME } from './tokens.js';
import { movedCorners, LAYOUT_LIMITS, type Move } from '../layout/layout.js';
import type { RearrangeController } from '../layout/rearrange.js';
import { ADDED_BOX_ID, type MovableObject, type BoxEdit } from '../layout/objects.js';
import RR_CSS from './rearrange_ui.css?raw';

type Pt = { x: number; z: number };
type Box = { minX: number; minZ: number; maxX: number; maxZ: number };
/** One box as the box tool shows it */
interface ToolBox { id: number; box: Box; removed: boolean; edited: boolean; added: boolean; movable: boolean }
type V3 = { x: number; y: number; z: number };
/** A ray from the camera through a point of the 3D view (world metres) */
export type ViewRay = (clientX: number, clientY: number) => { origin: V3; dir: V3 } | null;
type BoxDrag = { id: number | null; kind: 'move' | 'corner' | 'new'; corner: [0 | 1, 0 | 1]; start: Pt; orig: Box; cur: Box };

export interface RearrangeUIOptions {
  getPose: () => { x: number; z: number; yaw: number };
  /** Called when the panel opens or closes (stop walking keys, release the mouse) */
  onOpenChange?: (open: boolean) => void;
  /** Admin (tag mode): saves the layout for everyone */
  save?: () => Promise<void>;
}

export class RearrangeUI {
  private readonly _layer: HTMLElement;
  private readonly _canvas: HTMLCanvasElement;
  private readonly _hint: HTMLElement;
  private readonly _toasts: HTMLElement;
  private readonly _note: HTMLElement;
  private readonly _btn: Record<'left' | 'right' | 'undo' | 'redo' | 'reset' | 'done', HTMLButtonElement>;
  private readonly _lockBtn: HTMLButtonElement | null = null;
  private readonly _saveBtn: HTMLButtonElement | null = null;
  private readonly _boxBtns: { mode: HTMLButtonElement; remove: HTMLButtonElement; auto: HTMLButtonElement } | null = null;
  private _saving = false;
  /** Box tool (admin): fix the detected furniture boxes */
  private _boxMode = false;
  private _boxSel: number | null = null;
  private _boxDrag: BoxDrag | null = null;
  private _open = false;
  private _selected: number | null = null;
  private _view = { scale: 1, ox: 0, oz: 0, minX: 0, minZ: 0 };
  private _drag: { id: number; start: Pt; base: Move; moved: boolean } | null = null;
  private _raf = 0;
  /** Laptop extra: dragging a piece straight in the 3D view while the panel is open */
  private _viewRay: ViewRay | null = null;
  private _drag3d: { id: number; pointerId: number; y: number; grab: Pt; base: Move; moved: boolean; sx: number; sy: number } | null = null;

  constructor(private readonly _rr: RearrangeController, private readonly _opts: RearrangeUIOptions) {
    ensureTokens();
    if (!document.getElementById('rr-styles')) {
      const style = document.createElement('style');
      style.id = 'rr-styles';
      style.textContent = RR_CSS;
      document.head.appendChild(style);
    }
    this._toasts = document.createElement('div');
    this._toasts.className = 'rr-toasts ns-ui';
    this._toasts.setAttribute('role', 'status');
    this._toasts.setAttribute('aria-live', 'polite');
    document.body.appendChild(this._toasts);

    this._layer = document.createElement('div');
    this._layer.className = 'rr-layer ns-ui hidden';
    const panel = document.createElement('div');
    panel.className = 'rr-panel';
    panel.setAttribute('role', 'dialog');
    const admin = _rr.mode === 'admin';
    panel.setAttribute('aria-label', admin ? 'Room layout for everyone' : 'Rearrange furniture');
    panel.innerHTML = `
      <div class="rr-head"><span class="rr-title ns-label">${admin ? 'Layout for everyone' : 'Rearrange'}</span><span class="rr-note"></span></div>
      <canvas class="rr-canvas" aria-label="Floor plan: drag a piece to move it"></canvas>
      <div class="rr-hint"></div>
      <div class="rr-tools"></div>`;
    this._canvas = panel.querySelector('canvas')!;
    this._hint = panel.querySelector('.rr-hint')!;
    this._note = panel.querySelector('.rr-note')!;
    const tools = panel.querySelector('.rr-tools')!;
    const make = (cls: string, iconName: string, label: string, title: string, onClick: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `ns-btn ns-press ${cls}`;
      b.title = title;
      b.setAttribute('aria-label', label);
      b.innerHTML = `${icon(iconName, 16)}<span>${label}</span>`;
      b.addEventListener('click', () => { b.blur(); onClick(); });
      tools.appendChild(b);
      return b;
    };
    const step = LAYOUT_LIMITS.turnStepDeg;
    this._btn = {
      left: make('rr-left', 'turnLeft', 'Turn left', `Turn ${step}° left (Q)`, () => this._turn(step)),
      right: make('rr-right', 'turnRight', 'Turn right', `Turn ${step}° right (E)`, () => this._turn(-step)),
      undo: make('rr-undo', 'undo', 'Undo', 'Undo (Ctrl+Z)', () => this._rr.undo()),
      redo: make('rr-redo', 'redo', 'Redo', 'Redo (Ctrl+Y)', () => this._rr.redo()),
      reset: admin
        ? make('rr-reset', 'reset', 'Original', 'Put everything back as scanned (then Save for everyone)', () => this._rr.reset())
        : make('rr-reset', 'reset', 'Reset', _rr.baseMoves.length ? 'Back to the room as the owner set it' : 'Put everything back as scanned', () => this._rr.reset()),
      done: make('rr-done', 'close', 'Done', 'Close Rearrange (Esc)', () => this.close()),
    };
    if (admin) {
      this._lockBtn = make('rr-lock', 'lock', 'Lock', 'Lock or unlock the selected piece for visitors', () => {
        if (this._selected !== null) this._rr.toggleLock(this._selected);
      });
      this._saveBtn = make('rr-save', 'save', 'Save for everyone', 'Save this layout to the live site', () => void this._save());
      this._boxBtns = {
        mode: make('rr-boxes', 'edit', 'Fix boxes', 'Fix wrong furniture boxes (resize, add, remove)', () => this._toggleBoxMode()),
        remove: make('rr-box-remove', 'trash', 'Remove', 'This is not furniture (or delete a box you added)', () => this._boxRemove()),
        auto: make('rr-box-auto', 'reset', 'Auto size', 'Back to the box found in the scan', () => this._boxAuto()),
      };
      tools.insertBefore(this._lockBtn, this._btn.undo);
      tools.insertBefore(this._boxBtns.mode, this._btn.undo);
      tools.insertBefore(this._boxBtns.remove, this._btn.undo);
      tools.insertBefore(this._boxBtns.auto, this._btn.undo);
      tools.insertBefore(this._saveBtn, this._btn.done);
    }
    this._layer.appendChild(panel);
    document.body.appendChild(this._layer);

    this._canvas.addEventListener('pointerdown', e => this._onDown(e));
    this._canvas.addEventListener('pointermove', e => this._onMove(e));
    this._canvas.addEventListener('pointerup', e => this._onUp(e));
    this._canvas.addEventListener('pointercancel', () => { this._boxDrag = null; if (this._drag) { this._drag = null; this._rr.cancelDrag(); } });
    // Keys while open: the panel's own, and nothing reaches the walk controls
    window.addEventListener('keydown', e => this._onKey(e), true);
    window.addEventListener('keyup', e => { if (this._open) e.stopImmediatePropagation(); }, true);
    window.addEventListener('resize', () => this._draw());
    _rr.onChange(() => this._sync());
    this._sync();
  }

  get isOpen(): boolean {
    return this._open;
  }

  toggle(): void {
    if (this._open) this.close();
    else this.open();
  }

  open(): void {
    if (this._rr.paused) {
      this.toast('Rearrange is off while you are in a room with friends');
      return;
    }
    this._open = true;
    this._layer.classList.remove('hidden');
    document.documentElement.classList.add('ns-rr-open');
    if (document.pointerLockElement) document.exitPointerLock();
    this._opts.onOpenChange?.(true);
    this._sync();
    const tick = () => {
      if (!this._open) return;
      this._draw();
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  close(): void {
    if (!this._open) return;
    if (this._drag) { this._drag = null; this._rr.cancelDrag(); }
    this._open = false;
    this._layer.classList.add('hidden');
    document.documentElement.classList.remove('ns-rr-open');
    cancelAnimationFrame(this._raf);
    this._opts.onOpenChange?.(false);
  }

  toast(msg: string): void {
    const t = document.createElement('div');
    t.className = 'rr-toast';
    t.textContent = msg;
    this._toasts.appendChild(t);
    while (this._toasts.children.length > 3) this._toasts.firstElementChild?.remove();
    setTimeout(() => { t.classList.add('fade-out'); setTimeout(() => t.remove(), 300); }, 3200);
  }

  // --- State ------------------------------------------------------------------------------------

  private _sync(): void {
    if (this._boxMode) return this._syncBoxMode();
    if (this._boxBtns) {
      this._boxBtns.remove.style.display = 'none';
      this._boxBtns.auto.style.display = 'none';
      this._boxBtns.mode.querySelector('span')!.textContent = 'Fix boxes';
      for (const b of [this._btn.left, this._btn.right, this._btn.undo, this._btn.redo, this._btn.reset, this._lockBtn!]) b.style.display = '';
    }
    const sel = this._selected !== null;
    this._btn.left.disabled = !sel;
    this._btn.right.disabled = !sel;
    this._btn.undo.disabled = !this._rr.canUndo;
    this._btn.redo.disabled = !this._rr.canRedo;
    const admin = this._rr.mode === 'admin';
    const target = admin ? [] : this._rr.baseMoves;
    this._btn.reset.disabled = JSON.stringify(this._rr.moves) === JSON.stringify(target);
    if (this._lockBtn) {
      this._lockBtn.disabled = !sel;
      const locked = sel && this._rr.isLocked(this._selected!);
      this._lockBtn.querySelector('span')!.textContent = locked ? 'Unlock' : 'Lock';
    }
    if (this._saveBtn) {
      this._saveBtn.disabled = this._saving || !this._rr.dirty;
      this._saveBtn.querySelector('span')!.textContent = this._saving ? 'Saving…' : 'Save for everyone';
    }
    this._note.textContent = admin
      ? (this._rr.dirty ? 'Not saved yet' : 'Saved, everyone sees this')
      : 'Only you see these changes';
    const d = this._rr.dragging;
    this._hint.textContent = d
      ? (d.ok ? 'Fits here. Let go to place it.' : 'No room here. Let go and it moves back.')
      : sel && !admin && this._rr.isLocked(this._selected!)
        ? 'This piece stays where it is.'
        : sel
        ? (admin && this._rr.isLocked(this._selected!) ? 'Locked: visitors can\'t move it. You still can.' : 'Drag it to move, or turn it with the buttons.')
        : 'Tap or click a piece of furniture, then drag it.';
    if (this._open) this._draw();
  }

  // --- 3D drag (laptop) ------------------------------------------------------------------------

  /**
   * While the panel is open, a mouse press on a piece in the 3D view picks it up and slides it on
   * the floor (kept at the height you grabbed it, so it stays under the cursor). Touch screens use
   * the plan only, so the walk controls keep working.
   */
  attach3D(canvas: HTMLElement, ray: ViewRay): void {
    this._viewRay = ray;
    canvas.addEventListener('pointerdown', e => {
      if (!this._open || this._boxMode || e.pointerType === 'touch' || e.button !== 0 || this._rr.paused) return;
      const r = this._viewRay?.(e.clientX, e.clientY);
      const hit = r && this._pick3D(r.origin, r.dir);
      if (!hit) return;
      this._selected = hit.id;
      if (!this._rr.beginDrag(hit.id)) return this._sync();
      e.preventDefault();
      e.stopPropagation();
      canvas.setPointerCapture?.(e.pointerId);
      const base = this._rr.moves.find(m => m.id === hit.id) ?? { id: hit.id, dx: 0, dz: 0, turnDeg: 0 };
      this._drag3d = { id: hit.id, pointerId: e.pointerId, y: hit.y, grab: { x: hit.x, z: hit.z }, base, moved: false, sx: e.clientX, sy: e.clientY };
      document.body.style.cursor = 'grabbing';
    });
    canvas.addEventListener('pointermove', e => {
      const d = this._drag3d;
      if (!d || e.pointerId !== d.pointerId) return;
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return;
      d.moved = true;
      const r = ray(e.clientX, e.clientY);
      if (!r || Math.abs(r.dir.y) < 1e-4) return;
      const t = (d.y - r.origin.y) / r.dir.y;
      if (t <= 0 || t > 30) return; // pointing above the grab height: hold the last spot
      const x = r.origin.x + r.dir.x * t, z = r.origin.z + r.dir.z * t;
      this._rr.dragTo({ id: d.id, dx: d.base.dx + x - d.grab.x, dz: d.base.dz + z - d.grab.z, turnDeg: d.base.turnDeg });
    });
    const end = (e: PointerEvent) => {
      const d = this._drag3d;
      if (!d || e.pointerId !== d.pointerId) return;
      this._drag3d = null;
      document.body.style.cursor = '';
      if (d.moved && e.type === 'pointerup') this._rr.endDrag();
      else this._rr.cancelDrag();
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  /** True while a 3D press is on a piece (the view must not grab the mouse for looking) */
  get busy3D(): boolean {
    return this._drag3d !== null;
  }

  /** First piece the ray meets: marches along it (2 cm steps, 10 m) against each moved box */
  private _pick3D(o: V3, d: V3): { id: number; x: number; y: number; z: number } | null {
    const shapes = this._rr.objects.map(ob => ({ ob, poly: movedCorners(ob, this._moveOf(ob.id)) }));
    const len = Math.hypot(d.x, d.y, d.z) || 1;
    for (let t = 0.05; t < 10; t += 0.02) {
      const x = o.x + (d.x / len) * t, y = o.y + (d.y / len) * t, z = o.z + (d.z / len) * t;
      if (y < 0) break; // below the floor
      for (const { ob, poly } of shapes) {
        if (y <= ob.y1 && inside(poly, { x, z })) return { id: ob.id, x, y, z };
      }
    }
    return null;
  }

  // --- Box tool (admin) -------------------------------------------------------------------------

  private _toggleBoxMode(): void {
    if (this._drag) { this._drag = null; this._rr.cancelDrag(); }
    this._boxMode = !this._boxMode;
    this._boxSel = null;
    this._boxDrag = null;
    this._selected = null;
    this._sync();
  }

  private _syncBoxMode(): void {
    const b = this._boxBtns!;
    for (const x of [this._btn.left, this._btn.right, this._btn.undo, this._btn.redo, this._btn.reset, this._lockBtn!]) x.style.display = 'none';
    b.remove.style.display = '';
    b.auto.style.display = '';
    b.mode.querySelector('span')!.textContent = 'Boxes done';
    const sel = this._toolBoxes().find(t => t.id === this._boxSel) ?? null;
    b.remove.disabled = !sel;
    b.remove.querySelector('span')!.textContent = sel?.removed ? 'Restore' : 'Remove';
    b.auto.disabled = !sel || !sel.edited || sel.added;
    if (this._saveBtn) {
      this._saveBtn.disabled = this._saving || !this._rr.dirty;
      this._saveBtn.querySelector('span')!.textContent = this._saving ? 'Saving…' : 'Save for everyone';
    }
    this._note.textContent = this._rr.dirty ? 'Not saved yet' : 'Saved, everyone sees this';
    this._hint.textContent = this._boxDrag
      ? (this._boxDrag.kind === 'new' ? 'Let go to add this box.' : 'Let go to keep this size.')
      : sel
        ? (sel.removed ? 'Not furniture: it stays in the room as scanned.' : 'Drag a corner to resize, or drag inside to shift the box.')
        : 'Tap a box to fix it, or drag on empty floor to draw a missing one.';
    if (this._open) this._draw();
  }

  /** Every box as the tool shows it: detected (maybe fixed or removed) and added by the owner */
  private _toolBoxes(): ToolBox[] {
    const edits = new Map(this._rr.boxEdits.map(e => [e.id, e]));
    const movable = new Set(this._rr.objects.map(o => o.id));
    const fixedById = new Map(this._rr.plan.boxes.map(b => [b.id, b]));
    const out: ToolBox[] = [];
    for (const b of this._rr.detected.boxes) {
      const e = edits.get(b.id);
      const f = fixedById.get(b.id);
      out.push({ id: b.id, box: f ?? b, removed: !!e?.removed, edited: !!e, added: false, movable: movable.has(b.id) });
    }
    for (const e of edits.values()) {
      if (e.removed || out.some(t => t.id === e.id)) continue;
      const f = fixedById.get(e.id);
      if (f) out.push({ id: e.id, box: f, removed: false, edited: true, added: true, movable: movable.has(e.id) });
    }
    return out;
  }

  private _setEdit(id: number, edit: BoxEdit | null): void {
    const list = this._rr.boxEdits.filter(e => e.id !== id);
    if (edit) list.push(edit);
    this._rr.setBoxEdits(list);
  }

  private _boxRemove(): void {
    const t = this._toolBoxes().find(x => x.id === this._boxSel);
    if (!t) return;
    if (t.added) { this._setEdit(t.id, null); this._boxSel = null; }
    else this._setEdit(t.id, t.removed ? null : { id: t.id, removed: true });
  }

  private _boxAuto(): void {
    const t = this._toolBoxes().find(x => x.id === this._boxSel);
    if (t && !t.added) this._setEdit(t.id, null);
  }

  private _boxDown(p: Pt): void {
    const tools = this._toolBoxes();
    const sel = tools.find(t => t.id === this._boxSel);
    // A corner handle of the selected box first (10 px)
    if (sel && !sel.removed) {
      for (const cx of [0, 1] as const) for (const cz of [0, 1] as const) {
        const q = this._toPx({ x: cx ? sel.box.maxX : sel.box.minX, z: cz ? sel.box.maxZ : sel.box.minZ });
        const e = this._toPx(p);
        if (Math.hypot(q.px - e.px, q.py - e.py) <= 12) {
          this._boxDrag = { id: sel.id, kind: 'corner', corner: [cx, cz], start: p, orig: { ...sel.box }, cur: { ...sel.box } };
          return;
        }
      }
    }
    const under = tools.filter(t => p.x >= t.box.minX && p.x <= t.box.maxX && p.z >= t.box.minZ && p.z <= t.box.maxZ);
    under.sort((a, b) => (a.box.maxX - a.box.minX) * (a.box.maxZ - a.box.minZ) - (b.box.maxX - b.box.minX) * (b.box.maxZ - b.box.minZ));
    const hit = under[0];
    if (hit) {
      this._boxSel = hit.id;
      if (!hit.removed) this._boxDrag = { id: hit.id, kind: 'move', corner: [0, 0], start: p, orig: { ...hit.box }, cur: { ...hit.box } };
      return;
    }
    this._boxSel = null;
    const b = { minX: p.x, minZ: p.z, maxX: p.x, maxZ: p.z };
    this._boxDrag = { id: null, kind: 'new', corner: [1, 1], start: p, orig: b, cur: { ...b } };
  }

  private _boxMove(p: Pt): void {
    const d = this._boxDrag;
    if (!d) return;
    const dx = p.x - d.start.x, dz = p.z - d.start.z;
    const o = d.orig;
    if (d.kind === 'move') d.cur = { minX: o.minX + dx, maxX: o.maxX + dx, minZ: o.minZ + dz, maxZ: o.maxZ + dz };
    else {
      const x = d.corner[0] ? o.maxX + dx : o.minX + dx;
      const z = d.corner[1] ? o.maxZ + dz : o.minZ + dz;
      const ax = d.corner[0] ? o.minX : o.maxX, az = d.corner[1] ? o.minZ : o.maxZ;
      d.cur = { minX: Math.min(x, ax), maxX: Math.max(x, ax), minZ: Math.min(z, az), maxZ: Math.max(z, az) };
    }
    this._sync();
  }

  private _boxUp(): void {
    const d = this._boxDrag;
    this._boxDrag = null;
    if (!d) return this._sync();
    const c = d.cur;
    const big = c.maxX - c.minX >= 0.15 && c.maxZ - c.minZ >= 0.15;
    const changed = JSON.stringify(c) !== JSON.stringify(d.orig);
    if (d.kind === 'new') {
      if (!big) return this._sync();
      const ids = this._toolBoxes().map(t => t.id).concat(this._rr.boxEdits.map(e => e.id));
      const id = Math.max(ADDED_BOX_ID - 1, ...ids) + 1;
      this._boxSel = id;
      this._setEdit(id, { id, ...c });
    } else if (changed && d.id !== null) {
      if (!big) { this.toast('That box is too small'); return this._sync(); }
      this._setEdit(d.id, { id: d.id, ...c });
    } else this._sync();
  }

  private _drawBoxTool(ctx: CanvasRenderingContext2D, poly: (pts: Pt[]) => void): void {
    const corners = (b: Box): Pt[] => [{ x: b.minX, z: b.minZ }, { x: b.maxX, z: b.minZ }, { x: b.maxX, z: b.maxZ }, { x: b.minX, z: b.maxZ }];
    const d = this._boxDrag;
    for (const t of this._toolBoxes()) {
      const b = d && d.id === t.id ? d.cur : t.box;
      poly(corners(b));
      if (t.removed) {
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = 'rgba(231, 76, 60, 0.8)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = t.movable ? THEME.planBox : '#232a3d';
        ctx.fill();
        ctx.strokeStyle = t.edited ? THEME.sky : THEME.planBoxLine;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      if (t.id === this._boxSel) {
        poly(corners(b));
        ctx.strokeStyle = THEME.gold;
        ctx.lineWidth = 2.5;
        ctx.stroke();
        if (!t.removed) {
          ctx.fillStyle = THEME.gold;
          for (const p of corners(b)) { const q = this._toPx(p); ctx.fillRect(q.px - 5, q.py - 5, 10, 10); }
        }
      }
    }
    if (d && d.kind === 'new') {
      poly(corners(d.cur));
      ctx.fillStyle = 'rgba(111, 196, 242, 0.35)';
      ctx.fill();
      ctx.strokeStyle = THEME.sky;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  private async _save(): Promise<void> {
    if (!this._opts.save || this._saving) return;
    this._saving = true;
    this._sync();
    try {
      await this._opts.save();
    } finally {
      this._saving = false;
      this._sync();
    }
  }

  private _turn(stepDeg: number): void {
    if (this._selected === null) return;
    this._rr.turn(this._selected, stepDeg);
  }

  // --- Plan view --------------------------------------------------------------------------------

  private _fit(): void {
    const ring = this._rr.plan.outline[0] ?? [];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of ring) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    if (!Number.isFinite(minX)) return;
    const w = this._canvas.clientWidth, h = this._canvas.clientHeight, pad = 12;
    const scale = Math.min((w - 2 * pad) / (maxX - minX), (h - 2 * pad) / (maxZ - minZ));
    this._view = {
      scale,
      ox: (w - (maxX - minX) * scale) / 2,
      oz: (h - (maxZ - minZ) * scale) / 2,
      minX,
      minZ,
    };
  }

  private _toPx(p: Pt): { px: number; py: number } {
    const v = this._view;
    return { px: v.ox + (p.x - v.minX) * v.scale, py: v.oz + (p.z - v.minZ) * v.scale };
  }

  private _toWorld(px: number, py: number): Pt {
    const v = this._view;
    return { x: v.minX + (px - v.ox) / v.scale, z: v.minZ + (py - v.oz) / v.scale };
  }

  private _moveOf(id: number): Move | undefined {
    const d = this._rr.dragging;
    if (d && d.id === id) return d.move;
    return this._rr.moves.find(m => m.id === id);
  }

  private _hit(p: Pt): MovableObject | null {
    // Smallest piece under the point first (a table next to a bunk)
    const under = this._rr.objects.filter(o => inside(movedCorners(o, this._moveOf(o.id)), p));
    under.sort((a, b) => area(a) - area(b));
    return under[0] ?? null;
  }

  private _draw(): void {
    const c = this._canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    this._fit();
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const poly = (pts: Pt[]) => {
      ctx.beginPath();
      pts.forEach((p, i) => { const q = this._toPx(p); if (i) ctx.lineTo(q.px, q.py); else ctx.moveTo(q.px, q.py); });
      ctx.closePath();
    };
    // Floor
    ctx.beginPath();
    for (const ring of this._rr.plan.outline) {
      ring.forEach((p, i) => { const q = this._toPx(p); if (i) ctx.lineTo(q.px, q.py); else ctx.moveTo(q.px, q.py); });
      ctx.closePath();
    }
    ctx.fillStyle = THEME.planFloor;
    ctx.fill('evenodd');
    ctx.strokeStyle = THEME.gold;
    ctx.lineWidth = 2;
    ctx.stroke();
    if (this._boxMode) {
      this._drawBoxTool(ctx, poly);
      return;
    }
    // Fixed pieces (tall or large): muted
    const movable = new Set(this._rr.objects.map(o => o.id));
    for (const b of this._rr.plan.boxes) {
      if (movable.has(b.id)) continue;
      poly([{ x: b.minX, z: b.minZ }, { x: b.maxX, z: b.minZ }, { x: b.maxX, z: b.maxZ }, { x: b.minX, z: b.maxZ }]);
      ctx.fillStyle = '#232a3d';
      ctx.fill();
    }
    // Movable pieces where they stand now; a moved piece keeps a faint outline of its old spot
    const drag = this._rr.dragging;
    for (const o of this._rr.objects) {
      const m = this._moveOf(o.id);
      if (m) {
        poly(movedCorners(o, undefined));
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
      }
      const corners = movedCorners(o, m);
      poly(corners);
      const isDrag = drag?.id === o.id;
      const locked = this._rr.isLocked(o.id);
      ctx.fillStyle = isDrag ? (drag!.ok ? 'rgba(46, 204, 113, 0.55)' : 'rgba(231, 76, 60, 0.6)') : locked ? '#232a3d' : THEME.planBox;
      ctx.fill();
      if (locked && !isDrag) {
        // Small padlock in the middle of a locked piece
        const c = this._toPx({ x: corners.reduce((s, p) => s + p.x, 0) / corners.length, z: corners.reduce((s, p) => s + p.z, 0) / corners.length });
        ctx.strokeStyle = THEME.planBoxLine;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(c.px - 4, c.py - 1, 8, 6);
        ctx.beginPath();
        ctx.arc(c.px, c.py - 1, 3, Math.PI, 0);
        ctx.stroke();
        poly(corners);
      }
      ctx.lineWidth = this._selected === o.id ? 2.5 : 1;
      ctx.strokeStyle = this._selected === o.id ? THEME.gold : THEME.planBoxLine;
      ctx.stroke();
    }
    // You
    const pose = this._opts.getPose();
    const q = this._toPx(pose);
    ctx.fillStyle = THEME.sky;
    ctx.beginPath();
    ctx.arc(q.px, q.py, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = THEME.sky;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(q.px, q.py);
    ctx.lineTo(q.px - Math.sin(pose.yaw) * 12, q.py - Math.cos(pose.yaw) * 12);
    ctx.stroke();
  }

  // --- Input ------------------------------------------------------------------------------------

  private _eventWorld(e: PointerEvent): Pt {
    const r = this._canvas.getBoundingClientRect();
    return this._toWorld(e.clientX - r.left, e.clientY - r.top);
  }

  private _onDown(e: PointerEvent): void {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    this._fit();
    const p = this._eventWorld(e);
    if (this._boxMode) {
      this._boxDown(p);
      if (this._boxDrag) this._canvas.setPointerCapture(e.pointerId);
      this._sync();
      return;
    }
    const o = this._hit(p);
    this._selected = o?.id ?? null;
    if (o && this._rr.beginDrag(o.id)) {
      const base = this._rr.moves.find(m => m.id === o.id) ?? { id: o.id, dx: 0, dz: 0, turnDeg: 0 };
      this._drag = { id: o.id, start: p, base, moved: false };
      this._canvas.setPointerCapture(e.pointerId);
      this._canvas.classList.add('dragging');
    }
    this._sync();
  }

  private _onMove(e: PointerEvent): void {
    if (this._boxMode) return this._boxMove(this._eventWorld(e));
    if (!this._drag) return;
    const p = this._eventWorld(e);
    const dx = p.x - this._drag.start.x, dz = p.z - this._drag.start.z;
    if (!this._drag.moved && Math.hypot(dx, dz) < 0.03) return;
    this._drag.moved = true;
    const b = this._drag.base;
    this._rr.dragTo({ id: b.id, dx: b.dx + dx, dz: b.dz + dz, turnDeg: b.turnDeg });
  }

  private _onUp(e: PointerEvent): void {
    if (this._boxMode) {
      this._canvas.releasePointerCapture?.(e.pointerId);
      return this._boxUp();
    }
    if (!this._drag) return;
    this._canvas.releasePointerCapture?.(e.pointerId);
    this._canvas.classList.remove('dragging');
    const moved = this._drag.moved;
    this._drag = null;
    if (moved) this._rr.endDrag();
    else this._rr.cancelDrag();
  }

  private _onKey(e: KeyboardEvent): void {
    if (!this._open) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    let handled = true;
    if (k === 'escape') this.close();
    else if (this._boxMode && (k === 'delete' || k === 'backspace')) this._boxRemove();
    else if (this._boxMode && mod) handled = false;
    else if (mod && k === 'z' && !e.shiftKey) this._rr.undo();
    else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) this._rr.redo();
    else if (!mod && k === 'q') this._turn(LAYOUT_LIMITS.turnStepDeg);
    else if (!mod && k === 'e') this._turn(-LAYOUT_LIMITS.turnStepDeg);
    else handled = !mod; // other plain keys are swallowed so you don't walk while arranging
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }
}

function inside(poly: Pt[], p: Pt): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > p.z) !== (b.z > p.z) && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) hit = !hit;
  }
  return hit;
}

const area = (o: MovableObject): number => (o.lift.maxX - o.lift.minX) * (o.lift.maxZ - o.lift.minZ);
