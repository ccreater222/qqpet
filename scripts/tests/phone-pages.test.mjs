// Phone sign-in / task / mail / profile: the pure layout data (month grid, task
// states and grouping, mail rows and pages, the profile's stat grid) plus the
// wiring that puts each page on a bottom sheet at 1 CSS px = 1 dp on a phone.
// The CSS is parsed instead of eyeballed so the 44 dp floor, the 56 dp primary
// action and the 64 dp rows cannot silently regress, and every selector must stay
// inside `body.qp-phone` so the desktop windows are untouched.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  MAIL_PAGE_SIZE,
  MAIL_PHOTO_SENDER,
  MAIL_SENDER,
  WEEKDAYS,
  abilityEntries,
  mailPage,
  mailRow,
  mailRows,
  mailTotals,
  meterRatio,
  monthGrid,
  sexLabel,
  signDayAt,
  statGrid,
  statusEntries,
  statusLabel,
  stepMonth,
  taskRow,
  taskSections,
  taskTabs,
  tierCards,
  tierGoods,
  tierTitle,
} from '../../src/renderer/ui/mobile/phone-pages-model.ts'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

// ---- sign-in calendar ---------------------------------------------------------

test('the calendar starts its week on Monday and carries a full month in 7 columns', () => {
  assert.deepEqual([...WEEKDAYS], ['一', '二', '三', '四', '五', '六', '日'])
  // 2026-11-01 is a Sunday: six blanks before the 1st, 30 days, 36 cells.
  const november = monthGrid(2026, 11, [], 0)
  assert.equal(november.label, '2026年11月')
  assert.equal(november.lead, 6)
  assert.equal(november.days, 30)
  assert.equal(november.cells.length, 36)
  assert.deepEqual(november.cells.slice(0, 6).map((cell) => cell.blank), [true, true, true, true, true, true])
  assert.equal(november.cells[6].day, 1)
  assert.equal(november.cells[35].day, 30)
  // 2026-06-01 is a Monday, so a month can start with no blanks at all.
  assert.equal(monthGrid(2026, 6, [], 0).lead, 0)
  // Leap year.
  assert.equal(monthGrid(2024, 2, [], 0).days, 29)
  assert.equal(monthGrid(2026, 2, [], 0).days, 28)
  // Out of range months are clamped, not rolled into a neighbour.
  assert.equal(monthGrid(2026, 13, [], 0).month, 12)
  assert.equal(monthGrid(2026, 0, [], 0).month, 1)
})

test('a day is signed, today, past or future by its own 06:00 timestamp', () => {
  const signed = [signDayAt(2026, 11, 5), signDayAt(2026, 11, 9)]
  const today = signDayAt(2026, 11, 10)
  const grid = monthGrid(2026, 11, signed, today)
  const day = (n) => grid.cells.find((cell) => cell.day === n)
  assert.equal(day(4).past, true)
  assert.equal(day(4).signed, false)
  assert.equal(day(5).signed, true)
  assert.equal(day(5).past, true, 'a signed day in the past is both')
  assert.equal(day(9).signed, true)
  assert.equal(day(10).today, true)
  assert.equal(day(10).past, false)
  assert.equal(day(10).future, false)
  assert.equal(day(11).future, true)
  assert.equal(grid.signedCount, 2)
  // Every cell is keyed by 06:00 local on its own date; a blank has no key.
  assert.equal(day(1).at, new Date(2026, 10, 1, 6, 0, 0, 0).getTime() / 1000)
  assert.equal(grid.cells[0].at, 0)
  // Duplicate keys in a corrupt save count once on the calendar.
  assert.equal(monthGrid(2026, 11, [signDayAt(2026, 11, 5), signDayAt(2026, 11, 5)], today).signedCount, 1)
})

test('month navigation wraps years and never drifts', () => {
  assert.deepEqual(stepMonth(2026, 11, 1), { year: 2026, month: 12 })
  assert.deepEqual(stepMonth(2026, 12, 1), { year: 2027, month: 1 })
  assert.deepEqual(stepMonth(2026, 1, -1), { year: 2025, month: 12 })
  assert.deepEqual(stepMonth(2026, 11, -14), { year: 2025, month: 9 })
  assert.deepEqual(stepMonth(2026, 11, 0), { year: 2026, month: 11 })
  assert.deepEqual(stepMonth(2026, 11, Number.NaN), { year: 2026, month: 11 })
  assert.deepEqual(stepMonth(2026, 11, 12), { year: 2027, month: 11 })
})

