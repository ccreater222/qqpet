import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// 与 pet-runtime-festival.test.mjs 相同的 TS 解析钩子：src/shared/pet-runtime 与 sync 内部
// 的扩展名省略导入在 --experimental-strip-types 下需要显式补 .ts。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL &&
        /\/src\/shared\/(pet-runtime|sync)\//.test(context.parentURL) &&
        /\.[cm]?[jt]s$/.test(specifier) === false && specifier.endsWith('.json') === false) {
      return nextResolve(specifier + '.ts', context)
    }
    return nextResolve(specifier, context)
  },
})

const {
  CRAZY_THURSDAY,
  festivalMenuForDayKey,
  festivalMailForDayKey,
  festivalLineForDayKey,
  festivalLingerLineForDayKey,
  festivalShareCardSvg,
  festivalMilestoneGood,
  festivalStreakForClaim,
} = await import('../../src/shared/pet-runtime/festival.ts')
const {
  createRngState,
  dailyBoundaryMs,
  dayKeyAt,
  executeCommand,
  nextDailyBoundaryMs,
} = await import('../../src/shared/pet-runtime/index.ts')
const {
  createRuntimeRng,
  defaultTaskProgress,
  inventoryCount,
  readTaskProgress,
  writeTaskProgress,
} = await import('../../src/shared/pet-runtime/runtime-helpers.ts')
const { rollDailyTasks, resetDailyTasks } = await import('../../src/shared/pet-runtime/runtime-tasks.ts')
const { goodOf } = await import('../../src/shared/pet-runtime/content/index.ts')
const { validateSharedSaveJsonBlob } = await import('../../src/shared/sync/data-boundary.ts')
const { createSyncFixtures, LOCAL_DEVICE_ID, SEED } = await import('./sync-fixtures.mjs')

const TZ = 'Asia/Shanghai'
const ACTIVITY_ID = 'EVT-T2-20261203-01'
const MILESTONE_GOOD_ID = '900001'

const fixtures = createSyncFixtures()

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function freshSave(difficulty = 'easy') {
  const save = clone(fixtures.shared)
  save.petInfo.health = 5
  save.petInfo.hunger = 1100
  save.petInfo.clean = 1100
  save.petInfo.mood = 1000
  save.petInfo.yb = 5000
  save.petInfo.birthDay = Math.floor(Date.UTC(2025, 0, 1) / 1000)
  save.petInfo.pinkDiamond = false
  save.petInfo.PDgrowth = 0
  save.petInfo.PDgrowthValue = 0
  save.petInfo.PDgrowthValue_next = 0
  save.petInfo.PDiamondLevel = 0
  save.petInfo.PDiamondBeginDate = 0
  save.petInfo.PDiamondExpirationDate = 0
  save.petInfo.PDiamondYear = false
  save.petInfo.sweetHeart = false
  save.petInfo.sweetHeartOverTime = 0
  save.settings = { ...save.settings, paused: false, difficulty }
  save.saveJsonData = { ...save.saveJsonData, email: '{}', task: '{}', signin: '{}' }
  return save
}

function gameState({ atMs, difficulty = 'easy' } = {}) {
  const state = clone(fixtures.engine)
  state.save = freshSave(difficulty)
  state.gameTimeMs = atMs
  state.timeZone = TZ
  state.weatherLocation = 'Shanghai'
  state.advanceWhileEmpty = true
  state.lastProcessedDayBoundaryKey = dayKeyAt(atMs, TZ)
  state.nextDailyBoundaryMs = nextDailyBoundaryMs(atMs, TZ)
  state.lastSchedulerWallMs = atMs
  state.scheduledJobs = []
  state.nextScheduledJobId = 1
  state.gameSessions = []
  state.sessionCoverage = []
  delete state.coverageReopen
  state.importClamped = false
  state.clockSkippedMs = 0
  state.environment = { calendarByDay: {}, weatherByDay: {} }
  return state
}

function context(state, overrides = {}) {
  return {
    gameTimeMs: state.gameTimeMs,
    environment: state.environment,
    activeClientCount: 1,
    sessionActive: true,
    actorDeviceId: LOCAL_DEVICE_ID,
    actorRole: 'player',
    ...overrides,
  }
}

function rng() {
  return createRuntimeRng(createRngState(SEED))
}

