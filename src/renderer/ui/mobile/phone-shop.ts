// The phone shop. The desktop window (ui/shop.ts) is an 803 px pixel-art canvas
// whose 加购/购买 buttons only appear on :hover; box.ts shrinks it to ~0.49 on a
// phone, so its body text lands at 5.9 dp and nothing can be bought with a
// finger. This surface keeps the same data (shop.json, listGoods, price/buy/
// useItem) and the same 等级 / 粉钻 rules, but lays it out as a bottom sheet at
// 1 CSS px = 1 dp: two tabs, a chip row, two-column cards with an inline 1..99
// stepper, and the inventory as tappable rows.
import type { Good, GoodType } from '../../pet/data/goods'
import { describe, goodOf } from '../../pet/data/goods'
import SHOP from '../../pet/data/shop.json'
import { listGoods, onGoodsChange } from '../../pet/goods'
import { buy, buyRuntime, discount, price, useItem } from '../../pet/items'
import { info, onInfoChange, runtimeProjectionMode, save } from '../../pet/store'
import { button, div, img } from '../dom'
import {
  BAG_CHIPS,
  BAG_PAGE_SIZE,
  STORE_CHIPS,
  TABS,
  bagTypeOf,
  blockedReason,
  chipById,
  clampPage,
  createShopView,
  ownedOf,
  paginate,
  purchaseProblem,
  purchaseTotal,
  selectChip,
  selectTab,
  shelfEntries,
  stepQuantity,
  type BlockReason,
  type PurchaseContext,
  type ShopChip,
  type ShopCatalog,
  type ShopView,
} from './phone-shop-model'
import { openSheet, type SheetHandle } from './sheet'

const catalog = SHOP as ShopCatalog

/** The open phone shop, so a second request replaces it instead of stacking sheets. */
let current: SheetHandle | null = null
/** Redraw hook while the sheet is up; store events keep prices and counts honest. */
let redrawOpen: (() => void) | null = null

onGoodsChange(() => redrawOpen?.())
onInfoChange((key) => {
  if (key === 'yb' || key === 'pinkDiamond' || key === 'growth') redrawOpen?.()
})

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

/** What the buyer has right now: the same three inputs shop.ts `blocked` reads. */
const buyer = (): PurchaseContext => ({
  level: save.petComputedlInfo.level,
  pd: Boolean(info.pinkDiamond),
  balance: info.yb,
})

/** Why a shelf card cannot be bought, in its own words; '' when it can. */
const requirement = (g: Good, reason: BlockReason): string =>
  reason === 1 ? `需 Lv.${g.needLevel}` : reason === 2 ? '粉钻限定' : ''

/**
 * Opens the phone shop over the current screen. Every control is a bottom-sheet
 * row: the sheet's own close button, the two tabs, the chip row, the cards'
 * buttons and the pager are each at least 44 dp.
 */
