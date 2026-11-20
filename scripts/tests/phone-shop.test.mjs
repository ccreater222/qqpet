// Phone shop: the pure "catalogue -> chips / pages / purchasable" model, plus
// the wiring that makes the phone path replace the 803 px hover-only window.
// The mall data is the real shop.json, so a chip that points at a missing tab
// (or an id no chip reaches) fails here instead of shipping an empty shelf.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  BAG_CHIPS,
  MAX_QUANTITY,
  STORE_CHIPS,
  TABS,
  blockedReason,
  chipById,
  chipsFor,
  createShopView,
  defaultChip,
  ownedOf,
  paginate,
  purchaseProblem,
  purchaseTotal,
  selectChip,
  selectTab,
  shelfEntries,
  shelfIds,
  stepQuantity,
} from '../../src/renderer/ui/mobile/phone-shop-model.ts'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const catalog = JSON.parse(read('../../src/renderer/pet/data/shop.json'))
const everySoldId = () => Object.values(catalog).flatMap((tab) => Object.values(tab).flat(2))
const allShelfIds = () => STORE_CHIPS.flatMap((chip) => shelfIds(catalog, chip))
const goods = JSON.parse(read('../../src/renderer/pet/data/goods.json'))

test('the store is a flat chip row over the real mall data', () => {
  assert.deepEqual(TABS.map((tab) => tab.id), ['store', 'bag'])
  assert.deepEqual(TABS.map((tab) => tab.label), ['商店', '我的'])
  assert.deepEqual(STORE_CHIPS.map((chip) => chip.label), ['推荐', '食品', '日用品', '药品', '玩具', '属性', '装扮'])
  assert.equal(new Set(STORE_CHIPS.map((chip) => chip.id)).size, STORE_CHIPS.length, 'chip ids stay unique')
  for (const chip of STORE_CHIPS) {
    assert.ok(chip.sources.length > 0, `${chip.label} has no source`)
    for (const source of chip.sources) {
      assert.ok(catalog[source.tab], `${chip.label} points at a missing mall tab: ${source.tab}`)
      assert.ok(catalog[source.tab][source.type]?.length, `${chip.label} points at an empty shelf: ${source.tab}.${source.type}`)
    }
    assert.ok(shelfIds(catalog, chip).length > 0, `${chip.label} renders an empty list`)
  }
})

test('every good the mall sells is reachable from some phone chip', () => {
  const reachable = new Set(allShelfIds())
  for (const id of new Set(everySoldId())) assert.ok(reachable.has(id), `no chip sells ${id} on a phone`)
  for (const chip of STORE_CHIPS) {
    const ids = shelfIds(catalog, chip)
    assert.equal(new Set(ids).size, ids.length, `${chip.label} lists the same good twice`)
  }
})

test('every good a chip sells exists under the type the chip claims, with a positive price', () => {
  for (const chip of STORE_CHIPS) {
    for (const entry of shelfEntries(catalog, chip)) {
      const good = goods[entry.type]?.[`_${entry.id}`]
      assert.ok(good, `${chip.label} sells ${entry.id} as ${entry.type}, which goods.json does not have`)
      assert.ok(typeof good.price === 'number' && good.price > 0, `${chip.label}/${entry.id} sells for ${good.price}`)
    }
  }
})

test('推荐 merges the whole recommendation tab in its own order', () => {
  const picked = chipById(STORE_CHIPS, 'pick')
  assert.deepEqual(
    shelfIds(catalog, picked),
    ['food', 'clean', 'medicine'].flatMap((type) => catalog.shopTj[type]).flat(),
  )
})

test('a shelf drops duplicate ids but keeps catalogue order', () => {
  const synthetic = { tab: { food: [['a', 'b'], ['b', 'c', 'a']] } }
  const chip = { id: 'synthetic', label: '测试', sources: [{ tab: 'tab', type: 'food' }] }
  assert.deepEqual(shelfIds(synthetic, chip), ['a', 'b', 'c'])
  assert.deepEqual(shelfIds({}, chip), [], 'a missing shelf is empty, not a crash')
})

