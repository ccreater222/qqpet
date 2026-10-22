import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
  GROUP_E_COMMAND_TYPES,
  GROUP_F_COMMAND_TYPES,
  C4A_COMMAND_TYPES,
  executeCommand,
  createRngState,
  levelAndCapsOf,
  stableStringify,
  executeCommandIdempotent,
  createPersistedRuntimeState,
  appendTravelPhoto,
  dayKeyAt,
} = await import('../../src/shared/pet-runtime/index.ts')
const {
  FRIES, FARM_CROPS, FARM_SEEDS, FARM_FERTILIZERS, ISLAND, PHOTOS, allGoods, EXAM_BANK, SOLD_IDS,
} = await import('../../src/shared/pet-runtime/content/index.ts')
const { COMMAND_TYPES, parsePetCommand, validateCommandPayload } = await import('../../src/shared/sync/command-validation.ts')
const { validateEngineState } = await import('../../src/shared/sync/portable.ts')
const { validateSharedSaveJsonBlob, filterIslandCanonicalState } = await import('../../src/shared/sync/data-boundary.ts')
const { createRuntimeRng, currentBoundarySeconds } = await import('../../src/shared/pet-runtime/runtime-helpers.ts')
const {
  DAY_KEY,
  GAME_TIME_MS,
  LOCAL_DEVICE_ID,
  NEXT_BOUNDARY_MS,
  SEED,
  WALL_TIME_MS,
  createSyncFixtures,
} = await import('./sync-fixtures.mjs')

const fixtures = createSyncFixtures()
const OTHER_DEVICE_ID = 'local-device-other'

function blob(state, key) {
  return JSON.parse(state.save.saveJsonData[key])
}

function islandSeed(extra = {}) {
  return JSON.stringify({
    day: currentBoundarySeconds(GAME_TIME_MS, 'Asia/Shanghai'),
    sent: 0, letter: '', lit: [], lamps: [], tier: 0, pieces: 0, piece: false,
    newsFacts: [], newsDay: 0,
    want: '', loved: false, errands: [], fought: [], wins: 0,
    ...extra,
  })
}

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



test('Group E/F catalog is present and routed without unsupported fallback', () => {
  const expectedE = [
    'game.startSession', 'game.reward', 'game.abandonSession',
    'diudiule.startSession', 'diudiule.reward',
    'social.completeLanVisit',
    'island.arriveScene', 'island.acceptLetter', 'island.deliverLetter', 'island.turnInErrand',
    'island.startQuiz', 'island.answerQuiz', 'island.fightMonster', 'island.claimGrowthReward',
    'island.claimTreasure', 'island.giftNpc', 'island.talkNpc', 'island.visitSpot',
    'island.chat', 'island.playGame', 'island.refreshNews',
  ]
  const expectedF = [
    'fishing.buy', 'fishing.feed', 'fishing.harvest', 'fishing.harvestAll', 'fishing.speedUp',
    'farm.plant', 'farm.reclaim', 'farm.harvest', 'farm.care', 'farm.clear', 'farm.buySeed', 'farm.sellProduce',
  ]
  assert.deepEqual([...GROUP_E_COMMAND_TYPES], expectedE)
  assert.deepEqual([...GROUP_F_COMMAND_TYPES], expectedF)
  assert.deepEqual([...C4A_COMMAND_TYPES], [...expectedE, ...expectedF])
  for (const type of C4A_COMMAND_TYPES) assert.equal(COMMAND_TYPES.includes(type), true, type)

  const payloads = {
    'game.startSession': { gameId: 'g1', kind: 'small' },
    'game.reward': { sessionToken: 'missing' },
    'game.abandonSession': { sessionToken: 'missing' },
    'diudiule.startSession': {},
    'diudiule.reward': { sessionToken: 'missing' },
    'social.completeLanVisit': { peerId: 'peer', direction: 'incoming' },
    'island.arriveScene': { sceneId: '3' },
    'island.acceptLetter': { fromNpcId: '莉莉', toNpcId: '探险家琼斯' },
    'island.deliverLetter': { toNpcId: '探险家琼斯' },
    'island.turnInErrand': { npcId: '科洛', errandId: '0' },
    'island.startQuiz': { npcId: '科洛', errandId: '0' },
    'island.answerQuiz': { sessionToken: 'missing', optionIndex: 0 },
    'island.fightMonster': { monsterId: '1', tactic: '硬拼' },
    'island.claimGrowthReward': {},
    'island.claimTreasure': {},
    'island.giftNpc': { npcId: '木木', itemId: '102010001' },
    'island.talkNpc': { npcId: '莉莉' },
    'island.visitSpot': { spotId: 'pet_carnival' },
    'island.chat': { npcId: '莉莉' },
    'island.playGame': { gameKey: 'QQ跆拳道' },
    'island.refreshNews': { dayKey: dayKeyAt(GAME_TIME_MS, 'Asia/Shanghai') },
    'fishing.buy': { fryId: 2, quantity: 1 },
    'fishing.feed': { fishId: 1 },
    'fishing.harvest': { fishId: 1 },
    'fishing.harvestAll': {},
    'fishing.speedUp': {},
    'farm.plant': { seedId: 'RadishSeed', plotIds: [0] },
    'farm.reclaim': { plotIds: [6] },
    'farm.harvest': { plotIds: [0] },
    'farm.care': { plotIds: [0], action: 'water' },
    'farm.clear': { plotIds: [0] },
    'farm.buySeed': { seedId: 'RadishSeed', quantity: 1 },
    'farm.sellProduce': { itemId: 'Radish', quantity: 1 },
  }
  for (const type of C4A_COMMAND_TYPES) {
    const outcome = execute(baseState(), type, payloads[type])
    if (outcome.ok === false) {
      assert.equal(outcome.error.message.includes('outside the C3/C4a runtime slice'), false, type)
    }
  }
})

