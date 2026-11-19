// 动态复现台 v2（repro-matrix）：命令面全覆盖 + 存档形状变体。
// 用法：
//   node --experimental-strip-types audit/similar-errors/findings/repro-matrix/harness-matrix.mjs --list
//   node --experimental-strip-types .../harness-matrix.mjs --state imported --json
//   node --experimental-strip-types .../harness-matrix.mjs --state variant:task-counters-only --json
//   node --experimental-strip-types .../harness-matrix.mjs --diff imported  variant:task-counters-only
//   node --experimental-strip-types .../harness-matrix.mjs --matrix            # 全部 state × 全部 chain 的 JSON
//   node --experimental-strip-types .../harness-matrix.mjs --coverage          # 命令覆盖自检
//
// 与 audit/similar-errors/harness.mjs 的关系：本文件是它的超集副本（不改动原文件）。
// 所有 state 共用同一 boost（资源/等级/学习进度），只让“存档形状”成为变量。
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && /\.[cm]?[jt]s$/.test(specifier) === false && specifier.endsWith('.json') === false) {
      try {
        return nextResolve(specifier + '.ts', context)
      } catch {
        // 落到原始 specifier（目录/index 或真正的无扩展名文件）
      }
    }
    return nextResolve(specifier, context)
  },
})

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const imp = path => import(join(ROOT, path))

const { createHeadlessRuntime, createRngState, levelAndCapsOf } = await imp('src/shared/pet-runtime/index.ts')
const { emptyEggSave } = await imp('src/shared/pet-runtime/handlers-a.ts')
const { dayKeyAt, nextDailyBoundaryMs } = await imp('src/shared/pet-runtime/time.ts')
const { currentBoundarySeconds } = await imp('src/shared/pet-runtime/runtime-helpers.ts')
const {
  TRAVEL_PROVINCES, STATIC_TASKS, STUDY_GOODS, EXAM_BANK, FARM_SEEDS, FRIES,
} = await imp('src/shared/pet-runtime/content/index.ts')
const { createSyncFixtures, SEED } = await imp('scripts/tests/sync-fixtures.mjs')
const { isSharedSaveData, assertSharedSaveData } = await imp('src/shared/sync/data-boundary.ts')

const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'audit/similar-errors/fixtures/imported-shared.json'), 'utf8'))
const GAME_TIME_MS = Date.UTC(2026, 10, 18, 12, 1, 0) // 2026-11-18 20:01 +08
const TIME_ZONE = 'Asia/Shanghai'
const ADVANCE_MINUTES = 601 // 跨过 2026-11-19 06:00 的每日边界
const DAY_KEY = dayKeyAt(GAME_TIME_MS, TIME_ZONE) // 2026-11-18
const BOUNDARY_SEC = currentBoundarySeconds(GAME_TIME_MS, TIME_ZONE)

const clone = value => JSON.parse(JSON.stringify(value))
const fixtures = createSyncFixtures()

function engineFrom(shared) {
  const state = clone(fixtures.engine)
  state.save = clone(shared)
  state.gameTimeMs = GAME_TIME_MS
  state.lastSchedulerWallMs = GAME_TIME_MS
  state.timeZone = TIME_ZONE
  state.weatherLocation = 'Shanghai'
  state.advanceWhileEmpty = true
  state.rng = createRngState(SEED)
  state.scheduledJobs = []
  state.nextScheduledJobId = 1
  state.gameSessions = []
  state.sessionCoverage = []
  delete state.coverageReopen
  state.lastProcessedDayBoundaryKey = DAY_KEY
  state.nextDailyBoundaryMs = nextDailyBoundaryMs(GAME_TIME_MS, TIME_ZONE)
  state.importClamped = false
  state.clockSkippedMs = 0
  state.environment = { calendarByDay: {}, weatherByDay: {} }
  return state
}

/** 只放大“数量型”资源，不改动任何 blob/字段的存在性。 */
function boost(save) {
  Object.assign(save.petInfo, {
    growth: 5000, yb: 50000, diamond: 100, health: 5, hunger: 1100, clean: 1100, mood: 1000,
    intel: 200, charm: 200, strong: 200,
  })
  save.petComputedlInfo = { ...levelAndCapsOf(5000), healthMax: 5, moodMax: 1000 }
  save.studyInfo = { chinese: 30, mathematics: 30, politics: 30, music: 30, art: 30, manner: 30, pe: 30, labouring: 30, wushu: 30 }
  for (const [type, code] of Object.entries({
    food: '_102010001*20', clean: '_10021005*20', toy: '_t0002*5', medicine: '_60001*5', nums: '_growth*100',
  })) {
    const list = save.selfGoodDatas[type]
    if (Array.isArray(list) && list.length === 0) list.push(code)
  }
  save.gameSaveDatas.travel_china = TRAVEL_PROVINCES.map(province => ({ name: province.name, value: 1 }))
}

