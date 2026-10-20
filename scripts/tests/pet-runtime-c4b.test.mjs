import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
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
  advanceSchedulerChunk,
  executeCommand,
  createRngState,
  levelAndCapsOf,
  serializeRuntimeState,
  deserializeRuntimeState,
  stableStringify,
  RUNTIME_SCHEMA_VERSION,
  dayKeyAt,
  reconcileTimeZone,
  C3_COMMAND_TYPES,
  C4A_COMMAND_TYPES,
  C4B_COMMAND_TYPES,
} = await import('../../src/shared/pet-runtime/index.ts')
const { COMMAND_TYPES } = await import('../../src/shared/sync/command-validation.ts')
const { validateEngineState } = await import('../../src/shared/sync/portable.ts')
const {
  DAY_KEY, GAME_TIME_MS, LOCAL_DEVICE_ID, NEXT_BOUNDARY_MS, SEED, WALL_TIME_MS, createSyncFixtures,
} = await import('./sync-fixtures.mjs')

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

function blob(state, key) {
  return JSON.parse(state.save.saveJsonData[key])
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


test('scheduler catch-up is bounded and persists wall/game anchors per chunk', () => {
  const state = baseState()
  state.lastSchedulerWallMs = WALL_TIME_MS
  state.gameTimeMs = GAME_TIME_MS
  state.advanceWhileEmpty = true
  state.sessionCoverage = []
  const target = WALL_TIME_MS + 2 * 60000
  const first = advanceSchedulerChunk(state, context(state), target, { maxChunkTicks: 1, liveActiveClientCount: 0 })
  assert.equal(first.ticks, 1)
  assert.equal(first.catchingUp, true)
  assert.equal(first.state.gameTimeMs, GAME_TIME_MS + 60000)
  assert.equal(first.state.lastSchedulerWallMs, WALL_TIME_MS + 60000)
  assert.equal(first.state.save.petInfo.onLineTime, 0)
  const second = advanceSchedulerChunk(first.state, context(first.state), target, { maxChunkTicks: 1, liveActiveClientCount: 0 })
  assert.equal(second.ticks, 1)
  assert.equal(second.catchingUp, false)
  assert.equal(second.state.gameTimeMs, GAME_TIME_MS + 120000)
  assert.equal(second.state.lastSchedulerWallMs, target)
  assert.equal(second.state.save.petInfo.onLineTime, 0)
})

test('coverage derives session clock only from actual overlaps, including mid-catch-up connects', () => {
  const state = baseState()
  state.lastSchedulerWallMs = WALL_TIME_MS
  state.gameTimeMs = GAME_TIME_MS
  state.advanceWhileEmpty = true
  state.sessionCoverage = [{
    coverageId: 'late', deviceId: LOCAL_DEVICE_ID,
    connectedAtWallMs: WALL_TIME_MS + 60000,
    lastHeartbeatWallMs: WALL_TIME_MS + 120000,
  }]
  const target = WALL_TIME_MS + 2 * 60000
  const result = advanceSchedulerChunk(state, context(state), target)
  assert.equal(result.ticks, 2)
  assert.equal(result.state.save.petInfo.onLineTime, 1)

  const closed = baseState()
  closed.lastSchedulerWallMs = WALL_TIME_MS
  closed.gameTimeMs = GAME_TIME_MS
  closed.advanceWhileEmpty = true
  closed.sessionCoverage = [{
    coverageId: 'closed', deviceId: LOCAL_DEVICE_ID,
    connectedAtWallMs: WALL_TIME_MS - 60000,
    disconnectedAtWallMs: WALL_TIME_MS + 60000,
    lastHeartbeatWallMs: WALL_TIME_MS + 60000,
  }]
  const closedResult = advanceSchedulerChunk(closed, context(closed), target)
  assert.equal(closedResult.state.save.petInfo.onLineTime, 1)

  const open = baseState()
  open.lastSchedulerWallMs = WALL_TIME_MS
  open.gameTimeMs = GAME_TIME_MS
  open.advanceWhileEmpty = true
  open.sessionCoverage = [{
    coverageId: 'open', deviceId: LOCAL_DEVICE_ID,
    connectedAtWallMs: WALL_TIME_MS - 60000,
    lastHeartbeatWallMs: WALL_TIME_MS + 120000,
  }]
  const openResult = advanceSchedulerChunk(open, context(open), target)
  assert.equal(openResult.state.save.petInfo.onLineTime, 2)
})

test('advanceWhileEmpty false freezes zero-client cursors without backfill and resumes only live time', () => {
  const frozen = baseState()
  frozen.lastSchedulerWallMs = WALL_TIME_MS
  frozen.gameTimeMs = GAME_TIME_MS
  frozen.advanceWhileEmpty = false
  frozen.sessionCoverage = []
  const target = WALL_TIME_MS + 10 * 60000
  const frozenOutcome = advanceSchedulerChunk(frozen, context(frozen), target, { liveActiveClientCount: 0 })
  assert.equal(frozenOutcome.ticks, 0)
  assert.equal(frozenOutcome.frozen, true)
  assert.equal(frozenOutcome.state.gameTimeMs, GAME_TIME_MS)
  assert.equal(frozenOutcome.state.lastSchedulerWallMs, target)

  const live = baseState()
  live.lastSchedulerWallMs = WALL_TIME_MS
  live.gameTimeMs = GAME_TIME_MS
  live.advanceWhileEmpty = false
  live.sessionCoverage = [{
    coverageId: 'live', deviceId: LOCAL_DEVICE_ID,
    connectedAtWallMs: WALL_TIME_MS - 1000,
    lastHeartbeatWallMs: target,
  }]
  const liveOutcome = advanceSchedulerChunk(live, context(live), target, { liveActiveClientCount: 1 })
  assert.equal(liveOutcome.ticks, 10)
  assert.equal(liveOutcome.frozen, false)
  assert.equal(liveOutcome.state.gameTimeMs, GAME_TIME_MS + 10 * 60000)
  assert.equal(liveOutcome.state.save.petInfo.onLineTime, 10)
})

test('scheduler preserves paused deadline shifts and completes sessions in due/id order', () => {
  const paused = baseState()
  paused.lastSchedulerWallMs = WALL_TIME_MS
  paused.gameTimeMs = GAME_TIME_MS
  paused.advanceWhileEmpty = true
  paused.save.settings.paused = true
  paused.scheduledJobs = [{ id: 1, type: 'work', dueAtGameMs: GAME_TIME_MS + 60000, payload: { activityKind: 'work', activityId: 'job-1', startedAtGameMs: GAME_TIME_MS }, status: 'pending' }]
  paused.nextScheduledJobId = 2
  const pausedOutcome = advanceSchedulerChunk(paused, context(paused), WALL_TIME_MS + 60000)
  assert.equal(pausedOutcome.ticks, 1)
  assert.equal(pausedOutcome.state.scheduledJobs[0].status, 'pending')
  assert.equal(pausedOutcome.state.scheduledJobs[0].dueAtGameMs, GAME_TIME_MS + 120000)
  assert.equal(pausedOutcome.state.scheduledJobs[0].payload.startedAtGameMs, GAME_TIME_MS + 60000)

  const ordered = baseState()
  ordered.lastSchedulerWallMs = WALL_TIME_MS
  ordered.gameTimeMs = GAME_TIME_MS
  ordered.activeOption = { work: null, study: null, trip: null, ill: null, die: null }
  ordered.gameSessions = [{ ...fixtures.gameSession, sessionToken: 'session-1', status: 'active' }]
  ordered.scheduledJobs = [
    { id: 2, type: 'game-session', dueAtGameMs: GAME_TIME_MS + 60000, payload: { sessionToken: 'session-1', kind: 'game' }, status: 'pending' },
    { id: 1, type: 'game-session', dueAtGameMs: GAME_TIME_MS + 60000, payload: { sessionToken: 'session-missing', kind: 'game' }, status: 'pending' },
  ]
  ordered.nextScheduledJobId = 3
  const orderedOutcome = advanceSchedulerChunk(ordered, context(ordered), WALL_TIME_MS + 60000)
  assert.deepEqual(orderedOutcome.state.scheduledJobs.map(job => job.id), [2, 1])
  assert.equal(orderedOutcome.state.scheduledJobs.every(job => job.status === 'completed'), true)
  assert.equal(orderedOutcome.state.gameSessions[0].status, 'expired')
  assert.equal(orderedOutcome.state.gameSessions[0].cancelReason, 'deadline_expired')
})

test('daily boundaries run directly from scheduler metadata without job rows', () => {
  const state = baseState()
  state.lastSchedulerWallMs = WALL_TIME_MS
  state.gameTimeMs = NEXT_BOUNDARY_MS - 60000
  state.nextDailyBoundaryMs = NEXT_BOUNDARY_MS
  state.lastProcessedDayBoundaryKey = DAY_KEY
  state.advanceWhileEmpty = true
  state.scheduledJobs = []
  const result = advanceSchedulerChunk(state, context(state), WALL_TIME_MS + 60000)
  assert.equal(result.ticks, 1)
  assert.equal(result.state.gameTimeMs, NEXT_BOUNDARY_MS)
  assert.equal(result.state.lastProcessedDayBoundaryKey, dayKeyAt(NEXT_BOUNDARY_MS, 'Asia/Shanghai'))
  assert.equal(result.state.scheduledJobs.length, 0)
  assert.equal(blob(result.state, 'task').dailyDay, NEXT_BOUNDARY_MS / 1000)
  assert.equal(blob(result.state, 'island').day, NEXT_BOUNDARY_MS / 1000)
  const secondBoundary = advanceSchedulerChunk(result.state, context(result.state), WALL_TIME_MS + 120000)
  assert.equal(secondBoundary.state.lastProcessedDayBoundaryKey, result.state.lastProcessedDayBoundaryKey)
  assert.equal(blob(secondBoundary.state, 'task').dailyDay, NEXT_BOUNDARY_MS / 1000)
})

test('timezone changes reconcile the next boundary without replaying daily transitions', () => {
  const state = baseState()
  state.gameTimeMs = GAME_TIME_MS
  state.save.saveJsonData.signin = JSON.stringify({ collectionList: { '2026': { '10': [20] } } })
  const beforeSignin = blob(state, 'signin')
  const changed = ok(state, 'server.setTimeZone', { timeZone: 'America/New_York' }, { actorRole: 'owner' })
  assert.equal(changed.state.timeZone, 'America/New_York')
  assert.equal(changed.state.lastProcessedDayBoundaryKey, dayKeyAt(GAME_TIME_MS, 'America/New_York'))
  assert.equal(changed.state.nextDailyBoundaryMs, reconcileTimeZone(GAME_TIME_MS, 'America/New_York').nextDailyBoundaryMs)
  assert.deepEqual(blob(changed.state, 'signin'), beforeSignin)

  const westward = ok(changed.state, 'server.setTimeZone', { timeZone: 'Pacific/Honolulu' }, { actorRole: 'owner' })
  assert.equal(westward.state.lastProcessedDayBoundaryKey, dayKeyAt(GAME_TIME_MS, 'Pacific/Honolulu'))
  const eastward = ok(westward.state, 'server.setTimeZone', { timeZone: 'Pacific/Kiritimati' }, { actorRole: 'owner' })
  assert.equal(eastward.state.lastProcessedDayBoundaryKey, dayKeyAt(GAME_TIME_MS, 'Pacific/Kiritimati'))
  assert.deepEqual(blob(eastward.state, 'signin'), beforeSignin)
})

test('scheduler/restart replay preserves RNG, jobs, sessions, coverage and day metadata', () => {
  const state = baseState()
  state.lastSchedulerWallMs = WALL_TIME_MS
  state.gameTimeMs = GAME_TIME_MS
  state.advanceWhileEmpty = true
  state.sessionCoverage = [{
    coverageId: 'restart', deviceId: LOCAL_DEVICE_ID,
    connectedAtWallMs: WALL_TIME_MS, lastHeartbeatWallMs: WALL_TIME_MS + 60000,
  }]
  state.scheduledJobs = [{ id: 1, type: 'other', dueAtGameMs: GAME_TIME_MS + 60000, payload: {}, status: 'pending' }]
  state.nextScheduledJobId = 2
  state.gameSessions = [{ ...fixtures.gameSession, sessionToken: 'restart-session', status: 'active' }]
  const encoded = serializeRuntimeState(state, RUNTIME_SCHEMA_VERSION)
  const restored = deserializeRuntimeState(encoded, RUNTIME_SCHEMA_VERSION, validateEngineState)
  const a = advanceSchedulerChunk(state, context(state), WALL_TIME_MS + 120000)
  const b = advanceSchedulerChunk(restored, context(restored), WALL_TIME_MS + 120000)
  assert.equal(stableStringify(a.state), stableStringify(b.state))
  assert.deepEqual(a.events, b.events)
})

test('timezone reconciliation handles DST spring-forward and fall-back at runtime', () => {
  const spring = baseState()
  spring.gameTimeMs = Date.UTC(2026, 2, 8, 7, 0, 0)
  spring.save.saveJsonData.signin = JSON.stringify({ collectionList: { '2026': { '3': [8] } } })
  const springChanged = ok(spring, 'server.setTimeZone', { timeZone: 'America/New_York' }, { actorRole: 'owner' })
  const springExpected = reconcileTimeZone(spring.gameTimeMs, 'America/New_York')
  assert.equal(springChanged.state.lastProcessedDayBoundaryKey, springExpected.lastProcessedDayBoundaryKey)
  assert.equal(springChanged.state.nextDailyBoundaryMs, springExpected.nextDailyBoundaryMs)
  assert.deepEqual(blob(springChanged.state, 'signin'), blob(spring, 'signin'))

  const fall = baseState()
  fall.gameTimeMs = Date.UTC(2026, 10, 1, 6, 0, 0)
  fall.save.saveJsonData.signin = JSON.stringify({ collectionList: { '2026': { '11': [1] } } })
  const fallChanged = ok(fall, 'server.setTimeZone', { timeZone: 'America/New_York' }, { actorRole: 'owner' })
  const fallExpected = reconcileTimeZone(fall.gameTimeMs, 'America/New_York')
  assert.equal(fallChanged.state.lastProcessedDayBoundaryKey, fallExpected.lastProcessedDayBoundaryKey)
  assert.equal(fallChanged.state.nextDailyBoundaryMs, fallExpected.nextDailyBoundaryMs)
  assert.deepEqual(blob(fallChanged.state, 'signin'), blob(fall, 'signin'))
})


test('scheduled farm and fishing jobs tick canonical world state in due/id order', () => {
  const state = baseState()
  state.lastSchedulerWallMs = WALL_TIME_MS
  state.gameTimeMs = GAME_TIME_MS
  state.advanceWhileEmpty = true
  const now = Math.floor(GAME_TIME_MS / 1000)
  state.save.saveJsonData.farm = JSON.stringify({
    house: 'house', kennel: 'kennel', fence: 'fence', experience: '1', rank: '01', burden: [], warehouse: [],
    weather: 'Sunny', checked: now,
    farmland: Array.from({ length: 18 }, (_, index) => ({
      farmland: index < 6 ? 'FarmlandS' : 'Wasteland',
      ...(index === 0 ? { crop: 'RadishSeed', time: now - 50400, state: 0, progress: 0 } : {}),
    })),
  })
  state.save.saveJsonData.fishs = JSON.stringify({
    PD: { allvipcnt: 0, canusecnt: 0 },
    fishs: [{
      id: 10, fryid: 2, name: '金鱼', stage: 1, time: 0, interval: 7200, costyb: 2, YB: 2,
      quantity: 5, basequantity: 5, avatar: 2, AIXIN: 0, growth: 0, strong: 0, iq: 0, charm: 0,
      born: now - 7200, siLiao: 0,
    }],
  })
  state.scheduledJobs = [
    { id: 1, type: 'farm', dueAtGameMs: GAME_TIME_MS + 60000, payload: {}, status: 'pending' },
    { id: 2, type: 'fishing', dueAtGameMs: GAME_TIME_MS + 60000, payload: {}, status: 'pending' },
  ]
  state.nextScheduledJobId = 3
  const result = advanceSchedulerChunk(state, context(state), WALL_TIME_MS + 60000)
  assert.equal(result.ticks, 1)
  assert.equal(result.state.scheduledJobs.every(job => job.status === 'completed'), true)
  assert.equal(blob(result.state, 'farm').farmland[0].state, 5)
  assert.equal(blob(result.state, 'fishs').fishs[0].stage, 2)
  assert.equal(result.events.filter(event => event.type === 'farm.changed' && event.payload.action === 'tick').length, 1)
  assert.equal(result.events.filter(event => event.type === 'fishing.changed' && event.payload.action === 'tick').length, 1)
})


test('full renderer mutation gate classifies every canonical mutation/site to runtime groups', () => {
  const runtimeCommands = new Set([...C3_COMMAND_TYPES, ...C4A_COMMAND_TYPES, ...C4B_COMMAND_TYPES])
  const mapping = {
    'src/renderer/pet/activity.ts': ['job.startWork', 'job.startStudy', 'job.startTravel', 'activity.stop'],
    'src/renderer/pet/album.ts': ['job.startTravel'],
    'src/renderer/pet/fishing.ts': C4A_COMMAND_TYPES.filter(command => command.startsWith('fishing.')),
    'src/renderer/pet/goods.ts': ['inventory.buy', 'inventory.use', 'medical.treat'],
    'src/renderer/pet/items.ts': ['inventory.buy', 'inventory.use', 'medical.treat'],
    'src/renderer/pet/jobs.ts': ['job.startWork', 'job.startStudy', 'job.startTravel', 'activity.stop', 'travel.completeCollection'],
    'src/renderer/pet/mail.ts': ['mail.claim', 'mail.claimAll', 'mail.delete', 'mail.deleteAll'],
    'src/renderer/pet/pet.ts': ['pet.adopt', 'pet.reset', 'pet.bury', 'pet.rename', 'pet.setPaused', 'pet.pokeFace', 'pet.cheer'],
    'src/renderer/pet/signin.ts': ['signin.sign', 'signin.drawGrowth', 'signin.claimOnlineGift', 'signin.claimBirthdayGift'],
    'src/renderer/pet/store.ts': ['pet.setPaused', 'vip.buyPinkDiamond', 'vip.buySweetheart', 'vip.setSweetheart'],
    'src/renderer/pet/tasks.ts': ['task.claim'],
    'src/renderer/pet/vip.ts': ['vip.buyPinkDiamond', 'vip.clearPinkDiamond', 'vip.buySweetheart', 'vip.setSweetheart'],
    'src/renderer/pet/weather.ts': ['server.setWeatherCity'],
    'src/renderer/ui/adopt.ts': ['pet.adopt'],
    'src/renderer/ui/chat.ts': ['admin.grantCheat'],
    'src/renderer/ui/diudiule.ts': ['diudiule.startSession', 'diudiule.reward'],
    'src/renderer/ui/email.ts': ['mail.claim', 'mail.claimAll', 'mail.delete', 'mail.deleteAll'],
    'src/renderer/ui/face.ts': ['pet.pokeFace', 'pet.cheer'],
    'src/renderer/ui/farm.ts': C4A_COMMAND_TYPES.filter(command => command.startsWith('farm.')),
    'src/renderer/ui/fishing.ts': C4A_COMMAND_TYPES.filter(command => command.startsWith('fishing.')),
    'src/renderer/ui/games.ts': ['game.startSession', 'game.reward', 'game.abandonSession'],
    'src/renderer/ui/island.ts': C4A_COMMAND_TYPES.filter(command => command.startsWith('island.')),
    'src/renderer/ui/petinfo.ts': ['pet.adopt', 'pet.reset', 'pet.bury', 'pet.rename', 'pet.setPaused', 'pet.pokeFace', 'pet.cheer'],
    'src/renderer/ui/setup.ts': ['settings.setShared', 'server.setWeatherCity', 'admin.grantCheat', 'admin.grantRandomGoods'],
    'src/renderer/ui/smallgame.ts': ['game.startSession', 'game.reward', 'game.abandonSession'],
    'src/renderer/ui/state.ts': ['vip.setSweetheart'],
    'src/renderer/ui/travel.ts': ['travel.completeCollection'],
    'src/renderer/ui/visit.ts': ['social.completeLanVisit'],
  }
  const presentationOnly = {
    'src/renderer/main.ts': 'window placement and local settings only',
    'src/renderer/swf/sol.ts': 'local SharedObject scratch storage only',
    'src/renderer/ui/community.ts': 'local community point/presentation blob and saveSpot',
    'src/renderer/ui/menu.ts': 'local tray/menu settings only',
    'src/renderer/ui/update.ts': 'local update-check timestamp only',
    'src/renderer/ui/float.ts': 'visual float/presentation only',
    'src/renderer/ui/talk.ts': 'voice/presentation only',
    'src/renderer/swf/player.ts': 'SWF player presentation wrapper only',
  }
  const sharedRuntimeCommands = {
    'src/shared/pet-runtime/farm-runtime.ts': C4A_COMMAND_TYPES.filter(command => command.startsWith('farm.')),
    'src/shared/pet-runtime/fishing-runtime.ts': C4A_COMMAND_TYPES.filter(command => command.startsWith('fishing.')),
    'src/shared/pet-runtime/handlers-b.ts': C3_COMMAND_TYPES.filter(command => command.startsWith('inventory.') || command.startsWith('medical.') || command.startsWith('vip.') || command === 'travel.completeCollection'),
    'src/shared/pet-runtime/handlers-d.ts': C3_COMMAND_TYPES.filter(command => command.startsWith('signin.') || command.startsWith('mail.')),
    'src/shared/pet-runtime/handlers-server.ts': C4B_COMMAND_TYPES,
    'src/shared/pet-runtime/island-runtime.ts': C4A_COMMAND_TYPES.filter(command => command === 'social.completeLanVisit' || command.startsWith('island.')),
    'src/shared/pet-runtime/runtime-helpers.ts': C3_COMMAND_TYPES,
    'src/shared/pet-runtime/travel.ts': ['job.startTravel', 'activity.stop'],
  }
  const sharedRuntimeOnly = {
    'src/shared/pet-runtime/self-care.ts': 'passive tick engine, no client command surface',
    'src/shared/pet-runtime/tick.ts': 'scheduler/minute engine, no client command surface',
  }
  const requiredSites = {
    'src/renderer/ui/setup.ts|addInfo|yb': ['admin.grantCheat'],
    'src/renderer/ui/setup.ts|addInfo|growth': ['admin.grantCheat'],
    'src/renderer/ui/setup.ts|give|': ['admin.grantRandomGoods'],
    'src/renderer/ui/chat.ts|addInfo|': ['admin.grantCheat'],
    'src/renderer/ui/chat.ts|setInfo|': ['admin.grantCheat'],
    'src/renderer/ui/state.ts|setInfo|sweetHeart': ['vip.setSweetheart'],
    'src/renderer/pet/mail.ts|writeMails|': ['mail.claim', 'mail.claimAll', 'mail.delete', 'mail.deleteAll'],
    'src/renderer/ui/email.ts|writeMails|': ['mail.claim', 'mail.claimAll', 'mail.delete', 'mail.deleteAll'],
  }
  for (const [file, commands] of Object.entries(mapping)) {
    for (const command of commands) {
      assert.equal(runtimeCommands.has(command), true, file + ' maps to unimplemented ' + command)
    }
  }
  const mutationPattern = new RegExp(String.raw`\b(?:update|setInfo|setActivity|earnYb|takeGood|give|addInfo|addGood|startTimedGood|startTimed|writeSol|writeMails|saveSpot|store)\s*\(|\.callback\s*\(|ExternalInterface\.addCallback|pondCommand\s*\(`)
  const flagged = []
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.ts') && mutationPattern.test(readFileSync(path, 'utf8'))) flagged.push(path)
    }
  }
  walk('src/renderer')
  walk('src/shared')
  const unmapped = flagged.filter(path =>
    Object.prototype.hasOwnProperty.call(mapping, path) === false &&
    Object.prototype.hasOwnProperty.call(presentationOnly, path) === false &&
    Object.prototype.hasOwnProperty.call(sharedRuntimeCommands, path) === false &&
    Object.prototype.hasOwnProperty.call(sharedRuntimeOnly, path) === false,
  )
  assert.deepEqual(unmapped, [], 'renderer mutation files without a command/runtime classification')
  assert.equal(flagged.length > 0, true)

  const updateTargets = new Set()
  const setInfoTargets = new Set()
  const mutationFiles = []
  function walkTargets(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walkTargets(path)
      else if (entry.name.endsWith('.ts')) {
        const source = readFileSync(path, 'utf8')
        const updates = [...source.matchAll(/\bupdate\(\s*['"]([^'"]+)['"]/g)].map(match => match[1])
        const infos = [...source.matchAll(/\bsetInfo\(\s*['"]([^'"]+)['"]/g)].map(match => match[1])
        if (updates.length > 0 || infos.length > 0) mutationFiles.push(path)
        for (const target of updates) updateTargets.add(target)
        for (const target of infos) setInfoTargets.add(target)
      }
    }
  }
  walkTargets('src/renderer')
  const storeTargets = new Set([
    'activeOption', 'gameSaveDatas', 'havePet', 'illustrated', 'isBury', 'nowTimeLine',
    'petComputedlInfo', 'petInfo', 'saveJsonData', 'selfGoodDatas', 'selfGoodUseOption', 'settings', 'studyInfo',
  ])
  const infoTargets = new Set([
    'clean', 'health', 'hunger', 'lastX', 'lastY', 'mood', 'onlineDataTime', 'PDgrowth', 'PDgrowthValue',
    'PDgrowthValue_next', 'PDiamondBeginDate', 'PDiamondExpirationDate', 'PDiamondLevel', 'PDiamondYear',
    'pinkDiamond', 'sex', 'sweetHeart', 'sweetHeartOverTime', 'yb',
  ])
  for (const target of updateTargets) assert.equal(storeTargets.has(target), true, 'unclassified update target: ' + target)
  for (const target of setInfoTargets) assert.equal(infoTargets.has(target), true, 'unclassified setInfo target: ' + target)
  for (const file of mutationFiles) {
    assert.equal(mapping[file] !== undefined || presentationOnly[file] !== undefined || sharedRuntimeCommands[file] !== undefined || sharedRuntimeOnly[file] !== undefined, true, 'unclassified mutation file: ' + file)
  }

  const helperSites = new Set()
  function walkHelpers(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walkHelpers(path)
      else if (entry.name.endsWith('.ts')) {
        const source = readFileSync(path, 'utf8')
        for (const match of source.matchAll(/\b(update|setInfo|setActivity|earnYb|takeGood|give|addInfo|addGood|startTimedGood|startTimed|writeMails|saveSpot|store)\s*\(\s*(?:['"]([^'"]+)['"])?/g)) {
          helperSites.add(path + '|' + match[1] + '|' + (match[2] ?? ''))
          helperSites.add(path + '|' + match[1] + '|')
        }
      }
    }
  }
  walkHelpers('src/renderer')
  walkHelpers('src/shared')
  for (const [site, commands] of Object.entries(requiredSites)) {
    assert.equal(helperSites.has(site), true, 'required mutation site is missing: ' + site)
    for (const command of commands) {
      assert.equal(runtimeCommands.has(command), true, site + ' requires unimplemented ' + command)
      assert.equal(mapping[site.split('|')[0]].includes(command), true, site + ' command is not in its file mapping')
    }
  }
  for (const [file, commands] of Object.entries(sharedRuntimeCommands)) {
    for (const command of commands) assert.equal(runtimeCommands.has(command), true, file + ' maps to unimplemented ' + command)
    assert.equal(readFileSync(file, 'utf8').length > 0, true)
  }
  for (const file of Object.keys(sharedRuntimeOnly)) assert.equal(flagged.includes(file), true, 'stale shared-runtime classification: ' + file)
  assert.equal(helperSites.has('src/renderer/ui/community.ts|saveSpot|'), true, 'saveSpot helper must be scanned')
  assert.ok(presentationOnly['src/renderer/ui/community.ts'].length > 0)
  for (const file of Object.keys(presentationOnly)) {
    assert.ok(presentationOnly[file].length > 0)
    assert.equal(flagged.includes(file), true, 'presentation-only classification is stale: ' + file)
  }

  for (const helper of ['update', 'setInfo', 'setActivity', 'addInfo', 'earnYb', 'give', 'takeGood', 'addGood', 'startTimedGood', 'startTimed', 'writeMails', 'saveSpot', 'writeSol', 'store']) {
    assert.equal(mutationPattern.test(' ' + helper + "('x')"), true, 'mutation gate does not match helper ' + helper)
  }
  function gateAccepts(file, source) {
    return mutationPattern.test(source) === false || Object.prototype.hasOwnProperty.call(mapping, file) ||
      Object.prototype.hasOwnProperty.call(presentationOnly, file) ||
      Object.prototype.hasOwnProperty.call(sharedRuntimeCommands, file) ||
      Object.prototype.hasOwnProperty.call(sharedRuntimeOnly, file)
  }
  assert.equal(gateAccepts('src/renderer/new-unmapped.ts', "update('petInfo', {})"), false)
  assert.equal(gateAccepts('src/renderer/pet/pet.ts', "update('petInfo', {})"), true)
})

