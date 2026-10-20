import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
  COMMAND_ROLES,
  COMMAND_TYPES,
  COMMAND_PAYLOAD_VALIDATORS,
  CLIENT_MESSAGE_TYPES,
  DOMAIN_EVENT_TYPES,
  assertOrderedEventStream,
  PROTOCOL_VERSION,
  SERVER_MESSAGE_TYPES,
  parseClientMessage,
  parsePetCommand,
  projectExamSession,
  projectIslandQuizSession,
  parseServerMessage,
  validateCommandPayload,
} = await import('../../src/shared/sync/index.ts')
const { createSyncFixtures, DAY_KEY, GAME_TIME_MS } = await import('./sync-fixtures.mjs')

const fixtures = createSyncFixtures()

const EXPECTED_COMMANDS = [
  'pet.adopt', 'pet.reset', 'pet.bury', 'pet.rename', 'pet.setPaused', 'pet.pokeFace', 'pet.cheer',
  'inventory.buy', 'inventory.use', 'medical.treat', 'vip.buyPinkDiamond', 'vip.clearPinkDiamond',
  'vip.buySweetheart', 'vip.setSweetheart', 'travel.completeCollection', 'job.startWork',
  'job.startStudy', 'job.startTravel', 'activity.stop', 'task.claim', 'exam.start', 'exam.submit',
  'signin.sign', 'signin.drawGrowth', 'signin.claimOnlineGift', 'signin.claimBirthdayGift',
  'mail.claim', 'mail.claimAll', 'mail.delete', 'mail.deleteAll', 'game.startSession', 'game.reward',
  'diudiule.startSession', 'diudiule.reward', 'game.abandonSession', 'social.completeLanVisit',
  'island.arriveScene', 'island.acceptLetter', 'island.deliverLetter', 'island.turnInErrand',
  'island.startQuiz', 'island.answerQuiz', 'island.fightMonster', 'island.claimGrowthReward',
  'island.claimTreasure', 'island.giftNpc', 'island.talkNpc', 'island.visitSpot', 'island.chat',
  'island.playGame', 'island.refreshNews', 'fishing.buy', 'fishing.feed', 'fishing.harvest',
  'fishing.harvestAll', 'fishing.speedUp', 'farm.plant', 'farm.harvest', 'farm.care', 'farm.clear',
  'farm.buySeed', 'farm.sellProduce', 'settings.setShared', 'server.setAdvanceWhileEmpty',
  'server.setTimeZone', 'server.setWeatherCity', 'device.list', 'device.revoke',
  'admin.exportForDetach', 'admin.resumeServer', 'admin.importPortableBundle', 'admin.grantCheat',
  'admin.grantRandomGoods',
]

