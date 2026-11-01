/**
 * Namma Space: Tag Mode UI (Round 2)
 *
 * Activated only when ?tag=1 is in the query params.
 * Allows walking/flying around the scene and dropping POI tags (P key),
 * editing them, moving them to current position, deleting, exporting as pois.json,
 * and persisting a local draft in localStorage via PoiDraftStore.
 *
 * Styling comes only from tokens.ts (shared buttons, inputs, dialogs). On phones the Places panel
 * is a bottom sheet: it drops to its header while a POI or route card is open, and publishes its
 * height as --ns-sheet-h so those cards sit above it instead of underneath.
 */

import type { Id, POI } from '../contracts/types.js';
import type { Pose3D } from '../types.js';
import {
  POI_CATEGORIES,
  makePoi,
  PoiDraftStore,
  downloadPoiSet,
} from '../nav/pois.js';
import { ensureTokens, icon, trapTab } from './tokens.js';

export interface TagUIOptions {
  sceneId: Id;
  container?: HTMLElement;
  getPose: () => Pose3D;
  isWalkable?: (x: number, z: number) => boolean;
  onPoisChange: (pois: POI[]) => void;
  manifestPois?: POI[];
  /** Called when the Adjust switch flips (main.ts stops pointer lock while it is on) */
  onAdjustChange?: (on: boolean) => void;
}

interface ConfirmOptions {
  title: string;
  confirmLabel: string;
}

const PHONE_QUERY = '(max-width: 760px)';
const NAV_CARD_OPEN = '.nav-poi-card:not(.hidden), .nav-route-card:not(.hidden)';

export class TagUI {
  private readonly _sceneId: Id;
  private readonly _root: HTMLElement;
  private readonly _getPose: () => Pose3D;
  private readonly _isWalkable?: (x: number, z: number) => boolean;
  private readonly _onPoisChange: (pois: POI[]) => void;
  private readonly _draftStore: PoiDraftStore;

  private _pois: POI[] = [];
  private _manifestPois: POI[] = [];
  private _lastCategory: string = 'furniture';
  private _editingPoi: POI | null = null;
  private _isPanelCollapsed = false;
  private _formReturnFocus: HTMLElement | null = null;
  private _adjust = false;
  private _selectedId: Id | null = null;
  private readonly _onAdjustChange?: (on: boolean) => void;
  private readonly _adjustSwitch: HTMLButtonElement;
  private readonly _adjustHint: HTMLElement;

  // DOM Elements
  private readonly _toastContainer: HTMLElement;
  private readonly _panel: HTMLElement;
  private readonly _panelBody: HTMLElement;
  private readonly _countBadge: HTMLElement;
  private readonly _poiListContainer: HTMLElement;
  private readonly _collapseBtn: HTMLButtonElement;
  private readonly _formOverlay: HTMLElement;
  private readonly _formTitle: HTMLElement;
  private readonly _nameInput: HTMLInputElement;
  private readonly _categorySelect: HTMLSelectElement;
  private readonly _aliasesInput: HTMLInputElement;
  private readonly _warningBox: HTMLElement;
  private readonly _saveBtn: HTMLButtonElement;
  private readonly _cancelBtn: HTMLButtonElement;

  // In-page confirm dialog (replaces window.confirm)
  private readonly _confirmOverlay: HTMLElement;
  private readonly _confirmTitle: HTMLElement;
  private readonly _confirmOkBtn: HTMLButtonElement;
  private readonly _confirmCancelBtn: HTMLButtonElement;
  private _confirmResolve: ((ok: boolean) => void) | null = null;
  private _confirmReturnFocus: HTMLElement | null = null;

  private readonly _phoneQuery: MediaQueryList | null;

