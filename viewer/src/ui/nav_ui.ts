/**
 * Namma Space: Navigation UI (Round 2)
 * Search box (top-left) with fuzzy search over tagged POIs, and route card (bottom-center)
 * with distance to destination and arrival notice.
 *
 * Layout: on wide screens the POI card sits bottom-left and the route card bottom-centre.
 * Below 900 px both stack in one bottom-left column (full width on phones) so they never overlap
 * each other or the minimap, and nothing covers the centre of the view.
 */

import type { POI } from '../contracts/types.js';
import { searchPois, type SearchHit } from '../nav/search.js';
import { isTypingTarget } from './app_ui.js';
import { ensureTokens, icon } from './tokens.js';

export interface NavUIOptions {
  container?: HTMLElement;
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

const RESULTS_ID = 'nav-results-list';

export class NavUI {
  private readonly _root: HTMLElement;
  private readonly _searchContainer: HTMLElement;
  private readonly _searchBar: HTMLElement;
  private readonly _searchBtn: HTMLButtonElement;
  private readonly _input: HTMLInputElement;
  private readonly _resultsList: HTMLElement;

  private readonly _routeCard: HTMLElement;
  private readonly _routeContent: HTMLElement;
  private readonly _routeWalkBtn: HTMLButtonElement;
  private readonly _routeClearBtn: HTMLButtonElement;

  private readonly _poiCard: HTMLElement;
  private readonly _poiCardTitle: HTMLElement;
  private readonly _poiCardCategory: HTMLElement;
  private readonly _poiCardDist: HTMLElement;
  private readonly _poiCardDesc: HTMLElement;
  private readonly _poiCardAliases: HTMLElement;
  private readonly _poiCardCloseBtn: HTMLButtonElement;
  private readonly _poiCardNavBtn: HTMLButtonElement;
  private readonly _poiCardLookBtn: HTMLButtonElement;
  private _currentPoiCardItem: POI | null = null;
  private _isAutoWalking = false;

  private _pois: POI[] = [];
  private _currentHits: SearchHit[] = [];
  private _selectedIndex = -1;
  private _arrivedTimer: number | null = null;
  private _blockedTimer: number | null = null;

  private readonly _pickCallbacks: ((poi: POI) => void)[] = [];
  private readonly _clearCallbacks: (() => void)[] = [];
  private readonly _navigateCallbacks: ((poi: POI) => void)[] = [];
  private readonly _lookCallbacks: ((poi: POI) => void)[] = [];
  private readonly _toggleAutoWalkCallbacks: (() => void)[] = [];

