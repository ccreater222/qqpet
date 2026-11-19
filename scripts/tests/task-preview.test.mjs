import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Renderer sources use bundler-style extensionless imports and goods.ts imports
// goods.json bare (the bundler adds the JSON module type). Teach the test runner
// both so the module under test needs no test-only import syntax.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL && context.parentURL.includes('/src/renderer/') &&
        /\.[cm]?[jt]s$/.test(specifier) === false && specifier.endsWith('.json') === false) {
      return nextResolve(specifier + '.ts', context)
    }
    if (specifier.endsWith('.json') && context.parentURL) {
      return { url: new URL(specifier, context.parentURL).href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.json')) {
      return { format: 'module', source: 'export default ' + readFileSync(new URL(url), 'utf8'), shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const { previewTaskGoods } = await import('../../src/renderer/pet/task-preview.ts')

function looted(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: 'loot-' + String(index), name: 'loot', type: 'food', url: '', num: 1,
  }))
}

test('projection mode shows only fixed rewards and never draws locally', () => {
  let calls = 0
  const goods = previewTaskGoods({ reroll: 2, good: ['_yb*10'] }, {
    projectionMode: true,
    loot: count => {
      calls++
      return looted(count)
    },
  })
  assert.equal(calls, 0)
  assert.deepEqual(goods.map(good => [good.id, good.num]), [['yb', 10]])
})

test('legacy mode keeps looted goods first and fixed rewards after them', () => {
  const goods = previewTaskGoods({ reroll: 2, good: ['_yb*10'] }, {
    projectionMode: false,
    loot: count => {
      assert.equal(count, 2)
      return looted(count)
    },
  })
  assert.deepEqual(goods.map(good => good.id), ['loot-0', 'loot-1', 'yb'])
})

test('a task without fixed rewards previews as empty', () => {
  assert.deepEqual(previewTaskGoods({}, {
    projectionMode: false,
    loot: () => {
      throw new Error('loot must not be called without a reroll count')
    },
  }), [])
  assert.deepEqual(previewTaskGoods({ reroll: 1 }, {
    projectionMode: true,
    loot: () => {
      throw new Error('projection mode must not draw loot')
    },
  }), [])
})
