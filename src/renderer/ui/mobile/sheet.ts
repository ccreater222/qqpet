// A phone panel: a bottom sheet with a title, a close button and a scrolling
// body. Panels used to be 190-300 px desktop windows floating in the middle of
// the screen; at 1 CSS px = 1 dp those are unreadable and unreachable one-handed.
// Everything a thumb needs to reach lives at the bottom of the screen, and the
// sheet keeps clear of the system bars through the native safe insets.
import { div } from '../dom'
import { pushBack } from './back'
import { safeInset } from './sizing'
import './mobile.css'

export interface SheetOptions {
  title: string
  /** Scrolls when it does not fit. */
  body: HTMLElement
  /** Pinned under the body, e.g. a primary button. */
  footer?: HTMLElement
  /** Extra class on the card, so a surface can style its own content. */
  cardClass?: string
  /** Called once, however the sheet was closed. */
  onClose?: () => void
}

export interface SheetHandle {
  /** The whole layer, backdrop included. */
  el: HTMLElement
  card: HTMLElement
  body: HTMLElement
  title: HTMLElement
  close(): void
}

interface Open {
  handle: SheetHandle
  remove(): void
  onClose?: () => void
}

const stack: Open[] = []
const CLOSE_MS = 180
/** A downward drag this far closes the sheet; a shorter one springs back. */
const DISMISS_PX = 96

const syncBody = (): void => {
  document.body.classList.toggle('qp-sheet-open', stack.length > 0)
}

/** Whether a sheet is on screen; the pet stops reacting while one is open. */
export const sheetOpen = (): boolean => stack.length > 0
export const topSheet = (): SheetHandle | null => (stack.length ? stack[stack.length - 1]!.handle : null)


/** Closes the topmost sheet; false when there was none. */
export const closeTopSheet = (): boolean => {
  if (!stack.length) return false
  stack[stack.length - 1]!.handle.close()
  return true
}

export function openSheet(options: SheetOptions): SheetHandle {
  const title = div('qp-sheet-title', options.title)
  const closeButton = div('qp-sheet-close', '✕')
  closeButton.setAttribute('role', 'button')
  closeButton.setAttribute('aria-label', '关闭')
  const head = div('qp-sheet-head', div('qp-sheet-grip'), title, closeButton)
  const body = div('qp-sheet-body')
  body.append(options.body)
  const card = div(options.cardClass ? `qp-sheet-card ${options.cardClass}` : 'qp-sheet-card', head, body)
  if (options.footer) card.append(options.footer)
  const backdrop = div('qp-sheet-backdrop')
  const el = div('qp-sheet', backdrop, card)
  el.dataset.hit = ''
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-modal', 'true')
  el.setAttribute('aria-label', options.title)
  card.style.paddingBottom = `${safeInset('bottom')}px`

  let closed = false
  let remove = (): void => {}
  const handle: SheetHandle = { el, card, body, title, close: () => close() }

  const close = (): void => {
    if (closed) return
    closed = true
    const at = stack.findIndex((o) => o.handle === handle)
    if (at >= 0) stack.splice(at, 1)
    syncBody()
    el.classList.add('qp-closing')
    setTimeout(() => {
      remove()
      options.onClose?.()
    }, CLOSE_MS)
  }

  closeButton.addEventListener('click', () => close())
  // A backdrop tap closes, but only when the same gesture both started and ended
  // outside the card: a drag that overshoots the card must not dismiss it.
  let pressedBackdrop = false
  backdrop.addEventListener('pointerdown', () => (pressedBackdrop = true))
  backdrop.addEventListener('pointercancel', () => (pressedBackdrop = false))
  backdrop.addEventListener('pointerup', () => {
    if (pressedBackdrop) close()
    pressedBackdrop = false
  })

  // Drag the head down to dismiss, the gesture a phone user already knows.
  let startY: number | null = null
  let moved = 0
  head.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse') return
    startY = event.clientY
    moved = 0
    head.setPointerCapture(event.pointerId)
  })
  head.addEventListener('pointermove', (event) => {
    if (startY === null) return
    moved = Math.max(0, event.clientY - startY)
    card.style.transform = `translateY(${moved}px)`
    backdrop.style.opacity = String(Math.max(0, 1 - moved / 320))
  })
  const release = (): void => {
    if (startY === null) return
    startY = null
    card.style.transform = ''
    backdrop.style.opacity = ''
    if (moved > DISMISS_PX) close()
    moved = 0
  }
  head.addEventListener('pointerup', release)
  head.addEventListener('pointercancel', release)
  // Focus the sheet so the back gesture and the keyboard target it, not the page.
  card.tabIndex = -1
  requestAnimationFrame(() => card.focus({ preventScroll: true }))

  // Sit in the visible viewport, not the layout one: the keyboard shrinks the
  // visual viewport and a sheet pinned to the layout bottom would be behind it.
  const fitVisible = (): void => {
    const vv = window.visualViewport
    if (!vv) return
    el.style.top = `${vv.offsetTop}px`
    el.style.left = `${vv.offsetLeft}px`
    // Rounded down: a fractional visual viewport (412.19 dp) must not leave the card a sliver wider than the page.
    el.style.width = `${Math.floor(vv.width)}px`
    el.style.height = `${vv.height}px`
  }
  fitVisible()
  window.visualViewport?.addEventListener('resize', fitVisible)
  window.visualViewport?.addEventListener('scroll', fitVisible)

  // The phone host hands the back key to the page while a sheet is up (PetService.kt);
  // the shared stack keeps the topmost layer closing first when panels stack.
  const releaseBack = pushBack(close)

  document.body.append(el)
  remove = (): void => {
    window.visualViewport?.removeEventListener('resize', fitVisible)
    window.visualViewport?.removeEventListener('scroll', fitVisible)
    el.remove()
    releaseBack()
  }
  stack.push({ handle, remove, onClose: options.onClose })
  syncBody()
  return handle
}
