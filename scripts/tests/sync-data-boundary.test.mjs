import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL &&
        /\/src\/shared\/(pet-runtime|sync)\//.test(context.parentURL) &&
        /\.[cm]?[jt]s$/.test(specifier) === false) {
      return nextResolve(specifier + '.ts', context)
    }
    return nextResolve(specifier, context)
  },
})

const {
  DEVICE_LOCAL_SETTINGS_KEYS,
  NEVER_UPLOAD_SETTING_KEYS,
  PRESENTATION_ONLY_SAVE_JSON_KEYS,
  SHARED_SAVE_JSON_BLOB_VALIDATORS,
  SHARED_SAVE_JSON_KEYS,
  SchemaError,
  assertCanonicalSaveJsonBlob,
  assertDeviceLocalOverlay,
  assertEngineState,
  assertGameSessionPayload,
  assertLocalPetDocumentV2,
  assertNoNeverUpload,
  assertPortablePetBundle,
  assertRemoteProjectionCacheV2,
  assertSharedSaveData,
  deserializePortablePetBundle,
  filterIslandCanonicalState,
  filterNeverUpload,
  filterSharedSaveJsonData,
  LEGACY_PORTABLE_BUNDLE_FORMAT,
  LEGACY_PORTABLE_BUNDLE_SCHEMA_VERSION,
  migrateLegacyLocalPetDocumentV2,
  migrateLegacySaveDataToPortableBundle,
  migratePortablePetBundle,
  projectExamSession,
  projectIslandQuizSession,
  serializePortablePetBundle,
  toSharedSaveData,
  validateDeviceLocalOverlay,
  validateEngineState,
  validateLocalPetDocumentV2,
  validatePortablePetBundle,
  validateRemoteProjectionCacheV2,
  validateSharedSaveData,
  validateSharedSaveJsonBlob,
  isJsonValue,
  isNonNegativeIntegerArray,
  isNumberArray,
  isStringArray,
} = await import('../../src/shared/sync/index.ts')
const {
  DAY_KEY,
  GAME_TIME_MS,
  LOCAL_DEVICE_ID,
  NEXT_BOUNDARY_MS,
  SEED,
  createSyncFixtures,
} = await import('./sync-fixtures.mjs')

const fixtures = createSyncFixtures()

const GOOD_BLOB = {
  id: '1001', name: '苹果', type: 'food', url: 'pet/img_res/food/1.gif', num: 1,
  hunger: 10, clean: 0, mood: 5, intel: 0, charm: 0, strong: 0, price: 10,
  needLevel: 0, PD: false, outOfPrint: false, desc: '', rectype: '',
}

const VALID_SAVE_JSON_BLOBS = {
  email: {
    '1700000000': { d: 1700000000, l: '欢迎', glb: [GOOD_BLOB], r: false, m: 'message', k: 'welcome' },
  },
  task: {
    doNums: { Eat: 1, Travel2: 0 },
    taskList: { daily: [{ take: false, good: [GOOD_BLOB] }], ddw: [], growth: [], travel: [] },
    daily: [{ label: 'Eat {n}', msg: '说明', obj: 'Eat', num: 2, keep: true, reroll: 1, good: ['_yb*10'] }],
    dailyDay: 1700000000,
  },
  signin: {
    collectionList: { '2026': { '10': [1700000000] } },
    getGrowth: [[1, 2, 3], null],
    onlineGiftNum: 1,
    isOnlineLastTime: 20,
    getBirthDayGift: true,
  },
  fishs: {
    PD: { allvipcnt: 2, canusecnt: 1 },
    fishs: [{
      id: 1, fryid: 1, name: '小鱼', stage: 1, time: 0, interval: 3600, costyb: 10,
      YB: 20, quantity: 1, basequantity: 1, avatar: 1, AIXIN: 0, growth: 0, strong: 0,
      iq: 0, charm: 0, born: 1700000000, siLiao: 0,
    }],
  },
  farm: {
    house: 'house', kennel: 'kennel', fence: 'fence', experience: 24, rank: 1,
    burden: [{ name: '白萝卜种子', Items: 'RadishSeed', number: 10 }],
    warehouse: [{ fruit: 'Radish', number: 24, name: '白萝卜', price: 18 }],
    farmland: [
      {
        farmland: 'FarmlandS', crop: 'RadishSeed', time: 1700000000, harvest: 'xx',
        state: 6, growth: '收获果实24个,还剩24个', progress: 1, yield: 24, grass: 1, worm: 1,
      },
      { farmland: 'Wasteland' },
    ],
    weather: 'Sunny', username: '主人', wealth: 100, checked: 1700000000,
  },
  activity: 0,
  album: [{ id: 'photo-1', city: '北京', d: 1700000000 }],
  island: {
    day: 1700000000, sent: 1, letter: 'npc-1', lit: ['npc-1'],
    lamps: [3], tier: 1, pieces: 2, piece: true, want: '1001', loved: true,
    errands: [{ from: 'npc-1', kind: 'talk', to: 'npc-2', got: 0, took: false }],
    fought: ['monster-1'], wins: 2,
  },
}

function expectSchemaCode(fn, code) {
  assert.throws(fn, error => error instanceof SchemaError && error.code === code)
}