// ---- sign-in collection -------------------------------------------------------

test('the illustrated tiers split collected from missing without reordering', () => {
  const goods = [
    { id: 'a', name: '甲', url: 'a.svg' },
    { id: 'b', name: '乙', url: 'b.svg' },
    { id: 'c', name: '丙', url: 'c.svg' },
  ]
  const cards = tierCards(goods, ['c', 'a'])
  assert.deepEqual(cards.seen.map((good) => good.id), ['a', 'c'])
  assert.deepEqual(cards.unseen.map((good) => good.id), ['b'])
  assert.equal(cards.total, 3)
  assert.equal(cards.seenCount, 2)
  assert.equal(cards.complete, false)
  assert.equal(tierTitle('史诗', cards), '史诗: (2 / 3)')
  assert.deepEqual(tierGoods(cards).map((good) => good.id), ['a', 'c', 'b'])
  assert.equal(tierCards(goods, ['a', 'b', 'c']).complete, true)
  assert.equal(tierCards([], []).complete, false, 'an empty pool is not a complete collection')
  assert.equal(tierTitle('稀有', tierCards([], [])), '稀有: (0 / 0)')
})

// ---- tasks ---------------------------------------------------------------------

test('a task row keeps the desktop claim rules', () => {
  const pending = taskRow({ label: '喂我吃东西3次', msg: '肚子咕咕叫啦', num: 3, done: 1, take: false }, 2)
  assert.deepEqual(
    { index: pending.index, state: pending.state, progress: pending.progress, action: pending.action, enabled: pending.enabled },
    { index: 2, state: 'pending', progress: '1/3', action: '未达成', enabled: false },
  )
  assert.equal(pending.ratio, 1 / 3)
  assert.equal(pending.title, '喂我吃东西3次')
  assert.equal(pending.msg, '肚子咕咕叫啦')

  const ready = taskRow({ label: '洗澡', msg: '香香的', num: 3, done: 3, take: false }, 0)
  assert.equal(ready.state, 'ready')
  assert.equal(ready.action, '领取奖励')
  assert.equal(ready.enabled, true, 'a finished task may be claimed')
  assert.equal(ready.progress, '3/3')

  const claimed = taskRow({ label: '洗澡', msg: '香香的', num: 3, done: 9, take: true }, 0)
  assert.equal(claimed.state, 'claimed')
  assert.equal(claimed.action, '✓ 已领取')
  assert.equal(claimed.enabled, false)
  assert.equal(claimed.progress, '3/3', 'progress is capped at the target, like the desktop label')
  assert.equal(claimed.ratio, 1)
  assert.equal(taskRow({ label: 'x', msg: '', num: 0, done: 0, take: false }, 0).ratio, 0)
})

test('tasks group claimable-first and keep their tab index', () => {
  const rows = [
    taskRow({ label: '进行中', msg: '', num: 5, done: 1, take: false }, 3),
    taskRow({ label: '已完成', msg: '', num: 1, done: 1, take: true }, 4),
    taskRow({ label: '可领取', msg: '', num: 1, done: 1, take: false }, 7),
  ]
  const sections = taskSections(rows)
  assert.deepEqual(sections.map((section) => section.id), ['ready', 'pending', 'claimed'])
  assert.deepEqual(sections.map((section) => section.title), ['可领取', '进行中', '已完成'])
  assert.deepEqual(sections.flatMap((section) => section.rows.map((row) => row.index)), [7, 3, 4])
  // Empty blocks are dropped rather than rendering an empty heading.
  assert.deepEqual(taskSections([rows[1]]).map((section) => section.id), ['claimed'])
  assert.deepEqual(taskSections([]), [])
})

test('each tab chip counts what can be claimed right now', () => {
  const tabs = [
    { id: 'daily', label: '今日任务' },
    { id: 'ddw', label: '逗逗我' },
    { id: 'travel', label: '旅游任务' },
  ]
  const daily = [
    taskRow({ label: 'a', msg: '', num: 1, done: 1, take: false }, 0),
    taskRow({ label: 'b', msg: '', num: 2, done: 2, take: false }, 1),
    taskRow({ label: 'c', msg: '', num: 2, done: 0, take: false }, 2),
  ]
  const info = taskTabs(tabs, { daily, ddw: [taskRow({ label: 'd', msg: '', num: 5, done: 5, take: true }, 0)] })
  assert.deepEqual(info.map((tab) => [tab.id, tab.ready, tab.total]), [['daily', 2, 3], ['ddw', 0, 1], ['travel', 0, 0]])
})

