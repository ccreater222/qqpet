// Pure layout data for the four phone pages: sign-in, tasks, mail and the pet
// profile. The desktop windows (ui/signin.ts, ui/task.ts, ui/email.ts,
// ui/petinfo.ts) are fixed-pixel layouts authored for a mouse on a 480 px
// design space; on a phone they are rebuilt as bottom sheets at 1 CSS px = 1 dp.
// Everything that decides *what* those sheets show lives here — the calendar's
// month grid, a task's own state and progress, a mail's sender and preview, the
// profile's two-column stat grid — with no DOM and no store import, so
// scripts/tests can pin the layout data without a browser.
import type { Sex } from '../../../shared/save'

/** Monday first, the way the original sign-in calendar lays its week out. */
export const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'] as const

// ---- sign-in calendar ---------------------------------------------------------

/** The sign-in day keys are 06:00 timestamps: a day turns over at 06:00, not midnight. */
const SIGN_DAY_HOUR = 6

export interface CalendarCell {
  /** Day of the month; 0 for one of the blanks that align the 1st with its weekday. */
  day: number
  /** The 06:00 timestamp sign-ins are keyed by; 0 for a blank. */
  at: number
  blank: boolean
  /** The day passed before today's business day. */
  past: boolean
  /** A sign-in is recorded for this day. */
  signed: boolean
  /** The business day `signedToday()` and the 今日签到 button apply to. */
  today: boolean
  /** After the current business day. */
  future: boolean
}

export interface MonthGrid {
  year: number
  /** 1..12. */
  month: number
  /** `2026年11月`, the calendar's own heading. */
  label: string
  /** Blank cells before the 1st: 0 for a month starting on Monday. */
  lead: number
  days: number
  /** Days of this month with a recorded sign-in. */
  signedCount: number
  /** Exactly `lead + days` cells, row-major: 7 columns on every screen width. */
  cells: CalendarCell[]
}

const clampMonth = (month: number): number => Math.min(12, Math.max(1, Math.trunc(month)))

const clampYear = (year: number): number => (Number.isFinite(year) ? Math.trunc(year) : 1970)

/** The timestamp a calendar day is stored under: 06:00 local on that date. */
export function signDayAt(year: number, month: number, day: number): number {
  return new Date(clampYear(year), clampMonth(month) - 1, Math.trunc(day), SIGN_DAY_HOUR, 0, 0, 0).getTime() / 1000
}

/**
 * One month of the sign-in calendar, Monday first, with `lead` blanks before the
 * 1st. `signed` is `monthSigns(year, month)`; `today` is `dayStart()`. A day can
 * be both `signed` and `today`, exactly like the desktop's stacked classes.
 */
export function monthGrid(year: number, month: number, signed: readonly number[], today: number): MonthGrid {
  const y = clampYear(year)
  const m = clampMonth(month)
  const days = new Date(y, m, 0).getDate()
  const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7
  const marked = new Set(signed)
  const cells: CalendarCell[] = []
  let signedCount = 0
  for (let blank = 0; blank < lead; blank++) {
    cells.push({ day: 0, at: 0, blank: true, past: false, signed: false, today: false, future: false })
  }
  for (let day = 1; day <= days; day++) {
    const at = signDayAt(y, m, day)
    const isSigned = marked.has(at)
    if (isSigned) signedCount++
    cells.push({ day, at, blank: false, past: at < today, signed: isSigned, today: at === today, future: at > today })
  }
  return { year: y, month: m, label: `${y}年${m}月`, lead, days, signedCount, cells }
}

/**
 * The month `delta` steps away, wrapping years. A non-finite or zero delta keeps
 * the month as it is; the calendar can walk any distance without overflowing.
 */
export function stepMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const y = clampYear(year)
  const m = clampMonth(month)
  if (!Number.isFinite(delta) || delta === 0) return { year: y, month: m }
  const index = y * 12 + (m - 1) + Math.trunc(delta)
  return { year: Math.floor(index / 12), month: (((index % 12) + 12) % 12) + 1 }
}

// ---- sign-in illustrated collection ------------------------------------------