const VALID_PAYLOADS = {
  'pet.adopt': { sex: 'GG' },
  'pet.reset': {},
  'pet.bury': {},
  'pet.rename': { name: '新名字', host: '主人' },
  'pet.setPaused': { paused: true },
  'pet.pokeFace': { spotId: 'spot-1' },
  'pet.cheer': {},
  'inventory.buy': { type: 'food', itemId: '1001', quantity: 2 },
  'inventory.use': { type: 'food', itemId: '1001', quantity: 1 },
  'medical.treat': { mode: 'doctor', itemId: '10003' },
  'vip.buyPinkDiamond': { days: 30 },
  'vip.clearPinkDiamond': {},
  'vip.buySweetheart': { days: 30 },
  'vip.setSweetheart': { enabled: true },
  'travel.completeCollection': {},
  'job.startWork': { jobId: 'work-1' },
  'job.startStudy': { courseId: 'course-1' },
  'job.startTravel': {},
  'activity.stop': {},
  'task.claim': { tab: 'daily', index: 0 },
  'exam.start': { subject: '数学' },
  'exam.submit': { sessionToken: 'exam-token-0001', answers: [1, 1] },
  'signin.sign': {},
  'signin.drawGrowth': {},
  'signin.claimOnlineGift': {},
  'signin.claimBirthdayGift': {},
  'mail.claim': { mailId: 'mail-1' },
  'mail.claimAll': {},
  'mail.delete': { mailId: 'mail-1' },
  'mail.deleteAll': { scope: 'claimed' },
  'game.startSession': { gameId: 'smallgame-0001', kind: 'small' },
  'game.reward': { sessionToken: 'game-token-0001' },
  'diudiule.startSession': {},
  'diudiule.reward': { sessionToken: 'diudiule-token-0001' },
  'game.abandonSession': { sessionToken: 'game-token-0001' },
  'social.completeLanVisit': { peerId: 'peer-1', direction: 'incoming' },
  'island.arriveScene': { sceneId: 'scene-1' },
  'island.acceptLetter': { fromNpcId: 'npc-1', toNpcId: 'npc-2' },
  'island.deliverLetter': { toNpcId: 'npc-2' },
  'island.turnInErrand': { npcId: 'npc-1', errandId: 'errand-1', itemId: 'item-1' },
  'island.startQuiz': { npcId: 'npc-1', errandId: 'errand-1' },
  'island.answerQuiz': { sessionToken: 'quiz-token-0001', optionIndex: 2 },
  'island.fightMonster': { monsterId: 'monster-1', tactic: 'attack' },
  'island.claimGrowthReward': {},
  'island.claimTreasure': {},
  'island.giftNpc': { npcId: 'npc-1', itemId: 'item-1' },
  'island.talkNpc': { npcId: 'npc-1' },
  'island.visitSpot': { spotId: 'spot-1' },
  'island.chat': { npcId: 'npc-1' },
  'island.playGame': { gameKey: 'game-1' },
  'island.refreshNews': { dayKey: DAY_KEY },
  'fishing.buy': { fryId: 1, quantity: 2 },
  'fishing.feed': { fishId: 1 },
  'fishing.harvest': { fishId: 1 },
  'fishing.harvestAll': {},
  'fishing.speedUp': {},
  'farm.plant': { seedId: 'seed-1', plotIds: [0, 1] },
  'farm.harvest': { plotIds: [0, 1] },
  'farm.care': { plotIds: [0], action: 'water' },
  'farm.clear': { plotIds: [0] },
  'farm.buySeed': { seedId: 'seed-1', quantity: 2 },
  'farm.sellProduce': { itemId: 'produce-1', quantity: 1 },
  'settings.setShared': { key: 'difficulty', value: 'standard' },
  'server.setAdvanceWhileEmpty': { enabled: true },
  'server.setTimeZone': { timeZone: 'America/New_York' },
  'server.setWeatherCity': { city: 'Shanghai' },
  'device.list': {},
  'device.revoke': { deviceId: 'server-device-0001' },
  'admin.exportForDetach': {},
  'admin.resumeServer': {
    expectedEpoch: 2,
    bundle: fixtures.bundle,
    allowClamp: false,
    rebindLocalSessions: true,
  },
  'admin.importPortableBundle': {
    bundle: fixtures.bundle,
    allowClamp: true,
    rebindLocalSessions: false,
  },
  'admin.grantCheat': { stat: 'yb', amount: 1000 },
  'admin.grantRandomGoods': { type: 'food', quantity: 2 },
}

const OWNER_COMMANDS = [
  'pet.adopt', 'pet.reset', 'server.setAdvanceWhileEmpty', 'server.setTimeZone', 'server.setWeatherCity',
  'device.list', 'device.revoke', 'admin.importPortableBundle', 'admin.exportForDetach',
  'admin.resumeServer', 'admin.grantCheat', 'admin.grantRandomGoods',
]

function invalidPayload(payload) {
  const keys = Object.keys(payload)
  if (keys.length === 0) return { unexpected: true }
  return { ...payload, [keys[0]]: null }
}