function context(state, overrides = {}) {
  return {
    gameTimeMs: state.gameTimeMs,
    environment: state.environment,
    activeClientCount: 1,
    sessionActive: true,
    actorDeviceId: 'audit-device',
    actorRole: 'owner',
    ...overrides,
  }
}

// ---- 命令链 DSL ---------------------------------------------------------

const cmd = (type, payload = {}) => ({ k: 'cmd', type, payload })
const adv = minutes => ({ k: 'advance', minutes })
const at = (type, payload, out) => ({ k: 'cmd', type, payload, out })
const list = (...items) => items

const good = (id, type, num = 1, name = '物品') => ({ id, name, type, url: '', num })

// 静态任务计数器（模拟玩家真的做过这些动作；不是构造不可能状态）。
const RICH_DONUMS = { Amusing: 25, Study: 3, Work: 3, Travel1: 5, Eat: 1, Clean: 2, Toy: 3, GameRound: 2 }

function taskBlob(overrides = {}) {
  return JSON.stringify({
    doNums: { ...RICH_DONUMS },
    taskList: { daily: [], ddw: [], growth: [], travel: [] },
    daily: [],
    dailyDay: 0,
    ...overrides,
  })
}

const DAILY_DEF = { label: '喂我吃东西1次', msg: '肚子咕咕叫啦', obj: 'Eat', num: 1 }
const DAILY_ENTRY = { take: false, good: [good('yb', 'nums', 10, '元宝')] }

const mailLive = (d, glb, extra = {}) => ({ d, l: '欢迎', m: '欢迎回家', glb, ...extra })
const mailDeleted = d => ({ d, e: true })

function islandBlob(overrides = {}) {
  return JSON.stringify({
    day: BOUNDARY_SEC, sent: 0, letter: '', lit: [], lamps: [], tier: 0, pieces: 0, piece: false,
    want: '', loved: false, errands: [], fought: [], wins: 0, newsFacts: [], newsDay: 0,
    ...overrides,
  })
}

// ---- state（场景 + 形状变体）--------------------------------------------

const STATES = []
function state(name, options) {
  STATES.push({ name, ...options })
}

function importedBase() {
  const engine = engineFrom(FIXTURE)
  boost(engine.save)
  return engine
}

state('imported', {
  note: '用户真实导入存档（fixture，blob 为空）',
  build: importedBase,
})
state('imported-reset', {
  note: '同一存档跨过一次 06:00 每日边界（静态任务/邮件/岛屿已materialize）',
  build() {
    const engine = engineFrom(FIXTURE)
    const runtime = createHeadlessRuntime(engine)
    const advanced = runtime.advance(context(runtime.snapshot()), ADVANCE_MINUTES)
    if (advanced.ok === false) throw new Error('advance failed: ' + JSON.stringify(advanced.error))
    const after = runtime.snapshot()
    boost(after.save)
    return after
  },
})
state('fresh', {
  note: '新宠物 adopt 后（startSave/adopt 的默认初始化）',
  build() {
    const runtime = createHeadlessRuntime(engineFrom(emptyEggSave(clone(FIXTURE))))
    const adopted = runtime.execute({ type: 'pet.adopt', payload: { sex: 'MM' } }, context(runtime.snapshot()))
    if (adopted.ok === false) throw new Error('adopt failed: ' + JSON.stringify(adopted.error))
    const fresh = runtime.snapshot()
    boost(fresh.save)
    return fresh
  },
})

