// The phone sign-in page. The desktop window (ui/signin.ts) is 737x485: a
// 505 px illustrated collection beside a 200 px calendar, so on a 412 dp phone
// box.ts either clips the calendar column off the right edge (the old
// `.qp-panel` width cap) or shrinks the whole panel to 0.53 and leaves 6.4 dp
// text with 11.7 dp day cells. This page keeps the same store data and the same
// sign / gift / collection functions but lays them out at 1 CSS px = 1 dp:
// today's status and the 56 dp 今日签到 button first, then a 7-column month
// calendar with a >=44 dp cell per day, then the daily growth draw and online
// gift, then the collection as chips and two-column cards. The desktop window is
// untouched; only openSignIn()'s phone branch comes here.
import { allGoods, describe, type Good, type GoodType } from '../../pet/data/goods'
import POOLS from '../../pet/data/pool.json'
import { pay } from '../../pet/items'
import {
  birthdayGift,
  canDrawGrowth,
  drawGrowth,
  giftCost,
  monthSigns,
  signedToday,
  signin,
  signToday,
  takeOnlineGift,
} from '../../pet/signin'
import { info, onStoreEvent, runtimeProjectionMode, save } from '../../pet/store'
import { uiCommands } from '../../pet/command-map'
import { commandResultData, commandResultGoods, commandSucceeded, dispatchRuntimeCommand } from '../../pet/runtime-command'
import { dayStart } from '../../pet/vip'
import { div, img } from '../dom'
import { showResult } from '../result'
import { windowView } from '../window-view'
import { WEEKDAYS, monthGrid, stepMonth, tierCards, tierGoods, tierTitle, type CalendarCell } from './phone-pages-model'
import { openSheet, type SheetHandle } from './sheet'

/** Same six categories as the desktop tab bar (ui/signin.ts TYPES). */
const TYPES: { label: string; type: GoodType }[] = [
  { label: '食物', type: 'food' },
  { label: '日用品', type: 'clean' },
  { label: '玩具', type: 'toy' },
  { label: '药品', type: 'medicine' },
  { label: '背景', type: 'background' },
  { label: '属性', type: 'nums' },
]
/** The loot pools of pool.json, in the desktop's tier order. */
const TIERS = ['史诗', '传承', '稀有']

/** Click plus the keyboard activation a `div` does not get for free. */
const activate = (el: HTMLElement, run: () => void): void => {
  el.addEventListener('click', run)
  el.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    run()
  })
}

/** The open phone sign-in, so a second request replaces it instead of stacking sheets. */
let current: SheetHandle | null = null

/**
 * Opens the phone sign-in sheet. `signToday()`, `takeOnlineGift()` and
 * `drawGrowth()` are the desktop window's own functions; the runtime projection
 * path dispatches the same uiCommands the desktop does.
 */