test('the complete normative command catalog is present and every payload validates', () => {
  const spec = readFileSync(new URL('../../docs/superpowers/specs/2026-10-20-local-or-server-pet-data-design.md', import.meta.url), 'utf8')
  const payloadMapBlock = spec.split('export interface CommandPayloadMap {', 2)[1].split('\n}', 1)[0]
  const specCommands = [...payloadMapBlock.matchAll(/^\s*'([^']+)':/gm)].map(match => match[1])
  assert.equal(COMMAND_TYPES.length, 73)
  assert.deepEqual([...COMMAND_TYPES].sort(), specCommands.sort())
  assert.deepEqual([...COMMAND_TYPES].sort(), [...EXPECTED_COMMANDS].sort())
  assert.deepEqual(Object.keys(VALID_PAYLOADS).sort(), [...EXPECTED_COMMANDS].sort())
  const ownerSet = new Set(OWNER_COMMANDS)
  for (const commandType of COMMAND_TYPES) {
    assert.equal(typeof COMMAND_PAYLOAD_VALIDATORS[commandType], 'function')
    assert.equal(COMMAND_ROLES[commandType], ownerSet.has(commandType) ? 'owner' : 'player', commandType)
    const valid = VALID_PAYLOADS[commandType]
    assert.equal(validateCommandPayload(commandType, valid), true, commandType + ' valid payload')
    const parsed = parsePetCommand({ type: commandType, payload: valid })
    assert.equal(parsed.ok, true, commandType + ' command envelope')
    assert.deepEqual(parsed.command, { type: commandType, payload: valid })
    assert.equal(validateCommandPayload(commandType, invalidPayload(valid)), false, commandType + ' invalid payload')
    assert.equal(validateCommandPayload(commandType, { ...valid, unexpected: true }), false, commandType + ' extra payload field')
    assert.equal(parsePetCommand({ type: commandType, payload: invalidPayload(valid) }).ok, false, commandType + ' invalid command envelope')
  }
})

test('command parser rejects unknown types, missing payloads and non-command fields', () => {
  assert.equal(parsePetCommand(null).ok, false)
  assert.equal(parsePetCommand({ type: 'pet.unknown', payload: {} }).ok, false)
  assert.equal(parsePetCommand({ type: 'pet.adopt' }).ok, false)
  assert.equal(parsePetCommand({ type: 'pet.adopt', payload: { sex: 'GG' }, reward: 999 }).ok, false)
  assert.equal(parsePetCommand({ type: 'pet.adopt', payload: { sex: 'XX' } }).ok, false)
  assert.equal(validateCommandPayload('inventory.buy', { type: 'food', itemId: '1', quantity: 0 }), false)
  assert.equal(validateCommandPayload('settings.setShared', { key: 'difficulty', value: true }), false)
  assert.equal(validateCommandPayload('settings.setShared', { key: 'undying', value: true }), true)
  assert.equal(validateCommandPayload('settings.setShared', { key: 'undying', value: 'yes' }), false)
  assert.equal(validateCommandPayload('admin.importPortableBundle', { bundle: { ...fixtures.bundle, schemaVersion: 2 } }), false)
  assert.equal(validateCommandPayload('server.setTimeZone', { timeZone: 'Mars/Olympus_Mons' }), false)
  assert.equal(validateCommandPayload('island.refreshNews', { dayKey: '2026-02-30' }), false)
  let accessorReads = 0
  const accessorPayload = {}
  Object.defineProperty(accessorPayload, 'sex', {
    enumerable: true,
    get() {
      accessorReads++
      return 'GG'
    },
  })
  assert.equal(COMMAND_PAYLOAD_VALIDATORS['pet.adopt'](accessorPayload), false)
  assert.equal(validateCommandPayload('pet.adopt', accessorPayload), false)
  assert.equal(parsePetCommand({ type: 'pet.adopt', payload: accessorPayload }).ok, false)
  assert.equal(accessorReads, 0)
})