test('social LAN visit and album photo flow are deterministic canonical effects', () => {
  const state = baseState()
  state.save.petInfo.mood = 950
  const visited = ok(state, 'social.completeLanVisit', { peerId: 'peer-1', direction: 'incoming' })
  assert.equal(visited.state.save.petInfo.mood, 960)
  assert.equal(visited.result.mood, 10)
  assert.equal(visited.events[0].type, 'social.visitCompleted')

  const rng = createRuntimeRng(createRngState(SEED))
  const first = appendTravelPhoto(visited.state.save, '北京市', GAME_TIME_MS, rng)
  assert.ok(first)
  assert.equal(blob(visited.state, 'album').length, 1)
  assert.equal(PHOTOS.some(photo => photo.id === first.id), true)
  assert.equal(first.city, '北京市')
  const rng2 = createRuntimeRng(createRngState(SEED))
  const other = baseState()
  other.save.petInfo.mood = 950
  ok(other, 'social.completeLanVisit', { peerId: 'peer-1', direction: 'incoming' })
  const second = appendTravelPhoto(other.save, '北京市', GAME_TIME_MS, rng2)
  assert.deepEqual(second, first)
})

function islandState(extra = {}) {
  const state = baseState()
  state.save.saveJsonData.island = islandSeed(extra)
  return state
}

