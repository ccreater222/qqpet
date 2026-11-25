import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Production uses bundler resolution; direct source imports need the extension here.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '../dom' && context.parentURL?.endsWith('/src/renderer/ui/mobile/sizing.ts')) {
      return nextResolve(new URL('../dom.ts', context.parentURL).href, context)
    }
    return nextResolve(specifier, context)
  },
})

// The phone-layout decision is a pure function so the whole client matrix can be
// pinned without a browser. `sizing.ts` snapshots `matchMedia` at import time;
// the DOM wrapper is checked separately against mutable window facts below.
globalThis.matchMedia = () => ({ matches: true })
const { phoneUIFrom, phoneUI } = await import('../../src/renderer/ui/mobile/sizing.ts')

const facts = (over = {}) => ({
  phoneLayout: true,
  desktopHost: false,
  touch: true,
  screenWidth: 412,
  screenHeight: 892,
  scale: 1,
  clientWidth: 412,
  ...over,
})

test('the phone layout capability matrix', () => {
  // Desktop fine pointer: no touch, and the desktop preload declares false.
  assert.equal(phoneUIFrom(facts({
    phoneLayout: false, desktopHost: true, touch: false,
    screenWidth: 1280, screenHeight: 800, clientWidth: 1280,
  })), false)

  // Desktop 2-in-1 / Windows tablet mode (960x600 CSS, coarse pointer): the
  // desktop preload exposes setDragging, so it must never get the phone UI.
  assert.equal(phoneUIFrom(facts({
    phoneLayout: false, desktopHost: true, touch: true,
    screenWidth: 960, screenHeight: 600, clientWidth: 960,
  })), false)

  // An old desktop preload without the new capability still loses to setDragging.
  assert.equal(phoneUIFrom(facts({
    phoneLayout: undefined, desktopHost: true, touch: true,
    screenWidth: 960, screenHeight: 600, clientWidth: 960,
  })), false)

  // Android phone: explicit capability + touch + 1 CSS px per dp.
  assert.equal(phoneUIFrom(facts()), true)

  // iOS phone keeps its existing phone UI, now declared explicitly by its bridge.
  assert.equal(phoneUIFrom(facts({ screenWidth: 390, screenHeight: 844, clientWidth: 390 })), true)

  // Android tablet: the page is zoomed, so even with the capability it is not 1:1.
  assert.equal(phoneUIFrom(facts({
    screenWidth: 800, screenHeight: 1280, scale: 1.667, clientWidth: 800,
  })), false)

  // Harmony declares false and keeps its 480 design space.
  assert.equal(phoneUIFrom(facts({
    phoneLayout: false, screenWidth: 360, screenHeight: 780, scale: 0.75, clientWidth: 480,
  })), false)

  // Undefined keeps the legacy heuristic for bridges that predate the capability.
  assert.equal(phoneUIFrom(facts({ phoneLayout: undefined })), true)

  // A true capability still needs the screen/touch facts.
  assert.equal(phoneUIFrom(facts({ touch: false })), false)
  assert.equal(phoneUIFrom(facts({ scale: 1.5 })), false)
})

test('phoneUI reads the host capability and the desktop setDragging marker from window.qqpet', () => {
  globalThis.screen = { width: 412, height: 892 }
  globalThis.document = { documentElement: { clientWidth: 412 } }
  globalThis.window = { visualViewport: { scale: 1 }, qqpet: { capabilities: { phoneLayout: true } } }

  assert.equal(phoneUI(), true, 'an Android-shaped window with the explicit capability opts in')
  globalThis.window.qqpet.capabilities.phoneLayout = false
  assert.equal(phoneUI(), false, 'an explicit false forbids the phone layout')
  globalThis.window.qqpet.capabilities.phoneLayout = true
  globalThis.window.qqpet.setDragging = async () => ({ x: 0, y: 0 })
  assert.equal(phoneUI(), false, 'a desktop host never gets the phone layout')
})