test('paging clamps into range and reports its own edges', () => {
  const ids = Array.from({ length: 19 }, (_, i) => `id-${i}`)
  const first = paginate(ids, 1, 8)
  assert.deepEqual(first.ids, ids.slice(0, 8))
  assert.equal(first.totalPage, 3)
  assert.equal(first.hasPrev, false)
  assert.equal(first.hasNext, true)

  const last = paginate(ids, 99, 8)
  assert.equal(last.page, 3, 'a page past the end lands on the last page')
  assert.deepEqual(last.ids, ids.slice(16))
  assert.equal(last.hasNext, false)
  assert.equal(last.hasPrev, true)

  assert.equal(paginate(ids, 0, 8).page, 1, 'page 0 clamps to the first page')
  const empty = paginate([], 3, 8)
  assert.deepEqual(empty.ids, [])
  assert.equal(empty.page, 1, 'an empty shelf still has a page 1')
  assert.equal(empty.totalPage, 1)
  assert.equal(empty.hasPrev, false)
  assert.equal(empty.hasNext, false)
})

test('same data every page: walking the pages yields the shelf exactly once', () => {
  const shelf = shelfIds(catalog, chipById(STORE_CHIPS, 'food'))
  const walked = []
  let page = 1
  for (let guard = 0; guard < 100; guard++) {
    const next = paginate(shelf, page, 6)
    assert.ok(next.ids.length > 0, 'no page is empty before the end')
    walked.push(...next.ids)
    if (!next.hasNext) break
    page = next.page + 1
  }
  assert.deepEqual(walked, shelf)
  assert.equal(new Set(allShelfIds()).size, new Set(everySoldId()).size, 'the chips together cover the mall')
})

test('blocked reasons keep the desktop shop semantics', () => {
  const level10 = { level: 10, pd: false }
  assert.equal(blockedReason({}, level10), 0)
  assert.equal(blockedReason({ needLevel: 10 }, level10), 0)
  assert.equal(blockedReason({ needLevel: 11 }, level10), 1, 'a higher level blocks')
  assert.equal(blockedReason({ PD: true }, level10), 2, '粉钻-only goods block a non-member')
  assert.equal(blockedReason({ PD: true }, { level: 10, pd: true }), 0)
  // The desktop check only looks at 粉钻 when there is no level gate at all.
  assert.equal(blockedReason({ needLevel: 3, PD: true }, level10), 0)
  assert.equal(blockedReason({ needLevel: 30, PD: true }, level10), 1)
})

test('a refused purchase always says why; an accepted one says nothing', () => {
  const ctx = { level: 10, pd: false, balance: 100 }
  assert.equal(purchaseProblem({}, ctx, 1, 10), '')
  assert.match(purchaseProblem({ needLevel: 20 }, ctx, 1, 10), /等级/)
  assert.match(purchaseProblem({ PD: true }, ctx, 1, 10), /粉钻/)
  assert.match(purchaseProblem({}, ctx, 11, 10), /元宝/)
  assert.match(purchaseProblem({}, ctx, 0, 10), /数量/)
  assert.equal(purchaseTotal(7, 3), 21)
})

test('quantity stepping stays inside 1..99', () => {
  assert.equal(stepQuantity(1, -1), 1)
  assert.equal(stepQuantity(1, 10), 11)
  assert.equal(stepQuantity(MAX_QUANTITY, 1), MAX_QUANTITY)
  assert.equal(stepQuantity(5, Number.POSITIVE_INFINITY), MAX_QUANTITY)
  assert.equal(stepQuantity(5, Number.NEGATIVE_INFINITY), 1)
  assert.equal(stepQuantity(5, Number.NaN), 5)
  assert.equal(MAX_QUANTITY, 99)
})

test('the bag lists the inventory types as their own chips', () => {
  assert.deepEqual(BAG_CHIPS.map((chip) => chip.label), ['食品', '日用品', '药品', '玩具', '属性', '背景'])
  const types = BAG_CHIPS.flatMap((chip) => chip.sources.map((source) => source.type))
  assert.deepEqual(types, ['food', 'clean', 'medicine', 'toy', 'nums', 'background'])
  assert.equal(ownedOf(['_b0000001*3', '_b0000002*10'], 'b0000001'), 3)
  assert.equal(ownedOf(['_b0000001*3'], 'b0000009'), 0, 'an unowned good counts as 0')
  assert.equal(ownedOf([], 'anything'), 0)
})

