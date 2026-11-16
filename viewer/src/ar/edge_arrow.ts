/**
 * Namma Space AR: the arrow at the screen edge that points toward the next arrows or the place
 * when they are out of the camera view (AR build spec, "What is drawn in the camera view").
 * Pure maths, unit tested.
 *
 * Input is the target in normalised device coordinates (x right, y up, -1..1 on screen) plus
 * whether it is behind the camera. Output is where to put the arrow on screen, as fractions of
 * the screen size (0..1, y down like CSS), and its turn in degrees (0 points right, 90 down).
 */

/** The target counts as on screen inside this part of the view, so the arrow does not flicker at the very edge */
export const ON_SCREEN_NDC = 0.85;
/** Gap between the arrow and the screen edge, as a fraction of the screen */
export const EDGE_INSET = 0.08;

export interface EdgeArrow {
  /** Arrow centre, as fractions of the screen width and height (y down) */
  x: number;
  y: number;
  /** Turn in degrees: 0 points right, 90 down, 180 left, -90 up */
  angleDeg: number;
}

/** Where the edge arrow goes, or null when the target is in view. */
export function edgeArrow(ndcX: number, ndcY: number, behind: boolean): EdgeArrow | null {
  if (!behind && Math.abs(ndcX) <= ON_SCREEN_NDC && Math.abs(ndcY) <= ON_SCREEN_NDC) return null;
  // Behind the camera the projection is mirrored: flip it so the arrow points the right way.
  let dx = behind ? -ndcX : ndcX;
  let dy = behind ? -ndcY : ndcY;
  if (Math.hypot(dx, dy) < 1e-6) {
    // Straight behind: point down, the usual "turn around" cue
    dx = 0;
    dy = -1;
  }
  // Push the direction out to the edge of the inset box
  const lim = 1 - 2 * EDGE_INSET;
  const s = lim / Math.max(Math.abs(dx), Math.abs(dy));
  const ex = dx * s;
  const ey = dy * s;
  return {
    x: (ex + 1) / 2,
    y: (1 - ey) / 2,
    angleDeg: (Math.atan2(-dy, dx) * 180) / Math.PI,
  };
}