const hello = {
  t: 'hello', v: PROTOCOL_VERSION, requestId: 'req-hello', appVersion: '0.1.0',
  auth: { kind: 'token', token: 'secret-token' },
}
const mutation = {
  t: 'command', v: PROTOCOL_VERSION, requestId: 'req-command', opId: 'op-1',
  command: { type: 'pet.cheer', payload: {} },
}
const wireAuthority = {
  owner: 'server', authorityId: 'authority-server-0001', restoreGeneration: 1, epoch: 2, state: 'active',
}
const orderedEvent = {
  eventSeq: 1, revision: 3, commandSeq: 1, gameTimeMs: GAME_TIME_MS,
  type: 'pet.statsChanged', payload: { hunger: 900 },
}
const projection = {
  t: 'projection', v: PROTOCOL_VERSION, revision: 3, eventSeq: 1, gameTimeMs: GAME_TIME_MS,
  timeZone: 'Asia/Shanghai', advanceWhileEmpty: true, authority: wireAuthority,
  save: fixtures.shared, events: [orderedEvent],
}
const commandResult = {
  t: 'commandResult', v: PROTOCOL_VERSION, requestId: 'req-command', opId: 'op-1',
  commandType: 'device.list', status: 'applied', commandSeq: 1, revision: 3, eventSeq: 1,
  result: { devices: [] },
}
const welcome = {
  t: 'welcome', v: PROTOCOL_VERSION, requestId: 'req-hello', connectionId: 'connection-1',
  petId: 'pet-0001', deviceId: 'server-device-0001', deviceRole: 'owner', protocolVersion: 1,
  saveSchemaVersion: 1, serverTimeMs: GAME_TIME_MS, gameTimeMs: GAME_TIME_MS, timeZone: 'Asia/Shanghai',
  advanceWhileEmpty: true, authority: wireAuthority, headRevision: 3, headEventSeq: 1,
  catchingUp: false, delivery: 'snapshot',
}

test('protocol parser validates versions, directions, request correlation and shapes', () => {
  assert.equal(parseClientMessage(hello).ok, true)
  assert.equal(parseClientMessage(mutation).ok, true)
  assert.equal(parseClientMessage({ ...hello, v: 2 }).error.code, 'invalid_protocol_version')
  assert.equal(parseClientMessage({ ...hello, v: undefined }).error.code, 'invalid_frame')
  assert.equal(parseClientMessage({ ...mutation, requestId: '' }).error.code, 'missing_request_id')
  assert.equal(parseClientMessage({ ...mutation, command: { type: 'pet.adopt', payload: { sex: 'XX' } } }).error.code, 'invalid_command')
  assert.equal(parseClientMessage({ ...mutation, t: 'projection' }).error.code, 'unknown_message_type')
  let protocolAccessorReads = 0
  const accessorFrame = { ...mutation }
  Object.defineProperty(accessorFrame, 'opId', {
    enumerable: true,
    get() {
      protocolAccessorReads++
      return 'op-1'
    },
  })
  assert.equal(parseClientMessage(accessorFrame).ok, false)
  assert.equal(protocolAccessorReads, 0)
  assert.equal(parseClientMessage({ t: 'ping', v: 1, nonce: 1 }).ok, true)
  assert.equal(parseClientMessage({ t: 'ping', v: 1, nonce: 'one' }).ok, false)
  assert.equal(parseServerMessage(projection).ok, true)
  assert.equal(parseServerMessage(welcome).ok, true)
  assert.equal(parseServerMessage(commandResult).ok, true)
  const missingRequestId = { ...commandResult }
  delete missingRequestId.requestId
  assert.equal(parseServerMessage(missingRequestId).error.code, 'missing_request_id')
  assert.equal(parseServerMessage({ ...projection, v: 2 }).error.code, 'invalid_protocol_version')
  assert.equal(parseServerMessage({ ...welcome, saveSchemaVersion: 2 }).ok, false)
  assert.equal(parseServerMessage({ ...welcome, protocolVersion: 2 }).ok, false)
  assert.equal(parseServerMessage({ ...projection, events: [orderedEvent, { ...orderedEvent }] }).ok, false)
  assert.equal(parseServerMessage({ t: 'pong', v: 1, nonce: 1, serverTimeMs: GAME_TIME_MS }).ok, true)
  assert.equal(parseServerMessage({ t: 'error', v: 1, code: 'internal', message: 'x', refreshProjection: false }).ok, true)
  assert.equal(parseServerMessage({ t: 'error', v: 1, code: 'unknown', message: 'x', refreshProjection: false }).ok, false)
  assert.equal(parseServerMessage({
    t: 'deviceRevoked', v: 1, deviceId: 'server-device-0001', revokedAtMs: GAME_TIME_MS,
  }).ok, true)
  assert.equal(parseServerMessage({
    t: 'authorityResetRequired', v: 1, code: 'authority_reset_required',
    authority: fixtures.authority, reason: 'authority_mismatch', requireFullSnapshot: true,
  }).ok, true)
  assert.equal(parseServerMessage({
    t: 'commandStatusResult', v: 1, requestId: 'req-status', opId: 'op-1', status: 'not_applied',
  }).ok, true)
  assert.equal(parseServerMessage({
    t: 'commandStatusResult', v: 1, requestId: 'req-status', opId: 'op-1', status: 'applied',
    result: { ...commandResult, opId: 'different-op' },
  }).ok, false)
  assert.equal(parseServerMessage({
    t: 'portableBundle', v: 1, requestId: 'req-bundle', bundle: fixtures.bundle,
  }).ok, true)

  const islandResult = projectIslandQuizSession(fixtures.quizSession)
  const islandResultMessage = {
    ...commandResult,
    requestId: 'req-quiz',
    opId: 'op-quiz',
    commandType: 'island.startQuiz',
    result: islandResult,
  }
  assert.equal(parseServerMessage(islandResultMessage).ok, true)
  assert.equal(parseServerMessage({
    ...islandResultMessage,
    result: { ...islandResult, answerIndex: 2 },
  }).ok, false)
  const examResult = projectExamSession(fixtures.examSession)
  assert.equal(parseServerMessage({
    ...commandResult,
    commandType: 'exam.start',
    result: examResult,
  }).ok, true)
  assert.equal(parseServerMessage({
    ...commandResult,
    commandType: 'exam.start',
    result: { ...examResult, questions: [{ ...examResult.questions[0], answerIndex: 1 }] },
  }).ok, false)
  assert.equal(parseServerMessage({
    ...commandResult,
    commandType: 'pet.cheer',
    result: { nested: { answerKey: 'secret' } },
  }).ok, false)
  const ownerBundleResult = {
    ...commandResult,
    commandType: 'admin.exportForDetach',
    result: { authority: fixtures.authority, bundle: fixtures.bundle },
  }
  assert.equal(parseServerMessage(ownerBundleResult).ok, true)
  assert.equal(parseServerMessage({
    ...projection,
    save: { ...fixtures.shared, gameSessions: fixtures.engine.gameSessions },
  }).ok, false)
  assert.equal(parseServerMessage({
    ...projection,
    events: [{ ...orderedEvent, payload: { answerKey: 'secret' } }],
  }).ok, false)
  assert.equal(parseServerMessage({
    t: 'commandResult', v: 1, requestId: 'req-reject', opId: 'op-reject', commandType: 'pet.cheer',
    status: 'rejected', commandSeq: 1, revision: 1, eventSeq: 0,
    error: { code: 'invalid_payload', message: 'bad', refreshProjection: false, answerKey: 'secret' },
  }).ok, false)
  assert.equal(parseServerMessage({
    ...commandResult,
    commandType: 'device.list',
    result: { devices: [{ deviceId: 'd1', label: 'Desktop', role: 'owner', createdAtMs: 1, tokenHash: 'secret' }] },
  }).ok, false)
})


