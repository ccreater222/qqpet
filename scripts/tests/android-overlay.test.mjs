import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { nextBounds } from '../../src/mobile/bounds.ts'

const service = readFileSync(new URL('../../android/app/src/main/java/net/ankio/qqpet/PetService.kt', import.meta.url), 'utf8')
const setBounds = service.slice(service.indexOf('private fun setBounds('), service.indexOf('private fun http('))

// Android 10+ caps a NOT_TOUCHABLE system-alert window at alpha 0.8 (anti-clickjacking). The render
// window therefore lives in an attached-dialog child of a 1x1 overlay token host: that type is not a
// system-alert window and keeps alpha 1.0. The child is cropped to the visible rectangles; big resizes hide the
// WebView until the new frame is committed, because Chromium can show a white surface buffer during the resize.
test('the render window is a full-screen attached dialog of a 1x1 token host (no 0.8 alpha cap)', () => {
  assert.match(service, /wm\.addView\(host, hostParams\)/)
  assert.match(service, /host\.post \{ attachRenderWindow\(\) \}/)
  assert.match(service, /LayoutParams\.TYPE_APPLICATION_ATTACHED_DIALOG/)
  assert.match(service, /token = host\.windowToken/)
  assert.match(service, /alpha = 1f/)
  assert.match(service, /FLAG_NOT_TOUCHABLE/)
  // A ROM that refuses dialog children falls back to the overlay type, but says so instead of failing silently.
  assert.match(service, /attached dialog render window unavailable[\s\S]*TYPE_APPLICATION_OVERLAY/)
})

test('the render child is cropped to the visible rectangles (BLOCK_UNTRUSTED must not cover other apps)', () => {
  // A NOT_TOUCHABLE 1003 child still occludes untrusted windows below (BLOCK_UNTRUSTED); a full-screen one would
  // stop the launcher from receiving taps. The child therefore covers only the page's visible rectangles + 6 px,
  // and the WebView is translated by the window origin so the page itself never moves.
  assert.match(service, /private fun applyChildBounds\(boxes: List<Rect>\)/)
  assert.match(service, /private val childMargin = \d+/)
  assert.match(service, /web\.translationX = -next\.left\.toFloat\(\)/)
  assert.match(service, /private var childRect: Rect\?/)
  // The transient move may cover both frames, but a shrink must not union the old window back in.
  assert.match(service, /childWasEmpty/)
  assert.match(service, /BLOCK_UNTRUSTED/)
})

