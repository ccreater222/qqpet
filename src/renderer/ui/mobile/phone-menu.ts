// The phone menu: the desktop popup (110 px wide, 21 px rows, side-flying
// submenus) rebuilt as a bottom action sheet at 1 CSS px = 1 dp. It reuses the
// exact item tree from menu.ts; phone-menu-model.ts owns grouping and inline
// expansion, this file only projects it to the sheet's DOM.
//
// 顶部新增「宠物舞台」：sheet 打开后把真实 #pet 搬进滚动内容的第一块放大显示，
// 点位负责逗宠；往下滚会随列表滚走。舞台高度与几何见 pet-stage.ts。
import { doctor } from '../../pet/items'
import { machine } from '../../pet/pet'
import { edgeSide, info, onInfoChange, runtimeProjectionMode, save } from '../../pet/store'
import { openChat } from '../chat'
import { openGoods, openStudyPanel, openWorkPanel } from '../control'
import { div, img } from '../dom'
import { openEmail } from '../email'
import { clearFacePoints, showFacePoints } from '../face'
import { sendLetter } from '../lan-visit'
import { closeMenu, menuItems, restNow, type MenuItem } from '../menu'
import { openPetInfo } from '../petinfo'
import { openSignIn } from '../signin'
import { openTask } from '../task'
import { openTravel } from '../travel'
import {
  createMenuView,
  groupMenuItems,
  isRowExpanded,
  menuRowKey,
  toggleMenuRow,
  type MenuSection,
  type MenuSectionId,
  type MenuView,
} from './phone-menu-model'
import { openPetStage, type PetStageHandle } from './pet-stage'
import { openSheet, type SheetHandle } from './sheet'
import './menu-phone.css'

/** The open phone menu, so a second request replaces it instead of stacking sheets. */
let current: SheetHandle | null = null

/**
 * 菜单头部的三条状态条只在打开时构建一次；逗宠/后台把心情、饥饿、清洁改掉时要立刻重画。
 * onInfoChange 没有退订接口，所以模块顶层只注册一次：开菜单时换目标，关闭时只清自己那份。
 */
let refreshStats: (() => void) | null = null
onInfoChange((key) => {
  if (key === 'hunger' || key === 'clean' || key === 'mood') refreshStats?.()
})

const activate = (row: HTMLElement, onActivate: () => void): void => {
  row.setAttribute('role', 'button')
  row.tabIndex = 0
  row.addEventListener('click', onActivate)
  row.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    onActivate()
  })
}

const arrow = (expandable: boolean): HTMLElement => div(expandable ? 'qp-caret qp-menu-arrow' : 'qp-chevron qp-menu-arrow', '›')

type Shortcut = 'food' | 'clean' | 'medicine' | 'face' | 'toy'

/**
 * The everyday actions that used to need the icon toolbar and its hover
 * submenus. Toys are the fifth tile: on the phone they used to hide behind the
 * pet's mood meter only, which no one could discover.
 */
const SHORTCUTS: readonly { id: Shortcut; label: string; icon: string }[] = [
  { id: 'food', label: '喂养', icon: 'pet/control/icons/active/18.svg' },
  { id: 'clean', label: '清洁', icon: 'pet/control/icons/active/20.svg' },
  { id: 'medicine', label: '吃药', icon: 'pet/control/icons/active/22.svg' },
  { id: 'face', label: '逗它', icon: 'pet/face/click.svg' },
  { id: 'toy', label: '玩具', icon: 'pet/control/icons/active/28.svg' },
]

/** The 5-tile quick actions: every tile is a 72 dp thumb target of its own. */
function shortcuts(onPick: (id: Shortcut) => void): HTMLElement {
  const grid = div('qp-menu-shortcut-grid')
  for (const shortcut of SHORTCUTS) {
    const tile = div('qp-shortcut', img('qp-shortcut-icon', shortcut.icon), div('qp-shortcut-label', shortcut.label))
    activate(tile, () => onPick(shortcut.id))
    grid.append(tile)
  }
  return div('qp-menu-shortcuts', div('qp-section qp-menu-section-title', '快捷操作'), grid)
}

interface MenuStat {
  el: HTMLElement
  refresh(): void
}

