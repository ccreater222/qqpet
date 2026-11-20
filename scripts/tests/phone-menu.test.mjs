// Phone menu: the pure "menu tree -> grouped sections / inline expansion" model,
// plus the guarded cases (no pet, buried, dead) that must keep every entry.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runtimeMenuItems } from '../../src/renderer/ui/runtime-menu.ts'
import {
  DANGER_SECTION_TITLE,
  MENU_GROUP_ORDER,
  MENU_GROUP_TITLES,
  countMenuItems,
  createMenuView,
  groupMenuItems,
  isDangerous,
  isRowExpanded,
  menuRowKey,
  menuRows,
  toggleMenuRow,
} from '../../src/renderer/ui/mobile/phone-menu-model.ts'

const noop = () => {}
const actions = {
  adopt: noop,
  leave: noop,
  openState: noop,
  openShop: noop,
  openGoods: noop,
  openPetInfo: noop,
  openSetup: noop,
  openFarm: noop,
  openFishing: noop,
  openGames: noop,
  openIsland: noop,
  visitFriend: noop,
  readopt: noop,
  bury: noop,
  togglePaused: noop,
  paused: false,
  dead: false,
  buried: false,
}

const labels = (section) => section.items.map((item) => item.label)
const topLevel = (sections) => sections.flatMap((section) => section.items)

test('sections follow 互动 / 养成 / 设置 / 其他 and keep each group in tree order', () => {
  const items = [
    { label: '设置帮助', group: 'settings' },
    { label: '未标注项' },
    { label: '打开商城', group: 'care' },
    { label: '和我聊天', group: 'interact' },
    { label: '宠物状态', group: 'care' },
  ]
  const sections = groupMenuItems(items)
  assert.deepEqual(sections.map((section) => section.id), [...MENU_GROUP_ORDER])
  assert.deepEqual(sections.map((section) => section.title), MENU_GROUP_ORDER.map((id) => MENU_GROUP_TITLES[id]))
  assert.deepEqual(labels(sections[0]), ['和我聊天'])
  assert.deepEqual(labels(sections[1]), ['打开商城', '宠物状态'])
  assert.deepEqual(labels(sections[2]), ['设置帮助'])
  assert.deepEqual(labels(sections[3]), ['未标注项'], 'an unlabelled entry falls into 其他 instead of disappearing')
  assert.equal(countMenuItems(topLevel(sections)), countMenuItems(items))
})

test('nested entries are never dropped and only the annotated group changes', () => {
  const items = [
    { label: '喂养宠物', group: 'interact', children: [{ label: '喂养' }, { label: '清洗', children: [{ label: '香皂' }] }] },
    { label: '退出宠物', danger: true },
  ]
  const sections = groupMenuItems(items)
  assert.equal(topLevel(sections).length, 2)
  assert.equal(countMenuItems(topLevel(sections)), 5)
  assert.equal(topLevel(sections)[0].children[1].children[0].label, '香皂')
})

test('danger entries are red-classified and moved to the last section whatever their group', () => {
  const items = [
    { label: '退出宠物', group: 'interact', danger: true },
    { label: '和我聊天', group: 'interact' },
    { label: '埋葬宠物', danger: true },
    { label: '打开商城', group: 'care' },
  ]
  const sections = groupMenuItems(items)
  assert.equal(sections.at(-1).id, 'danger')
  assert.equal(sections.at(-1).title, DANGER_SECTION_TITLE)
  assert.deepEqual(labels(sections.at(-1)), ['退出宠物', '埋葬宠物'])
  assert.deepEqual(labels(sections[0]), ['和我聊天'], 'a danger entry leaves its normal group')
  assert.equal(isDangerous(items[0]), true)
  assert.equal(isDangerous(items[1]), false)
  assert.equal(isDangerous({ label: '重新领养宠物' }), false, 'classification is explicit, not guessed from the label')
})

test('inline expansion lists every child in place and collapses back', () => {
  const sections = groupMenuItems([
    { label: '喂养宠物', group: 'interact', children: [{ label: '喂养' }, { label: '清洗' }, { label: '吃药' }] },
    { label: '一起玩耍', group: 'interact', children: [{ label: '休息一下' }] },
  ])
  const key = menuRowKey('interact', 0)
  let view = createMenuView()
  assert.deepEqual(menuRows(sections, view).map((row) => row.item.label), ['喂养宠物', '一起玩耍'])

  view = toggleMenuRow(view, key)
  assert.equal(isRowExpanded(view, key), true)
  const open = menuRows(sections, view)
  assert.deepEqual(open.map((row) => [row.item.label, row.depth]), [
    ['喂养宠物', 0],
    ['喂养', 1],
    ['清洗', 1],
    ['吃药', 1],
    ['一起玩耍', 0],
  ])
  assert.deepEqual(open.filter((row) => row.depth === 1).map((row) => row.item.label), ['喂养', '清洗', '吃药'])

  view = toggleMenuRow(view, key)
  assert.deepEqual(menuRows(sections, view).map((row) => row.item.label), ['喂养宠物', '一起玩耍'])
})

