import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readRendererTaskTables } from './pet-task-source.mjs'
import { registerHooks } from 'node:module'
import test from 'node:test'

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
  C3_COMMAND_TYPES,
  createHeadlessRuntime,
  createRngState,
  executeCommand,
  advanceMinute,
  advanceMinutes,
  levelAndCapsOf,
  serializeRuntimeState,
  deserializeRuntimeState,
  fallbackWeatherForDay,
  applyTravelCompletion,
  travelEarlyRoll,
  travelInventoryTotal,
  sessionActivityForInterval,
  stableStringify,
  rebindSessionActor,
  rebindOrCancelImportedSessions,
  RUNTIME_SCHEMA_VERSION,
} = await import('../../src/shared/pet-runtime/index.ts')
const { validateEngineState } = await import('../../src/shared/sync/portable.ts')
const { COMMAND_TYPES } = await import('../../src/shared/sync/command-validation.ts')
const { goodOf, TRAVEL_PROVINCES, DAILY_TASK_TEMPLATES, STATIC_TASKS, EXAM_BANK, LOOT_POOLS, parseGoodCode, BIRTHDAY_FOOD_IDS } = await import('../../src/shared/pet-runtime/content/index.ts')
const {
  dailyTaskCandidates,
  dailyTaskIsOff,
  dailyTaskNeeded,
  dailyTaskPool,
  resetDailyTasks,
  rollDailyTasks,
} = await import('../../src/shared/pet-runtime/runtime-tasks.ts')
const { createRuntimeRng, currentBoundarySeconds, lootGoods, mailGoods } = await import('../../src/shared/pet-runtime/runtime-helpers.ts')
const { claimOnlineGift, claimBirthdayGift } = await import('../../src/shared/pet-runtime/handlers-d.ts')
const { startTravel } = await import('../../src/shared/pet-runtime/handlers-c.ts')
const { takeTravelPhoto } = await import('../../src/shared/pet-runtime/travel.ts')
const {
  DAY_KEY,
  GAME_TIME_MS,
  LOCAL_DEVICE_ID,
  NEXT_BOUNDARY_MS,
  SEED,
  WALL_TIME_MS,
  createSyncFixtures,
} = await import('./sync-fixtures.mjs')

const OTHER_DEVICE_ID = 'local-device-other'

function deterministicSeed(attempt) {
  return SEED.slice(0, 24) + attempt.toString(16).padStart(8, '0')
}
const fixtures = createSyncFixtures()

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function canonicalTask(good) {
  return {
    id: good.id, name: good.name, type: good.type, url: good.url, num: good.num,
    ...(good.price === undefined ? {} : { price: good.price }),
    ...(good.value === undefined ? {} : { value: good.value }),
    ...(good.object === undefined ? {} : { object: good.object }),
  }
}

