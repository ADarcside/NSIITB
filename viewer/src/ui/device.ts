/**
 * The screen and input checks the viewer uses, in one place.
 * Keep these in step with the matching @media rules in the UI styles.
 */

/** Phone-sized screen: narrow portrait, or a short touch screen in landscape */
export const PHONE_QUERY = '(max-width: 760px), (pointer: coarse) and (max-height: 520px)';

/** Like PHONE_QUERY but touch only, so a narrow desktop window keeps the desktop HUD */
export const PHONE_TOUCH_QUERY = '(pointer: coarse) and (max-width: 760px), (pointer: coarse) and (max-height: 520px)';

/** Narrow screen only (the tag panel's bottom-sheet layout) */
export const NARROW_QUERY = '(max-width: 760px)';

/** A finger instead of a mouse: phones and tablets */
export const TOUCH_QUERY = '(pointer: coarse)';

export function matches(query: string): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(query).matches;
}

export const isPhone = (): boolean => matches(PHONE_QUERY);
export const isPhoneTouch = (): boolean => matches(PHONE_TOUCH_QUERY);
export const isTouchDevice = (): boolean => matches(TOUCH_QUERY);