// ---- mail ----------------------------------------------------------------------

test('a mail row shows sender, subject, time and its own action', () => {
  const photo = mailRow({ d: 1700000000, l: '来自杭州的明信片', p: 'hz-01', m: '照片我收进相簿啦', glb: [] })
  assert.equal(photo.sender, MAIL_PHOTO_SENDER)
  assert.equal(photo.subject, '来自杭州的明信片')
  assert.equal(photo.preview, '旅行照片')
  assert.equal(photo.photo, true)
  assert.equal(photo.photoId, 'hz-01')
  assert.equal(photo.action, '领取')
  assert.equal(photo.time, 1700000000)

  const gift = mailRow({ d: 1700000001, l: '欢迎来到QQ宠物~', glb: [{ name: '元宝', url: 'yb.svg', num: 100 }, { name: '饼干', url: 'b.svg', num: 3 }] })
  assert.equal(gift.sender, MAIL_SENDER)
  assert.equal(gift.preview, '2 件奖励')
  assert.equal(gift.goodsTotal, 103)
  assert.equal(gift.action, '领取')

  const claimed = mailRow({ d: 1700000002, l: '节日快乐', r: true, glb: [{ name: '元宝', url: 'yb.svg', num: 200 }] })
  assert.equal(claimed.action, '删除')
  assert.equal(claimed.claimed, true)
  assert.match(claimed.preview, /^已领取 · /)
  assert.equal(mailRow({ d: 1, l: '空' }).preview, '暂无奖励')
  assert.equal(mailRow({ d: 1, l: '空' }).subject, '空')
})

test('live mail drops deleted entries and lists the newest first', () => {
  const list = [
    { d: 1700000000, l: 'old', glb: [] },
    { d: 1700000001, e: true },
    { d: 1700000002, l: 'new', glb: [] },
  ]
  // The caller passes Object.values of the save: integer-like keys enumerate in
  // ascending send order, so reversing gives newest first.
  assert.deepEqual(mailRows(list).map((row) => row.subject), ['new', 'old'])
  assert.deepEqual(mailRows([]), [])
  assert.equal(MAIL_PAGE_SIZE, 3)
})

test('mail pages clamp into range and report their edges', () => {
  const rows = Array.from({ length: 7 }, (_, i) => mailRow({ d: i + 1, l: `m${i}`, glb: [] }))
  const first = mailPage(rows, 1, 3)
  assert.deepEqual(first.rows.map((row) => row.subject), ['m0', 'm1', 'm2'])
  assert.equal(first.totalPage, 3)
  assert.equal(first.total, 7)
  assert.equal(first.hasPrev, false)
  assert.equal(first.hasNext, true)
  const last = mailPage(rows, 99, 3)
  assert.equal(last.page, 3)
  assert.deepEqual(last.rows.map((row) => row.subject), ['m6'])
  assert.equal(last.hasPrev, true)
  assert.equal(last.hasNext, false)
  assert.equal(mailPage(rows, 0, 3).page, 1)
  assert.equal(mailPage(rows, Number.NaN, 3).page, 1)
  const empty = mailPage([], 4)
  assert.deepEqual(empty.rows, [])
  assert.equal(empty.page, 1)
  assert.equal(empty.totalPage, 1)
  assert.equal(empty.hasPrev, false)
  assert.equal(empty.hasNext, false)
})

test('bulk mail counts drive 一键领取 / 一键删除', () => {
  const rows = [
    mailRow({ d: 1, l: 'a', glb: [] }),
    mailRow({ d: 2, l: 'b', r: true, glb: [] }),
    mailRow({ d: 3, l: 'c', p: 'x', r: true }),
  ]
  assert.deepEqual(mailTotals(rows), { claimable: 1, deletable: 2, photos: 1 })
  assert.deepEqual(mailTotals([]), { claimable: 0, deletable: 0, photos: 0 })
})

// ---- pet profile ---------------------------------------------------------------