/** 形状变体：在 imported（已 boost）基础上只改一处。 */
const VARIANTS = {
  'task-counters-only': {
    note: 'task 只有 doNums，无 taskList/daily（做动作只累加计数器、从未跑过 06:00 重置）',
    apply(save) { save.saveJsonData.task = JSON.stringify({ doNums: { ...RICH_DONUMS } }) },
  },
  'task-counter-lists-empty': {
    note: 'task 有 doNums + 全空 taskList（addTaskCount 写出的真实 legacy 形状）',
    apply(save) { save.saveJsonData.task = taskBlob() },
  },
  'task-ddW-partial': {
    note: 'taskList.ddw 只有 1 个 entry（其余 tab 空），doNums 已达标',
    apply(save) {
      save.saveJsonData.task = taskBlob({
        taskList: { daily: [], ddw: [{ take: false, good: [good('102010001', 'food', 1)] }], growth: [], travel: [] },
      })
    },
  },
  'task-daily-defs-no-entry': {
    note: 'daily 有任务定义但 taskList.daily 为空（两份表不同步）',
    apply(save) {
      save.saveJsonData.task = taskBlob({ daily: [DAILY_DEF], dailyDay: BOUNDARY_SEC, taskList: { daily: [], ddw: [], growth: [], travel: [] } })
    },
  },
  'task-daily-stale-pending': {
    note: 'daily 定义 + 条目都在、doNums 达标，但 dailyDay 是昨天（未跑重置的陈旧每日表）',
    apply(save) {
      save.saveJsonData.task = taskBlob({
        daily: [DAILY_DEF], dailyDay: BOUNDARY_SEC - 86400,
        taskList: { daily: [DAILY_ENTRY], ddw: [], growth: [], travel: [] },
      })
    },
  },
  'task-travel-keep-claimed': {
    note: 'travel keep 任务（index>=2）已领取（take:true），travel_china 已满',
    apply(save) {
      const travel = STATIC_TASKS.travel.map((template, index) => ({
        take: index >= 2, good: [good('100010490', 'background', 1)],
      }))
      save.saveJsonData.task = taskBlob({ taskList: { daily: [], ddw: [], growth: [], travel } })
    },
  },
  'signin-minimal': {
    note: 'signin 只有 {}（无 getGrowth/collectionList）',
    apply(save) { save.saveJsonData.signin = '{}' },
  },
  'email-mixed': {
    note: 'email 混合：1 未领取 / 1 已领取 / 1 已删除占位',
    apply(save) {
      save.saveJsonData.email = JSON.stringify({
        1: mailLive(1, [good('yb', 'nums', 100, '元宝')]),
        2: mailLive(2, [good('102010001', 'food', 1)], { r: true }),
        3: mailDeleted(3),
      })
    },
  },
  'email-claimed-only': {
    note: 'email 只有已领取邮件（领奖全部不可用）',
    apply(save) { save.saveJsonData.email = JSON.stringify({ 1: mailLive(1, [good('yb', 'nums', 100)], { r: true }) }) },
  },
  'island-partial': {
    note: 'island 是部分字段（day 已 pin 到当前边界，其余留默认）',
    apply(save) { save.saveJsonData.island = islandBlob() },
  },
  'island-errands': {
    note: 'island 带一组真实可达的当日委托（talk/visit/chat/tour/bring/gift/quiz/fight）',
    apply(save) {
      save.saveJsonData.island = islandBlob({
        want: '102010001',
        errands: [
          { from: '翠花', kind: 'talk', to: '周大饼', got: 0, took: false },
          { from: '周大饼', kind: 'visit', to: '5', got: 0, took: false },
          { from: '杰里', kind: 'chat', to: '3', got: 0, took: false },
          { from: '洛克大使', kind: 'tour', to: '3', got: 0, took: false },
          { from: '莉莉', kind: 'bring', to: '102010001', got: 0, took: false },
          { from: '木木', kind: 'gift', to: 'food', got: 0, took: false },
          { from: '珍尼花', kind: 'quiz', to: 'xx-chinese', got: 0, took: false },
          { from: '监狱长', kind: 'fight', to: '1', got: 0, took: false },
        ],
      })
    },
  },
  'farm-half': {
    note: 'farm 是半结构（只有 2 块地，无 burden/warehouse）',
    apply(save) {
      save.saveJsonData.farm = JSON.stringify({
        farmland: [{ farmland: 'FarmlandS', grass: 1 }, { farmland: 'FarmlandS' }],
        experience: '1', rank: '01',
      })
    },
  },
  'fishs-PD-only': {
    note: 'fishs 只有 PD 段（无 fishs 数组）',
    apply(save) { save.saveJsonData.fishs = JSON.stringify({ PD: { allvipcnt: 4, canusecnt: 4 } }) },
  },
  'blobs-missing': {
    note: 'saveJsonData 缺少 farm/island/activity/album 键（旧版本本地存档的真实形状）',
    apply(save) {
      for (const key of ['farm', 'island', 'activity', 'album']) delete save.saveJsonData[key]
    },
  },
  'study-partial': {
    note: 'studyInfo 只有 chinese 一个键',
    apply(save) { save.studyInfo = { chinese: 30 } },
  },
  'goods-missing-group': {
    note: 'selfGoodDatas 缺 medicine 分组',
    apply(save) { delete save.selfGoodDatas.medicine },
  },
  'gamesave-partial': {
    note: 'gameSaveDatas 缺 travel_china 键',
    apply(save) { delete save.gameSaveDatas.travel_china },
  },
}

for (const [key, variant] of Object.entries(VARIANTS)) {
  state('variant:' + key, {
    note: variant.note,
    build() {
      const engine = importedBase()
      variant.apply(engine.save)
      return engine
    },
  })
}

// ---- 命令链 -------------------------------------------------------------

const STUDY_BY_SUBJECT = new Map(STUDY_GOODS.map(study => [study.id, study]))
const ALL_SUBJECTS = Object.keys(EXAM_BANK)

const CHAINS = []
const chain = (name, steps, setup = null, note = '') => CHAINS.push({ name, steps, setup, note })

chain('pet.lifecycle', list(
  cmd('pet.rename', { name: '小企鹅', host: '主人' }),
  cmd('pet.pokeFace', { spotId: 'H' }),
  cmd('pet.cheer'),
  cmd('pet.setPaused', { paused: true }),
  cmd('pet.setPaused', { paused: false }),
))

chain('pet.bury', list(
  cmd('pet.bury'),
  cmd('pet.bury'),
), save => { save.petInfo.health = 0; save.activeOption.ill = '0-0' })