test('the render window no longer crops or shifts the page: setBounds is a no-op', () => {
  assert.match(service, /private fun setBounds\(x: Double, y: Double, w: Double, h: Double, viewport: Double\)/)
  assert.ok(setBounds.includes('No-op by design'))
  assert.doesNotMatch(setBounds, /web\.translation[XY]|wm\.updateViewLayout|params\.(width|height|x|y)\s*=/)
  assert.doesNotMatch(service, /private fun place\(/)
})

test('the render window follows the page during a drag; only the portals wait for ACTION_UP', () => {
  // Moving a portal window under the finger cuts its touch stream, but the render child is NOT_TOUCHABLE: it can
  // follow the page's full-page drag rectangle immediately, otherwise the pet leaves its old crop and disappears.
  const sync = service.slice(service.indexOf('private fun syncPortalsUnchecked'), service.indexOf('private fun mergeRects'))
  const apply = sync.indexOf('applyChildBounds(boxes)')
  const defer = sync.indexOf('touchActive.isNotEmpty()')
  assert.ok(apply >= 0 && defer >= 0, 'syncPortalsUnchecked must crop the child and defer portals')
  assert.ok(apply < defer, 'the child must be cropped before the touchActive early return')
})

test('a big render-window resize hides the child window until the WebView has drawn the new size (no white flash)', () => {
  // Hiding only the WebView is not enough: the white buffer belongs to the child window's own surface. The window
  // alpha goes to 0 across the resize, and is restored only after a committed frame + two WebView animation frames.
  assert.match(service, /private fun hideChildForResize\(/)
  assert.match(service, /private fun revealChildAfterResize\(/)
  assert.match(service, /p\.alpha = 0f/)
  assert.match(service, /REVEAL_DELAY_MS/)
  assert.match(service, /REVEAL_SHORT_MS/)
  assert.match(service, /HIDDEN_WATCHDOG_MS/)
  assert.match(service, /revealToken/)
  // bigResize must look at size only: a pet that walks across the screen must not hide the window every tick.
  const big = service.slice(service.indexOf('private fun bigResize('), service.indexOf('private fun hideChildForResize('))
  assert.match(big, /width\(\)|height\(\)/)
  assert.doesNotMatch(big, /\.left|\.top|\.x\b|\.y\b/)
})

const box = (left, top, right, bottom) => ({ left, top, right, bottom })

test('the window stays put while the animation draws a little wider or narrower (#18: left-right shaking)', () => {
  let cur = nextBounds({ x: 0, y: 0, w: 0, h: 0 }, box(200.4, 300.6, 346.2, 446.9), 400, 800)
  assert.deepEqual(cur, { x: 176, y: 276, w: 195, h: 195 })
  for (const need of [box(198, 302, 350, 440), box(205, 296, 340, 450), box(185, 290, 360, 460)]) {
    assert.deepEqual(nextBounds(cur, need, 400, 800), cur)
  }
})

test('content leaving the window or leaving it mostly empty moves it with a margin', () => {
  const cur = { x: 176, y: 276, w: 195, h: 195 }
  assert.deepEqual(nextBounds(cur, box(200, 300, 346, 480), 400, 800), { x: 176, y: 276, w: 194, h: 228 })
  assert.deepEqual(nextBounds(cur, box(260, 360, 300, 400), 400, 800), { x: 236, y: 336, w: 88, h: 88 })
})

test('page edges clamp the window; a full-page drag window shrinks back afterwards', () => {
  const full = nextBounds({ x: 0, y: 0, w: 0, h: 0 }, box(0, 0, 400, 800), 400, 800)
  assert.deepEqual(full, { x: 0, y: 0, w: 400, h: 800 })
  const edge = nextBounds({ x: 0, y: 0, w: 0, h: 0 }, box(300, 10, 420, 120), 400, 800)
  assert.deepEqual(edge, { x: 276, y: 0, w: 124, h: 144 })
  assert.deepEqual(nextBounds(edge, box(310, 0, 400, 118), 400, 800), edge)
  assert.deepEqual(nextBounds(full, box(200, 300, 346, 446), 400, 800), { x: 176, y: 276, w: 194, h: 194 })
})

test('nothing to show empties the window', () => {
  assert.deepEqual(nextBounds({ x: 5, y: 5, w: 50, h: 50 }, null, 400, 800), { x: 0, y: 0, w: 0, h: 0 })
  assert.deepEqual(nextBounds({ x: 5, y: 5, w: 50, h: 50 }, box(10, 10, 10, 30), 400, 800), { x: 0, y: 0, w: 0, h: 0 })
})

// ---- page-side touch region contract (Android overlay) -------------------------------------

const bridge = readFileSync(new URL('../../src/android/bridge.ts', import.meta.url), 'utf8')

test('the bridge exposes setHitShape only when the shell can restrict the touchable region', () => {
  // The optional native method is the capability probe; old APKs simply lack it.
  assert.match(bridge, /setTouchableRegion\?\(rects: string, viewport: number\): void/)
  assert.match(bridge, /const setTouchableRegion = typeof native\.setTouchableRegion === 'function'/)
  // Degradation: an old shell gets no setHitShape at all, so its window stays fully touchable as before.
  assert.match(
    bridge,
    /\.\.\.\(setTouchableRegion === null \? \{\} : \{ setHitShape: \(rects: ShapeRect\[\]\) => setTouchableRegion\(JSON\.stringify\(rects\), innerWidth\) \}\)/,
  )
  assert.equal((bridge.match(/\bsetHitShape:/g) ?? []).length, 1, 'setHitShape must live only in the guarded spread')
  // JSON rects are CSS px of the page, which the native side scales to the window.
  assert.match(bridge, /JSON\.stringify\(rects\), innerWidth/)
})

test('the touch region does not change the window bounds contract', () => {
  // setBounds keeps its signature and its job: the visual crop of the page.
  assert.match(service, /private fun setBounds\(x: Double, y: Double, w: Double, h: Double, viewport: Double\)/)
  assert.match(service, /fun setBounds\(x: Double, y: Double, w: Double, h: Double, viewport: Double\) = web\.post/)
})

test('the native side forwards touches through overlay portals once landed', t => {
  if (!service.includes('dispatchTouchEvent')) {
    // The native change is a separate workstream; the page contract above covers the degradation path.
    t.skip('PetService.kt has no touch portal forwarding yet')
    return
  }
  // Stable contract only: the JS entry the page calls, a render window that takes no touches itself, and the
  // forwarded stream. Private fields and method names are free to change.
  assert.match(service, /@JavascriptInterface\s+fun setTouchableRegion\(rects: String, viewport: Double\)/)
  assert.match(service, /FLAG_NOT_TOUCHABLE/)
  assert.match(service, /dispatchTouchEvent/)
})
