/**
 * Namma Space: shared UI tokens (Techfest sibling theme)
 * One spacing, radius, colour, type and motion scale for every overlay (HUD, search, cards,
 * minimap, tag panel, POI labels, loading screen). Each UI module calls ensureTokens() before
 * injecting its own styles; the sheet is added once.
 *
 * The palette, type and shapes follow techfest.org's computed styles (see docs/ui-audit.md,
 * "Techfest sibling theme"): near-black #0a0a0c page, navy glass rails with a pale-blue hairline,
 * gold #ffd700 -> #ffaa00 accents with dark text, rust #b53b26 secondary fills, sky #6fc4f2 hover,
 * Space Grotesk with uppercase tracked labels. Nothing is loaded from techfest.org.
 *
 * Contrast: text tokens are checked against --ns-surface over a bright scene (>= 4.5:1).
 * Motion: every transition uses the --ns-dur-* tokens, which drop to 0 under prefers-reduced-motion.
 */

// Self-hosted OFL fonts, bundled by Vite (licences next to the files in src/assets/fonts/)
import spaceGroteskUrl from '../assets/fonts/space-grotesk-latin-wght.woff2';
import ryeUrl from '../assets/fonts/rye-latin-400.woff2';

/**
 * The same palette for code that cannot read CSS variables: the minimap canvas, the Three.js route
 * ribbon and goal ring, and the WebGL clear colour.
 */
export const THEME = {
  bg: '#0a0a0c',
  gold: '#ffd700',
  goldDeep: '#ffaa00',
  rust: '#b53b26',
  sky: '#6fc4f2',
  copper: '#e0b48a',
  ink: '#0a0a0c',
  white: '#ffffff',
  mapBg: '#0d1220',
  mapFree: [216, 210, 196, 235] as const,
  mapBlocked: [10, 10, 12, 255] as const,
  mapBorder: 'rgba(150, 200, 255, 0.15)',
  mapDot: '#14182a',
  routeTexture: ['rgba(255, 255, 255, 0.95)', 'rgba(255, 215, 0, 0.92)', 'rgba(255, 170, 0, 0.6)', 'rgba(181, 59, 38, 0.25)'] as const,
} as const;

export const TOKENS_STYLE_ID = 'namma-ui-tokens';

