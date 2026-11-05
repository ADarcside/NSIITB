/**
 * Phones: keep the page itself at 1x zoom.
 *
 * iOS Safari zooms the whole page on a quick double tap, a two-finger pinch, focusing a text box
 * under 16 px, and sometimes keeps that zoom across a portrait <-> landscape rotation. The 3D view
 * does its own look and move with touch, so page zoom only ever covers the HUD and needs a reload.
 *
 * - gesturestart / gesturechange (iOS pinch on the page) are cancelled everywhere
 * - double-tap zoom is turned off in CSS (touch-action: manipulation on the page, none on the
 *   3D view; see index.html), so quick taps on buttons still all count
 * - if a zoom slips through anyway (visualViewport.scale > 1), rewriting the viewport meta makes
 *   iOS snap back to 1x
 *
 * Laptops and desktops never call this.
 */

const VIEWPORT = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, viewport-fit=cover';

/** Snaps the page back to 1x if iOS left it zoomed in. */
export function resetPageZoom(): void {
  const vv = window.visualViewport;
  if (!vv || vv.scale <= 1.01) return;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta) return;
  // Changing the content (even briefly) is what makes iOS re-apply initial-scale
  meta.content = VIEWPORT.replace('initial-scale=1.0', 'initial-scale=0.99');
  requestAnimationFrame(() => {
    meta.content = VIEWPORT;
  });
}

export function preventPageZoom(): () => void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (meta) meta.content = VIEWPORT;

  const cancel = (e: Event) => e.preventDefault();
  // Two fingers moving on anything but the 3D view (which handles its own touches) = page pinch
  const onTouchMove = (e: TouchEvent) => {
    if (e.touches.length > 1 && e.cancelable && !(e.target instanceof HTMLCanvasElement)) e.preventDefault();
  };

  document.addEventListener('gesturestart', cancel, { passive: false });
  document.addEventListener('gesturechange', cancel, { passive: false });
  document.addEventListener('touchmove', onTouchMove, { passive: false });
  window.visualViewport?.addEventListener('resize', resetPageZoom);

  return () => {
    document.removeEventListener('gesturestart', cancel);
    document.removeEventListener('gesturechange', cancel);
    document.removeEventListener('touchmove', onTouchMove);
    window.visualViewport?.removeEventListener('resize', resetPageZoom);
  };
}