test('no pet keeps the adopt entry and puts 退出宠物 in the danger section', () => {
  const raw = runtimeMenuItems(false, actions)
  const sections = groupMenuItems(raw)
  assert.deepEqual(topLevel(sections).map((item) => item.label), ['选择宠物', '退出宠物'])
  assert.equal(sections.at(-1).id, 'danger')
  assert.deepEqual(labels(sections.at(-1)), ['退出宠物'])
})

test('buried keeps re-adoption and exit, both in the danger section', () => {
  const raw = runtimeMenuItems(true, { ...actions, buried: true })
  const sections = groupMenuItems(raw)
  assert.deepEqual(topLevel(sections).map((item) => item.label), ['重新领养宠物', '退出宠物'])
  assert.equal(sections.at(-1).id, 'danger')
  assert.deepEqual(labels(sections.at(-1)), ['重新领养宠物', '退出宠物'])
  assert.equal(sections.length, 1, 'only danger actions remain for a buried pet')
})

test('dead keeps the shop, help, state, bury and exit entries and every child', () => {
  const raw = runtimeMenuItems(true, { ...actions, dead: true })
  const sections = groupMenuItems(raw)
  assert.deepEqual(topLevel(sections).map((item) => item.label), ['打开商城', '宠物状态', '设置帮助', '埋葬宠物', '退出宠物'])
  assert.equal(countMenuItems(topLevel(sections)), countMenuItems(raw))
  const help = topLevel(sections).find((item) => item.label === '设置帮助')
  assert.deepEqual(help.children.map((child) => child.label), ['宠物资料', '系统设置'])
  assert.equal(sections.at(-1).id, 'danger')
  assert.deepEqual(labels(sections.at(-1)), ['埋葬宠物', '退出宠物'])
})

test('the phone menu supplies chat itself in runtime mode without touching runtimeMenuItems', () => {
  const source = readFileSync(new URL('../../src/renderer/ui/mobile/phone-menu.ts', import.meta.url), 'utf8')
  assert.match(source, /runtimeProjectionMode/, 'the extra row must only exist where runtimeMenuItems omits chat')
  assert.match(source, /openChat/, 'the row must open the real chat panel')
  assert.match(source, /items\.unshift\(\{ label: '和我聊天'/, 'the row joins the 互动 section instead of floating above it')
  const runtime = readFileSync(new URL('../../src/renderer/ui/runtime-menu.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(runtime, /和我聊天/, 'the desktop runtime menu stays unchanged')
})

test('the menu stylesheet is phone-only and sizes rows for a finger', () => {
  const css = readFileSync(new URL('../../src/renderer/ui/mobile/menu-phone.css', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  const selectors = [...css.matchAll(/([^{}]+)\{/g)]
    .map((match) => match[1].trim())
    .filter((selector) => !selector.startsWith('@') && !/^(from|to|\d+%)$/.test(selector))
  assert.ok(selectors.length > 0)
  for (const selector of selectors) {
    for (const one of selector.split(',')) {
      assert.match(one.trim(), /^body\.qp-phone\b/, `desktop selector escaped the phone scope: ${one.trim()}`)
    }
  }
  assert.doesNotMatch(css, /\.ui-menu/, 'the desktop popup menu must not be restyled')
  assert.match(css, /\.qp-menu-row[^{]*\{[^}]*min-height:\s*56px/s)
  assert.match(css, /\.qp-menu-row[^{]*\{[^}]*font-size:\s*15px/s)
  assert.match(css, /\.qp-menu-sub-row[^{]*\{[^}]*min-height:\s*48px/s)
  // Quick actions: four tiles, each its own 72 dp thumb target.
  assert.match(css, /\.qp-shortcut[^{]*\{[^}]*min-width:\s*72px/s)
  assert.match(css, /\.qp-shortcut[^{]*\{[^}]*min-height:\s*72px/s)
  assert.match(css, /\.qp-shortcut-label[^{]*\{[^}]*font-size:\s*13px/s)
  assert.match(css, /\.qp-menu-stat-head[^{]*\{[^}]*font-size:\s*13px/s, 'the care meters must be readable, not 11px')
  assert.match(css, /grid-template-columns:\s*repeat\(4, minmax\(72px, 1fr\)\)/)
})