test('island daily interaction commands cover letters, errands, quiz and news', () => {
  const letters = islandState()
  const accepted = ok(letters, 'island.acceptLetter', { fromNpcId: '小艾', toNpcId: '探险家琼斯' })
  assert.equal(blob(accepted.state, 'island').letter, '探险家琼斯')
  const delivered = ok(accepted.state, 'island.deliverLetter', { toNpcId: '探险家琼斯' })
  assert.equal(blob(delivered.state, 'island').sent, 1)
  assert.equal(blob(delivered.state, 'island').letter, '')

  rejected(islandState(), 'island.acceptLetter', { fromNpcId: '莉莉', toNpcId: '探险家琼斯' }, {}, 'not_available')
  const litTarget = islandState({ lit: ['探险家琼斯'] })
  rejected(litTarget, 'island.acceptLetter', { fromNpcId: '小艾', toNpcId: '探险家琼斯' }, {}, 'not_available')
  const unlit = ok(litTarget, 'island.acceptLetter', { fromNpcId: '小艾', toNpcId: '莉莉' })
  assert.equal(blob(unlit.state, 'island').letter, '莉莉')

  const arrival = islandState({ errands: [{ from: '周大饼', kind: 'visit', to: '3', got: 0, took: false }] })
  const arrived = ok(arrival, 'island.arriveScene', { sceneId: '3' })
  assert.equal(blob(arrived.state, 'island').errands[0].got, 1)

  const talked = ok(islandState({ errands: [{ from: '科洛', kind: 'talk', to: '莉莉', got: 0, took: false }] }), 'island.talkNpc', { npcId: '莉莉' })
  assert.equal(blob(talked.state, 'island').errands[0].got, 1)

  const chatted = ok(islandState({ errands: [{ from: '科洛', kind: 'chat', to: '2', got: 0, took: false }] }), 'island.chat', { npcId: '莉莉' })
  assert.equal(blob(chatted.state, 'island').errands[0].got, 1)

  const spot = Object.keys(ISLAND.spots)[0]
  const visited = ok(islandState({ errands: [{ from: '图图', kind: 'spot', to: spot, got: 0, took: false }] }), 'island.visitSpot', { spotId: spot })
  assert.equal(blob(visited.state, 'island').errands[0].got, 1)

  const game = Object.keys(ISLAND.plays)[0]
  const played = ok(islandState({ errands: [{ from: '科洛', kind: 'play', to: game, got: 0, took: false }] }), 'island.playGame', { gameKey: game })
  assert.equal(blob(played.state, 'island').errands[0].got, 1)

  const errand = islandState({ errands: [{ from: '科洛', kind: 'talk', to: '莉莉', got: 1, took: false }] })
  const turned = ok(errand, 'island.turnInErrand', { npcId: '科洛', errandId: '0' })
  assert.equal(blob(turned.state, 'island').errands[0].took, true)
  assert.ok(turned.result.goods.length >= 1)

  const love = islandState({ want: '102010001', loved: false })
  const gifted = ok(love, 'island.giftNpc', { npcId: '小艾', itemId: '102010001' })
  assert.equal(blob(gifted.state, 'island').loved, true)
  assert.equal(gifted.state.save.selfGoodDatas.food.find(entry => entry.startsWith('_102010001*')), '_102010001*4')
  assert.ok(gifted.result.goods.length >= 2)
  rejected(gifted.state, 'island.giftNpc', { npcId: '小艾', itemId: '102010001' }, {}, 'already_claimed')

  const bring = islandState({ errands: [{ from: '佐佐', kind: 'bring', to: '102010001', got: 0, took: false }] })
  const brought = ok(bring, 'island.turnInErrand', { npcId: '佐佐', errandId: '0', itemId: '102010001' })
  assert.equal(blob(brought.state, 'island').errands[0].took, true)
  assert.equal(brought.state.save.selfGoodDatas.food.find(entry => entry.startsWith('_102010001*')), '_102010001*4')

  const fight = islandState()
  const fought = ok(fight, 'island.fightMonster', { monsterId: '1', tactic: '硬拼' })
  const foughtIsland = blob(fought.state, 'island')
  assert.deepEqual(foughtIsland.fought, ['1'])
  assert.equal(typeof fought.result.won, 'boolean')

  const growth = islandState({ tier: 0 })
  const grown = ok(growth, 'island.claimGrowthReward', {})
  assert.equal(grown.result.tier, 2)
  assert.ok(grown.result.goods.length >= 3)

  const treasure = islandState({ pieces: 7, piece: false })
  const dug = ok(treasure, 'island.claimTreasure', {})
  assert.equal(dug.result.full, true)
  assert.equal(blob(dug.state, 'island').pieces, 0)

  const newsState = islandState()
  const news = ok(newsState, 'island.refreshNews', { dayKey: dayKeyAt(GAME_TIME_MS, 'Asia/Shanghai') })
  assert.equal(news.result.facts.length, 4)
  assert.equal(news.result.facts.every(fact => ISLAND.facts.some(([heading, text]) => heading === fact.heading && text === fact.fact)), true)

  const quizSubject = Object.keys(EXAM_BANK)[0]
  const quizState = islandState({ errands: [{ from: '科洛', kind: 'quiz', to: quizSubject, got: 0, took: false }] })
  const started = ok(quizState, 'island.startQuiz', { npcId: '科洛', errandId: '0' })
  assert.ok(started.result.sessionToken)
  const question = started.state.gameSessions[0].payload
  const answered = ok(started.state, 'island.answerQuiz', { sessionToken: started.result.sessionToken, optionIndex: question.answerIndex })
  assert.equal(answered.result.correct, true)
})

test('fishing commands apply canonical pond growth, purchases, harvest and speed-ups', () => {
  const bought = ok(baseState(), 'fishing.buy', { fryId: 2, quantity: 1 })
  const pond = blob(bought.state, 'fishs')
  assert.equal(pond.fishs.length, 1)
  assert.equal(pond.fishs[0].fryid, 2)
  assert.equal(pond.fishs[0].name, FRIES.find(fry => fry.fryid === 2).name)
  assert.equal(bought.state.save.petInfo.yb, 4998)

  const fishId = pond.fishs[0].id
  const fed = ok(bought.state, 'fishing.feed', { fishId })
  const fedPond = blob(fed.state, 'fishs')
  assert.equal(fedPond.fishs[0].siLiao, 1)
  assert.equal(fed.state.save.petInfo.yb, 4988)

  const speedState = clone(bought.state)
  speedState.save.saveJsonData.fishs = JSON.stringify({ PD: { allvipcnt: 2, canusecnt: 1 }, fishs: [{ ...pond.fishs[0], id: 100, born: GAME_TIME_MS / 1000 - 7200 }] })
  const sped = ok(speedState, 'fishing.speedUp', {})
  assert.equal(blob(sped.state, 'fishs').PD.canusecnt, 0)
  assert.equal(blob(sped.state, 'fishs').fishs[0].siLiao, 1)

  const harvestState = clone(bought.state)
  harvestState.save.saveJsonData.fishs = JSON.stringify({ PD: { allvipcnt: 0, canusecnt: 0 }, fishs: [{ ...pond.fishs[0], stage: 3, quantity: 5, YB: 2 }] })
  harvestState.save.gameSaveDatas.fishing_harvestfish = 999
  const harvested = ok(harvestState, 'fishing.harvest', { fishId })
  assert.equal(harvested.result.yb, 10)
  assert.equal(blob(harvested.state, 'fishs').fishs.length, 0)
  assert.equal(harvested.state.save.gameSaveDatas.fishing_harvestfish, 0)
  assert.equal(harvested.state.save.gameSaveDatas.yyds, 1)

  const allState = clone(bought.state)
  const ripeFish = { ...pond.fishs[0], id: 201, stage: 3, quantity: 2, YB: 3 }
  const ripeFish2 = { ...pond.fishs[0], id: 202, stage: 3, quantity: 4, YB: 5 }
  allState.save.saveJsonData.fishs = JSON.stringify({ PD: { allvipcnt: 0, canusecnt: 0 }, fishs: [ripeFish, ripeFish2] })
  const all = ok(allState, 'fishing.harvestAll', {})
  assert.equal(all.result.harvested, 2)
  assert.equal(all.result.yb, 26)
  assert.equal(blob(all.state, 'fishs').fishs.length, 0)

  rejected(baseState(), 'fishing.feed', { fishId: 999 }, {}, 'not_available')
  rejected(baseState(), 'fishing.speedUp', {}, {}, 'not_available')
})