test('CRAZY_THURSDAY 补强常量：四周常客徽章与纪念物品', () => {
  assert.equal(CRAZY_THURSDAY.streakWeeks, 4)
  assert.equal(CRAZY_THURSDAY.badgeTitle, '疯狂星期四常客')
  assert.equal(CRAZY_THURSDAY.badgeGoodId, MILESTONE_GOOD_ID)
})

test('festivalMenuForDayKey：周三预览/周四 active 返回本周菜单，普通日期 null', () => {
  const preview = festivalMenuForDayKey('2026-12-02')
  assert.ok(preview, '2026-12-02 是 preview，必须返回本周菜单')
  assert.equal(preview.dayKey, '2026-12-02')
  assert.equal(preview.variantId, 'eat-3')
  assert.equal(preview.label, CRAZY_THURSDAY.variants[0].label)
  assert.equal(preview.obj, 'Eat')
  assert.equal(preview.num, 3)
  assert.equal(preview.food, 3)
  assert.equal(preview.toy, 1)
  assert.equal(typeof preview.text, 'string')
  assert.ok(preview.text.includes('本周菜单'), preview.text)
  assert.ok(preview.text.includes(preview.label), preview.text)
  assert.ok(preview.text.includes('3 食物'), preview.text)
  assert.ok(preview.text.includes('1 玩具'), preview.text)

  const active = festivalMenuForDayKey('2026-12-03')
  assert.ok(active, '2026-12-03 是 active，必须返回本周菜单')
  assert.equal(active.dayKey, '2026-12-03')
  assert.equal(active.variantId, preview.variantId)
  assert.equal(active.obj, preview.obj)
  assert.equal(active.num, preview.num)
  assert.equal(active.food, 3)
  assert.equal(active.toy, 1)
  assert.ok(active.text.includes('本周菜单'), active.text)

  // 第二周菜单跟着周序号换变体。
  const week2 = festivalMenuForDayKey('2026-12-09')
  assert.ok(week2)
  assert.equal(week2.variantId, 'amuse-20')
  assert.equal(week2.obj, 'Amusing')
  assert.equal(week2.num, 20)

  assert.equal(festivalMenuForDayKey('2026-12-04'), null)
  assert.equal(festivalMenuForDayKey('2026-12-08'), null)
  assert.equal(festivalMenuForDayKey('2026-11-26'), null)
})

test('festivalMailForDayKey：预告/今日邮件正文含本周菜单与餐盒数量', () => {
  for (const dayKey of ['2026-12-02', '2026-12-03']) {
    const mail = festivalMailForDayKey(dayKey)
    assert.ok(mail, dayKey)
    assert.equal(typeof mail.moodMessage, 'string')
    assert.match(mail.moodMessage, /本周菜单/, dayKey + ' 正文必须带本周菜单预览')
    assert.match(mail.moodMessage, /3\s*份?食物/, dayKey + ' 正文必须写 3 食物')
    assert.match(mail.moodMessage, /1\s*个?玩具/, dayKey + ' 正文必须写 1 玩具')
  }

  // 标题沿用 §6.2，不得因为补正文而改掉。
  assert.equal(festivalMailForDayKey('2026-12-02').title, '明天就是肯德基疯狂星期四，V我50？')
  assert.equal(festivalMailForDayKey('2026-12-03').title, '肯德基疯狂星期四：你的专属餐盒到了')
})

test('festivalLineForDayKey 与 festivalLingerLineForDayKey：周三/周四台词、周五余韵、其余 null', () => {
  const preview = festivalLineForDayKey('2026-12-02')
  const active = festivalLineForDayKey('2026-12-03')
  for (const [dayKey, line] of [['2026-12-02', preview], ['2026-12-03', active]]) {
    assert.equal(typeof line, 'string', dayKey)
    assert.ok(line.length > 0, dayKey + ' 台词不得为空')
    assert.match(line, /疯狂星期四|肯德基|V我50/, dayKey + ' 必须是 KFC 主题台词：' + line)
  }
  assert.equal(festivalLineForDayKey('2026-12-04'), null, '周五由余韵台词函数负责')
  assert.equal(festivalLineForDayKey('2026-12-08'), null)
  assert.equal(festivalLineForDayKey('2026-11-26'), null)

  const linger = festivalLingerLineForDayKey('2026-12-04')
  assert.equal(typeof linger, 'string')
  assert.ok(linger.length > 0)
  assert.match(linger, /疯狂星期四|昨天/, '周五余韵台词：' + linger)
  assert.ok(festivalLingerLineForDayKey('2026-12-11'), '第二个周五也要有余韵')
  assert.equal(festivalLingerLineForDayKey('2026-12-03'), null, '周四不是余韵日')
  assert.equal(festivalLingerLineForDayKey('2026-12-02'), null, '周三不是余韵日')
})

