import assert from 'node:assert/strict'
import test from 'node:test'

const { settleCartLines } = await import('../../src/renderer/ui/shop-cart.ts')

test('cart settle: every accepted line leaves the cart', () => {
  const lines = [{ key: 'food-1' }, { key: 'clean-2' }]
  const result = settleCartLines(lines, [
    { key: 'food-1', ok: true },
    { key: 'clean-2', ok: true },
  ])
  assert.deepEqual(result.remaining, [])
  assert.equal(result.allOk, true)
})

test('cart settle: rejected lines stay and keep their original order', () => {
  const lines = [{ key: 'food-1' }, { key: 'clean-2' }, { key: 'toy-3' }]
  const result = settleCartLines(lines, [
    { key: 'food-1', ok: true },
    { key: 'clean-2', ok: false },
    { key: 'toy-3', ok: false },
  ])
  assert.deepEqual(result.remaining, [{ key: 'clean-2' }, { key: 'toy-3' }])
  assert.equal(result.allOk, false)
})

test('cart settle: a line missing from the outcome counts as failed and stays', () => {
  const lines = [{ key: 'food-1' }, { key: 'clean-2' }]
  const result = settleCartLines(lines, [{ key: 'food-1', ok: true }])
  assert.deepEqual(result.remaining, [{ key: 'clean-2' }])
  assert.equal(result.allOk, false)
})

test('cart settle: no settlement at all keeps every line', () => {
  const lines = [{ key: 'food-1' }]
  const result = settleCartLines(lines, [])
  assert.deepEqual(result.remaining, [{ key: 'food-1' }])
  assert.equal(result.allOk, false)
})

test('cart settle: line payload survives the filter untouched', () => {
  const lines = [{ key: 'food-1', good: { id: 'food-1', name: '鱼' }, n: 2 }]
  const result = settleCartLines(lines, [{ key: 'food-1', ok: true }])
  assert.deepEqual(result.remaining, [])
  const kept = settleCartLines(lines, [{ key: 'food-1', ok: false }])
  assert.equal(kept.remaining[0], lines[0])
})
