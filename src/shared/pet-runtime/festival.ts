/**
 * KFC 疯狂星期四 · 企鹅特供日：纯共享节日规则模块。
 *
 * 本模块只接收已经按 06:00 游戏日切好的 dayKey 与存档快照，不读系统时间、
 * 不读时区数据库；同一输入在桌面本地、服务端与移动宿主上结果一致。活动名、
 * 四变体文案、邮件文案与奖励均从 CRAZY_THURSDAY 常量派生，避免多处手写。
 */
import type { SharedSaveData } from '../sync/data-boundary'
import { allGoods, formatGoodCode, goodOf, type RuntimeGood } from './content/index'
import { scaleYbForDifficulty, type RuntimeRng, type TaskDefinition } from './runtime-helpers'
import { addDaysToDayKey, parseDayKey } from './time'

export type FestivalPhase = 'preview' | 'active'

export interface FestivalDay {
  /** 稳定代码键（codeKey）；canonical activityId 见 activityId 字段。 */
  id: string
  name: string
  activityId: string
  phase: FestivalPhase
}

export interface FestivalRewardSpec {
  yb: number
  food: number
  toy: number
}

export interface FestivalVariant {
  id: string
  label: string
  msg: string
  obj: 'Eat' | 'Amusing' | 'Toy' | 'Clean'
  num: number
}

export interface FestivalMailDefinition {
  key: string
  title: string
  moodMessage: string
  phase: FestivalPhase
  /** null 表示预告邮件无附件；active 邮件使用登录礼奖励。 */
  goodsSpec: FestivalRewardSpec | null
}

/** 本周疯狂菜单：preview 提前展示次日周四的变体，active 展示当日变体。 */
export interface FestivalMenu {
  /** 菜单对应的游戏日（preview 仍是周三当天，变体取次日周四）。 */
  dayKey: string
  phase: FestivalPhase
  variantId: string
  label: string
  obj: FestivalVariant['obj']
  num: number
  /** 本周疯狂餐盒固定数量（3 食物 + 1 玩具）。 */
  food: number
  toy: number
  /** 邮件正文 / 任务预览 / 分享卡共用的菜单正文。 */
  text: string
}

export interface FestivalShareGood {
  id: string
  name: string
  type?: string
  url?: string
  num: number
}

export interface FestivalShareInput {
  petName: string
  line: string
  goods: readonly FestivalShareGood[]
}

export interface FestivalConfig {
  activityId: string
  codeKey: string
  name: string
  weekday: number
  enabledFrom: string
  firstRunStartDayKey: string
  /** 以下字段为静态配置/未来字段，MVP 运行时只读取 weekday/enabledFrom/variants/奖励常量。 */
  firstRunEndDayKey: string
  previewDays: number
  lingerDays: number
  previewMail: string
  claimCutoff: string
  loginMail: FestivalRewardSpec
  taskReward: FestivalRewardSpec
  variants: readonly FestivalVariant[]
  fallbackVariantId: string
  maxBoxValue: number
  enabled: boolean
  /** 连续参与多少周授予常客徽章与纪念玩具。 */
  streakWeeks: number
  badgeTitle: string
  badgeGoodId: string
}

export const CRAZY_THURSDAY: FestivalConfig = {
  activityId: 'EVT-T2-20261203-01',
  codeKey: 'weekly-special-day',
  name: 'KFC 疯狂星期四 · 企鹅特供日',
  weekday: 4,
  enabledFrom: '2026-12-03',
  firstRunStartDayKey: '2026-12-03',
  firstRunEndDayKey: '2026-12-04',
  previewDays: 1,
  lingerDays: 1,
  previewMail: 'preview',
  claimCutoff: 'never',
  loginMail: { yb: 30, food: 2, toy: 0 },
  taskReward: { yb: 100, food: 3, toy: 1 },
  variants: [
    {
      id: 'eat-3',
      label: 'V我50·疯狂干饭：喂我 3 次',
      msg: '肯德基疯狂星期四第一件事：干饭！先喂我三顿，吃饱才有力气拆餐盒~',
      obj: 'Eat',
      num: 3,
    },
    {
      id: 'amuse-20',
      label: '原味鸡·疯狂逗乐：逗我 20 次',
      msg: '手速测试开始！点我 20 下，笑出声就算过关，V我50 加个鸡腿~',
      obj: 'Amusing',
      num: 20,
    },
    {
      id: 'toy-3',
      label: '疯狂餐盒·疯狂玩耍：陪我玩 3 次玩具',
      msg: '餐盒里好像有新玩具，先陪我玩三次再说！',
      obj: 'Toy',
      num: 3,
    },
    {
      id: 'clean-2',
      label: '香辣鸡翅·疯狂洗香香：帮我洗 2 次',
      msg: '吃饱玩够，该洗香香啦，帮我洗两次，洗完奖励你一只香辣鸡翅~',
      obj: 'Clean',
      num: 2,
    },
  ],
  fallbackVariantId: 'amuse-20',
  maxBoxValue: 400,
  enabled: true,
  streakWeeks: 4,
  badgeTitle: '疯狂星期四常客',
  badgeGoodId: '900001',
}