test('festivalShareCardSvg：生成 SVG 并转义 petName/line/物品名', () => {
  const svg = festivalShareCardSvg({
    petName: '小鹅<&"',
    line: 'V我50 & <吃鸡>',
    goods: [
      { id: 't0001', name: '原味鸡<桶>', type: 'food', url: '', num: 3 },
      { id: 't0002', name: '疯狂玩具', type: 'toy', url: '', num: 1 },
    ],
  })
  assert.equal(typeof svg, 'string')
  assert.ok(svg.trimStart().startsWith('<svg'), '必须返回 <svg 字符串')
  assert.ok(svg.includes('小鹅&lt;&amp;'), 'petName 必须做 XML 转义：' + svg.slice(0, 300))
  assert.ok(svg.includes('V我50 &amp; &lt;吃鸡&gt;'), 'line 必须做 XML 转义')
  assert.ok(svg.includes('原味鸡&lt;桶&gt;'), '物品名必须做 XML 转义')
  assert.equal(svg.includes('<桶>'), false, '不得把物品名里的尖括号原样拼进标签')
  assert.ok(svg.includes('疯狂玩具'))
  assert.match(svg, /原味鸡[\s\S]{0,200}3|3[\s\S]{0,200}原味鸡/, '物品数量必须出现在卡片里')
  assert.match(svg, /疯狂玩具[\s\S]{0,120}1|1[\s\S]{0,120}疯狂玩具/, '玩具数量必须出现在卡片里')
})

test('festivalMilestoneGood：返回 900001 疯狂星期四纪念玩具', () => {
  const good = festivalMilestoneGood()
  assert.deepEqual(good, goodOf('toy', MILESTONE_GOOD_ID))
  assert.equal(good.type, 'toy')
  assert.equal(good.id, MILESTONE_GOOD_ID)
  assert.ok(good.name.includes('疯狂星期四'), good.name)
  assert.equal(good.price, -1)
})

test('festivalStreakForClaim：连续周 +1、断周重置 1、旧档三个连续周补算为 4', () => {
  // 连续周：上一周在账本里，周数 +1。
  assert.equal(festivalStreakForClaim(2, ['2026-12-03', '2026-12-10'], '2026-12-17'), 3)
  // 断周：上一周不在账本里，从 1 重新开始。
  assert.equal(festivalStreakForClaim(2, ['2026-12-03'], '2026-12-17'), 1)
  // 旧档只有 festivalClaims、没有 streak 字段：已连续三周时补算为 4。
  assert.equal(festivalStreakForClaim(0, ['2026-12-03', '2026-12-10', '2026-12-17'], '2026-12-24'), 4)
  // 第一次领取。
  assert.equal(festivalStreakForClaim(0, [], '2026-12-03'), 1)
})