test('view state starts on the store and resets the page when the shelf changes', () => {
  const view = createShopView()
  assert.equal(view.tab, 'store')
  assert.equal(view.chip, defaultChip('store'))
  assert.equal(view.page, 1)
  const deeper = { ...view, page: 4 }
  assert.deepEqual(selectChip(deeper, 'toy'), { tab: 'store', chip: 'toy', page: 1 })
  assert.deepEqual(selectTab(deeper, 'bag'), { tab: 'bag', chip: defaultChip('bag'), page: 1 })
  assert.deepEqual(chipsFor('bag'), BAG_CHIPS)
  assert.deepEqual(chipsFor('store'), STORE_CHIPS)
})

test('the phone stylesheet is scoped, finger-sized and never hover-only', () => {
  const css = read('../../src/renderer/ui/mobile/phone-shop.css').replace(/\/\*[\s\S]*?\*\//g, '')
  const selectors = [...css.matchAll(/([^{}]+)\{/g)]
    .map((match) => match[1].trim())
    .filter((selector) => !selector.startsWith('@') && !/^(from|to|\d+%)$/.test(selector))
  assert.ok(selectors.length > 0)
  for (const selector of selectors) {
    for (const one of selector.split(',')) {
      assert.match(one.trim(), /^body\.qp-phone\b/, `desktop selector escaped the phone scope: ${one.trim()}`)
    }
  }
  assert.doesNotMatch(css, /:hover/, 'a finger has no hover; the phone shop must not need one')
  assert.doesNotMatch(css, /\.ui-shop/, 'the desktop shop must not be restyled')
  // Tap targets: the 44 dp floor, a 48 dp segmented control and 64 dp bag rows.
  assert.match(css, /\.qp-shop-tab[^{]*\{[^}]*min-height:\s*var\(--qp-tap\)/s)
  assert.match(css, /\.qp-shop-chip[^{]*\{[^}]*min-height:\s*var\(--qp-tap-sm\)/s)
  assert.match(css, /\.qp-shop-buy[^{]*\{[^}]*min-height:\s*var\(--qp-tap-sm\)/s)
  assert.match(css, /\.qp-shop-step[^{]*\{[^}]*width:\s*var\(--qp-tap-sm\)/s)
  assert.match(css, /\.qp-shop-step[^{]*\{[^}]*height:\s*var\(--qp-tap-sm\)/s)
  assert.match(css, /\.qp-shop-bag-row[^{]*\{[^}]*min-height:\s*64px/s)
  // Two columns that can shrink instead of pushing the sheet sideways.
  assert.match(css, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/)
  // Text floors: name 15 px, prices/notes 13 px, icon 56 dp, chips scroll sideways.
  assert.match(css, /\.qp-shop-name[^{]*\{[^}]*font-size:\s*var\(--qp-font\)/s)
  assert.match(css, /\.qp-shop-price[^{]*\{[^}]*font-size:\s*var\(--qp-font-sm\)/s)
  assert.match(css, /\.qp-shop-icon[^{]*\{[^}]*width:\s*56px/s)
  assert.match(css, /\.qp-shop-icon[^{]*\{[^}]*height:\s*56px/s)
  assert.match(css, /\.qp-shop-chips[^{]*\{[^}]*overflow-x:\s*auto/s)
})

test('openShop branches to the phone surface before the desktop window opens', () => {
  const src = read('../../src/renderer/ui/shop.ts')
  const open = src.slice(src.indexOf('export function openShop'))
  assert.match(open, /if \(phoneUI\(\)\) return openPhoneShop\(\)/, 'the phone branch is missing')
  const body = open.slice(open.indexOf('{') + 1)
  assert.ok(
    body.indexOf('if (phoneUI()) return openPhoneShop()') < body.indexOf('if (close) return'),
    'the phone branch runs before the desktop shop grabs its singleton',
  )
})

test('the phone surface is a sheet over the shared shop/food/items contracts', () => {
  const src = read('../../src/renderer/ui/mobile/phone-shop.ts')
  for (const needle of ["from './sheet'", "from '../../pet/items'", "from '../../pet/goods'", "import './phone-shop.css'"]) {
    assert.ok(src.includes(needle), `phone-shop.ts lost its ${needle} dependency`)
  }
  assert.match(src, /openSheet\(\{[\s\S]*?title:\s*'商城'/)
  assert.match(src, /useItem\(/, 'the bag must use goods through the shared item path')
  assert.match(src, /buy(Runtime)?\(/, 'a purchase must go through the shared buy path')
  assert.match(src, /listGoods\(/, 'the bag must page the shared inventory')
  assert.doesNotMatch(src, /windowView\(/, 'the phone shop keeps its own quantity stepper inside the sheet')
})
