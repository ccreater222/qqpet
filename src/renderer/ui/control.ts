import { describe, type Good, type GoodType } from '../pet/data/goods'
import { toolbarScaleFor } from '../../shared/layout'
import { listGoods, onGoodsChange, pageOf, type Page } from '../pet/goods'
import { doctor, useItem } from '../pet/items'
import { describeStudy, describeWork, study, studyGoods, work, workGoods } from '../pet/jobs'
import { info, onInfoChange, petSize, runtimeProjectionMode, save } from '../pet/store'
import { viewportSize } from './viewport'
import './css/control.css'
import { button, div, img, touch } from './dom'
import { openSheet } from './mobile/sheet'
import { phoneUI } from './mobile/sizing'
import { openCommunity } from './community'
import { openEmail } from './email'
import { openFarm } from './farm'
import { openFishing } from './fishing'
import { openGames } from './games'
import { openIslandRuntime } from './island-runtime'
import { openMstx } from './mstx'
import { openPetInfo } from './petinfo'
import { progress } from './progress'
import { openSetup } from './setup'
import { openShop } from './shop'
import { openSignIn } from './signin'
import { visitFriend } from './visit'
import { setBubbleLift } from './talk'
import { openTask } from './task'
import { openTravel } from './travel'

const ICONS = 'pet/control/icons/'
const BAR_HEIGHT = 180
/** The goods panel, the bar's widest part. */
const BAR_WIDTH = 314
const EDGE = 10
/** Where the penguin's head and feet sit in the pet box; the swf leaves the rest transparent. */
const HEAD = 0.4
const FEET = 0.95
/** A finger needs longer than a mouse to find the next button. */
const HIDE_MS = touch ? 5000 : 1500
const PAGE = 4

type Stat = 'hunger' | 'clean' | 'health' | 'mood'

/** A list of goods to pick from, 4 per page. */
interface Panel {
  icon: string
  list: (page: number) => Page
  lines: (g: Good) => string[]
  /** Returns true when the panel should close. */
  use: (g: Good) => boolean
  /** Everyday panels: the inventory type shown, with the bar of the stat it restores and a shop link. */
  type?: GoodType
  stat?: Stat
}

interface Entry {
  name: string
  icon: string
  run: () => void
}

const activeIcon = (n: number): string => `${ICONS}active/${n}.svg`

const inventoryPanel = (type: GoodType, icon: number, stat: Stat): Panel => ({
  icon: activeIcon(icon),
  list: (page) => listGoods(type, page, PAGE),
  lines: (g) => [...describe(g), `数量：${g.num}`],
  use: (g) => {
    useItem(g)
    return false
  },
  type,
  stat,
})

const PANELS = {
  food: inventoryPanel('food', 18, 'hunger'),
  clean: inventoryPanel('clean', 20, 'clean'),
  medicine: inventoryPanel('medicine', 22, 'health'),
  toy: inventoryPanel('toy', 28, 'mood'),
}

/** On a phone the icon bar is gone: the same inventory opens as a bottom sheet. */
const PHONE_GOODS_TITLES: Record<keyof typeof PANELS, string> = {
  food: '喂养',
  clean: '清洁',
  medicine: '吃药',
  toy: '玩耍',
}

interface PhoneGoods {
  type: keyof typeof PANELS
  draw: () => void
  close: () => void
}

/** The open phone goods sheet, so an inventory change repaints it in place. */
let phoneGoods: PhoneGoods | null = null

/**
 * The everyday goods panel as a phone sheet: one 64 dp row per good (40 dp icon,
 * 15 px name, 13 px description), 44 dp paging, 去购物 kept at the bottom.
 * A tap uses the good at once instead of the toolbar's tap-to-preview dance.
 */