test('shared save filtering removes device fields, local settings and local-only blobs', () => {
  assert.deepEqual([...PRESENTATION_ONLY_SAVE_JSON_KEYS].sort(), ['community', 'weather'])
  assert.equal(PRESENTATION_ONLY_SAVE_JSON_KEYS.some(key => key === 'email'), false)
  assert.equal(validateSharedSaveData(fixtures.shared), true)
  assertSharedSaveData(fixtures.shared)
  assert.equal(Object.prototype.hasOwnProperty.call(fixtures.shared.petInfo, 'lastX'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(fixtures.shared.petInfo, 'lastY'), false)
  assert.deepEqual(Object.keys(fixtures.shared.settings).sort(), ['difficulty', 'paused', 'undying'])
  assert.equal(Object.prototype.hasOwnProperty.call(fixtures.shared.settings, 'aiKey'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(fixtures.shared.settings, 'searchKey'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(fixtures.shared.settings, 'webhookToken'), false)

  const rebuilt = toSharedSaveData(fixtures.save)
  assertSharedSaveData(rebuilt)
  assert.equal(Object.prototype.hasOwnProperty.call(rebuilt.petInfo, 'lastX'), false)
  assert.equal(typeof fixtures.save.petInfo.lastX, 'number')
  assert.equal(Object.prototype.hasOwnProperty.call(rebuilt.saveJsonData, 'weather'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(rebuilt.saveJsonData, 'community'), false)

  const withDevicePosition = {
    ...fixtures.shared,
    petInfo: { ...fixtures.shared.petInfo, lastX: 10 },
  }
  assert.equal(validateSharedSaveData(withDevicePosition), false)
  expectSchemaCode(() => assertSharedSaveData(withDevicePosition), 'forbidden_field')

  const withLocalSecret = {
    ...fixtures.shared,
    settings: { ...fixtures.shared.settings, aiKey: 'sk-secret' },
  }
  assert.equal(validateSharedSaveData(withLocalSecret), false)
  expectSchemaCode(() => assertSharedSaveData(withLocalSecret), 'forbidden_field')

  const withLocalBlob = {
    ...fixtures.shared,
    saveJsonData: { ...fixtures.shared.saveJsonData, weather: '{"shown":true}' },
  }
  assert.equal(validateSharedSaveData(withLocalBlob), false)
  expectSchemaCode(() => assertSharedSaveData(withLocalBlob), 'forbidden_field')

  const withInvalidBlob = {
    ...fixtures.shared,
    saveJsonData: { ...fixtures.shared.saveJsonData, task: '{bad json' },
  }
  assert.equal(validateSharedSaveData(withInvalidBlob), false)

  const withAnswerKey = {
    ...fixtures.shared,
    activeOption: { ...fixtures.shared.activeOption, answerIndex: 1 },
  }
  assert.equal(validateSharedSaveData(withAnswerKey), false)
  expectSchemaCode(() => assertSharedSaveData(withAnswerKey), 'forbidden_field')
})

test('device overlay retains canonical local identity and secrets locally', () => {
  assert.equal(validateDeviceLocalOverlay(fixtures.device), true)
  assertDeviceLocalOverlay(fixtures.device)
  assert.equal(fixtures.device.localDeviceId, LOCAL_DEVICE_ID)
  assert.deepEqual(Object.keys(fixtures.device.settings).sort(), [...DEVICE_LOCAL_SETTINGS_KEYS].sort())
  for (const key of NEVER_UPLOAD_SETTING_KEYS) {
    assert.equal(Object.prototype.hasOwnProperty.call(fixtures.device.settings, key), true, key + ' stays device-local')
  }
  assert.equal(fixtures.device.settings.aiKey, 'sk-test-secret')
  assert.equal(fixtures.device.settings.searchKey, 'search-test-secret')
  assert.equal(fixtures.device.settings.webhookToken, 'webhook-test-secret')
  assert.equal(validateDeviceLocalOverlay({
    ...fixtures.device,
    settings: { ...fixtures.device.settings, aiKey: 42 },
  }), false)
  assert.equal(JSON.stringify(fixtures.shared).includes('sk-test-secret'), false)
  assert.equal(JSON.stringify(fixtures.bundle).includes('sk-test-secret'), false)
  assert.equal(JSON.stringify(fixtures.bundle).includes('search-test-secret'), false)
  assert.equal(JSON.stringify(fixtures.bundle).includes('webhook-test-secret'), false)
  assert.throws(() => assertNoNeverUpload(fixtures.device), /never-upload field is forbidden/)

  const secretTree = {
    safe: { aiKey: 'a', searchKey: 'b', webhookToken: 'c', keep: 1 },
    list: [{ token: 'x', keep: true }],
  }
  const filtered = filterNeverUpload(secretTree)
  assert.deepEqual(filtered, { safe: { keep: 1 }, list: [{ keep: true }] })
  assert.equal(secretTree.safe.aiKey, 'a')
  assert.equal(secretTree.list[0].token, 'x')
})

test('engine, portable bundle and local document validate and round-trip canonically', () => {
  assert.equal(validateEngineState(fixtures.engine), true)
  assertEngineState(fixtures.engine)
  assert.equal(fixtures.engine.environment.weatherByDay[DAY_KEY].dayKey, DAY_KEY)
  assert.equal(fixtures.engine.importClamped, false)
  assert.equal(fixtures.engine.clockSkippedMs, 0)
  assert.equal(fixtures.engine.lastProcessedDayBoundaryKey, DAY_KEY)
  assert.equal(fixtures.engine.sessionCoverage[0].deviceId, LOCAL_DEVICE_ID)
  assert.equal(fixtures.engine.coverageReopen.survivors[0].localDeviceId, LOCAL_DEVICE_ID)
  const missingBoundaryField = { ...fixtures.engine }
  delete missingBoundaryField.importClamped
  assert.equal(validateEngineState(missingBoundaryField), false)
  const engineWithSecret = {
    ...fixtures.engine,
    save: {
      ...fixtures.engine.save,
      settings: { ...fixtures.engine.save.settings, aiKey: 'sk-secret' },
    },
  }
  assert.equal(validateEngineState(engineWithSecret), false)
  const weather = fixtures.engine.environment.weatherByDay[DAY_KEY]
  const weatherKeyMismatch = {
    ...fixtures.engine,
    environment: { ...fixtures.engine.environment, weatherByDay: { '2026-10-21': weather } },
  }
  assert.equal(validateEngineState(weatherKeyMismatch), false)

  assert.equal(validatePortablePetBundle(fixtures.bundle), true)
  assertPortablePetBundle(fixtures.bundle)
  const serialized = serializePortablePetBundle(fixtures.bundle)
  const decoded = deserializePortablePetBundle(serialized)
  assert.deepEqual(decoded, fixtures.bundle)
  assert.deepEqual(decoded.authority, fixtures.authority)
  assert.deepEqual(decoded.engine.rng, fixtures.engine.rng)
  assert.deepEqual(decoded.engine.gameSessions, fixtures.engine.gameSessions)
  assert.deepEqual(decoded.engine.environment, fixtures.engine.environment)
  assert.equal(decoded.engine.gameSessions.length, 3)
  assert.equal(serializePortablePetBundle(decoded), serialized)
  assert.equal(serializePortablePetBundle(fixtures.bundle), serialized)
  assert.equal(serialized.includes('answerIndex'), true)
  assert.equal(decoded.engine.gameSessions.find(session => session.payload.kind === 'exam').payload.questions[0].answerIndex, 1)

  assert.equal(validateLocalPetDocumentV2(fixtures.localDocument), true)
  assertLocalPetDocumentV2(fixtures.localDocument)
  assert.equal(Object.prototype.hasOwnProperty.call(fixtures.localDocument.runtime, 'localDeviceId'), false)
  assert.equal(fixtures.localDocument.device.localDeviceId, fixtures.localDocument.bundle.originLocalDeviceId)
  const serverAuthority = { ...fixtures.authority, owner: 'server', authorityId: 'authority-server-origin' }
  const serverOriginBundle = { ...fixtures.bundle, authority: serverAuthority }
  assertPortablePetBundle(serverOriginBundle)
  assert.equal(validateLocalPetDocumentV2({
    ...fixtures.localDocument,
    revision: serverAuthority.revision,
    eventSeq: serverAuthority.eventSeq,
    authority: { state: 'handoff_pending', stamp: serverAuthority },
    bundle: serverOriginBundle,
  }), true)
  assert.equal(validateLocalPetDocumentV2({
    ...fixtures.localDocument,
    revision: serverAuthority.revision,
    eventSeq: serverAuthority.eventSeq,
    authority: { state: 'active', stamp: serverAuthority },
    bundle: serverOriginBundle,
  }), false)
  expectSchemaCode(() => assertLocalPetDocumentV2({
    ...fixtures.localDocument,
    revision: serverAuthority.revision,
    eventSeq: serverAuthority.eventSeq,
    authority: { state: 'active', stamp: serverAuthority },
    bundle: serverOriginBundle,
  }), 'identity_mismatch')
  const serverOriginWithoutProvenance = { ...serverOriginBundle }
  delete serverOriginWithoutProvenance.originLocalDeviceId
  assertPortablePetBundle(serverOriginWithoutProvenance)
  assert.equal(validateLocalPetDocumentV2({
    ...fixtures.localDocument,
    revision: serverAuthority.revision,
    eventSeq: serverAuthority.eventSeq,
    authority: { state: 'handoff_pending', stamp: serverAuthority },
    bundle: serverOriginWithoutProvenance,
  }), true)
  const localOwnerWithoutOrigin = { ...fixtures.bundle }
  delete localOwnerWithoutOrigin.originLocalDeviceId
  assert.equal(validatePortablePetBundle(localOwnerWithoutOrigin), false)
  expectSchemaCode(() => assertPortablePetBundle(localOwnerWithoutOrigin), 'missing_field')
  const missingOriginBundle = { ...fixtures.bundle }
  delete missingOriginBundle.originLocalDeviceId
  assert.equal(validateLocalPetDocumentV2({ ...fixtures.localDocument, bundle: missingOriginBundle }), false)
  expectSchemaCode(() => assertLocalPetDocumentV2({ ...fixtures.localDocument, bundle: missingOriginBundle }), 'missing_field')
  const conflictingAuthority = { ...fixtures.authority, epoch: fixtures.authority.epoch + 1 }
  assert.equal(validateLocalPetDocumentV2({
    ...fixtures.localDocument,
    authority: { ...fixtures.localDocument.authority, stamp: conflictingAuthority },
  }), false)
  expectSchemaCode(() => assertLocalPetDocumentV2({
    ...fixtures.localDocument,
    authority: { ...fixtures.localDocument.authority, stamp: conflictingAuthority },
  }), 'identity_mismatch')
  for (const [field, value] of [
    ['authorityId', 'authority-other'],
    ['owner', 'server'],
    ['epoch', fixtures.authority.epoch + 1],
    ['restoreGeneration', fixtures.authority.restoreGeneration + 1],
    ['revision', fixtures.authority.revision + 1],
    ['eventSeq', fixtures.authority.eventSeq + 1],
    ['handoffId', 'handoff-other'],
    ['detachedAtWallMs', fixtures.authority.detachedAtWallMs + 1],
  ]) {
    const stamp = { ...fixtures.authority, [field]: value }
    expectSchemaCode(() => assertLocalPetDocumentV2({
      ...fixtures.localDocument,
      authority: { state: 'active', stamp },
    }), 'identity_mismatch')
  }
  const conflictingOriginBundle = { ...fixtures.bundle, originLocalDeviceId: 'other-device-id' }
  assert.equal(validateLocalPetDocumentV2({ ...fixtures.localDocument, bundle: conflictingOriginBundle }), false)
  expectSchemaCode(() => assertLocalPetDocumentV2({ ...fixtures.localDocument, bundle: conflictingOriginBundle }), 'identity_mismatch')
  assert.equal(validateRemoteProjectionCacheV2(fixtures.remoteCache), true)
  assertRemoteProjectionCacheV2(fixtures.remoteCache)
  assertGameSessionPayload(fixtures.examSession.payload)
  assertGameSessionPayload(fixtures.quizSession.payload)
  expectSchemaCode(() => assertGameSessionPayload({
    ...fixtures.examSession.payload,
    questions: [{ ...fixtures.examSession.payload.questions[0], answerIndex: 99 }],
  }), 'invalid_schema')
  expectSchemaCode(() => assertGameSessionPayload({ ...fixtures.examSession.payload, extra: true }), 'forbidden_field')
  const duplicateLocalId = {
    ...fixtures.localDocument,
    runtime: { ...fixtures.localDocument.runtime, localDeviceId: 'duplicate-device-id' },
  }
  assert.equal(validateLocalPetDocumentV2(duplicateLocalId), false)
})

test('portable schema and format versions are rejected before migration', () => {
  const nextBundle = { ...fixtures.bundle, schemaVersion: 2 }
  assert.equal(validatePortablePetBundle(nextBundle), false)
  expectSchemaCode(() => migratePortablePetBundle(nextBundle), 'unsupported_schema_version')
  expectSchemaCode(() => deserializePortablePetBundle(JSON.stringify(nextBundle)), 'unsupported_schema_version')
  expectSchemaCode(() => assertPortablePetBundle({ ...fixtures.bundle, format: 'other-format' }), 'unsupported_format')

  const badEngine = { ...fixtures.engine, schemaVersion: 2 }
  const badEngineBundle = { ...fixtures.bundle, engine: badEngine }
  assert.equal(validatePortablePetBundle(badEngineBundle), false)
  expectSchemaCode(() => assertPortablePetBundle(badEngineBundle), 'unsupported_schema_version')

  const mismatch = { ...fixtures.bundle, shared: { ...fixtures.shared, havePet: false } }
  assert.equal(validatePortablePetBundle(mismatch), false)
  expectSchemaCode(() => assertPortablePetBundle(mismatch), 'invalid_schema')
  expectSchemaCode(() => deserializePortablePetBundle('{bad json'), 'invalid_schema')

  const badLocal = { ...fixtures.localDocument, schemaVersion: 2 }
  assert.equal(validateLocalPetDocumentV2(badLocal), false)
  expectSchemaCode(() => assertLocalPetDocumentV2(badLocal), 'unsupported_schema_version')
  const badRemote = { ...fixtures.remoteCache, schemaVersion: 2 }
  assert.equal(validateRemoteProjectionCacheV2(badRemote), false)
  expectSchemaCode(() => assertRemoteProjectionCacheV2(badRemote), 'unsupported_schema_version')
})

test('exam and island-quiz projections never expose canonical answer keys', () => {
  const exam = projectExamSession(fixtures.examSession)
  assert.deepEqual(exam.questions[0], {
    questionId: 'q-1',
    prompt: '1 + 1 = ?',
    options: ['1', '2', '3'],
  })
  assert.equal(Object.prototype.hasOwnProperty.call(exam.questions[0], 'answerIndex'), false)
  assert.equal(JSON.stringify(exam).includes('answerIndex'), false)

  const quiz = projectIslandQuizSession(fixtures.quizSession)
  assert.deepEqual(quiz, {
    sessionToken: 'quiz-token-0001',
    recordId: 'record-0001',
    quizKind: 'riddle',
    prompt: '谁的尾巴长？',
    options: ['企鹅', '兔子', '大象'],
  })
  assert.equal(Object.prototype.hasOwnProperty.call(quiz, 'answerIndex'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(quiz, 'metadata'), false)
  assert.equal(JSON.stringify(quiz).includes('answerIndex'), false)
  assert.throws(() => projectExamSession(fixtures.gameSession), /session kind mismatch/)
  assert.equal(Object.prototype.hasOwnProperty.call(fixtures.shared, 'gameSessions'), false)
  assert.equal(JSON.stringify(fixtures.shared).includes('answerIndex'), false)
})

test('saveJsonData per-blob validators reject unknown fields and nested secrets', () => {
  assert.deepEqual(Object.keys(SHARED_SAVE_JSON_BLOB_VALIDATORS).sort(), [...SHARED_SAVE_JSON_KEYS].sort())
  const jsonBlobs = Object.fromEntries(
    Object.entries(VALID_SAVE_JSON_BLOBS).map(([key, value]) => [key, JSON.stringify(value)]),
  )
  const sharedWithValidBlobs = { ...fixtures.shared, saveJsonData: jsonBlobs }
  assert.equal(validateSharedSaveData(sharedWithValidBlobs), true)
  for (const key of SHARED_SAVE_JSON_KEYS) {
    assert.equal(validateSharedSaveJsonBlob(key, jsonBlobs[key]), true, key)
    assert.doesNotThrow(() => assertCanonicalSaveJsonBlob(key, jsonBlobs[key]), key)

    const sample = VALID_SAVE_JSON_BLOBS[key]
    let invalid
    if (Array.isArray(sample)) invalid = [{ ...sample[0], unknownCanonicalField: true }]
    else if (sample !== null && typeof sample === 'object') invalid = { ...sample, unknownCanonicalField: true }
    else invalid = { unexpected: true }
    assert.equal(validateSharedSaveJsonBlob(key, JSON.stringify(invalid)), false, key + ' unknown field')
  }

  assert.equal(validateSharedSaveJsonBlob('task', JSON.stringify({
    ...VALID_SAVE_JSON_BLOBS.task,
    daily: [{ ...VALID_SAVE_JSON_BLOBS.task.daily[0], unknownCanonicalField: true }],
  })), false)
  assert.equal(validateSharedSaveJsonBlob('email', JSON.stringify({
    '1700000000': { ...VALID_SAVE_JSON_BLOBS.email['1700000000'], unknownCanonicalField: true },
  })), false)
  assert.equal(validateSharedSaveJsonBlob('fishs', JSON.stringify({
    ...VALID_SAVE_JSON_BLOBS.fishs,
    fishs: [{ ...VALID_SAVE_JSON_BLOBS.fishs.fishs[0], unknownCanonicalField: true }],
  })), false)
  assert.equal(validateSharedSaveJsonBlob('farm', JSON.stringify({
    ...VALID_SAVE_JSON_BLOBS.farm,
    farmland: [{ ...VALID_SAVE_JSON_BLOBS.farm.farmland[0], unknownCanonicalField: true }],
  })), false)
  assert.equal(validateSharedSaveJsonBlob('farm', JSON.stringify({
    ...VALID_SAVE_JSON_BLOBS.farm,
    burden: [{ ...VALID_SAVE_JSON_BLOBS.farm.burden[0], unknownCanonicalField: true }],
  })), false)
  assert.equal(validateSharedSaveJsonBlob('farm', JSON.stringify({
    ...VALID_SAVE_JSON_BLOBS.farm,
    warehouse: [{ ...VALID_SAVE_JSON_BLOBS.farm.warehouse[0], unknownCanonicalField: true }],
  })), false)
  assert.equal(validateSharedSaveJsonBlob('farm', JSON.stringify({
    ...VALID_SAVE_JSON_BLOBS.farm,
    farmland: [{ ...VALID_SAVE_JSON_BLOBS.farm.farmland[0], harvest: { prose: 'not canonical' } }],
  })), false)
  assert.equal(validateSharedSaveJsonBlob('island', JSON.stringify({
    ...VALID_SAVE_JSON_BLOBS.island,
    errands: [{ ...VALID_SAVE_JSON_BLOBS.island.errands[0], unknownCanonicalField: true }],
  })), false)
  assert.equal(validateSharedSaveJsonBlob('signin', JSON.stringify({
    collectionList: { '2026': { '13': [1700000000] } },
  })), false)

  const withTaskAiKey = {
    ...fixtures.shared,
    saveJsonData: { ...jsonBlobs, task: JSON.stringify({ ...VALID_SAVE_JSON_BLOBS.task, aiKey: 'secret' }) },
  }
  assert.equal(validateSharedSaveData(withTaskAiKey), false)
  expectSchemaCode(() => assertSharedSaveData(withTaskAiKey), 'forbidden_field')

  const withTaskAnswerIndex = {
    ...fixtures.shared,
    saveJsonData: { ...jsonBlobs, task: JSON.stringify({ ...VALID_SAVE_JSON_BLOBS.task, answerIndex: 0 }) },
  }
  assert.equal(validateSharedSaveData(withTaskAnswerIndex), false)
  expectSchemaCode(() => assertSharedSaveData(withTaskAnswerIndex), 'forbidden_field')

  const nestedSecret = JSON.stringify({ aiKey: 'nested-secret' })
  const withNestedTaskSecret = {
    ...fixtures.shared,
    saveJsonData: {
      ...jsonBlobs,
      task: JSON.stringify({
        ...VALID_SAVE_JSON_BLOBS.task,
        daily: [{ ...VALID_SAVE_JSON_BLOBS.task.daily[0], label: nestedSecret }],
      }),
    },
  }
  assert.equal(validateSharedSaveData(withNestedTaskSecret), false)
  expectSchemaCode(() => assertSharedSaveData(withNestedTaskSecret), 'forbidden_field')

  let tooDeep = JSON.stringify({ aiKey: 'deep-secret' })
  for (let depth = 0; depth < 6; depth++) tooDeep = JSON.stringify(tooDeep)
  assert.equal(validateSharedSaveJsonBlob('island', JSON.stringify({
    ...VALID_SAVE_JSON_BLOBS.island,
    note: tooDeep,
  })), false)

  const unknownBlobShared = {
    ...fixtures.shared,
    saveJsonData: { ...fixtures.shared.saveJsonData, evilBlob: '{}' },
  }
  assert.equal(validateSharedSaveData(unknownBlobShared), false)
  expectSchemaCode(() => assertSharedSaveData(unknownBlobShared), 'forbidden_field')
  expectSchemaCode(() => toSharedSaveData({
    ...fixtures.save,
    saveJsonData: { ...fixtures.save.saveJsonData, evilBlob: '{}' },
  }), 'forbidden_field')
})

test('island prose is filtered while canonical island decisions are preserved', () => {
  const rawIsland = JSON.parse(fixtures.save.saveJsonData.island)
  assert.equal(rawIsland.news.length, 1)
  assert.equal(typeof rawIsland.note, 'string')
  assert.equal(typeof rawIsland.errands[0].ask, 'string')

  const filteredIsland = filterIslandCanonicalState(rawIsland)
  assert.equal(Object.prototype.hasOwnProperty.call(filteredIsland, 'news'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(filteredIsland, 'note'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(filteredIsland.errands[0], 'ask'), false)
  assert.deepEqual(filteredIsland.lit, rawIsland.lit)
  assert.deepEqual(filteredIsland.lamps, rawIsland.lamps)
  assert.deepEqual(filteredIsland.errands[0], {
    from: 'npc-0001', kind: 'talk', to: 'npc-0002', got: 0, took: false,
  })

  const filteredBlobs = filterSharedSaveJsonData(fixtures.save.saveJsonData)
  assert.equal(Object.prototype.hasOwnProperty.call(filteredBlobs, 'community'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(filteredBlobs, 'weather'), false)
  const sharedIsland = JSON.parse(filteredBlobs.island)
  assert.equal(Object.prototype.hasOwnProperty.call(sharedIsland, 'news'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(sharedIsland, 'note'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(sharedIsland.errands[0], 'ask'), false)

  assert.equal(validateSharedSaveJsonBlob('island', JSON.stringify({ ...VALID_SAVE_JSON_BLOBS.island, note: 'AI prose' })), false)
  const rawIslandShared = {
    ...fixtures.shared,
    saveJsonData: { ...fixtures.shared.saveJsonData, island: JSON.stringify(rawIsland) },
  }
  assert.equal(validateSharedSaveData(rawIslandShared), false)
  expectSchemaCode(() => assertSharedSaveData(rawIslandShared), 'forbidden_field')

  const rebuilt = toSharedSaveData(fixtures.save)
  const rebuiltIsland = JSON.parse(rebuilt.saveJsonData.island)
  assert.equal(Object.prototype.hasOwnProperty.call(rebuiltIsland, 'news'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(rebuiltIsland, 'note'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(rebuiltIsland.errands[0], 'ask'), false)

  const badShared = {
    ...fixtures.shared,
    saveJsonData: { ...fixtures.shared.saveJsonData, island: JSON.stringify(rawIsland) },
  }
  const badBundle = {
    ...fixtures.bundle,
    shared: badShared,
    engine: { ...fixtures.engine, save: badShared },
  }
  assert.equal(validatePortablePetBundle(badBundle), false)
  assert.equal(serializePortablePetBundle(fixtures.bundle).includes('AI generated ask prose'), false)
  assert.equal(serializePortablePetBundle(fixtures.bundle).includes('AI generated news prose'), false)
})

test('strict JSON-value helpers reject accessors, symbols, sparse arrays and extra properties', () => {
  assert.equal(isJsonValue(new Date(0)), false)

  let getterReads = 0
  const getterObject = {}
  Object.defineProperty(getterObject, 'value', {
    enumerable: true,
    get() {
      getterReads++
      return 1
    },
  })
  assert.equal(isJsonValue(getterObject), false)
  assert.equal(getterReads, 0)

  const sparse = []
  sparse.length = 2
  sparse[1] = 'value'
  assert.equal(isJsonValue(sparse), false)
  assert.equal(isStringArray(sparse), false)

  const extraArrayProperty = [1, 2]
  extraArrayProperty.extra = true
  assert.equal(isJsonValue(extraArrayProperty), false)
  assert.equal(isNumberArray(extraArrayProperty), false)

  const nonEnumerable = { visible: 1 }
  Object.defineProperty(nonEnumerable, 'hidden', { value: 2, enumerable: false })
  assert.equal(isJsonValue(nonEnumerable), false)

  const withSymbol = { visible: 1 }
  Object.defineProperty(withSymbol, Symbol('hidden'), { value: 2, enumerable: true })
  assert.equal(isJsonValue(withSymbol), false)

  const accessorArray = ['a']
  Object.defineProperty(accessorArray, '0', {
    enumerable: true,
    get() {
      getterReads++
      return 'a'
    },
  })
  assert.equal(isStringArray(accessorArray), false)
  assert.equal(getterReads, 0)

  assert.equal(isStringArray(['a', 'b']), true)
  assert.equal(isNumberArray([1, 2.5]), true)
  assert.equal(isNonNegativeIntegerArray([0, 1, 2]), true)
})

test('legacy bare SaveData and config.json migrate deterministically into v1 bundles', () => {
  const options = {
    nowMs: GAME_TIME_MS,
    seedHex: SEED,
    authority: fixtures.authority,
    localDeviceId: LOCAL_DEVICE_ID,
    timeZone: 'Asia/Shanghai',
    advanceWhileEmpty: true,
    weatherLocation: 'Shanghai',
  }
  const bundled = migrateLegacySaveDataToPortableBundle(fixtures.save, options)
  assertPortablePetBundle(bundled)
  assert.deepEqual(bundled.authority, fixtures.authority)
  assert.equal(bundled.format, 'qqpet-portable-v1')
  assert.equal(bundled.schemaVersion, 1)
  assert.equal(bundled.exportedAtWallMs, GAME_TIME_MS)
  assert.equal(bundled.originLocalDeviceId, LOCAL_DEVICE_ID)
  assert.equal(bundled.engine.gameTimeMs, GAME_TIME_MS)
  assert.equal(bundled.engine.lastSchedulerWallMs, GAME_TIME_MS)
  assert.equal(bundled.engine.lastProcessedDayBoundaryKey, DAY_KEY)
  assert.equal(bundled.engine.nextDailyBoundaryMs, NEXT_BOUNDARY_MS)
  assert.equal(bundled.engine.importClamped, false)
  assert.equal(bundled.engine.clockSkippedMs, 0)
  assert.equal(bundled.engine.rng.seedHex, SEED)
  assert.deepEqual(bundled.engine.gameSessions, [])
  assert.deepEqual(bundled.engine.environment, { calendarByDay: {}, weatherByDay: {} })
  assert.equal(JSON.stringify(bundled.shared).includes('AI generated ask prose'), false)
  const repeated = migrateLegacySaveDataToPortableBundle(fixtures.save, options)
  assert.equal(serializePortablePetBundle(repeated), serializePortablePetBundle(bundled))
  const frozen = migrateLegacySaveDataToPortableBundle(fixtures.save, { ...options, advanceWhileEmpty: false })
  assert.equal(frozen.engine.advanceWhileEmpty, false)

  const configBundled = migrateLegacySaveDataToPortableBundle({ petInfoData: fixtures.save }, {
    ...options,
    advanceWhileEmpty: undefined,
  })
  assert.equal(configBundled.engine.advanceWhileEmpty, true)
  assert.equal(serializePortablePetBundle(configBundled).includes('"aiKey"'), false)

  const realLegacyConfig = {
    machineId: 'outer-machine',
    oId: 'outer-owner',
    petInfoData: {
      ...fixtures.save,
      machineId: 'legacy-machine-id',
      oId: 'legacy-owner-id',
    },
  }
  const normalizedConfigBundle = migrateLegacySaveDataToPortableBundle(realLegacyConfig, options)
  const normalizedConfigText = serializePortablePetBundle(normalizedConfigBundle)
  assert.equal(normalizedConfigText.includes('legacy-machine-id'), false)
  assert.equal(normalizedConfigText.includes('legacy-owner-id'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(normalizedConfigBundle.shared, 'machineId'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(normalizedConfigBundle.shared, 'oId'), false)
  assert.equal(realLegacyConfig.petInfoData.machineId, 'legacy-machine-id')
  const directLegacyBundle = migrateLegacySaveDataToPortableBundle({
    ...fixtures.save,
    machineId: 'direct-machine-id',
    oId: 'direct-owner-id',
  }, options)
  assert.equal(serializePortablePetBundle(directLegacyBundle).includes('direct-machine-id'), false)
  assert.equal(serializePortablePetBundle(directLegacyBundle).includes('direct-owner-id'), false)
  expectSchemaCode(() => migrateLegacySaveDataToPortableBundle(fixtures.save, {
    ...options,
    seedHex: '0'.repeat(32),
  }), 'invalid_schema')
})

test('portable v0 bundles migrate once while preserving scheduler anchors', () => {
  const engineV0 = JSON.parse(JSON.stringify(fixtures.engine))
  delete engineV0.schemaVersion
  delete engineV0.lastProcessedDayBoundaryKey
  delete engineV0.nextDailyBoundaryMs
  delete engineV0.importClamped
  delete engineV0.clockSkippedMs
  const bundleV0 = {
    format: LEGACY_PORTABLE_BUNDLE_FORMAT,
    schemaVersion: LEGACY_PORTABLE_BUNDLE_SCHEMA_VERSION,
    exportedAtMs: GAME_TIME_MS,
    authority: fixtures.authority,
    originLocalDeviceId: LOCAL_DEVICE_ID,
    shared: fixtures.shared,
    engine: engineV0,
  }
  assert.equal(validatePortablePetBundle(bundleV0), false)
  const migrated = migratePortablePetBundle(bundleV0)
  assertPortablePetBundle(migrated)
  assert.equal(migrated.format, 'qqpet-portable-v1')
  assert.equal(migrated.schemaVersion, 1)
  assert.equal(migrated.exportedAtWallMs, GAME_TIME_MS)
  assert.equal(migrated.engine.schemaVersion, 1)
  assert.equal(migrated.engine.gameTimeMs, fixtures.engine.gameTimeMs)
  assert.equal(migrated.engine.lastSchedulerWallMs, fixtures.engine.lastSchedulerWallMs)
  assert.equal(migrated.engine.lastProcessedDayBoundaryKey, DAY_KEY)
  assert.equal(migrated.engine.nextDailyBoundaryMs, NEXT_BOUNDARY_MS)
  assert.equal(migrated.engine.importClamped, false)
  assert.equal(migrated.engine.clockSkippedMs, 0)
  assert.deepEqual(deserializePortablePetBundle(JSON.stringify(bundleV0)), migrated)
  expectSchemaCode(() => migratePortablePetBundle({ ...bundleV0, schemaVersion: 3 }), 'unsupported_schema_version')
  expectSchemaCode(() => migratePortablePetBundle({ ...bundleV0, format: 'qqpet-portable-v9' }), 'unsupported_format')
})

test('legacy local v2 duplicate localDeviceId migrates only when canonical identity matches', () => {
  const duplicate = {
    ...fixtures.localDocument,
    runtime: { ...fixtures.localDocument.runtime, localDeviceId: LOCAL_DEVICE_ID },
  }
  const migrated = migrateLegacyLocalPetDocumentV2(duplicate)
  assert.equal(validateLocalPetDocumentV2(migrated), true)
  assert.equal(Object.prototype.hasOwnProperty.call(migrated.runtime, 'localDeviceId'), false)
  assert.deepEqual(migrated.runtime, fixtures.localDocument.runtime)
  assert.equal(duplicate.runtime.localDeviceId, LOCAL_DEVICE_ID)

  const conflicting = {
    ...fixtures.localDocument,
    runtime: { ...fixtures.localDocument.runtime, localDeviceId: 'different-device-id' },
  }
  expectSchemaCode(() => migrateLegacyLocalPetDocumentV2(conflicting), 'identity_mismatch')
  assert.equal(conflicting.runtime.localDeviceId, 'different-device-id')

  const unchanged = migrateLegacyLocalPetDocumentV2(fixtures.localDocument)
  assert.deepEqual(unchanged, fixtures.localDocument)
  const missingOriginBundle = { ...fixtures.bundle }
  delete missingOriginBundle.originLocalDeviceId
  assert.equal(validateLocalPetDocumentV2({ ...fixtures.localDocument, bundle: missingOriginBundle }), false)
})

test('recursive forbidden scans cover non-blob shared/engine data and nested JSON strings', () => {
  const dirtyShared = {
    ...fixtures.shared,
    activeOption: { ...fixtures.shared.activeOption, note: '{"aiKey":"shared-secret"}' },
  }
  assert.equal(validateSharedSaveData(dirtyShared), false)
  expectSchemaCode(() => assertSharedSaveData(dirtyShared), 'forbidden_field')

  const dirtyEngine = JSON.parse(JSON.stringify(fixtures.engine))
  dirtyEngine.scheduledJobs[0].payload.note = '{"webhookToken":"engine-secret"}'
  assert.equal(validateEngineState(dirtyEngine), false)
  expectSchemaCode(() => assertEngineState(dirtyEngine), 'forbidden_field')

  const dirtyBundle = JSON.parse(JSON.stringify(fixtures.bundle))
  dirtyBundle.engine.scheduledJobs[0].payload.note = '{"webhookToken":"bundle-secret"}'
  assert.equal(validatePortablePetBundle(dirtyBundle), false)
  expectSchemaCode(() => assertPortablePetBundle(dirtyBundle), 'forbidden_field')
  expectSchemaCode(() => deserializePortablePetBundle(JSON.stringify(dirtyBundle)), 'forbidden_field')

  const dirtyLocal = {
    ...fixtures.localDocument,
    bundle: dirtyBundle,
    engine: undefined,
  }
  delete dirtyLocal.engine
  assert.equal(validateLocalPetDocumentV2(dirtyLocal), false)

  const dirtyFilterInput = {
    keep: { aiKey: 'remove-me', note: '{"webhookToken":"nested-secret","keep":1}' },
    list: [{ searchKey: 'remove-search', keep: true }],
  }
  const filtered = filterNeverUpload(dirtyFilterInput)
  assert.deepEqual(filtered, {
    keep: { note: '{"keep":1}' },
    list: [{ keep: true }],
  })
  assert.equal(dirtyFilterInput.keep.aiKey, 'remove-me')
  assert.equal(dirtyFilterInput.list[0].searchKey, 'remove-search')
})