/** 一条状态条；数字/条宽由 refresh() 读最新值，舞台里逗宠后能立刻变。 */
function stat(label: string, cls: string, read: () => [value: number, max: number]): MenuStat {
  const fill = div(`qp-menu-stat-fill ${cls}`)
  const valueEl = div('qp-menu-stat-value')
  const meter = div('qp-menu-stat-track', fill)
  const cell = div('qp-menu-stat', div('qp-menu-stat-head', div('qp-menu-stat-label', label), valueEl), meter)
  cell.setAttribute('role', 'img')
  const refresh = (): void => {
    const [value, max] = read()
    const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0
    valueEl.textContent = String(Math.round(value))
    fill.style.width = `${Math.round(ratio * 100)}%`
    cell.setAttribute('aria-label', `${label} ${Math.round(value)} / ${max}`)
  }
  refresh()
  return { el: cell, refresh }
}

interface MenuHeader {
  el: HTMLElement
  refresh(): void
}

/** 昵称、等级和三条状态条；点击进宠物档案。48dp 头像已由顶部宠物舞台代替。 */
function header(onOpen: () => void): MenuHeader {
  const computed = save.petComputedlInfo
  const who = div(
    'qp-menu-who',
    div('qp-menu-name', info.name),
    div('qp-menu-meta', div('qp-menu-level', `Lv.${computed.level}`), arrow(false)),
  )
  // 上限也从当前的 petComputedlInfo 读，升级/投影变化后不会停在旧值。
  const stats = [
    stat('饥饿', 'qp-stat-hunger', () => [info.hunger, save.petComputedlInfo.hungerMax]),
    stat('清洁', 'qp-stat-clean', () => [info.clean, save.petComputedlInfo.cleanMax]),
    stat('心情', 'qp-stat-mood', () => [info.mood, save.petComputedlInfo.moodMax]),
  ]
  const head = div('qp-menu-head', who, div('qp-menu-stats', ...stats.map((one) => one.el)))
  head.tabIndex = 0
  head.setAttribute('role', 'button')
  head.setAttribute('aria-label', `宠物档案：${info.name} 等级 ${computed.level}`)
  activate(head, onOpen)
  return { el: head, refresh: () => { for (const one of stats) one.refresh() } }
}

function childRow(item: MenuItem, onPick: (item: MenuItem) => void): HTMLElement {
  const row = div(`qp-row qp-menu-sub-row${item.danger ? ' qp-danger' : ''}`, div('qp-row-grow qp-menu-label', item.label), div('qp-chevron qp-menu-arrow', '›'))
  if (item.title) row.title = item.title
  if (item.on) row.prepend(div('qp-menu-check', '✓'))
  activate(row, () => onPick(item))
  return row
}

function parentRow(
  section: MenuSectionId,
  index: number,
  item: MenuItem,
  view: () => MenuView,
  setView: (next: MenuView) => void,
  onPick: (item: MenuItem) => void,
): HTMLElement {
  const key = menuRowKey(section, index)
  const subId = `qp-menu-sub-${section}-${index}`
  const sub = div('qp-menu-sub')
  sub.id = subId
  sub.append(div('qp-menu-sub-inner', ...item.children!.map((child) => childRow(child, onPick))))
  sub.toggleAttribute('inert', true)
  sub.setAttribute('aria-hidden', 'true')

  const row = div(
    `qp-row qp-menu-row qp-menu-parent${item.danger ? ' qp-danger' : ''}`,
    item.on ? div('qp-menu-check', '✓') : '',
    div('qp-row-grow qp-menu-label', item.label),
    arrow(true),
  )
  if (item.title) row.title = item.title
  row.setAttribute('aria-expanded', 'false')
  row.setAttribute('aria-controls', subId)
  activate(row, () => {
    setView(toggleMenuRow(view(), key))
    const expanded = isRowExpanded(view(), key)
    row.setAttribute('aria-expanded', String(expanded))
    sub.classList.toggle('qp-open', expanded)
    sub.toggleAttribute('inert', !expanded)
    sub.setAttribute('aria-hidden', String(!expanded))
  })
  return div('qp-menu-item', row, sub)
}