test('TaskProgress：festivalStreak/festivalBadges 可读写、日切保留、空字段不落盘', () => {
  const save = freshSave()
  const claims = { [ACTIVITY_ID]: { '2026-12-03': true, '2026-12-10': true } }
  writeTaskProgress(save, {
    ...defaultTaskProgress(),
    festivalClaims: claims,
    festivalStreak: { [ACTIVITY_ID]: 2 },
    festivalBadges: { [ACTIVITY_ID]: '疯狂星期四常客' },
  })

  let progress = readTaskProgress(save)
  assert.deepEqual(progress.festivalClaims, claims)
  assert.deepEqual(progress.festivalStreak, { [ACTIVITY_ID]: 2 })
  assert.deepEqual(progress.festivalBadges, { [ACTIVITY_ID]: '疯狂星期四常客' })

  // 06:00 日切重掷 daily 表时，常客进度与徽章不得丢。
  resetDailyTasks(save, dailyBoundaryMs('2026-12-10', TZ), TZ, rng())
  progress = readTaskProgress(save)
  assert.deepEqual(progress.festivalClaims, claims)
  assert.deepEqual(progress.festivalStreak, { [ACTIVITY_ID]: 2 })
  assert.deepEqual(progress.festivalBadges, { [ACTIVITY_ID]: '疯狂星期四常客' })

  // 可选字段全空时不落盘，普通存档与旧 golden 保持一致。
  const emptySave = freshSave()
  writeTaskProgress(emptySave, defaultTaskProgress())
  const raw = JSON.parse(emptySave.saveJsonData.task)
  assert.equal(Object.prototype.hasOwnProperty.call(raw, 'festivalClaims'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(raw, 'festivalStreak'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(raw, 'festivalBadges'), false)

  // 同步边界必须接受新字段，否则本地写下的常客进度会在上传/导入时被判非法。
  const blob = JSON.stringify({
    doNums: {},
    taskList: { daily: [], ddw: [], growth: [], travel: [] },
    daily: [],
    dailyDay: 0,
    festivalClaims: claims,
    festivalStreak: { [ACTIVITY_ID]: 2 },
    festivalBadges: { [ACTIVITY_ID]: '疯狂星期四常客' },
  })
  assert.equal(validateSharedSaveJsonBlob('task', blob), true, 'data-boundary 必须接受 festivalStreak/festivalBadges')
})

test('task.claim：连续第四周领取授予 streak=4/常客徽章/纪念玩具，普通任务不受影响', () => {
  const state = gameState({ atMs: dailyBoundaryMs('2026-12-24', TZ) })
  rollDailyTasks(state.save, state.gameTimeMs, TZ, rng())

  let progress = readTaskProgress(state.save)
  assert.equal(progress.daily.length, 5)
  const festival = progress.daily[4]
  assert.equal(festival.festivalId, ACTIVITY_ID)
  assert.equal(festival.festivalIssueWeek, '2026-12-24')

  // 预置前三周（12-03/12-10/12-17）已领取、连续 3 周的旧档状态。
  progress.festivalClaims = {
    [ACTIVITY_ID]: { '2026-12-03': true, '2026-12-10': true, '2026-12-17': true },
  }
  progress.festivalStreak = { [ACTIVITY_ID]: 3 }
  progress.festivalBadges = {}
  progress.doNums[festival.obj] = festival.num
  writeTaskProgress(state.save, progress)

  assert.equal(readTaskProgress(state.save).festivalStreak[ACTIVITY_ID], 3)
  assert.equal(inventoryCount(state.save, 'toy', MILESTONE_GOOD_ID), 0)

  const claimed = executeCommand(state, { type: 'task.claim', payload: { tab: 'daily', index: 4 } }, context(state))
  assert.equal(claimed.ok, true, JSON.stringify(claimed.ok ? claimed.result : claimed.error))

  const after = readTaskProgress(claimed.state.save)
  assert.equal(after.festivalClaims[ACTIVITY_ID]['2026-12-24'], true)
  assert.equal(after.festivalStreak[ACTIVITY_ID], 4)
  assert.equal(after.festivalBadges[ACTIVITY_ID], '疯狂星期四常客')
  assert.equal(inventoryCount(claimed.state.save, 'toy', MILESTONE_GOOD_ID), 1, '第四周必须发放纪念玩具')

  // 同一任务再次领取仍被账本拦截，纪念玩具不重复发放。
  const again = executeCommand(claimed.state, { type: 'task.claim', payload: { tab: 'daily', index: 4 } }, context(claimed.state))
  assert.equal(again.ok, false)
  assert.equal(again.error.code, 'already_claimed')
  assert.equal(inventoryCount(claimed.state.save, 'toy', MILESTONE_GOOD_ID), 1)

  // 普通每日任务照常领取，不被常客逻辑影响。
  const normalProgress = readTaskProgress(claimed.state.save)
  const normal = normalProgress.daily[0]
  assert.equal(normal.festivalId, undefined)
  normalProgress.doNums[normal.obj] = normal.num
  writeTaskProgress(claimed.state.save, normalProgress)
  const normalClaim = executeCommand(claimed.state, { type: 'task.claim', payload: { tab: 'daily', index: 0 } }, context(claimed.state))
  assert.equal(normalClaim.ok, true, JSON.stringify(normalClaim.ok ? normalClaim.result : normalClaim.error))
  const final = readTaskProgress(normalClaim.state.save)
  assert.equal(final.festivalStreak[ACTIVITY_ID], 4)
  assert.equal(final.festivalBadges[ACTIVITY_ID], '疯狂星期四常客')
  assert.equal(inventoryCount(normalClaim.state.save, 'toy', MILESTONE_GOOD_ID), 1)
})
