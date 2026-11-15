# Viewer UI audit (Round 2)

Date: 1 Nov 2026. Scope: `viewer/src/ui/*.ts`, `viewer/src/nav/route_view.ts`, `viewer/index.html`.

How it was done:

- **Web Interface Guidelines** (vercel-labs `web-design-guidelines` skill, rules fetched fresh from `vercel-labs/web-interface-guidelines/command.md`), checked line by line.
- **Impeccable audit** (`pbakaus/impeccable` 4.8.0, `reference/audit.md`). Its detector found 0 issues on the source files (regex rules only for `.ts`) and 0 on the rendered page, so every finding below was checked by hand.
- **Screenshots** with Playwright CLI and GPU Chrome (RTX 5050, ANGLE D3D11) at 1440x900 and 390x844 (touch, coarse pointer), on a synthetic 4x4 m test room with 7 POIs. The K-720 splat was not available on this machine.

Line numbers refer to the code before this pass (commit `7bad621`).

## Impeccable health score: 9/20 (Poor)

| Dimension | Score | Key finding |
|---|---|---|
| Accessibility | 2 | No focus styles, zoom disabled, small text below 4.5:1 contrast |
| Performance | 3 | Minimap grid cached once; label `transition: transform` fights the per-frame transform |
| Theming | 1 | About 40 hard-coded colours, 7 radii and 5 copies of the font stack across 5 files |
| Responsive | 1 | The phone HUD is unusable, and the cards and minimap overlap |
| Implementation integrity | 2 | Coherent dark-glass look, but each file styles itself separately |

## P0: blocking

- **Phone HUD is unusable.** The seven top-right buttons wrap into two-line chips that sit under the full-width search bar ("F 0", "Free roam", "(R)"). Locations: `app_ui.ts:395-403`, `nav_ui.ts:818-824`.
- **Phone cards collide.** The minimap (bottom-right) covers the POI card's **Look** button, and the route card (bottom-centre) is hidden behind the POI card. Locations: `nav_ui.ts:657, 715`, `minimap.ts:419-446`.

## P1: major

- `index.html:5`: `user-scalable=no` disables pinch-zoom (WCAG 1.4.4).
- **No visible keyboard focus** on any button. `outline: none` without a ring replacement at `nav_ui.ts:601` and `tag_ui.ts:756`.
- **Touch targets under 44 px on phones**: close buttons ✕ (`nav_ui.ts:680, 743`, about 22 px), **Take me there** (`nav_ui.ts:695`, about 22 px tall), HUD buttons (about 30 px), tag row actions (`tag_ui.ts:651`, 26 px), minimap POI hit radius 12 px (`minimap.ts:396`).
- **Contrast**: `#64748b` text at 10-11 px on slate-900 is about 3.7:1, below 4.5:1. Affects the result category (`nav_ui.ts:644`), aliases (`nav_ui.ts:783`) and tag coordinates (`tag_ui.ts:636`).
- **POI labels lag the camera.** `route_view.ts:475` sets `transition: transform 0.15s` on pills whose transform is written every frame, so labels trail behind when you turn. The hover `scale(1.05)` (`:484`) never applies because the inline transform wins.
- **No `prefers-reduced-motion` anywhere.** Affects the ribbon grow, ring pulse, dash scroll (`route_view.ts:301-328`) and all CSS transitions.
- **Route status is not announced.** "You've arrived", "blocked" and the tag toasts have no `aria-live` (`nav_ui.ts:100-104`, `tag_ui.ts:492`).
- **Desktop tag mode**: the Places panel (`tag_ui.ts:520-525`) overlaps the 360 px minimap (`minimap.ts:306`).

## P2: minor

- **No shared tokens.** Colours, radii (4/6/8/10/12/20/9999 px), spacing and the font stack are repeated in each `_injectStyles()`.
- **Cards and lists pop in.** `.hidden { display: none }` with no enter or exit transition on the POI card, route card or results.
- **Search combobox semantics.** The input has no `aria-expanded`, `aria-controls` or `aria-activedescendant`, and the rows are `div`s (`nav_ui.ts:83-95, 511`). Keyboard arrows do work.
- **Help overlay** has no `role="dialog"`, Esc doesn't close it, and focus isn't moved into it (`app_ui.ts:235-268`).
- **Emoji used as icons** (🔇 🔉 ✎ ⌖ 🗑) render differently on each OS (`app_ui.ts:306`, `tag_ui.ts:433-467`).
- **Progress bar animates `width`**, a layout property (`app_ui.ts:475`).
- **Missing page setup**: no safe-area insets for notched phones, no `color-scheme: dark` or `theme-color`, and no favicon (a 404 on every load) in `index.html`.