chain('pet.adopt', list(
  cmd('pet.adopt', { sex: 'MM' }),
  cmd('pet.adopt', { sex: 'GG' }),
), save => { save.havePet = false })

chain('pet.reset-cycle', list(
  cmd('pet.reset'),
  cmd('pet.adopt', { sex: 'GG' }),
  cmd('signin.sign'),
  cmd('signin.drawGrowth'),
  cmd('task.claim', { tab: 'ddw', index: 0 }),
  cmd('island.claimTreasure'),
  cmd('farm.buySeed', { seedId: 'RadishSeed', quantity: 1 }),
))

chain('inventory.buy-use', list(
  cmd('inventory.buy', { type: 'food', itemId: '102010001', quantity: 1 }),
  cmd('inventory.use', { type: 'food', itemId: '102010001' }),
  cmd('inventory.use', { type: 'clean', itemId: '10021005' }),
  cmd('inventory.use', { type: 'toy', itemId: 't0002' }),
  cmd('inventory.use', { type: 'food', itemId: '99999999' }),
), save => { save.petInfo.hunger = 500; save.petInfo.clean = 500 })

chain('medical.treat', list(
  cmd('medical.treat', { mode: 'doctor' }),
  cmd('medical.treat', { mode: 'doctor' }),
), save => { save.petInfo.health = 4; save.activeOption.ill = '1-' })

chain('medical.treat-owned', list(
  cmd('medical.treat', { mode: 'owned', itemId: '60001' }),
  cmd('medical.treat', { mode: 'owned', itemId: '60001' }),
), save => { save.petInfo.health = 4; save.activeOption.ill = '1-' })

chain('vip', list(
  cmd('vip.buyPinkDiamond', { days: 1 }),
  cmd('vip.clearPinkDiamond'),
  cmd('vip.buySweetheart', { days: 1 }),
  cmd('vip.setSweetheart', { enabled: true }),
))

chain('travel.collection', list(
  cmd('travel.completeCollection'),
  cmd('travel.completeCollection'),
))

chain('jobs', list(
  cmd('job.startWork', { jobId: 'bz' }),
  cmd('activity.stop'),
  cmd('job.startStudy', { courseId: 'xx-chinese' }),
  cmd('activity.stop'),
  cmd('job.startTravel'),
  cmd('activity.stop'),
  cmd('activity.stop'),
), save => { save.studyInfo.chinese = 0 })

chain('task.static.rich', list(
  cmd('task.claim', { tab: 'ddw', index: 0 }),
  cmd('task.claim', { tab: 'ddw', index: 1 }),
  cmd('task.claim', { tab: 'ddw', index: 2 }),
  cmd('task.claim', { tab: 'ddw', index: 3 }),
  cmd('task.claim', { tab: 'ddw', index: 4 }),
  cmd('task.claim', { tab: 'growth', index: 0 }),
  cmd('task.claim', { tab: 'growth', index: 1 }),
  cmd('task.claim', { tab: 'growth', index: 2 }),
  cmd('task.claim', { tab: 'growth', index: 3 }),
  cmd('task.claim', { tab: 'travel', index: 0 }),
  cmd('task.claim', { tab: 'travel', index: 1 }),
  cmd('task.claim', { tab: 'travel', index: 2 }),
  cmd('task.claim', { tab: 'travel', index: 3 }),
  cmd('task.claim', { tab: 'travel', index: 4 }),
  cmd('task.claim', { tab: 'travel', index: 5 }),
  cmd('task.claim', { tab: 'travel', index: 6 }),
  cmd('task.claim', { tab: 'travel', index: 7 }),
  cmd('task.claim', { tab: 'travel', index: 8 }),
), save => { save.saveJsonData.task = JSON.stringify({ doNums: { ...RICH_DONUMS } }) },
  '计数器达标但静态表尚未生成（legacy 导入形状）')

chain('task.static.raw', list(
  cmd('task.claim', { tab: 'ddw', index: 0 }),
  cmd('task.claim', { tab: 'ddw', index: 1 }),
  cmd('task.claim', { tab: 'growth', index: 0 }),
  cmd('task.claim', { tab: 'travel', index: 2 }),
  cmd('task.claim', { tab: 'daily', index: 0 }),
), null, '不预置 task blob：直接观察 state 自身的 task 形状')

chain('exam.raw', list(
  cmd('exam.start', { subject: 'xx-chinese' }),
  cmd('exam.start', { subject: 'xx-mathematics' }),
  cmd('exam.start', { subject: 'nope' }),
), null, '不预置 studyInfo：直接观察 state 自身的 studyInfo 形状')

chain('task.daily', list(
  cmd('task.claim', { tab: 'daily', index: 0 }),
  cmd('task.claim', { tab: 'daily', index: 0 }),
  cmd('task.claim', { tab: 'daily', index: 1 }),
), save => {
  save.saveJsonData.task = taskBlob({ daily: [DAILY_DEF], dailyDay: BOUNDARY_SEC, taskList: { daily: [DAILY_ENTRY], ddw: [], growth: [], travel: [] } })
})

