import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL &&
        /\.[cm]?[jt]s$/.test(specifier) === false && specifier.endsWith('.json') === false) {
      return nextResolve(specifier + '.ts', context)
    }
    return nextResolve(specifier, context)
  },
})

const { normalizeSharedSaveDefaults } = await import('../../src/shared/sync/normalize.ts')
const {
  assertSharedSaveData,
  validateSharedSaveData,
} = await import('../../src/shared/sync/data-boundary.ts')
const { SchemaError } = await import('../../src/shared/sync/schema.ts')
const {
  migrateLegacySaveDataToPortableBundle,
  validateEngineState,
} = await import('../../src/shared/sync/portable.ts')
const {
  createHeadlessRuntime,
  levelAndCapsOf,
} = await import('../../src/shared/pet-runtime/index.ts')
const { TRAVEL_PROVINCES } = await import('../../src/shared/pet-runtime/content/index.ts')
const { planPortableImport } = await import('../../server/src/portable-import.ts')
const {
  GAME_TIME_MS,
  LOCAL_DEVICE_ID,
  SEED,
  createSyncFixtures,
} = await import('./sync-fixtures.mjs')

const fixtures = createSyncFixtures()

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

const CANONICAL_SAVE_JSON_DATA = {
  email: '{}', task: '{}', signin: '{}', fishs: '{}', farm: '{}', activity: '0', album: '[]', island: '{}',
}

function canonicalShared() {
  const shared = clone(fixtures.shared)
  shared.saveJsonData = { ...CANONICAL_SAVE_JSON_DATA }
  return shared
}

function expectSchemaCode(fn, code) {
  assert.throws(fn, error => error instanceof SchemaError && error.code === code)
}

const MIGRATION_OPTIONS = {
  nowMs: GAME_TIME_MS,
  seedHex: SEED,
  authority: fixtures.authority,
  localDeviceId: LOCAL_DEVICE_ID,
  timeZone: 'Asia/Shanghai',
  advanceWhileEmpty: true,
  weatherLocation: 'Shanghai',
}

function runtimeContext(state) {
  return {
    gameTimeMs: state.gameTimeMs,
    environment: state.environment,
    activeClientCount: 1,
    sessionActive: false,
    actorDeviceId: LOCAL_DEVICE_ID,
    actorRole: 'player',
  }
}

test('normalize fills missing canonical keys and reports each filled path', () => {
  const shared = canonicalShared()
  delete shared.activeOption.trip
  shared.selfGoodDatas.food = null
  delete shared.gameSaveDatas.travel_china
  delete shared.studyInfo.wushu
  delete shared.selfGoodUseOption.toy
  shared.illustrated = null
  delete shared.petComputedlInfo.moodMax

  const filled = normalizeSharedSaveDefaults(shared)

  assert.deepEqual([...filled].sort(), [
    'activeOption.trip',
    'gameSaveDatas.travel_china',
    'illustrated',
    'petComputedlInfo.moodMax',
    'selfGoodDatas.food',
    'selfGoodUseOption.toy',
    'studyInfo.wushu',
  ])
  assert.equal(shared.activeOption.trip, null)
  assert.deepEqual(shared.selfGoodDatas.food, [])
  assert.deepEqual(shared.gameSaveDatas.travel_china, [])
  assert.equal(shared.studyInfo.wushu, 0)
  assert.equal(shared.selfGoodUseOption.toy, null)
  assert.deepEqual(shared.illustrated, [])
  assert.equal(shared.petComputedlInfo.moodMax, 1000)
  // Existing blob strings are never rewritten.
  assert.equal(shared.saveJsonData.email, '{}')
  assert.equal(validateSharedSaveData(shared), true)
  assert.equal(normalizeSharedSaveDefaults(shared).length, 0)
})