test('farm commands cover seeded shop, planting, care, harvest, warehouse and sale', () => {
  const seed = FARM_SEEDS.find(candidate => candidate.seed === 'RadishSeed')
  const crop = FARM_CROPS.find(candidate => candidate.seed === 'RadishSeed')
  assert.ok(seed && crop)

  const bought = ok(baseState(), 'farm.buySeed', { seedId: 'RadishSeed', quantity: 2 })
  let farm = blob(bought.state, 'farm')
  assert.equal(farm.burden.find(entry => entry.Items === 'RadishSeed').number, 2)
  assert.equal(bought.state.save.petInfo.yb, 5000 - seed.price * 2)

  const planted = ok(bought.state, 'farm.plant', { seedId: 'RadishSeed', plotIds: [0, 1] })
  farm = blob(planted.state, 'farm')
  assert.equal(farm.farmland[0].crop, 'RadishSeed')
  assert.equal(farm.farmland[1].crop, 'RadishSeed')
  assert.equal(farm.burden.length, 0)

  const farmForHarvest = blob(planted.state, 'farm')
  farmForHarvest.farmland[0].time = Math.floor(GAME_TIME_MS / 1000) - crop.time - 1
  farmForHarvest.farmland[2].farmland = 'FarmlandG'
  farmForHarvest.farmland[2].grass = 1
  farmForHarvest.farmland[2].worm = 1
  farmForHarvest.farmland[3] = { ...farmForHarvest.farmland[1] }
  farmForHarvest.farmland[3].time = Math.floor(GAME_TIME_MS / 1000) - 100
  farmForHarvest.burden = [{ name: '普通化肥', Items: 'Fertilizer', number: 1 }]
  const harvestBase = clone(planted.state)
  harvestBase.save.saveJsonData.farm = JSON.stringify(farmForHarvest)
  const harvested = ok(harvestBase, 'farm.harvest', { plotIds: [0] })
  farm = blob(harvested.state, 'farm')
  const warehouse = farm.warehouse.find(entry => entry.fruit === 'Radish')
  assert.ok(warehouse)
  assert.ok(warehouse.number > 0)
  assert.equal(farm.farmland[0].harvest, 'xx')
  assert.ok(Number(farm.experience) >= crop.experience)

  // State above is intentionally rebuilt because harvest's cloned output owns the RNG/state.
  const careBase = clone(planted.state)
  careBase.save.saveJsonData.farm = JSON.stringify(farmForHarvest)
  const watered = ok(careBase, 'farm.care', { plotIds: [2], action: 'water' })
  assert.equal(blob(watered.state, 'farm').farmland[2].farmland, 'FarmlandS')
  assert.equal(blob(watered.state, 'farm').farmland[2].grass, 1)

  const weeded = ok(watered.state, 'farm.care', { plotIds: [2], action: 'weed' })
  assert.equal(blob(weeded.state, 'farm').farmland[2].grass, undefined)
  const debug = ok(weeded.state, 'farm.care', { plotIds: [2], action: 'pest' })
  assert.equal(blob(debug.state, 'farm').farmland[2].worm, undefined)
  const fertilized = ok(debug.state, 'farm.care', { plotIds: [3], action: 'fertilize' })
  assert.equal(blob(fertilized.state, 'farm').burden.length, 0)
  assert.ok(blob(fertilized.state, 'farm').farmland[3].time < farmForHarvest.farmland[3].time)

  const cleared = ok(harvested.state, 'farm.clear', { plotIds: [0] })
  assert.equal(blob(cleared.state, 'farm').farmland[0].crop, undefined)

  const sold = ok(harvested.state, 'farm.sellProduce', { itemId: 'Radish', quantity: 1 })
  assert.ok(sold.result.yb > 0)
  assert.equal(blob(sold.state, 'farm').warehouse.find(entry => entry.fruit === 'Radish').number, warehouse.number - 1)
})