test('every protocol message variant has a valid shape and correlated requests require requestId', () => {
  assert.deepEqual([...CLIENT_MESSAGE_TYPES].sort(), ['command', 'commandStatus', 'exportBundle', 'hello', 'ping', 'resync'])
  assert.deepEqual([...SERVER_MESSAGE_TYPES].sort(), [
    'authorityResetRequired', 'commandResult', 'commandStatusResult', 'deviceRevoked', 'error', 'pong',
    'portableBundle', 'projection', 'ready', 'replay', 'snapshot', 'welcome',
  ])
  const commandStatus = {
    t: 'commandStatus', v: PROTOCOL_VERSION, requestId: 'req-status', opId: 'op-1',
  }
  const exportBundle = {
    t: 'exportBundle', v: PROTOCOL_VERSION, requestId: 'req-export',
  }
  const resync = {
    t: 'resync', v: PROTOCOL_VERSION, requestId: 'req-resync', lastRevision: 2, lastEventSeq: 3,
    discardCachedAuthority: true,
  }
  const ping = { t: 'ping', v: PROTOCOL_VERSION, nonce: 1 }
  const clientMessages = { hello, command: mutation, commandStatus, exportBundle, resync, ping }
  assert.deepEqual(Object.keys(clientMessages).sort(), [...CLIENT_MESSAGE_TYPES].sort())
  for (const [type, message] of Object.entries(clientMessages)) {
    assert.equal(parseClientMessage(message).ok, true, type)
  }

  const { events: projectionEvents, ...projectionBase } = projection
  const snapshot = { ...projectionBase, t: 'snapshot' }
  const replay = { t: 'replay', v: PROTOCOL_VERSION, fromEventSeq: 0, toEventSeq: 1, events: [orderedEvent] }
  const ready = {
    t: 'ready', v: PROTOCOL_VERSION, revision: 3, eventSeq: 1, gameTimeMs: GAME_TIME_MS,
    timeZone: 'Asia/Shanghai', advanceWhileEmpty: true, authority: wireAuthority, catchingUp: false,
  }
  const commandStatusResult = {
    t: 'commandStatusResult', v: PROTOCOL_VERSION, requestId: 'req-status', opId: 'op-1',
    status: 'applied', result: commandResult,
  }
  const portableBundle = {
    t: 'portableBundle', v: PROTOCOL_VERSION, requestId: 'req-bundle', bundle: fixtures.bundle,
  }
  const deviceRevoked = {
    t: 'deviceRevoked', v: PROTOCOL_VERSION, deviceId: 'server-device-0001', revokedAtMs: GAME_TIME_MS,
  }
  const authorityResetRequired = {
    t: 'authorityResetRequired', v: PROTOCOL_VERSION, code: 'authority_reset_required',
    authority: fixtures.authority, reason: 'authority_mismatch', requireFullSnapshot: true,
  }
  const protocolError = {
    t: 'error', v: PROTOCOL_VERSION, code: 'internal', message: 'failure', refreshProjection: false,
  }
  const pong = { t: 'pong', v: PROTOCOL_VERSION, nonce: 1, serverTimeMs: GAME_TIME_MS }
  const projectionWithEvents = { ...projection, events: projectionEvents }
  const serverMessages = {
    welcome, snapshot, replay, ready, projection: projectionWithEvents, commandResult,
    commandStatusResult, portableBundle, deviceRevoked, authorityResetRequired, error: protocolError, pong,
  }
  assert.deepEqual(Object.keys(serverMessages).sort(), [...SERVER_MESSAGE_TYPES].sort())
  for (const [type, message] of Object.entries(serverMessages)) {
    assert.equal(parseServerMessage(message).ok, true, type)
  }

  for (const type of ['hello', 'command', 'commandStatus', 'exportBundle', 'resync']) {
    const message = { ...clientMessages[type] }
    delete message.requestId
    assert.equal(parseClientMessage(message).error.code, 'missing_request_id', type)
  }
  for (const type of ['welcome', 'commandResult', 'commandStatusResult', 'portableBundle']) {
    const message = { ...serverMessages[type] }
    delete message.requestId
    assert.equal(parseServerMessage(message).error.code, 'missing_request_id', type)
  }
})


test('the ordered event catalog is complete and wire event streams are monotonic', () => {
  const expectedEvents = [
    'pet.statsChanged', 'pet.levelChanged', 'pet.illnessChanged', 'pet.died',
    'inventory.changed', 'item.consumed', 'reward.granted',
    'activity.started', 'activity.completed', 'task.progress', 'task.claimed',
    'mail.arrived', 'mail.claimed', 'signin.changed', 'vip.changed',
    'game.sessionStarted', 'game.sessionSettled',
    'island.errandChanged', 'island.combatSettled', 'island.rewardGranted',
    'farm.changed', 'fishing.changed', 'system.snapshotBoundary', 'system.catchUpCompleted',
  ]
  assert.deepEqual([...DOMAIN_EVENT_TYPES].sort(), [...expectedEvents].sort())
  assert.doesNotThrow(() => assertOrderedEventStream([orderedEvent]))
  assert.throws(() => assertOrderedEventStream([orderedEvent, { ...orderedEvent }]), /strictly increasing/)
  assert.throws(() => assertOrderedEventStream([{ ...orderedEvent, revision: -1 }]), /revisions/)
})
