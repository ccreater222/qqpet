// The phone shop's pure model: the mall catalogue (shop.json) becomes one flat
// row of category chips, a shelf of ids per chip, pages of that shelf, and the
// "can this be bought — and if not, why" decision. No DOM and no store imports,
// so scripts/tests imports this file directly and phone-shop.ts stays a thin
// projection of this state. The desktop shop (ui/shop.ts) keeps the same data
// and the same 等级 / 粉钻 rules; only the presentation differs.
import type { GoodType } from '../../pet/data/goods'

export type ShopTab = 'store' | 'bag'

export interface ShopTabInfo {
  id: ShopTab
  label: string
}

/** The segmented control at the top of the sheet. */
export const TABS: readonly ShopTabInfo[] = [
  { id: 'store', label: '商店' },
  { id: 'bag', label: '我的' },
]

/** One (mall tab, good type) pair of shop.json. */
export interface ChipSource {
  tab: string
  type: GoodType
}

export interface ShopChip {
  id: string
  label: string
  sources: readonly ChipSource[]
}

/**
 * 商店: the desktop's two-level tabs (mall tab + sub type) flattened into the
 * chips a thumb can actually hit. 推荐 keeps the whole recommendation tab,
 * which is why it has three sources instead of one.
 */
export const STORE_CHIPS: readonly ShopChip[] = [
  {
    id: 'pick',
    label: '推荐',
    sources: [
      { tab: 'shopTj', type: 'food' },
      { tab: 'shopTj', type: 'clean' },
      { tab: 'shopTj', type: 'medicine' },
    ],
  },
  { id: 'food', label: '食品', sources: [{ tab: 'shopWy', type: 'food' }] },
  { id: 'clean', label: '日用品', sources: [{ tab: 'shopWy', type: 'clean' }] },
  { id: 'medicine', label: '药品', sources: [{ tab: 'shopWy', type: 'medicine' }] },
  { id: 'toy', label: '玩具', sources: [{ tab: 'shopGN', type: 'toy' }] },
  { id: 'nums', label: '属性', sources: [{ tab: 'shopGN', type: 'nums' }] },
  { id: 'background', label: '装扮', sources: [{ tab: 'shopZB', type: 'background' }] },
]

/**
 * 我的: the inventory types of the desktop's left half, as their own chips.
 * The bag has no mall tab, so `tab` only marks the source row; the type is
 * what listGoods needs.
 */
export const BAG_CHIPS: readonly ShopChip[] = [
  { id: 'food', label: '食品', sources: [{ tab: 'self', type: 'food' }] },
  { id: 'clean', label: '日用品', sources: [{ tab: 'self', type: 'clean' }] },
  { id: 'medicine', label: '药品', sources: [{ tab: 'self', type: 'medicine' }] },
  { id: 'toy', label: '玩具', sources: [{ tab: 'self', type: 'toy' }] },
  { id: 'nums', label: '属性', sources: [{ tab: 'self', type: 'nums' }] },
  { id: 'background', label: '背景', sources: [{ tab: 'self', type: 'background' }] },
]

/** shop.json: mall tab -> good type -> pages of item ids. */
export type ShopCatalog = Record<string, Partial<Record<GoodType, string[][]>> | undefined>

/** Store cards per page: two columns of four. */
export const PAGE_SIZE = 8
/** Bag rows per page; a row is twice as tall as a card is wide. */
export const BAG_PAGE_SIZE = 8
export const MAX_QUANTITY = 99

export const chipsFor = (tab: ShopTab): readonly ShopChip[] => (tab === 'store' ? STORE_CHIPS : BAG_CHIPS)

export const defaultChip = (tab: ShopTab): string => chipsFor(tab)[0]!.id

/** A chip by id, falling back to the first one: a stale selection must not blank the page. */
export const chipById = (chips: readonly ShopChip[], id: string): ShopChip =>
  chips.find((chip) => chip.id === id) ?? chips[0]!

/** The inventory type a bag chip lists. */
export const bagTypeOf = (chip: ShopChip): GoodType => chip.sources[0]!.type

/**
 * Every good a chip sells, in catalogue order, each once. A chip can span
 * several mall types (推荐) and a good may sit on more than one page in the
 * source data, so the type travels with the id instead of being guessed back.
 */
export interface ShelfEntry {
  id: string
  type: GoodType
}

export function shelfEntries(catalog: ShopCatalog, chip: ShopChip): ShelfEntry[] {
  const seen = new Set<string>()
  const entries: ShelfEntry[] = []
  for (const source of chip.sources) {
    for (const page of catalog[source.tab]?.[source.type] ?? []) {
      for (const id of page) {
        if (seen.has(id)) continue
        seen.add(id)
        entries.push({ id, type: source.type })
      }
    }
  }
  return entries
}

