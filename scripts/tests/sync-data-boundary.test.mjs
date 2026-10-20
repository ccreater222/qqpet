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
  SchemaError,
  assertDeviceLocalOverlay,
  assertEngineState,
  assertGameSessionPayload,
  assertLocalPetDocumentV2,
  assertNoNeverUpload,
  assertPortablePetBundle,
  assertRemoteProjectionCacheV2,
  assertSharedSaveData,
  deserializePortablePetBundle,
  filterNeverUpload,
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
} = await import('../../src/shared/sync/index.ts')
const {
  DAY_KEY,
  LOCAL_DEVICE_ID,
  createSyncFixtures,
} = await import('./sync-fixtures.mjs')

const fixtures = createSyncFixtures()

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
  const serverOriginBundle = { ...fixtures.bundle }
  delete serverOriginBundle.originLocalDeviceId
  assert.equal(validateLocalPetDocumentV2({ ...fixtures.localDocument, bundle: serverOriginBundle }), true)
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