export interface Collectible {
  id: string
  name: string
  url: string
  desc?: string
}

export interface TierCards<T extends Collectible = Collectible> {
  /** Cards the owner has collected, in pool order. */
  seen: T[]
  /** Cards still greyed out, in pool order. */
  unseen: T[]
  total: number
  seenCount: number
  complete: boolean
}

/** Splits one loot pool's goods into the collected and the still-missing. */
export function tierCards<T extends Collectible>(goods: readonly T[], illustrated: readonly unknown[]): TierCards<T> {
  const owned = new Set(illustrated)
  const seen: T[] = []
  const unseen: T[] = []
  for (const good of goods) (owned.has(good.id) ? seen : unseen).push(good)
  return { seen, unseen, total: goods.length, seenCount: seen.length, complete: goods.length > 0 && unseen.length === 0 }
}

/** The tier heading `史诗: (12 / 67)`, the counter the desktop shows. */
export const tierTitle = (tier: string, cards: TierCards): string => `${tier}: (${cards.seenCount} / ${cards.total})`

/** Every card of a tier, collected first, so one grid can show all of them. */
export const tierGoods = <T extends Collectible>(cards: TierCards<T>): T[] => [...cards.seen, ...cards.unseen]

// ---- tasks -------------------------------------------------------------------

export type TaskState = 'claimed' | 'ready' | 'pending'

export interface TaskInput {
  label: string
  msg: string
  num: number
  done: number
  take: boolean
}

export interface TaskRow {
  /** The task's index in its tab, what claim(tab, index) needs. */
  index: number
  title: string
  msg: string
  /** `3/5`, capped at the target like the desktop label. */
  progress: string
  done: number
  num: number
  /** 0..1, for the row's progress hint. */
  ratio: number
  state: TaskState
  /** The reward button's own words. */
  action: string
  /** The reward button is only live for a finished, unclaimed task. */
  enabled: boolean
}

/** One task as the phone row renders it, with the desktop's claim rules. */
export function taskRow(task: TaskInput, index: number): TaskRow {
  const num = Number.isFinite(task.num) ? Math.max(0, task.num) : 0
  const done = Number.isFinite(task.done) ? Math.max(0, task.done) : 0
  const shown = Math.min(done, num)
  const state: TaskState = task.take ? 'claimed' : done >= num ? 'ready' : 'pending'
  return {
    index,
    title: task.label,
    msg: task.msg,
    progress: `${shown}/${num}`,
    done,
    num,
    ratio: num > 0 ? Math.min(1, done / num) : 0,
    state,
    action: state === 'claimed' ? '✓ 已领取' : state === 'ready' ? '领取奖励' : '未达成',
    enabled: state === 'ready',
  }
}

export interface TaskSection {
  id: TaskState
  title: string
  rows: TaskRow[]
}

const SECTION_TITLES: Record<TaskState, string> = { ready: '可领取', pending: '进行中', claimed: '已完成' }
const SECTION_ORDER: readonly TaskState[] = ['ready', 'pending', 'claimed']

/**
 * The tab's tasks in three blocks, claimable first: on a phone the action a
 * thumb is looking for must not sit under a screenful of progress rows. Rows
 * keep their tab index, and empty blocks are left out.
 */
export function taskSections(rows: readonly TaskRow[]): TaskSection[] {
  const sections = SECTION_ORDER.map((id) => ({ id, title: SECTION_TITLES[id], rows: rows.filter((row) => row.state === id) }))
  return sections.filter((section) => section.rows.length > 0)
}

export interface TaskTabInput {
  id: string
  label: string
}

export interface TaskTabInfo extends TaskTabInput {
  /** How many of this tab's tasks can be claimed right now. */
  ready: number
  total: number
}

/** The tab chips, each with its claimable count so the user knows where to go. */
export function taskTabs(tabs: readonly TaskTabInput[], byTab: Readonly<Record<string, readonly TaskRow[]>>): TaskTabInfo[] {
  return tabs.map((tab) => {
    const rows = byTab[tab.id] ?? []
    return { id: tab.id, label: tab.label, ready: rows.filter((row) => row.state === 'ready').length, total: rows.length }
  })
}

