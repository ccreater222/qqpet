// The back key, shared by everything modal on a phone. A sheet and a framed panel
// can be open at once (a confirmation over the menu), so the host gets one handler
// that always closes the topmost layer instead of whichever layer registered last.
// The Android web view asks for this through `setBackHandler` (PetService.kt); the
// desktop and the other mobile hosts never define it, so their panels keep the old
// behaviour of closing by the close button or the backdrop.

type Handler = () => void

const stack: Handler[] = []

/** Makes the layer focusable so the host routes the back key here; releases it with the last layer. */
const sync = (): void => {
  const open = stack.length > 0
  window.__qqpetSetBackHandler?.(open)
  if (!open) {
    window.__qqpetBack = undefined
    window.qqpet.setFocusable(false)
    return
  }
  window.__qqpetBack = () => stack[stack.length - 1]?.()
}

/** Registers a layer that closes on the back key; returns the matching release. */
export function pushBack(close: Handler): () => void {
  const wasOpen = stack.length > 0
  stack.push(close)
  if (!wasOpen) window.qqpet.setFocusable(true)
  sync()
  let released = false
  return () => {
    if (released) return
    released = true
    const at = stack.indexOf(close)
    if (at >= 0) stack.splice(at, 1)
    sync()
  }
}

/** Whether any layer wants the back key (tests and diagnostics). */
export const backLayers = (): number => stack.length