test('every normative command is classified as runtime-handled or host-only', () => {
  const runtimeHandled = new Set([...C3_COMMAND_TYPES, ...C4A_COMMAND_TYPES, ...C4B_COMMAND_TYPES])
  const hostOnly = new Set([
    'device.list', 'device.revoke',
    'admin.exportForDetach', 'admin.resumeServer', 'admin.importPortableBundle',
  ])
  for (const command of COMMAND_TYPES) {
    assert.equal(runtimeHandled.has(command) || hostOnly.has(command), true, 'unclassified command: ' + command)
  }
  assert.equal(runtimeHandled.has('settings.setShared'), true)
  assert.equal(runtimeHandled.has('server.setTimeZone'), true)
  assert.equal(runtimeHandled.has('server.setAdvanceWhileEmpty'), true)
  assert.equal(runtimeHandled.has('server.setWeatherCity'), true)
  assert.equal(runtimeHandled.has('admin.grantCheat'), true)
  assert.equal(runtimeHandled.has('admin.grantRandomGoods'), true)
})

test('server/settings/admin C4b handlers apply only validated canonical changes', () => {
  const state = baseState()
  const settings = ok(state, 'settings.setShared', { key: 'difficulty', value: 'standard' })
  assert.equal(settings.state.save.settings.difficulty, 'standard')
  const paused = ok(settings.state, 'server.setAdvanceWhileEmpty', { enabled: false }, { actorRole: 'owner' })
  assert.equal(paused.state.advanceWhileEmpty, false)
  const city = ok(paused.state, 'server.setWeatherCity', { city: 'Beijing' }, { actorRole: 'owner' })
  assert.equal(city.state.weatherLocation, 'Beijing')
  const granted = ok(city.state, 'admin.grantCheat', { stat: 'yb', amount: 25 }, { actorRole: 'owner' })
  assert.equal(granted.state.save.petInfo.yb, city.state.save.petInfo.yb + 25)
  const goods = ok(granted.state, 'admin.grantRandomGoods', { type: 'food', quantity: 2 }, { actorRole: 'owner' })
  assert.ok(goods.result.goods.length >= 1)
})

