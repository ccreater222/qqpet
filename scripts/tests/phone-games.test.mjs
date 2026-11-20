// Phone game lobby: the pure "catalogue -> category chips / search / flat list"
// model, the sheet that replaces the 675 px desktop window, and the phone
// stylesheet. The catalogue is the real games.json, so a category that stops
// existing (or a game no chip reaches) fails here instead of shipping an empty
// list on a phone.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  DIUDIULE,
  PLAY_CATEGORY_ID,
  buildPhoneGames,
  categoryOf,
  createGamesView,
  filterGames,
  flattenGames,
  visibleGames,
} from '../../src/renderer/ui/mobile/phone-games-model.ts'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const catalog = JSON.parse(read('../../src/renderer/pet/data/games.json'))

/** SMALL_GAMES lives beside DOM code; only its literal table is needed here. */
function smallGameTable() {
  const source = read('../../src/renderer/ui/smallgame.ts')
  const start = source.indexOf('export const SMALL_GAMES = [')
  assert.ok(start >= 0, 'smallgame.ts must keep its SMALL_GAMES table')
  const block = source.slice(start, source.indexOf(']', start))
  return [...block.matchAll(/dir: '([^']+)', name: '([^']+)',?[^}]*?icon: (?:'([^']+)'|undefined)/g)].map((match) => ({
    dir: match[1],
    name: match[2],
    icon: match[3],
  }))
}

const SMALL_GAMES = smallGameTable()
const categories = () => buildPhoneGames(catalog, SMALL_GAMES)

test('the phone lobby lists the exact desktop categories, with 陪我玩 first', () => {
  assert.deepEqual(categories().map((category) => category.label), ['陪我玩', ...catalog.map((entry) => entry.name)])
  assert.deepEqual(categories().map((category) => category.id), [PLAY_CATEGORY_ID, ...catalog.map((entry) => entry.dir)])
  assert.equal(new Set(categories().map((category) => category.id)).size, categories().length, 'category ids stay unique')
  for (const category of categories()) assert.ok(category.items.length > 0, `${category.label} renders an empty list`)
})

test('陪我玩 holds every desktop game plus 丢丢乐, and nothing is reachable twice', () => {
  const play = categoryOf(categories(), PLAY_CATEGORY_ID)
  assert.deepEqual(play.items.map((item) => item.name), [...SMALL_GAMES.map((game) => game.name), DIUDIULE])
  assert.equal(SMALL_GAMES.length, 6, 'the six TickleSystem games are the desktop list')
  assert.deepEqual(play.items.map((item) => item.kind), [...SMALL_GAMES.map(() => 'small'), 'diudiule'])
  for (const [index, game] of SMALL_GAMES.entries()) {
    assert.equal(play.items[index].dir, game.dir)
    assert.equal(play.items[index].icon, game.icon ? `pet/quickBar/TickleSystem/${game.icon}00.png` : '', `${game.name} icon path`)
  }

  const all = flattenGames(categories())
  assert.equal(all.length, 7 + catalog.reduce((sum, entry) => sum + entry.games.length, 0))
  assert.equal(new Set(all.map((item) => item.id)).size, all.length, 'every game has its own id')
  for (const entry of catalog) {
    const flash = all.filter((item) => item.kind === 'flash' && item.categoryId === entry.dir)
    assert.deepEqual(flash.map((item) => item.name), entry.games, `${entry.name} keeps the desktop order`)
    for (const item of flash) assert.equal(item.dir, entry.dir, `${item.name} carries its SWF folder`)
  }
})

test('flattening keeps category order and the selected chip is the list', () => {
  const flat = flattenGames(categories())
  assert.equal(flat[0].categoryId, PLAY_CATEGORY_ID)
  assert.deepEqual(
    [...new Set(flat.map((item) => item.categoryId))],
    categories().map((category) => category.id),
    'a category never reappears after another one',
  )
  const view = createGamesView(categories())
  assert.equal(view.categoryId, PLAY_CATEGORY_ID, 'the lobby opens on 陪我玩')
  assert.equal(view.query, '')

  const ow = categoryOf(categories(), '鼹鼠')
  assert.deepEqual(visibleGames(categories(), { categoryId: '鼹鼠', query: '' }).map((item) => item.name), ow.items.map((item) => item.name))
  assert.deepEqual(visibleGames(categories(), { categoryId: 'nope', query: '' }), categoryOf(categories(), PLAY_CATEGORY_ID).items, 'an unknown chip falls back to the first')
  assert.deepEqual(visibleGames([], view), [], 'an empty catalogue renders no rows')
})