function itemRow(item: MenuItem, onPick: (item: MenuItem) => void): HTMLElement {
  const row = div(
    `qp-row qp-menu-row${item.danger ? ' qp-danger' : ''}`,
    item.on ? div('qp-menu-check', '✓') : '',
    div('qp-row-grow qp-menu-label', item.label),
    arrow(false),
  )
  if (item.title) row.title = item.title
  activate(row, () => onPick(item))
  return div('qp-menu-item', row)
}

function section(section: MenuSection, view: () => MenuView, setView: (next: MenuView) => void, onPick: (item: MenuItem) => void): HTMLElement {
  const wrap = div(`qp-menu-section qp-menu-section-${section.id}`)
  wrap.append(div(section.id === 'danger' ? 'qp-section qp-menu-section-title qp-menu-danger-title' : 'qp-section qp-menu-section-title', section.title))
  section.items.forEach((item, index) => {
    wrap.append(item.children?.length ? parentRow(section.id, index, item, view, setView, onPick) : itemRow(item, onPick))
  })
  return wrap
}

/**
 * Entries the desktop reaches from the floating icon toolbar (control.ts MENU).
 * main.ts never shows that bar once the page is laid out at 1 CSS px = 1 dp, so
 * without these rows 签到/任务/打工/学习/旅游/看病 have no phone entry at all, and
 * 邮箱/玩具/休息一下/去朋友家送信 only existed behind a conditional bubble or a
 * legacy submenu (review 05-review-c §3). They are added to the phone sheet only:
 * runtimeMenuItems stays the exact desktop runtime tree.
 */
function phoneEntries(runtime: boolean): MenuItem[] {
  const entries: MenuItem[] = [
    // 工具: daily actions, one tap from the first screen.
    { label: '邮箱', group: 'tools', run: openEmail },
    { label: '任务', group: 'tools', run: openTask },
    { label: '签到', group: 'tools', run: openSignIn },
    // 互动: the toolbar's own entries. 打工/学习 open the same panel data from
    // control.ts as a bottom sheet; the rest reuse their existing implementations.
    { label: '打工', group: 'interact', run: openWorkPanel },
    { label: '学习', group: 'interact', run: openStudyPanel },
    { label: '旅游', group: 'interact', run: openTravel },
    { label: '看病', group: 'interact', run: doctor },
  ]
  // The legacy tree already carries these two under 一起玩耍; only the runtime
  // tree (the Android default) has no such submenu.
  if (runtime) {
    entries.push(
      { label: '休息一下', group: 'interact', run: restNow },
      { label: '去朋友家送信', group: 'interact', run: sendLetter },
    )
  }
  return entries
}

/**
 * Opens the phone action sheet at the bottom of the screen. `at` is accepted for
 * parity with openMenu (the sheet ignores the requested point); picking an entry
 * closes the sheet first and then runs the item, exactly like the desktop pick.
 */