test('farm reclaim validation is strict while duplicate ids are rejected by the handler', () => {
  assert.equal(validateCommandPayload('farm.reclaim', { plotIds: [6, 7] }), true)
  assert.deepEqual(parsePetCommand({ type: 'farm.reclaim', payload: { plotIds: [6, 7] } }), {
    ok: true,
    command: { type: 'farm.reclaim', payload: { plotIds: [6, 7] } },
  })
  for (const payload of [
    {},
    { plotIds: [] },
    { plotIds: [6, -1] },
    { plotIds: [6, 1.5] },
    { plotIds: '6' },
    { plotIds: [6], extra: true },
  ]) {
    assert.equal(validateCommandPayload('farm.reclaim', payload), false, JSON.stringify(payload))
  }
  // Duplicate ids are structurally valid and are rejected atomically by the handler.
  assert.equal(validateCommandPayload('farm.reclaim', { plotIds: [6, 6] }), true)
})

test('farm reclaim converts only selected wasteland plots exactly once without rewards', () => {
  const state = baseState()
  const before = state.save
  const outcome = ok(state, 'farm.reclaim', { plotIds: [6, 7] })
  const farm = blob(outcome.state, 'farm')
  assert.equal(farm.farmland.length, 18)
  assert.deepEqual(farm.farmland.map((land) => land.farmland), [
    'FarmlandS', 'FarmlandS', 'FarmlandS', 'FarmlandS', 'FarmlandS', 'FarmlandS',
    'FarmlandS', 'FarmlandS',
    'Wasteland', 'Wasteland', 'Wasteland', 'Wasteland', 'Wasteland', 'Wasteland', 'Wasteland', 'Wasteland', 'Wasteland', 'Wasteland',
  ])
  assert.equal(farm.farmland[6].crop, undefined)
  assert.deepEqual(outcome.result, { reclaimed: 2 })
  assert.equal(outcome.events.length, 1)
  assert.equal(outcome.events[0].type, 'farm.changed')
  assert.equal(outcome.events[0].payload.action, 'reclaim')
  assert.deepEqual(outcome.events[0].payload.plots, [6, 7])
  assert.equal(outcome.state.save.petInfo.yb, before.petInfo.yb)
  assert.equal(outcome.state.save.petInfo.growth, before.petInfo.growth)
  assert.equal(Number(farm.experience), 1)
  assert.equal(Number(farm.rank), 1)
  assert.deepEqual(farm.burden, [])
  assert.deepEqual(farm.warehouse, [])

  rejected(state, 'farm.reclaim', { plotIds: [0] }, {}, 'not_available')
  rejected(state, 'farm.reclaim', { plotIds: [18] }, {}, 'not_available')
  rejected(state, 'farm.reclaim', { plotIds: [6, 6] }, {}, 'invalid_payload')
  rejected(state, 'farm.reclaim', { plotIds: [-1] }, {}, 'invalid_payload')
})

test('farm reclaim op-id replay is idempotent and a fresh op-id cannot reclaim twice', () => {
  const petId = 'pet-farm-reclaim'
  const deviceId = 'device-farm-reclaim'
  const command = { type: 'farm.reclaim', payload: { plotIds: [6, 7] } }
  const document = createPersistedRuntimeState(baseState())
  const first = executeCommandIdempotent(petId, deviceId, document, command, context(document.engine), 'op-reclaim-1')
  assert.equal(first.duplicate, false)
  assert.equal(first.outcome.ok, true)
  assert.deepEqual(first.outcome.result, { reclaimed: 2 })
  const reclaimedFarm = blob(first.document.engine, 'farm')
  assert.equal(reclaimedFarm.farmland[6].farmland, 'FarmlandS')
  assert.equal(reclaimedFarm.farmland[7].farmland, 'FarmlandS')

  const replay = executeCommandIdempotent(petId, deviceId, first.document, command, context(first.document.engine), 'op-reclaim-1')
  assert.equal(replay.duplicate, true)
  assert.equal(replay.outcome.ok, true)
  assert.deepEqual(replay.outcome.result, { reclaimed: 2 })
  assert.equal(replay.outcome.events.length, 0)
  assert.equal(stableStringify(replay.document.engine), stableStringify(first.document.engine))

  const secondAttempt = executeCommandIdempotent(petId, deviceId, first.document, command, context(first.document.engine), 'op-reclaim-2')
  assert.equal(secondAttempt.duplicate, false)
  assert.equal(secondAttempt.outcome.ok, false)
  assert.equal(secondAttempt.outcome.error.code, 'not_available')
  assert.equal(stableStringify(secondAttempt.document.engine), stableStringify(first.document.engine))
})