test('search trims, ignores case and walks every category at once', () => {
  const all = flattenGames(categories())
  assert.deepEqual(filterGames(all, '   '), all, 'a blank query filters nothing')
  assert.deepEqual(filterGames(all, 'qq飞车').map((item) => item.name), ['QQ飞车'])
  assert.deepEqual(filterGames(all, 'QQ宠物').map((item) => item.name), ['QQ宠物挖矿', 'QQ宠物捉鱼', 'QQ宠物摘星星', 'QQ宠物泡泡'])
  const luoke = filterGames(all, '洛克')
  assert.equal(luoke.length, 7)
  assert.ok(luoke.every((item) => item.categoryLabel === '尖耳朵'), 'a search result still says where it came from')
  assert.equal(filterGames(all, '冒险岛').length, 9, 'the category name is searchable too')
  assert.equal(filterGames(all, '丢丢乐').length, 1)
  assert.deepEqual(filterGames(all, '不存在的游戏'), [])

  // The list under a query is the flattened catalogue, not the selected chip:
  // searching from 陪我玩 must still find a 企鹅 flash game.
  const found = visibleGames(categories(), { categoryId: PLAY_CATEGORY_ID, query: '洛克' })
  assert.deepEqual(found.map((item) => item.name), luoke.map((item) => item.name))
  assert.deepEqual(visibleGames(categories(), { categoryId: '企鹅', query: 'qq飞车' }).map((item) => item.name), ['QQ飞车'])
})

test('the model stays pure, so the phone surface owns every DOM and command call', () => {
  const source = read('../../src/renderer/ui/mobile/phone-games-model.ts')
  assert.doesNotMatch(source, /^import /m, 'the model must not import a runtime module')
  assert.doesNotMatch(source, /document\.|window\./, 'the model must not touch the DOM')
})

