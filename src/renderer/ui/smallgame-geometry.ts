/**
 * paopao2 (吹泡泡) picks its bubble/movement candidates from the desktop margins hard-coded
 * into MainWindow.checkScreenPosition() — resources/pet/smallGamec1/p/cn/allet/qqpet/desktop/
 * chuipaopao/core/MainWindow.as:94-109: x<200 blocks left, y<200 blocks up, x>W-300-50 blocks
 * right, y>H-300-65 blocks down. On a phone-sized viewport those bands cover almost the whole
 * screen (412 wide: left ⇔ x<200, right ⇔ x>62), so the candidate list collapses.
 *
 * The deployed SWF only swaps Capabilities.screenResolution for API.GetScreenWidth/Height; the
 * four constants stay in the binary. This module therefore simulates a desktop-sized game area
 * on the host side for the paopao2 root window: the SWF sees virtual coordinates and a virtual
 * screen, while the real root stays clamped inside the viewport and every child window keeps
 * real coordinates. No SWF binary is modified.
 */

/** Every main_*.swf stage is 140×140. */
const MAIN = 140
/** Desktop margins from MainWindow.as: left 200, right 300+50, up 200, down 300+65. */
const DESKTOP_LEFT = 200
const DESKTOP_RIGHT = 350
const DESKTOP_BOTTOM = 365
/** Keep a clamped phone root this far from the bezel, so the SWF's edges sit at the real edges. */
const EDGE = 20

export interface PaopaoGameArea {
  /** Added to the root's real x/y to get the coordinates its SWF sees. */
  offset: number
  /** Virtual screen width/height reported to the mapped root. */
  width: number
  height: number
}

/**
 * The virtual game area for a viewport that cannot fit the desktop margins, or null when the
 * real viewport is already large enough (desktop and large tablets keep real coordinates).
 *
 * The root is clamped to [0, viewport-MAIN], so its virtual position spans
 * [offset, viewport-MAIN+offset]. With offset 180 the left/top 200 margins trigger only within
 * 20 px of the real edge, and the virtual screen extends far enough that the right/bottom
 * margins do the same:
 *   width  = offset + (viewportWidth - MAIN - EDGE) + DESKTOP_RIGHT
 *   height = offset + (viewportHeight - MAIN - EDGE) + DESKTOP_BOTTOM
 */
export function paopaoGameArea(viewportWidth: number, viewportHeight: number): PaopaoGameArea | null {
  if (viewportWidth >= DESKTOP_LEFT + DESKTOP_RIGHT + MAIN && viewportHeight >= DESKTOP_LEFT + DESKTOP_BOTTOM + MAIN) {
    return null
  }
  const offset = DESKTOP_LEFT - EDGE
  return {
    offset,
    width: viewportWidth + DESKTOP_RIGHT + offset - (MAIN + EDGE),
    height: viewportHeight + DESKTOP_BOTTOM + offset - (MAIN + EDGE),
  }
}

/** Clamp a window into the viewport; a window larger than the viewport pins to the top-left. */
export function clampRoot(
  x: number,
  y: number,
  w: number,
  h: number,
  viewportWidth: number,
  viewportHeight: number,
): { x: number; y: number } {
  return {
    x: Math.min(Math.max(x, 0), Math.max(0, viewportWidth - w)),
    y: Math.min(Math.max(y, 0), Math.max(0, viewportHeight - h)),
  }
}
