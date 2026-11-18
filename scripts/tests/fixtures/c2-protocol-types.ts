import type {
  ClientHello,
  CommandPayloadMap,
  CommandRequest,
  CommandResult,
  ErrorMessage,
  DomainEventType,
  JsonValue,
  OrderedEvent,
  PetCommand,
  ProjectionMessage,
  ResultDataFor,
  ResultDataMap,
  SnapshotMessage,
  WireCommandResult,
} from '../../../src/shared/sync/protocol'
import { COMMAND_PAYLOAD_VALIDATORS } from '../../../src/shared/sync/command-validation'

const DEVICES: ResultDataMap['device.list'] = {
  devices: [{
    deviceId: 'device-1',
    label: 'Desktop',
    role: 'owner',
    createdAtMs: 1,
    lastSeenAtMs: 2,
  }],
}

const APPLIED: CommandResult<'device.list'> = {
  status: 'applied',
  commandType: 'device.list',
  opId: 'op-1',
  commandSeq: 1,
  revision: 2,
  eventSeq: 3,
  result: DEVICES,
}

const REJECTED: CommandResult<'pet.adopt'> = {
  status: 'rejected',
  commandType: 'pet.adopt',
  opId: 'op-2',
  commandSeq: 2,
  revision: 2,
  eventSeq: 3,
  error: { code: 'unauthorized', message: 'owner required', refreshProjection: false },
}

const DUPLICATE: CommandResult<'device.list'> = {
  status: 'duplicate',
  commandType: 'device.list',
  opId: 'op-1',
  commandSeq: 1,
  revision: 2,
  eventSeq: 3,
  original: 'applied',
  result: DEVICES,
}

const ISLAND: ResultDataFor<'island.startQuiz'> = {
  sessionToken: 'opaque-token',
  recordId: 'record-1',
  quizKind: 'riddle',
  prompt: 'question',
  options: ['a', 'b'],
}

const EXAM: ResultDataFor<'exam.start'> = {
  sessionToken: 'exam-token',
  questions: [{ questionId: 'q-1', prompt: 'question', options: ['a', 'b'] }],
}

const WIRE: WireCommandResult<'island.startQuiz'> = {
  t: 'commandResult',
  v: 1,
  requestId: 'req-1',
  opId: 'op-3',
  commandType: 'island.startQuiz',
  status: 'applied',
  commandSeq: 3,
  revision: 4,
  eventSeq: 5,
  result: ISLAND,
}

const ADOPT: CommandPayloadMap['pet.adopt'] = { sex: 'GG' }
const SHARED_SETTING: CommandPayloadMap['settings.setShared'] = { key: 'difficulty', value: 'standard' }
const COMMAND: PetCommand = { type: 'pet.adopt', payload: ADOPT }
const JSON_DATA: JsonValue = { nested: [1, true, null, 'value'] }
const FALLBACK_RESULT: ResultDataFor<'pet.cheer'> = { presentation: 'cheer', intensity: 1 }
const FALLBACK_COMMAND_RESULT: CommandResult<'pet.cheer'> = {
  status: 'applied', commandType: 'pet.cheer', opId: 'op-fallback', commandSeq: 5, revision: 6, eventSeq: 7,
  result: FALLBACK_RESULT,
}

const EVENT: OrderedEvent<DomainEventType> = {
  eventSeq: 1, revision: 1, gameTimeMs: 1, type: 'pet.statsChanged', payload: { hunger: 100 },
}


// @ts-expect-error device.list result must contain DeviceInfo[]
const BAD_DEVICES: ResultDataMap['device.list'] = { devices: 'not-an-array' }

// @ts-expect-error island quiz projections must not expose answerIndex
const LEAKED_ISLAND: ResultDataFor<'island.startQuiz'> = { sessionToken: 'opaque-token', recordId: 'record-1', quizKind: 'riddle', prompt: 'question', options: ['a'], answerIndex: 1 }

// @ts-expect-error exam question projections must not expose answerIndex
const LEAKED_QUESTION: ResultDataFor<'exam.start'>['questions'][number] = { questionId: 'q-1', prompt: 'question', options: ['a'], answerIndex: 0 }
const LEAKED_EXAM: ResultDataFor<'exam.start'> = {
  sessionToken: 'exam-token',
  questions: [LEAKED_QUESTION],
}

// @ts-expect-error wire result data must match the command type
const BAD_WIRE: WireCommandResult<'device.list'> = { t: 'commandResult', v: 1, requestId: 'req-2', opId: 'op-4', commandType: 'device.list', status: 'applied', commandSeq: 4, revision: 5, eventSeq: 6, result: ISLAND }

// @ts-expect-error event types are a closed semantic catalog
const BAD_EVENT: OrderedEvent<DomainEventType> = { eventSeq: 2, revision: 2, gameTimeMs: 2, type: 'pet.unknown', payload: {} }

// @ts-expect-error pet.adopt only accepts the two canonical sexes
const BAD_ADOPT: PetCommand = { type: 'pet.adopt', payload: { sex: 'XX' } }