test('advanceWhileEmpty=false stops at the first mid-chunk coverage gap without post-gap effects', () => {
  const state = baseState()
  state.lastSchedulerWallMs = WALL_TIME_MS
  state.gameTimeMs = GAME_TIME_MS
  state.advanceWhileEmpty = false
  state.sessionCoverage = []
  state.scheduledJobs = [{ id: 1, type: 'other', dueAtGameMs: GAME_TIME_MS + 120000, payload: {}, status: 'pending' }]
  state.nextScheduledJobId = 2
  const firstMinute = WALL_TIME_MS + 60000
  const target = WALL_TIME_MS + 3 * 60000
  const result = advanceSchedulerChunk(state, context(state, { activeClientCount: 1 }), target, {
    liveActiveClientCountAtWallMs: wallMs => wallMs < firstMinute ? 1 : 0,
    coverageAtWallMs: (fromWallMs, toWallMs) => ({
      activeClientCount: fromWallMs < firstMinute && toWallMs > WALL_TIME_MS ? 1 : 0,
      sessionActive: fromWallMs < firstMinute && toWallMs > WALL_TIME_MS,
    }),
  })
  assert.equal(result.ticks, 1)
  assert.equal(result.frozen, true)
  assert.equal(result.state.gameTimeMs, GAME_TIME_MS + 60000)
  assert.equal(result.state.lastSchedulerWallMs, firstMinute)
  assert.equal(result.state.scheduledJobs[0].status, 'pending')
  assert.equal(result.events.some(event => event.type === 'pet.statsChanged'), true)
})