test('the phone surface reuses the desktop play paths instead of copying them', () => {
  const source = read('../../src/renderer/ui/mobile/phone-games.ts')
  for (const needle of [
    "from './sheet'",
    "import './phone-games.css'",
    "from '../smallgame'",
    "from '../diudiule'",
    "from '../games'",
    'openSheet({',
  ]) {
    assert.ok(source.includes(needle), `phone-games.ts lost its ${needle} dependency`)
  }
  assert.match(source, /playSmallGame\(/, 'a 陪我玩 tile must start the shared small game')
  assert.match(source, /playDiudiule\(/, '丢丢乐 must start the shared desktop game')
  assert.match(source, /startFlashGame\(/, 'a flash game must start the shared server session')
  // Copying the launch logic is what would drift from games.ts.
  assert.doesNotMatch(source, /dispatchRuntimeCommand|uiCommands\.game|window\.qqpet\.openGame/, 'the launch path belongs to games.ts')
  assert.doesNotMatch(source, /openBox|openFrame/, 'the phone lobby is a sheet, not a desktop window')

  const games = read('../../src/renderer/ui/games.ts')
  const open = games.slice(games.indexOf('export function openGames'))
  assert.match(open, /if \(phoneUI\(\)\) return openPhoneGames\(\)/, 'the phone branch is missing')
  const body = open.slice(open.indexOf('{') + 1)
  assert.ok(
    body.indexOf('if (phoneUI()) return openPhoneGames()') < body.indexOf('if (open) return'),
    'the phone branch runs before the desktop window grabs its singleton',
  )
  assert.match(games, /export async function startFlashGame|export function startFlashGame/, 'the flash launch must be shared with the phone lobby')
})

const ISLAND_MARK = '/* ---- island sheet'

/** The island section of the shared phone-pages.css (impl-pages owns the rest). */
function islandSegment() {
  const css = read('../../src/renderer/ui/css/phone-pages.css')
  const at = css.indexOf(ISLAND_MARK)
  assert.ok(at >= 0, `phone-pages.css is missing the island section (${ISLAND_MARK})`)
  return css.slice(at)
}

test('the phone lobby stylesheet is scoped, finger-sized and never hover-only', () => {
  for (const path of ['../../src/renderer/ui/mobile/phone-games.css', '../../src/renderer/ui/css/phone-pages.css']) {
    const css = read(path).replace(/\/\*[\s\S]*?\*\//g, '')
    const selectors = [...css.matchAll(/([^{}]+)\{/g)]
      .map((match) => match[1].trim())
      .filter((selector) => !selector.startsWith('@') && !/^(from|to|\d+%)$/.test(selector))
    assert.ok(selectors.length > 0, `${path} is empty`)
    for (const selector of selectors) {
      for (const one of selector.split(',')) {
        assert.match(one.trim(), /^body\.qp-phone\b/, `${path}: desktop selector escaped the phone scope: ${one.trim()}`)
      }
    }
    assert.doesNotMatch(css, /:hover/, `${path}: a finger has no hover`)
  }

  const games = read('../../src/renderer/ui/mobile/phone-games.css')
  assert.match(games, /\.qp-games-chip[^{]*\{[^}]*min-height:\s*var\(--qp-tap-sm\)/s)
  assert.match(games, /\.qp-games-item[^{]*\{[^}]*min-height:\s*64px/s)
  assert.match(games, /\.qp-games-icon[^{]*\{[^}]*width:\s*40px/s)
  assert.match(games, /\.qp-games-icon[^{]*\{[^}]*height:\s*40px/s)
  assert.match(games, /\.qp-games-name[^{]*\{[^}]*font-size:\s*var\(--qp-font\)/s)
  assert.match(games, /\.qp-games-note[^{]*\{[^}]*font-size:\s*var\(--qp-font-sm\)/s)
  assert.match(games, /\.qp-games-start[^{]*\{[^}]*min-height:\s*var\(--qp-tap-sm\)/s)
  assert.match(games, /\.qp-games-name[^{]*\{[^}]*-webkit-line-clamp:\s*2/s, 'a 12-character game name needs two lines')
  assert.match(games, /\.qp-games-chips[^{]*\{[^}]*overflow-x:\s*auto/s, 'seven chips scroll sideways instead of shrinking')

  const island = islandSegment().replace(/\/\*[\s\S]*?\*\//g, '')
  assert.doesNotMatch(island, /\.ui-island\b/, 'the island desktop window must not be restyled')
  assert.match(island, /\.qp-island-sheet[^{]*\.qp-sheet-body[^{]*\{[^}]*font-size:\s*var\(--qp-font\)/s, 'island body text is 15 px')
  assert.match(island, /\.qp-island \.i_row[^{]*\{[^}]*min-height:\s*56px/s, 'island rows are 56 dp')
  assert.match(island, /\.qp-island \.focusPress[^{]*\{[^}]*min-height:\s*var\(--qp-tap-sm\)/s, 'island actions are 44 dp')
  assert.match(island, /\.qp-island-acts[^{]*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/s, 'five footer buttons never overflow a 412 dp row')
})

// ---- the mounted sheet (runtime, not just source) -------------------------

class FakeNode {
  constructor(tag, cls = '', children = []) {
    this.tagName = String(tag).toUpperCase()
    this.className = cls
    this.children = []
    this.listeners = new Map()
    this.attrs = new Map()
    this.style = {}
    this.dataset = {}
    this.value = ''
    this.tabIndex = 0
    for (const child of children) this.append(child)
  }
  append(...nodes) {
    for (const node of nodes) this.children.push(typeof node === 'string' ? node : node)
  }
  replaceChildren(...nodes) {
    this.children = []
    this.append(...nodes)
  }
  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }
  setAttribute(key, value) {
    this.attrs.set(key, String(value))
  }
  getAttribute(key) {
    return this.attrs.get(key) ?? null
  }
  fire(type) {
    for (const listener of this.listeners.get(type) ?? []) listener({ type, target: this, preventDefault() {} })
  }
  get textContent() {
    return this.children.map((child) => (typeof child === 'string' ? child : child.textContent)).join('')
  }
  set textContent(value) {
    this.children = [String(value)]
  }
}

const nodesUnder = (root, cls) => {
  const found = []
  const visit = (node) => {
    if (node instanceof FakeNode === false) return
    if (` ${node.className} `.includes(` ${cls} `)) found.push(node)
    for (const child of node.children) visit(child)
  }
  visit(root)
  return found
}

test('the mounted lobby is a sheet over the same launch paths and filters live', async () => {
  const { stripTypeScriptTypes } = await import('node:module')
  const { runInNewContext } = await import('node:vm')
  const source = stripTypeScriptTypes(read('../../src/renderer/ui/mobile/phone-games.ts'), { mode: 'transform' })
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '')
  const calls = []
  const sheets = []
  const catalog = [
    { name: '企鹅', dir: '企鹅', games: ['QQ飞车', 'QQ地下城与勇士之Q宠版'] },
    { name: '熊', dir: '熊', games: ['奥比捕鱼'] },
  ]
  const small = [{ dir: 'guess', name: '猜动作', icon: 'guess' }]
  const context = {
    GAMES: catalog,
    SMALL_GAMES: small,
    buildPhoneGames,
    createGamesView,
    visibleGames,
    document: { createElement: (tag) => new FakeNode(tag) },
    div: (cls, ...kids) => new FakeNode('div', cls, kids),
    img: (cls, src) => Object.assign(new FakeNode('img', cls), { src }),
    typeable: (input) => input,
    playSmallGame: (game) => calls.push(['small', game.dir]),
    playDiudiule: () => calls.push(['diudiule']),
    startFlashGame: (id) => {
      calls.push(['flash', id])
      return Promise.resolve()
    },
    openSheet: (options) => {
      sheets.push(options)
      return {
        el: new FakeNode('div'),
        card: new FakeNode('div'),
        body: options.body,
        title: new FakeNode('div', 'qp-sheet-title'),
        close: () => {
          options.closed = true
          options.onClose?.()
        },
      }
    },
  }
  runInNewContext(`${source}\nthis.__lobby = { openPhoneGames }`, context)
  const { openPhoneGames } = context.__lobby
  openPhoneGames()
  assert.equal(sheets.length, 1)
  const sheet = sheets[0]
  assert.equal(sheet.title, '游戏大厅')
  assert.equal(sheet.cardClass, 'qp-games-sheet')

  const chips = nodesUnder(sheet.body, 'qp-games-chip')
  assert.deepEqual(chips.map((chip) => chip.textContent), ['陪我玩2', '企鹅2', '熊1'])
  assert.equal(chips.length, 3)
  assert.equal(chips[0].getAttribute('aria-pressed'), 'true')

  const rows = nodesUnder(sheet.body, 'qp-games-item')
  assert.deepEqual(rows.map((row) => nodesUnder(row, 'qp-games-name')[0].textContent), ['猜动作', '丢丢乐'])
  assert.ok(nodesUnder(sheet.body, 'qp-games-start').length === rows.length)
  assert.equal(nodesUnder(sheet.body, 'qp-games-search')[0].getAttribute('aria-label'), '搜索游戏')

  rows[0].fire('click')
  assert.deepEqual(calls.at(-1), ['small', 'guess'], '陪我玩 must start the shared small game')
  assert.equal(sheet.closed, true, 'launching closes the sheet first')
  rows[1].fire('click')
  assert.deepEqual(calls.at(-1), ['diudiule'])

  // Chip 2 = 企鹅: two flash games, launched through games.ts's startFlashGame.
  chips[1].fire('click')
  const flashRows = nodesUnder(sheet.body, 'qp-games-item')
  assert.deepEqual(flashRows.map((row) => nodesUnder(row, 'qp-games-name')[0].textContent), ['QQ飞车', 'QQ地下城与勇士之Q宠版'])
  flashRows[0].fire('click')
  assert.deepEqual(calls.at(-1), ['flash', '企鹅/QQ飞车.swf'])

  // A query walks every category; the same rows re-render without a fresh sheet.
  const search = nodesUnder(sheet.body, 'qp-games-search')[0]
  search.value = '奥比'
  search.fire('input')
  const found = nodesUnder(sheet.body, 'qp-games-item')
  assert.deepEqual(found.map((row) => nodesUnder(row, 'qp-games-name')[0].textContent), ['奥比捕鱼'])
  assert.match(sheet.body.textContent, /搜索到 1 个游戏/)
  search.value = '不存在的游戏'
  search.fire('input')
  assert.match(sheet.body.textContent, /没有找到匹配的游戏/)
  // Picking a chip drops the query, or the list would look dead.
  chips[0].fire('click')
  assert.equal(search.value, '')
  assert.deepEqual(nodesUnder(sheet.body, 'qp-games-item').map((row) => nodesUnder(row, 'qp-games-name')[0].textContent), ['猜动作', '丢丢乐'])
})