chain('exam.submit-all-subjects', ALL_SUBJECTS.flatMap(subject => {
  const study = STUDY_BY_SUBJECT.get(subject)
  return [
    at('exam.start', { subject }, 'exam'),
    cmd('exam.submit', (state, vars) => {
      const session = state.gameSessions.find(item => item.sessionToken === (vars.exam?.token ?? '__missing__'))
      const questions = session?.payload?.questions ?? []
      return { sessionToken: (vars.exam?.token ?? '__missing__'), answers: questions.map(question => question.answerIndex) }
    }),
    cmd('exam.submit', { sessionToken: '__missing__', answers: [0, 0, 0] }),
  ]
}), save => {
  for (const study of STUDY_GOODS) {
    const subject = typeof study.value === 'string' ? study.value : undefined
    if (subject !== undefined) save.studyInfo[subject] = (study.classNumUp ?? 0) + (study.classNum ?? 0)
  }
})

chain('signin', list(
  cmd('signin.sign'),
  cmd('signin.sign'),
  cmd('signin.drawGrowth'),
  cmd('signin.claimOnlineGift'),
  cmd('signin.claimBirthdayGift'),
))

chain('mail', list(
  cmd('mail.claimAll'),
  cmd('mail.deleteAll', { scope: 'claimed' }),
  cmd('mail.claim', { mailId: '1' }),
  cmd('mail.delete', { mailId: '1' }),
  cmd('mail.claim', { mailId: '1' }),
  cmd('mail.claim', { mailId: '99' }),
  cmd('mail.claimAll'),
), save => {
  save.saveJsonData.email = JSON.stringify({
    1: mailLive(1, [good('yb', 'nums', 100, '元宝')]),
    2: mailLive(2, [good('102010001', 'food', 1)], { r: true }),
    3: mailDeleted(3),
  })
})

chain('game.session', list(
  at('game.startSession', { gameId: 'game-1', kind: 'small' }, 'game'),
  cmd('game.reward', (state, vars) => ({ sessionToken: (vars.game?.token ?? '__missing__') })),
  cmd('game.reward', (state, vars) => ({ sessionToken: (vars.game?.token ?? '__missing__') })),
  at('game.startSession', { gameId: 'game-2', kind: 'flash' }, 'game2'),
  cmd('game.abandonSession', (state, vars) => ({ sessionToken: (vars.game2?.token ?? '__missing__') })),
  cmd('game.abandonSession', (state, vars) => ({ sessionToken: (vars.game2?.token ?? '__missing__') })),
))

chain('game.expiry', list(
  at('game.startSession', { gameId: 'game-1', kind: 'small' }, 'game'),
  adv(61),
  cmd('game.reward', (state, vars) => ({ sessionToken: (vars.game?.token ?? '__missing__') })),
))

chain('game.bad-token', list(
  cmd('game.reward', { sessionToken: 'not-a-token' }),
  cmd('game.abandonSession', { sessionToken: 'not-a-token' }),
  cmd('game.reward', { sessionToken: '' }),
))

chain('game.kind-mismatch', list(
  at('diudiule.startSession', {}, 'd'),
  cmd('game.reward', (state, vars) => ({ sessionToken: (vars.d?.token ?? '__missing__') })),
  cmd('diudiule.reward', { sessionToken: '__nope__' }),
))

chain('diudiule', list(
  at('diudiule.startSession', {}, 'd'),
  cmd('diudiule.reward', (state, vars) => ({ sessionToken: (vars.d?.token ?? '__missing__') })),
  at('diudiule.startSession', {}, 'd2'),
  cmd('diudiule.reward', (state, vars) => ({ sessionToken: (vars.d2?.token ?? '__missing__') })),
))

chain('diudiule.ill', list(
  at('diudiule.startSession', {}, 'd'),
  cmd('diudiule.reward', (state, vars) => ({ sessionToken: (vars.d?.token ?? '__missing__') })),
), save => { save.petInfo.health = 4 })

chain('social.visit', list(cmd('social.completeLanVisit', { peerId: 'peer-1', direction: 'incoming' })))

chain('island.core', list(
  cmd('island.arriveScene', { sceneId: '3' }),
  cmd('island.talkNpc', { npcId: '莉莉' }),
  cmd('island.visitSpot', { spotId: 'jycat' }),
  cmd('island.chat', { npcId: '莉莉' }),
  cmd('island.playGame', { gameKey: 'QQ跆拳道' }),
  cmd('island.giftNpc', { npcId: '小艾', itemId: '102010001' }),
  cmd('island.giftNpc', { npcId: '莉莉', itemId: '102010001' }),
))

chain('island.gift', list(
  cmd('island.giftNpc', { npcId: '小艾', itemId: '102010001' }),
  cmd('island.giftNpc', { npcId: '小艾', itemId: '102010001' }),
), save => {
  save.saveJsonData.island = islandBlob({ want: '102010001' })
})