test('normalize never adds missing saveJsonData blob keys', () => {
  const shared = canonicalShared()
  delete shared.saveJsonData.task
  delete shared.saveJsonData.farm
  shared.saveJsonData.email = null

  assert.deepEqual(normalizeSharedSaveDefaults(shared), [])
  assert.equal(Object.prototype.hasOwnProperty.call(shared.saveJsonData, 'task'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(shared.saveJsonData, 'farm'), false)
  assert.equal(shared.saveJsonData.email, null)
})

test('normalize materializes whole missing groups but never invents required top-level groups', () => {
  const shared = canonicalShared()
  for (const group of [
    'petComputedlInfo', 'studyInfo', 'activeOption', 'selfGoodDatas',
    'selfGoodUseOption', 'gameSaveDatas', 'illustrated',
  ]) {
    delete shared[group]
  }
  shared.activeOption = null
  shared.selfGoodDatas = null

  const filled = normalizeSharedSaveDefaults(shared)

  assert.deepEqual([...filled].sort(), [
    'activeOption',
    'gameSaveDatas',
    'illustrated',
    'petComputedlInfo',
    'selfGoodDatas',
    'selfGoodUseOption',
    'studyInfo',
  ])
  assert.deepEqual(shared.activeOption, { work: null, study: null, trip: null, ill: null, die: null })
  assert.deepEqual(shared.selfGoodDatas, {
    food: [], clean: [], medicine: [], background: [], toy: [], nums: [], service: [], work: [], study: [], trip: [],
  })
  assert.deepEqual(shared.selfGoodUseOption, { background: null, food: null, clean: null, toy: null })
  assert.deepEqual(shared.gameSaveDatas, {
    fishing_harvestfish: 0, travel_china: [], travel_china_num: 0, ddw: 0, yyds: 0,
  })
  assert.deepEqual(shared.studyInfo, {
    chinese: 0, mathematics: 0, politics: 0, music: 0, art: 0, manner: 0, pe: 0, labouring: 0, wushu: 0,
  })
  assert.deepEqual(shared.petComputedlInfo, {
    level: 1, upGrowth: 0, nextGrowth: 125, hungerMax: 1100, cleanMax: 1100, healthMax: 5, moodMax: 1000,
  })
  assert.deepEqual(shared.illustrated, [])
  assert.equal(validateSharedSaveData(shared), true)

  const withoutRequired = canonicalShared()
  delete withoutRequired.petInfo
  delete withoutRequired.settings
  delete withoutRequired.saveJsonData
  assert.equal(normalizeSharedSaveDefaults(withoutRequired).length, 0)
  assert.equal(Object.prototype.hasOwnProperty.call(withoutRequired, 'petInfo'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(withoutRequired, 'settings'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(withoutRequired, 'saveJsonData'), false)
})

test('normalize keeps every existing non-null value untouched and is idempotent', () => {
  const shared = canonicalShared()
  shared.activeOption.work = 'bz'
  shared.selfGoodDatas.food = ['_102010001*2']
  shared.selfGoodUseOption.food = { id: '102010001', left: 7 }
  shared.studyInfo.chinese = 3
  shared.gameSaveDatas.travel_china = [{ name: '北京市', value: 2 }]
  shared.gameSaveDatas.travel_china_num = 4
  shared.illustrated = ['10013006']
  shared.petComputedlInfo.level = 4
  shared.saveJsonData.task = '{"doNums":{"Eat":1}}'

  assert.deepEqual(normalizeSharedSaveDefaults(shared), [])
  assert.equal(shared.activeOption.work, 'bz')
  assert.deepEqual(shared.selfGoodDatas.food, ['_102010001*2'])
  assert.deepEqual(shared.selfGoodUseOption.food, { id: '102010001', left: 7 })
  assert.equal(shared.studyInfo.chinese, 3)
  assert.deepEqual(shared.gameSaveDatas.travel_china, [{ name: '北京市', value: 2 }])
  assert.equal(shared.gameSaveDatas.travel_china_num, 4)
  assert.deepEqual(shared.illustrated, ['10013006'])
  assert.equal(shared.petComputedlInfo.level, 4)
  assert.equal(shared.saveJsonData.task, '{"doNums":{"Eat":1}}')

  const before = JSON.stringify(shared)
  const filled = normalizeSharedSaveDefaults(shared)
  assert.deepEqual(filled, [])
  assert.equal(JSON.stringify(shared), before)
})

test('normalize leaves invalid types for the shared validator to reject', () => {
  const cases = [
    ['activeOption group', shared => { shared.activeOption = 'x' }],
    ['activeOption member', shared => { shared.activeOption.work = 42 }],
    ['travel_china member', shared => { shared.gameSaveDatas.travel_china = 'x' }],
    ['selfGoodDatas group member', shared => { shared.selfGoodDatas.food = 'x' }],
    ['selfGoodUseOption group', shared => { shared.selfGoodUseOption = 'x' }],
    ['studyInfo group', shared => { shared.studyInfo = 'x' }],
    ['illustrated group', shared => { shared.illustrated = 'x' }],
    ['petComputedlInfo group', shared => { shared.petComputedlInfo = 'x' }],
  ]
  for (const [label, mutate] of cases) {
    const shared = canonicalShared()
    mutate(shared)
    assert.deepEqual(normalizeSharedSaveDefaults(shared), [], label)
    expectSchemaCode(() => assertSharedSaveData(shared), 'invalid_schema')
  }

  // A missing member is left for the import boundary to fill, not treated as an invalid type.
  const partial = canonicalShared()
  delete partial.activeOption.trip
  delete partial.gameSaveDatas.travel_china
  assert.equal(validateSharedSaveData(partial), true)
  normalizeSharedSaveDefaults(partial)
  assert.equal(validateSharedSaveData(partial), true)
})

test('legacy migration normalizes partial canonical groups so commands and ticks stay healthy', () => {
  const legacy = clone(fixtures.save)
  Object.assign(legacy.petInfo, { growth: 5000, health: 5, hunger: 1100, clean: 1100, mood: 1000, yb: 20000 })
  legacy.petComputedlInfo = { ...levelAndCapsOf(5000), healthMax: 5, moodMax: 1000 }
  legacy.activeOption = {}
  delete legacy.studyInfo.wushu
  delete legacy.studyInfo.music
  delete legacy.selfGoodDatas.food
  delete legacy.selfGoodUseOption.toy
  delete legacy.gameSaveDatas.travel_china
  legacy.illustrated = null
  legacy.saveJsonData = { email: '{}', task: '{}', signin: '{}', fishs: '{}' }

  const bundle = migrateLegacySaveDataToPortableBundle(legacy, MIGRATION_OPTIONS)
  assert.equal(validateEngineState(bundle.engine), true)
  const save = bundle.engine.save
  assert.deepEqual(save.activeOption, { work: null, study: null, trip: null, ill: null, die: null })
  assert.deepEqual(save.selfGoodDatas.food, [])
  assert.equal(save.selfGoodUseOption.toy, null)
  assert.deepEqual(save.gameSaveDatas.travel_china, [])
  assert.equal(save.studyInfo.wushu, 0)
  assert.equal(save.studyInfo.music, 0)
  assert.deepEqual(save.illustrated, [])
  // Blob defaults stay out of the shared normalizer: missing keys keep their runtime fallbacks.
  assert.equal(Object.prototype.hasOwnProperty.call(save.saveJsonData, 'album'), false)

  // The caller's legacy object must not be repaired in place.
  assert.deepEqual(legacy.activeOption, {})
  assert.equal(legacy.illustrated, null)
  assert.equal(Object.prototype.hasOwnProperty.call(legacy.saveJsonData, 'album'), false)

  const work = createHeadlessRuntime(bundle.engine)
  const start = work.execute({ type: 'job.startWork', payload: { jobId: 'bz' } }, runtimeContext(work.snapshot()))
  assert.equal(start.ok, true, start.ok ? '' : start.error.code + ': ' + start.error.message)

  const buy = createHeadlessRuntime(bundle.engine)
  const bought = buy.execute(
    { type: 'inventory.buy', payload: { type: 'food', itemId: '102010001', quantity: 1 } },
    runtimeContext(buy.snapshot()),
  )
  assert.equal(bought.ok, true, bought.ok ? '' : bought.error.code + ': ' + bought.error.message)

  const tick = createHeadlessRuntime(bundle.engine)
  const ticked = tick.tick(runtimeContext(tick.snapshot()))
  assert.equal(ticked.ok, true, ticked.ok ? '' : ticked.error.code + ': ' + ticked.error.message)

  const travelEngine = clone(bundle.engine)
  travelEngine.save.gameSaveDatas.travel_china = TRAVEL_PROVINCES.map(province => ({ name: province.name, value: 1 }))
  const travel = createHeadlessRuntime(travelEngine)
  const collected = travel.execute({ type: 'travel.completeCollection', payload: {} }, runtimeContext(travel.snapshot()))
  assert.equal(collected.ok, true, collected.ok ? '' : collected.error.code + ': ' + collected.error.message)
  assert.equal(collected.state.save.gameSaveDatas.travel_china_num, 1)
})

test('server planPortableImport normalizes a partial bundle without mutating the caller', () => {
  const incoming = clone(fixtures.bundle)
  for (const save of [incoming.shared, incoming.engine.save]) {
    save.activeOption = null
    delete save.selfGoodDatas.food
    delete save.gameSaveDatas.travel_china
    delete save.selfGoodUseOption.toy
    delete save.studyInfo.wushu
    save.illustrated = null
  }
  const before = clone(incoming)

  const planned = planPortableImport({
    bundle: incoming,
    current: {
      petId: 'pet-0001',
      authorityId: 'authority-server-0001',
      restoreGeneration: 0,
      epoch: 0,
      handoffEpoch: null,
      owner: 'server',
      state: 'active',
      handoffId: 'handoff-server-0001',
      detachedAtMs: null,
      sourceRevision: null,
      sourceEventSeq: null,
    },
    wallNowMs: GAME_TIME_MS,
    allowClamp: true,
    resumeMode: false,
    uploaderDeviceId: 'server-device-0001',
    rebindLocalSessions: true,
    destinationHasNoAppliedCommands: true,
  })
  assert.equal(planned.ok, true, planned.ok ? '' : planned.code + ': ' + planned.message)
  const save = planned.plan.engine.save
  assert.deepEqual(save.activeOption, { work: null, study: null, trip: null, ill: null, die: null })
  assert.deepEqual(save.selfGoodDatas.food, [])
  assert.deepEqual(save.gameSaveDatas.travel_china, [])
  assert.equal(save.selfGoodUseOption.toy, null)
  assert.equal(save.studyInfo.wushu, 0)
  assert.deepEqual(save.illustrated, [])
  assert.equal(validateEngineState(planned.plan.engine), true)

  // planPortableImport clones before normalizing: the uploaded bundle keeps its original shape.
  assert.deepEqual(incoming, before)
  assert.equal(incoming.shared.activeOption, null)
  assert.equal(Object.prototype.hasOwnProperty.call(incoming.engine.save.selfGoodDatas, 'food'), false)

  // A genuinely invalid type keeps the original server rejection semantics.
  const invalid = clone(fixtures.bundle)
  invalid.shared.gameSaveDatas.travel_china = 'x'
  invalid.engine.save.gameSaveDatas.travel_china = 'x'
  const rejected = planPortableImport({
    bundle: invalid,
    current: {
      petId: 'pet-0001',
      authorityId: 'authority-server-0001',
      restoreGeneration: 0,
      epoch: 0,
      handoffEpoch: null,
      owner: 'server',
      state: 'active',
      handoffId: 'handoff-server-0001',
      detachedAtMs: null,
      sourceRevision: null,
      sourceEventSeq: null,
    },
    wallNowMs: GAME_TIME_MS,
    allowClamp: true,
    resumeMode: false,
    uploaderDeviceId: 'server-device-0001',
    rebindLocalSessions: true,
    destinationHasNoAppliedCommands: true,
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'invalid_payload')
})
