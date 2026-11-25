import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// 与 pet-runtime-c3.test.mjs 相同的 TS 解析钩子：src/shared/pet-runtime 与 sync 内部
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
  festivalDayForDayKey,
  weekAnchorDayKey,
  festivalWeekIndex,
  festivalTaskForDayKey,
  festivalMailForDayKey,
  festivalMailGoods,
} = await import('../../src/shared/pet-runtime/festival.ts')

const {
  advanceMinute,
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
const { parseGoodCode } = await import('../../src/shared/pet-runtime/content/index.ts')
const { createSyncFixtures, LOCAL_DEVICE_ID, SEED } = await import('./sync-fixtures.mjs')

const TZ = 'Asia/Shanghai'
const ACTIVITY_ID = 'EVT-T2-20261203-01'
const FIRST_THURSDAY = '2026-12-03'

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

function tick(state) {
  const outcome = advanceMinute(state, context(state))
  assert.equal(outcome.ok, true, JSON.stringify(outcome.ok ? outcome.result : outcome.error))
  return outcome.state
}

function mailsOf(state) {
  return JSON.parse(state.save.saveJsonData.email ?? '{}')
}

function mailByKey(state, key) {
  return Object.values(mailsOf(state)).find(mail => mail !== null && typeof mail === 'object' && mail.k === key)
}

function festivalMailKeys(state) {
  return Object.values(mailsOf(state))
    .map(mail => (mail !== null && typeof mail === 'object' ? mail.k : undefined))
    .filter(key => typeof key === 'string' && key.startsWith('crazy-thursday-'))
}

function rng() {
  return createRuntimeRng(createRngState(SEED))
}

function normalizeGoods(entries = []) {
  return entries.map(entry => (typeof entry === 'string' ? parseGoodCode(entry) : entry)).filter(good => good !== null)
}

function countType(goods, type) {
  return goods.filter(good => good.type === type).length
}

function ybOf(goods) {
  return goods.find(good => good.type === 'nums' && good.id === 'yb')
}

test('festival 日期规则：周三 preview、周四 active、其余 null（含首跑闸门与 rehearsal）', () => {
  assert.equal(CRAZY_THURSDAY.activityId, ACTIVITY_ID)
  assert.equal(CRAZY_THURSDAY.codeKey, 'weekly-special-day')
  assert.equal(CRAZY_THURSDAY.enabledFrom, FIRST_THURSDAY)
  assert.equal(CRAZY_THURSDAY.weekday, 4)
  assert.equal(CRAZY_THURSDAY.enabled, true)
  assert.equal(CRAZY_THURSDAY.loginMail.yb, 30)
  assert.equal(CRAZY_THURSDAY.loginMail.food, 2)
  assert.equal(CRAZY_THURSDAY.taskReward.yb, 100)
  assert.equal(CRAZY_THURSDAY.taskReward.food, 3)
  assert.equal(CRAZY_THURSDAY.taskReward.toy, 1)
  assert.equal(CRAZY_THURSDAY.variants.length, 4)

  const preview = festivalDayForDayKey('2026-12-02')
  assert.ok(preview)
  assert.equal(preview.phase, 'preview')
  assert.equal(preview.id, CRAZY_THURSDAY.codeKey)
  assert.equal(preview.name, CRAZY_THURSDAY.name)

  const active = festivalDayForDayKey(FIRST_THURSDAY)
  assert.ok(active)
  assert.equal(active.phase, 'active')
  assert.equal(active.id, CRAZY_THURSDAY.codeKey)

  assert.equal(festivalDayForDayKey('2026-12-04'), null)
  assert.equal(festivalDayForDayKey('2026-11-26'), null)
  assert.equal(festivalDayForDayKey('2026-12-01'), null)
  assert.equal(festivalDayForDayKey('2026-10-20'), null)

  // 第二周自动平移：周三 12-09 preview、周四 12-10 active、周五 12-11 落空。
  assert.equal(festivalDayForDayKey('2026-12-09').phase, 'preview')
  assert.equal(festivalDayForDayKey('2026-12-10').phase, 'active')
  assert.equal(festivalDayForDayKey('2026-12-11'), null)
  // 跨年周四仍是活动日。
  assert.equal(festivalDayForDayKey('2026-12-31').phase, 'active')

  // rehearsal 只影响测试窗口 2026-11-25 preview / 2026-11-26 active。
  assert.equal(festivalDayForDayKey('2026-11-25', { rehearsal: true }).phase, 'preview')
  assert.equal(festivalDayForDayKey('2026-11-26', { rehearsal: true }).phase, 'active')
})

test('weekAnchorDayKey 以周一为周起点，festivalWeekIndex 按首跑锚点 1-4 循环', () => {
  assert.equal(weekAnchorDayKey('2026-12-07'), '2026-12-10') // 周一
  assert.equal(weekAnchorDayKey('2026-12-09'), '2026-12-10') // 周三 -> 本周四
  assert.equal(weekAnchorDayKey('2026-12-10'), '2026-12-10') // 周四本身
  assert.equal(weekAnchorDayKey('2026-12-11'), '2026-12-10') // 周五 -> 本周四
  assert.equal(weekAnchorDayKey('2026-12-13'), '2026-12-10') // 周日 -> 本周四
  assert.equal(weekAnchorDayKey('2026-12-14'), '2026-12-17') // 下周一 -> 下周四

  assert.equal(festivalWeekIndex('2026-12-03'), 1)
  assert.equal(festivalWeekIndex('2026-12-10'), 2)
  assert.equal(festivalWeekIndex('2026-12-17'), 3)
  assert.equal(festivalWeekIndex('2026-12-24'), 4)
  assert.equal(festivalWeekIndex('2026-12-31'), 1) // 第 5 次循环回第 1 变体，跨年不重置

  // preview 用 dayKey+1 的目标周四计算周序。
  assert.equal(festivalWeekIndex('2026-12-02'), 1)
  assert.equal(festivalWeekIndex('2026-12-09'), 2)
})

test('festivalTaskForDayKey：四变体按周轮换、festivalId/issueWeek 与餐盒奖励正确', () => {
  const cases = [
    ['2026-12-03', 'Eat', 3],
    ['2026-12-10', 'Amusing', 20],
    ['2026-12-17', 'Toy', 3],
    ['2026-12-24', 'Clean', 2],
    ['2026-12-31', 'Eat', 3],
  ]
  for (const [dayKey, obj, num] of cases) {
    const task = festivalTaskForDayKey(dayKey, freshSave('easy'), rng())
    assert.ok(task, dayKey)
    assert.equal(task.festivalId, ACTIVITY_ID, dayKey)
    assert.equal(task.festivalIssueWeek, weekAnchorDayKey(dayKey), dayKey)
    assert.equal(task.obj, obj, dayKey)
    assert.equal(task.num, num, dayKey)
    assert.equal(typeof task.label, 'string')
    assert.ok(task.label.length > 0, dayKey)
    assert.ok(Array.isArray(task.good), dayKey)

    const goods = normalizeGoods(task.good)
    assert.equal(goods.length, task.good.length, dayKey + ' good codes must all parse')
    assert.equal(countType(goods, 'food'), 3, dayKey)
    assert.equal(countType(goods, 'toy'), 1, dayKey)
    const yb = ybOf(goods)
    assert.ok(yb, dayKey)
    assert.equal(yb.num, 100, dayKey)
    for (const good of goods.filter(good => good.type !== 'nums')) {
      assert.equal(good.num, 1, dayKey + ' item num must be 1')
    }
  }

  // standard 难度：任务元宝在生成时固定为 round(100 * 0.4) = 40，物品数量不变。
  const standardTask = festivalTaskForDayKey('2026-12-03', freshSave('standard'), rng())
  const standardGoods = normalizeGoods(standardTask.good)
  assert.equal(ybOf(standardGoods).num, 40)
  assert.equal(countType(standardGoods, 'food'), 3)
  assert.equal(countType(standardGoods, 'toy'), 1)
})

test('rollDailyTasks：周四 4 条日常后追加第 5 条特供任务，周五/普通日仍 4 条', () => {
  const thursdayMs = dailyBoundaryMs('2026-12-03', TZ)
  const thursdaySave = freshSave()
  const thursday = rollDailyTasks(thursdaySave, thursdayMs, TZ, rng())
  assert.equal(thursday.length, 5)
  assert.equal(thursday.slice(0, 4).some(task => task.festivalId !== undefined), false)
  assert.equal(thursday[4].festivalId, ACTIVITY_ID)
  assert.equal(thursday[4].festivalIssueWeek, '2026-12-03')
  assert.equal(readTaskProgress(thursdaySave).daily.length, 5)
  assert.equal(readTaskProgress(thursdaySave).taskList.daily.length, 5)

  const fridaySave = freshSave()
  const friday = rollDailyTasks(fridaySave, dailyBoundaryMs('2026-12-04', TZ), TZ, rng())
  assert.equal(friday.length, 4)
  assert.equal(friday.some(task => task.festivalId !== undefined), false)

  const normalSave = freshSave()
  const normal = rollDailyTasks(normalSave, dailyBoundaryMs('2026-12-08', TZ), TZ, rng())
  assert.equal(normal.length, 4)

  const beforeLaunchSave = freshSave()
  const beforeLaunch = rollDailyTasks(beforeLaunchSave, dailyBoundaryMs('2026-11-26', TZ), TZ, rng())
  assert.equal(beforeLaunch.length, 4)

  // 法定节假日：特供任务固定在 daily[4]，节假日额外任务顺延到 daily[5]。
  const holidaySave = freshSave()
  const holidayTask = {
    label: '测试节快乐',
    msg: '过节啦，陪我玩5次玩具一起庆祝吧~',
    obj: 'Toy',
    num: 5,
    reroll: 2,
    good: ['_yb*100'],
  }
  const holiday = rollDailyTasks(holidaySave, thursdayMs, TZ, rng(), {
    date: '2026-12-03',
    lunar: '测试月',
    term: null,
    holiday: { name: '测试节', off: true },
  })
  assert.equal(holiday.length, 6)
  assert.equal(holiday[4].festivalId, ACTIVITY_ID)
  assert.deepEqual(holiday[5], holidayTask)
})

test('TaskProgress.festivalClaims 可读写，且 resetDailyTasks 必须保留领奖账本', () => {
  const save = freshSave()
  const claims = { [ACTIVITY_ID]: { '2026-12-03': true } }
  writeTaskProgress(save, { ...defaultTaskProgress(), festivalClaims: claims })
  assert.deepEqual(readTaskProgress(save).festivalClaims, claims)

  const reset = resetDailyTasks(save, dailyBoundaryMs('2026-12-03', TZ), TZ, rng())
  assert.equal(reset.daily.length, 5)
  assert.deepEqual(readTaskProgress(save).festivalClaims, claims)
})

test('task.claim：首次成功写入 festivalClaims，重掷同一 issueWeek 后第二次 already_claimed', () => {
  const state = gameState({ atMs: dailyBoundaryMs('2026-12-03', TZ) })
  const firstRng = rng()
  rollDailyTasks(state.save, state.gameTimeMs, TZ, firstRng)

  let progress = readTaskProgress(state.save)
  assert.equal(progress.daily.length, 5)
  const festival = progress.daily[4]
  assert.equal(festival.festivalId, ACTIVITY_ID)
  assert.equal(festival.festivalIssueWeek, '2026-12-03')
  progress.doNums[festival.obj] = festival.num
  writeTaskProgress(state.save, progress)

  const first = executeCommand(state, { type: 'task.claim', payload: { tab: 'daily', index: 4 } }, context(state))
  assert.equal(first.ok, true, JSON.stringify(first.ok ? first.result : first.error))
  const claimedYb = first.result.goods.find(good => good.id === 'yb')
  assert.ok(claimedYb, 'task.claim 结果必须包含元宝奖励')
  assert.equal(claimedYb.num, 100)
  assert.equal(inventoryCount(first.state.save, 'nums', 'yb'), 100)

  progress = readTaskProgress(first.state.save)
  assert.equal(progress.taskList.daily[4].take, true)
  assert.equal(progress.festivalClaims?.[ACTIVITY_ID]?.['2026-12-03'], true)

  // 模拟时区回拨 / 同一 issueWeek 的 daily 表重掷：entry.take 被重置，但账本必须保留。
  resetDailyTasks(first.state.save, first.state.gameTimeMs, TZ, rng())
  progress = readTaskProgress(first.state.save)
  assert.deepEqual(progress.festivalClaims, { [ACTIVITY_ID]: { '2026-12-03': true } })
  assert.equal(progress.taskList.daily[4].take, false)
  const rerolled = progress.daily[4]
  assert.equal(rerolled.festivalId, ACTIVITY_ID)
  progress.doNums[rerolled.obj] = rerolled.num
  writeTaskProgress(first.state.save, progress)

  const second = executeCommand(first.state, { type: 'task.claim', payload: { tab: 'daily', index: 4 } }, context(first.state))
  assert.equal(second.ok, false, '同一 issueWeek 第二次领取必须被拒绝')
  assert.equal(second.error.code, 'already_claimed')
})

test('festivalMailGoods：登录礼 easy 30 / standard 12 元宝 + 2 食物；餐盒 3 食物 + 1 玩具', () => {
  const easySave = freshSave('easy')
  const easyLogin = normalizeGoods(festivalMailGoods(easySave, CRAZY_THURSDAY.loginMail, rng()))
  assert.equal(countType(easyLogin, 'food'), 2)
  assert.equal(countType(easyLogin, 'toy'), 0)
  assert.equal(ybOf(easyLogin).num, 30)
  for (const good of easyLogin.filter(good => good.type !== 'nums')) assert.equal(good.num, 1)

  const standardSave = freshSave('standard')
  const standardLogin = normalizeGoods(festivalMailGoods(standardSave, CRAZY_THURSDAY.loginMail, rng()))
  assert.equal(countType(standardLogin, 'food'), 2)
  assert.equal(countType(standardLogin, 'toy'), 0)
  assert.equal(ybOf(standardLogin).num, 12)

  const easyBox = normalizeGoods(festivalMailGoods(easySave, CRAZY_THURSDAY.taskReward, rng()))
  assert.equal(countType(easyBox, 'food'), 3)
  assert.equal(countType(easyBox, 'toy'), 1)
  assert.equal(ybOf(easyBox).num, 100)

  const standardBox = normalizeGoods(festivalMailGoods(standardSave, CRAZY_THURSDAY.taskReward, rng()))
  assert.equal(countType(standardBox, 'food'), 3)
  assert.equal(countType(standardBox, 'toy'), 1)
  assert.equal(ybOf(standardBox).num, 40)

  for (const good of [...easyLogin, ...easyBox, ...standardBox].filter(good => good.type !== 'nums')) {
    assert.notEqual(good.price, -1, good.id + ' 不得是 price=-1 的非卖品')
    assert.notEqual(good.outOfPrint, true, good.id + ' 不得是绝版物品')
    assert.notEqual(good.PD, true, good.id + ' 不得是付费限定物品')
  }
})

test('festivalMailForDayKey：preview/active 返回邮件定义', () => {
  assert.ok(festivalMailForDayKey('2026-12-02'))
  assert.ok(festivalMailForDayKey('2026-12-03'))
})

test('邮件边界：周三 06:00 preview 无附件；周四 06:00 active 有 2 食物 + easy 30 / standard 12 元宝', () => {
  // 2026-12-02 05:59 -> 06:00：preview 邮件。
  const previewState = gameState({ atMs: dailyBoundaryMs('2026-12-02', TZ) - 60_000 })
  const afterPreview = tick(previewState)
  const previewMail = mailByKey(afterPreview, 'crazy-thursday-preview-2026-12-02')
  assert.ok(previewMail, '缺少 crazy-thursday-preview-2026-12-02')
  assert.deepEqual(previewMail.glb, [], '预告邮件不得带附件')
  assert.deepEqual(festivalMailKeys(afterPreview), ['crazy-thursday-preview-2026-12-02'])
  assert.equal(readTaskProgress(afterPreview.save).daily.length, 4, 'preview 日不得生成特供任务')

  // 2026-12-03 05:59 -> 06:00：active 邮件（easy）。
  const activeState = gameState({ atMs: dailyBoundaryMs('2026-12-03', TZ) - 60_000 })
  const afterActive = tick(activeState)
  const activeMail = mailByKey(afterActive, 'crazy-thursday-2026-12-03')
  assert.ok(activeMail, '缺少 crazy-thursday-2026-12-03')
  assert.deepEqual(festivalMailKeys(afterActive), ['crazy-thursday-2026-12-03'])
  const activeGoods = activeMail.glb
  assert.equal(activeGoods.filter(good => good.type === 'food').length, 2)
  assert.equal(activeGoods.filter(good => good.type === 'toy').length, 0)
  assert.equal(ybOf(activeGoods).num, 30)
  for (const good of activeGoods.filter(good => good.type === 'food')) assert.equal(good.num, 1)
  const activeProgress = readTaskProgress(afterActive.save)
  assert.equal(activeProgress.daily.length, 5)
  assert.equal(activeProgress.daily[4].festivalId, ACTIVITY_ID)

  // standard 难度：同一封登录礼邮件只发 12 元宝，物品数量不变。
  const standardState = gameState({ atMs: dailyBoundaryMs('2026-12-03', TZ) - 60_000, difficulty: 'standard' })
  const afterStandard = tick(standardState)
  const standardMail = mailByKey(afterStandard, 'crazy-thursday-2026-12-03')
  assert.ok(standardMail)
  const standardGoods = standardMail.glb
  assert.equal(standardGoods.filter(good => good.type === 'food').length, 2)
  assert.equal(ybOf(standardGoods).num, 12)
})

test('旧日期/普通日不回归：首跑前周四与活动后周五都不产生 festival 任务或邮件', () => {
  // 2026-11-26（首跑前周四）默认不生效。
  const beforeLaunch = tick(gameState({ atMs: dailyBoundaryMs('2026-11-26', TZ) - 60_000 }))
  assert.deepEqual(festivalMailKeys(beforeLaunch), [])
  const beforeLaunchTasks = readTaskProgress(beforeLaunch.save)
  assert.equal(beforeLaunchTasks.daily.length, 4)
  assert.equal(beforeLaunchTasks.daily.some(task => task.festivalId !== undefined), false)

  // 2026-12-04（周五 / linger）不生成新任务与新邮件。
  const friday = tick(gameState({ atMs: dailyBoundaryMs('2026-12-04', TZ) - 60_000 }))
  assert.deepEqual(festivalMailKeys(friday), [])
  const fridayTasks = readTaskProgress(friday.save)
  assert.equal(fridayTasks.daily.length, 4)
  assert.equal(fridayTasks.daily.some(task => task.festivalId !== undefined), false)
})