  constructor(options: NavUIOptions = {}) {
    const parent = options.container ?? document.body;

    this._root = document.createElement('div');
    this._root.id = 'namma-nav-ui-root';
    this._root.className = 'namma-nav-ui-layer ns-ui';

    // 1. Search Box (top-left), an ARIA combobox over the results listbox
    this._searchContainer = document.createElement('div');
    this._searchContainer.className = 'nav-search-container';

    this._searchBar = document.createElement('div');
    this._searchBar.className = 'nav-search-bar';

    this._searchBtn = document.createElement('button');
    this._searchBtn.className = 'nav-search-btn';
    this._searchBtn.setAttribute('aria-label', 'Search places (/)');
    this._searchBtn.title = 'Search places (/)';
    this._searchBtn.tabIndex = -1; // the input itself is the tab stop
    this._searchBtn.innerHTML = icon('search', 16);

    this._input = document.createElement('input');
    this._input.type = 'search';
    this._input.name = 'place';
    this._input.className = 'nav-search-input';
    this._input.placeholder = 'Search places…';
    this._input.autocomplete = 'off';
    this._input.spellcheck = false;
    this._input.enterKeyHint = 'go';
    this._input.setAttribute('aria-label', 'Search places');
    this._input.setAttribute('role', 'combobox');
    this._input.setAttribute('aria-autocomplete', 'list');
    this._input.setAttribute('aria-controls', RESULTS_ID);
    this._input.setAttribute('aria-expanded', 'false');

    const kbdHint = document.createElement('kbd');
    kbdHint.className = 'ns-kbd nav-search-kbd';
    kbdHint.setAttribute('aria-hidden', 'true');
    kbdHint.textContent = '/';

    this._searchBar.append(this._searchBtn, this._input, kbdHint);

    this._resultsList = document.createElement('div');
    this._resultsList.id = RESULTS_ID;
    this._resultsList.className = 'nav-results-list hidden';
    this._resultsList.setAttribute('role', 'listbox');
    this._resultsList.setAttribute('aria-label', 'Places');

    this._searchContainer.append(this._searchBar, this._resultsList);
    this._root.appendChild(this._searchContainer);

    // Bottom stack: a layout-free wrapper on wide screens, one column on narrow ones
    const bottomStack = document.createElement('div');
    bottomStack.className = 'nav-bottom-stack';

    // 2. Route Card (bottom-center)
    this._routeCard = document.createElement('div');
    this._routeCard.className = 'nav-route-card hidden';
    this._routeCard.setAttribute('role', 'region');
    this._routeCard.setAttribute('aria-label', 'Route navigation');

    this._routeContent = document.createElement('div');
    this._routeContent.className = 'nav-route-content';
    this._routeContent.setAttribute('aria-live', 'polite');

    this._routeWalkBtn = document.createElement('button');
    this._routeWalkBtn.className = 'nav-route-walk-btn ns-press';
    this._routeWalkBtn.title = 'Auto-walk along this path (1.4 m/s)';
    this._setWalkButton('walk', 'Take me there');

    this._routeClearBtn = document.createElement('button');
    this._routeClearBtn.className = 'nav-icon-btn nav-route-clear-btn ns-press';
    this._routeClearBtn.setAttribute('aria-label', 'Clear route');
    this._routeClearBtn.title = 'Clear route';
    this._routeClearBtn.innerHTML = icon('close', 16);

    this._routeCard.append(this._routeContent, this._routeWalkBtn, this._routeClearBtn);

    // 3. POI Info Card (bottom-left)
    this._poiCard = document.createElement('div');
    this._poiCard.className = 'nav-poi-card hidden';
    this._poiCard.setAttribute('role', 'region');
    this._poiCard.setAttribute('aria-label', 'Place details');

    const cardHeader = document.createElement('div');
    cardHeader.className = 'nav-poi-card-header';

    this._poiCardTitle = document.createElement('h2');
    this._poiCardTitle.className = 'nav-poi-card-title';

    this._poiCardCloseBtn = document.createElement('button');
    this._poiCardCloseBtn.className = 'nav-icon-btn nav-poi-card-close ns-press';
    this._poiCardCloseBtn.setAttribute('aria-label', 'Close card');
    this._poiCardCloseBtn.innerHTML = icon('close', 16);

    cardHeader.append(this._poiCardTitle, this._poiCardCloseBtn);

    const metaRow = document.createElement('div');
    metaRow.className = 'nav-poi-card-meta';

    this._poiCardCategory = document.createElement('span');
    this._poiCardCategory.className = 'nav-poi-card-cat';

    this._poiCardDist = document.createElement('span');
    this._poiCardDist.className = 'nav-poi-card-dist ns-num';

    metaRow.append(this._poiCardCategory, this._poiCardDist);

    this._poiCardDesc = document.createElement('div');
    this._poiCardDesc.className = 'nav-poi-card-desc hidden';

    this._poiCardAliases = document.createElement('div');
    this._poiCardAliases.className = 'nav-poi-card-aliases hidden';

    const actionsRow = document.createElement('div');
    actionsRow.className = 'nav-poi-card-actions';

    this._poiCardNavBtn = document.createElement('button');
    this._poiCardNavBtn.className = 'nav-poi-btn primary ns-slant-r ns-press';
    this._poiCardNavBtn.textContent = 'Navigate';

    this._poiCardLookBtn = document.createElement('button');
    this._poiCardLookBtn.className = 'nav-poi-btn secondary ns-slant-l ns-press';
    this._poiCardLookBtn.textContent = 'Look';

    actionsRow.append(this._poiCardNavBtn, this._poiCardLookBtn);

    this._poiCard.append(
      cardHeader,
      metaRow,
      this._poiCardDesc,
      this._poiCardAliases,
      actionsRow
    );

    bottomStack.append(this._poiCard, this._routeCard);
    this._root.appendChild(bottomStack);

    ensureTokens();
    this._injectStyles();
    parent.appendChild(this._root);

    this._setupEvents();
  }