export function openPhoneShop(): void {
  current?.close()
  current = null
  let view: ShopView = createShopView()
  /** The card whose stepper is open; one at a time, cleared on any navigation. */
  let pending: { id: string; n: number } | null = null
  let toast: { text: string; kind: 'ok' | 'error' } | null = null
  let toastTimer: ReturnType<typeof setTimeout> | undefined
  let pageInfo: { page: number; totalPage: number } | null = null
  let handle: SheetHandle | null = null

  const body = div('qp-shop')
  const footer = div('qp-shop-footer')

  function notify(text: string, kind: 'ok' | 'error'): void {
    toast = { text, kind }
    if (toastTimer !== undefined) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      toastTimer = undefined
      toast = null
      drawFooter()
    }, 2600)
    drawFooter()
  }

  function pagerRow(): HTMLElement | null {
    if (pageInfo === null || pageInfo.totalPage <= 1) return null
    const { page, totalPage } = pageInfo
    const step = (delta: number): HTMLElement => {
      const to = page + delta
      const enabled = to >= 1 && to <= totalPage
      const el = div('qp-shop-page', delta < 0 ? '‹ 上一页' : '下一页 ›')
      el.setAttribute('role', 'button')
      el.setAttribute('aria-label', delta < 0 ? '上一页' : '下一页')
      el.setAttribute('aria-disabled', String(!enabled))
      if (enabled) {
        el.tabIndex = 0
        activate(el, () => {
          view = { ...view, page: to }
          pending = null
          draw()
        })
      }
      return el
    }
    return div('qp-shop-pager', step(-1), div('qp-shop-pageno', `${page} / ${totalPage}`), step(1))
  }

  function drawFooter(): void {
    const rows: HTMLElement[] = []
    if (toast) rows.push(div(`qp-shop-toast qp-shop-toast-${toast.kind}`, toast.text))
    const pager = pagerRow()
    if (pager) rows.push(pager)
    footer.replaceChildren(...rows)
    footer.style.display = rows.length ? '' : 'none'
  }

  function tabs(): HTMLElement {
    const row = div('qp-shop-tabs')
    row.setAttribute('role', 'tablist')
    for (const tab of TABS) {
      const selected = view.tab === tab.id
      const cell = div('qp-shop-tab', tab.label)
      cell.setAttribute('role', 'tab')
      cell.setAttribute('aria-selected', String(selected))
      cell.tabIndex = 0
      activate(cell, () => {
        if (view.tab === tab.id) return
        view = selectTab(view, tab.id)
        pending = null
        draw()
      })
      row.append(cell)
    }
    return row
  }

  function chips(chips: readonly ShopChip[]): HTMLElement {
    const row = div('qp-shop-chips')
    row.setAttribute('role', 'tablist')
    for (const chip of chips) {
      const cell = div('qp-shop-chip', chip.label)
      cell.setAttribute('role', 'tab')
      cell.setAttribute('aria-selected', String(view.chip === chip.id))
      cell.tabIndex = 0
      activate(cell, () => {
        if (view.chip === chip.id) return
        view = selectChip(view, chip.id)
        pending = null
        draw()
      })
      row.append(cell)
    }
    return row
  }

  /** 元宝 on the left, membership on the right: what a price will actually cost. */
  function wallet(): HTMLElement {
    const member = buyer().pd
    return div(
      'qp-shop-wallet',
      div('', `元宝 ${info.yb}`),
      member ? div('', '粉钻会员 · 八折') : div('', '未开通粉钻'),
    )
  }

  /** Unit price, with the struck-through list price when the membership cuts it. */
  function priceLine(g: Good): HTMLElement {
    const unit = price(g)
    const line = div('qp-shop-price', `${unit} 元宝`)
    if (g.price !== undefined && discount(g.price) > unit) line.append(span('qp-shop-price-was', String(g.price)))
    return line
  }

  function buyButton(g: Good, reason: BlockReason): HTMLElement {
    const locked = reason !== 0
    const el = button('qp-shop-buy', () => {
      if (locked) {
        // An explicit reason, the same one buy() would refuse with: never a dead tap.
        notify(purchaseProblem(g, buyer(), 1, price(g)), 'error')
        return
      }
      pending = { id: g.id, n: 1 }
      draw()
    }, '购买')
    el.setAttribute('role', 'button')
    el.setAttribute('aria-label', `购买 ${g.name}`)
    el.setAttribute('aria-disabled', String(locked))
    if (locked) el.dataset.locked = 'true'
    return el
  }

  function quantityBox(g: Good): HTMLElement {
    const n = pending?.n ?? 1
    const step = (delta: number): HTMLElement => {
      const el = div('qp-shop-step', delta < 0 ? '−' : '+')
      el.setAttribute('role', 'button')
      el.setAttribute('aria-label', delta < 0 ? '减少一个' : '增加一个')
      el.tabIndex = 0
      activate(el, () => {
        if (pending === null) return
        pending = { id: pending.id, n: stepQuantity(pending.n, delta) }
        draw()
      })
      return el
    }
    return div(
      'qp-shop-buybox',
      div('qp-shop-total', `共 ${purchaseTotal(price(g), n)} 元宝 · 余额 ${info.yb}`),
      div('qp-shop-qty', step(-1), div('qp-shop-count', String(n)), step(1)),
      div(
        'qp-shop-actions',
        button('qp-shop-cancel', () => {
          pending = null
          draw()
        }, '取消'),
        button('qp-shop-ok', () => void confirmPurchase(g), '确认'),
      ),
    )
  }

  function productCard(id: string, type: GoodType): HTMLElement {
    const g = goodOf(type, id)
    const reason = blockedReason(g, buyer())
    const owned = ownedOf(save.selfGoodDatas[type], id)
    const note = requirement(g, reason) || (owned > 0 ? `已有 ${owned}` : '未拥有')
    const card = div(
      'qp-shop-product',
      img('qp-shop-icon', g.url),
      div('qp-shop-name', g.name),
      div('qp-shop-meta', priceLine(g), div(reason ? 'qp-shop-owned qp-shop-owned-locked' : 'qp-shop-owned', note)),
    )
    card.append(pending?.id === id ? quantityBox(g) : buyButton(g, reason))
    return card
  }

  function storePane(): HTMLElement[] {
    const chip = chipById(STORE_CHIPS, view.chip)
    const shelf = shelfEntries(catalog, chip)
    const types = new Map<string, GoodType>(shelf.map((entry) => [entry.id, entry.type]))
    const page = paginate(shelf.map((entry) => entry.id), view.page)
    view = { ...view, page: page.page }
    pageInfo = { page: page.page, totalPage: page.totalPage }
    const cards = page.ids.map((id) => productCard(id, types.get(id)!))
    return [
      wallet(),
      chips(STORE_CHIPS),
      cards.length ? div('qp-shop-grid', ...cards) : div('qp-shop-empty', '这个分类暂时没有货'),
    ]
  }

  function bagPane(): HTMLElement[] {
    const chip = chipById(BAG_CHIPS, view.chip)
    const type = bagTypeOf(chip)
    const totalPage = Math.max(1, Math.ceil(save.selfGoodDatas[type].length / BAG_PAGE_SIZE))
    const page = clampPage(view.page, totalPage)
    view = { ...view, page }
    pageInfo = { page, totalPage }
    const { list } = listGoods(type, page, BAG_PAGE_SIZE)
    if (list.length === 0) return [chips(BAG_CHIPS), div('qp-shop-empty', `背包里没有${chip.label}，去商店买点吧`)]
    return [chips(BAG_CHIPS), div('qp-shop-bag', ...list.map(bagRow))]
  }

  function bagRow(g: Good): HTMLElement {
    const effect = describe(g)[0]
    const row = div(
      'qp-shop-bag-row',
      img('qp-shop-bag-icon', g.url),
      div(
        'qp-shop-bag-text',
        div('qp-shop-bag-name', g.name),
        div('qp-shop-bag-note', effect ? `剩余 ${g.num} · ${effect}` : `剩余 ${g.num}`),
      ),
      div('qp-shop-bag-use', '使用'),
    )
    row.setAttribute('role', 'button')
    row.setAttribute('aria-label', `使用 ${g.name}，剩余 ${g.num}`)
    row.tabIndex = 0
    activate(row, () => useGood(g))
    return row
  }

  function useGood(g: Good): void {
    if (g.type === 'nums' || g.type === 'medicine') {
      // These open the shared windowView dialog (or need the pet's own bubble),
      // which sits under the sheet. Step out of the way first, like the phone
      // menu does: the confirmation then lands in front of the user, not behind.
      handle?.close()
      setTimeout(() => useItem(g), 220)
      return
    }
    useItem(g)
    notify(`已使用 ${g.name}`, 'ok')
    draw()
  }

  async function confirmPurchase(g: Good): Promise<void> {
    const n = pending?.n ?? 1
    const problem = purchaseProblem(g, buyer(), n, price(g))
    if (problem) {
      notify(problem, 'error')
      return
    }
    const ok = runtimeProjectionMode ? await buyRuntime(g, n) : buy(g, n)
    if (!ok) {
      notify(`没能买到 ${g.name}，请稍后再试`, 'error')
      return
    }
    pending = null
    draw()
    notify(`已购买 ${g.name} ×${n}`, 'ok')
  }

  function draw(): void {
    pageInfo = null
    body.replaceChildren(tabs(), ...(view.tab === 'store' ? storePane() : bagPane()))
    drawFooter()
  }

  draw()
  redrawOpen = draw
  handle = openSheet({
    title: '商城',
    body,
    footer,
    cardClass: 'qp-shop-sheet',
    onClose: () => {
      if (toastTimer !== undefined) clearTimeout(toastTimer)
      if (redrawOpen === draw) redrawOpen = null
      if (current === handle) current = null
    },
  })
  current = handle
}
