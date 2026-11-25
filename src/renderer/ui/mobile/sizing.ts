// Phone mode: the page is laid out in density-independent pixels, so a length
// written in CSS pixels is the physical size a finger needs. Android's web view
// serves phones with `initial-scale=1` (AssetClient.kt); tablets keep the old
// 480-px design space, where desktop-sized UI is still proportioned. A host
// that knows its own layout strategy declares it through `capabilities.phoneLayout`:
// false forbids the phone UI, true allows it, and undefined keeps the legacy
// viewport heuristic for bridges that predate the flag. The screen test remains
// after the capability because even a phone-capable host must really be one CSS
// pixel per dp; a desktop preload additionally exposes `setDragging`.
import { touch } from '../dom'

/** Below this screen short side (dp) the page is a phone, not a tablet. */
const PHONE_MAX = 600

/** Everything the phone-layout decision reads, pure data so every client row is unit-testable. */
export interface PhoneUIFacts {
  /** Host capability bit: false forbids the phone layout, undefined keeps the legacy heuristic. */
  phoneLayout?: boolean
  /** Desktop preloads expose `setDragging` on every platform; those hosts never get the phone layout. */
  desktopHost: boolean
  touch: boolean
  screenWidth: number
  screenHeight: number
  scale: number
  clientWidth: number
}

/** A touch screen narrow enough to be a phone, with the page laid out at 1 CSS px = 1 dp. */
export const phoneUIFrom = (facts: PhoneUIFacts): boolean => {
  if (facts.phoneLayout === false) return false
  if (facts.desktopHost) return false
  return facts.touch
    && Math.min(facts.screenWidth, facts.screenHeight) <= PHONE_MAX
    && Math.abs(facts.scale - 1) < 0.02
    && (Math.abs(facts.clientWidth - facts.screenWidth) <= 2 || Math.abs(facts.clientWidth - facts.screenHeight) <= 2)
}

/** Whether this host renders the phone UI; reads the bridge capability and the real viewport. */
export const phoneUI = (): boolean => phoneUIFrom({
  phoneLayout: window.qqpet?.capabilities?.phoneLayout,
  desktopHost: typeof window.qqpet?.setDragging === 'function',
  touch,
  screenWidth: screen.width,
  screenHeight: screen.height,
  scale: window.visualViewport?.scale ?? 1,
  clientWidth: document.documentElement.clientWidth,
})

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