  constructor(options: TagUIOptions) {
    this._sceneId = options.sceneId;
    this._getPose = options.getPose;
    this._isWalkable = options.isWalkable;
    this._onPoisChange = options.onPoisChange;
    this._onAdjustChange = options.onAdjustChange;
    this._draftStore = new PoiDraftStore(this._sceneId);
    this._manifestPois = options.manifestPois ? [...options.manifestPois] : [];
    this._phoneQuery = window.matchMedia ? window.matchMedia(PHONE_QUERY) : null;

    const parent = options.container ?? document.body;

    this._root = document.createElement('div');
    this._root.id = 'namma-tag-ui-root';
    this._root.className = 'namma-tag-ui-layer ns-ui';

    ensureTokens();
    this._injectStyles();

    // 1. Toast Container
    this._toastContainer = document.createElement('div');
    this._toastContainer.id = 'tag-toast-container';
    this._toastContainer.className = 'tag-toast-container';
    this._toastContainer.setAttribute('role', 'status');
    this._toastContainer.setAttribute('aria-live', 'polite');
    this._root.appendChild(this._toastContainer);

    // 2. Tag Panel (right side; bottom sheet on phones)
    this._panel = document.createElement('section');
    this._panel.id = 'tag-panel';
    this._panel.className = 'tag-panel';
    this._panel.setAttribute('aria-label', 'Tagged places');

    const header = document.createElement('div');
    header.className = 'tag-panel-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'tag-panel-title-wrap';

    const title = document.createElement('h2');
    title.className = 'tag-panel-title';
    title.textContent = 'Places';

    this._countBadge = document.createElement('span');
    this._countBadge.className = 'tag-count-badge';
    this._countBadge.textContent = '(0)';

    const modeChip = document.createElement('span');
    modeChip.className = 'tag-mode-chip';
    modeChip.textContent = 'Tag mode';

    titleWrap.append(title, this._countBadge, modeChip);

    this._collapseBtn = document.createElement('button');
    this._collapseBtn.className = 'tag-icon-btn tag-collapse-btn ns-press';
    this._collapseBtn.setAttribute('aria-label', 'Toggle tag panel');
    this._collapseBtn.setAttribute('aria-controls', 'tag-panel-body');
    this._collapseBtn.setAttribute('aria-expanded', 'true');
    this._collapseBtn.title = 'Collapse/Expand panel';
    this._collapseBtn.innerHTML =
      '<svg class="ns-icon tag-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
    this._collapseBtn.addEventListener('click', () => this._onCollapseClick());

    header.append(titleWrap, this._collapseBtn);
    this._panel.appendChild(header);

    this._panelBody = document.createElement('div');
    this._panelBody.id = 'tag-panel-body';
    this._panelBody.className = 'tag-panel-body';

    // Adjust switch: pick a place in the list, then click the floor (or the map) to put it there
    const adjustRow = document.createElement('div');
    adjustRow.className = 'tag-adjust-row';
    const adjustLabel = document.createElement('span');
    adjustLabel.className = 'tag-adjust-label';
    adjustLabel.id = 'tag-adjust-label';
    adjustLabel.textContent = 'Adjust mode';
    const adjustKey = document.createElement('kbd');
    adjustKey.className = 'tag-adjust-kbd';
    adjustKey.textContent = 'T';
    adjustLabel.appendChild(adjustKey);
    this._adjustSwitch = document.createElement('button');
    this._adjustSwitch.type = 'button';
    this._adjustSwitch.className = 'tag-switch ns-press';
    this._adjustSwitch.setAttribute('role', 'switch');
    this._adjustSwitch.setAttribute('aria-checked', 'false');
    this._adjustSwitch.setAttribute('aria-labelledby', 'tag-adjust-label');
    this._adjustSwitch.innerHTML = '<span class="tag-switch-knob" aria-hidden="true"></span>';
    this._adjustSwitch.addEventListener('click', () => this.toggleAdjust());
    adjustRow.append(adjustLabel, this._adjustSwitch);
    this._adjustHint = document.createElement('div');
    this._adjustHint.className = 'tag-adjust-hint hidden';
    this._panelBody.append(adjustRow, this._adjustHint);

    this._poiListContainer = document.createElement('div');
    this._poiListContainer.className = 'tag-poi-list';
    this._panelBody.appendChild(this._poiListContainer);

    const footer = document.createElement('div');
    footer.className = 'tag-panel-footer';

    const exportBtn = document.createElement('button');
    exportBtn.className = 'ns-btn ns-btn-primary ns-slant-r ns-press';
    exportBtn.textContent = 'Export pois.json';
    exportBtn.title = 'Download pois.json file';
    exportBtn.addEventListener('click', () => {
      downloadPoiSet(this._sceneId, this._pois);
      this.showToast('Exported pois.json');
    });

    const clearBtn = document.createElement('button');
    clearBtn.className = 'ns-btn ns-btn-danger-soft ns-slant-l ns-press';
    clearBtn.textContent = 'Clear draft';
    clearBtn.title = 'Clear browser draft and revert to original places';
    clearBtn.addEventListener('click', () => {
      void this._confirm({
        title: 'Clear local draft and revert to original places?',
        confirmLabel: 'Clear draft',
      }).then(ok => {
        if (!ok) return;
        this._draftStore.clear();
        this._pois = this._manifestPois.map(p => ({ ...p }));
        this._draftStore.save(this._pois);
        this._onPoisChange(this._pois);
        this._renderList();
        this.showToast('Draft cleared');
      });
    });

    footer.append(exportBtn, clearBtn);
    this._panelBody.appendChild(footer);
    this._panel.appendChild(this._panelBody);
    this._root.appendChild(this._panel);

    // 3. Inline Form Modal (for Add & Edit)
    this._formOverlay = document.createElement('div');
    this._formOverlay.id = 'tag-form-modal';
    this._formOverlay.className = 'ns-scrim tag-form-overlay hidden';

    const card = document.createElement('div');
    card.className = 'ns-dialog tag-form-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'tag-form-title');

    this._formTitle = document.createElement('h2');
    this._formTitle.className = 'ns-dialog-title';
    this._formTitle.id = 'tag-form-title';
    this._formTitle.textContent = 'Add Place';
    card.appendChild(this._formTitle);

    const form = document.createElement('form');
    form.className = 'tag-form';
    form.addEventListener('submit', e => {
      e.preventDefault();
      this._submitForm();
    });

    // Name field
    const nameGroup = document.createElement('div');
    nameGroup.className = 'tag-field-group';
    const nameLabel = document.createElement('label');
    nameLabel.textContent = 'Name *';
    nameLabel.htmlFor = 'tag-name-input';
    this._nameInput = document.createElement('input');
    this._nameInput.type = 'text';
    this._nameInput.id = 'tag-name-input';
    this._nameInput.className = 'ns-input';
    this._nameInput.placeholder = 'e.g. Desk…';
    this._nameInput.name = 'poi-name';
    this._nameInput.required = true;
    this._nameInput.autocomplete = 'off';
    this._nameInput.enterKeyHint = 'done';
    nameGroup.append(nameLabel, this._nameInput);
    form.appendChild(nameGroup);

    // Category field
    const catGroup = document.createElement('div');
    catGroup.className = 'tag-field-group';
    const catLabel = document.createElement('label');
    catLabel.textContent = 'Category';
    catLabel.htmlFor = 'tag-cat-select';
    this._categorySelect = document.createElement('select');
    this._categorySelect.id = 'tag-cat-select';
    this._categorySelect.className = 'ns-input tag-select';
    for (const cat of POI_CATEGORIES) {
      const opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = cat;
      this._categorySelect.appendChild(opt);
    }
    catGroup.append(catLabel, this._categorySelect);
    form.appendChild(catGroup);

    // Aliases field
    const aliasGroup = document.createElement('div');
    aliasGroup.className = 'tag-field-group';
    const aliasLabel = document.createElement('label');
    aliasLabel.textContent = 'Aliases (comma-separated)';
    aliasLabel.htmlFor = 'tag-aliases-input';
    this._aliasesInput = document.createElement('input');
    this._aliasesInput.type = 'text';
    this._aliasesInput.id = 'tag-aliases-input';
    this._aliasesInput.className = 'ns-input';
    this._aliasesInput.placeholder = 'e.g. table, study…';
    this._aliasesInput.name = 'poi-aliases';
    this._aliasesInput.autocomplete = 'off';
    this._aliasesInput.enterKeyHint = 'done';
    aliasGroup.append(aliasLabel, this._aliasesInput);
    form.appendChild(aliasGroup);

    // Walkability warning
    this._warningBox = document.createElement('div');
    this._warningBox.id = 'tag-walk-warning';
    this._warningBox.className = 'tag-warning-box hidden';
    this._warningBox.setAttribute('role', 'status');
    this._warningBox.textContent = 'Not on the floor map, a route will end at the nearest floor spot.';
    form.appendChild(this._warningBox);

    // Buttons
    const btnRow = document.createElement('div');
    btnRow.className = 'ns-dialog-actions';

    this._cancelBtn = document.createElement('button');
    this._cancelBtn.type = 'button';
    this._cancelBtn.className = 'ns-btn ns-press';
    this._cancelBtn.textContent = 'Cancel';
    this._cancelBtn.addEventListener('click', () => this.closeForm());

    this._saveBtn = document.createElement('button');
    this._saveBtn.type = 'submit';
    this._saveBtn.className = 'ns-btn ns-btn-primary ns-press';
    this._saveBtn.textContent = 'Save';

    btnRow.append(this._cancelBtn, this._saveBtn);
    form.appendChild(btnRow);

    card.appendChild(form);
    this._formOverlay.appendChild(card);
    this._root.appendChild(this._formOverlay);

    // 4. Confirm dialog (delete, clear draft)
    this._confirmOverlay = document.createElement('div');
    this._confirmOverlay.id = 'tag-confirm-modal';
    this._confirmOverlay.className = 'ns-scrim tag-confirm-overlay hidden';
    const confirmCard = document.createElement('div');
    confirmCard.className = 'ns-dialog tag-confirm-card';
    confirmCard.setAttribute('role', 'alertdialog');
    confirmCard.setAttribute('aria-modal', 'true');
    confirmCard.setAttribute('aria-labelledby', 'tag-confirm-title');
    this._confirmTitle = document.createElement('h2');
    this._confirmTitle.id = 'tag-confirm-title';
    this._confirmTitle.className = 'ns-dialog-title';
    const confirmActions = document.createElement('div');
    confirmActions.className = 'ns-dialog-actions';
    this._confirmCancelBtn = document.createElement('button');
    this._confirmCancelBtn.type = 'button';
    this._confirmCancelBtn.className = 'ns-btn ns-press';
    this._confirmCancelBtn.textContent = 'Cancel';
    this._confirmCancelBtn.addEventListener('click', () => this._closeConfirm(false));
    this._confirmOkBtn = document.createElement('button');
    this._confirmOkBtn.type = 'button';
    this._confirmOkBtn.className = 'ns-btn ns-btn-danger ns-press';
    this._confirmOkBtn.addEventListener('click', () => this._closeConfirm(true));
    confirmActions.append(this._confirmCancelBtn, this._confirmOkBtn);
    confirmCard.append(this._confirmTitle, confirmActions);
    this._confirmOverlay.appendChild(confirmCard);
    this._root.appendChild(this._confirmOverlay);

    parent.appendChild(this._root);

    // Global keyboard listener for Esc on modal
    window.addEventListener('keydown', (e: KeyboardEvent) => {
      if (!this._formOverlay.classList.contains('hidden')) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          this.closeForm();
        }
      }
    });

    // Keys inside an open dialog stay in it: Esc closes, Tab cycles, and game shortcuts
    // (P, N, H, /, WASD) don't fire from its buttons. keyup is left alone so held keys release.
    this._formOverlay.addEventListener('keydown', e => {
      trapTab(card, e);
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeForm();
      }
      e.stopPropagation();
    });
    this._confirmOverlay.addEventListener('keydown', e => {
      trapTab(confirmCard, e);
      if (e.key === 'Escape') {
        e.preventDefault();
        this._closeConfirm(false);
      }
      e.stopPropagation();
    });

    // Close on overlay click outside card
    this._formOverlay.addEventListener('click', e => {
      if (e.target === this._formOverlay) {
        this.closeForm();
      }
    });
    this._confirmOverlay.addEventListener('click', e => {
      if (e.target === this._confirmOverlay) this._closeConfirm(false);
    });

    // Phone bottom sheet: publish its height so the POI and route cards stack above it
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => this._syncSheet()).observe(this._panel);
    }
    this._phoneQuery?.addEventListener?.('change', () => this._syncSheet());
    this._syncSheet();
  }

  /** True while the add/edit form or the confirm dialog is open (main.ts skips pointer lock then) */
  get isFormOpen(): boolean {
    return !this._formOverlay.classList.contains('hidden') || !this._confirmOverlay.classList.contains('hidden');
  }

  /** True while the Adjust switch is on: clicks on the floor or map place the selected tag */
  get adjustMode(): boolean {
    return this._adjust;
  }

  get selectedPoi(): POI | null {
    return this._pois.find(p => p.poi_id === this._selectedId) ?? null;
  }

  setAdjust(on: boolean): void {
    if (this._adjust === on) return;
    this._adjust = on;
    if (on) {
      document.exitPointerLock?.();
      if (this._isPanelCollapsed) this.toggleCollapse();
      if (!this.selectedPoi && this._pois.length > 0) this._selectedId = this._pois[0].poi_id;
    }
    this._adjustSwitch.setAttribute('aria-checked', String(on));
    this._panel.classList.toggle('adjusting', on);
    this._renderList();
    this._onAdjustChange?.(on);
    this.showToast(on ? 'Adjust mode on: drag any tag to move it' : 'Adjust mode off');
  }

  toggleAdjust(): void {
    this.setAdjust(!this._adjust);
  }

  /** Marks a place as the one the next floor or map click moves */
  selectPoi(id: Id | null): void {
    this._selectedId = id;
    this._renderList();
  }

  /** Moves the selected tag to (x, z). Returns the moved POI, or null if nothing is selected. */
  moveSelected(x: number, z: number): POI | null {
    const poi = this.selectedPoi;
    if (!poi) {
      this.showToast('Pick a place in the list first');
      return null;
    }
    return this.movePoi(poi, x, z);
  }

  /** Puts a tag at (x, z), saves the draft and selects it (end of a drag) */
  movePoi(poi: POI, x: number, z: number): POI {
    this._selectedId = poi.poi_id;
    poi.position.x = Math.round(x * 1000) / 1000;
    poi.position.z = Math.round(z * 1000) / 1000;
    const walkable = this._isWalkable ? this._isWalkable(x, z) : true;
    this._draftStore.save(this._pois);
    this._onPoisChange(this._pois);
    this._renderList();
    this.showToast(`Placed ${poi.name}${walkable ? '' : ' (off the floor map, routes end at the nearest floor spot)'}`);
    return poi;
  }

  setManifestPois(pois: POI[]): void {
    this._manifestPois = pois.map(p => ({ ...p }));
  }

  setPois(pois: POI[]): void {
    this._pois = pois;
    if (this._selectedId && !pois.some(p => p.poi_id === this._selectedId)) this._selectedId = null;
    this._renderList();
  }

  toggleCollapse(): void {
    this._isPanelCollapsed = !this._isPanelCollapsed;
    this._panel.classList.toggle('collapsed', this._isPanelCollapsed);
    this._syncSheet();
  }

  showToast(msg: string, durationMs = 3000): void {
    const toast = document.createElement('div');
    toast.className = 'tag-toast';
    toast.textContent = msg;
    this._toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('fade-out');
      setTimeout(() => toast.remove(), 300);
    }, durationMs);
  }

  openAdd(): void {
    if (!this._confirmOverlay.classList.contains('hidden')) return;
    document.exitPointerLock?.();
    this._editingPoi = null;
    this._formTitle.textContent = 'Add Place';
    this._nameInput.value = '';
    this._categorySelect.value = this._lastCategory;
    this._aliasesInput.value = '';

    const pose = this._getPose();
    const walkable = this._isWalkable ? this._isWalkable(pose.x, pose.z) : true;
    this._warningBox.classList.toggle('hidden', walkable);

    this._showForm();
    // P is a game shortcut: after Save or Cancel focus goes back to the scene, as before
    this._formReturnFocus = null;
    setTimeout(() => this._nameInput.focus(), 60);
  }

  openEdit(poi: POI): void {
    document.exitPointerLock?.();
    this._editingPoi = poi;
    this._formTitle.textContent = 'Edit Place';
    this._nameInput.value = poi.name;
    this._categorySelect.value = poi.category || 'other';
    this._aliasesInput.value = poi.aliases ? poi.aliases.join(', ') : '';

    const walkable = this._isWalkable ? this._isWalkable(poi.position.x, poi.position.z) : true;
    this._warningBox.classList.toggle('hidden', walkable);

    this._showForm();
    setTimeout(() => {
      this._nameInput.focus();
      this._nameInput.select();
    }, 60);
  }

  closeForm(): void {
    this._formOverlay.classList.add('hidden');
    this._editingPoi = null;
    this._nameInput.blur();
    this._aliasesInput.blur();
    this._categorySelect.blur();
    this._restoreFocus(this._formReturnFocus);
    this._formReturnFocus = null;
  }

  private _showForm(): void {
    if (this._formOverlay.classList.contains('hidden')) {
      this._formReturnFocus = document.activeElement as HTMLElement | null;
    }
    this._formOverlay.classList.remove('hidden');
  }

  /** In-page replacement for window.confirm: resolves true on confirm, false on Cancel, Esc or backdrop */
  private _confirm(opts: ConfirmOptions): Promise<boolean> {
    if (this._confirmResolve) this._closeConfirm(false);
    document.exitPointerLock?.();
    this._confirmTitle.textContent = opts.title;
    this._confirmOkBtn.textContent = opts.confirmLabel;
    this._confirmReturnFocus = document.activeElement as HTMLElement | null;
    this._confirmOverlay.classList.remove('hidden');
    // The safe choice has focus, so Enter right after the click doesn't delete anything
    this._confirmCancelBtn.focus();
    return new Promise(resolve => {
      this._confirmResolve = resolve;
    });
  }

  private _closeConfirm(ok: boolean): void {
    if (this._confirmOverlay.classList.contains('hidden')) return;
    this._confirmOverlay.classList.add('hidden');
    const resolve = this._confirmResolve;
    this._confirmResolve = null;
    this._restoreFocus(this._confirmReturnFocus);
    this._confirmReturnFocus = null;
    resolve?.(ok);
  }

  /** Returns focus to the control that opened a dialog, unless it was removed or is the canvas */
  private _restoreFocus(el: HTMLElement | null): void {
    if (el && el.isConnected && el !== document.body && el.tagName !== 'CANVAS') {
      el.focus();
    }
  }

  private _isPhone(): boolean {
    return Boolean(this._phoneQuery?.matches);
  }

  /** Chevron: on a phone with a POI or route card open, it opens or closes the sheet over the peek state */
  private _onCollapseClick(): void {
    const cardOpen = this._isPhone() && Boolean(document.querySelector(NAV_CARD_OPEN));
    if (cardOpen && !this._panel.classList.contains('peek-open')) {
      this._panel.classList.add('peek-open');
      if (this._isPanelCollapsed) this.toggleCollapse();
    } else if (cardOpen) {
      this._panel.classList.remove('peek-open');
    } else {
      this._panel.classList.remove('peek-open');
      this.toggleCollapse();
    }
    this._syncSheet();
  }

  /** Keeps aria-expanded and --ns-sheet-h in step with what the sheet actually shows */
  private _syncSheet(): void {
    if (!document.querySelector(NAV_CARD_OPEN)) this._panel.classList.remove('peek-open');
    const bodyShown = getComputedStyle(this._panelBody).display !== 'none';
    this._collapseBtn.setAttribute('aria-expanded', String(bodyShown));
    this._panel.classList.toggle('body-hidden', !bodyShown);
    const sheetH = this._isPhone() ? `${Math.ceil(this._panel.getBoundingClientRect().height) + 8}px` : '0px';
    document.documentElement.style.setProperty('--ns-sheet-h', sheetH);
  }

  private _submitForm(): void {
    const name = this._nameInput.value.trim();
    if (!name) {
      this._nameInput.focus();
      return;
    }

    const category = (this._categorySelect.value as POI['category']) || 'other';
    this._lastCategory = category;

    const aliasesRaw = this._aliasesInput.value;
    const aliases = aliasesRaw
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    if (this._editingPoi) {
      // Editing existing POI
      const poi = this._editingPoi;
      poi.name = name;
      poi.category = category;
      poi.aliases = aliases.length ? aliases : undefined;

      this._draftStore.save(this._pois);
      this._onPoisChange(this._pois);
      this._renderList();
      this.closeForm();
      this.showToast(`Updated ${name}`);
    } else {
      // Adding new POI at current pose
      const pose = this._getPose();
      const yawDeg = Math.round((pose.yaw * 180) / Math.PI);
      const newPoi = makePoi(this._sceneId, name, pose.x, pose.z, {
        category,
        aliases: aliases.length ? aliases : undefined,
        yaw_deg: yawDeg,
      });

      this._pois.push(newPoi);
      this._draftStore.save(this._pois);
      this._onPoisChange(this._pois);
      this._renderList();
      this.closeForm();
      this.showToast(`Added ${name}`);
    }
  }

  private _renderList(): void {
    this._countBadge.textContent = `(${this._pois.length})`;
    this._adjustHint.classList.toggle('hidden', !this._adjust);
    this._adjustHint.textContent = 'Drag a tag label in the view, or its dot on the map, to move it.';
    this._poiListContainer.innerHTML = '';

    if (this._pois.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'tag-empty-notice';
      empty.textContent = 'No places tagged yet. Press P to add one.';
      this._poiListContainer.appendChild(empty);
      return;
    }

    this._pois.forEach(poi => {
      const row = document.createElement('div');
      row.className = 'tag-poi-row';
      if (this._adjust && poi.poi_id === this._selectedId) {
        row.classList.add('selected');
        row.setAttribute('aria-current', 'true');
      }
      row.addEventListener('click', e => {
        if ((e.target as HTMLElement).closest('button')) return;
        this.selectPoi(poi.poi_id);
      });

      const info = document.createElement('div');
      info.className = 'tag-poi-info';

      const nameEl = document.createElement('div');
      nameEl.className = 'tag-poi-name';
      nameEl.textContent = poi.name;

      const metaEl = document.createElement('div');
      metaEl.className = 'tag-poi-meta';

      const catBadge = document.createElement('span');
      catBadge.className = 'tag-poi-category';
      catBadge.textContent = poi.category || 'other';

      const posSpan = document.createElement('span');
      posSpan.className = 'tag-poi-pos ns-num';
      posSpan.textContent = `${poi.position.x.toFixed(2)}, ${poi.position.z.toFixed(2)}`;

      metaEl.append(catBadge, posSpan);
      info.append(nameEl, metaEl);

      const actions = document.createElement('div');
      actions.className = 'tag-poi-actions';

      // Edit button
      const editBtn = document.createElement('button');
      editBtn.className = 'tag-icon-btn tag-action-btn ns-press';
      editBtn.title = 'Edit place';
      editBtn.setAttribute('aria-label', `Edit ${poi.name}`);
      editBtn.innerHTML = icon('edit', 16);
      editBtn.addEventListener('click', () => {
        this.openEdit(poi);
      });

      // Move here button
      const moveBtn = document.createElement('button');
      moveBtn.className = 'tag-icon-btn tag-action-btn ns-press';
      moveBtn.title = 'Move here (current position)';
      moveBtn.setAttribute('aria-label', `Move ${poi.name} here`);
      moveBtn.innerHTML = icon('target', 16);
      moveBtn.addEventListener('click', () => {
        const pose = this._getPose();
        poi.position.x = Math.round(pose.x * 1000) / 1000;
        poi.position.z = Math.round(pose.z * 1000) / 1000;
        poi.yaw_deg = Math.round((pose.yaw * 180) / Math.PI);

        const walkable = this._isWalkable ? this._isWalkable(pose.x, pose.z) : true;
        this._draftStore.save(this._pois);
        this._onPoisChange(this._pois);
        this._renderList();

        if (!walkable) {
          this.showToast(`Moved ${poi.name} (not on floor map)`);
        } else {
          this.showToast(`Moved ${poi.name}`);
        }
      });

      // Delete button
      const delBtn = document.createElement('button');
      delBtn.className = 'tag-icon-btn tag-action-btn delete ns-press';
      delBtn.title = 'Delete place';
      delBtn.setAttribute('aria-label', `Delete ${poi.name}`);
      delBtn.innerHTML = icon('trash', 16);
      delBtn.addEventListener('click', () => {
        void this._confirm({ title: `Delete "${poi.name}"?`, confirmLabel: 'Delete' }).then(ok => {
          if (!ok) return;
          this._pois = this._pois.filter(p => p.poi_id !== poi.poi_id);
          this._draftStore.save(this._pois);
          this._onPoisChange(this._pois);
          this._renderList();
          this.showToast(`Deleted ${poi.name}`);
        });
      });

      actions.append(editBtn, moveBtn, delBtn);
      row.append(info, actions);
      this._poiListContainer.appendChild(row);
    });
  }

  private _injectStyles(): void {
    if (document.getElementById('namma-tag-ui-style')) return;
    const style = document.createElement('style');
    style.id = 'namma-tag-ui-style';
    style.textContent = `
      .namma-tag-ui-layer {
        font-family: var(--ns-font);
        color: var(--ns-text);
        pointer-events: none;
      }

      /* ---------- Toasts ---------- */
      .tag-toast-container {
        position: fixed;
        top: calc(var(--ns-hud-top) + var(--ns-target) + 16px);
        left: 50%;
        transform: translateX(-50%);
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--ns-space-2);
        width: max-content;
        max-width: calc(100% - 2 * var(--ns-edge));
        z-index: 500;
        pointer-events: none;
      }
      .tag-toast {
        background: var(--ns-surface-strong);
        color: var(--ns-text);
        border: 1px solid var(--ns-border-strong);
        padding: var(--ns-space-2) var(--ns-space-4);
        border-radius: var(--ns-radius-pill);
        font-size: var(--ns-fs-md);
        font-weight: 600;
        box-shadow: var(--ns-shadow);
        overflow-wrap: anywhere;
        transition: opacity var(--ns-dur) var(--ns-ease-out), translate var(--ns-dur) var(--ns-ease-out);
        @starting-style { opacity: 0; translate: 0 -6px; }
      }
      .tag-toast.fade-out {
        opacity: 0;
        translate: 0 -6px;
        transition-duration: var(--ns-dur-fast);
      }

      /* ---------- Places panel (same card as the POI card) ---------- */
      .tag-panel {
        position: fixed;
        top: calc(var(--ns-hud-top) + var(--ns-target) + 16px);
        right: var(--ns-hud-right);
        width: 300px;
        /* Stops above the 360 px tag-mode minimap (plus its padding) in the bottom-right corner */
        max-height: max(180px, calc(100vh - var(--ns-hud-top) - var(--ns-target) - 16px - var(--ns-hud-bottom) - 382px));
        background: var(--ns-surface-strong);
        border: 1px solid var(--ns-border);
        border-radius: var(--ns-radius-lg);
        box-shadow: var(--ns-shadow);
        display: flex;
        flex-direction: column;
        z-index: 90;
        pointer-events: auto;
        overflow: hidden;
      }
      .tag-panel.collapsed .tag-panel-body {
        display: none;
      }
      .tag-panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--ns-space-2);
        padding: var(--ns-space-1) var(--ns-space-1) var(--ns-space-1) var(--ns-space-4);
        border-bottom: 1px solid var(--ns-border);
      }
      .tag-panel.body-hidden .tag-panel-header { border-bottom: 0; }
      .tag-panel-title-wrap {
        display: flex;
        align-items: baseline;
        gap: 6px;
        min-width: 0;
      }
      .tag-panel-title {
        margin: 0;
        font-weight: 700;
        font-size: var(--ns-fs-lg);
        letter-spacing: var(--ns-heading-ls);
        color: var(--ns-accent);
      }
      .tag-count-badge {
        font-size: var(--ns-fs-md);
        color: var(--ns-text-muted);
        font-variant-numeric: tabular-nums;
      }
      .tag-mode-chip {
        display: none;
        align-self: center;
        margin-left: var(--ns-space-1);
        padding: 1px 8px;
        border: 1px solid var(--ns-badge-border);
        border-radius: 4px;
        background: transparent;
        color: var(--ns-badge);
        font-size: 10px;
        font-weight: 900;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        white-space: nowrap;
      }
      .tag-icon-btn {
        flex: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: var(--ns-target);
        height: var(--ns-target);
        padding: 0;
        border: 1px solid transparent;
        border-radius: var(--ns-radius-sm);
        background: transparent;
        color: var(--ns-text-muted);
        cursor: pointer;
      }
      .tag-chevron { transition: rotate var(--ns-dur) var(--ns-ease-out); }
      .tag-panel.body-hidden .tag-chevron { rotate: -90deg; }
      .tag-panel-body {
        display: flex;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
      }
      .tag-poi-list {
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
        padding: var(--ns-space-2);
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .tag-empty-notice {
        padding: 18px 10px;
        text-align: center;
        font-size: var(--ns-fs-sm);
        color: var(--ns-text-muted);
      }
      .tag-poi-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        background: var(--ns-row);
        border: 1px solid var(--ns-row-border);
        border-radius: var(--ns-radius-md);
        padding: var(--ns-space-1) var(--ns-space-1) var(--ns-space-1) var(--ns-space-3);
        gap: var(--ns-space-2);
      }
      .tag-poi-row { cursor: pointer; }
      .tag-poi-row.selected {
        border-color: var(--ns-accent);
        box-shadow: inset 0 0 0 1px var(--ns-accent), inset 3px 0 0 var(--ns-accent);
        background: var(--ns-accent-soft);
      }
      .tag-poi-row.selected .tag-poi-name { color: var(--ns-accent); }
      .tag-adjust-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--ns-space-2);
        padding: var(--ns-space-2) var(--ns-space-2) var(--ns-space-2) var(--ns-space-4);
        border-bottom: 1px solid var(--ns-border);
      }
      .tag-adjust-label {
        display: inline-flex;
        align-items: center;
        gap: var(--ns-space-2);
        font-size: var(--ns-fs-sm);
        font-weight: 700;
        letter-spacing: var(--ns-label-ls);
        text-transform: uppercase;
        color: var(--ns-text-strong);
      }
      .tag-adjust-kbd {
        font: inherit;
        font-size: var(--ns-fs-xs);
        color: var(--ns-text-muted);
        border: 1px solid var(--ns-border-strong);
        border-bottom-width: 2px;
        border-radius: 4px;
        background: var(--ns-kbd-bg);
        padding: 0 6px;
      }
      .tag-switch {
        position: relative;
        flex: none;
        width: 48px;
        height: 28px;
        padding: 0;
        border-radius: var(--ns-radius-pill);
        border: 1px solid var(--ns-border-strong);
        background: var(--ns-row);
        cursor: pointer;
        transition: background var(--ns-dur) var(--ns-ease-out);
      }
      .tag-switch-knob {
        position: absolute;
        top: 3px;
        left: 3px;
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background: var(--ns-text-muted);
        transition: translate var(--ns-dur) var(--ns-ease-out), background var(--ns-dur) var(--ns-ease-out);
      }
      .tag-switch[aria-checked="true"] { background: var(--ns-primary); border-color: var(--ns-accent); box-shadow: var(--ns-glow); }
      .tag-switch[aria-checked="true"] .tag-switch-knob { translate: 20px 0; background: var(--ns-on-accent); }
      .tag-adjust-hint {
        padding: var(--ns-space-2) var(--ns-space-4);
        font-size: var(--ns-fs-sm);
        line-height: 1.45;
        color: var(--ns-warn-text);
        background: var(--ns-warn-soft);
        border-bottom: 1px solid var(--ns-warn-border);
      }
      .tag-adjust-hint.hidden { display: none; }
      .tag-panel.adjusting { border-color: var(--ns-accent); }
      .tag-poi-info {
        flex: 1;
        min-width: 0;
      }
      .tag-poi-name {
        font-size: var(--ns-fs-md);
        font-weight: 600;
        color: var(--ns-text-strong);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .tag-poi-meta {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        margin-top: 3px;
        white-space: nowrap;
        overflow: hidden;
      }
      .tag-poi-category {
        flex: none;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: var(--ns-label-ls);
        text-transform: uppercase;
        background: transparent;
        color: var(--ns-copper);
        padding: 0 6px;
        border: 1px solid currentColor;
        border-radius: 4px;
      }
      .tag-poi-pos {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        font-size: var(--ns-fs-xs);
        color: var(--ns-text-subtle);
      }
      .tag-poi-actions {
        flex: none;
        display: flex;
        align-items: center;
        gap: 2px;
      }
      .tag-panel-footer {
        padding: var(--ns-space-2);
        border-top: 1px solid var(--ns-border);
        display: flex;
        gap: var(--ns-space-2);
      }
      .tag-panel-footer .ns-btn { flex: 1; padding: 0 var(--ns-space-2); font-size: var(--ns-fs-xs); letter-spacing: 0.06em; white-space: nowrap; }
      @media (hover: hover) and (pointer: fine) {
        .tag-poi-row:hover { background: var(--ns-row-hover); }
        .tag-icon-btn:hover { background: var(--ns-surface-hover); color: var(--ns-text-strong); }
        .tag-action-btn.delete:hover {
          background: var(--ns-danger-soft);
          border-color: var(--ns-danger-border);
          color: var(--ns-danger-text);
        }
      }

      /* ---------- Add / edit form and confirm (shared dialog) ---------- */
      .tag-form-overlay, .tag-confirm-overlay { z-index: 300; }
      .tag-form {
        display: flex;
        flex-direction: column;
        gap: var(--ns-space-3);
      }
      .tag-field-group {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .tag-field-group label {
        font-size: var(--ns-fs-sm);
        font-weight: 600;
        color: var(--ns-text-muted);
      }
      .tag-select { cursor: pointer; }
      .tag-warning-box {
        background: var(--ns-warn-soft);
        border: 1px solid var(--ns-warn-border);
        color: var(--ns-warn-text);
        padding: var(--ns-space-2) 10px;
        border-radius: var(--ns-radius-sm);
        font-size: var(--ns-fs-sm);
        line-height: 1.45;
      }
      .tag-confirm-card { max-width: 360px; }

      /* Narrow screens: the panel becomes a bottom-right sheet; the minimap is top-right */
      @media (max-width: 900px) {
        .tag-panel {
          top: auto;
          bottom: var(--ns-hud-bottom);
          width: min(300px, calc(100% - 2 * var(--ns-edge)));
          max-height: 42vh;
        }
      }

      /* Phone: full-width bottom sheet. While a POI or route card is open it drops to its header
         (unless opened with the chevron), and nav_ui lifts those cards by --ns-sheet-h. */
      @media (max-width: 760px) {
        .tag-panel {
          left: var(--ns-hud-left);
          right: var(--ns-hud-right);
          width: auto;
          max-height: 40vh;
          border-radius: var(--ns-radius-lg);
        }
        .tag-mode-chip { display: inline-block; }
        html:has(.nav-poi-card:not(.hidden)) .tag-panel:not(.peek-open) .tag-panel-body,
        html:has(.nav-route-card:not(.hidden)) .tag-panel:not(.peek-open) .tag-panel-body {
          display: none;
        }
        .tag-poi-name { font-size: var(--ns-fs-lg); }
        .tag-panel-footer .ns-btn { font-size: var(--ns-fs-md); }
        .tag-toast-container {
          top: auto;
          bottom: calc(var(--ns-hud-bottom) + var(--ns-sheet-h, 0px));
        }
      }
    `;
    document.head.appendChild(style);
  }
}