function openPhoneGoods(type: keyof typeof PANELS): void {
  phoneGoods?.close()
  const panel = PANELS[type]
  let page = 1
  let sheet: ReturnType<typeof openSheet> | null = null
  let self: PhoneGoods | null = null
  const content = div('qp-goods')
  const draw = (): void => {
    const { list: goods, totalPage } = panel.list(page)
    page = Math.min(Math.max(page, 1), Math.max(totalPage, 1))
    const rows = goods.map((g) => {
      const row = div('qp-row qp-goods-row')
      row.setAttribute('role', 'button')
      row.tabIndex = 0
      row.append(
        img('qp-goods-icon', g.url),
        div('qp-goods-main', div('qp-goods-name', g.name), ...panel.lines(g).map((line) => div('qp-goods-line', line))),
      )
      const use = (): void => {
        if (!self) return
        if (panel.use(g)) return void sheet?.close()
        draw()
      }
      row.addEventListener('click', use)
      row.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        use()
      })
      return row
    })
    const prev = button('qp-btn qp-btn-ghost qp-goods-page', () => {
      if (page > 1) {
        page -= 1
        draw()
      }
    }, '上一页')
    const next = button('qp-btn qp-btn-ghost qp-goods-page', () => {
      if (page < totalPage) {
        page += 1
        draw()
      }
    }, '下一页')
    if (page <= 1) prev.setAttribute('aria-disabled', 'true')
    if (page >= totalPage) next.setAttribute('aria-disabled', 'true')
    const pager = div(
      'qp-goods-pager',
      prev,
      div('qp-goods-pageinfo', totalPage ? `第 ${page} / ${totalPage} 页` : '暂无物品'),
      next,
    )
    const stat = panel.stat
      ? (() => {
          const max = save.petComputedlInfo[`${panel.stat}Max`]
          return div(
            'qp-goods-stat',
            div('qp-goods-stat-label', '当前'),
            progress(info[panel.stat], max),
            div('qp-goods-stat-value', `${Math.round(info[panel.stat])} / ${max}`),
          )
        })()
      : null
    content.replaceChildren(...(stat ? [stat] : []), ...(rows.length ? rows : [div('qp-goods-none', '空空如也~~')]), pager)
  }
  const footer = panel.stat
    ? div(
        'qp-footer',
        button('qp-btn', () => {
          sheet?.close()
          openShop()
        }, '去购物'),
      )
    : undefined
  const handle = openSheet({
    title: PHONE_GOODS_TITLES[type],
    body: content,
    footer,
    onClose: () => {
      if (phoneGoods === self) phoneGoods = null
    },
  })
  sheet = handle
  self = { type, draw, close: () => handle.close() }
  phoneGoods = self
  draw()
}

/** A menu group opens its children on hover, or runs `run` on click. */
const MENU: { name: string; icon: string; children?: Entry[]; run?: () => void }[] = [
  {
    name: '日常',
    icon: 'richang.png',
    children: [
      { name: '食物', icon: 'weishi.png', run: () => openPanel(PANELS.food) },
      { name: '清洁', icon: 'qingjie.png', run: () => openPanel(PANELS.clean) },
      { name: '吃药', icon: 'zhibing.png', run: () => openPanel(PANELS.medicine) },
      { name: '玩具', icon: 'wanshua.png', run: () => openPanel(PANELS.toy) },
    ],
  },
  {
    name: '交互',
    icon: 'chongwu.png',
    children: [
      {
        name: '打工',
        icon: 'dagong.png',
        run: () => openPanel({ icon: activeIcon(26), list: (page) => pageOf(workGoods(), page, PAGE), lines: describeWork, use: work }),
      },
      {
        name: '学习',
        icon: 'xuexi.png',
        run: () => openPanel({ icon: activeIcon(24), list: (page) => pageOf(studyGoods(), page, PAGE), lines: describeStudy, use: study }),
      },
      { name: '旅游', icon: 'lvyou.png', run: openTravel },
      { name: '看病', icon: 'zhibing.png', run: doctor },
    ],
  },
  {
    name: '工具',
    icon: 'renwu.png',
    children: [
      { name: '邮箱', icon: 'haoyou.png', run: openEmail },
      { name: '任务', icon: 'renwu1.png', run: openTask },
      { name: '签到', icon: 'juanzhou00.png', run: openSignIn },
      { name: '设置', icon: 'guanli.png', run: openSetup },
    ],
  },
  {
    name: '活动',
    icon: 'gonggao.png',
    children: [
      { name: '池塘', icon: 'fish01.png', run: openFishing },
      { name: '农场', icon: 'nongchang01.png', run: openFarm },
      { name: '游戏', icon: 'game.svg', run: openGames },
      { name: '密室', icon: 'mstx.png', run: openMstx },
      { name: '社区', icon: 'shequ.png', run: openCommunity },
    ],
  },
  { name: '档案', icon: 'dangan.png', run: openPetInfo },
]