## P3: polish

- "Loading scene assets..." should use `…` (`app_ui.ts:200, 313`). The search placeholder should end in `…`, and the "(/)" hint means nothing on a phone.
- FPS and distances need `tabular-nums` so the badges don't jitter in width.

## What already works

- User text goes through `escapeHtml` or `textContent`. Icon buttons have `aria-label`s.
- Search has full keyboard control (`/`, arrows, Enter, Esc). Shortcuts are skipped while typing.
- The minimap renders the grid once to an offscreen canvas. FPS is measured, not asserted.
- `pointer: coarse` rules already exist for search rows (44 px).

## Fixed in this pass

The `ui:` commits after this audit fix the following:

- **All P0 and P1 items.**
  - The phone HUD is one scrollable icon row under the search bar.
  - The cards share one bottom stack on narrow screens, and the minimap moves top-right.
  - Pinch-zoom works again.
  - Focus rings use `:focus-visible`, and touch targets are 44 px.
  - Muted text is `#b4c0d0`.
  - Labels no longer lag the camera.
  - Reduced motion is respected everywhere.
  - Route status and toasts use `aria-live`.
  - The tag panel stops above the minimap.
- **These P2 items.**
  - Shared tokens in `viewer/src/ui/tokens.ts`.
  - Eased card, list and overlay transitions (150-250 ms, none under reduced motion).
  - Search combobox ARIA.
  - The help dialog (Esc closes it, focus moves in and back out).
  - SVG icons replace the emoji.
  - The progress bar animates `transform`.
  - Safe areas, `color-scheme`, `theme-color` and an inline favicon.
- **The P3 items.** The ellipsis, the `…` placeholder and tabular numerals.

Still open:

- Button copy is not in Title Case. The existing wording was kept on purpose.
- ~~In tag mode on a phone, the Places sheet can overlap an open POI card.~~ Fixed in the tag-mode pass. The sheet drops to its header while a POI or route card is open, and the cards sit above it via `--ns-sheet-h`. Delete and Clear draft use an in-page dialog instead of `window.confirm`.
- Everything was checked on the synthetic test room, not on K-720.

After the fixes, Impeccable's detector reports 0 findings on the rendered page. It first flagged a radial-gradient glow on the new loading screen, which was removed.

## Loading screen reference (techfest.org)

I looked at techfest.org on 1 Nov 2026 with Playwright CLI and GPU Chrome, at 1440x900 and 390x844 (intro frames at 0.3, 1.2 and 2.5 s, the hero, and three scroll positions). Colours marked *computed* come from the page's computed styles. The rest are 5x5 px averages sampled from the screenshots.

- **Dark, cinematic base.** The page background is near-black `#0a0a0c` (computed). Full-bleed video backdrops in dusk tones sit over it: indigo `#2d314a` at the top, plum haze `#392329`, and a warm sunset `#fabd74` near the horizon. The hero video is heavily depth-of-field blurred, so the UI stays readable.
- **The intro is a symmetric, glowing kaleidoscope.** Mirrored mechanical shapes in amber `#e9822e` and gold glow `#c5972d` around a bright core resolve into the hero. The motion is slow and atmospheric, not snappy.
- **Gold is the accent.** Section headings and the primary "Join now" pill are gold `#ffd700` (computed), with dark `#0a0a0c` text on the pill. Card frames are a softer metallic gold, about `#f8d169`, with a faint glow.
- **Chamfered sci-fi frames.** Cards and the top nav use clipped 45° corners, notched metal borders and small cyan corner lights. That cyan was too small to sample cleanly, so I matched it to our `#7dd3fc` focus colour.
- **Glass rails.** The side navigation and the Sign in button are translucent navy `rgba(15, 25, 45, 0.65)` (computed button background) with blur and a thin light border.
- **Type.** Space Grotesk (computed), a geometric grotesque. Headings are bold 700 with a small positive tracking (0.8 px). Nav labels and the "SCROLL" cue are uppercase with wide letter-spacing.
- **Motion on scroll.** Cards fade in from blurred and transparent to sharp, and a thin vertical line under "SCROLL" invites you down.

**What the loading screen takes from this:** the near-black dusk with a linear amber horizon (no radial glow), gold for the progress and accents, a symmetric inline-SVG "gate" whose chamfered frame traces the measured download, a chamfered glass panel with cyan corner ticks, wide-tracked caps labels, and a blur-and-fade dissolve into the 3D view.