const numbers = {
  level: 12,
  yb: 500,
  diamond: 7,
  intel: 30,
  strong: 20,
  charm: 10,
  growth: 400,
  upGrowth: 100,
  nextGrowth: 900,
  hunger: 550,
  hungerMax: 1100,
  clean: 1100,
  cleanMax: 1100,
  health: 4,
  healthMax: 5,
  mood: 100,
  moodMax: 1000,
  age: '3小时20分钟',
  growthPerHour: 12,
  status: '工作中',
  onlineMinutes: 200,
  pd: '未开通',
  sweetHeart: '未开通',
}

test('the profile grid is two columns, padded on the last row', () => {
  const entries = abilityEntries(numbers)
  assert.deepEqual(entries.map((entry) => entry.label), ['等级：', '元宝：', '钻石：', '智力：', '武力：', '魅力：'])
  assert.deepEqual(entries.map((entry) => entry.value), ['12', '500', '7', '30', '20', '10'])
  const grid = statGrid(entries)
  assert.equal(grid.length, 3)
  assert.ok(grid.every((row) => row.length === 2))
  const odd = statGrid(statusEntries(numbers))
  assert.equal(odd.length, 6, '11 entries on a 2-column grid need six rows')
  assert.equal(odd[5].length, 2)
  assert.equal(odd[5][1], null, 'the empty cell is padded, not a third column')
  assert.deepEqual(statGrid([]), [])
  assert.equal(statGrid(entries, 3).length, 2)
})

test('meters clamp and the status rows carry the desktop labels', () => {
  assert.equal(meterRatio(50, 100), 0.5)
  assert.equal(meterRatio(200, 100), 1)
  assert.equal(meterRatio(-5, 100), 0)
  assert.equal(meterRatio(5, 0), 0)
  assert.equal(meterRatio(Number.NaN, 100), 0)
  const entries = statusEntries(numbers)
  assert.deepEqual(
    entries.map((entry) => entry.label),
    ['成长：', '饥饿：', '清洁：', '健康：', '心情：', '年龄：', '成长速度：', '状态：', '在线时间：', '粉钻：', '贴心宝贝：'],
  )
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  assert.equal(byId.get('growth').value, '400 / 900')
  assert.equal(byId.get('growth').ratio, 300 / 800)
  assert.equal(byId.get('hunger').ratio, 0.5)
  assert.equal(byId.get('health').ratio, 0.8)
  assert.equal(byId.get('mood').ratio, 0.1)
  assert.equal(byId.get('age').value, '3小时20分钟')
  assert.equal(byId.get('speed').value, '12/小时')
  assert.equal(byId.get('state').value, '工作中')
  assert.equal(byId.get('online').value, '200分钟')
  assert.equal(byId.get('pd').ratio, undefined, 'a plain value has no meter')
})

test('the status line drops the stop button the state panel owns', () => {
  assert.equal(statusLabel(['工作中 ', { nodeType: 1 }]), '工作中')
  assert.equal(statusLabel(['生病了']), '生病了')
  assert.equal(statusLabel([]), '')
  assert.equal(sexLabel('GG'), 'GG（弟弟）')
  assert.equal(sexLabel('MM'), 'MM（妹妹）')
})

// ---- phone stylesheet ----------------------------------------------------------

/** The part of phone-pages.css this task owns; the island section is appended below it. */
const css = (() => {
  const raw = read('../../src/renderer/ui/css/phone-pages.css')
  const island = raw.indexOf('/* ---- island')
  const mine = island >= 0 ? raw.slice(0, island) : raw
  return mine.replace(/\/\*[\s\S]*?\*\//g, '')
})()

const cssRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
  selectors: match[1].split(',').map((selector) => selector.trim()),
  body: match[2],
}))

/** Every declaration block that lists `selector`, so grouped rules still match. */
const blocks = (selector) => cssRules.filter((rule) => rule.selectors.includes(selector)).map((rule) => rule.body)
const declares = (selector, pattern, label) =>
  assert.ok(blocks(selector).some((body) => pattern.test(body)), `${label ?? selector} is missing ${pattern}`)