/** Runtime mode exposes converted panels only: fishing, farm, games, the command-driven island and LAN visits. */
const runtimeMenu = MENU.map((group) =>
  group.name === '活动'
    ? {
        ...group,
        children: [
          ...(group.children
            ?.map((child) => (child.name === '社区' ? { ...child, name: '企鹅岛', run: openIslandRuntime } : child))
            .filter((child) => child.name === '池塘' || child.name === '游戏' || child.name === '企鹅岛' || child.name === '农场') ?? []),
          { name: '找朋友玩', icon: 'chongwu.png', run: visitFriend },
        ],
      }
    : group,
).filter((group) => group.children === undefined || group.children.length > 0)
const visibleMenu = runtimeProjectionMode ? runtimeMenu : MENU

const control = div('control')
control.dataset.hit = ''
document.body.appendChild(div('ui-control', control))

let shown = false
let hideTimer = 0
let introTimer = 0
let open: (Panel & { page: number }) | null = null

/**
 * Visible page box the bar must stay inside. Desktop uses the overlay size; when Android zooms the
 * layout viewport above what is shown, prefer the visual viewport so the panel is not clipped (#124 #103).
 */
function screenBox(): { left: number; top: number; width: number; height: number } {
  const base = touch ? { width: innerWidth, height: innerHeight } : viewportSize()
  const vv = window.visualViewport
  if (vv && vv.scale > 1.01) {
    return {
      left: vv.offsetLeft,
      top: vv.offsetTop,
      width: Math.min(vv.width, base.width),
      height: Math.min(vv.height, base.height),
    }
  }
  return { left: 0, top: 0, width: base.width, height: base.height }
}

/**
 * Centered under the pet's feet; when there is no room below, mirrored above its head. Kept on screen.
 * Native iPads use the original toolbar size; other touch hosts grow it with the pet.
 */
function place(): void {
  const size = petSize()
  const box = screenBox()
  const scale = toolbarScaleFor(size, (box.width - 2 * EDGE) / BAR_WIDTH, touch, window.qqpet.deviceKind)
  const height = BAR_HEIGHT * scale
  const half = (BAR_WIDTH * scale) / 2 + EDGE
  const feet = info.lastY + size * FEET
  const onTop = feet > box.top + box.height - EDGE - height
  control.classList.toggle('up', onTop)
  // Prefer the pet's center, then clamp so the 314px goods panel (scaled) stays fully visible (#124).
  const center = Math.min(Math.max(info.lastX + size / 2, box.left + half), box.left + box.width - half)
  control.style.left = `${center}px`
  control.style.top = `${onTop ? info.lastY + size * HEAD : feet}px`
  control.style.transform = `scale(${scale})`
  setBubbleLift(shown && onTop ? Math.max(height - size * HEAD, 0) : 0)
  // Tooltips and submenus can still stick out: nudge after layout if children overflow the visible box.
  requestAnimationFrame(() => {
    if (!shown) return
    let minL = center
    let maxR = center
    for (const child of control.children) {
      const r = (child as HTMLElement).getBoundingClientRect()
      if (r.width <= 0 && r.height <= 0) continue
      minL = Math.min(minL, r.left)
      maxR = Math.max(maxR, r.right)
    }
    let shift = 0
    if (maxR > box.left + box.width - EDGE) shift = box.left + box.width - EDGE - maxR
    if (minL + shift < box.left + EDGE) shift = box.left + EDGE - minL
    if (shift) control.style.left = `${center + shift}px`
    control.classList.toggle('nearRight', center + shift > box.left + box.width / 2)
  })
}

/** A tap leaves its menu hovered, children shown: on touch the bar goes once a child is picked, unless it opened a goods panel. */
function pick(run: () => void): void {
  run()
  if (touch && !open) hide()
}

const icons: HTMLElement[] = []
const menus = div(
  'menus fcc',
  ...visibleMenu.map((g) => {
    const icon = div('menuItemIconBox', img('menuItemIcon', ICONS + g.icon))
    icons.push(icon)
    const item = div(
      'menuItem fcc focusPress',
      div('menuTip', g.name),
      icon,
      ...(g.children
        ? [div('childrenMenu', ...g.children.map((c) => button('childrenMenuItem fc', () => pick(c.run), img('childrenMenuItemIcon', ICONS + c.icon), ` ${c.name}`)))]
        : []),
    )
    if (g.run) item.addEventListener('click', g.run)
    item.addEventListener('mouseenter', () => {
      clearTimeout(introTimer)
      highlight(-1)
      clearTimeout(hideTimer)
    })
    item.addEventListener('mouseleave', scheduleHide)
    return item
  }),
)
control.appendChild(menus)