test('per-minute coverage hook credits only post-connect minutes', () => {
  const state = baseState()
  state.lastSchedulerWallMs = WALL_TIME_MS
  state.gameTimeMs = GAME_TIME_MS
  state.advanceWhileEmpty = true
  state.sessionCoverage = []
  const connectAt = WALL_TIME_MS + 60000
  const target = WALL_TIME_MS + 3 * 60000
  const observed = []
  const result = advanceSchedulerChunk(state, context(state), target, {
    liveActiveClientCountAtWallMs: wallMs => {
      observed.push(wallMs)
      return wallMs >= connectAt ? 1 : 0
    },
    coverageAtWallMs: (fromWallMs, toWallMs) => {
      const active = fromWallMs >= connectAt && toWallMs > connectAt
      return { activeClientCount: active ? 1 : 0, sessionActive: active }
    },
  })
  assert.equal(result.ticks, 3)
  assert.deepEqual(observed, [WALL_TIME_MS, WALL_TIME_MS + 60000, WALL_TIME_MS + 120000])
  assert.equal(result.state.save.petInfo.onLineTime, 2)
})

test('paused game-session time is shifted so only active minutes are rewarded', () => {
  const paused = baseState()
  paused.gameSessions = [{ ...fixtures.gameSession, sessionToken: 'paused-session', startedAtGameMs: GAME_TIME_MS, expiresAtGameMs: GAME_TIME_MS + 60 * 60000, status: 'active' }]
  paused.save.settings.paused = true
  paused.lastSchedulerWallMs = WALL_TIME_MS
  paused.gameTimeMs = GAME_TIME_MS
  const pausedRun = advanceSchedulerChunk(paused, context(paused), WALL_TIME_MS + 10 * 60000)
  assert.equal(pausedRun.ticks, 10)
  assert.equal(pausedRun.state.gameSessions[0].startedAtGameMs, GAME_TIME_MS + 10 * 60000)
  assert.equal(pausedRun.state.gameSessions[0].expiresAtGameMs, GAME_TIME_MS + 70 * 60000)
  pausedRun.state.save.settings.paused = false
  const activeRun = advanceSchedulerChunk(pausedRun.state, context(pausedRun.state), WALL_TIME_MS + 11 * 60000)
  const rewarded = ok(activeRun.state, 'game.reward', { sessionToken: 'paused-session' })
  assert.equal(rewarded.result.minutes, 1)
})