test('the phone page stylesheet is scoped to phone bodies and never hover-only', () => {
  assert.ok(cssRules.length > 0)
  for (const rule of cssRules) {
    for (const selector of rule.selectors) {
      if (!selector || selector.startsWith('@') || /^(from|to|\d+%|-?\d+\.?\d*%)$/.test(selector)) continue
      assert.match(selector, /^body\.qp-phone\b/, `desktop selector escaped the phone scope: ${selector}`)
    }
  }
  assert.doesNotMatch(css, /:hover/, 'a finger has no hover; none of these pages may need one')
  assert.doesNotMatch(css, /\.ui-(signin|task|email|petinfo)\b/, 'the desktop windows must not be restyled')
})

test('sign-in keeps the daily action and the calendar finger-sized', () => {
  declares('body.qp-phone .qp-signin-primary', /min-height:\s*56px/)
  declares('body.qp-phone .qp-signin-days', /grid-template-columns:\s*repeat\(7, minmax\(0, 1fr\)\)/)
  declares('body.qp-phone .qp-signin-day', /min-height:\s*var\(--qp-tap-sm\)/)
  declares('body.qp-phone .qp-signin-nav', /width:\s*var\(--qp-tap-sm\)/)
  declares('body.qp-phone .qp-signin-nav', /height:\s*var\(--qp-tap-sm\)/)
  declares('body.qp-phone .qp-signin-chips', /flex-wrap:\s*wrap/)
  declares('body.qp-phone .qp-signin-chip', /min-height:\s*var\(--qp-tap-sm\)/)
  declares('body.qp-phone .qp-signin-tier-toggle', /min-height:\s*var\(--qp-tap-sm\)/)
  declares('body.qp-phone .qp-signin-cards', /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/)
  declares('body.qp-phone .qp-signin-icon', /width:\s*var\(--qp-tap-sm\)/)
  declares('body.qp-phone .qp-signin-icon', /height:\s*var\(--qp-tap-sm\)/)
  declares('body.qp-phone .qp-signin-action', /min-height:\s*var\(--qp-tap-sm\)/)
  declares('body.qp-phone .qp-signin-digit', /font-size:\s*30px/)
})

test('task rows are 64 dp with a 44 dp claim key and 15/13 text', () => {
  declares('body.qp-phone .qp-task-row', /min-height:\s*64px/)
  declares('body.qp-phone .qp-task-title', /font-size:\s*var\(--qp-font\)/)
  declares('body.qp-phone .qp-task-progress', /font-size:\s*var\(--qp-font-sm\)/)
  declares('body.qp-phone .qp-task-claim', /min-height:\s*var\(--qp-tap-sm\)/)
  declares('body.qp-phone .qp-task-tab', /min-height:\s*var\(--qp-tap-sm\)/)
})

test('mail rows are 64 dp with 15/13/12 text and every action >=44 dp', () => {
  declares('body.qp-phone .qp-email-row', /min-height:\s*64px/)
  declares('body.qp-phone .qp-email-sender', /font-size:\s*var\(--qp-font\)/)
  declares('body.qp-phone .qp-email-subject', /font-size:\s*var\(--qp-font-sm\)/)
  declares('body.qp-phone .qp-email-time', /font-size:\s*12px/)
  declares('body.qp-phone .qp-email-page', /min-height:\s*var\(--qp-tap-sm\)/)
  declares('body.qp-phone .qp-email-bulk-act', /min-height:\s*var\(--qp-tap-sm\)/)
  declares('body.qp-phone .qp-email-back', /min-height:\s*var\(--qp-tap-sm\)/)
  declares('body.qp-phone .qp-email-claim', /min-height:\s*48px/)
  declares('body.qp-phone .qp-email-detail-body', /white-space:\s*pre-wrap/)
})

test('the profile is a 96 dp avatar, 44 dp fields and a two-column stat grid', () => {
  declares('body.qp-phone .qp-petinfo-avatar-wrap', /width:\s*96px/)
  declares('body.qp-phone .qp-petinfo-avatar-wrap', /height:\s*96px/)
  declares('body.qp-phone .qp-petinfo-grid', /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/)
  declares('body.qp-phone .qp-petinfo-label', /font-size:\s*var\(--qp-font-sm\)/)
  declares('body.qp-phone .qp-petinfo-value', /font-size:\s*var\(--qp-font\)/)
  declares('body.qp-phone .qp-petinfo-meter', /height:\s*20px/)
  declares('body.qp-phone .qp-petinfo-input', /height:\s*var\(--qp-tap-sm\)/)
  declares('body.qp-phone .qp-petinfo-save', /min-height:\s*var\(--qp-tap-sm\)/)
})

