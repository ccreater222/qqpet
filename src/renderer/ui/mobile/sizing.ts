// Phone mode: the page is laid out in density-independent pixels, so a length
// written in CSS pixels is the physical size a finger needs. Android's web view
// serves phones with `initial-scale=1` (AssetClient.kt); tablets keep the old
// 480-px design space, where desktop-sized UI is still proportioned. The test
// below is empirical instead of a host flag: it only turns on when the layout
// really is one CSS pixel per dp, so a shell that still zooms the page (or a
// future host that does) keeps the desktop sizes instead of getting them shrunk.
import { touch } from '../dom'

/** Below this screen short side (dp) the page is a phone, not a tablet. */
const PHONE_MAX = 600

/** CSS pixels the page really is laid out in; the screen's own width in dp. */
const laidOutInDp = (): boolean => {
  const width = document.documentElement.clientWidth
  return Math.abs(width - screen.width) <= 2 || Math.abs(width - screen.height) <= 2
}

/** A touch screen narrow enough to be a phone, with the page laid out at 1 CSS px = 1 dp. */
export const phoneUI = (): boolean =>
  touch
  && Math.min(screen.width, screen.height) <= PHONE_MAX
  && Math.abs((window.visualViewport?.scale ?? 1) - 1) < 0.02
  && laidOutInDp()

/** Turns on the phone stylesheet. Idempotent; other hosts and the desktop are untouched. */
export const applyPhoneClass = (): boolean => {
  const on = phoneUI()
  document.body.classList.toggle('qp-phone', on)
  return on
}

/** A system bar or cutout inset, in CSS pixels, as the Android bridge reports it. */
export const safeInset = (side: 'top' | 'right' | 'bottom' | 'left'): number => {
  const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(`--safe-${side}`))
  return Number.isFinite(value) ? value : 0
}

/** The part of the page a finger can reach: the visual viewport inside the system bars. */
export const phoneViewport = (): { left: number; top: number; width: number; height: number } => {
  const vv = window.visualViewport
  return {
    left: safeInset('left'),
    top: safeInset('top'),
    width: (vv?.width ?? innerWidth) - safeInset('left') - safeInset('right'),
    height: (vv?.height ?? innerHeight) - safeInset('top') - safeInset('bottom'),
  }
}