// ---- mail --------------------------------------------------------------------

/** Mails per page; the desktop shows three and a row is taller on a phone. */
export const MAIL_PAGE_SIZE = 3
/** Mails are written by the pet itself; the original's inbox had no sender column. */
export const MAIL_SENDER = 'QQ宠物'
export const MAIL_PHOTO_SENDER = '旅行明信片'

export interface MailGood {
  name: string
  num: number
  url: string
}

/** saveJsonData.email entries; a deleted one keeps `e: true` and nothing else. */
export interface MailLike {
  d: number
  l?: string
  r?: boolean
  m?: string
  p?: string
  e?: true
  glb?: readonly MailGood[]
}

export interface MailRow {
  /** The mail's key in the save, its send time. */
  key: number
  sender: string
  subject: string
  /** What the pet says in the mail; the detail view's scrolling body. */
  body: string
  /** Unix seconds, formatted by the page. */
  time: number
  claimed: boolean
  photo: boolean
  /** The album photo id of a postcard mail; '' otherwise. */
  photoId: string
  goods: readonly MailGood[]
  /** Sum of the goods' counts. */
  goodsTotal: number
  /** The one line under the subject: `3 件奖励`, `旅行照片`, or the claimed variant. */
  preview: string
  /** What tapping the row's action does. */
  action: '领取' | '删除'
}

export function mailRow(mail: MailLike): MailRow {
  const goods = mail.glb ?? []
  const claimed = mail.r === true
  const photo = Boolean(mail.p)
  const goodsTotal = goods.reduce((sum, good) => sum + (Number.isFinite(good.num) ? good.num : 0), 0)
  const preview = photo ? '旅行照片' : goods.length ? `${goods.length} 件奖励` : '暂无奖励'
  return {
    key: mail.d,
    sender: photo ? MAIL_PHOTO_SENDER : MAIL_SENDER,
    subject: mail.l ?? '',
    body: mail.m ?? '',
    time: mail.d,
    claimed,
    photo,
    photoId: mail.p ?? '',
    goods,
    goodsTotal,
    preview: claimed ? `已领取 · ${preview}` : preview,
    action: claimed ? '删除' : '领取',
  }
}

/**
 * Live mails, newest first. The caller passes `Object.values` of the save: mail
 * keys are send times, and integer-like keys enumerate in ascending order, so
 * reversing that list is what brings new mail to the top.
 */
export function mailRows(list: readonly MailLike[]): MailRow[] {
  return list
    .filter((mail) => mail.e === undefined)
    .reverse()
    .map(mailRow)
}

export interface MailPage {
  rows: MailRow[]
  /** The clamped page actually shown. */
  page: number
  totalPage: number
  total: number
  hasPrev: boolean
  hasNext: boolean
}

export function mailPage(rows: readonly MailRow[], page: number, size = MAIL_PAGE_SIZE): MailPage {
  const step = Number.isFinite(size) && size > 0 ? Math.trunc(size) : MAIL_PAGE_SIZE
  const totalPage = Math.max(1, Math.ceil(rows.length / step))
  const at = Number.isFinite(page) ? Math.min(Math.max(Math.trunc(page), 1), totalPage) : 1
  return {
    rows: rows.slice((at - 1) * step, at * step),
    page: at,
    totalPage,
    total: rows.length,
    hasPrev: at > 1,
    hasNext: at < totalPage,
  }
}

export interface MailTotals {
  claimable: number
  deletable: number
  photos: number
}

/** The bulk buttons' counts: 一键领取 covers unclaimed, 一键删除 covers claimed. */
export function mailTotals(rows: readonly MailRow[]): MailTotals {
  let claimable = 0
  let deletable = 0
  let photos = 0
  for (const row of rows) {
    if (row.claimed) deletable++
    else claimable++
    if (row.photo) photos++
  }
  return { claimable, deletable, photos }
}

// ---- pet profile -------------------------------------------------------------

export interface StatEntry {
  id: string
  label: string
  value: string
  /** 0..1 for a meter; omitted for a plain value. */
  ratio?: number
}