  setPois(pois: POI[]): void {
    this._pois = pois;
    if (!this._resultsList.classList.contains('hidden')) {
      this._updateResults();
    }
  }

  onPick(cb: (poi: POI) => void): void {
    this._pickCallbacks.push(cb);
  }

  onClear(cb: () => void): void {
    this._clearCallbacks.push(cb);
  }

  onNavigate(cb: (poi: POI) => void): void {
    this._navigateCallbacks.push(cb);
  }

  onLook(cb: (poi: POI) => void): void {
    this._lookCallbacks.push(cb);
  }

  onToggleAutoWalk(cb: () => void): void {
    this._toggleAutoWalkCallbacks.push(cb);
  }

  get isAutoWalking(): boolean {
    return this._isAutoWalking;
  }

  setAutoWalking(walking: boolean): void {
    this._isAutoWalking = walking;
    if (walking) {
      this._setWalkButton('stop', 'Stop');
      this._routeWalkBtn.classList.add('walking');
    } else {
      this._setWalkButton('walk', 'Take me there');
      this._routeWalkBtn.classList.remove('walking');
    }
  }

  showPoiCard(poi: POI, distanceM: number | null): void {
    this._currentPoiCardItem = poi;
    this._poiCardTitle.textContent = poi.name;
    this._poiCardCategory.textContent = poi.category || 'other';

    if (distanceM !== null) {
      this._poiCardDist.textContent = `${distanceM.toFixed(1)} m`;
    } else {
      this._poiCardDist.textContent = 'not reachable';
    }

    if (poi.description && poi.description.trim()) {
      this._poiCardDesc.textContent = poi.description;
      this._poiCardDesc.classList.remove('hidden');
    } else {
      this._poiCardDesc.classList.add('hidden');
    }

    if (poi.aliases && poi.aliases.length > 0) {
      this._poiCardAliases.textContent = `Aliases: ${poi.aliases.join(', ')}`;
      this._poiCardAliases.classList.remove('hidden');
    } else {
      this._poiCardAliases.classList.add('hidden');
    }

    this._poiCard.classList.remove('hidden');
  }

  hidePoiCard(): void {
    this._poiCard.classList.add('hidden');
    this._currentPoiCardItem = null;
  }

  isPoiCardOpen(): boolean {
    return !this._poiCard.classList.contains('hidden');
  }

  setRoute(name: string, metres: number | null, suffix = ''): void {
    if (this._arrivedTimer !== null) {
      window.clearTimeout(this._arrivedTimer);
      this._arrivedTimer = null;
    }
    if (this._blockedTimer !== null) {
      window.clearTimeout(this._blockedTimer);
      this._blockedTimer = null;
    }

    if (metres !== null) {
      this._routeContent.innerHTML = `To <strong>${escapeHtml(name)}</strong> <span class="nav-route-dist ns-num">${metres.toFixed(1)} m</span>${escapeHtml(suffix)}`;
    } else {
      this._routeContent.innerHTML = `No walkable path to <strong>${escapeHtml(name)}</strong>`;
    }
    this._routeCard.classList.toggle('no-path', metres === null);
    this._routeCard.classList.remove('arrived');
    this._routeCard.classList.remove('hidden');
  }