test('C4a fishing, farm and island content tables drift-check against renderer/SWF sources', () => {
  const fries = JSON.parse(readFileSync('src/renderer/pet/data/fries.json', 'utf8'))
  assert.deepEqual(FRIES, fries)

  function attrs(text) {
    const result = {}
    for (const match of text.matchAll(/([A-Za-z]+)="([^"]*)"/g)) result[match[1]] = match[2]
    return result
  }
  const cropXml = readFileSync('resources/pet/qqfarm/com/MyFarm/data/xml/Crop.xml', 'utf8')
  const seedXml = readFileSync('resources/pet/qqfarm/com/MyFarm/data/xml/seed.xml', 'utf8')
  const crops = [...cropXml.matchAll(/<items\s+([^>]+)><\/items>/g)].map(match => {
    const row = attrs(match[1])
    return {
      seed: row.seed, name: row.name, crop: row.crop, time: Number(row.time),
      experience: Number(row.experience), yield: Number(row.yield), price: Number(row.price),
    }
  })
  const seeds = [...seedXml.matchAll(/<item\s+([^>]+)><\/item>/g)].map(match => {
    const row = attrs(match[1])
    return {
      seed: row.object, name: row.name, price: Number(row.price), rank: Number(row.rank),
      maturation: Number(row.maturation), experience: Number(row.experience), yield: Number(row.yield),
      cropPrice: Number(row.prices), type: row.type,
    }
  })
  assert.deepEqual(FARM_CROPS, crops)
  assert.deepEqual(FARM_SEEDS, seeds)
  assert.equal(readFileSync('src/shared/pet-runtime/content/shop.json', 'utf8'), readFileSync('src/renderer/pet/data/shop.json', 'utf8'))
  const shop = JSON.parse(readFileSync('src/renderer/pet/data/shop.json', 'utf8'))
  const shopLeaves = []
  const collect = value => {
    if (typeof value === 'string') shopLeaves.push(value)
    else if (Array.isArray(value)) value.forEach(collect)
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(collect)
  }
  collect(shop)
  assert.deepEqual([...SOLD_IDS].sort(), [...new Set(shopLeaves)].sort())

  const islandSource = readFileSync('src/renderer/ui/island.ts', 'utf8')
  const placesBlock = islandSource.split('const PLACES:')[1].split('}', 1)[0]
  const places = {}
  for (const match of placesBlock.matchAll(/(\d+): '([^']+)'/g)) places[match[1]] = match[2]
  assert.deepEqual(ISLAND.places, places)

  const folkBlock = islandSource.split('const FOLK:')[1].split('\n}', 1)[0]
  const folk = {}
  for (const match of folkBlock.matchAll(/^  ([^:]+): \{ key: '([^']+)', scene: (\d+), about: '([^']*)' \}/gm)) {
    folk[match[1]] = { key: match[2], scene: Number(match[3]), about: match[4] }
  }
  assert.deepEqual(ISLAND.folk, folk)

  const factsBlock = islandSource.split('const FACTS:')[1].split('\n]', 1)[0]
  const facts = [...factsBlock.matchAll(/\['([^']+)', '([^']*)'\]/g)].map(match => [match[1], match[2]])
  assert.deepEqual(ISLAND.facts, facts)

  const monsterBlock = islandSource.split('const MONSTERS:')[1].split('\n}', 1)[0]
  const monsters = {}
  for (const match of monsterBlock.matchAll(/^  (\d+): \['([^']+)', (\d+), '([^']*)'\]/gm)) {
    monsters[match[1]] = { name: match[2], scene: Number(match[3]), about: match[4] }
  }
  assert.deepEqual(ISLAND.monsters, monsters)

  const playBlock = islandSource.split('const PLAYS:')[1].split('\n}', 1)[0]
  const plays = {}
  for (const match of playBlock.matchAll(/^  (?:'([^']+)'|([^:]+)): '([^']+)'/gm)) {
    plays[(match[1] ?? match[2]).trim()] = match[3]
  }
  assert.deepEqual(ISLAND.plays, plays)

  const spotBlock = islandSource.split('const SPOTS:')[1].split('\nconst MONSTERS', 1)[0]
  const spotRows = [...spotBlock.matchAll(/^  (?:'([^']+)'|([A-Za-z0-9_]+)): \{\n    name: '([^']+)'/gm)]
  assert.deepEqual(Object.keys(ISLAND.spots), spotRows.map(match => match[1] ?? match[2]))
  assert.deepEqual(Object.fromEntries(spotRows.map(match => [match[1] ?? match[2], { name: match[3] }])), ISLAND.spots)

  const sendersBlock = islandSource.split('const SENDERS = ')[1].split('\n', 1)[0]
  const senders = [...sendersBlock.matchAll(/'([^']+)'/g)].map(match => match[1])
  assert.deepEqual(ISLAND.senders, senders)
  for (const [name, value] of [['LETTERS', ISLAND.letters], ['PIECES', ISLAND.pieces], ['TIER', ISLAND.tier]]) {
    const match = new RegExp('const ' + name + ' = (\\d+)').exec(islandSource)
    assert.equal(Number(match[1]), value)
  }

  const errandsBlock = islandSource.split('const ERRANDS:')[1].split('\n]', 1)[0]
  const errands = [...errandsBlock.matchAll(/\['([^']+)', '([^']+)', '([^']+)', '([^']*)'\]/g)]
    .map(match => [match[1], match[2], match[3], match[4]])
  assert.deepEqual(ISLAND.errands, errands)

  const tacticsBlock = islandSource.split('const TACTICS = ')[1].split('\n} as const', 1)[0]
  const tactics = {}
  for (const match of tacticsBlock.matchAll(/^  (\S+): \{\n    stat: '([^']+)'/gm)) tactics[match[1]] = match[2]
  assert.deepEqual(ISLAND.tactics, tactics)

  const choresBlock = islandSource.split('const CHORES:')[1].split('\n}', 1)[0]
  const chores = {}
  for (const match of choresBlock.matchAll(/^  (\w+): \['[^']*', (\d+)\]/gm)) chores[match[1]] = Number(match[2])
  assert.deepEqual(ISLAND.chores, chores)

  const giftsBlock = islandSource.split('const GIFTS:')[1].split('\n}', 1)[0]
  const gifts = {}
  for (const match of giftsBlock.matchAll(/(\w+): '([^']+)'/g)) gifts[match[1]] = match[2]
  assert.deepEqual(ISLAND.gifts, gifts)

  const farmControl = readFileSync('tools/qqfarm/src/com/MyFarm/control/FarmlandControl.as', 'utf8')
  const fertilizerBlock = farmControl.split('const FERTILIZER:Object = {')[1].split('};', 1)[0]
  const fertilizerDurations = {}
  for (const match of fertilizerBlock.matchAll(/"([^"]+)":(\d+)/g)) fertilizerDurations[match[1]] = Number(match[2])
  const propsXml = readFileSync('resources/pet/qqfarm/com/MyFarm/data/xml/props.xml', 'utf8')
  const fertilizerNames = {}
  for (const match of propsXml.matchAll(/<item\s+([^>]+)>/g)) {
    const row = attrs(match[1])
    if (row.object && row.name) fertilizerNames[row.object] = row.name
  }
  const expectedFertilizers = Object.entries(fertilizerDurations).map(([item, duration]) => ({ item, name: fertilizerNames[item], duration }))
  assert.deepEqual(FARM_FERTILIZERS, expectedFertilizers)
  assert.throws(() => assert.deepEqual(FARM_FERTILIZERS, [...expectedFertilizers, { item: 'FertilizerSynthetic', name: '合成化肥', duration: 123 }]), assert.AssertionError)
  assert.throws(() => assert.deepEqual([...FARM_FERTILIZERS, { item: 'RuntimeOnly', name: '仅运行时', duration: 1 }], expectedFertilizers), assert.AssertionError)
})

test('game and diudiule sessions remain server-authoritative in Group E', () => {
  const gameStarted = ok(baseState(), 'game.startSession', { gameId: 'island-game', kind: 'small' })
  const gameToken = gameStarted.result.sessionToken
  assert.ok(gameToken)
  const gameState = clone(gameStarted.state)
  gameState.gameTimeMs += 60000
  const gameReward = ok(gameState, 'game.reward', { sessionToken: gameToken })
  assert.equal(gameReward.result.minutes, 1)
  assert.ok(gameReward.state.gameSessions[0].status === 'settled')

  const diuStarted = ok(baseState(), 'diudiule.startSession', {})
  const diuToken = diuStarted.result.sessionToken
  const diuReward = ok(diuStarted.state, 'diudiule.reward', { sessionToken: diuToken })
  assert.equal(diuReward.state.gameSessions[0].status, 'settled')
  assert.equal(diuReward.result.yb, 1)
})

test('island daily roll mirrors the 6+2, can-filtered, sold-want renderer path', () => {
  const state = islandState({ day: 0 })
  const refreshed = ok(state, 'island.refreshNews', { dayKey: dayKeyAt(GAME_TIME_MS, 'Asia/Shanghai') })
  const island = blob(refreshed.state, 'island')
  assert.equal(island.errands.length, 8)
  assert.equal(new Set(island.errands.map(errand => errand.from)).size, 8)
  assert.ok(new Set(island.errands.map(errand => errand.kind)).size < 8, 'made kinds may repeat written/made kinds')
  const written = island.errands.slice(0, 6)
  for (const errand of written) {
    assert.equal(ISLAND.errands.some(([from, kind, to]) => from === errand.from && kind === errand.kind && to === errand.to), true)
  }
  for (const errand of island.errands) {
    if (errand.kind === 'bring') {
      const item = allGoods('food').concat(allGoods('toy'), allGoods('clean')).find(good => good.id === errand.to)
      assert.ok(item)
      assert.equal(SOLD_IDS.has(item.id), true)
      assert.ok(item.price > 0 && item.price <= 200)
      assert.equal(item.PD === true || item.outOfPrint === true, false)
    }
    if (errand.kind === 'fight') {
      const id = Number(errand.to)
      const best = Math.max(...Object.values(ISLAND.tactics).map(stat => {
        const value = refreshed.state.save.petInfo[stat]
        return (value + 10) / (value + 10 + 10 * id * id)
      }))
      assert.ok(best >= 0.5)
    }
  }
  const want = allGoods('food').concat(allGoods('toy'), allGoods('clean')).find(good => good.id === island.want)
  assert.ok(want)
  assert.equal(SOLD_IDS.has(want.id), true)
  assert.ok(want.price > 0 && want.price <= 200)
  assert.equal(want.PD === true || want.outOfPrint === true, false)
  assert.ok((want.needLevel ?? 0) <= refreshed.state.save.petComputedlInfo.level)
})

test('island refreshNews persists canonical facts and is idempotent until the next day', () => {
  const state = islandState({ day: 0 })
  const first = ok(state, 'island.refreshNews', { dayKey: dayKeyAt(GAME_TIME_MS, 'Asia/Shanghai') })
  assert.equal(first.result.cached, false)
  assert.equal(first.result.facts.length, 4)
  assert.deepEqual(blob(first.state, 'island').newsFacts, first.result.facts.map(fact => [fact.heading, fact.fact]))
  const drawsAfterFirst = first.state.rng.draws
  const second = ok(first.state, 'island.refreshNews', { dayKey: dayKeyAt(GAME_TIME_MS, 'Asia/Shanghai') })
  assert.equal(second.result.cached, true)
  assert.deepEqual(second.result.facts, first.result.facts)
  assert.equal(second.state.rng.draws, drawsAfterFirst)

  const nextTime = NEXT_BOUNDARY_MS + 1000
  const next = clone(first.state)
  next.gameTimeMs = nextTime
  const nextKey = dayKeyAt(nextTime, 'Asia/Shanghai')
  const nextDay = ok(next, 'island.refreshNews', { dayKey: nextKey })
  assert.equal(nextDay.result.cached, false)
  assert.equal(blob(nextDay.state, 'island').newsDay, currentBoundarySeconds(nextTime, 'Asia/Shanghai'))
  const nextDraws = nextDay.state.rng.draws
  const repeat = ok(nextDay.state, 'island.refreshNews', { dayKey: nextKey })
  assert.equal(repeat.result.cached, true)
  assert.equal(repeat.state.rng.draws, nextDraws)
})


test('canonical island news fields reject malformed shapes without crashing refresh', () => {
  assert.equal(validateSharedSaveJsonBlob('island', JSON.stringify({ newsFacts: [['a', 'b']], newsDay: 1 })), true)
  assert.equal(validateSharedSaveJsonBlob('island', JSON.stringify({ newsFacts: 'bad' })), false)
  assert.equal(validateSharedSaveJsonBlob('island', JSON.stringify({ newsFacts: [['a']] })), false)
  assert.equal(validateSharedSaveJsonBlob('island', JSON.stringify({ newsFacts: [[1, 2]] })), false)
  assert.equal(validateSharedSaveJsonBlob('island', JSON.stringify({ newsDay: 'bad' })), false)
  assert.equal(validateSharedSaveJsonBlob('island', JSON.stringify({ newsDay: -1 })), false)
  assert.equal(validateSharedSaveJsonBlob('island', JSON.stringify({ newsDay: 1.5 })), false)
  assert.throws(() => filterIslandCanonicalState({ newsFacts: 'bad' }))
  assert.throws(() => filterIslandCanonicalState({ newsDay: 'bad' }))

  const malformedFacts = baseState()
  malformedFacts.save.saveJsonData.island = JSON.stringify({ newsFacts: 'bad', newsDay: 1 })
  const factsOutcome = execute(malformedFacts, 'island.refreshNews', { dayKey: dayKeyAt(GAME_TIME_MS, 'Asia/Shanghai') })
  assert.equal(factsOutcome.ok, false)
  assert.equal(factsOutcome.error.code, 'invalid_payload')

  const malformedDay = baseState()
  malformedDay.save.saveJsonData.island = JSON.stringify({ newsFacts: [], newsDay: 'bad' })
  const dayOutcome = execute(malformedDay, 'island.refreshNews', { dayKey: dayKeyAt(GAME_TIME_MS, 'Asia/Shanghai') })
  assert.equal(dayOutcome.ok, false)
  assert.equal(dayOutcome.error.code, 'invalid_payload')
})
