// The phone menu: the desktop popup (110 px wide, 21 px rows, side-flying
// submenus) rebuilt as a bottom action sheet at 1 CSS px = 1 dp. It reuses the
// exact item tree from menu.ts; phone-menu-model.ts owns grouping and inline
// expansion, this file only projects it to the sheet's DOM.
import { doctor } from '../../pet/items'
import { avatar, info, runtimeProjectionMode, save } from '../../pet/store'
import { openChat } from '../chat'
import { openGoods, openStudyPanel, openWorkPanel } from '../control'
import { div, img } from '../dom'
import { openEmail } from '../email'
import { showFacePoints } from '../face'
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
import { openSheet, type SheetHandle } from './sheet'
import './menu-phone.css'

/** The open phone menu, so a second request replaces it instead of stacking sheets. */
let current: SheetHandle | null = null

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

function stat(label: string, cls: string, value: number, max: number): HTMLElement {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0
  const fill = div(`qp-menu-stat-fill ${cls}`)
  fill.style.width = `${Math.round(ratio * 100)}%`
  const meter = div('qp-menu-stat-track', fill)
  const cell = div(
    'qp-menu-stat',
    div('qp-menu-stat-head', div('qp-menu-stat-label', label), div('qp-menu-stat-value', String(Math.round(value)))),
    meter,
  )
  cell.setAttribute('role', 'img')
  cell.setAttribute('aria-label', `${label} ${Math.round(value)} / ${max}`)
  return cell
}

/** Avatar, name, level and the three care meters; a tap opens the pet's profile. */
function header(onOpen: () => void): HTMLElement {
  const computed = save.petComputedlInfo
  const who = div(
    'qp-menu-who',
    div('qp-menu-name', info.name),
    div('qp-menu-meta', div('qp-menu-level', `Lv.${computed.level}`), arrow(false)),
  )
  const stats = div(
    'qp-menu-stats',
    stat('饥饿', 'qp-stat-hunger', info.hunger, computed.hungerMax),
    stat('清洁', 'qp-stat-clean', info.clean, computed.cleanMax),
    stat('心情', 'qp-stat-mood', info.mood, computed.moodMax),
  )
  const head = div('qp-menu-head', img('qp-menu-avatar', avatar()), who, stats)
  head.tabIndex = 0
  head.setAttribute('role', 'button')
  head.setAttribute('aria-label', `宠物档案：${info.name} 等级 ${computed.level}`)
  activate(head, onOpen)
  return head
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
  let fired = false
  const pickAndClose = (item: MenuItem): void => {
    if (fired) return
    fired = true
    handle?.close()
    item.run?.()
  }
  const body = div('qp-menu')
  if (save.havePet && !save.isBury) body.append(header(() => {
    // The profile must be mounted before the sheet animates away; the sheet's
    // own close then reveals it instead of leaving a dead tap.
    openPetInfo()
    handle?.close()
  }))
  if (save.havePet && !save.isBury) {
    body.append(shortcuts((id) => {
      handle?.close()
      if (id === 'face') showFacePoints()
      else openGoods(id)
    }))
  }
  for (const entry of sections) body.append(section(entry, () => view, (next) => { view = next }, pickAndClose))

  handle = openSheet({
    title: 'QQ宠物',
    body,
    cardClass: 'qp-menu-card',
    onClose: () => {
      if (current === handle) current = null
    },
  })
  current = handle
  // The panel opens under the finger that tapped the pet, so a second tap would
  // either hit the first row (和我聊天) or the backdrop (and close it again).
  // Ignore the whole layer for the length of the open animation; the tap falls
  // through to the pet, whose handler sees the menu already open.
  handle.el.style.pointerEvents = 'none'
  setTimeout(() => {
    handle.el.style.pointerEvents = ''
  }, 220)
}