export function shelfIds(catalog: ShopCatalog, chip: ShopChip): string[] {
  return shelfEntries(catalog, chip).map((entry) => entry.id)
}

export interface ShopPage {
  /** The slice on this page. */
  ids: string[]
  /** The clamped page number actually shown. */
  page: number
  /** At least 1, so an empty shelf still has a page to stand on. */
  totalPage: number
  count: number
  hasPrev: boolean
  hasNext: boolean
}

/** Clamps a page into `1..totalPage`; an empty or unknown total is page 1. */
export function clampPage(page: number, totalPage: number): number {
  const last = Number.isFinite(totalPage) ? Math.max(1, Math.floor(totalPage)) : 1
  if (!Number.isFinite(page)) return 1
  return Math.min(Math.max(Math.floor(page), 1), last)
}

export function paginate(ids: readonly string[], page: number, size = PAGE_SIZE): ShopPage {
  const step = Number.isFinite(size) && size > 0 ? Math.floor(size) : PAGE_SIZE
  const totalPage = Math.max(1, Math.ceil(ids.length / step))
  const at = clampPage(page, totalPage)
  return {
    ids: ids.slice((at - 1) * step, at * step),
    page: at,
    totalPage,
    count: ids.length,
    hasPrev: at > 1,
    hasNext: at < totalPage,
  }
}

/** Same order as desktop shop.ts `blocked`: a level gate wins, 粉钻 only when there is none. */
export type BlockReason = 0 | 1 | 2

export interface Buyable {
  needLevel?: number
  PD?: boolean
}

export interface BuyerContext {
  level: number
  pd: boolean
}

export function blockedReason(good: Buyable, ctx: BuyerContext): BlockReason {
  if (good.needLevel) return good.needLevel > ctx.level ? 1 : 0
  return good.PD && !ctx.pd ? 2 : 0
}

export interface PurchaseContext extends BuyerContext {
  balance: number
}

export const purchaseTotal = (unitPrice: number, quantity: number): number =>
  Math.max(0, Math.round(unitPrice * quantity))

/**
 * Why a purchase would fail, as a line the panel can show; '' when it can go
 * ahead. The checks mirror what buy() itself refuses, in the same order.
 */
export function purchaseProblem(
  good: Buyable,
  ctx: PurchaseContext,
  quantity: number,
  unitPrice: number,
): string {
  if (!Number.isFinite(quantity) || quantity < 1) return '请先选择购买数量'
  const reason = blockedReason(good, ctx)
  if (reason === 1) return `等级不足：需要 Lv.${good.needLevel}，你的宠物还没到这个等级`
  if (reason === 2) return '需要粉钻贵族会员才能购买'
  const total = purchaseTotal(unitPrice, quantity)
  if (total > ctx.balance) return `元宝不足：需要 ${total}，现在只有 ${ctx.balance}`
  return ''
}

/** Quantity stepper: whole numbers, never below 1, never above `cap` (99). */
export function stepQuantity(quantity: number, delta: number, cap = MAX_QUANTITY): number {
  const limit = Number.isFinite(cap) ? Math.max(1, Math.floor(cap)) : MAX_QUANTITY
  if (Number.isNaN(delta)) return clampQuantity(quantity, limit)
  if (delta === Number.POSITIVE_INFINITY) return limit
  if (delta === Number.NEGATIVE_INFINITY) return 1
  return clampQuantity(quantity + delta, limit)
}

const clampQuantity = (quantity: number, limit: number): number => {
  if (Number.isNaN(quantity)) return 1
  if (quantity === Number.POSITIVE_INFINITY) return limit
  if (quantity === Number.NEGATIVE_INFINITY) return 1
  return Math.min(Math.max(Math.round(quantity), 1), limit)
}

/** How many of `id` the inventory holds, from `_<id>*<count>` entries. */
export function ownedOf(inventory: readonly string[], id: string): number {
  const entry = inventory.find((value) => value.startsWith(`_${id}*`))
  if (entry === undefined) return 0
  const count = Number(entry.slice(id.length + 2))
  return Number.isFinite(count) ? count : 0
}

export interface ShopView {
  tab: ShopTab
  /** The selected chip of the active tab. */
  chip: string
  page: number
}

export const createShopView = (): ShopView => ({ tab: 'store', chip: defaultChip('store'), page: 1 })

/** Switching to the tab already showing keeps the shelf and the page untouched. */
export const selectTab = (view: ShopView, tab: ShopTab): ShopView =>
  view.tab === tab ? view : { tab, chip: defaultChip(tab), page: 1 }

export const selectChip = (view: ShopView, chip: string): ShopView => ({
  tab: view.tab,
  chip,
  page: 1,
})