const DAY_MS = 86_400_000
const REHEARSAL_PREVIEW_DAY = '2026-11-25'
const REHEARSAL_ACTIVE_DAY = '2026-11-26'

function festivalDayOf(phase: FestivalPhase): FestivalDay {
  return {
    id: CRAZY_THURSDAY.codeKey,
    name: CRAZY_THURSDAY.name,
    activityId: CRAZY_THURSDAY.activityId,
    phase,
  }
}

/** 周一=1…周日=7，用 UTC 日历计算，不依赖宿主时区。 */
function weekdayOfDayKey(dayKey: string): number {
  const parts = parseDayKey(dayKey)
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay() || 7
}

function dayNumber(dayKey: string): number {
  const parts = parseDayKey(dayKey)
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / DAY_MS)
}

/**
 * 判断 dayKey 当天的活动阶段：周三 preview、周四 active、其余 null。
 * 首跑前（含 2026-11-26 演练日）默认不生效；rehearsal 仅供测试。
 */
export function festivalDayForDayKey(dayKey: string, options: { rehearsal?: boolean } = {}): FestivalDay | null {
  if (CRAZY_THURSDAY.enabled === false) return null
  if (options.rehearsal === true) {
    if (dayKey === REHEARSAL_PREVIEW_DAY) return festivalDayOf('preview')
    if (dayKey === REHEARSAL_ACTIVE_DAY) return festivalDayOf('active')
  }
  const weekday = weekdayOfDayKey(dayKey)
  if (weekday === CRAZY_THURSDAY.weekday && dayKey >= CRAZY_THURSDAY.enabledFrom) return festivalDayOf('active')
  if (weekday === CRAZY_THURSDAY.weekday - 1 && addDaysToDayKey(dayKey, 1) >= CRAZY_THURSDAY.enabledFrom) {
    return festivalDayOf('preview')
  }
  return null
}

/** 该 dayKey 所在周的周四；周起点固定为周一。 */
export function weekAnchorDayKey(dayKey: string): string {
  return addDaysToDayKey(dayKey, CRAZY_THURSDAY.weekday - weekdayOfDayKey(dayKey))
}

/** 从首跑 2026-12-03 起算的周序号（1-4 循环，跨年不重置）。 */
export function festivalWeekIndex(dayKey: string): number {
  const target = weekAnchorDayKey(dayKey)
  const weeks = Math.floor((dayNumber(target) - dayNumber(CRAZY_THURSDAY.firstRunStartDayKey)) / 7)
  const cycle = CRAZY_THURSDAY.variants.length
  return ((weeks % cycle) + cycle) % cycle + 1
}

/** 按周序号选变体；MVP 四变体全等级可用，预留给未来不可用兜底。 */
export function festivalVariantForDayKey(dayKey: string, options: { rehearsal?: boolean } = {}): FestivalVariant {
  if (options.rehearsal === true) return CRAZY_THURSDAY.variants[0]
  return CRAZY_THURSDAY.variants[(festivalWeekIndex(dayKey) - 1) % CRAZY_THURSDAY.variants.length]
}

/**
 * 本周疯狂菜单：preview（周三）预取次日周四的变体，active（周四）取当日变体。
 * 邮件正文、任务预览与分享卡共用同一份菜单文案，周三就能看到本周吃什么。
 */
export function festivalMenuForDayKey(
  dayKey: string,
  options: { rehearsal?: boolean } = {},
): FestivalMenu | null {
  const day = festivalDayForDayKey(dayKey, options)
  if (day === null) return null
  const variantDayKey = day.phase === 'preview' ? addDaysToDayKey(dayKey, 1) : dayKey
  const variant = festivalVariantForDayKey(variantDayKey, options)
  const food = CRAZY_THURSDAY.taskReward.food
  const toy = CRAZY_THURSDAY.taskReward.toy
  return {
    dayKey,
    phase: day.phase,
    variantId: variant.id,
    label: variant.label,
    obj: variant.obj,
    num: variant.num,
    food,
    toy,
    text: '本周菜单：' + variant.label + '。KFC 疯狂餐盒含 ' + String(food) + ' 食物 + ' + String(toy) + ' 玩具，V我50 今天吃个痛快！',
  }
}