function baseState() {
  const state = clone(fixtures.engine)
  state.save = clone(fixtures.shared)
  state.save.petInfo.growth = 5000
  state.save.petInfo.health = 5
  state.save.petInfo.hunger = 1000
  state.save.petInfo.clean = 1000
  state.save.petInfo.mood = 1000
  state.save.petInfo.yb = 5000
  state.save.petInfo.intel = 100
  state.save.petInfo.charm = 100
  state.save.petInfo.strong = 100
  state.save.petInfo.onLineTime = 0
  state.save.petInfo.onlineDataTime = 0
  state.save.petInfo.birthDay = Math.floor(GAME_TIME_MS / 1000)
  state.save.petInfo.pinkDiamond = false
  state.save.petInfo.PDgrowth = 0
  state.save.petInfo.PDgrowthValue = 0
  state.save.petInfo.PDgrowthValue_next = 0
  state.save.petInfo.PDiamondLevel = 0
  state.save.petInfo.PDiamondBeginDate = 0
  state.save.petInfo.PDiamondExpirationDate = 0
  state.save.petInfo.PDiamondYear = false
  state.save.petInfo.sweetHeart = false
  state.save.petInfo.sweetHeartOverTime = 0
  state.save.petComputedlInfo = { ...levelAndCapsOf(5000), healthMax: 5, moodMax: 1000 }
  state.save.studyInfo = { chinese: 0, mathematics: 0, politics: 0, music: 0, art: 0, manner: 0, pe: 0, labouring: 0, wushu: 0 }
  state.save.activeOption = { work: null, study: null, trip: null, ill: null, die: null }
  state.save.selfGoodDatas = {
    food: ['_102010001*5'], clean: ['_10021005*5'], medicine: ['_60001*1', '_50001*1', '_10003*1'],
    background: [], toy: ['_t0002*1'], nums: ['_growth*10'], service: [], work: [], study: [], trip: [],
  }
  state.save.selfGoodUseOption = { background: null, food: null, clean: null, toy: null }
  state.save.gameSaveDatas = { fishing_harvestfish: 0, travel_china: [], travel_china_num: 0, ddw: 0, yyds: 0 }
  state.save.illustrated = []
  state.save.settings = { paused: false, difficulty: 'easy', undying: false }
  state.save.saveJsonData = {
    email: '{}', task: '{}', signin: '{}', fishs: '{}', farm: '{}', activity: '0', album: '[]', island: '{}',
  }
  state.gameTimeMs = GAME_TIME_MS
  state.lastSchedulerWallMs = WALL_TIME_MS
  state.timeZone = 'Asia/Shanghai'
  state.weatherLocation = 'Shanghai'
  state.advanceWhileEmpty = true
  state.rng = createRngState(SEED)
  state.scheduledJobs = []
  state.nextScheduledJobId = 1
  state.gameSessions = []
  state.sessionCoverage = []
  delete state.coverageReopen
  state.lastProcessedDayBoundaryKey = DAY_KEY
  state.nextDailyBoundaryMs = NEXT_BOUNDARY_MS
  state.importClamped = false
  state.clockSkippedMs = 0
  state.environment = { calendarByDay: {}, weatherByDay: {} }
  assert.equal(validateEngineState(state), true)
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

function execute(state, type, payload = {}, overrides = {}) {
  return executeCommand(state, { type, payload }, context(state, overrides))
}

function ok(state, type, payload = {}, overrides = {}) {
  const outcome = execute(state, type, payload, overrides)
  assert.equal(outcome.ok, true, type + ': ' + JSON.stringify(outcome.ok ? outcome.result : outcome.error))
  return outcome
}

function rejected(state, type, payload = {}, overrides = {}, code = null) {
  const outcome = execute(state, type, payload, overrides)
  assert.equal(outcome.ok, false, type + ' should reject')
  if (code !== null) assert.equal(outcome.error.code, code, type)
  return outcome
}

function blob(state, key) {
  return JSON.parse(state.save.saveJsonData[key])
}

test('group A: lifecycle, reset/adopt, direct interaction and pause', () => {
  const original = baseState()
  original.save.settings.difficulty = 'standard'
  original.save.settings.undying = true
  original.sessionCoverage = [{
    coverageId: 'coverage-open', deviceId: LOCAL_DEVICE_ID, connectedAtWallMs: WALL_TIME_MS - 1000,
    lastHeartbeatWallMs: WALL_TIME_MS,
  }]
  original.scheduledJobs = [{ id: 1, type: 'other', dueAtGameMs: GAME_TIME_MS + 60000, payload: {}, status: 'pending' }]
  original.nextScheduledJobId = 2
  original.gameSessions = [clone(fixtures.gameSession)]

  rejected(original, 'pet.reset', {}, { actorRole: 'player' }, 'unauthorized')
  const reset = ok(original, 'pet.reset', {}, { actorRole: 'owner' })
  assert.equal(reset.state.save.havePet, false)
  assert.equal(reset.state.save.settings.difficulty, 'standard')
  assert.equal(reset.state.save.settings.undying, true)
  assert.deepEqual(reset.state.scheduledJobs, [])
  assert.deepEqual(reset.state.gameSessions, [])
  assert.deepEqual(reset.state.sessionCoverage, [])
  assert.equal(reset.state.rng.draws, 0)
  assert.equal(original.save.havePet, true)
  const advancedRng = baseState()
  advancedRng.rng = { ...advancedRng.rng, draws: 17 }
  assert.equal(validateEngineState(advancedRng), true)
  const rngReset = ok(advancedRng, 'pet.reset', {}, { actorRole: 'owner' })
  assert.equal(rngReset.state.rng.draws, 0)
  assert.equal(rngReset.state.rng.seedHex, SEED)
  assert.equal(rngReset.state.rng.stateHex, SEED)

  rejected(reset.state, 'pet.adopt', { sex: 'MM' }, { actorRole: 'player' }, 'unauthorized')
  const adopted = ok(reset.state, 'pet.adopt', { sex: 'MM' }, { actorRole: 'owner' })
  assert.equal(adopted.state.save.havePet, true)
  assert.equal(adopted.state.save.petInfo.sex, 'MM')
  assert.equal(adopted.state.save.petInfo.yb, 5000)
  assert.ok(adopted.state.save.selfGoodDatas.food.length > 0)
  rejected(adopted.state, 'pet.adopt', { sex: 'MM' }, { actorRole: 'owner' }, 'wrong_phase')

  const renamed = ok(adopted.state, 'pet.rename', { name: ' 小企鹅 ', host: '主人' })
  assert.equal(renamed.state.save.petInfo.name, '小企鹅')
  rejected(adopted.state, 'pet.rename', { name: '   ' }, {}, 'invalid_payload')

  rejected(adopted.state, 'pet.bury', {}, {}, 'wrong_phase')
  const dead = clone(adopted.state)
  dead.save.petInfo.health = 0
  const buried = ok(dead, 'pet.bury')
  assert.equal(buried.state.save.isBury, true)
  rejected(buried.state, 'pet.bury', {}, {}, 'already_claimed')

  const base = baseState()
  const pokedA = ok(base, 'pet.pokeFace', { spotId: 'H' })
  const pokedB = executeCommand(base, { type: 'pet.pokeFace', payload: { spotId: 'H' } }, context(base))
  assert.deepEqual(pokedA, pokedB)
  assert.equal(pokedA.state.save.gameSaveDatas.ddw, 1)
  assert.equal(blob(pokedA.state, 'task').doNums.Amusing, 1)
  const cheered = ok(base, 'pet.cheer')
  assert.ok(cheered.result.mood >= 5)

  const paused = ok(base, 'pet.setPaused', { paused: true })
  const pausedTick = advanceMinute(paused.state, context(paused.state))
  assert.equal(pausedTick.ok, true)
  assert.equal(pausedTick.state.gameTimeMs, paused.state.gameTimeMs + 60000)
  assert.equal(pausedTick.state.save.petInfo.mood, paused.state.save.petInfo.mood)
  assert.equal(pausedTick.state.save.petInfo.onLineTime, paused.state.save.petInfo.onLineTime)
})

test('group B: inventory, medicine, VIP economy and travel completion', () => {
  const base = baseState()
  const bought = ok(base, 'inventory.buy', { type: 'food', itemId: '102010001', quantity: 2 })
  assert.equal(bought.state.save.petInfo.yb, 4990)
  assert.equal(bought.state.save.selfGoodDatas.food.find(entry => entry.startsWith('_102010001*')), '_102010001*7')
  rejected(base, 'inventory.buy', { type: 'food', itemId: 'not-a-good', quantity: 1 }, {}, 'not_available')
  const poor = baseState()
  poor.save.petInfo.yb = 0
  rejected(poor, 'inventory.buy', { type: 'food', itemId: '102010001', quantity: 1 }, {}, 'insufficient_funds')

  const hungry = baseState()
  hungry.save.petInfo.hunger = 500
  const used = ok(hungry, 'inventory.use', { type: 'food', itemId: '102010001' })
  assert.equal(used.state.save.petInfo.hunger, 600)
  assert.equal(blob(used.state, 'task').doNums.Eat, 1)
  rejected(base, 'inventory.use', { type: 'food', itemId: '10013006' }, {}, 'insufficient_item')

  const ill = baseState()
  ill.save.petInfo.health = 4
  ill.save.activeOption.ill = '0-'
  const treated = ok(ill, 'medical.treat', { mode: 'doctor' })
  assert.equal(treated.state.save.petInfo.health, 5)
  assert.equal(treated.state.save.activeOption.ill, null)
  const wrong = baseState()
  wrong.save.petInfo.health = 4
  wrong.save.activeOption.ill = '0-'
  wrong.save.selfGoodDatas.medicine.push('_20001*1')
  const misused = ok(wrong, 'medical.treat', { mode: 'owned', itemId: '20001' })
  assert.equal(misused.state.save.petInfo.health, 3)

  const vip = ok(base, 'vip.buyPinkDiamond', { days: 1 })
  assert.equal(vip.state.save.petInfo.pinkDiamond, true)
  assert.equal(vip.state.save.petInfo.PDiamondLevel, 1)
  assert.equal(blob(vip.state, 'fishs').PD.canusecnt, 2)
  const cleared = ok(vip.state, 'vip.clearPinkDiamond')
  assert.equal(cleared.state.save.petInfo.pinkDiamond, false)
  const sweet = ok(base, 'vip.buySweetheart', { days: 1 })
  assert.equal(sweet.state.save.petInfo.sweetHeart, true)
  const off = ok(sweet.state, 'vip.setSweetheart', { enabled: false })
  assert.equal(off.state.save.petInfo.sweetHeart, false)
  const expired = baseState()
  rejected(expired, 'vip.setSweetheart', { enabled: true }, {}, 'not_available')

  const travelled = baseState()
  travelled.save.petInfo.yb = 20000
  travelled.save.gameSaveDatas.travel_china = TRAVEL_PROVINCES.map(province => ({ name: province.name, value: 1 }))
  const collection = ok(travelled, 'travel.completeCollection')
  assert.equal(collection.state.save.gameSaveDatas.travel_china_num, 1)
  assert.deepEqual(collection.state.save.gameSaveDatas.travel_china, [])
  assert.equal(collection.state.save.petInfo.yb, 11112)
  rejected(base, 'travel.completeCollection', {}, {}, 'not_available')
})

test('group C: work, study, travel, activity cancellation and task claims', () => {
  const base = baseState()
  const work = ok(base, 'job.startWork', { jobId: 'bz' })
  assert.equal(work.state.save.activeOption.work, 'bz')
  assert.equal(work.state.scheduledJobs.length, 1)
  assert.equal(work.state.scheduledJobs[0].type, 'work')
  assert.equal(work.state.scheduledJobs[0].dueAtGameMs, GAME_TIME_MS + 30 * 60000)
  rejected(work.state, 'job.startTravel', {}, {}, 'busy')

  const afterWork = advanceMinutes(work.state, context(work.state, { sessionActive: false, activeClientCount: 0 }), 30)
  assert.equal(afterWork.ok, true, JSON.stringify(afterWork.ok ? afterWork.result : afterWork.error))
  assert.equal(afterWork.state.save.activeOption.work, null)
  assert.equal(afterWork.state.save.petInfo.yb, 5010)
  assert.equal(afterWork.state.scheduledJobs[0].status, 'completed')
  assert.equal(blob(afterWork.state, 'task').doNums.Work, 1)

  const study = ok(base, 'job.startStudy', { courseId: 'xx-chinese' })
  assert.equal(study.state.save.activeOption.study, 'xx-chinese')
  assert.equal(study.state.scheduledJobs[0].type, 'study')
  assert.ok(study.state.scheduledJobs[0].dueAtGameMs > GAME_TIME_MS)
  assert.ok(study.state.scheduledJobs[0].dueAtGameMs <= GAME_TIME_MS + 45 * 60000)

  const travel = ok(base, 'job.startTravel')
  assert.equal(travel.state.save.activeOption.trip, travel.result.destination)
  const stopped = ok(travel.state, 'activity.stop')
  assert.equal(stopped.state.save.activeOption.trip, null)
  assert.equal(stopped.state.scheduledJobs[0].status, 'cancelled')
  rejected(base, 'activity.stop', {}, {}, 'not_available')

  const taskState = baseState()
  const reward = goodOf('nums', 'yb', 10)
  taskState.save.saveJsonData.task = JSON.stringify({
    doNums: { Eat: 1 },
    taskList: { daily: [{ take: false, good: [reward] }], ddw: [], growth: [], travel: [] },
    daily: [{ label: 'Eat task', msg: 'eat', obj: 'Eat', num: 1 }],
    dailyDay: currentBoundarySeconds(GAME_TIME_MS, 'Asia/Shanghai'),
  })
  const claimed = ok(taskState, 'task.claim', { tab: 'daily', index: 0 })
  assert.equal(claimed.state.save.petInfo.yb, 5000)
  assert.equal(claimed.state.save.selfGoodDatas.nums.find(entry => entry.startsWith('_yb*')), '_yb*10')
  assert.equal(blob(claimed.state, 'task').taskList.daily[0].take, true)
  rejected(claimed.state, 'task.claim', { tab: 'daily', index: 0 }, {}, 'already_claimed')
  const incomplete = baseState()
  incomplete.save.saveJsonData.task = JSON.stringify({
    doNums: { Eat: 0 },
    taskList: { daily: [{ take: false, good: [reward] }], ddw: [], growth: [], travel: [] },
    daily: [{ label: 'Eat task', msg: 'eat', obj: 'Eat', num: 1 }],
    dailyDay: currentBoundarySeconds(GAME_TIME_MS, 'Asia/Shanghai'),
  })
  rejected(incomplete, 'task.claim', { tab: 'daily', index: 0 }, {}, 'not_available')
})

test('group C: static task tab rewards are claimable before the first daily reset', () => {
  const fresh = baseState()
  assert.deepEqual(blob(fresh, 'task'), {})
  let poked = fresh
  for (let index = 0; index < 5; index++) poked = ok(poked, 'pet.pokeFace', { spotId: 'H' }).state
  // Reproduces an imported/handed-off save: counters advance while static tab lists stay empty.
  const before = blob(poked, 'task')
  assert.equal(before.doNums.Amusing, 5)
  assert.deepEqual(before.taskList, { daily: [], ddw: [], growth: [], travel: [] })

  const claimed = ok(poked, 'task.claim', { tab: 'ddw', index: 0 })
  const task = blob(claimed.state, 'task')
  assert.equal(task.taskList.ddw.length, STATIC_TASKS.ddw.length)
  assert.equal(task.taskList.growth.length, STATIC_TASKS.growth.length)
  assert.equal(task.taskList.travel.length, STATIC_TASKS.travel.length)
  assert.equal(task.taskList.ddw[0].take, true)
  assert.equal(task.taskList.ddw[1].take, false)
  assert.equal(claimed.state.save.selfGoodDatas.food.find(entry => entry.startsWith('_102010001*')), '_102010001*6')
  assert.equal(claimed.result.goods[0].id, '102010001')
  rejected(claimed.state, 'task.claim', { tab: 'ddw', index: 0 }, {}, 'already_claimed')
  rejected(claimed.state, 'task.claim', { tab: 'ddw', index: 1 }, {}, 'not_available')
})

test('group C: static task tabs materialize missing entries and keep existing ones intact', () => {
  const partial = baseState()
  const kept = goodOf('nums', 'yb', 10)
  partial.save.saveJsonData.task = JSON.stringify({
    doNums: { Amusing: 10 },
    taskList: { daily: [], ddw: [{ take: true, good: [kept] }], growth: [], travel: [] },
  })
  rejected(partial, 'task.claim', { tab: 'ddw', index: 0 }, {}, 'already_claimed')
  const claimed = ok(partial, 'task.claim', { tab: 'ddw', index: 1 })
  const task = blob(claimed.state, 'task')
  assert.deepEqual(task.taskList.ddw[0], { take: true, good: [kept] })
  assert.equal(task.taskList.ddw[1].take, true)
  assert.equal(task.taskList.ddw.length, STATIC_TASKS.ddw.length)

  const rerolled = baseState()
  rerolled.save.saveJsonData.task = JSON.stringify({
    doNums: { Amusing: 25 },
    taskList: { daily: [], ddw: [], growth: [], travel: [] },
  })
  const rolled = ok(rerolled, 'task.claim', { tab: 'ddw', index: 4 })
  const rolledTask = blob(rolled.state, 'task')
  assert.equal(rolledTask.taskList.ddw[4].take, true)
  assert.equal(rolledTask.taskList.ddw[4].good.length, 2)
  assert.equal(rolled.result.goods.length, 2)
})

test('group C: every static task entry is claimable from an untouched save', () => {
  for (const tab of ['ddw', 'growth', 'travel']) {
    STATIC_TASKS[tab].forEach((template, index) => {
      const state = baseState()
      const doNums = template.obj === 'Travel2' ? {} : { [template.obj]: template.num }
      state.save.saveJsonData.task = JSON.stringify({
        doNums,
        taskList: { daily: [], ddw: [], growth: [], travel: [] },
      })
      if (template.obj === 'Travel2') {
        state.save.gameSaveDatas.travel_china = Array.from({ length: template.num }, (_, day) => ({ name: 'city-' + String(day), value: 1 }))
      }
      const claimed = ok(state, 'task.claim', { tab, index })
      const entry = blob(claimed.state, 'task').taskList[tab][index]
      assert.equal(entry.take, true, tab + '#' + String(index) + ' take')
      assert.equal(claimed.result.goods.length, entry.good.length, tab + '#' + String(index) + ' goods')
    })
  }
})

test('group C: exams persist answers, reject wrong devices and expose projections only', () => {
  const ready = baseState()
  ready.save.studyInfo.chinese = 9
  rejected(baseState(), 'exam.start', { subject: 'xx-chinese' }, {}, 'not_available')
  const startedA = ok(ready, 'exam.start', { subject: 'xx-chinese' })
  const startedB = executeCommand(ready, { type: 'exam.start', payload: { subject: 'xx-chinese' } }, context(ready))
  assert.deepEqual(startedA, startedB)
  assert.equal(JSON.stringify(startedA.result).includes('answerIndex'), false)
  assert.equal(JSON.stringify(startedA.result).includes('answerKey'), false)
  assert.equal(startedA.result.questions.length, 3)
  const session = startedA.state.gameSessions.find(candidate => candidate.payload.kind === 'exam')
  assert.ok(session)
  assert.equal(session.payload.questions[0].answerIndex >= 0, true)
  const answers = session.payload.questions.map(question => question.answerIndex)

  const wrongDevice = rejected(startedA.state, 'exam.submit', {
    sessionToken: session.sessionToken, answers,
  }, { actorDeviceId: OTHER_DEVICE_ID }, 'unauthorized')
  assert.equal(wrongDevice.events.length, 0)
  rejected(startedA.state, 'game.reward', { sessionToken: session.sessionToken }, {}, 'wrong_phase')
  const submitted = ok(startedA.state, 'exam.submit', { sessionToken: session.sessionToken, answers })
  assert.equal(submitted.result.passed, true)
  assert.equal(submitted.state.save.studyInfo.chinese, 10)
  rejected(submitted.state, 'exam.submit', { sessionToken: session.sessionToken, answers }, {}, 'already_claimed')
})

test('group D: sign-in, growth draw, online gift, birthday and mail commands', () => {
  const base = baseState()
  const signed = ok(base, 'signin.sign')
  const signin = blob(signed.state, 'signin')
  assert.equal(Object.values(signin.collectionList).flatMap(months => Object.values(months)).flat().length, 1)
  rejected(signed.state, 'signin.sign', {}, {}, 'already_claimed')

  const drawn = ok(base, 'signin.drawGrowth')
  assert.equal(drawn.result.digits.length, 3)
  assert.ok(drawn.state.rng.draws > base.rng.draws)

  const giftReady = baseState()
  giftReady.save.saveJsonData.signin = JSON.stringify({
    collectionList: {}, getGrowth: null, onlineGiftNum: 2, isOnlineLastTime: 0, getBirthDayGift: true,
  })
  const gift = ok(giftReady, 'signin.claimOnlineGift')
  assert.equal(gift.state.save.petInfo.yb, 4800)
  assert.equal(blob(gift.state, 'signin').onlineGiftNum, 3)
  assert.equal(blob(gift.state, 'signin').isOnlineLastTime, 20)
  rejected(gift.state, 'signin.claimOnlineGift', {}, {}, 'cooldown')

  const birthday = baseState()
  birthday.save.saveJsonData.signin = JSON.stringify({
    collectionList: {}, getGrowth: null, onlineGiftNum: 0, isOnlineLastTime: 20, getBirthDayGift: false,
  })
  const birthdayGift = ok(birthday, 'signin.claimBirthdayGift')
  assert.equal(blob(birthdayGift.state, 'signin').getBirthDayGift, true)
  rejected(birthdayGift.state, 'signin.claimBirthdayGift', {}, {}, 'already_claimed')
  const wrongDay = baseState()
  wrongDay.save.petInfo.birthDay = Math.floor(GAME_TIME_MS / 1000) - 5 * 86400
  wrongDay.save.saveJsonData.signin = JSON.stringify({
    collectionList: {}, getGrowth: null, onlineGiftNum: 0, isOnlineLastTime: 20, getBirthDayGift: false,
  })
  rejected(wrongDay, 'signin.claimBirthdayGift', {}, {}, 'not_available')

  const reward = goodOf('nums', 'yb', 5)
  const mailState = baseState()
  mailState.save.saveJsonData.email = JSON.stringify({
    100: { d: 100, l: 'Unclaimed', glb: [reward] },
    101: { d: 101, l: 'Claimed', r: true, glb: [] },
    102: { d: 102, e: true, k: 'old' },
    103: { d: 103, l: 'Second', glb: [reward] },
  })
  const claimed = ok(mailState, 'mail.claim', { mailId: '100' })
  assert.equal(blob(claimed.state, 'email')['100'].r, true)
  rejected(claimed.state, 'mail.claim', { mailId: '100' }, {}, 'already_claimed')
  rejected(claimed.state, 'mail.delete', { mailId: '103' }, {}, 'wrong_phase')
  const deleted = ok(claimed.state, 'mail.delete', { mailId: '100' })
  assert.equal(blob(deleted.state, 'email')['100'].e, true)
  const claimedAll = ok(claimed.state, 'mail.claimAll')
  assert.equal(claimedAll.result.claimed, 1)
  const deletedAll = ok(claimedAll.state, 'mail.deleteAll', { scope: 'claimed' })
  assert.ok(deletedAll.result.deleted >= 2)
  const mailAfter = blob(deletedAll.state, 'email')
  assert.equal(mailAfter['101'].e, true)
  assert.equal(mailAfter['103'].e, true)
  assert.equal(mailAfter['102'].e, true)
})

test('daily boundary resets tasks/sign-in/fish/VIP and delivers due mail', () => {
  const state = baseState()
  state.gameTimeMs = NEXT_BOUNDARY_MS - 60000
  state.nextDailyBoundaryMs = NEXT_BOUNDARY_MS
  state.lastProcessedDayBoundaryKey = DAY_KEY
  state.save.petInfo.onLineTime = 20
  state.save.saveJsonData.signin = JSON.stringify({
    collectionList: {}, getGrowth: [[1, 2, 3], null], onlineGiftNum: 4, isOnlineLastTime: 3, getBirthDayGift: true,
  })
  state.save.saveJsonData.fishs = JSON.stringify({ PD: { allvipcnt: 0, canusecnt: 5 }, fishs: [] })
  state.environment.calendarByDay = {
    '2026-10-21': {
      date: '2026-10-21', lunar: '九月初一', term: null, holiday: { name: '测试节', off: true },
    },
  }
  const tick = advanceMinute(state, context(state, { sessionActive: false, activeClientCount: 0 }))
  assert.equal(tick.ok, true, JSON.stringify(tick.ok ? tick.result : tick.error))
  const task = blob(tick.state, 'task')
  assert.ok(task.daily.length > 0)
  assert.equal(task.taskList.ddw.length, 5)
  assert.equal(task.taskList.growth.length, 4)
  assert.equal(task.taskList.travel.length, 9)
  const signin = blob(tick.state, 'signin')
  assert.equal(signin.getGrowth, null)
  assert.equal(signin.onlineGiftNum, 0)
  assert.equal(signin.isOnlineLastTime, 20)
  assert.equal(signin.getBirthDayGift, false)
  const pond = blob(tick.state, 'fishs')
  assert.equal(pond.PD.allvipcnt, 2)
  assert.equal(pond.PD.canusecnt, 0)
  const mails = Object.values(blob(tick.state, 'email'))
  assert.ok(mails.some(mail => mail.l === '欢迎来到QQ宠物~'))
  assert.ok(mails.some(mail => mail.l === '测试节快乐！'))
  assert.equal(tick.state.lastProcessedDayBoundaryKey, '2026-10-21')
  assert.ok(tick.state.nextDailyBoundaryMs > NEXT_BOUNDARY_MS)
  assert.equal(tick.state.environment.weatherByDay['2026-10-21'].provenance, 'fallback')
})

test('coverage-derived activeClientCount only covers actual connected intervals', () => {
  const coverage = [
    { coverageId: 'open-before', deviceId: 'device-a', connectedAtWallMs: 1000, lastHeartbeatWallMs: 1900 },
    { coverageId: 'closed-mid', deviceId: 'device-b', connectedAtWallMs: 2000, lastHeartbeatWallMs: 2400, disconnectedAtWallMs: 2500 },
    { coverageId: 'late', deviceId: 'device-c', connectedAtWallMs: 5000, lastHeartbeatWallMs: 5400, disconnectedAtWallMs: 5500 },
  ]
  assert.deepEqual(sessionActivityForInterval(coverage, 1000, 2000), { activeClientCount: 1, sessionActive: true })
  assert.deepEqual(sessionActivityForInterval(coverage, 2000, 2500), { activeClientCount: 2, sessionActive: true })
  assert.deepEqual(sessionActivityForInterval(coverage, 2500, 5000), { activeClientCount: 1, sessionActive: true })
  assert.deepEqual(sessionActivityForInterval(coverage, 5000, 5500), { activeClientCount: 2, sessionActive: true })
  assert.deepEqual(sessionActivityForInterval(coverage, 5500, 6000), { activeClientCount: 1, sessionActive: true })
  assert.deepEqual(sessionActivityForInterval([], 1000, 2000), { activeClientCount: 0, sessionActive: false })
})

test('online-session clock splits from world time and weather fallback is stable', () => {
  const offline = baseState()
  const online = baseState()
  offline.save.saveJsonData.signin = JSON.stringify({
    collectionList: {}, getGrowth: null, onlineGiftNum: 0, isOnlineLastTime: 20, getBirthDayGift: true,
  })
  online.save.saveJsonData.signin = offline.save.saveJsonData.signin
  const offlineTick = advanceMinute(offline, context(offline, { sessionActive: false, activeClientCount: 0 }))
  const onlineTick = advanceMinute(online, context(online, { sessionActive: true, activeClientCount: 1 }))
  assert.equal(offlineTick.ok, true)
  assert.equal(onlineTick.ok, true)
  assert.equal(offlineTick.state.save.petInfo.onLineTime, 0)
  assert.equal(offlineTick.state.save.petInfo.onlineDataTime, 0)
  assert.equal(onlineTick.state.save.petInfo.onLineTime, 1)
  assert.equal(onlineTick.state.save.petInfo.onlineDataTime, 1)
  assert.equal(blob(offlineTick.state, 'signin').isOnlineLastTime, 20)
  assert.equal(blob(onlineTick.state, 'signin').isOnlineLastTime, 19)
  assert.equal(offlineTick.state.save.petInfo.hunger, onlineTick.state.save.petInfo.hunger)
  const weather = offlineTick.state.environment.weatherByDay[DAY_KEY]
  assert.equal(weather.provenance, 'fallback')
  assert.deepEqual(weather, fallbackWeatherForDay(SEED, DAY_KEY, { fetchedAtMs: GAME_TIME_MS + 60000, sourceLabel: 'seed+day-key' }))
  assert.deepEqual(offlineTick.state.environment.weatherByDay, onlineTick.state.environment.weatherByDay)
})

test('runtime state serialization round-trips through the schema codec', () => {
  const state = ok(baseState(), 'signin.sign').state
  const advanced = advanceMinutes(state, context(state, { sessionActive: false, activeClientCount: 0 }), 3)
  assert.equal(advanced.ok, true)
  const encoded = serializeRuntimeState(advanced.state, RUNTIME_SCHEMA_VERSION)
  const decoded = deserializeRuntimeState(encoded, RUNTIME_SCHEMA_VERSION, validateEngineState)
  assert.deepEqual(decoded, advanced.state)
  assert.equal(validateEngineState(decoded), true)
})

test('headless runtime executes commands and ticks without host globals', () => {
  const base = baseState()
  const runtime = createHeadlessRuntime(base)
  const command = runtime.execute({ type: 'signin.sign', payload: {} }, context(base))
  assert.equal(command.ok, true)
  const before = runtime.snapshot()
  const tick = runtime.tick(context(before, { sessionActive: true, activeClientCount: 1 }))
  assert.equal(tick.ok, true)
  const after = runtime.snapshot()
  assert.equal(after.gameTimeMs, before.gameTimeMs + 60000)
  assert.equal(after.save.petInfo.onLineTime, 1)
})

test('actor-bound game and diudiule sessions reject replay, expiry, wrong device and kind confusion', () => {
  const base = baseState()
  const startedA = ok(base, 'game.startSession', { gameId: 'smallgame-1', kind: 'small' })
  const startedB = executeCommand(base, { type: 'game.startSession', payload: { gameId: 'smallgame-1', kind: 'small' } }, context(base))
  assert.deepEqual(startedA, startedB)
  const token = startedA.result.sessionToken
  assert.equal(token.length, 32)
  rejected(startedA.state, 'game.reward', { sessionToken: token }, { actorDeviceId: OTHER_DEVICE_ID }, 'unauthorized')
  rejected(startedA.state, 'game.reward', { sessionToken: 'fabricated-token' }, {}, 'not_available')

  const zero = ok(base, 'game.startSession', { gameId: 'smallgame-zero', kind: 'small' })
  const zeroReward = ok(zero.state, 'game.reward', { sessionToken: zero.result.sessionToken })
  assert.equal(zeroReward.result.minutes, 0)
  assert.equal(zeroReward.result.gameRound, 0)
  assert.equal(blob(zeroReward.state, 'task').doNums?.GameRound, undefined)
  const zeroSession = zeroReward.state.gameSessions.find(session => session.sessionToken === zero.result.sessionToken)
  assert.equal(zeroSession.status, 'settled')

  const fiveMinutesLater = startedA.state.gameTimeMs + 5 * 60000
  const rewarded = ok(startedA.state, 'game.reward', { sessionToken: token }, { gameTimeMs: fiveMinutesLater })
  assert.equal(rewarded.result.minutes, 5)
  assert.equal(rewarded.result.yb, 25)
  const gameTask = blob(rewarded.state, 'task')
  assert.equal(gameTask.doNums.GameRound, 1)
  assert.equal(gameTask.doNums.Game, 5)
  rejected(rewarded.state, 'game.reward', { sessionToken: token }, { gameTimeMs: fiveMinutesLater }, 'already_claimed')

  const diudiuleBase = baseState()
  diudiuleBase.save.petInfo.mood = 900
  const diudiule = ok(diudiuleBase, 'diudiule.startSession')
  rejected(diudiule.state, 'game.reward', { sessionToken: diudiule.result.sessionToken }, {}, 'wrong_phase')
  const diudiuleReward = ok(diudiule.state, 'diudiule.reward', { sessionToken: diudiule.result.sessionToken })
  assert.equal(diudiuleReward.result.mood, 55)
  assert.equal(blob(diudiuleReward.state, 'task').doNums?.GameRound, undefined)
  rejected(diudiuleReward.state, 'diudiule.reward', { sessionToken: diudiule.result.sessionToken }, {}, 'already_claimed')

  const expired = ok(base, 'diudiule.startSession')
  const expiredSession = expired.state.gameSessions.find(session => session.sessionToken === expired.result.sessionToken)
  rejected(expired.state, 'diudiule.reward', { sessionToken: expired.result.sessionToken }, {
    gameTimeMs: expiredSession.expiresAtGameMs + 1,
  }, 'not_available')

  const abandoned = ok(base, 'game.startSession', { gameId: 'smallgame-2', kind: 'flash' })
  const abandon = ok(abandoned.state, 'game.abandonSession', { sessionToken: abandoned.result.sessionToken })
  assert.equal(abandon.result.status, 'abandoned')
  rejected(abandon.state, 'game.reward', { sessionToken: abandoned.result.sessionToken }, {}, 'already_claimed')

  const expiring = ok(base, 'diudiule.startSession')
  const advanced = advanceMinutes(expiring.state, context(expiring.state, { sessionActive: false, activeClientCount: 0 }), 5)
  assert.equal(advanced.ok, true, JSON.stringify(advanced.ok ? advanced.result : advanced.error))
  const expiredStateSession = advanced.state.gameSessions.find(session => session.sessionToken === expiring.result.sessionToken)
  assert.equal(expiredStateSession.status, 'expired')
  assert.equal(advanced.state.scheduledJobs.find(job => job.payload.sessionToken === expiring.result.sessionToken).status, 'completed')
})

test('exam and island-quiz sessions are actor-bound, one-use and answer-key-free in results', () => {
  const ready = baseState()
  ready.save.studyInfo.chinese = 9
  const exam = ok(ready, 'exam.start', { subject: 'xx-chinese' })
  const examSession = exam.state.gameSessions.find(session => session.payload.kind === 'exam')
  assert.equal(JSON.stringify(exam.result).includes('answerIndex'), false)
  assert.equal(examSession.payload.questions.every(question => Number.isSafeInteger(question.answerIndex)), true)
  rejected(exam.state, 'exam.submit', {
    sessionToken: exam.result.sessionToken,
    answers: examSession.payload.questions.map(question => question.answerIndex),
  }, { actorDeviceId: OTHER_DEVICE_ID }, 'unauthorized')
  const answers = examSession.payload.questions.map(question => question.answerIndex)
  rejected(exam.state, 'game.reward', { sessionToken: exam.result.sessionToken }, {}, 'wrong_phase')
  const submitted = ok(exam.state, 'exam.submit', { sessionToken: exam.result.sessionToken, answers })
  assert.equal(submitted.result.passed, true)
  rejected(submitted.state, 'exam.submit', { sessionToken: exam.result.sessionToken, answers }, {}, 'already_claimed')

  const quiz = baseState()
  quiz.save.saveJsonData.island = JSON.stringify({
    day: Math.floor(GAME_TIME_MS / 1000), sent: 0, letter: '', lit: [], lamps: [], tier: 0, pieces: 0,
    piece: false, want: '', loved: false,
    errands: [{ from: 'npc-1', kind: 'quiz', to: 'xx-chinese', got: 0, took: false }],
    fought: [], wins: 0,
  })
  const pausedQuiz = clone(quiz)
  pausedQuiz.save.settings.paused = true
  rejected(pausedQuiz, 'island.startQuiz', { npcId: 'npc-1', errandId: 'quiz' }, {}, 'paused')
  const busyQuiz = clone(quiz)
  busyQuiz.save.activeOption.work = 'bz'
  rejected(busyQuiz, 'island.startQuiz', { npcId: 'npc-1', errandId: 'quiz' }, {}, 'busy')

  const bankLength = EXAM_BANK['xx-chinese'].length
  const dayOne = clone(quiz)
  const dayOneIsland = blob(dayOne, 'island')
  dayOneIsland.day = 86400
  dayOne.save.saveJsonData.island = JSON.stringify(dayOneIsland)
  const dayOneQuiz = ok(dayOne, 'island.startQuiz', { npcId: 'npc-1', errandId: 'quiz' })
  assert.equal(dayOneQuiz.result.recordId, 'xx-chinese:' + String(Math.floor(86400 / 86400) % bankLength))
  const dayTwo = clone(quiz)
  const dayTwoIsland = blob(dayTwo, 'island')
  dayTwoIsland.day = 2 * 86400
  dayTwo.save.saveJsonData.island = JSON.stringify(dayTwoIsland)
  const dayTwoQuiz = ok(dayTwo, 'island.startQuiz', { npcId: 'npc-1', errandId: 'quiz' })
  assert.equal(dayTwoQuiz.result.recordId, 'xx-chinese:' + String(Math.floor((2 * 86400) / 86400) % bankLength))
  assert.equal(dayOneQuiz.result.recordId === dayTwoQuiz.result.recordId, false)

  const quizStarted = ok(quiz, 'island.startQuiz', { npcId: 'npc-1', errandId: 'quiz' })
  assert.equal(JSON.stringify(quizStarted.result).includes('answerIndex'), false)
  assert.equal(quizStarted.result.sessionToken.length, 32)
  const quizSession = quizStarted.state.gameSessions.find(session => session.payload.kind === 'island_quiz')
  assert.equal(quizSession.payload.answerIndex >= 0, true)
  rejected(quizStarted.state, 'island.answerQuiz', {
    sessionToken: quizStarted.result.sessionToken, optionIndex: quizSession.payload.answerIndex,
  }, { actorDeviceId: OTHER_DEVICE_ID }, 'unauthorized')
  const identityChanged = clone(quizStarted.state)
  const changedIsland = blob(identityChanged, 'island')
  changedIsland.errands[0].to = 'xx-mathematics'
  identityChanged.save.saveJsonData.island = JSON.stringify(changedIsland)
  rejected(identityChanged, 'island.answerQuiz', {
    sessionToken: quizStarted.result.sessionToken, optionIndex: quizSession.payload.answerIndex,
  }, {}, 'not_available')

  const wrongIndex = (quizSession.payload.answerIndex + 1) % quizSession.payload.options.length
  const wrongQuiz = ok(quizStarted.state, 'island.answerQuiz', {
    sessionToken: quizStarted.result.sessionToken, optionIndex: wrongIndex,
  })
  assert.equal(wrongQuiz.result.correct, false)
  const islandAfterWrong = blob(wrongQuiz.state, 'island')
  assert.equal(islandAfterWrong.errands[0].took, true)
  assert.equal(islandAfterWrong.errands[0].got, 0)

  const correctQuizSession = ok(quizStarted.state, 'island.startQuiz', { npcId: 'npc-1', errandId: 'quiz' })
  const correctSession = correctQuizSession.state.gameSessions
    .filter(session => session.payload.kind === 'island_quiz' && session.status === 'active')
    .at(-1)
  const correct = ok(correctQuizSession.state, 'island.answerQuiz', {
    sessionToken: correctSession.sessionToken, optionIndex: correctSession.payload.answerIndex,
  })
  assert.equal(correct.result.correct, true)
  const islandAfterCorrect = blob(correct.state, 'island')
  assert.equal(islandAfterCorrect.errands[0].took, true)
  assert.equal(islandAfterCorrect.errands[0].got, 1)
  rejected(correct.state, 'island.answerQuiz', {
    sessionToken: correctSession.sessionToken, optionIndex: correctSession.payload.answerIndex,
  }, {}, 'already_claimed')
})

test('local actor rebind helpers preserve, rebind or abandon imported sessions explicitly', () => {
  const base = baseState()
  const started = ok(base, 'game.startSession', { gameId: 'smallgame-rebind', kind: 'small' })
  const token = started.result.sessionToken
  const rebound = rebindSessionActor(started.state, token, OTHER_DEVICE_ID)
  assert.equal(rebound.gameSessions.find(session => session.sessionToken === token).actorDeviceId, OTHER_DEVICE_ID)
  assert.equal(started.state.gameSessions.find(session => session.sessionToken === token).actorDeviceId, LOCAL_DEVICE_ID)
  rejected(rebound, 'game.reward', { sessionToken: token }, {
    gameTimeMs: rebound.gameTimeMs + 60000,
  }, 'unauthorized')
  const reboundReward = ok(rebound, 'game.reward', { sessionToken: token }, {
    actorDeviceId: OTHER_DEVICE_ID,
    gameTimeMs: rebound.gameTimeMs + 60000,
  })
  assert.equal(reboundReward.result.minutes, 1)

  const reboundImport = rebindOrCancelImportedSessions(started.state, {
    localActorDeviceId: LOCAL_DEVICE_ID,
    newActorDeviceId: OTHER_DEVICE_ID,
    rebindLocalSessions: true,
    nowMs: started.state.gameTimeMs,
  })
  assert.equal(reboundImport.gameSessions.find(session => session.sessionToken === token).actorDeviceId, OTHER_DEVICE_ID)
  const cancelledImport = rebindOrCancelImportedSessions(started.state, {
    localActorDeviceId: LOCAL_DEVICE_ID,
    newActorDeviceId: OTHER_DEVICE_ID,
    rebindLocalSessions: false,
    nowMs: started.state.gameTimeMs,
  })
  const cancelled = cancelledImport.gameSessions.find(session => session.sessionToken === token)
  assert.equal(cancelled.status, 'abandoned')
  assert.equal(cancelled.cancelReason, 'actor_rebind_failed')
  assert.equal(cancelledImport.scheduledJobs.find(job => job.payload.sessionToken === token).status, 'cancelled')

  const multi = clone(started.state)
  const sessionTemplate = multi.gameSessions[0]
  multi.gameSessions = [
    { ...sessionTemplate, sessionToken: 'local-session', actorDeviceId: LOCAL_DEVICE_ID },
    { ...sessionTemplate, sessionToken: 'upload-session', actorDeviceId: OTHER_DEVICE_ID, payload: { kind: 'diudiule' } },
    { ...sessionTemplate, sessionToken: 'foreign-session', actorDeviceId: 'foreign-device', payload: { kind: 'diudiule' } },
  ]
  multi.scheduledJobs = ['local-session', 'upload-session', 'foreign-session'].map((sessionToken, index) => ({
    id: index + 1,
    type: 'game-session',
    dueAtGameMs: multi.gameTimeMs + 60000,
    payload: { sessionToken, kind: 'diudiule' },
    status: 'pending',
  }))
  multi.nextScheduledJobId = 4
  const imported = rebindOrCancelImportedSessions(multi, {
    localActorDeviceId: LOCAL_DEVICE_ID,
    newActorDeviceId: OTHER_DEVICE_ID,
    rebindLocalSessions: true,
    nowMs: multi.gameTimeMs,
  })
  assert.equal(imported.gameSessions.find(session => session.sessionToken === 'local-session').actorDeviceId, OTHER_DEVICE_ID)
  assert.equal(imported.gameSessions.find(session => session.sessionToken === 'upload-session').status, 'active')
  const foreign = imported.gameSessions.find(session => session.sessionToken === 'foreign-session')
  assert.equal(foreign.status, 'abandoned')
  assert.equal(foreign.cancelReason, 'actor_rebind_failed')
  assert.equal(imported.scheduledJobs.find(job => job.payload.sessionToken === 'foreign-session').status, 'cancelled')
  assert.equal(imported.scheduledJobs.find(job => job.payload.sessionToken === 'upload-session').status, 'pending')

  const noRebind = rebindOrCancelImportedSessions(multi, {
    localActorDeviceId: LOCAL_DEVICE_ID,
    newActorDeviceId: OTHER_DEVICE_ID,
    rebindLocalSessions: false,
    nowMs: multi.gameTimeMs,
  })
  assert.equal(noRebind.gameSessions.find(session => session.sessionToken === 'local-session').cancelReason, 'actor_rebind_failed')
  assert.equal(noRebind.gameSessions.find(session => session.sessionToken === 'upload-session').status, 'active')
  assert.equal(noRebind.scheduledJobs.find(job => job.payload.sessionToken === 'local-session').status, 'cancelled')
})

test('timed activities complete from scheduled game-time jobs without client timers', () => {
  const studyBase = baseState()
  const startedStudy = ok(studyBase, 'job.startStudy', { courseId: 'xx-chinese' })
  const studyJob = startedStudy.state.scheduledJobs[0]
  const studyMinutes = Math.ceil((studyJob.dueAtGameMs - startedStudy.state.gameTimeMs) / 60000)
  const completedStudy = advanceMinutes(
    startedStudy.state,
    context(startedStudy.state, { sessionActive: false, activeClientCount: 0 }),
    studyMinutes,
  )
  assert.equal(completedStudy.ok, true, JSON.stringify(completedStudy.ok ? completedStudy.result : completedStudy.error))
  assert.equal(completedStudy.state.save.activeOption.study, null)
  assert.equal(completedStudy.state.save.studyInfo.chinese, 1)
  assert.equal(blob(completedStudy.state, 'task').doNums.Study, 1)
  assert.equal(completedStudy.state.scheduledJobs[0].status, 'completed')

  const travelBase = baseState()
  const startedTravel = ok(travelBase, 'job.startTravel')
  const completedTravel = advanceMinutes(
    startedTravel.state,
    context(startedTravel.state, { sessionActive: false, activeClientCount: 0 }),
    60,
  )
  assert.equal(completedTravel.ok, true, JSON.stringify(completedTravel.ok ? completedTravel.result : completedTravel.error))
  assert.equal(completedTravel.state.save.activeOption.trip, null)
  assert.equal(completedTravel.state.save.gameSaveDatas.travel_china.length, 1)
  assert.equal(completedTravel.state.save.gameSaveDatas.travel_china[0].name, startedTravel.result.destination)
  assert.equal(blob(completedTravel.state, 'task').doNums.Travel1, 1)
})

test('daily VIP settlement and timed-good expiry are boundary/tick driven', () => {
  const state = baseState()
  state.gameTimeMs = NEXT_BOUNDARY_MS - 60000
  state.nextDailyBoundaryMs = NEXT_BOUNDARY_MS
  state.lastProcessedDayBoundaryKey = DAY_KEY
  const currentBoundarySec = Math.floor((NEXT_BOUNDARY_MS - 86400000) / 1000)
  state.save.petInfo.pinkDiamond = true
  state.save.petInfo.PDiamondLevel = 1
  state.save.petInfo.PDgrowth = 0
  state.save.petInfo.PDgrowthValue = 20
  state.save.petInfo.PDiamondBeginDate = currentBoundarySec
  state.save.petInfo.PDiamondExpirationDate = currentBoundarySec + 3 * 86400
  state.save.petInfo.sweetHeart = true
  state.save.petInfo.sweetHeartOverTime = Math.floor(NEXT_BOUNDARY_MS / 1000)
  state.save.selfGoodUseOption.food = { id: '102010001', left: 1 }
  const tick = advanceMinute(state, context(state, { sessionActive: false, activeClientCount: 0 }))
  assert.equal(tick.ok, true, JSON.stringify(tick.ok ? tick.result : tick.error))
  assert.equal(tick.state.save.petInfo.PDgrowth, 20)
  assert.equal(tick.state.save.petInfo.pinkDiamond, true)
  assert.equal(tick.state.save.petInfo.PDiamondLevel, 1)
  assert.equal(tick.state.save.petInfo.sweetHeart, false)
  assert.equal(tick.state.save.petInfo.sweetHeartOverTime, 0)
  assert.equal(tick.state.save.selfGoodUseOption.food, null)
  assert.equal(tick.events.some(event => event.type === 'item.consumed' && event.payload.expired === true), true)

  const expiring = baseState()
  expiring.gameTimeMs = NEXT_BOUNDARY_MS - 60000
  expiring.nextDailyBoundaryMs = NEXT_BOUNDARY_MS
  expiring.lastProcessedDayBoundaryKey = DAY_KEY
  expiring.save.petInfo.pinkDiamond = true
  expiring.save.petInfo.PDiamondLevel = 3
  expiring.save.petInfo.PDiamondExpirationDate = Math.floor(NEXT_BOUNDARY_MS / 1000)
  expiring.save.saveJsonData.fishs = JSON.stringify({ PD: { allvipcnt: 6, canusecnt: 6 }, fishs: [] })
  const expired = advanceMinute(expiring, context(expiring, { sessionActive: false, activeClientCount: 0 }))
  assert.equal(expired.ok, true, JSON.stringify(expired.ok ? expired.result : expired.error))
  assert.equal(expired.state.save.petInfo.pinkDiamond, false)
  assert.deepEqual(blob(expired.state, 'fishs').PD, { allvipcnt: 2, canusecnt: 0 })
})

test('numeric inventory use and doctor revival use canonical content effects', () => {
  const numeric = baseState()
  const grown = ok(numeric, 'inventory.use', { type: 'nums', itemId: 'growth', quantity: 2 })
  assert.equal(grown.state.save.petInfo.growth, 5002)
  assert.equal(grown.state.save.selfGoodDatas.nums.find(entry => entry.startsWith('_growth*')), '_growth*8')

  const dead = baseState()
  dead.save.petInfo.health = 0
  dead.save.activeOption.ill = '0-'
  const revived = ok(dead, 'medical.treat', { mode: 'doctor' })
  assert.equal(revived.state.save.petInfo.health, 5)
  assert.equal(revived.state.save.activeOption.ill, null)
  assert.equal(revived.state.save.selfGoodDatas.medicine.some(entry => entry.startsWith('_60001*')), false)
})

test('C3 deterministic golden scenario replays byte-identically', () => {
  function scenario() {
    let state = baseState()
    const events = []
    for (const command of [
      { type: 'pet.pokeFace', payload: { spotId: 'H' } },
      { type: 'inventory.buy', payload: { type: 'food', itemId: '102010001', quantity: 2 } },
      { type: 'inventory.use', payload: { type: 'food', itemId: '102010001', quantity: 1 } },
      { type: 'signin.sign', payload: {} },
      { type: 'job.startWork', payload: { jobId: 'bz' } },
    ]) {
      const outcome = executeCommand(state, command, context(state))
      assert.equal(outcome.ok, true, command.type)
      state = outcome.state
      events.push(...outcome.events)
    }
    const ticked = advanceMinutes(state, context(state, { sessionActive: true, activeClientCount: 1 }), 30)
    assert.equal(ticked.ok, true)
    events.push(...ticked.events)
    return { state: ticked.state, events }
  }
  const first = scenario()
  const second = scenario()
  assert.deepEqual(first, second)
  const digest = createHash('sha256')
    .update(serializeRuntimeState(first.state, RUNTIME_SCHEMA_VERSION))
    .update(stableStringify(first.events))
    .digest('hex')
  // #75: the scenario signs in, so the canonical digest now carries petInfo.diamond (3 -> 4) and
  // the extra reward.granted {source:'signin-diamond'} event. Replay determinism is still exact.
  // F2: the first tick now materializes today's daily tasks (definitions + entries + dailyDay)
  // before the work job settles, so the digest also covers that canonical table and its RNG draws.
  assert.equal(digest, '853e8d8c61a35681745d927ea1f69361f627e0042d8a3f3cfd2cf891025945c1')
  assert.equal(validateEngineState(first.state), true)
})


test('C3 command slice covers every A-D and actor-bound session command', () => {
  assert.deepEqual([...C3_COMMAND_TYPES].sort(), [
    'activity.stop',
    'diudiule.reward',
    'diudiule.startSession',
    'exam.start',
    'exam.submit',
    'game.abandonSession',
    'game.reward',
    'game.startSession',
    'inventory.buy',
    'inventory.use',
    'island.answerQuiz',
    'island.startQuiz',
    'job.startStudy',
    'job.startTravel',
    'job.startWork',
    'mail.claim',
    'mail.claimAll',
    'mail.delete',
    'mail.deleteAll',
    'medical.treat',
    'pet.adopt',
    'pet.bury',
    'pet.cheer',
    'pet.pokeFace',
    'pet.rename',
    'pet.reset',
    'pet.setPaused',
    'signin.claimBirthdayGift',
    'signin.claimOnlineGift',
    'signin.drawGrowth',
    'signin.sign',
    'task.claim',
    'travel.completeCollection',
    'vip.buyPinkDiamond',
    'vip.buySweetheart',
    'vip.clearPinkDiamond',
    'vip.setSweetheart',
  ])
  for (const command of C3_COMMAND_TYPES) assert.ok(COMMAND_TYPES.includes(command), command)
})


test('runtime content copies remain byte-identical to the renderer extraction sources', () => {
  for (const file of ['goods.json', 'pool.json', 'travel.json', 'exam.json', 'album.json']) {
    const runtime = readFileSync(new URL(`../../src/shared/pet-runtime/content/${file}`, import.meta.url), 'utf8')
    const renderer = readFileSync(new URL(`../../src/renderer/pet/data/${file}`, import.meta.url), 'utf8')
    assert.equal(runtime, renderer, file)
  }
  const runtimeIlls = readFileSync(new URL('../../src/shared/pet-runtime/content/ills.ts', import.meta.url), 'utf8')
  const rendererIlls = readFileSync(new URL('../../src/renderer/pet/data/ills.ts', import.meta.url), 'utf8')
  assert.equal(runtimeIlls, rendererIlls)
})

test('task tables drift guard matches renderer TASKS/KINDS exactly', () => {
  const renderer = readRendererTaskTables()
  assert.deepEqual(STATIC_TASKS, renderer.tasks)
  assert.deepEqual(
    DAILY_TASK_TEMPLATES.map(template => ({
      obj: template.obj,
      label: template.label,
      num: template.num,
      msg: template.msg,
      needsKind: template.needsKind,
      canLevelTwo: template.canLevelTwo,
      hasCan: template.hasCan,
    })),
    renderer.kinds.map(({ obj, label, num, msg, needsKind, canLevelTwo, hasCan }) => ({
      obj, label, num, msg, needsKind, canLevelTwo, hasCan,
    })),
  )
  assert.equal(DAILY_TASK_TEMPLATES.some(template => template.obj === 'Game'), true)
  assert.equal(DAILY_TASK_TEMPLATES.some(template => template.obj === 'GameRound'), true)
})

test('daily tasks use weighted needs, four unique tasks, Work availability and holiday extras', () => {
  const hungry = baseState()
  hungry.save.petInfo.hunger = 100
  hungry.save.petInfo.clean = 1000
  hungry.save.petInfo.mood = 1000
  hungry.save.petInfo.yb = 5000
  const pool = dailyTaskPool(hungry.save, false)
  assert.equal(pool.filter(template => template.obj === 'Eat').length, 3)
  assert.equal(pool.filter(template => template.obj === 'Study').length, 3)
  assert.equal(pool.filter(template => template.obj === 'Game').length, 1)

  const lowLevel = baseState()
  lowLevel.save.petComputedlInfo.level = 1
  lowLevel.save.petInfo.yb = 0
  assert.equal(dailyTaskCandidates(lowLevel.save).some(template => template.obj === 'Work'), false)
  const highLevel = baseState()
  highLevel.save.petInfo.yb = 0
  assert.equal(dailyTaskCandidates(highLevel.save).some(template => template.obj === 'Work'), true)

  const save = baseState()
  const daily = rollDailyTasks(save.save, GAME_TIME_MS, 'Asia/Shanghai', createRuntimeRng(createRngState(SEED)))
  assert.equal(daily.length, 4)
  assert.equal(new Set(daily.map(task => task.obj)).size, 4)
  const off = dailyTaskIsOff(GAME_TIME_MS, 'Asia/Shanghai')
  for (const task of daily) {
    const template = DAILY_TASK_TEMPLATES.find(candidate => candidate.obj === task.obj)
    assert.ok(template, task.obj)
    assert.equal(task.label, template.label.replace('{n}', String(task.num)))
    assert.equal(task.msg, template.msg[dailyTaskNeeded(template, save.save, off) ? 0 : 1])
  }

  const holidayCalendar = {
    date: '2026-10-20', lunar: '九月初一', term: null, holiday: { name: '测试节', off: true },
  }
  const holidaySave = baseState()
  const holidayDaily = rollDailyTasks(holidaySave.save, GAME_TIME_MS, 'Asia/Shanghai', createRuntimeRng(createRngState(SEED)), holidayCalendar)
  assert.equal(holidayDaily.length, 5)
  assert.deepEqual(holidayDaily[4], {
    label: '测试节快乐',
    msg: '过节啦，陪我玩5次玩具一起庆祝吧~',
    obj: 'Toy',
    num: 5,
    reroll: 2,
    good: ['_yb*100'],
  })
})

test('daily task messages follow the need branch and Game is in the daily pool', () => {
  function findTaskWithObj(start, obj, attemptLimit = 200) {
    for (let attempt = 1; attempt <= attemptLimit; attempt++) {
      const save = clone(start.save)
      const seed = deterministicSeed(attempt)
      const daily = rollDailyTasks(save, GAME_TIME_MS, 'Asia/Shanghai', createRuntimeRng(createRngState(seed)))
      const task = daily.find(candidate => candidate.obj === obj)
      if (task) return { task, save, off: dailyTaskIsOff(GAME_TIME_MS, 'Asia/Shanghai') }
    }
    throw new Error('could not generate requested daily task: ' + obj)
  }
  const hungry = baseState()
  hungry.save.petInfo.hunger = 100
  const hungryEat = findTaskWithObj(hungry, 'Eat')
  const hungryTemplate = DAILY_TASK_TEMPLATES.find(template => template.obj === 'Eat')
  assert.equal(hungryEat.task.msg, hungryTemplate.msg[0])
  assert.equal(dailyTaskNeeded(hungryTemplate, hungryEat.save, hungryEat.off), true)

  const full = baseState()
  full.save.petInfo.hunger = 1000
  const fullEat = findTaskWithObj(full, 'Eat')
  assert.equal(fullEat.task.msg, hungryTemplate.msg[1])
  assert.equal(dailyTaskNeeded(hungryTemplate, fullEat.save, fullEat.off), false)

  const gamePool = dailyTaskPool(full.save, dailyTaskIsOff(GAME_TIME_MS, 'Asia/Shanghai'))
  assert.ok(gamePool.some(template => template.obj === 'Game'))
})

test('travel completion matches early souvenir and always-photo/mail branches', () => {
  const destination = TRAVEL_PROVINCES[0].name
  function applyBranch(early) {
    const state = baseState()
    state.save.activeOption.trip = destination
    const before = travelInventoryTotal(state.save)
    const events = applyTravelCompletion(state, destination, early, state.gameTimeMs, createRuntimeRng(createRngState(SEED)))
    return {
      state,
      events,
      before,
      after: travelInventoryTotal(state.save),
      album: blob(state, 'album'),
      mails: blob(state, 'email'),
      completion: events.find(event => event.type === 'activity.completed'),
    }
  }
  const normal = applyBranch(false)
  assert.equal(normal.completion.payload.early, false)
  assert.equal(normal.completion.payload.souvenirs, 0)
  assert.equal(normal.after, normal.before)
  assert.equal(normal.album.length, 1)
  assert.equal(normal.album[0].city, destination)
  assert.equal(Object.values(normal.mails).some(mail => mail.p === normal.album[0].id), true)
  assert.equal(normal.state.save.activeOption.trip, null)
  assert.equal(normal.state.save.gameSaveDatas.travel_china[0].name, destination)
  assert.equal(blob(normal.state, 'task').doNums.Travel1, 1)

  const early = applyBranch(true)
  assert.equal(early.completion.payload.early, true)
  assert.equal(early.completion.payload.souvenirs, 1)
  assert.equal(early.after, early.before + 1)
  assert.equal(early.album.length, 1)
  assert.equal(Object.values(early.mails).some(mail => mail.p === early.album[0].id), true)
})

test('normal 60-minute travel does not add a souvenir and early roll does', () => {
  function run(seed) {
    const state = baseState()
    state.rng = createRngState(seed)
    const started = ok(state, 'job.startTravel')
    const before = travelInventoryTotal(started.state.save)
    const ticked = advanceMinutes(started.state, context(started.state, { sessionActive: false, activeClientCount: 0 }), 60)
    assert.equal(ticked.ok, true, JSON.stringify(ticked.ok ? ticked.result : ticked.error))
    const completion = ticked.events.find(event => event.type === 'activity.completed' && event.payload.kind === 'travel')
    assert.ok(completion)
    return {
      early: completion.payload.early === true,
      souvenirDelta: travelInventoryTotal(ticked.state.save) - before,
      album: blob(ticked.state, 'album'),
      mails: blob(ticked.state, 'email'),
      jobStatus: ticked.state.scheduledJobs.find(job => job.type === 'travel')?.status,
    }
  }
  let normal = null
  let early = null
  for (let attempt = 1; attempt <= 200 && (normal === null || early === null); attempt++) {
    const seed = deterministicSeed(attempt)
    const result = run(seed)
    if (result.early) early = result
    else normal = result
  }
  assert.ok(normal, 'expected a normal 60-minute travel branch')
  assert.ok(early, 'expected an early travel branch')
  assert.equal(normal.souvenirDelta, 0)
  assert.equal(early.souvenirDelta, 1)
  assert.equal(normal.album.length, 1)
  assert.equal(early.album.length, 1)
  assert.ok(Object.keys(normal.mails).length > 0)
  assert.ok(Object.keys(early.mails).length > 0)
  assert.equal(normal.jobStatus, 'completed')
  assert.equal(early.jobStatus, 'completed')
})


test('sweetheart passive self-care consumes owned goods and records canonical task effects', () => {
  const state = baseState()
  state.save.petInfo.sweetHeart = true
  state.save.petInfo.sweetHeartOverTime = Math.floor(GAME_TIME_MS / 1000) + 7 * 86400
  state.save.petInfo.hunger = 200
  state.save.petInfo.clean = 1000
  state.save.petInfo.mood = 1000
  state.save.selfGoodDatas.food = ['_10013006*5']
  const ticked = advanceMinutes(state, context(state, { sessionActive: false, activeClientCount: 0 }), 8)
  assert.equal(ticked.ok, true, JSON.stringify(ticked.ok ? ticked.result : ticked.error))
  assert.equal(ticked.state.save.selfGoodDatas.food.find(entry => entry.startsWith('_10013006*')), '_10013006*2')
  assert.equal(blob(ticked.state, 'task').doNums.Eat, 3)
  assert.ok(ticked.state.save.petInfo.hunger > 600)
  const careEvents = ticked.events.filter(event => event.type === 'item.consumed' && event.payload.source === 'sweetheart' && event.payload.type === 'food')
  assert.equal(careEvents.length, 3)
  assert.ok(ticked.events.some(event => event.type === 'item.consumed' && event.payload.source === 'sweetheart' && event.payload.type === 'clean'))
  assert.equal(ticked.events.filter(event => event.type === 'task.progress' && event.payload.counter === 'Eat').length, 3)
})



test('due travel jobs are authoritative even with missing or stale activity projection', () => {
  const state = baseState()
  const destination = TRAVEL_PROVINCES[0].name
  state.save.activeOption.trip = 'stale-destination'
  state.save.saveJsonData.activity = '42'
  state.scheduledJobs = [{
    id: 1,
    type: 'travel',
    dueAtGameMs: state.gameTimeMs + 60000,
    payload: {
      activityKind: 'travel',
      activityId: destination,
      startedAtGameMs: state.gameTimeMs - 59 * 60000,
      early: 0,
      plannedMinutes: 60,
    },
    status: 'pending',
  }]
  state.nextScheduledJobId = 2
  const beforeInventory = travelInventoryTotal(state.save)
  const ticked = advanceMinute(state, context(state, { sessionActive: false, activeClientCount: 0 }))
  assert.equal(ticked.ok, true, JSON.stringify(ticked.ok ? ticked.result : ticked.error))
  assert.equal(ticked.state.scheduledJobs[0].status, 'completed')
  assert.equal(ticked.state.save.activeOption.trip, null)
  assert.equal(ticked.state.save.gameSaveDatas.travel_china.some(entry => entry.name === destination), true)
  assert.equal(blob(ticked.state, 'album').length, 1)
  assert.equal(Object.values(blob(ticked.state, 'email')).some(mail => typeof mail.p === 'string'), true)
  assert.equal(travelInventoryTotal(ticked.state.save), beforeInventory)
  assert.equal(blob(ticked.state, 'activity'), 0)

  const missing = clone(state)
  missing.save.activeOption.trip = null
  delete missing.save.saveJsonData.activity
  const missingTick = advanceMinute(missing, context(missing, { sessionActive: false, activeClientCount: 0 }))
  assert.equal(missingTick.ok, true, JSON.stringify(missingTick.ok ? missingTick.result : missingTick.error))
  assert.equal(missingTick.state.save.gameSaveDatas.travel_china.some(entry => entry.name === destination), true)

  const cancelled = clone(state)
  cancelled.scheduledJobs[0].status = 'cancelled'
  const cancelledTick = advanceMinute(cancelled, context(cancelled, { sessionActive: false, activeClientCount: 0 }))
  assert.equal(cancelledTick.ok, true, JSON.stringify(cancelledTick.ok ? cancelledTick.result : cancelledTick.error))
  assert.equal(cancelledTick.state.save.gameSaveDatas.travel_china.length, 0)
  assert.equal(cancelledTick.state.save.activeOption.trip, null)
  assert.equal(blob(cancelledTick.state, 'activity'), 0)
})

test('first daily reset and reset/adopt cycles keep travel tasks claimable', () => {
  const first = baseState()
  const resetTasks = resetDailyTasks(first.save, GAME_TIME_MS, 'Asia/Shanghai', createRuntimeRng(createRngState(SEED)))
  assert.equal(resetTasks.next.taskList.travel.slice(2).every(entry => entry.take === false), true)
  assert.equal(resetTasks.next.taskList.ddw.every(entry => entry.take === false), true)
  assert.equal(resetTasks.next.taskList.growth.every(entry => entry.take === false), true)

  const reset = ok(baseState(), 'pet.reset', {}, { actorRole: 'owner' })
  const afterReset = resetDailyTasks(reset.state.save, GAME_TIME_MS, 'Asia/Shanghai', createRuntimeRng(createRngState(SEED)))
  assert.equal(afterReset.next.taskList.travel.slice(2).every(entry => entry.take === false), true)

  const adopted = ok(reset.state, 'pet.adopt', { sex: 'GG' }, { actorRole: 'owner' })
  adopted.state.gameTimeMs = NEXT_BOUNDARY_MS - 60000
  adopted.state.nextDailyBoundaryMs = NEXT_BOUNDARY_MS
  adopted.state.lastProcessedDayBoundaryKey = DAY_KEY
  const boundary = advanceMinute(adopted.state, context(adopted.state, { sessionActive: false, activeClientCount: 0 }))
  assert.equal(boundary.ok, true, JSON.stringify(boundary.ok ? boundary.result : boundary.error))
  const travelTasks = blob(boundary.state, 'task').taskList.travel
  assert.equal(travelTasks.length, 9)
  assert.equal(travelTasks.slice(2).every(entry => entry.take === false), true)
})

test('runtime need and availability predicates match renderer semantics exactly', () => {
  const renderer = readRendererTaskTables()
  assert.equal(renderer.kinds.length, DAILY_TASK_TEMPLATES.length)
  const compile = source => new Function('info', 'save', 'off', 'return (' + source + ')(off)')
  const canScenarios = []
  const base = baseState()
  for (const level of [1, 2, 3]) {
    for (const yb of [0, 5000]) {
      for (const mood of [0, 1000]) {
        for (const hunger of [0, 1800]) {
          const save = clone(base.save)
          save.petComputedlInfo.level = level
          save.petInfo.yb = yb
          save.petInfo.mood = mood
          save.petInfo.hunger = hunger
          save.petInfo.clean = hunger
          save.petInfo.charm = hunger ? 0 : 1000
          save.petInfo.intel = hunger ? 0 : 1000
          save.petInfo.strong = hunger ? 0 : 1000
          canScenarios.push(save)
        }
      }
    }
  }
  DAILY_TASK_TEMPLATES.forEach((template, index) => {
    const source = renderer.kinds[index]
    assert.equal(source.obj, template.obj)
    assert.equal(source.canSource === null, template.hasCan === false)
    if (source.canSource !== null) {
      assert.equal(source.canSource, '() => save.petComputedlInfo.level >= 2', 'unsupported renderer can predicate')
      const rendererCan = compile(source.canSource)
      for (const save of canScenarios) {
        const expected = rendererCan(save.petInfo, save, false)
        const actual = dailyTaskCandidates(save).some(candidate => candidate.obj === template.obj)
        assert.equal(actual, expected, template.obj + ' can predicate')
      }
    }
  })

  const needsScenarios = []
  for (const cap of [1100, 1800]) {
    const hungerValues = [0, cap / 2 - 1, cap / 2, cap / 2 + 1, cap]
    const cleanValues = [0, cap / 2 - 1, cap / 2, cap / 2 + 1, cap]
    const moodValues = [0, 499, 500, 501, 1000]
    const ybValues = [0, 499, 500, 501, 5000]
    for (const off of [false, true]) {
      for (const hunger of hungerValues) {
        for (const clean of cleanValues) {
          for (const mood of moodValues) {
            for (const yb of ybValues) {
              const save = clone(base.save)
              save.petComputedlInfo.hungerMax = cap
              save.petComputedlInfo.cleanMax = cap
              save.petComputedlInfo.moodMax = 1000
              save.petInfo.hunger = hunger
              save.petInfo.clean = clean
              save.petInfo.mood = mood
              save.petInfo.yb = yb
              needsScenarios.push({ save, off })
            }
          }
        }
      }
    }
  }
  DAILY_TASK_TEMPLATES.forEach((template, index) => {
    const source = renderer.kinds[index]
    const rendererNeed = compile(source.needsSource)
    for (const scenario of needsScenarios) {
      const expected = rendererNeed(scenario.save.petInfo, scenario.save, scenario.off)
      const actual = dailyTaskNeeded(template, scenario.save, scenario.off)
      assert.equal(actual, expected, template.obj + ' need predicate mismatch off=' + scenario.off)
    }
  })
})


test('canonical loot uses floor randomIndex rather than rounded integer selection', () => {
  const calls = []
  const fakeRng = {
    randomUnit: () => 0.999,
    randomIndex(count) {
      calls.push(count)
      return count - 1
    },
    randIntInclusive() {
      throw new Error('loot must not use rounded selection')
    },
  }
  const goods = lootGoods(fakeRng, 2, 0)
  assert.equal(goods.length, 2)
  assert.deepEqual(calls, [LOOT_POOLS[0].length, LOOT_POOLS[0].length])
  const last = parseGoodCode(LOOT_POOLS[0][LOOT_POOLS[0].length - 1])
  assert.equal(goods[0].id, last.id)
  assert.equal(goods[1].id, last.id)
})

test('sweetheart self-care uses recomputed caps on a level-up tick', () => {
  const state = baseState()
  state.save.petInfo.growth = 5899.5
  state.save.petComputedlInfo = { ...levelAndCapsOf(5000), healthMax: 5, moodMax: 1000 }
  state.save.petInfo.sweetHeart = true
  state.save.petInfo.sweetHeartOverTime = Math.floor(GAME_TIME_MS / 1000) + 7 * 86400
  state.save.petInfo.hunger = 1100
  state.save.petInfo.clean = 1000
  state.save.petInfo.mood = 1000
  state.save.selfGoodDatas.food = ['_10013006*5']
  const ticked = advanceMinute(state, context(state, { sessionActive: false, activeClientCount: 0 }))
  assert.equal(ticked.ok, true, JSON.stringify(ticked.ok ? ticked.result : ticked.error))
  assert.equal(ticked.state.save.petComputedlInfo.level, 9)
  assert.equal(ticked.state.save.petComputedlInfo.hungerMax, 1900)
  assert.equal(ticked.state.save.selfGoodDatas.food.find(entry => entry.startsWith('_10013006*')), '_10013006*4')
  assert.equal(blob(ticked.state, 'task').doNums.Eat, 1)
  assert.ok(ticked.state.save.petInfo.hunger > 1100)
})

test('fresh static task rewards replay renderer load-then-reset RNG order', () => {
  function rewardFor(template, rng) {
    const random = template.reroll ? lootGoods(rng, template.reroll) : []
    const fixed = (template.good ?? []).map(code => parseGoodCode(code)).filter(good => good !== null)
    return [...random, ...fixed]
  }
  function expectedStatic(seed) {
    const rng = createRuntimeRng(createRngState(seed))
    const tabs = ['ddw', 'growth', 'travel']
    const loaded = {}
    for (const tab of tabs) {
      loaded[tab] = STATIC_TASKS[tab].map(template => ({ take: false, good: rewardFor(template, rng) }))
    }
    const reset = {}
    for (const tab of tabs) {
      reset[tab] = STATIC_TASKS[tab].map((template, index) => ({
        take: template.keep === true ? loaded[tab][index].take : false,
        good: template.reroll ? rewardFor(template, rng) : loaded[tab][index].good,
      }))
    }
    return reset
  }
  function assertPath(start) {
    const expected = expectedStatic(SEED)
    const actual = resetDailyTasks(start.save, GAME_TIME_MS, 'Asia/Shanghai', createRuntimeRng(createRngState(SEED)))
    assert.deepEqual(actual.next.taskList.ddw, expected.ddw)
    assert.deepEqual(actual.next.taskList.growth, expected.growth)
    assert.deepEqual(actual.next.taskList.travel, expected.travel)
  }
  // Reset over tables that are already materialized (adoption fills them now):
  // fixed goods are kept, only reroll entries draw, in tab order on a fresh stream.
  function expectedMaterializedReset(seed) {
    const rng = createRuntimeRng(createRngState(seed))
    const reset = {}
    for (const tab of ['ddw', 'growth', 'travel']) {
      reset[tab] = STATIC_TASKS[tab].map(template => ({
        take: false,
        good: template.reroll
          ? rewardFor(template, rng)
          : (template.good ?? []).map(code => parseGoodCode(code)).filter(good => good !== null),
      }))
    }
    return reset
  }
  assertPath(baseState())
  assertPath(ok(baseState(), 'pet.reset', {}, { actorRole: 'owner' }).state)
  const adopted = ok(ok(baseState(), 'pet.reset', {}, { actorRole: 'owner' }).state, 'pet.adopt', { sex: 'GG' }, { actorRole: 'owner' }).state
  assert.equal(blob(adopted, 'task').taskList.ddw.length, STATIC_TASKS.ddw.length)
  const materialized = expectedMaterializedReset(SEED)
  const actual = resetDailyTasks(adopted.save, GAME_TIME_MS, 'Asia/Shanghai', createRuntimeRng(createRngState(SEED)))
  assert.deepEqual(actual.next.taskList.ddw, materialized.ddw)
  assert.deepEqual(actual.next.taskList.growth, materialized.growth)
  assert.deepEqual(actual.next.taskList.travel, materialized.travel)
})

test('paused travel projection freezes active minutes and early rolls use current state', () => {
  const base = baseState()
  const drawsBeforeStart = base.rng.draws
  const started = ok(base, 'job.startTravel')
  assert.equal(started.state.rng.draws, drawsBeforeStart + 1)
  const job = started.state.scheduledJobs[0]
  const dueAt = job.dueAtGameMs
  const startedAt = job.payload.startedAtGameMs
  const drawsBeforePause = started.state.rng.draws

  const paused = clone(started.state)
  paused.save.settings.paused = true
  const pausedTicks = advanceMinutes(paused, context(paused, { sessionActive: false, activeClientCount: 0 }), 10)
  assert.equal(pausedTicks.ok, true, JSON.stringify(pausedTicks.ok ? pausedTicks.result : pausedTicks.error))
  const pausedJob = pausedTicks.state.scheduledJobs[0]
  assert.equal(pausedTicks.state.rng.draws, drawsBeforePause)
  assert.equal(pausedJob.dueAtGameMs, dueAt + 10 * 60000)
  assert.equal(pausedJob.payload.startedAtGameMs, startedAt + 10 * 60000)
  assert.equal(blob(pausedTicks.state, 'activity'), 0)

  pausedTicks.state.save.settings.paused = false
  const resumed = advanceMinute(pausedTicks.state, context(pausedTicks.state, { sessionActive: false, activeClientCount: 0 }))
  assert.equal(resumed.ok, true, JSON.stringify(resumed.ok ? resumed.result : resumed.error))
  assert.equal(blob(resumed.state, 'activity'), 1)
  assert.equal(resumed.state.scheduledJobs[0].status, 'pending')

  function thresholdFor(save) {
    let captured = null
    const fakeRng = {
      randIntInclusive(min, max) {
        captured = { min, max }
        return 11
      },
    }
    const early = travelEarlyRoll(save, fakeRng)
    return { captured, early }
  }
  const low = thresholdFor(clone(base.save))
  const luckySave = clone(base.save)
  luckySave.petInfo.pinkDiamond = true
  luckySave.petInfo.PDiamondLevel = 7
  luckySave.petInfo.sweetHeart = true
  luckySave.petInfo.charm = 60000
  luckySave.petInfo.intel = 90000
  const lucky = thresholdFor(luckySave)
  assert.equal(low.captured.min, 0)
  assert.equal(low.captured.max, 990)
  assert.equal(lucky.captured.max < low.captured.max, true)
  assert.equal(low.early, false)
  assert.equal(lucky.early, false)
})


test('rounded renderer draws remain rounded outside lootGoods item selection', () => {
  function recordingRng(roundedValue = 0) {
    const calls = []
    return {
      calls,
      randIntInclusive(min, max) {
        calls.push(['rand', min, max])
        return roundedValue
      },
      randomIndex(count) {
        calls.push(['index', count])
        return 0
      },
      randomUnit() {
        calls.push(['unit'])
        return 0.99
      },
      chance(probability) {
        calls.push(['chance', probability])
        return false
      },
    }
  }

  const online = baseState()
  online.save.saveJsonData.signin = JSON.stringify({
    collectionList: {}, getGrowth: null, onlineGiftNum: 0, isOnlineLastTime: 0, getBirthDayGift: true,
  })
  const onlineRng = recordingRng(2)
  const onlineResult = claimOnlineGift({ state: online, ctx: context(online), rng: onlineRng })
  assert.deepEqual(onlineRng.calls[0], ['rand', 0, 10_000])
  assert.equal(onlineRng.calls.some(call => call[0] === 'index'), true)
  assert.ok(onlineResult.events.length > 0)

  const birthday = baseState()
  birthday.save.saveJsonData.signin = JSON.stringify({
    collectionList: {}, getGrowth: null, onlineGiftNum: 0, isOnlineLastTime: 20, getBirthDayGift: false,
  })
  const birthdayRng = recordingRng(0)
  const birthdayResult = claimBirthdayGift({ state: birthday, ctx: context(birthday), rng: birthdayRng })
  assert.deepEqual(birthdayRng.calls, [['rand', 0, BIRTHDAY_FOOD_IDS.length - 1]])
  assert.ok(birthdayResult.events.length > 0)

  const photo = baseState()
  photo.save.saveJsonData.album = '[]'
  const photoRng = recordingRng(0)
  const shot = takeTravelPhoto(photo.save, TRAVEL_PROVINCES[0].name, GAME_TIME_MS, photoRng)
  assert.ok(shot)
  assert.equal(photoRng.calls[0][0], 'chance')
  const roundedPhotoCall = photoRng.calls.find(call => call[0] === 'rand')
  assert.ok(roundedPhotoCall)
  assert.equal(roundedPhotoCall[1], 0)
  assert.equal(photoRng.calls.some(call => call[0] === 'index'), false)

  const travel = baseState()
  const travelRng = recordingRng(0)
  startTravel({ state: travel, ctx: context(travel), rng: travelRng })
  assert.deepEqual(travelRng.calls[0], ['rand', 0, TRAVEL_PROVINCES.length - 1])

  const mail = baseState()
  const mailRng = recordingRng(0)
  const mailGift = mailGoods(mail.save, 100, mailRng)
  assert.equal(mailGift.length, 6)
  assert.equal(mailRng.calls.every(call => call[0] === 'rand'), true)
})

test('mixed due travel/study jobs process in dueAt then jobId order without passive fallback', () => {
  const state = baseState()
  const destination = TRAVEL_PROVINCES[0].name
  const dueAt = state.gameTimeMs + 60000
  state.save.activeOption.trip = 'stale-travel'
  state.save.activeOption.study = 'stale-study'
  state.scheduledJobs = [
    {
      id: 1,
      type: 'travel',
      dueAtGameMs: dueAt,
      payload: { activityKind: 'travel', activityId: destination, startedAtGameMs: dueAt - 60 * 60000, plannedMinutes: 60 },
      status: 'pending',
    },
    {
      id: 2,
      type: 'study',
      dueAtGameMs: dueAt,
      payload: { activityKind: 'study', activityId: 'xx-chinese', startedAtGameMs: dueAt - 45 * 60000, early: 0 },
      status: 'pending',
    },
  ]
  state.nextScheduledJobId = 3
  const ticked = advanceMinute(state, context(state, { sessionActive: false, activeClientCount: 0 }))
  assert.equal(ticked.ok, true, JSON.stringify(ticked.ok ? ticked.result : ticked.error))
  assert.equal(ticked.state.scheduledJobs[0].status, 'completed')
  assert.equal(ticked.state.scheduledJobs[1].status, 'completed')
  assert.equal(ticked.state.save.studyInfo.chinese, 1)
  assert.equal(ticked.state.save.gameSaveDatas.travel_china.filter(entry => entry.name === destination).length, 1)
  assert.equal(blob(ticked.state, 'album').length, 1)
  assert.equal(Object.values(blob(ticked.state, 'email')).filter(mail => typeof mail.p === 'string').length, 1)
  const completions = ticked.events.filter(event => event.type === 'activity.completed')
  const travelCompletion = completions.findIndex(event => event.payload.kind === 'travel')
  const studyCompletion = completions.findIndex(event => event.payload.kind === 'study')
  assert.equal(travelCompletion >= 0, true)
  assert.equal(studyCompletion >= 0, true)
  assert.equal(travelCompletion < studyCompletion, true)
  assert.equal(completions.filter(event => event.payload.kind === 'travel').length, 1)
  assert.equal(ticked.state.save.activeOption.trip, null)
  assert.equal(ticked.state.save.activeOption.study, null)
  assert.equal(blob(ticked.state, 'activity'), 0)
})

test('overdue travel completes once in the scheduled-job phase and never rewards twice', () => {
  const state = baseState()
  const destination = TRAVEL_PROVINCES[0].name
  const dueAt = state.gameTimeMs - 10 * 60000
  state.save.activeOption.trip = 'stale-projection'
  state.save.saveJsonData.activity = '123'
  state.scheduledJobs = [{
    id: 1,
    type: 'travel',
    dueAtGameMs: dueAt,
    payload: { activityKind: 'travel', activityId: destination, startedAtGameMs: dueAt - 60 * 60000, plannedMinutes: 60 },
    status: 'pending',
  }]
  state.nextScheduledJobId = 2
  const ticked = advanceMinute(state, context(state, { sessionActive: false, activeClientCount: 0 }))
  assert.equal(ticked.ok, true, JSON.stringify(ticked.ok ? ticked.result : ticked.error))
  assert.equal(ticked.state.scheduledJobs[0].status, 'completed')
  assert.equal(ticked.events.filter(event => event.type === 'activity.completed' && event.payload.kind === 'travel').length, 1)
  assert.equal(ticked.state.save.gameSaveDatas.travel_china.length, 1)
  assert.equal(blob(ticked.state, 'album').length, 1)
  assert.equal(Object.values(blob(ticked.state, 'email')).filter(mail => typeof mail.p === 'string').length, 1)

  const nextTick = advanceMinute(ticked.state, context(ticked.state, { sessionActive: false, activeClientCount: 0 }))
  assert.equal(nextTick.ok, true, JSON.stringify(nextTick.ok ? nextTick.result : nextTick.error))
  assert.equal(nextTick.events.filter(event => event.type === 'activity.completed' && event.payload.kind === 'travel').length, 0)
  assert.equal(nextTick.state.save.gameSaveDatas.travel_china.length, 1)
  assert.equal(blob(nextTick.state, 'album').length, 1)
  assert.equal(Object.values(blob(nextTick.state, 'email')).filter(mail => typeof mail.p === 'string').length, 1)
})

test('group C: an untouched save materializes today\'s daily tasks on the first tick', () => {
  const fresh = baseState()
  assert.deepEqual(blob(fresh, 'task'), {})
  const boundary = currentBoundarySeconds(GAME_TIME_MS, 'Asia/Shanghai')
  const ticked = advanceMinute(fresh, context(fresh, { sessionActive: false, activeClientCount: 0 }))
  assert.equal(ticked.ok, true, JSON.stringify(ticked.ok ? ticked.result : ticked.error))
  const task = blob(ticked.state, 'task')
  assert.equal(task.dailyDay, boundary)
  assert.equal(task.daily.length, 4)
  assert.equal(task.taskList.daily.length, task.daily.length)

  // Materializing today's tasks must not touch the counters that feed the claims.
  const doNums = { Eat: 99, Clean: 99, Toy: 99, Amusing: 99, Work: 99, Study: 99, GameRound: 99, Game: 99, Travel1: 99 }
  ticked.state.save.saveJsonData.task = JSON.stringify({ ...task, doNums })
  const claimed = ok(ticked.state, 'task.claim', { tab: 'daily', index: 0 })
  assert.equal(claimed.result.goods.length, 2)
  assert.equal(blob(claimed.state, 'task').taskList.daily[0].take, true)

  // C15: definitions present but entries truncated is the same gap on a partial blob.
  const partial = baseState()
  partial.save.saveJsonData.task = JSON.stringify({ ...task, doNums, taskList: { ...task.taskList, daily: [] } })
  const repaired = ok(partial, 'task.claim', { tab: 'daily', index: 0 })
  const repairedTask = blob(repaired.state, 'task')
  assert.equal(repairedTask.daily.length, 4)
  assert.equal(repairedTask.taskList.daily.length, 4)
  assert.equal(repairedTask.taskList.daily[0].take, true)
})

test('group C: a newly adopted pet gets today\'s daily tasks immediately', () => {
  const reset = ok(baseState(), 'pet.reset', {}, { actorRole: 'owner' })
  const adopted = ok(reset.state, 'pet.adopt', { sex: 'MM' }, { actorRole: 'owner' })
  const task = blob(adopted.state, 'task')
  assert.equal(task.dailyDay, currentBoundarySeconds(adopted.state.gameTimeMs, adopted.state.timeZone))
  assert.equal(task.daily.length, 4)
  assert.equal(task.taskList.daily.length, 4)
  assert.equal(task.daily.every(definition => definition.reroll === 1), true)
})

test('group C: crossing 06:00 rolls today\'s tasks exactly once', async () => {
  const state = baseState()
  const dayTick = advanceMinute(state, context(state, { sessionActive: false, activeClientCount: 0 }))
  assert.equal(dayTick.ok, true, JSON.stringify(dayTick.ok ? dayTick.result : dayTick.error))
  const beforeBoundary = blob(dayTick.state, 'task')
  assert.equal(beforeBoundary.daily.length, 4)
  dayTick.state.save.saveJsonData.task = JSON.stringify({ ...beforeBoundary, doNums: { Amusing: 7 } })
  dayTick.state.gameTimeMs = NEXT_BOUNDARY_MS - 60000
  dayTick.state.nextDailyBoundaryMs = NEXT_BOUNDARY_MS
  dayTick.state.lastProcessedDayBoundaryKey = DAY_KEY

  const crossed = advanceMinute(dayTick.state, context(dayTick.state, { sessionActive: false, activeClientCount: 0 }))
  assert.equal(crossed.ok, true, JSON.stringify(crossed.ok ? crossed.result : crossed.error))
  const task = blob(crossed.state, 'task')
  assert.equal(task.dailyDay, NEXT_BOUNDARY_MS / 1000)
  assert.equal(task.daily.length, 4)
  assert.equal(task.taskList.daily.length, 4)
  assert.deepEqual(task.doNums, {})
  assert.equal(crossed.events.filter(event => event.type === 'task.progress' && event.payload.dailyReset === true).length, 1)

  // The on-demand fill must be a no-op once the boundary just rolled: no second roll, no draws.
  const { ensureTaskTables } = await import('../../src/shared/pet-runtime/runtime-tasks.ts')
  const probe = createRuntimeRng(crossed.state.rng)
  ensureTaskTables(crossed.state.save, crossed.state.gameTimeMs, crossed.state.timeZone, probe)
  assert.equal(probe.state.draws, crossed.state.rng.draws)
  const nextMinute = advanceMinute(crossed.state, context(crossed.state, { sessionActive: false, activeClientCount: 0 }))
  const nextTask = blob(nextMinute.state, 'task')
  assert.deepEqual(nextTask.daily, task.daily)
  assert.equal(nextTask.dailyDay, task.dailyDay)
})

test('growth-changing commands emit the same level cue as passive ticks', () => {
  const state = baseState()
  const outcome = ok(state, 'admin.grantCheat', { stat: 'growth', amount: 40000 }, { actorRole: 'owner' })
  const levels = outcome.events.filter(event => event.type === 'pet.levelChanged')
  assert.equal(levels.length, 1, 'one command batch must emit one level cue')
  assert.ok(levels[0].payload.level > levels[0].payload.previousLevel)
  assert.equal(outcome.state.save.petComputedlInfo.level, levels[0].payload.level)
})