chain('island.letters', list(
  cmd('island.acceptLetter', { fromNpcId: '小艾', toNpcId: '亮亮' }),
  cmd('island.acceptLetter', { fromNpcId: '小艾', toNpcId: '杰里' }),
  cmd('island.deliverLetter', { toNpcId: '杰里' }),
  cmd('island.deliverLetter', { toNpcId: '亮亮' }),
  cmd('island.acceptLetter', { fromNpcId: '摩西', toNpcId: '亮亮' }),
  cmd('island.deliverLetter', { toNpcId: '亮亮' }),
), save => { save.saveJsonData.island = islandBlob() })

chain('island.errands', list(
  cmd('island.arriveScene', { sceneId: '5' }),
  cmd('island.turnInErrand', { npcId: '周大饼', errandId: 'visit' }),
  cmd('island.turnInErrand', { npcId: '周大饼', errandId: 'visit' }),
  cmd('island.talkNpc', { npcId: '周大饼' }),
  cmd('island.turnInErrand', { npcId: '翠花', errandId: 'talk' }),
  cmd('island.chat', { npcId: '莉莉' }),
  cmd('island.chat', { npcId: '莉莉' }),
  cmd('island.chat', { npcId: '莉莉' }),
  cmd('island.turnInErrand', { npcId: '杰里', errandId: 'chat' }),
  cmd('island.arriveScene', { sceneId: '3' }),
  cmd('island.turnInErrand', { npcId: '洛克大使', errandId: 'tour' }),
  cmd('island.turnInErrand', { npcId: '莉莉', errandId: 'bring' }),
  cmd('island.turnInErrand', { npcId: '木木', errandId: 'gift' }),
  cmd('island.turnInErrand', { npcId: '不存在', errandId: 'talk' }),
), save => {
  save.saveJsonData.island = islandBlob({
    want: '102010001',
    errands: [
      { from: '翠花', kind: 'talk', to: '周大饼', got: 0, took: false },
      { from: '周大饼', kind: 'visit', to: '5', got: 0, took: false },
      { from: '杰里', kind: 'chat', to: '3', got: 0, took: false },
      { from: '洛克大使', kind: 'tour', to: '3', got: 0, took: false },
      { from: '莉莉', kind: 'bring', to: '102010001', got: 0, took: false },
      { from: '木木', kind: 'gift', to: 'food', got: 0, took: false },
      { from: '珍尼花', kind: 'quiz', to: 'xx-chinese', got: 0, took: false },
      { from: '监狱长', kind: 'fight', to: '1', got: 0, took: false },
    ],
  })
})

chain('island.quiz', list(
  at('island.startQuiz', { npcId: '珍尼花', errandId: 'quiz' }, 'quiz'),
  cmd('island.answerQuiz', (state, vars) => {
    const session = state.gameSessions.find(item => item.sessionToken === (vars.quiz?.token ?? '__missing__'))
    return { sessionToken: (vars.quiz?.token ?? '__missing__'), optionIndex: session?.payload?.answerIndex ?? 0 }
  }),
  cmd('island.startQuiz', { npcId: '珍尼花', errandId: 'quiz' }),
  cmd('island.startQuiz', { npcId: '莉莉', errandId: 'quiz' }),
), save => {
  save.saveJsonData.island = islandBlob({
    errands: [{ from: '珍尼花', kind: 'quiz', to: 'xx-chinese', got: 0, took: false }],
  })
})

chain('island.quiz-natural', list(
  cmd('island.arriveScene', { sceneId: '3' }),
), null, '自然 roll 的当日委托（不 pin errand 列表）')

chain('island.fight', list(
  cmd('island.fightMonster', { monsterId: '1', tactic: '硬拼' }),
  cmd('island.fightMonster', { monsterId: '1', tactic: '硬拼' }),
  cmd('island.fightMonster', { monsterId: '999', tactic: '硬拼' }),
  cmd('island.fightMonster', { monsterId: '2', tactic: '乱打' }),
), save => { save.saveJsonData.island = islandBlob() })

chain('island.rewards', list(
  cmd('island.claimGrowthReward'),
  cmd('island.claimGrowthReward'),
  cmd('island.claimTreasure'),
  cmd('island.claimTreasure'),
  cmd('island.refreshNews', { dayKey: DAY_KEY }),
  cmd('island.refreshNews', { dayKey: '2026-11-17' }),
))

chain('fishing.harvest', list(
  at('fishing.buy', { fryId: 2, quantity: 1 }, 'buy'),
  cmd('fishing.feed', (state, vars) => ({ fishId: (vars.buy?.result?.fishIds ?? [])[0] })),
  adv(241),
  cmd('fishing.harvest', (state, vars) => ({ fishId: (vars.buy?.result?.fishIds ?? [])[0] })),
  cmd('fishing.harvestAll'),
  cmd('fishing.speedUp'),
))

chain('fishing.harvestAll', list(
  at('fishing.buy', { fryId: 2, quantity: 2 }, 'buy'),
  adv(241),
  cmd('fishing.harvestAll'),
), null, '成熟鱼批量收获')