const PREVIEW_LINE = '明天就是肯德基疯狂星期四了，听说有原味鸡和疯狂餐盒，我先把肚子腾出来~'
const LINGER_LINE = '疯狂星期四结束啦，昨天吃得饱饱的，今天也要好好吃饭哦~'
const ACTIVE_LINES: Record<string, string> = {
  'eat-3': '一口、两口、三口……疯狂星期四的饭就是比平时香！',
  'amuse-20': '再点一下嘛，我快笑出鹅叫了，V我50 买个原味鸡桶~',
  'toy-3': '这个玩具好玩！疯狂餐盒里还有没有别的？',
  'clean-2': '洗香香也是疯狂星期四的一部分，香喷喷才有胃口~',
}

/** 周三预告 / 周四当日宠物台词；其余日期返回 null。 */
export function festivalLineForDayKey(
  dayKey: string,
  options: { rehearsal?: boolean } = {},
): string | null {
  const day = festivalDayForDayKey(dayKey, options)
  if (day === null) return null
  if (day.phase === 'preview') return PREVIEW_LINE
  const variant = festivalVariantForDayKey(dayKey, options)
  return ACTIVE_LINES[variant.id] ?? '肯德基疯狂星期四到啦，V我50 今天吃个痛快！'
}

/** 周五余韵台词；活动首跑前的周五返回 null。 */
export function festivalLingerLineForDayKey(dayKey: string): string | null {
  if (CRAZY_THURSDAY.enabled === false) return null
  if (weekdayOfDayKey(dayKey) !== CRAZY_THURSDAY.weekday + 1) return null
  if (weekAnchorDayKey(dayKey) < CRAZY_THURSDAY.enabledFrom) return null
  return LINGER_LINE
}

function festivalPool(type: 'food' | 'toy', minPrice: number, maxPrice: number): RuntimeGood[] {
  return allGoods(type).filter(good =>
    typeof good.price === 'number' &&
    good.price >= minPrice &&
    good.price <= maxPrice &&
    good.outOfPrint !== true &&
    good.PD !== true,
  )
}

function poolExhaustedError(label: string, count: number, got: number): Error {
  return new Error('festival ' + label + ' pool cannot supply ' + String(count) + ' items (got ' + String(got) + ')')
}

function pickFromPool(pool: readonly RuntimeGood[], count: number, rng: RuntimeRng, label: string): RuntimeGood[] {
  const remaining = pool.slice()
  const picks: RuntimeGood[] = []
  while (picks.length < count) {
    if (remaining.length === 0) throw poolExhaustedError(label, count, picks.length)
    const index = rng.randomIndex(remaining.length)
    if (index === null) throw poolExhaustedError(label, count, picks.length)
    const [good] = remaining.splice(index, 1)
    picks.push({ ...good, num: 1 })
  }
  return picks
}

function cheapestFromPool(pool: readonly RuntimeGood[], count: number, label: string): RuntimeGood[] {
  if (pool.length < count) throw poolExhaustedError(label, count, pool.length)
  return pool
    .slice()
    .sort((a, b) => (a.price ?? Number.MAX_SAFE_INTEGER) - (b.price ?? Number.MAX_SAFE_INTEGER))
    .slice(0, count)
    .map(good => ({ ...good, num: 1 }))
}

function goodsValue(goods: readonly RuntimeGood[]): number {
  return goods.reduce((sum, good) => sum + (good.price ?? 0), 0)
}

/**
 * 按奖励规格抽取活动物品：食物池 5-150、玩具池 16-120，均排除
 * outOfPrint/PD；每项固定 num=1。奖池不足以抽满时显式抛错，不静默少发。
 * 元宝走标准难度缩放。
 */
