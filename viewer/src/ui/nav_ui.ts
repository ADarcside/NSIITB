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
import NAV_UI_CSS from './nav_ui.css?raw';

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

    // Publish how tall the bottom cards are (--ns-nav-stack-h), so the touch joystick sits above them
    if (typeof ResizeObserver !== 'undefined') {
      const publish = () => {
        const stackH = bottomStack.getBoundingClientRect().height; // 0 while it is display: contents
        const h = stackH > 0 ? stackH : this._poiCard.offsetHeight;
        document.documentElement.style.setProperty('--ns-nav-stack-h', `${Math.round(h)}px`);
      };
      const ro = new ResizeObserver(publish);
      ro.observe(this._poiCard);
      ro.observe(this._routeCard);
      window.addEventListener('resize', publish);
    }

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
    this._setupCardSwipe();

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

  /** Touch: drag the place card down to close it (the same as its close button). Buttons keep their taps. */
  private _setupCardSwipe(): void {
    const card = this._poiCard;
    let startY = 0;
    let dy = 0;
    let pointerId: number | null = null;
    const end = (e: PointerEvent) => {
      if (pointerId !== e.pointerId) return;
      pointerId = null;
      card.style.transition = '';
      card.style.translate = '';
      if (dy > 56) this.hidePoiCard();
      dy = 0;
    };
    card.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch' || (e.target instanceof Element && e.target.closest('button'))) return;
      pointerId = e.pointerId;
      startY = e.clientY;
      dy = 0;
      card.setPointerCapture?.(e.pointerId);
    });
    card.addEventListener('pointermove', e => {
      if (pointerId !== e.pointerId) return;
      dy = Math.max(0, e.clientY - startY);
      card.style.transition = 'none';
      card.style.translate = `0 ${dy}px`;
    });
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', end);
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
    style.textContent = NAV_UI_CSS;
    document.head.appendChild(style);
  }
}
