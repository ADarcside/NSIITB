/**
 * Namma Space AR: the route card's AR button in the normal viewer (AR build spec, "Entry").
 * Registered by main.ts only in a VITE_AR=1 build and loaded on demand, so a normal build has no
 * AR button and no AR code. Tapping AR opens ar.html going to the route's place; Exit there comes
 * back to the same room and place.
 */

import type { ArGuide, RouteBus } from '../nav/active_route.js';
import { arUrlFromViewer } from './links.js';

interface XrLike {
  isSessionSupported(mode: string): Promise<boolean>;
}

export const arGuide: ArGuide = {
  async supported(): Promise<boolean> {
    const xr = (navigator as Navigator & { xr?: XrLike }).xr;
    if (!xr || !window.isSecureContext) return false;
    try {
      return await xr.isSessionSupported('immersive-ar');
    } catch {
      return false;
    }
  },
  async start(routes: RouteBus): Promise<void> {
    const to = routes.current?.to;
    if (!to) return;
    window.location.assign(arUrlFromViewer(window.location.href, to.poi_id));
  },
  stop(): void {
    // The AR page is a separate page, so there is nothing to stop here
  },
};