const highlight = (n: number): void => icons.forEach((icon, i) => icon.classList.toggle('hoverMenuItemIcon', i === n))

/** Lights the menu icons up one after another when the bar appears. */
function intro(n = 0): void {
  highlight(n)
  if (n < icons.length) introTimer = window.setTimeout(() => intro(n + 1), 150)
}

/** Pressing the pet shows the bar. */
export function showControl(): void {
  if (save.isBury) return
  clearTimeout(hideTimer)
  if (shown) return
  shown = true
  control.classList.add('showControl')
  place()
  intro()
}

/** Shows the bar with an everyday goods panel open; on a phone the panel is a bottom sheet instead. */
export function openGoods(type: keyof typeof PANELS): void {
  if (phoneUI()) return openPhoneGoods(type)
  showControl()
  openPanel(PANELS[type])
}

/** The bar hides 1.5 s (5 s on touch screens) after the pointer leaves it, unless an inventory panel is open. */
export function scheduleHide(): void {
  clearTimeout(hideTimer)
  if (open) return
  hideTimer = window.setTimeout(hide, HIDE_MS)
}

function hide(): void {
  shown = false
  control.classList.remove('showControl')
  place()
}

let list: HTMLElement | null = null
/** The stat bar of the open panel, updated in place so a tick does not rebuild the goods under a finger. */
let bar: HTMLElement | null = null
/** The good a touch already previewed; it survives rebuilds of the same panel (a count change, a page turn). */
let picked: string | null = null

function openPanel(p: Panel, page = 1): void {
  if (open?.type !== p.type || open?.icon !== p.icon) picked = null
  open = { ...p, page }
  bar = null
  menus.style.display = 'none'
  const { list: goods, totalPage } = p.list(page)
  const turn = (d: number) => (): void => {
    if (page + d >= 1 && page + d <= totalPage) openPanel(p, page + d)
  }
  const items = goods.map((g: Good) =>
    div(
      'goodItem',
      div(
        'goodItemIconBox fcc',
        div('goodInfo', div('goodName', g.name), ...p.lines(g).map((l) => div('goodDatas', l))),
        Object.assign(img('goodItemIcon', g.url), {
          onclick: () => {
            // A tap hovers what it touches: the first one shows the good's info, the next uses it.
            if (touch && picked !== g.id) return void (picked = g.id)
            picked = null
            if (p.use(g)) closePanel()
          },
        }),
      ),
    ),
  )
  const next = div(
    'goodList focusPress',
    img('goodTypeIcon', p.icon),
    ...(p.stat ? [button('toShoppingMall', openShop, '去购物')] : []),
    button('goodClose', closePanel),
    div(
      'goodListMain fcc',
      button('toLeft', turn(-1)),
      div(
        'goods f1 fC h100',
        div('fc f1', ...(items.length ? items : [div('goodsNone tc w100', ' 空空如也~~ ')])),
        ...(p.stat ? [(bar = div('progress', progress(info[p.stat], save.petComputedlInfo[`${p.stat}Max`])))] : []),
      ),
      button('toRight', turn(1)),
    ),
  )
  if (list) list.replaceWith(next)
  else control.appendChild(next)
  list = next
  place()
}

function closePanel(): void {
  open = null
  list?.remove()
  list = null
  bar = null
  picked = null
  menus.style.display = ''
  scheduleHide()
}

onInfoChange((key) => {
  if (key === 'lastX' || key === 'lastY' || key === 'growth') place()
  // 只换进度条：整块重建会丢掉手指刚点过的预览，第二下又变成预览，物品用不出去
  if (open?.stat && key === open.stat && bar) {
    const next = div('progress', progress(info[open.stat], save.petComputedlInfo[`${open.stat}Max`]))
    bar.replaceWith(next)
    bar = next
  }
})
onGoodsChange((type) => {
  if (phoneGoods?.type === type) phoneGoods.draw()
  if (open?.type === type) openPanel(open, Math.min(open.page, Math.max(open.list(1).totalPage, 1)))
})