chain('fishing.speedUp-vip', list(
  at('fishing.buy', { fryId: 2, quantity: 1 }, 'buy'),
  cmd('fishing.speedUp'),
  cmd('fishing.speedUp'),
), save => { save.saveJsonData.fishs = JSON.stringify({ PD: { allvipcnt: 4, canusecnt: 2 } }) })

chain('farm.full', list(
  cmd('farm.buySeed', { seedId: 'RadishSeed', quantity: 2 }),
  cmd('farm.buyFertilizer', { fertilizerId: 'Fertilizer', quantity: 1 }),
  cmd('farm.reclaim', { plotIds: [6, 7] }),
  cmd('farm.plant', { seedId: 'RadishSeed', plotIds: [1] }),
  cmd('farm.care', { plotIds: [1], action: 'fertilize' }),
  cmd('farm.care', { plotIds: [0], action: 'weed' }),
  cmd('farm.care', { plotIds: [0], action: 'water' }),
  cmd('farm.plant', { seedId: 'RadishSeed', plotIds: [7] }),
  adv(841),
  cmd('farm.harvest', { plotIds: [1] }),
  cmd('farm.harvest', { plotIds: [1] }),
  cmd('farm.clear', { plotIds: [1] }),
  cmd('farm.sellProduce', { itemId: 'Radish', quantity: 1 }),
  cmd('farm.sellProduce', { itemId: 'Radish', quantity: 9999 }),
), save => {
  save.saveJsonData.farm = JSON.stringify({
    house: 'house', kennel: 'kennel', fence: 'fence', experience: '1', rank: '01',
    burden: [], warehouse: [], weather: 'Sunny', checked: Math.floor(GAME_TIME_MS / 1000),
    farmland: [
      { farmland: 'FarmlandS', grass: 1 },
      { farmland: 'FarmlandS' },
      { farmland: 'FarmlandS' }, { farmland: 'FarmlandS' }, { farmland: 'FarmlandS' }, { farmland: 'FarmlandS' },
      { farmland: 'Wasteland' }, { farmland: 'Wasteland' },
      { farmland: 'Wasteland' }, { farmland: 'Wasteland' }, { farmland: 'Wasteland' }, { farmland: 'Wasteland' },
    ],
  })
})

chain('farm.empty-blobs', list(
  cmd('farm.buySeed', { seedId: 'RadishSeed', quantity: 1 }),
  cmd('farm.plant', { seedId: 'RadishSeed', plotIds: [0] }),
  cmd('farm.plant', { seedId: 'RadishSeed', plotIds: [99] }),
  cmd('farm.harvest', { plotIds: [0] }),
  cmd('farm.clear', { plotIds: [0] }),
  cmd('farm.sellProduce', { itemId: 'Radish', quantity: 1 }),
), null, 'farm blob 为空（fixture 原样）')

chain('settings.server', list(
  cmd('settings.setShared', { key: 'difficulty', value: 'standard' }),
  cmd('settings.setShared', { key: 'undying', value: true }),
  cmd('server.setAdvanceWhileEmpty', { enabled: false }),
  cmd('server.setTimeZone', { timeZone: 'UTC' }),
  cmd('server.setWeatherCity', { city: 'Tokyo' }),
))

chain('admin', list(
  cmd('admin.grantCheat', { stat: 'growth', amount: 100 }),
  cmd('admin.grantCheat', { stat: 'yb', amount: 100 }),
  cmd('admin.grantCheat', { stat: 'growth', amount: -5 }),
  cmd('admin.grantRandomGoods', { type: 'food', quantity: 2 }),
  cmd('admin.grantRandomGoods', { type: 'nope', quantity: 2 }),
))

function sampleBundle(state) {
  const bundle = {
    format: 'qqpet-portable-v1',
    schemaVersion: 1,
    exportedAtWallMs: GAME_TIME_MS,
    authority: {
      owner: 'local',
      authorityId: 'audit-authority-0001',
      epoch: 1,
      restoreGeneration: 0,
      revision: 1,
      eventSeq: 0,
      handoffId: 'audit-handoff-0001',
      detachedAtWallMs: GAME_TIME_MS,
    },
    originLocalDeviceId: 'audit-local-device',
    shared: null,
    engine: state,
  }
  bundle.shared = clone(state.save)
  return bundle
}

chain('host-only', list(
  cmd('device.list'),
  cmd('device.revoke', { deviceId: 'dev-1' }),
  cmd('admin.exportForDetach'),
  // 下面两条需要合法 bundle；payload 用当前 state 组出来，只为验证 runtime 层是否处理
  { k: 'cmd', type: 'admin.importPortableBundle', payload: (state) => ({ bundle: sampleBundle(state) }) },
  { k: 'cmd', type: 'admin.resumeServer', payload: (state) => ({ expectedEpoch: 1, bundle: sampleBundle(state) }) },
), null, 'host-only：shared runtime 不含（server 层实现）')

// ---- 执行 ---------------------------------------------------------------

function recordError(error) {
  return { code: error.code, message: error.message }
}