  showArrived(name: string): void {
    if (this._arrivedTimer !== null) {
      window.clearTimeout(this._arrivedTimer);
    }
    if (this._blockedTimer !== null) {
      window.clearTimeout(this._blockedTimer);
      this._blockedTimer = null;
    }
    this._routeContent.innerHTML = `You've arrived at <strong>${escapeHtml(name)}</strong>`;
    this._routeCard.classList.add('arrived');
    this._routeCard.classList.remove('no-path');
    this._routeCard.classList.remove('hidden');

    this._arrivedTimer = window.setTimeout(() => {
      this.clearRoute();
    }, 3000);
  }

  showBlocked(name: string): void {
    if (this._arrivedTimer !== null) {
      window.clearTimeout(this._arrivedTimer);
      this._arrivedTimer = null;
    }
    if (this._blockedTimer !== null) {
      window.clearTimeout(this._blockedTimer);
      this._blockedTimer = null;
    }

    const previousHtml = this._routeContent.innerHTML;
    this._routeContent.innerHTML = `Couldn't reach <strong>${escapeHtml(name)}</strong>, blocked`;
    this._routeCard.classList.remove('hidden');

    this._blockedTimer = window.setTimeout(() => {
      this._blockedTimer = null;
      if (previousHtml && !this._routeCard.classList.contains('hidden')) {
        this._routeContent.innerHTML = previousHtml;
      }
    }, 3000);
  }

  clearRoute(): void {
    if (this._arrivedTimer !== null) {
      window.clearTimeout(this._arrivedTimer);
      this._arrivedTimer = null;
    }
    if (this._blockedTimer !== null) {
      window.clearTimeout(this._blockedTimer);
      this._blockedTimer = null;
    }
    this._routeCard.classList.add('hidden');
    this._input.value = '';
  }

  focusSearch(): void {
    document.exitPointerLock?.();
    this._input.focus();
    this._input.select();
    this._updateResults();
    this._showResults();
  }

  dispose(): void {
    if (this._arrivedTimer !== null) {
      window.clearTimeout(this._arrivedTimer);
    }
    if (this._blockedTimer !== null) {
      window.clearTimeout(this._blockedTimer);
    }
    this._root.remove();
  }

  private _setWalkButton(iconName: string, label: string): void {
    this._routeWalkBtn.innerHTML = `${icon(iconName, 14)}<span>${label}</span>`;
  }