// ---- wiring ---------------------------------------------------------------------

const PHONE = {
  'signin.ts': 'openPhoneSignIn',
  'task.ts': 'openPhoneTask',
  'email.ts': 'openPhoneEmail',
  'petinfo.ts': 'openPhonePetInfo',
}
const OPENER = { 'signin.ts': 'openSignIn', 'task.ts': 'openTask', 'email.ts': 'openEmail', 'petinfo.ts': 'openPetInfo' }
/** The first desktop-only statement each opener makes: the phone branch must win. */
const DESKTOP = { 'signin.ts': 'if (open) return', 'task.ts': 'if (open) return', 'email.ts': 'if (open) return', 'petinfo.ts': 'close()' }

test('each page branches to its phone sheet before the desktop window opens', () => {
  for (const [file, phone] of Object.entries(PHONE)) {
    const src = read(`../../src/renderer/ui/${file}`)
    const start = src.indexOf(`export function ${OPENER[file]}`)
    assert.ok(start >= 0, `${file}: ${OPENER[file]} moved`)
    const body = src.slice(src.indexOf('{', start) + 1)
    const branch = body.indexOf(`if (phoneUI()) return ${phone}()`)
    assert.ok(branch >= 0, `${file} has no phone branch`)
    assert.ok(branch < body.indexOf(DESKTOP[file]), `${file}: the desktop path runs before the phone branch`)
    assert.match(src, /from '\.\/mobile\/sizing'/, `${file} must import phoneUI from the phone sizing module`)
  }
  // The desktop bodies are still there: each opener keeps building its own window.
  assert.match(read('../../src/renderer/ui/signin.ts'), /openBox\(root/)
  assert.match(read('../../src/renderer/ui/task.ts'), /openBox\(root/)
  assert.match(read('../../src/renderer/ui/email.ts'), /openFrame\(/)
  assert.match(read('../../src/renderer/ui/petinfo.ts'), /openBox\(div\('ui-petinfo'/)
})

test('the phone surfaces are sheets over the shared page logic', () => {
  const signin = read('../../src/renderer/ui/mobile/phone-signin.ts')
  for (const needle of ["from './sheet'", "import '../css/phone-pages.css'", 'signToday(', 'takeOnlineGift(', 'drawGrowth(', 'uiCommands.signIn()', 'showResult(']) {
    assert.ok(signin.includes(needle), `phone-signin.ts lost ${needle}`)
  }
  assert.match(signin, /openSheet\(\{[\s\S]*?title:\s*'签到'/)

  const task = read('../../src/renderer/ui/mobile/phone-task.ts')
  for (const needle of ["from './sheet'", "import '../css/phone-pages.css'", 'claimRuntime(', 'claim(', 'showResult(']) {
    assert.ok(task.includes(needle), `phone-task.ts lost ${needle}`)
  }
  assert.match(task, /openSheet\(\{[\s\S]*?title:\s*'任务'/)

  const email = read('../../src/renderer/ui/mobile/phone-email.ts')
  for (const needle of [
    "from './sheet'",
    "import '../css/phone-pages.css'",
    'readMails(',
    'writeMails(',
    'give(',
    'uiCommands.mailClaimAll()',
    'uiCommands.mailDeleteAll()',
    'uiCommands.mailClaim(',
    'uiCommands.mailDelete(',
  ]) {
    assert.ok(email.includes(needle), `phone-email.ts lost ${needle}`)
  }
  assert.match(email, /openSheet\(\{[\s\S]*?title:\s*'邮箱'/)
  // Deleting a mail keeps the save's own tombstone shape ({ d, e: true, k }).
  assert.match(email, /e:\s*true/)

  const profile = read('../../src/renderer/ui/mobile/phone-petinfo.ts')
  for (const needle of ["from './sheet'", "import '../css/phone-pages.css'", 'uiCommands.rename(', 'setInfo(', 'formatDate(', 'progress']) {
    if (needle === 'progress') continue
    assert.ok(profile.includes(needle), `phone-petinfo.ts lost ${needle}`)
  }
  assert.match(profile, /openSheet\(\{[\s\S]*?title:\s*'宠物档案'/)
})