/** A fraction clamped to 0..1; a missing or zero total draws an empty bar. */
export function meterRatio(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0
  return Math.min(1, Math.max(0, value / max))
}

/** The rows of a two-column grid, padded with nulls so the last row keeps its columns. */
export function statGrid(entries: readonly StatEntry[], columns = 2): (StatEntry | null)[][] {
  const cols = Number.isFinite(columns) ? Math.max(1, Math.trunc(columns)) : 2
  const rows: (StatEntry | null)[][] = []
  for (let at = 0; at < entries.length; at += cols) {
    const row: (StatEntry | null)[] = entries.slice(at, at + cols)
    while (row.length < cols) row.push(null)
    rows.push(row)
  }
  return rows
}

/** The numbers the profile prints; the page reads them from the store once per refresh. */
export interface PetNumbers {
  level: number
  yb: number
  diamond: number
  intel: number
  strong: number
  charm: number
  growth: number
  /** Growth at which the current level started. */
  upGrowth: number
  /** Growth at which the next level starts. */
  nextGrowth: number
  hunger: number
  hungerMax: number
  clean: number
  cleanMax: number
  health: number
  healthMax: number
  mood: number
  moodMax: number
  age: string
  growthPerHour: number
  status: string
  onlineMinutes: number
  /** `未开通` or a membership line. */
  pd: string
  /** `未开通` or an expiry line. */
  sweetHeart: string
}

/** 等级 / 元宝 / 钻石 and the pet's three abilities, two per row. */
export function abilityEntries(p: PetNumbers): StatEntry[] {
  return [
    { id: 'level', label: '等级：', value: String(p.level) },
    { id: 'yb', label: '元宝：', value: String(p.yb) },
    { id: 'diamond', label: '钻石：', value: String(p.diamond) },
    { id: 'intel', label: '智力：', value: String(p.intel) },
    { id: 'strong', label: '武力：', value: String(p.strong) },
    { id: 'charm', label: '魅力：', value: String(p.charm) },
  ]
}

const meter = (id: string, label: string, value: string, n: number, m: number): StatEntry => ({
  id,
  label,
  value,
  ratio: meterRatio(n, m),
})

/** The five meters and the six facts the tray's status panel also shows. */
export function statusEntries(p: PetNumbers): StatEntry[] {
  return [
    meter('growth', '成长：', `${Math.round(p.growth)} / ${p.nextGrowth}`, p.growth - p.upGrowth, p.nextGrowth - p.upGrowth),
    meter('hunger', '饥饿：', `${Math.trunc(p.hunger)} / ${p.hungerMax}`, p.hunger, p.hungerMax),
    meter('clean', '清洁：', `${Math.trunc(p.clean)} / ${p.cleanMax}`, p.clean, p.cleanMax),
    meter('health', '健康：', `${Math.trunc(p.health)} / ${p.healthMax}`, p.health, p.healthMax),
    meter('mood', '心情：', `${Math.trunc(p.mood)} / ${p.moodMax}`, p.mood, p.moodMax),
    { id: 'age', label: '年龄：', value: p.age },
    { id: 'speed', label: '成长速度：', value: `${Math.round(p.growthPerHour)}/小时` },
    { id: 'state', label: '状态：', value: p.status },
    { id: 'online', label: '在线时间：', value: `${p.onlineMinutes}分钟` },
    { id: 'pd', label: '粉钻：', value: p.pd },
    { id: 'heart', label: '贴心宝贝：', value: p.sweetHeart },
  ]
}

/**
 * The profile's 状态 line as text. `status()` returns text parts plus a stop
 * button while the pet is busy; the phone profile shows the state only (the
 * state panel owns the stop control), so the nodes are dropped.
 */
export function statusLabel(parts: readonly unknown[]): string {
  return parts
    .filter((part): part is string => typeof part === 'string')
    .join('')
    .trim()
}

/** 性别 is stored as the save's code; the profile prints it the way the original did. */
export const sexLabel = (sex: Sex | string): string => (sex === 'GG' ? 'GG（弟弟）' : sex === 'MM' ? 'MM（妹妹）' : String(sex))