**What it doesn't use:** Techfest's logo, wordmark, mascot, images, video, font files or code. Nothing is loaded from techfest.org. The type is the system sans (`--ns-font`), because Space Grotesk would need a font download.

## Techfest sibling theme

Measured on techfest.org (home page and `/competitions`) on 1 Nov 2026 with Playwright CLI and GPU Chrome, at 1440x900 and 390x844. All values come from `getComputedStyle`, apart from the dusk colours, which were sampled from screenshots (see the section above).

**Colours**

| Role | Value | Where on the site |
|---|---|---|
| Page background | `#0a0a0c` | `html`, `body` |
| Inner-page background | `#0d0603` | `/competitions` body |
| Surface (glass) | `rgba(10, 15, 30, 0.6)` + `blur(20px)` | side rails |
| Border | `1px rgba(150, 200, 255, 0.15)` | side rails |
| Shadow | `0 10px 40px rgba(0, 0, 0, 0.6)` | side rails |
| Text | `#ffffff` | nav labels, body copy |
| Accent | `#ffd700` | section headings |
| Primary button | `linear-gradient(90deg, #ffd700, #ffaa00)`, text `#0a0a0c`, glow `0 4px 15px rgba(255, 215, 0, 0.3)` | "Join now" |
| Secondary fill | `#b53b26` | EXPLORE / REGISTER, prize box |
| Hover | `#6fc4f2` (text colour) | side-rail items |
| Badge | `#ffe600`, weight 900 | "FESTIVE DISCOUNT" |
| Muted accent | `#e0b48a` | `/competitions` details |

**Type**

| Use | Family | Size / weight / tracking / case |
|---|---|---|
| Body | Space Grotesk | 12.8 px, 400 |
| Headings | Space Grotesk | 18.4 px, 700, 0.8 px, gold |
| Nav labels | Space Grotesk | 15 px, 700, 1.44 px, uppercase |
| Rail labels | Space Grotesk | 10 px, 400, 0.5 px, capitalised |
| Primary button | Space Grotesk | 13.6 px, 700 |
| Inner-page title | Bleeding_Cowboys | 115 px, 700, 11.5 px (0.1 em), uppercase |

**Shapes and motion**

- Buttons have 8 px corners and rails 12 px.
- EXPLORE / REGISTER are slanted pairs: `clip-path: polygon(0 0, 100% 0, 80% 100%, 0 100%)` and its mirror.
- The nav strip and card frames use chamfered, notched gold frames.
- Hover scales buttons to 1.05 over 0.2 s, and rail items fade to sky blue over 0.3 s.

**How the viewer follows it.** Everything lives in `viewer/src/ui/tokens.ts`: the `--ns-*` variables, plus a `THEME` object for the minimap canvas, the route ribbon and the WebGL clear colour.

- **Colours:**
  - page `#0a0a0c`, used by `index.html`, `theme-color`, the renderer clear colour and the loading screen
  - navy glass with the pale-blue hairline
  - gold gradient primary buttons with dark text and a gold glow
  - rust `#b53b26` for danger
  - sky `#6fc4f2` for hover and focus. This is the site's own blue, and the only blue left.
  - `#ffe600` TAG MODE badge
  - copper category tags
- **Type:** Space Grotesk throughout, with gold headings and uppercase tracked labels.
- **Shapes:** slanted Navigate / Look and Export / Clear pairs, and a gold route on both the floor and the minimap.

Deliberate differences from the site:

- Panels are more opaque (0.74 and 0.93 instead of 0.6), to keep AA contrast over a bright 3D scene.
- The blur is 10 px instead of 20 px. That held FPS within budget in an interleaved A/B at 6x CPU throttle (−1.6 fps).
- Transitions are 150-250 ms, and none with reduced motion.

**Fonts**

| Font | Licence | Use here | Source |
|---|---|---|---|
| Space Grotesk | SIL OFL 1.1 | All viewer UI. Self-hosted latin woff2 in `viewer/src/assets/fonts/`, bundled by Vite. | github.com/floriankarsten/space-grotesk, woff2 downloaded from Google Fonts |
| Bleeding_Cowboys | Not OFL. It circulates as a freeware display font with no open licence I could verify. | Not used | — |
| Rye | SIL OFL 1.1 (Reserved Font Name "Rye") | Closest OFL substitute for the site's western display face. Used only for the loading-screen room name, unmodified. | github.com/google/fonts/tree/main/ofl/rye |

Nothing is loaded from techfest.org or Google Fonts at runtime, and no Techfest logo, wordmark, mascot, image, video or code is used.