export function festivalMailGoods(save: SharedSaveData, spec: FestivalRewardSpec, rng: RuntimeRng): RuntimeGood[] {
  const foodPool = festivalPool('food', 5, 150)
  const toyPool = festivalPool('toy', 16, 120)
  const draw = (): RuntimeGood[] => [
    ...pickFromPool(foodPool, spec.food, rng, 'food'),
    ...pickFromPool(toyPool, spec.toy, rng, 'toy'),
  ]
  let items = draw()
  // 疯狂餐盒硬上限保护：超价重抽最多 3 次，仍超则改用池内最低价组合。
  for (let attempt = 0; attempt < 3 && goodsValue(items) > CRAZY_THURSDAY.maxBoxValue; attempt++) {
    items = draw()
  }
  if (goodsValue(items) > CRAZY_THURSDAY.maxBoxValue) {
    items = [...cheapestFromPool(foodPool, spec.food, 'food'), ...cheapestFromPool(toyPool, spec.toy, 'toy')]
  }
  return [...items, { ...goodOf('nums', 'yb'), num: scaleYbForDifficulty(save, spec.yb) }]
}

/** 周四特供任务：返回带 festivalId/festivalIssueWeek 的普通 TaskDefinition。 */
export function festivalTaskForDayKey(
  dayKey: string,
  save: SharedSaveData,
  rng: RuntimeRng,
  options: { rehearsal?: boolean } = {},
): TaskDefinition | null {
  const day = festivalDayForDayKey(dayKey, options)
  if (day === null || day.phase !== 'active') return null
  const variant = festivalVariantForDayKey(dayKey, options)
  const goods = festivalMailGoods(save, CRAZY_THURSDAY.taskReward, rng)
  return {
    label: variant.label,
    msg: variant.msg,
    obj: variant.obj,
    num: variant.num,
    festivalId: CRAZY_THURSDAY.activityId,
    festivalIssueWeek: weekAnchorDayKey(dayKey),
    good: goods.map(good => formatGoodCode(good, good.num)),
  }
}