export const TOKENS_CSS = `
  @font-face {
    font-family: "Space Grotesk";
    src: url("${spaceGroteskUrl}") format("woff2");
    font-weight: 300 700;
    font-style: normal;
    font-display: swap;
  }
  @font-face {
    font-family: "Rye";
    src: url("${ryeUrl}") format("woff2");
    font-weight: 400;
    font-style: normal;
    font-display: swap;
  }
  :root {
    /* Type: Space Grotesk like techfest.org; Rye stands in for its display face on the loading screen */
    --ns-font: "Space Grotesk", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --ns-font-display: "Rye", Georgia, "Times New Roman", serif;
    --ns-fs-xs: 11px;
    --ns-fs-sm: 12px;
    --ns-fs-md: 13px;
    --ns-fs-lg: 15px;
    --ns-fs-xl: 18px;
    --ns-label-ls: 0.096em;   /* nav labels: 15 px / 1.44 px */
    --ns-heading-ls: 0.04em;  /* gold headings: 18.4 px / 0.8 px */

    /* Spacing (4 px grid) */
    --ns-space-1: 4px;
    --ns-space-2: 8px;
    --ns-space-3: 12px;
    --ns-space-4: 16px;
    --ns-space-5: 24px;

    /* Radius: 8 px buttons, 12 px rails and cards, 10 px slant on paired buttons */
    --ns-radius-sm: 8px;
    --ns-radius-md: 10px;
    --ns-radius-lg: 12px;
    --ns-radius-pill: 999px;
    --ns-slant: 10px;

    /* Colour */
    --ns-bg: ${THEME.bg};
    --ns-surface: rgba(10, 15, 30, 0.74);
    --ns-surface-strong: rgba(10, 15, 30, 0.93);
    --ns-surface-raised: rgba(24, 32, 54, 0.94);
    --ns-surface-hover: rgba(255, 255, 255, 0.08);
    --ns-surface-hover-strong: rgba(255, 255, 255, 0.14);
    --ns-border: rgba(150, 200, 255, 0.15);
    --ns-border-strong: rgba(150, 200, 255, 0.3);
    --ns-text: #ffffff;
    --ns-text-strong: #ffffff;
    --ns-text-muted: #c8ccd6;
    --ns-text-subtle: #9aa1b0;
    --ns-on-fill: #ffffff;
    --ns-on-accent: ${THEME.ink};
    --ns-accent: ${THEME.gold};
    --ns-accent-deep: ${THEME.goldDeep};
    --ns-accent-soft: rgba(255, 215, 0, 0.14);
    --ns-accent-ring: rgba(255, 215, 0, 0.28);
    --ns-primary: linear-gradient(90deg, ${THEME.gold}, ${THEME.goldDeep});
    --ns-primary-hover: linear-gradient(90deg, #ffe14d, #ffb933);
    --ns-glow: 0 4px 15px rgba(255, 215, 0, 0.3);
    --ns-glow-strong: 0 6px 22px rgba(255, 215, 0, 0.45);
    --ns-route: ${THEME.gold};
    --ns-route-soft: rgba(255, 215, 0, 0.45);
    --ns-sky: ${THEME.sky};
    --ns-copper: ${THEME.copper};
    --ns-badge: #ffe600;
    --ns-badge-border: rgba(255, 230, 0, 0.5);
    --ns-success-border: rgba(74, 222, 128, 0.6);
    --ns-nopath-border: rgba(255, 170, 0, 0.65);
    --ns-danger: ${THEME.rust};
    --ns-danger-hover: #9c3220;
    --ns-danger-text: #f6a896;
    --ns-danger-soft: rgba(181, 59, 38, 0.22);
    --ns-danger-soft-hover: rgba(181, 59, 38, 0.38);
    --ns-danger-border: rgba(224, 110, 80, 0.6);
    --ns-error-bg: rgba(52, 12, 6, 0.95);
    --ns-error-text: #ffc9bd;
    --ns-warn: ${THEME.goldDeep};
    --ns-warn-soft: rgba(255, 170, 0, 0.14);
    --ns-warn-border: rgba(255, 170, 0, 0.7);
    --ns-warn-text: #ffd27a;
    --ns-row: rgba(255, 255, 255, 0.04);
    --ns-row-hover: rgba(255, 255, 255, 0.08);
    --ns-row-border: rgba(150, 200, 255, 0.1);
    --ns-input: rgba(5, 8, 16, 0.72);
    --ns-input-solid: #0d1220;
    --ns-kbd-bg: rgba(255, 255, 255, 0.08);
    --ns-scrim: rgba(5, 5, 8, 0.74);
    --ns-focus: ${THEME.sky};
    --ns-selection: rgba(255, 215, 0, 0.3);
    --ns-shadow-sm: 0 4px 14px rgba(0, 0, 0, 0.45);
    --ns-shadow: 0 10px 40px rgba(0, 0, 0, 0.6);
    /* techfest.org uses blur(20px); 10 px is what was measured inside the FPS budget
       (interleaved A/B at 6x CPU throttle: -1.6 fps against the previous UI) */
    --ns-blur: blur(10px);

    /* POI labels over the scene */
    --ns-pill-bg: rgba(10, 15, 30, 0.88);
    --ns-pill-bg-hover: rgba(24, 32, 54, 0.96);
    --ns-pill-border: rgba(255, 215, 0, 0.45);
    --ns-pill-border-hover: rgba(255, 215, 0, 0.9);
    --ns-pill-highlight-bg: linear-gradient(90deg, ${THEME.gold}, ${THEME.goldDeep});

    /* Loading screen (dusk sky sampled from techfest.org's intro and hero) */
    --ns-ld-dusk: #2d314a;
    --ns-ld-plum: #392329;
    --ns-ld-amber: #e9822e;
    --ns-ld-gold-soft: #f8d169;
    --ns-ld-glass: rgba(10, 15, 30, 0.6);
    --ns-ld-text-dim: #d9cbb8;
    --ns-ld-edge: rgba(248, 209, 105, 0.35);
    --ns-ld-line: rgba(248, 209, 105, 0.16);
    --ns-ld-track: rgba(248, 209, 105, 0.18);
    --ns-ld-inner: rgba(248, 209, 105, 0.45);
    --ns-ld-inner-b: rgba(233, 130, 46, 0.55);
    --ns-ld-ray: rgba(250, 189, 116, 0.35);
    --ns-ld-glow: rgba(255, 215, 0, 0.55);
    --ns-ld-core-glow: rgba(233, 130, 46, 0.9);
    --ns-ld-name-glow: rgba(233, 130, 46, 0.35);
    --ns-ld-credit: rgba(217, 203, 184, 0.78);

    /* Motion */
    --ns-ease-out: cubic-bezier(0.23, 1, 0.32, 1);
    --ns-dur-press: 120ms;
    --ns-dur-fast: 150ms;
    --ns-dur: 200ms;
    --ns-dur-slow: 250ms;

    /* Layout */
    --ns-target: 32px;
    --ns-edge: 16px;
    --ns-hud-top: max(var(--ns-edge), env(safe-area-inset-top));
    --ns-hud-bottom: max(var(--ns-edge), env(safe-area-inset-bottom));
    --ns-hud-left: max(var(--ns-edge), env(safe-area-inset-left));
    --ns-hud-right: max(var(--ns-edge), env(safe-area-inset-right));
  }
  @media (pointer: coarse) {
    :root { --ns-target: 44px; }
  }
  @media (max-width: 640px) {
    :root { --ns-edge: 12px; }
  }
  @media (prefers-reduced-motion: reduce) {
    :root {
      --ns-dur-press: 0ms;
      --ns-dur-fast: 0ms;
      --ns-dur: 0ms;
      --ns-dur-slow: 0ms;
    }
  }

  /* Shared primitives */
  .ns-ui button, .ns-ui input, .ns-ui select { font-family: inherit; touch-action: manipulation; }
  .ns-ui button { -webkit-tap-highlight-color: transparent; }
  .ns-ui :focus-visible {
    outline: 2px solid var(--ns-focus);
    outline-offset: 2px;
  }
  .ns-ui ::selection { background: var(--ns-selection); }
  .ns-press {
    transition: transform var(--ns-dur-press) var(--ns-ease-out), background-color var(--ns-dur-fast) ease,
      border-color var(--ns-dur-fast) ease, color var(--ns-dur-fast) ease, box-shadow var(--ns-dur) ease;
  }
  .ns-press:active { transform: scale(0.97); }
  .ns-num { font-variant-numeric: tabular-nums; }
  .ns-icon { display: block; flex: none; }
  .ns-kbd {
    display: inline-block;
    min-width: 18px;
    padding: 1px 5px;
    border: 1px solid var(--ns-border-strong);
    border-bottom-width: 2px;
    border-radius: 4px;
    background: var(--ns-kbd-bg);
    font: 700 10px/1.4 var(--ns-font);
    color: var(--ns-text-muted);
    text-align: center;
  }
  @media (pointer: coarse) {
    .ns-kbd { display: none; }
  }

  /* Uppercase tracked label, like techfest.org's nav ("ACCOMMODATION") */
  .ns-label {
    font-weight: 700;
    letter-spacing: var(--ns-label-ls);
    text-transform: uppercase;
  }

  /* Buttons (help, error, tag mode): uppercase tracked labels, 8 px corners */
  .ns-btn {
    min-height: var(--ns-target);
    padding: 0 var(--ns-space-4);
    border-radius: var(--ns-radius-sm);
    border: 1px solid var(--ns-border-strong);
    background: var(--ns-surface-hover);
    color: var(--ns-text);
    font-size: var(--ns-fs-sm);
    font-weight: 700;
    letter-spacing: var(--ns-label-ls);
    text-transform: uppercase;
    cursor: pointer;
  }
  /* Gold gradient with dark text and a soft gold glow, like the site's "Join now" */
  .ns-btn-primary {
    background: var(--ns-primary);
    border-color: transparent;
    color: var(--ns-on-accent);
    box-shadow: var(--ns-glow);
  }
  .ns-btn-danger { background: var(--ns-danger); border-color: transparent; color: var(--ns-on-fill); }
  .ns-btn-danger-soft { background: var(--ns-danger-soft); border-color: var(--ns-danger-border); color: var(--ns-danger-text); }
  @media (hover: hover) and (pointer: fine) {
    .ns-btn:hover { background: var(--ns-surface-hover-strong); color: var(--ns-sky); }
    .ns-btn-primary:hover { background: var(--ns-primary-hover); color: var(--ns-on-accent); box-shadow: var(--ns-glow-strong); }
    .ns-btn-danger:hover { background: var(--ns-danger-hover); color: var(--ns-on-fill); }
    .ns-btn-danger-soft:hover { background: var(--ns-danger-soft-hover); color: var(--ns-danger-text); }
  }

  /* Slanted button pairs, like the site's EXPLORE / REGISTER: the inner edges lean towards each other.
     clip-path would cut the outline, so these show focus as an inset ring instead. */
  .ns-slant-r { clip-path: polygon(0 0, 100% 0, calc(100% - var(--ns-slant)) 100%, 0 100%); padding-right: calc(var(--ns-space-4) + 4px); }
  .ns-slant-l { clip-path: polygon(var(--ns-slant) 0, 100% 0, 100% 100%, 0 100%); padding-left: calc(var(--ns-space-4) + 4px); }
  .ns-ui .ns-slant-r:focus-visible, .ns-ui .ns-slant-l:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--ns-focus);
  }

  /* Text inputs and selects: same focus treatment as the search box */
  .ns-input {
    min-height: var(--ns-target);
    width: 100%;
    background: var(--ns-input);
    border: 1px solid var(--ns-border-strong);
    color: var(--ns-text-strong);
    padding: 0 10px;
    border-radius: var(--ns-radius-sm);
    font-size: var(--ns-fs-md);
    outline: none;
    transition: border-color var(--ns-dur-fast) ease, box-shadow var(--ns-dur-fast) ease;
  }
  .ns-input::placeholder { color: var(--ns-text-subtle); }
  .ns-input option { background: var(--ns-input-solid); color: var(--ns-text-strong); }
  .ns-ui .ns-input:focus-visible {
    outline: none;
    border-color: var(--ns-accent);
    box-shadow: 0 0 0 3px var(--ns-accent-ring);
  }
  /* 16 px stops iOS Safari zooming into a focused field */
  @media (max-width: 760px), (pointer: coarse) {
    .ns-input { font-size: 16px; }
  }

  /* Modal dialogs (help, tag form, tag confirm) */
  .ns-scrim {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--ns-edge);
    background: var(--ns-scrim);
    pointer-events: auto;
    overscroll-behavior: contain;
    transition: opacity var(--ns-dur) var(--ns-ease-out), display var(--ns-dur) allow-discrete;
    @starting-style { opacity: 0; }
  }
  .ns-scrim.hidden { opacity: 0; transition-duration: var(--ns-dur-fast); }
  .ns-dialog {
    width: 100%;
    max-width: 400px;
    max-height: 100%;
    overflow-y: auto;
    background: var(--ns-surface-strong);
    border: 1px solid var(--ns-border);
    border-radius: var(--ns-radius-lg);
    padding: var(--ns-space-5);
    box-shadow: var(--ns-shadow);
    transition: scale var(--ns-dur) var(--ns-ease-out);
    @starting-style { scale: 0.97; }
  }
  /* Gold heading, like the site's section titles */
  .ns-dialog-title {
    margin: 0 0 var(--ns-space-4);
    font-size: var(--ns-fs-xl);
    font-weight: 700;
    letter-spacing: var(--ns-heading-ls);
    color: var(--ns-accent);
    text-wrap: balance;
    overflow-wrap: anywhere;
  }
  .ns-dialog-text {
    margin: calc(-1 * var(--ns-space-2)) 0 var(--ns-space-4);
    font-size: var(--ns-fs-md);
    line-height: 1.45;
    color: var(--ns-text-muted);
  }
  .ns-dialog-actions {
    display: flex;
    gap: var(--ns-space-2);
    margin-top: var(--ns-space-2);
  }
  .ns-dialog-actions .ns-btn { flex: 1; }
`;

/** Keeps Tab and Shift+Tab inside an open dialog. Call from the dialog's keydown handler. */
export function trapTab(container: HTMLElement, e: KeyboardEvent): void {
  if (e.key !== 'Tab') return;
  const focusables = Array.from(
    container.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')
  ).filter(el => !el.hasAttribute('disabled') && el.offsetParent !== null);
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/** Injects the shared token sheet once. Safe to call from every UI constructor. */
export function ensureTokens(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(TOKENS_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = TOKENS_STYLE_ID;
  style.textContent = TOKENS_CSS;
  document.head.appendChild(style);
}

/** Inline SVG icons, one 24-unit grid and 2 px stroke, so no emoji or font glyphs stand in for icons. */
const ICON_PATHS: Record<string, string> = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  map: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6"/><path d="M12 17h.01"/>',
  reset: '<path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v4h4"/>',
  volume: '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>',
  mute: '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="m17 9 4 6M21 9l-4 6"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="m13 7 4 4"/>',
  target: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  walk: '<path d="M5 12h12M13 6l6 6-6 6"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
};

export function icon(name: keyof typeof ICON_PATHS | string, size = 16): string {
  const paths = ICON_PATHS[name] ?? '';
  return `<svg class="ns-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
}