export {
  ADOPT,
  APPLIED,
  BAD_ADOPT,
  BAD_DEVICES,
  BAD_WIRE,
  BAD_EVENT,
  COMMAND,
  DEVICES,
  DUPLICATE,
  EVENT,
  EXAM,
  FALLBACK_COMMAND_RESULT,
  FALLBACK_RESULT,
  GAME_START_RESULT,
  ISLAND,
  JSON_DATA,
  LEAKED_EXAM,
  LEAKED_QUESTION,
  LEAKED_ISLAND,
  REJECTED,
  SHARED_SETTING,
  WIRE,
}

import type {
  AuthorityStamp,
  CoverageSurvivor,
  DeviceLocalOverlay,
  EngineState,
  EnvironmentInputs,
  LocalPetDocumentV2,
  PortablePetBundleV1,
  SessionCoverageInterval,
  SharedSaveData,
  WeatherDayRecord,
  WireAuthority,
} from '../../../src/shared/sync/index'

declare const ENGINE: EngineState
declare const SHARED: SharedSaveData
declare const DEVICE: DeviceLocalOverlay
declare const AUTHORITY: AuthorityStamp
declare const BUNDLE: PortablePetBundleV1
declare const LOCAL_DOCUMENT: LocalPetDocumentV2
declare const SURVIVOR: CoverageSurvivor
declare const COVERAGE: SessionCoverageInterval
declare const WEATHER: WeatherDayRecord
declare const ENVIRONMENT: EnvironmentInputs
declare const WIRE_AUTHORITY: WireAuthority

const ENGINE_VALUE: EngineState = ENGINE
const SHARED_VALUE: SharedSaveData = SHARED
const DEVICE_VALUE: DeviceLocalOverlay = DEVICE
const AUTHORITY_VALUE: AuthorityStamp = AUTHORITY
const BUNDLE_VALUE: PortablePetBundleV1 = BUNDLE
const LOCAL_DOCUMENT_VALUE: LocalPetDocumentV2 = LOCAL_DOCUMENT
const SURVIVOR_VALUE: CoverageSurvivor = SURVIVOR
const COVERAGE_VALUE: SessionCoverageInterval = COVERAGE
const WEATHER_VALUE: WeatherDayRecord = WEATHER
const ENVIRONMENT_VALUE: EnvironmentInputs = ENVIRONMENT
const WIRE_AUTHORITY_VALUE: WireAuthority = WIRE_AUTHORITY
const DEVICE_REVOKE_RESULT: ResultDataMap['device.revoke'] = { deviceId: 'device-1', revokedAtMs: 10 }
const GAME_START_RESULT: ResultDataMap['game.startSession'] = { sessionToken: 'game-token', gameId: 'game-1' }
const DIUDIULE_START_RESULT: ResultDataMap['diudiule.startSession'] = { sessionToken: 'diudiule-token' }
const ADMIN_EXPORT_RESULT: ResultDataMap['admin.exportForDetach'] = { authority: AUTHORITY, bundle: BUNDLE }


const CLIENT_HELLO: ClientHello = {
  t: 'hello', v: 1, requestId: 'req-hello', appVersion: '0.1.0',
  auth: { kind: 'token', token: 'secret-token' },
}
const COMMAND_REQUEST: CommandRequest = {
  t: 'command', v: 1, requestId: 'req-command', opId: 'op-1', observedRevision: 2,
  command: COMMAND,
}
const ERROR_MESSAGE: ErrorMessage = {
  t: 'error', v: 1, requestId: 'req-error', code: 'internal', message: 'failure', refreshProjection: false,
}
const WIRE_AUTHORITY_DECL: WireAuthority = {
  owner: 'server', authorityId: 'authority-1', restoreGeneration: 1, epoch: 2, state: 'active',
}
const SNAPSHOT_MESSAGE: SnapshotMessage = {
  t: 'snapshot', v: 1, revision: 2, eventSeq: 1, gameTimeMs: 1000, timeZone: 'Asia/Shanghai',
  advanceWhileEmpty: true, authority: WIRE_AUTHORITY_DECL, save: SHARED,
}
const PROJECTION_MESSAGE: ProjectionMessage = {
  t: 'projection', v: 1, revision: 2, eventSeq: 1, gameTimeMs: 1000, timeZone: 'Asia/Shanghai',
  advanceWhileEmpty: true, authority: WIRE_AUTHORITY_DECL, save: SHARED, events: [EVENT],
}


export {
  ADMIN_EXPORT_RESULT,
  AUTHORITY_VALUE,
  BUNDLE_VALUE,
  CLIENT_HELLO,
  COMMAND_REQUEST,
  COVERAGE_VALUE,
  DEVICE_REVOKE_RESULT,
  DEVICE_VALUE,
  DIUDIULE_START_RESULT,
  ENGINE_VALUE,
  ENVIRONMENT_VALUE,
  ERROR_MESSAGE,
  LOCAL_DOCUMENT_VALUE,
  PROJECTION_MESSAGE,
  SHARED_VALUE,
  SNAPSHOT_MESSAGE,
  SURVIVOR_VALUE,
  WEATHER_VALUE,
  WIRE_AUTHORITY_VALUE,
}

function narrowAdopt(value: unknown): 'GG' | 'MM' | null {
  if (COMMAND_PAYLOAD_VALIDATORS['pet.adopt'](value)) return value.sex
  return null
}

export { narrowAdopt }