test('weather city changes invalidate current/future weather cache but keep past records', () => {
  const state = baseState()
  const template = fixtures.engine.environment.weatherByDay[DAY_KEY]
  state.environment.weatherByDay = {
    '2026-10-19': { ...template, dayKey: '2026-10-19' },
    '2026-10-20': { ...template, dayKey: '2026-10-20' },
    '2026-10-21': { ...template, dayKey: '2026-10-21' },
  }
  const changed = ok(state, 'server.setWeatherCity', { city: 'Beijing' }, { actorRole: 'owner' })
  assert.equal(changed.state.weatherLocation, 'Beijing')
  assert.equal(Object.prototype.hasOwnProperty.call(changed.state.environment.weatherByDay, '2026-10-19'), true)
  assert.equal(Object.prototype.hasOwnProperty.call(changed.state.environment.weatherByDay, '2026-10-20'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(changed.state.environment.weatherByDay, '2026-10-21'), false)
})

test('server/admin commands enforce owner authority and repeated settings stay canonical', () => {
  const state = baseState()
  rejected(state, 'server.setTimeZone', { timeZone: 'America/New_York' }, {}, 'unauthorized')
  rejected(state, 'server.setAdvanceWhileEmpty', { enabled: false }, {}, 'unauthorized')
  rejected(state, 'server.setWeatherCity', { city: 'Beijing' }, {}, 'unauthorized')
  rejected(state, 'admin.grantCheat', { stat: 'yb', amount: 1 }, {}, 'unauthorized')
  rejected(state, 'admin.grantRandomGoods', { type: 'food', quantity: 1 }, {}, 'unauthorized')
  const once = ok(state, 'server.setAdvanceWhileEmpty', { enabled: false }, { actorRole: 'owner' })
  const twice = ok(once.state, 'server.setAdvanceWhileEmpty', { enabled: false }, { actorRole: 'owner' })
  assert.equal(twice.state.advanceWhileEmpty, false)
  assert.equal(stableStringify(once.state), stableStringify(twice.state))
  const zoneOnce = ok(twice.state, 'server.setTimeZone', { timeZone: 'Asia/Shanghai' }, { actorRole: 'owner' })
  const zoneTwice = ok(zoneOnce.state, 'server.setTimeZone', { timeZone: 'Asia/Shanghai' }, { actorRole: 'owner' })
  assert.equal(stableStringify(zoneOnce.state), stableStringify(zoneTwice.state))
  rejected(zoneTwice.state, 'settings.setShared', { key: 'difficulty', value: 'invalid' }, {}, 'invalid_payload')
})