  private _setupEvents(): void {
    // Release pointer lock whenever clicking search controls
    const exitLock = () => {
      document.exitPointerLock?.();
    };

    this._searchBar.addEventListener('click', exitLock);
    this._searchBtn.addEventListener('click', () => {
      exitLock();
      this.focusSearch();
    });

    // Input events
    this._input.addEventListener('focus', () => {
      exitLock();
      this._updateResults();
      this._showResults();
    });

    this._input.addEventListener('input', () => {
      this._updateResults();
      this._showResults();
    });

    this._input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this._input.value = '';
        this._input.blur();
        this._hideResults();
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (this._resultsList.classList.contains('hidden')) {
          this._showResults();
          return;
        }
        if (this._currentHits.length > 0) {
          this._selectedIndex = (this._selectedIndex + 1) % this._currentHits.length;
          this._renderResults();
        }
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (this._resultsList.classList.contains('hidden')) {
          this._showResults();
          return;
        }
        if (this._currentHits.length > 0) {
          this._selectedIndex =
            this._selectedIndex <= 0 ? this._currentHits.length - 1 : this._selectedIndex - 1;
          this._renderResults();
        }
        return;
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        if (this._selectedIndex >= 0 && this._selectedIndex < this._currentHits.length) {
          this._selectHit(this._currentHits[this._selectedIndex]);
        } else if (this._currentHits.length > 0) {
          this._selectHit(this._currentHits[0]);
        }
      }
    });

    // Close results when clicking outside
    document.addEventListener('pointerdown', (e: PointerEvent) => {
      if (!this._searchContainer.contains(e.target as Node)) {
        this._hideResults();
      }
    });

    // Global / shortcut
    window.addEventListener('keydown', (e: KeyboardEvent) => {
      if (isTypingTarget(e)) return;
      if (e.key === '/' || e.code === 'Slash') {
        if (!e.ctrlKey && !e.altKey && !e.metaKey) {
          e.preventDefault();
          this.focusSearch();
        }
      }
    });

    // Clear route button
    this._routeClearBtn.addEventListener('click', () => {
      this.clearRoute();
      this._clearCallbacks.forEach(cb => cb());
    });

    // POI Card actions
    this._poiCardCloseBtn.addEventListener('click', () => {
      this.hidePoiCard();
    });

    this._poiCardNavBtn.addEventListener('click', () => {
      if (this._currentPoiCardItem) {
        const poi = this._currentPoiCardItem;
        this._navigateCallbacks.forEach(cb => cb(poi));
      }
    });

    this._poiCardLookBtn.addEventListener('click', () => {
      if (this._currentPoiCardItem) {
        const poi = this._currentPoiCardItem;
        this._lookCallbacks.forEach(cb => cb(poi));
      }
    });

    // Auto-walk button
    this._routeWalkBtn.addEventListener('click', () => {
      this._toggleAutoWalkCallbacks.forEach(cb => cb());
    });

    // Close POI card on Escape
    window.addEventListener('keydown', (e: KeyboardEvent) => {
      if (isTypingTarget(e)) return;
      if (e.key === 'Escape' && this.isPoiCardOpen()) {
        e.preventDefault();
        this.hidePoiCard();
      }
    });
  }

  private _showResults(): void {
    this._resultsList.classList.remove('hidden');
    this._input.setAttribute('aria-expanded', 'true');
    document.documentElement.classList.add('ns-search-open');
  }

  private _hideResults(): void {
    this._resultsList.classList.add('hidden');
    this._input.setAttribute('aria-expanded', 'false');
    document.documentElement.classList.remove('ns-search-open');
    this._input.removeAttribute('aria-activedescendant');
  }

  private _updateResults(): void {
    if (this._pois.length === 0) {
      this._currentHits = [];
      this._selectedIndex = -1;
      this._resultsList.innerHTML = `<div class="nav-result-empty">No places tagged in this scene yet</div>`;
      this._input.removeAttribute('aria-activedescendant');
      return;
    }

    const query = this._input.value.trim();
    this._currentHits = searchPois(this._pois, query, 8);
    this._selectedIndex = this._currentHits.length > 0 ? 0 : -1;
    this._renderResults();
  }

  private _renderResults(): void {
    if (this._currentHits.length === 0) {
      this._resultsList.innerHTML = `<div class="nav-result-empty">No matching places</div>`;
      this._input.removeAttribute('aria-activedescendant');
      return;
    }

    this._resultsList.innerHTML = '';
    this._currentHits.forEach((hit, index) => {
      const row = document.createElement('div');
      row.id = `nav-result-${index}`;
      row.className = `nav-result-row${index === this._selectedIndex ? ' selected' : ''}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', index === this._selectedIndex ? 'true' : 'false');
      row.innerHTML = `
        <span class="nav-result-name">${escapeHtml(hit.poi.name)}</span>
        <span class="nav-result-cat">${escapeHtml(hit.poi.category || 'other')}</span>
      `;

      // Prevent input from blurring prematurely on mousedown
      row.addEventListener('pointerdown', (e: PointerEvent) => {
        e.preventDefault();
      });

      row.addEventListener('click', () => {
        this._selectHit(hit);
      });

      row.addEventListener('pointerenter', () => {
        this._selectedIndex = index;
        const rows = this._resultsList.querySelectorAll('.nav-result-row');
        rows.forEach((r, idx) => {
          r.classList.toggle('selected', idx === index);
          r.setAttribute('aria-selected', idx === index ? 'true' : 'false');
        });
        this._input.setAttribute('aria-activedescendant', row.id);
      });

      this._resultsList.appendChild(row);
    });

    if (this._selectedIndex >= 0) {
      const selectedId = `nav-result-${this._selectedIndex}`;
      this._input.setAttribute('aria-activedescendant', selectedId);
      this._resultsList.querySelector(`#${selectedId}`)?.scrollIntoView({ block: 'nearest' });
    }
  }

  private _selectHit(hit: SearchHit): void {
    this._input.value = hit.poi.name;
    this._hideResults();
    this._input.blur();
    this._pickCallbacks.forEach(cb => cb(hit.poi));
  }

  private _injectStyles(): void {
    if (document.getElementById('namma-nav-ui-style')) return;
    const style = document.createElement('style');
    style.id = 'namma-nav-ui-style';
    style.textContent = `
      .namma-nav-ui-layer {
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

      /* ---------- Search ---------- */
      .nav-search-container {
        position: absolute;
        top: var(--ns-hud-top);
        left: var(--ns-hud-left);
        z-index: 95;
        width: 300px;
        pointer-events: auto;
      }
      .nav-search-bar {
        display: flex;
        align-items: center;
        min-height: calc(var(--ns-target) + 8px);
        background: var(--ns-surface);
        backdrop-filter: var(--ns-blur);
        -webkit-backdrop-filter: var(--ns-blur);
        border: 1px solid var(--ns-border);
        border-radius: var(--ns-radius-lg);
        padding: 0 var(--ns-space-2) 0 var(--ns-space-1);
        gap: var(--ns-space-1);
        box-shadow: var(--ns-shadow);
        transition: border-color var(--ns-dur-fast) ease, box-shadow var(--ns-dur-fast) ease;
      }
      .nav-search-bar:focus-within {
        border-color: var(--ns-accent);
        box-shadow: var(--ns-shadow), 0 0 0 3px var(--ns-accent-ring);
      }
      .nav-search-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: var(--ns-target);
        height: var(--ns-target);
        background: transparent;
        border: none;
        padding: 0;
        color: var(--ns-accent);
        cursor: pointer;
      }
      .nav-search-input {
        flex: 1;
        min-width: 0;
        background: transparent;
        border: none;
        outline: none;
        color: var(--ns-text);
        font-size: var(--ns-fs-md);
        font-weight: 500;
        caret-color: var(--ns-accent);
        -webkit-appearance: none;
        appearance: none;
      }
      /* The bar's :focus-within ring is the focus indicator; no second ring on the input */
      .nav-search-input:focus-visible { outline: none; }
      .nav-search-input::-webkit-search-cancel-button { -webkit-appearance: none; }
      .nav-search-input::placeholder { color: var(--ns-text-subtle); }
      .nav-search-bar:focus-within .nav-search-kbd { opacity: 0; }
      .nav-search-kbd { transition: opacity var(--ns-dur-fast) ease; }
      .nav-results-list {
        margin-top: 6px;
        padding: var(--ns-space-1);
        background: var(--ns-surface-strong);
        border: 1px solid var(--ns-border);
        border-radius: var(--ns-radius-lg);
        box-shadow: var(--ns-shadow);
        max-height: min(380px, 50vh);
        overflow-y: auto;
        overscroll-behavior: contain;
        transform-origin: top left;
        transition: opacity var(--ns-dur-fast) var(--ns-ease-out), transform var(--ns-dur-fast) var(--ns-ease-out),
          display var(--ns-dur-fast) allow-discrete;
        @starting-style { opacity: 0; transform: translateY(-4px) scale(0.98); }
      }
      .nav-results-list.hidden { opacity: 0; transform: translateY(-4px) scale(0.98); }
      .nav-result-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: var(--ns-space-3);
        min-height: var(--ns-target);
        padding: 6px 10px;
        border-radius: var(--ns-radius-sm);
        cursor: pointer;
      }
      .nav-result-row.selected { background: var(--ns-accent-soft); box-shadow: inset 2px 0 0 var(--ns-accent); }
      .nav-result-name {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: var(--ns-fs-md);
        font-weight: 600;
        color: var(--ns-text);
      }
      .nav-result-row.selected .nav-result-name { color: var(--ns-accent); }
      .nav-result-cat {
        flex: none;
        font-size: var(--ns-fs-xs);
        font-weight: 500;
        color: var(--ns-text-muted);
        text-transform: lowercase;
      }
      .nav-result-empty {
        padding: var(--ns-space-3) 14px;
        font-size: var(--ns-fs-sm);
        color: var(--ns-text-muted);
        text-align: center;
      }

      /* ---------- Bottom cards ---------- */
      .nav-bottom-stack { display: contents; }
      .nav-route-card, .nav-poi-card {
        background: var(--ns-surface-strong);
        box-shadow: var(--ns-shadow);
        pointer-events: auto;
        transition: opacity var(--ns-dur) var(--ns-ease-out), translate var(--ns-dur) var(--ns-ease-out),
          display var(--ns-dur) allow-discrete;
        @starting-style { opacity: 0; translate: 0 8px; }
      }
      .nav-route-card.hidden, .nav-poi-card.hidden {
        opacity: 0;
        translate: 0 6px;
        transition-duration: var(--ns-dur-fast);
      }

      .nav-route-card {
        position: absolute;
        bottom: var(--ns-hud-bottom);
        left: 50%;
        transform: translateX(-50%);
        z-index: 90;
        display: flex;
        align-items: center;
        gap: var(--ns-space-2);
        max-width: min(560px, calc(100% - 2 * var(--ns-edge)));
        border: 1px solid var(--ns-route-soft);
        border-radius: var(--ns-radius-lg);
        padding: 5px 5px 5px 16px;
        color: var(--ns-text);
        font-size: var(--ns-fs-md);
      }
      .nav-route-card.arrived { border-color: var(--ns-success-border); }
      .nav-route-card.no-path { border-color: var(--ns-nopath-border); }
      .nav-route-content {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .nav-route-content strong { color: var(--ns-route); font-weight: 700; }
      .nav-route-dist {
        margin-left: 6px;
        font-weight: 700;
        color: var(--ns-text-strong);
      }
      .nav-icon-btn {
        flex: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: var(--ns-target);
        height: var(--ns-target);
        padding: 0;
        border: none;
        border-radius: var(--ns-radius-sm);
        background: transparent;
        color: var(--ns-text-muted);
        cursor: pointer;
      }
      .nav-route-walk-btn {
        flex: none;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-height: var(--ns-target);
        padding: 0 14px;
        border: none;
        border-radius: var(--ns-radius-sm);
        background: var(--ns-primary);
        color: var(--ns-on-accent);
        box-shadow: var(--ns-glow);
        font-size: var(--ns-fs-sm);
        font-weight: 700;
        letter-spacing: var(--ns-label-ls);
        text-transform: uppercase;
        cursor: pointer;
        white-space: nowrap;
      }
      .nav-route-walk-btn.walking { background: var(--ns-danger); color: var(--ns-on-fill); box-shadow: none; }
      @media (hover: hover) and (pointer: fine) {
        .nav-icon-btn:hover { color: var(--ns-sky); background: var(--ns-surface-hover); }
        .nav-route-walk-btn:hover { background: var(--ns-primary-hover); box-shadow: var(--ns-glow-strong); }
        .nav-route-walk-btn.walking:hover { background: var(--ns-danger-hover); }
        .nav-result-row:hover { background: var(--ns-accent-soft); }
      }

      .nav-poi-card {
        position: absolute;
        bottom: var(--ns-hud-bottom);
        left: var(--ns-hud-left);
        z-index: 90;
        width: 300px;
        max-width: calc(100vw - 2 * var(--ns-edge));
        border: 1px solid var(--ns-border);
        border-radius: var(--ns-radius-lg);
        padding: var(--ns-space-3) var(--ns-space-3) var(--ns-space-3) var(--ns-space-4);
        display: flex;
        flex-direction: column;
        gap: var(--ns-space-2);
      }
      .nav-poi-card-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: var(--ns-space-2);
        margin: -4px -4px 0 0;
      }
      .nav-poi-card-title {
        margin: 0;
        min-width: 0;
        font-size: var(--ns-fs-lg);
        font-weight: 700;
        letter-spacing: var(--ns-heading-ls);
        color: var(--ns-accent);
        overflow-wrap: anywhere;
        text-wrap: balance;
      }
      .nav-poi-card-meta {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: var(--ns-space-2);
        padding-right: var(--ns-space-1);
      }
      .nav-poi-card-cat {
        font-size: var(--ns-fs-xs);
        font-weight: 700;
        letter-spacing: var(--ns-label-ls);
        text-transform: uppercase;
        background: transparent;
        color: var(--ns-copper);
        padding: 1px 8px;
        border: 1px solid currentColor;
        border-radius: 4px;
      }
      .nav-poi-card-dist {
        font-size: var(--ns-fs-sm);
        font-weight: 600;
        color: var(--ns-text);
      }
      .nav-poi-card-desc {
        font-size: var(--ns-fs-sm);
        color: var(--ns-text-muted);
        line-height: 1.45;
        overflow-wrap: anywhere;
      }
      .nav-poi-card-aliases {
        font-size: var(--ns-fs-xs);
        color: var(--ns-text-muted);
        overflow-wrap: anywhere;
      }
      .nav-poi-card-actions {
        display: flex;
        gap: var(--ns-space-2);
        margin-top: var(--ns-space-1);
        padding-right: var(--ns-space-1);
      }
      .nav-poi-btn {
        flex: 1;
        min-height: var(--ns-target);
        padding: 0 var(--ns-space-3);
        border: none;
        border-radius: 2px;
        font-size: var(--ns-fs-sm);
        font-weight: 700;
        letter-spacing: var(--ns-label-ls);
        text-transform: uppercase;
        cursor: pointer;
      }
      /* Navigate / Look are a slanted pair, like the site's EXPLORE / REGISTER */
      .nav-poi-btn.primary {
        background: var(--ns-primary);
        color: var(--ns-on-accent);
      }
      .nav-poi-btn.secondary {
        background: var(--ns-surface-hover-strong);
        color: var(--ns-text);
      }
      .nav-poi-card-actions { gap: 4px; }
      @media (hover: hover) and (pointer: fine) {
        .nav-poi-btn.primary:hover { background: var(--ns-primary-hover); }
        .nav-poi-btn.secondary:hover { background: var(--ns-surface-hover-strong); color: var(--ns-sky); }
      }

      /* Below 900 px: POI card and route card share one bottom-left column */
      @media (max-width: 900px) {
        .nav-bottom-stack {
          position: absolute;
          left: var(--ns-hud-left);
          bottom: var(--ns-hud-bottom);
          z-index: 90;
          display: flex;
          flex-direction: column;
          gap: var(--ns-space-2);
          width: min(380px, calc(100% - 2 * var(--ns-edge)));
          pointer-events: none;
        }
        .nav-route-card, .nav-poi-card {
          position: static;
          transform: none;
          width: auto;
          max-width: none;
        }
      }

      /* Phone: search spans the top row */
      @media (max-width: 760px) {
        .nav-search-container {
          left: var(--ns-hud-left);
          right: var(--ns-hud-right);
          width: auto;
        }
        .nav-search-input { font-size: 16px; } /* 16 px stops iOS zooming into the field */
        /* The open results list covers the HUD row; hide the row so its blurred glass can't show through */
        html.ns-search-open .hud-top-right { visibility: hidden; }
        /* In tag mode the Places sheet publishes its height; the cards sit on top of it, never under */
        .nav-bottom-stack {
          right: var(--ns-hud-right);
          width: auto;
          bottom: calc(var(--ns-hud-bottom) + var(--ns-sheet-h, 0px));
        }
        .nav-poi-card { padding: var(--ns-space-2) var(--ns-space-2) var(--ns-space-2) var(--ns-space-3); gap: 6px; }
      }
    `;
    document.head.appendChild(style);
  }
}