function shortResult(result) {
  if (result === undefined) return undefined
  const text = JSON.stringify(result)
  return text.length > 240 ? text.slice(0, 240) + '…' : text
}

function runChain(baseState, spec) {
  const initial = clone(baseState)
  if (spec.setup !== null) spec.setup(initial.save)
  const runtime = createHeadlessRuntime(initial)
  const vars = {}
  const steps = []
  for (const step of spec.steps) {
    if (step.k === 'advance') {
      const snapshot = runtime.snapshot()
      const outcome = runtime.advance(context(snapshot), step.minutes)
      steps.push(outcome.ok
        ? { step: 'advance:' + step.minutes + 'm', ok: true }
        : { step: 'advance:' + step.minutes + 'm', ok: false, ...recordError(outcome.error) })
      if (outcome.ok === false) break
      continue
    }
    const snapshot = runtime.snapshot()
    const payload = typeof step.payload === 'function' ? step.payload(snapshot, vars) : (step.payload ?? {})
    const outcome = runtime.execute({ type: step.type, payload }, context(snapshot))
    const record = { step: step.type, ok: outcome.ok }
    if (step.out !== undefined) {
      vars[step.out] = { token: outcome.result?.sessionToken, result: outcome.result ?? {} }
    }
    if (outcome.ok) {
      record.result = shortResult(outcome.result)
    } else {
      Object.assign(record, recordError(outcome.error))
    }
    steps.push(record)
  }
  return steps
}

function buildState(spec) {
  const engine = spec.build()
  let importable = true
  let importError
  try {
    assertSharedSaveData(clone(engine.save))
  } catch (error) {
    importable = false
    importError = error instanceof Error ? error.message : String(error)
  }
  return { engine, importable, importError }
}

function runState(spec) {
  const built = buildState(spec)
  const results = {}
  for (const spec2 of CHAINS) results[spec2.name] = runChain(built.engine, spec2)
  return { importable: built.importable, importError: built.importError, results }
}

function diffRuns(a, b) {
  const lines = []
  for (const name of Object.keys(a)) {
    const left = a[name]
    const right = b[name]
    left.forEach((step, index) => {
      const other = right[index]
      if (other === undefined) {
        lines.push({ chain: name, step: step.step, left: step.ok ? 'ok' : `${step.code}: ${step.message}`, right: '(absent)' })
        return
      }
      const same = step.ok === other.ok && step.code === other.code && step.message === other.message
      if (same) return
      lines.push({
        chain: name,
        step: step.step,
        left: step.ok ? 'ok' : `${step.code}: ${step.message}`,
        right: other.ok ? 'ok' : `${other.code}: ${other.message}`,
      })
    })
  }
  return lines
}

const args = process.argv.slice(2)
const flag = name => args.includes('--' + name)
const option = name => {
  const index = args.indexOf('--' + name)
  return index < 0 ? undefined : args[index + 1]
}
const byName = name => {
  const found = STATES.find(item => item.name === name)
  if (found === undefined) throw new Error('unknown state: ' + name + '（--list 查看）')
  return found
}

if (flag('list')) {
  console.log(JSON.stringify({
    states: STATES.map(item => ({ name: item.name, note: item.note })),
    chains: CHAINS.map(item => ({ name: item.name, steps: item.steps.length, note: item.note })),
    commandCount: new Set(CHAINS.flatMap(item => item.steps.filter(step => step.k === 'cmd').map(step => step.type))).size,
  }, null, 1))
} else if (flag('coverage')) {
  const covered = new Set(CHAINS.flatMap(item => item.steps.filter(step => step.k === 'cmd').map(step => step.type)))
  const { COMMAND_TYPES } = await imp('src/shared/sync/command-validation.ts')
  const all = COMMAND_TYPES ?? []
  console.log(JSON.stringify({
    total: all.length,
    covered: all.filter(key => covered.has(key)),
    missing: all.filter(key => covered.has(key) === false),
    extra: [...covered].filter(key => all.includes(key) === false),
  }, null, 1))
} else if (flag('matrix')) {
  const out = {}
  for (const spec of STATES) out[spec.name] = runState(spec)
  console.log(JSON.stringify(out, null, 1))
} else if (flag('diff')) {
  const names = args.filter((arg, index) => arg.startsWith('--') === false && args[index - 1] !== '--diff' && !['matrix', 'coverage', 'json', 'list'].includes(arg))
  const leftName = option('diff')
  if (leftName === undefined) throw new Error('--diff 需要基准 state 名')
  const left = runState(byName(leftName))
  const out = { base: leftName, baseImportable: left.importable, diffs: {} }
  for (const name of new Set(names.filter(name => name !== leftName))) {
    const right = runState(byName(name))
    out.diffs[name] = diffRuns(left.results, right.results)
  }
  console.log(JSON.stringify(out, null, 1))
} else {
  const which = option('state') ?? 'imported'
  const spec = byName(which)
  console.log(JSON.stringify({ state: which, note: spec.note, ...runState(spec) }, null, 1))
}