/** preview 返回无附件预告邮件，active 返回登录礼邮件；其余日期 null。 */
export function festivalMailForDayKey(dayKey: string, options: { rehearsal?: boolean } = {}): FestivalMailDefinition | null {
  const day = festivalDayForDayKey(dayKey, options)
  if (day === null) return null
  const menu = festivalMenuForDayKey(dayKey, options)
  const menuText = menu === null ? '' : menu.text
  if (day.phase === 'preview') {
    return {
      key: 'crazy-thursday-preview-' + dayKey,
      title: '明天就是肯德基疯狂星期四，V我50？',
      // 标题保持不变；正文补足本周菜单，让玩家提前看到周四吃什么。
      moodMessage: 'V我50！' + menuText,
      phase: 'preview',
      goodsSpec: null,
    }
  }
  return {
    key: 'crazy-thursday-' + dayKey,
    title: '肯德基疯狂星期四：你的专属餐盒到了',
    moodMessage: '今天吃肯德基！' + menuText,
    phase: 'active',
    goodsSpec: CRAZY_THURSDAY.loginMail,
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** 分享卡文字宽度估算：ASCII 半角按 0.5 个中文字宽，其余（中文/全角/emoji）按 1。 */
function shareTextUnits(char: string): number {
  return (char.codePointAt(0) ?? 0) <= 0x7f ? 0.5 : 1
}

function shareTextWidth(value: string, fontSize: number): number {
  let units = 0
  for (const char of Array.from(value)) units += shareTextUnits(char)
  return units * fontSize
}

/** 只由收尾标点组成的末行不单独成行（最多让上一行多容纳 1 个字宽，仍在 600 内）。 */
const CLOSING_PUNCTUATION = new Set([
  '，', '。', '！', '？', '；', '：', '、', '）', '》', '」', '』', '】', '…',
  ',', '.', '!', '?', ';', ':', ')', ']', '}',
])

/** 按最大字宽折行，避免长台词/宠物名在 600 宽分享卡里横向溢出。 */
function wrapShareText(value: string, maxUnits: number): string[] {
  const lines: string[] = []
  let line = ''
  let units = 0
  for (const char of Array.from(value)) {
    const width = shareTextUnits(char)
    if (line !== '' && units + width > maxUnits) {
      // 收尾标点不另起一行：允许当前行多容纳 1 个字宽，视觉上仍在 600 内。
      if (CLOSING_PUNCTUATION.has(char) && units + width <= maxUnits + 1) {
        line += char
        units += width
        continue
      }
      lines.push(line)
      line = ''
      units = 0
    }
    line += char
    units += width
  }
  if (line !== '' || lines.length === 0) lines.push(line)
  if (lines.length > 1) {
    const last = lines[lines.length - 1]
    const previous = lines[lines.length - 2]
    if (Array.from(last).every(char => CLOSING_PUNCTUATION.has(char))) {
      let lastUnits = 0
      for (const char of Array.from(last)) lastUnits += shareTextUnits(char)
      let previousUnits = 0
      for (const char of Array.from(previous)) previousUnits += shareTextUnits(char)
      if (previousUnits + lastUnits <= maxUnits + 1) {
        lines[lines.length - 2] = previous + last
        lines.pop()
      }
    }
  }
  return lines
}

/** 居中多行文本：每行一个 <tspan>，行高由 dy 控制。 */
function shareTextLines(
  lines: readonly string[],
  top: number,
  fontSize: number,
  lineHeight: number,
  fill: string,
): string {
  const spans = lines
    .map((line, index) => '<tspan x="300" dy="' + String(index === 0 ? 0 : lineHeight) + '">' + escapeXml(line) + '</tspan>')
    .join('')
  return '<text x="300" y="' + String(top) + '" font-size="' + String(fontSize) + '" text-anchor="middle" fill="' + fill + '">'
    + spans + '</text>'
}

/**
 * 生成「晒餐盒」分享卡 SVG（纯字符串，不依赖 DOM/canvas）。
 * 宠物名按约 16 字/行、台词按约 26 字/行拆 <tspan>，长物品名用 textLength 等比缩放；
 * 所有玩家可见文本都做 XML 转义，避免宠物名/物品名里的尖括号破坏标签。
 */
export function festivalShareCardSvg(input: FestivalShareInput): string {
  const petNameLines = wrapShareText(input.petName, 16)
  const lineLines = wrapShareText(input.line, 26)
  const petNameTop = 292
  const petNameLineHeight = 40
  const lineTop = Math.max(342, petNameTop + (petNameLines.length - 1) * petNameLineHeight + 42)
  const lineLineHeight = 30
  const lineBottom = lineTop + (lineLines.length - 1) * lineLineHeight
  const goodsTop = Math.max(430, lineBottom + 40)
  const rows = input.goods.map((good, index) => {
    const y = goodsTop + index * 64
    // 物品名左对齐，右侧留给数量；估算超过 380px 时压缩字形，保证 600 宽不溢出。
    const fit = shareTextWidth(good.name, 24) > 380 ? ' textLength="380" lengthAdjust="spacingAndGlyphs"' : ''
    return '<g><rect x="60" y="' + String(y - 34) + '" width="480" height="48" rx="12" fill="#fff8ec"/>'
      + '<text x="84" y="' + String(y) + '" font-size="24" fill="#3a2a1a"' + fit + '>' + escapeXml(good.name) + '</text>'
      + '<text x="516" y="' + String(y) + '" font-size="24" text-anchor="end" fill="#c62828">× ' + String(good.num) + '</text></g>'
  }).join('')
  return '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800">'
    + '<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c62828"/><stop offset="1" stop-color="#7f1010"/></linearGradient></defs>'
    + '<rect width="600" height="800" fill="url(#bg)"/>'
    + '<circle cx="300" cy="150" r="88" fill="#fff8ec"/>'
    + '<text x="300" y="140" font-size="30" text-anchor="middle" fill="#c62828">疯狂星期四</text>'
    + '<text x="300" y="182" font-size="22" text-anchor="middle" fill="#7f1010">企鹅特供日</text>'
    + shareTextLines(petNameLines, petNameTop, 34, petNameLineHeight, '#fff8ec')
    + shareTextLines(lineLines, lineTop, 22, lineLineHeight, '#ffe6c7')
    + rows
    + '<text x="300" y="740" font-size="18" text-anchor="middle" fill="#ffe6c7">KFC 疯狂星期四 · V我50</text>'
    + '</svg>'
}

/** 连续第四周纪念玩具：goods.json 中的非卖品 900001。 */
export function festivalMilestoneGood(): RuntimeGood {
  return goodOf('toy', CRAZY_THURSDAY.badgeGoodId)
}

/**
 * 计算本次领取后的连续周数：以 festivalClaims 账本为唯一权威，从 issueWeek
 * 的前一周开始沿账本逐周回数，断周即重置为 1。previousStreak 仅为旧档缓存
 * 保留、不参与计算，避免缓存高于账本时让异常存档提前拿到常客徽章。
 */
export function festivalStreakForClaim(
  _previousStreak: number,
  claimedWeeks: readonly string[],
  issueWeek: string,
): number {
  const claimed = new Set(claimedWeeks)
  let consecutive = 0
  let cursor = addDaysToDayKey(issueWeek, -7)
  while (claimed.has(cursor)) {
    consecutive += 1
    cursor = addDaysToDayKey(cursor, -7)
  }
  return consecutive + 1
}
