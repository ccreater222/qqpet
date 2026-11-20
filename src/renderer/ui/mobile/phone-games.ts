// The phone game lobby. The desktop window (ui/games.ts, ui/css/games.css) is a
// 540 px canvas zoomed 1.25x — 675 px wide — so on a phone only 56 % of it fits:
// 5 of 7 categories and 9 of 28 企鹅 games were off screen with no way to scroll
// (review: tmp/reports/mobile-ui/05-review-a.md §2). This sheet keeps the same
// catalogue, the same seven tabs and the same launch paths, but lays them out at
// 1 CSS px = 1 dp: a search field, a scrolling chip row, and one 64 dp row per
// game with a 40 dp tile, the name on two lines and a 44 dp 开始 button.
import GAMES from '../../pet/data/games.json'
import { div, img, typeable } from '../dom'
import { playDiudiule } from '../diudiule'
import { startFlashGame } from '../games'
import { playSmallGame, SMALL_GAMES } from '../smallgame'
import {
  buildPhoneGames,
  createGamesView,
  visibleGames,
  type PhoneGameItem,
  type PhoneGamesView,
} from './phone-games-model'
import { openSheet, type SheetHandle } from './sheet'
import './phone-games.css'

/** The open lobby, so a second request replaces it instead of stacking sheets. */
let current: SheetHandle | null = null

/** Click plus the keyboard activation a `div` does not get for free. */
const activate = (el: HTMLElement, run: () => void): void => {
  el.addEventListener('click', run)
  el.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    run()
  })
}

const span = (cls: string, text: string): HTMLSpanElement =>
  Object.assign(document.createElement('span'), { className: cls, textContent: text })

/** A game with no tile art still needs a 40 dp square: a play mark in the paper colour. */
const tile = (item: PhoneGameItem): HTMLElement =>
  item.icon ? img('qp-games-icon', item.icon) : div('qp-games-icon qp-games-icon-empty', '▶')

/**
 * Opens the phone game lobby over the current screen. Every game is a row the
 * whole thumb can hit; the chip row and the search field sit above it.
 */
export function openPhoneGames(): void {
  current?.close()
  current = null
  const categories = buildPhoneGames(GAMES, SMALL_GAMES)
  let view: PhoneGamesView = createGamesView(categories)
  let handle: SheetHandle | null = null

  const search = typeable(Object.assign(document.createElement('input'), {
    className: 'qp-games-search',
    type: 'search',
    placeholder: '搜索游戏',
    autocomplete: 'off',
  }))
  search.setAttribute('aria-label', '搜索游戏')
  const chipsRow = div('qp-games-chips')
  const list = div('qp-games-list')
  const body = div('qp-games', search, chipsRow, list)

  function drawChips(): void {
    chipsRow.replaceChildren(...categories.map((category) => {
      const cell = div(
        'qp-games-chip',
        div('qp-games-chip-label', category.label),
        span('qp-games-chip-count', String(category.items.length)),
      )
      cell.setAttribute('role', 'button')
      cell.setAttribute('aria-pressed', String(view.categoryId === category.id))
      cell.tabIndex = 0
      activate(cell, () => {
        // Picking a chip means "show me this category": a leftover query would
        // keep the list on the whole catalogue and make the tap look dead.
        view = { categoryId: category.id, query: '' }
        search.value = ''
        drawChips()
        drawList()
      })
      return cell
    }))
  }

  function drawList(): void {
    const items = visibleGames(categories, view)
    const rows: HTMLElement[] = []
    if (view.query.trim().length > 0) {
      // A search walks every category, so each row has to say where it came from.
      rows.push(div('qp-games-hint', items.length > 0 ? `搜索到 ${items.length} 个游戏` : '没有找到匹配的游戏'))
    }
    rows.push(...items.map(gameRow))
    if (items.length === 0 && view.query.trim().length === 0) rows.push(div('qp-games-hint', '这个分类还没有游戏'))
    list.replaceChildren(...rows)
  }

  function gameRow(item: PhoneGameItem): HTMLElement {
    const row = div(
      'qp-games-item',
      tile(item),
      div('qp-games-text', div('qp-games-name', item.name), div('qp-games-note', item.categoryLabel)),
      div('qp-games-start', '开始'),
    )
    row.setAttribute('role', 'button')
    row.setAttribute('aria-label', `开始 ${item.name}`)
    row.tabIndex = 0
    activate(row, () => play(item))
    return row
  }

  /** Close first, then hand off to the desktop launch path — never a second copy of it. */
  function play(item: PhoneGameItem): void {
    handle?.close()
    current = null
    if (item.kind === 'diudiule') {
      playDiudiule()
      return
    }
    if (item.kind === 'small') {
      const game = SMALL_GAMES.find((entry) => entry.dir === item.dir)
      if (game) playSmallGame(game)
      return
    }
    void startFlashGame(`${item.dir}/${item.name}.swf`)
  }

  search.addEventListener('input', () => {
    view = { ...view, query: search.value }
    drawList()
  })

  drawChips()
  drawList()
  handle = openSheet({
    title: '游戏大厅',
    body,
    cardClass: 'qp-games-sheet',
    onClose: () => {
      if (current === handle) current = null
    },
  })
  current = handle
}