export function openPhoneSignIn(): void {
  current?.close()
  current = null

  let sheet: SheetHandle | null = null
  let alive = true
  let type: GoodType = 'food'
  // Only the first tier is expanded by default: 食物 holds ~550 collectibles, and
  // drawing them all on open stalls the sheet. Every tier heading still shows its
  // count, one tap away.
  const shown = [true, false, false]
  let lastDraw = signin.getGrowth?.[1] ?? signin.getGrowth?.[0] ?? [0, 0, 0]
  let drawing = false
  const today = new Date(dayStart() * 1000)
  let view = { year: today.getFullYear(), month: today.getMonth() + 1 }

  const body = div('qp-signin')
  const statusCard = div('qp-signin-card')
  const calendarCard = div('qp-signin-card')
  const giftCard = div('qp-signin-card')
  const collectionCard = div('qp-signin-card')
  body.append(statusCard, calendarCard, giftCard, collectionCard)

  const card = (): HTMLElement | null => sheet?.card ?? null
  const result = (goods: Good[], msg = ''): void => {
    const host = card()
    if (host) showResult(host, goods, msg)
  }

  // ---- today: status and the one daily action ------------------------------
  // Kept as live nodes: the 1 s tick only rewrites text, because replacing the
  // button under a finger would swallow the tap.

  const statusTitle = div('qp-signin-count')
  const statusHint = div('qp-signin-hint')
  const primary = div('qp-signin-primary')
  statusCard.append(statusTitle, statusHint, primary, div('qp-signin-hint', '签到有几率获得绝版物品哦~'))
  primary.setAttribute('role', 'button')
  primary.tabIndex = 0
  primary.addEventListener('click', doSign)
  primary.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    doSign()
  })

  function syncStatus(): void {
    const now = new Date(dayStart() * 1000)
    const signed = signedToday()
    statusTitle.textContent = signed ? '今天已经签到啦' : '今天还没签到'
    statusHint.textContent = `本月已累计签到 ${monthSigns(now.getFullYear(), now.getMonth() + 1).length} 次`
    primary.textContent = signed ? '已签到' : '今日签到'
    primary.setAttribute('aria-label', signed ? '今天已经签到' : '今日签到')
    primary.setAttribute('aria-disabled', String(signed))
  }

  function doSign(): void {
    if (signedToday()) return
    if (runtimeProjectionMode) {
      void dispatchRuntimeCommand(uiCommands.signIn()).then((response) => {
        if (commandSucceeded(response) === false) return
        syncStatus()
        drawCalendar()
        result(commandResultGoods(response))
      })
      return
    }
    result(signToday())
    syncStatus()
    drawCalendar()
  }

  // ---- month calendar ------------------------------------------------------

  function drawCalendar(): void {
    const grid = monthGrid(view.year, view.month, monthSigns(view.year, view.month), dayStart())
    const prev = div('qp-signin-nav', '‹')
    const next = div('qp-signin-nav', '›')
    for (const [el, delta, label] of [
      [prev, -1, '上个月'],
      [next, 1, '下个月'],
    ] as const) {
      el.setAttribute('role', 'button')
      el.setAttribute('aria-label', label)
      el.tabIndex = 0
      activate(el, () => {
        view = stepMonth(view.year, view.month, delta)
        drawCalendar()
      })
    }
    calendarCard.replaceChildren(
      div('qp-signin-cal-head', prev, div('qp-signin-month', `${grid.label} · 已签 ${grid.signedCount} 天`), next),
      div('qp-signin-week', ...WEEKDAYS.map((weekday) => div('', weekday))),
      div('qp-signin-days', ...grid.cells.map(dayCell)),
    )
  }

  const dayCell = (cell: CalendarCell): HTMLElement => {
    if (cell.blank) return div('qp-signin-day qp-signin-day-blank')
    const classes = [
      'qp-signin-day',
      cell.past && !cell.signed && 'qp-signin-day-past',
      cell.signed && 'qp-signin-day-signed',
      cell.today && 'qp-signin-day-today',
      cell.future && 'qp-signin-day-future',
    ]
    const el = div(classes.filter(Boolean).join(' '), String(cell.day))
    el.setAttribute('aria-label', `${cell.day}日${cell.signed ? '，已签到' : ''}${cell.today ? '，今天' : ''}`)
    return el
  }

  // ---- growth draw and online gift ----------------------------------------

  const digitEls = lastDraw.map((n) => div('qp-signin-digit', String(n)))
  const drawButton = div('qp-signin-action')
  const onlineCount = div('qp-signin-count')
  const giftHint = div('qp-signin-hint')
  const giftButton = div('qp-signin-action')
  for (const [el, label, run] of [
    [drawButton, '抽成长值', doDrawGrowth],
    [giftButton, '领取在线礼包', claimOnlineGift],
  ] as const) {
    el.setAttribute('role', 'button')
    el.setAttribute('aria-label', label)
    el.tabIndex = 0
    activate(el, run)
  }
  const subtitle = div('qp-signin-title', '在线礼包')
  subtitle.classList.add('qp-signin-subtitle')
  giftCard.append(
    div('qp-signin-title', '成长值'),
    div('qp-signin-row', div('qp-signin-digits', ...digitEls), drawButton),
    div('qp-signin-hint', '免费抽取宠物成长值，每日限一次（粉钻可额外抽取一次）'),
    subtitle,
    onlineCount,
    div('qp-signin-row', giftHint, giftButton),
    div('qp-signin-hint', '（粉钻可领取双倍奖励）'),
  )

  function syncGift(): void {
    digitEls.forEach((el, i) => (el.textContent = String(lastDraw[i] ?? 0)))
    onlineCount.textContent = `已在线 ${info.onlineDataTime | 0} 分钟`
    giftHint.textContent = `抽奖每10次必出高级物品，当前已抽取（${signin.onlineGiftNum}）次`
    const drawable = canDrawGrowth() && !drawing
    drawButton.textContent = drawing ? '抽取中…' : '抽成长值'
    drawButton.setAttribute('aria-disabled', String(!drawable))
    const giftReady = signin.isOnlineLastTime <= 0
    giftButton.textContent = giftReady ? '点击领取' : `剩余${signin.isOnlineLastTime | 0}分钟`
    giftButton.setAttribute('aria-disabled', String(!giftReady))
  }

  function doDrawGrowth(): void {
    if (drawing || canDrawGrowth() === false) return
    if (runtimeProjectionMode) {
      drawing = true
      syncGift()
      void dispatchRuntimeCommand(uiCommands.drawGrowth()).then((response) => {
        const data = commandResultData<{ digits: number[]; value: number }>(response)
        if (data === null) {
          drawing = false
          syncGift()
          return
        }
        lastDraw = data.digits
        syncGift()
        setTimeout(() => {
          if (!alive) return
          drawing = false
          syncGift()
          result(commandResultGoods(response), '你咋运气这么差呢！~再让你试一次吧~~')
        }, 600)
      })
      return
    }
    drawing = true
    const outcome = drawGrowth()
    lastDraw = outcome.digits
    syncGift()
    setTimeout(() => {
      if (!alive) return
      drawing = false
      syncGift()
      result(outcome.goods, '你咋运气这么差呢！~再让你试一次吧~~')
    }, 600)
  }

  function claimOnlineGift(): void {
    if (signin.isOnlineLastTime > 0) return
    if (runtimeProjectionMode) {
      const claim = (): void => {
        void dispatchRuntimeCommand(uiCommands.claimOnlineGift()).then((response) => {
          if (commandSucceeded(response) === false) return
          result(commandResultGoods(response))
          syncGift()
        })
      }
      const cost = giftCost()
      if (cost === 0) return claim()
      const member = info.pinkDiamond
      windowView({
        title: '在线礼包',
        msg: `${member ? '尊贵的粉钻用户，' : '尊敬的宠主，'}确定花费${cost}${member ? '元宝领取双份在线礼物么？' : '元宝领取在线礼物么？'}`,
        ok: (close) => {
          close()
          claim()
        },
      })
      return
    }
    const take = (): void => {
      result(takeOnlineGift())
      syncGift()
    }
    const cost = giftCost()
    if (cost === 0) return take()
    const member = info.pinkDiamond
    windowView({
      title: '在线礼包',
      msg: `${member ? '尊贵的粉钻用户，' : '尊敬的宠主，'}确定花费${cost}${member ? '元宝领取双份在线礼物么？' : '元宝领取在线礼物么？'}`,
      ok: (close) => {
        if (!pay(cost)) return
        close()
        take()
      },
    })
  }

  // ---- 图鉴: type chips and two-column cards -------------------------------

  function drawCollection(): void {
    const chips = div('qp-signin-chips')
    for (const entry of TYPES) {
      const chip = div('qp-signin-chip', entry.label)
      chip.setAttribute('role', 'tab')
      chip.setAttribute('aria-selected', String(entry.type === type))
      chip.tabIndex = 0
      activate(chip, () => {
        if (type === entry.type) return
        type = entry.type
        drawCollection()
      })
      chips.append(chip)
    }
    const byId = new Map<string, Good>()
    for (const good of allGoods(type)) byId.set(good.id, good)
    const tiers = TIERS.map((tier, i) => {
      // pool.json lists every tier's loot codes; a code of another type is skipped.
      const pool: Good[] = []
      for (const code of POOLS[i] ?? []) {
        const good = byId.get(code.slice(1))
        if (good) pool.push(good)
      }
      const cards = tierCards(pool, save.illustrated)
      const toggle = div('qp-signin-tier-toggle', shown[i] ? '收起' : '展开')
      toggle.setAttribute('role', 'button')
      toggle.setAttribute('aria-label', `${tier}${shown[i] ? '收起' : '展开'}`)
      toggle.setAttribute('aria-expanded', String(Boolean(shown[i])))
      toggle.tabIndex = 0
      activate(toggle, () => {
        shown[i] = !shown[i]
        drawCollection()
      })
      const head = div('qp-signin-tier-head', div('qp-signin-tier-title', tierTitle(tier, cards)), toggle)
      if (!shown[i]) return div('qp-signin-tier', head)
      const grid = div('qp-signin-cards', ...tierGoods(cards).map((good) => collectionItem(good, cards.seen.includes(good))))
      return div('qp-signin-tier', head, grid)
    })
    collectionCard.replaceChildren(
      div('qp-signin-title', '图鉴'),
      div('qp-signin-hint', '灰色的是还没收集到的物品，长按查看详情'),
      chips,
      ...tiers,
    )
  }

  /** A collected card keeps its colours and its effect text; a missing one is greyed out. */
  function collectionItem(good: Good, seen: boolean): HTMLElement {
    const item = div('qp-signin-item', img('qp-signin-icon', good.url), div('qp-signin-name', good.name))
    item.dataset.seen = String(seen)
    item.title = `${good.name}：${seen ? describe(good).join('；') || '暂无介绍' : good.desc || '暂无介绍'}`
    return item
  }

  syncStatus()
  drawCalendar()
  syncGift()
  drawCollection()

  let stopProjection = (): void => {}
  let timer = 0
  sheet = openSheet({
    title: '签到',
    body,
    cardClass: 'qp-page-sheet qp-signin-sheet',
    onClose: () => {
      alive = false
      stopProjection()
      clearInterval(timer)
      if (current === sheet) current = null
    },
  })
  current = sheet
  stopProjection = onStoreEvent((event) => {
    if (event.type !== 'signin.changed') return
    syncStatus()
    drawCalendar()
    syncGift()
  })
  // The online minute counter and the 06:00 day rollover both move without a store event.
  timer = window.setInterval(() => {
    if (!alive) return
    syncStatus()
    syncGift()
  }, 1000)

  // The birthday gift is granted on opening, exactly like the desktop window does.
  setTimeout(() => {
    if (!alive) return
    if (runtimeProjectionMode) {
      const now = new Date()
      const born = new Date(info.birthDay * 1000)
      // Only the daily birthday slot may ask the host; otherwise the command
      // would reject with a confusing error every time the panel opens.
      if (signin.getBirthDayGift || now.getDate() !== born.getDate()) return
      void dispatchRuntimeCommand(uiCommands.claimBirthdayGift()).then((response) => {
        const goods = commandResultGoods(response)
        if (goods.length > 0) result(goods)
      })
      return
    }
    const goods = birthdayGift()
    if (goods.length) result(goods)
  }, 500)
}