export function openPhoneMenu(at: { x: number; y: number; pet: boolean }, adopt: () => void): void {
  void at
  // 轻点宠物会先把桌面热点画出来（showFacePointsAfterClick）；这里先清掉按 187dp 盒子
  // 算出的点位，等舞台把宠物放大到 300dp 后按新尺寸重新画，避免点位错位。
  clearFacePoints()
  closeMenu()
  current?.close()
  current = null

  // Phone-only gap: the Android runtime tree omits chat and the entire icon-toolbar
  // group, and a phone has no toolbar to fall back on. The shared desktop menu is
  // untouched: chat joins 互动 here, and phoneEntries appends the toolbar rows.
  const items = menuItems(adopt)
  if (save.havePet && !save.isBury && info.health > 0) {
    if (runtimeProjectionMode) items.unshift({ label: '和我聊天', group: 'interact', run: openChat })
    items.push(...phoneEntries(runtimeProjectionMode))
  }
  const sections = groupMenuItems(items)
  let view = createMenuView()
  let handle: SheetHandle | null = null
  let stageHandle: PetStageHandle | null = null
  let pointWatcher: number | null = null
  let fired = false
  // 舞台层级 695 高于新开的 sheet（690）：点条目会立刻打开另一个面板，必须在关菜单前
  // 先释放舞台，否则关闭动画的 180ms 里放大的宠物会压在新面板上面。
  const releaseStage = (): void => {
    if (pointWatcher !== null) {
      clearInterval(pointWatcher)
      pointWatcher = null
    }
    stageHandle?.close()
    stageHandle = null
  }
  const pickAndClose = (item: MenuItem): void => {
    if (fired) return
    fired = true
    releaseStage()
    handle?.close()
    item.run?.()
  }
  const hasPet = save.havePet && !save.isBury
  const body = div('qp-menu')
  let ownRefresh: (() => void) | null = null
  let stageSlot: HTMLElement | null = null
  if (hasPet) {
    // 轻点结束会把贴着屏幕侧边的宠物切到 Hide_left/right（input 的 end 先于菜单打开，而且
    // 新姿态可能还在 machine 的队列里）：舞台放大的正是这只宠物，剪影放大后只剩一条黑线，
    // 所以只要位置贴边就主动唤回站姿。edgeSide() 只看位置，能同时盖住已在播和刚排队的躲藏；
    // 动画结束后的兜底躲边由 store 的 applyEdge() 舞台守卫负责，这里不用重复处理。
    if (edgeSide() !== null) machine.play({ a: 'normal' })
    // 舞台是滚动内容的第一块：随列表一起滚走，而不是固定在标题栏下面。
    stageSlot = div('qp-menu-pet-slot')
    const stage = div('qp-menu-pet-stage', stageSlot)
    // 只要互动没关（faceClick=1/2）就给提示；点位本身在舞台里是隐形的。
    if (save.settings.faceClick !== 0) stage.append(div('qp-menu-pet-hint', '点击宠物逗它'))
    // 舞台本身只是宠物容器：点空白/宠物身体＝把可点部位重新显示出来；真正的逗宠是 .point 的 click。
    stage.addEventListener('click', () => {
      // 正在播 interact（预载/播放）时不补点位；其余情况点身体＝重新显示可点部位，不逗宠。
      if (document.querySelector('#pet ruffle-player[data-swf*="/interact/"]')) return
      showFacePoints()
    })
    body.append(stage)
  }
  if (hasPet) {
    const head = header(() => {
      // The profile must be mounted before the sheet animates away; the sheet's
      // own close then reveals it instead of leaving a dead tap.
      openPetInfo()
      releaseStage()
      handle?.close()
    })
    body.append(head.el)
    ownRefresh = head.refresh
  }
  if (hasPet) {
    body.append(shortcuts((id) => {
      if (id === 'face') {
        // 原地显示可点部位，不关菜单、不直接逗宠；点位自己的 click 才会触发 interact 动画。
        showFacePoints()
        return
      }
      releaseStage()
      handle?.close()
      openGoods(id)
    }))
  }
  for (const entry of sections) body.append(section(entry, () => view, (next) => { view = next }, pickAndClose))

  handle = openSheet({
    title: 'QQ宠物',
    body,
    cardClass: 'qp-menu-card',
    onClose: () => {
      // ✕、遮罩、下滑、返回键都汇到 sheet 的 close()，所以舞台在这里兜底释放一次。
      releaseStage()
      // 只清自己那份：新菜单可能已在旧 sheet 的关闭动画里接管了 refreshStats。
      if (refreshStats === ownRefresh) refreshStats = null
      if (current === handle) current = null
    },
  })
  current = handle
  refreshStats = ownRefresh
  if (stageSlot) {
    stageHandle = openPetStage(stageSlot)
    // 打开时宠物可能还在换装/回站姿（例如贴边唤回），先画一次；之后每 400ms 补一次：
    // poke 播完会清空 .face 层，showFacePoints 自己按 faceClick/姿势门控决定何时重建。
    showFacePoints()
    // interact 片在预载/播放时不能补点位（pose 的切换晚于 SWF 的 data-swf 更新）。
    const pointsIdle = (): boolean => document.querySelector('#pet ruffle-player[data-swf*="/interact/"]') === null
    pointWatcher = window.setInterval(() => {
      if (pointsIdle()) showFacePoints()
    }, 400)
  }
  // The panel opens under the finger that tapped the pet, so a second tap would
  // either hit the first row (和我聊天) or the backdrop (and close it again).
  // Ignore the whole layer for the length of the open animation; the tap falls
  // through to the pet, whose handler sees the menu already open.
  handle.el.style.pointerEvents = 'none'
  setTimeout(() => {
    handle.el.style.pointerEvents = ''
  }, 220)
}
