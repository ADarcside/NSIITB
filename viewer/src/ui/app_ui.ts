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
 */

import type { AppUI, ViewerErrorCode } from '../types.js';

export interface AppUIOptions {
  container?: HTMLElement;
  isDevScene?: boolean;
  initialMode?: 'Ghost' | 'Grid';
  onReset?: () => void;
  onModeToggle?: () => void;
}

export class VanillaAppUI implements AppUI {
  private readonly _root: HTMLElement;
  private readonly _progressContainer: HTMLElement;
  private readonly _progressBar: HTMLElement;
  private readonly _progressText: HTMLElement;
  private readonly _errorPanel: HTMLElement;
  private readonly _errorCode: HTMLElement;
  private readonly _errorMessage: HTMLElement;
  private readonly _errorActions: HTMLElement;
  private readonly _helpOverlay: HTMLElement;
  private readonly _fpsBadge: HTMLElement;
  private readonly _modeBadge: HTMLElement;
  private readonly _resetButton: HTMLElement;

  private _isHelpVisible = false;
  private _mode: 'Ghost' | 'Grid' = 'Ghost';
  private readonly _onReset?: () => void;
  private readonly _onModeToggle?: () => void;

  constructor(options: AppUIOptions = {}) {
    this._onReset = options.onReset;
    this._onModeToggle = options.onModeToggle;
    this._mode = options.initialMode ?? 'Ghost';

    const parent = options.container ?? document.body;

    this._root = document.createElement('div');
    this._root.id = 'namma-ui-root';
    this._root.className = 'namma-ui-layer';

    // Inject styles
    this._injectStyles();

    // 1. Permanent DEV banner if dev synthetic scene
    if (options.isDevScene) {
      const devBanner = document.createElement('div');
      devBanner.id = 'dev-synthetic-banner';
      devBanner.className = 'dev-banner';
      devBanner.textContent = 'DEV SYNTHETIC SCENE (Synthetic test scene — not a real room reconstruction)';
      this._root.appendChild(devBanner);
    }

    // 2. Top-Right HUD: FPS, Mode Indicator, Help & Reset Buttons
    const topHud = document.createElement('div');
    topHud.className = 'hud-top-right';

    this._fpsBadge = document.createElement('div');
    this._fpsBadge.id = 'fps-counter';
    this._fpsBadge.className = 'hud-badge fps-badge';
    this._fpsBadge.textContent = 'FPS: --';
    topHud.appendChild(this._fpsBadge);

    this._modeBadge = document.createElement('button');
    this._modeBadge.id = 'mode-indicator';
    this._modeBadge.className = 'hud-badge mode-badge';
    this._modeBadge.title = 'Click to toggle collision mode (Ghost / Grid)';
    this._modeBadge.textContent = `Mode: ${this._mode}`;
    this._modeBadge.addEventListener('click', () => {
      this._onModeToggle?.();
    });
    topHud.appendChild(this._modeBadge);

    this._resetButton = document.createElement('button');
    this._resetButton.id = 'reset-btn';
    this._resetButton.className = 'hud-button';
    this._resetButton.title = 'Reset camera pose (R)';
    this._resetButton.textContent = 'Reset (R)';
    this._resetButton.addEventListener('click', () => {
      this._onReset?.();
    });
    topHud.appendChild(this._resetButton);

    const helpBtn = document.createElement('button');
    helpBtn.id = 'help-toggle-btn';
    helpBtn.className = 'hud-button';
    helpBtn.title = 'Toggle Controls Help (H)';
    helpBtn.textContent = 'Help (H)';
    helpBtn.addEventListener('click', () => this.toggleHelp());
    topHud.appendChild(helpBtn);

    this._root.appendChild(topHud);

    // 3. Center Progress Bar
    this._progressContainer = document.createElement('div');
    this._progressContainer.id = 'loading-overlay';
    this._progressContainer.className = 'loading-overlay';

    const progressCard = document.createElement('div');
    progressCard.className = 'loading-card';

    this._progressText = document.createElement('div');
    this._progressText.className = 'loading-text';
    this._progressText.textContent = 'Loading scene assets...';
    progressCard.appendChild(this._progressText);

    const barOuter = document.createElement('div');
    barOuter.className = 'progress-bar-outer';

    this._progressBar = document.createElement('div');
    this._progressBar.id = 'progress-bar';
    this._progressBar.className = 'progress-bar-inner';
    barOuter.appendChild(this._progressBar);

    progressCard.appendChild(barOuter);
    this._progressContainer.appendChild(progressCard);
    this._root.appendChild(this._progressContainer);

    // 4. Error Panel (E_MANIFEST, E_ASSET, E_WEBGL, E_SPZ)
    this._errorPanel = document.createElement('div');
    this._errorPanel.id = 'error-panel';
    this._errorPanel.className = 'error-panel hidden';

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
    this._helpOverlay.innerHTML = `
      <div class="help-card">
        <h2>Controls & Navigation</h2>
        <div class="help-grid">
          <div><kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd></div><div>Walk (Forward, Left, Back, Right)</div>
          <div><kbd>Shift</kbd></div><div>Fast Walk (2.5 m/s)</div>
          <div><kbd>E</kbd> / <kbd>Q</kbd></div><div>Fly up / down (over or between furniture; R walks again)</div>
          <div><kbd>Mouse</kbd></div><div>Look around (Yaw & Pitch +/-85&deg;)</div>
          <div><kbd>Click</kbd></div><div>Lock mouse cursor to look</div>
          <div><kbd>Esc</kbd></div><div>Release mouse cursor</div>
          <div><kbd>R</kbd></div><div>Reset to start pose</div>
          <div><kbd>H</kbd></div><div>Toggle this help overlay</div>
        </div>
        <button id="close-help-btn" class="hud-button primary">Got it</button>
      </div>
    `;

    const closeBtn = this._helpOverlay.querySelector('#close-help-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.toggleHelp());
    }

    this._root.appendChild(this._helpOverlay);

    // 6. Global keyboard listeners for H and R
    window.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.code === 'KeyH' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        this.toggleHelp();
      }
    });

    parent.appendChild(this._root);
  }

  setMode(mode: 'Ghost' | 'Grid'): void {
    this._mode = mode;
    this._modeBadge.textContent = `Mode: ${this._mode}`;
  }

  showProgress(p: number): void {
    const clamped = Math.max(0, Math.min(1.0, p));
    const percent = Math.round(clamped * 100);
    this._progressBar.style.width = `${percent}%`;
    this._progressText.textContent = `Loading scene assets... ${percent}%`;

    if (clamped >= 1.0) {
      setTimeout(() => {
        this._progressContainer.classList.add('hidden');
      }, 200);
    } else {
      this._progressContainer.classList.remove('hidden');
    }
  }

  showError(code: ViewerErrorCode, msg: string, onRetryLite?: () => void): void {
    this._progressContainer.classList.add('hidden');
    this._errorCode.textContent = `Error [${code}]`;
    this._errorMessage.textContent = msg;

    this._errorActions.innerHTML = '';
    if (onRetryLite) {
      const retryBtn = document.createElement('button');
      retryBtn.className = 'hud-button primary';
      retryBtn.textContent = 'Retry with Lite Asset';
      retryBtn.addEventListener('click', () => {
        this._errorPanel.classList.add('hidden');
        onRetryLite();
      });
      this._errorActions.appendChild(retryBtn);
    }

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'hud-button';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.addEventListener('click', () => {
      this._errorPanel.classList.add('hidden');
    });
    this._errorActions.appendChild(dismissBtn);

    this._errorPanel.classList.remove('hidden');
  }

  toggleHelp(): void {
    this._isHelpVisible = !this._isHelpVisible;
    if (this._isHelpVisible) {
      this._helpOverlay.classList.remove('hidden');
    } else {
      this._helpOverlay.classList.add('hidden');
    }
  }

  setFps(v: number): void {
    this._fpsBadge.textContent = `FPS: ${Math.round(v)}`;
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
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        color: #f1f5f9;
        overflow: hidden;
      }
      .hidden { display: none !important; }
      .dev-banner {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        background: #dc2626;
        color: #ffffff;
        font-weight: 700;
        font-size: 13px;
        letter-spacing: 0.5px;
        text-align: center;
        padding: 6px 12px;
        z-index: 100;
        box-shadow: 0 2px 8px rgba(0,0,0,0.4);
      }
      .hud-top-right {
        position: absolute;
        top: 40px;
        right: 16px;
        display: flex;
        gap: 8px;
        pointer-events: auto;
        z-index: 90;
      }
      .hud-badge {
        background: rgba(15, 23, 42, 0.75);
        backdrop-filter: blur(8px);
        border: 1px solid rgba(255, 255, 255, 0.15);
        padding: 6px 12px;
        border-radius: 6px;
        font-size: 13px;
        font-weight: 600;
        color: #38bdf8;
      }
      .hud-button {
        background: rgba(15, 23, 42, 0.75);
        backdrop-filter: blur(8px);
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: #f8fafc;
        padding: 6px 12px;
        border-radius: 6px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: background 0.15s;
      }
      .hud-button:hover {
        background: rgba(30, 41, 59, 0.9);
      }
      .hud-button.primary {
        background: #0284c7;
        border-color: #38bdf8;
      }
      .loading-overlay {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(10, 15, 29, 0.85);
        backdrop-filter: blur(10px);
        pointer-events: auto;
        z-index: 80;
      }
      .loading-card {
        background: rgba(30, 41, 59, 0.95);
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 10px;
        padding: 24px;
        width: 320px;
        text-align: center;
        box-shadow: 0 10px 25px rgba(0,0,0,0.5);
      }
      .loading-text {
        font-size: 14px;
        margin-bottom: 12px;
        font-weight: 500;
      }
      .progress-bar-outer {
        width: 100%;
        height: 8px;
        background: rgba(255, 255, 255, 0.1);
        border-radius: 4px;
        overflow: hidden;
      }
      .progress-bar-inner {
        width: 0%;
        height: 100%;
        background: #38bdf8;
        transition: width 0.15s ease-out;
      }
      .error-panel {
        position: absolute;
        top: 80px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(127, 29, 29, 0.95);
        border: 1px solid #ef4444;
        border-radius: 8px;
        padding: 16px 20px;
        width: 90%;
        max-width: 500px;
        pointer-events: auto;
        z-index: 95;
        box-shadow: 0 8px 24px rgba(0,0,0,0.5);
      }
      .error-code {
        font-weight: 700;
        font-size: 14px;
        color: #fecaca;
        margin-bottom: 4px;
      }
      .error-message {
        font-size: 13px;
        color: #ffffff;
        margin-bottom: 12px;
        line-height: 1.4;
      }
      .error-actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
      }
      .help-overlay {
        position: absolute;
        inset: 0;
        background: rgba(15, 23, 42, 0.8);
        backdrop-filter: blur(6px);
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: auto;
        z-index: 85;
      }
      .help-card {
        background: #1e293b;
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 12px;
        padding: 24px;
        width: 90%;
        max-width: 440px;
        box-shadow: 0 12px 30px rgba(0,0,0,0.6);
      }
      .help-card h2 {
        margin: 0 0 16px 0;
        font-size: 18px;
      }
      .help-grid {
        display: grid;
        grid-template-columns: 120px 1fr;
        gap: 8px 16px;
        font-size: 13px;
        margin-bottom: 20px;
        align-items: center;
      }
      kbd {
        background: #334155;
        border: 1px solid rgba(255, 255, 255, 0.2);
        padding: 2px 6px;
        border-radius: 4px;
        font-family: monospace;
        font-size: 11px;
      }
    `;
    document.head.appendChild(style);
  }
}
