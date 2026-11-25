import assert from 'node:assert/strict'
import test from 'node:test'
import { pushBack } from '../../src/renderer/ui/mobile/back.ts'

test('a host without a back handler never changes native focus', () => {
  const focus = []
  globalThis.window = { qqpet: { setFocusable: (on) => focus.push(on) } }

  const release = pushBack(() => {})
  try {
    assert.deepEqual(focus, [], 'opening a sheet must not call setFocusable without a back key')
  } finally {
    release()
  }
  assert.deepEqual(focus, [], 'closing it must not either')
  assert.equal(globalThis.window.__qqpetBack, undefined)
})

test('the Android back-key host still gets focus while a layer is open', () => {
  const focus = []
  const back = []
  globalThis.window = {
    qqpet: { setFocusable: (on) => focus.push(on) },
    __qqpetSetBackHandler: (on) => back.push(on),
  }

  const release = pushBack(() => {})
  assert.deepEqual(focus, [true])
  assert.deepEqual(back, [true])
  assert.equal(typeof globalThis.window.__qqpetBack, 'function')

  release()
  assert.deepEqual(focus, [true, false])
  assert.deepEqual(back, [true, false])
  assert.equal(globalThis.window.__qqpetBack, undefined)
})
