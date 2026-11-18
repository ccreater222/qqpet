import { cloneRngState, createRngState } from '../pet-runtime/rng'
import { assertJsonSafe, stableStringify } from '../pet-runtime/serialization'
import { assertTimeZone, dayKeyAt, isDayKey, nextDailyBoundaryMs } from '../pet-runtime/time'
import { RUNTIME_SCHEMA_VERSION } from '../pet-runtime/types'
import type {
  CalendarInput,
  CoverageEndProvenance,
  CoverageReopen,
  CoverageSurvivor,
  EngineState,
  EnvironmentInputs,
  GameSessionPayload,
  GameSessionState,
  ScheduledJob,
  SessionCoverageInterval,
  WeatherDayRecord,
} from '../pet-runtime/types'
import type { OpIdCache } from '../pet-runtime/idempotency'
import type { OrderedDomainEvent } from '../pet-runtime/events'
import { ORDERED_EVENT_TYPES } from '../pet-runtime/events'
import { isCommandKey } from './command-validation'
import { COMMAND_ERROR_CODES } from './protocol'
import type { SaveData } from '../save'
import type { DeviceLocalOverlay, SharedSaveData } from './data-boundary'
import {
  assertDeviceLocalOverlay,
  assertNoForbiddenJsonKey,
  assertNoNeverUpload,
  assertSharedSaveData,
  backfillLegacySharedPetInfo,
  toSharedSaveData,
} from './data-boundary'
import {
  assertOnlyKeys,
  assertRequiredKeys,
  assertSchemaVersion,
  failSchema,
  isEnum,
  isNonEmptyString,
  isNonNegativeInteger,
  isRecord,
  requireBoolean,
  requireJsonObject,
  requireNonNegativeInteger,
  requireRecord,
  requireSafeInteger,
  type SchemaError,
} from './schema'

export const PORTABLE_BUNDLE_FORMAT = 'qqpet-portable-v1' as const
export const PORTABLE_BUNDLE_SCHEMA_VERSION = 1 as const
export const LOCAL_DOCUMENT_FORMAT = 'qqpet-local-v2' as const
export const LOCAL_DOCUMENT_SCHEMA_VERSION = 1 as const
export const REMOTE_PROJECTION_CACHE_FORMAT = 'qqpet-server-projection-v2' as const
export const REMOTE_PROJECTION_CACHE_SCHEMA_VERSION = 1 as const
export const LEGACY_PORTABLE_BUNDLE_FORMAT = 'qqpet-portable-v0' as const
export const LEGACY_PORTABLE_BUNDLE_SCHEMA_VERSION = 0 as const

export interface AuthorityStamp {
  owner: 'local' | 'server'
  /** Stable lineage UUID; changes only on operator restore/reset rollback. */
  authorityId: string
  epoch: number
  restoreGeneration: number
  revision: number
  eventSeq: number
  handoffId: string
  detachedAtWallMs: number
}

export interface WireAuthority {
  owner: 'local' | 'server'
  authorityId: string
  restoreGeneration: number
  epoch: number
  state: 'active' | 'archived' | 'reset'
}

export interface PortablePetBundleV1 {
  format: typeof PORTABLE_BUNDLE_FORMAT
  schemaVersion: typeof PORTABLE_BUNDLE_SCHEMA_VERSION
  exportedAtWallMs: number
  authority: AuthorityStamp
  /** Present for local-origin bundles; provenance/rebinding only, never auth authority. */
  originLocalDeviceId?: string
  shared: SharedSaveData
  engine: EngineState
}

export interface LocalPersistedRuntimeIdentity {
  /** New UUID on every process start; never reused across restart. */
  appInstanceId: string
  startedAtWallMs: number
}

export interface LocalRuntimeIdentity extends LocalPersistedRuntimeIdentity {
  /** Derived from LocalPetDocumentV2.device.localDeviceId; never serialized independently. */
  readonly localDeviceId: string
}

export interface LocalEventHistoryEntry extends OrderedDomainEvent {
  /** Commit revision assigned by the local host when the event was persisted. */
  revision?: number
  /** Game time of the commit batch that emitted the event. */
  gameTimeMs?: number
  commandSeq?: number
}

export interface LocalPetDocumentV2 {
  format: typeof LOCAL_DOCUMENT_FORMAT
  schemaVersion: typeof LOCAL_DOCUMENT_SCHEMA_VERSION
  revision: number
  eventSeq: number
  authority: {
    state: 'active' | 'handoff_pending' | 'archived'
    stamp: AuthorityStamp
  }
  bundle: PortablePetBundleV1
  runtime: LocalPersistedRuntimeIdentity
  device: DeviceLocalOverlay
  /** Host-level opId cache committed atomically with the local document. */
  idempotency?: OpIdCache
  /** Recent ordered event history retained by the local host. */
  eventHistory?: LocalEventHistoryEntry[]
}

export interface RemoteProjectionCacheV2 {
  format: typeof REMOTE_PROJECTION_CACHE_FORMAT
  schemaVersion: typeof REMOTE_PROJECTION_CACHE_SCHEMA_VERSION
  petId: string
  deviceId: string
  revision: number
  eventSeq: number
  gameTimeMs: number
  timeZone: string
  advanceWhileEmpty: boolean
  /** Canonical owner-selected weather location carried by the server projection. */
  weatherLocation?: string
  authority: WireAuthority
  shared: SharedSaveData
  device: DeviceLocalOverlay
}

export type LegacyEngineStateV0 = Omit<
  EngineState,
  'schemaVersion' | 'lastProcessedDayBoundaryKey' | 'nextDailyBoundaryMs' | 'importClamped' | 'clockSkippedMs'
> & {
  schemaVersion?: 0 | 1
  lastProcessedDayBoundaryKey?: string
  nextDailyBoundaryMs?: number
  importClamped?: boolean
  clockSkippedMs?: number
}

export interface LegacyPortablePetBundleV0 {
  format: typeof LEGACY_PORTABLE_BUNDLE_FORMAT
  schemaVersion: typeof LEGACY_PORTABLE_BUNDLE_SCHEMA_VERSION
  exportedAtMs: number
  authority: AuthorityStamp
  originLocalDeviceId?: string
  shared: SharedSaveData
  engine: LegacyEngineStateV0
}

export interface LegacySaveMigrationOptions {
  /** Explicit host wall-clock anchor used for game time and scheduler. */
  nowMs: number
  /** Explicit host CSPRNG seed. Zero/malformed seeds are rejected. */
  seedHex: string
  authority: AuthorityStamp
  localDeviceId: string
  timeZone: string
  advanceWhileEmpty?: boolean
  weatherLocation?: string
}

export const AUTHORITY_STAMP_KEYS = [
  'owner', 'authorityId', 'epoch', 'restoreGeneration', 'revision', 'eventSeq', 'handoffId', 'detachedAtWallMs',
] as const
export const WIRE_AUTHORITY_KEYS = ['owner', 'authorityId', 'restoreGeneration', 'epoch', 'state'] as const
export const ENGINE_STATE_KEYS = [
  'schemaVersion', 'save', 'gameTimeMs', 'lastSchedulerWallMs', 'timeZone', 'weatherLocation',
  'advanceWhileEmpty', 'rng', 'scheduledJobs', 'nextScheduledJobId', 'gameSessions',
  'sessionCoverage', 'coverageReopen', 'lastProcessedDayBoundaryKey', 'nextDailyBoundaryMs',
  'importClamped', 'clockSkippedMs', 'environment',
] as const
export const ENGINE_REQUIRED_KEYS = [
  'schemaVersion', 'save', 'gameTimeMs', 'lastSchedulerWallMs', 'timeZone', 'weatherLocation',
  'advanceWhileEmpty', 'rng', 'scheduledJobs', 'nextScheduledJobId', 'gameSessions',
  'sessionCoverage', 'lastProcessedDayBoundaryKey', 'nextDailyBoundaryMs',
  'importClamped', 'clockSkippedMs', 'environment',
] as const

const COVERAGE_END_PROVENANCE = [
  'disconnect', 'shutdown', 'suspend', 'crash_repaired', 'pet_reset', 'import_replaced',
  'authority_handoff', 'graceful', 'socket_closed', 'app_shutdown',
] as const
const SCHEDULED_JOB_TYPES = ['work', 'study', 'travel', 'game-session', 'farm', 'fishing', 'mail', 'other'] as const
const JOB_STATUSES = ['pending', 'completed', 'cancelled'] as const
const SESSION_STATUSES = ['active', 'settled', 'abandoned', 'expired'] as const
const WEATHER_PROVENANCE = ['live', 'cache', 'fallback', 'imported'] as const

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  if (isNonEmptyString(value) === false) failSchema('invalid_schema', path, 'expected a non-empty string')
}

function assertOptionalString(value: unknown, path: string): void {
  if (value !== undefined && typeof value !== 'string') failSchema('invalid_schema', path, 'expected a string')
}

function assertOptionalNonNegativeInteger(value: unknown, path: string): void {
  if (value !== undefined && isNonNegativeInteger(value) === false) {
    failSchema('invalid_schema', path, 'expected a non-negative safe integer')
  }
}

function assertCoverageProvenance(value: unknown, path: string): asserts value is CoverageEndProvenance {
  if (isEnum(value, COVERAGE_END_PROVENANCE) === false) failSchema('invalid_schema', path, 'invalid coverage end provenance')
}

export function assertAuthorityStamp(value: unknown, path = '$.authority'): asserts value is AuthorityStamp {
  requireRecord(value, path)
  assertRequiredKeys(value, AUTHORITY_STAMP_KEYS, path)
  assertOnlyKeys(value, AUTHORITY_STAMP_KEYS, path)
  if (isEnum(value.owner, ['local', 'server'] as const) === false) failSchema('invalid_schema', path + '.owner', 'invalid owner')
  assertNonEmptyString(value.authorityId, path + '.authorityId')
  assertNonEmptyString(value.handoffId, path + '.handoffId')
  requireNonNegativeInteger(value.epoch, path + '.epoch')
  requireNonNegativeInteger(value.restoreGeneration, path + '.restoreGeneration')
  requireNonNegativeInteger(value.revision, path + '.revision')
  requireNonNegativeInteger(value.eventSeq, path + '.eventSeq')
  requireNonNegativeInteger(value.detachedAtWallMs, path + '.detachedAtWallMs')
}

export function validateAuthorityStamp(value: unknown): value is AuthorityStamp {
  try {
    assertAuthorityStamp(value)
    return true
  } catch {
    return false
  }
}

export function assertWireAuthority(value: unknown, path = '$.authority'): asserts value is WireAuthority {
  requireRecord(value, path)
  assertRequiredKeys(value, WIRE_AUTHORITY_KEYS, path)
  assertOnlyKeys(value, WIRE_AUTHORITY_KEYS, path)
  if (isEnum(value.owner, ['local', 'server'] as const) === false) failSchema('invalid_schema', path + '.owner', 'invalid owner')
  assertNonEmptyString(value.authorityId, path + '.authorityId')
  requireNonNegativeInteger(value.restoreGeneration, path + '.restoreGeneration')
  requireNonNegativeInteger(value.epoch, path + '.epoch')
  if (isEnum(value.state, ['active', 'archived', 'reset'] as const) === false) {
    failSchema('invalid_schema', path + '.state', 'invalid authority state')
  }
}

export function validateWireAuthority(value: unknown): value is WireAuthority {
  try {
    assertWireAuthority(value)
    return true
  } catch {
    return false
  }
}

function assertRng(value: unknown, path: string): void {
  requireRecord(value, path)
  assertRequiredKeys(value, ['algorithm', 'seedHex', 'stateHex', 'draws'], path)
  assertOnlyKeys(value, ['algorithm', 'seedHex', 'stateHex', 'draws'], path)
  try {
    cloneRngState(value as never)
  } catch {
    failSchema('invalid_schema', path, 'invalid RNG state')
  }
}

function assertScheduledJob(value: unknown, path: string): asserts value is ScheduledJob {
  requireRecord(value, path)
  assertRequiredKeys(value, ['id', 'type', 'dueAtGameMs', 'payload', 'status'], path)
  assertOnlyKeys(value, ['id', 'type', 'dueAtGameMs', 'payload', 'status'], path)
  requireNonNegativeInteger(value.id, path + '.id')
  if (isEnum(value.type, SCHEDULED_JOB_TYPES) === false) failSchema('invalid_schema', path + '.type', 'invalid job type')
  requireSafeInteger(value.dueAtGameMs, path + '.dueAtGameMs')
  requireJsonObject(value.payload, path + '.payload')
  if (isEnum(value.status, JOB_STATUSES) === false) failSchema('invalid_schema', path + '.status', 'invalid job status')
}

function assertExamQuestion(value: unknown, path: string): void {
  requireRecord(value, path)
  assertRequiredKeys(value, ['questionId', 'prompt', 'options', 'answerIndex'], path)
  assertOnlyKeys(value, ['questionId', 'prompt', 'options', 'answerIndex'], path)
  assertNonEmptyString(value.questionId, path + '.questionId')
  if (typeof value.prompt !== 'string') failSchema('invalid_schema', path + '.prompt', 'expected a string')
  if (Array.isArray(value.options) === false || value.options.some(option => typeof option !== 'string')) {
    failSchema('invalid_schema', path + '.options', 'expected string options')
  }
  requireNonNegativeInteger(value.answerIndex, path + '.answerIndex')
  if ((value.answerIndex as number) >= (value.options as string[]).length) {
    failSchema('invalid_schema', path + '.answerIndex', 'answerIndex is outside the options')
  }
}

export function assertGameSessionPayload(value: unknown, path = '$.payload'): asserts value is GameSessionPayload {
  requireRecord(value, path)
  if (value.kind === 'game') {
    assertOnlyKeys(value, ['kind', 'gameId', 'gameKind', 'presentationSeed'], path)
    assertRequiredKeys(value, ['kind', 'gameId', 'gameKind', 'presentationSeed'], path)
    assertNonEmptyString(value.gameId, path + '.gameId')
    if (isEnum(value.gameKind, ['small', 'flash'] as const) === false) failSchema('invalid_schema', path + '.gameKind', 'invalid game kind')
    assertNonEmptyString(value.presentationSeed, path + '.presentationSeed')
    return
  }
  if (value.kind === 'diudiule') {
    assertOnlyKeys(value, ['kind'], path)
    return
  }
  if (value.kind === 'exam') {
    assertOnlyKeys(value, ['kind', 'subject', 'questions', 'examMetadata'], path)
    assertRequiredKeys(value, ['kind', 'subject', 'questions', 'examMetadata'], path)
    assertNonEmptyString(value.subject, path + '.subject')
    if (Array.isArray(value.questions) === false || value.questions.length === 0) {
      failSchema('invalid_schema', path + '.questions', 'expected a non-empty question list')
    }
    value.questions.forEach((question, index) => assertExamQuestion(question, path + '.questions[' + index + ']'))
    requireRecord(value.examMetadata, path + '.examMetadata')
    assertOnlyKeys(value.examMetadata, ['lesson', 'school'], path + '.examMetadata')
    requireNonNegativeInteger(value.examMetadata.lesson, path + '.examMetadata.lesson')
    if (typeof value.examMetadata.school !== 'string') failSchema('invalid_schema', path + '.examMetadata.school', 'expected a string')
    return
  }
  if (value.kind === 'island_quiz') {
    assertOnlyKeys(value, ['kind', 'quizKind', 'recordId', 'prompt', 'options', 'answerIndex', 'metadata'], path)
    assertRequiredKeys(value, ['kind', 'quizKind', 'recordId', 'prompt', 'options', 'answerIndex', 'metadata'], path)
    assertNonEmptyString(value.quizKind, path + '.quizKind')
    assertNonEmptyString(value.recordId, path + '.recordId')
    if (typeof value.prompt !== 'string') failSchema('invalid_schema', path + '.prompt', 'expected a string')
    if (Array.isArray(value.options) === false || value.options.some(option => typeof option !== 'string')) {
      failSchema('invalid_schema', path + '.options', 'expected string options')
    }
    requireNonNegativeInteger(value.answerIndex, path + '.answerIndex')
    if ((value.answerIndex as number) >= (value.options as string[]).length) {
      failSchema('invalid_schema', path + '.answerIndex', 'answerIndex is outside the options')
    }
    requireJsonObject(value.metadata, path + '.metadata')
    return
  }
  failSchema('invalid_schema', path + '.kind', 'unknown game session kind')
}

function assertGameSession(value: unknown, path: string): asserts value is GameSessionState {
  requireRecord(value, path)
  assertRequiredKeys(value, ['sessionToken', 'actorDeviceId', 'payload', 'startedAtGameMs', 'expiresAtGameMs', 'status'], path)
  assertOnlyKeys(value, [
    'sessionToken', 'actorDeviceId', 'payload', 'startedAtGameMs', 'expiresAtGameMs',
    'status', 'settledCommandSeq', 'rewardKey', 'cancelReason',
  ], path)
  assertNonEmptyString(value.sessionToken, path + '.sessionToken')
  assertNonEmptyString(value.actorDeviceId, path + '.actorDeviceId')
  assertGameSessionPayload(value.payload, path + '.payload')
  requireSafeInteger(value.startedAtGameMs, path + '.startedAtGameMs')
  requireSafeInteger(value.expiresAtGameMs, path + '.expiresAtGameMs')
  if ((value.expiresAtGameMs as number) < (value.startedAtGameMs as number)) {
    failSchema('invalid_schema', path + '.expiresAtGameMs', 'session expiry must not precede its start')
  }
  if (isEnum(value.status, SESSION_STATUSES) === false) failSchema('invalid_schema', path + '.status', 'invalid session status')
  assertOptionalNonNegativeInteger(value.settledCommandSeq, path + '.settledCommandSeq')
  assertOptionalString(value.rewardKey, path + '.rewardKey')
  assertOptionalString(value.cancelReason, path + '.cancelReason')
}

function assertCoverageInterval(value: unknown, path: string): asserts value is SessionCoverageInterval {
  requireRecord(value, path)
  assertRequiredKeys(value, ['coverageId', 'deviceId', 'connectedAtWallMs', 'lastHeartbeatWallMs'], path)
  assertOnlyKeys(value, ['coverageId', 'deviceId', 'connectedAtWallMs', 'disconnectedAtWallMs', 'lastHeartbeatWallMs', 'closeReason'], path)
  assertNonEmptyString(value.coverageId, path + '.coverageId')
  assertNonEmptyString(value.deviceId, path + '.deviceId')
  requireNonNegativeInteger(value.connectedAtWallMs, path + '.connectedAtWallMs')
  assertOptionalNonNegativeInteger(value.disconnectedAtWallMs, path + '.disconnectedAtWallMs')
  requireNonNegativeInteger(value.lastHeartbeatWallMs, path + '.lastHeartbeatWallMs')
  if (value.closeReason !== undefined) assertCoverageProvenance(value.closeReason, path + '.closeReason')
}

function assertCoverageSurvivor(value: unknown, path: string): asserts value is CoverageSurvivor {
  requireRecord(value, path)
  if (value.kind === 'server_connection') {
    assertRequiredKeys(value, ['kind', 'connectionId', 'deviceId', 'lastHeartbeatWallMs', 'eligible'], path)
    assertOnlyKeys(value, [
      'kind', 'connectionId', 'deviceId', 'authenticatedSessionId', 'lastHeartbeatWallMs',
      'eligible', 'activeEndWallMs', 'activeEndProvenance',
    ], path)
    assertNonEmptyString(value.connectionId, path + '.connectionId')
    assertNonEmptyString(value.deviceId, path + '.deviceId')
    assertOptionalString(value.authenticatedSessionId, path + '.authenticatedSessionId')
  } else if (value.kind === 'local_app') {
    assertRequiredKeys(value, ['kind', 'appInstanceId', 'localDeviceId', 'lastHeartbeatWallMs', 'eligible'], path)
    assertOnlyKeys(value, [
      'kind', 'appInstanceId', 'localDeviceId', 'lastHeartbeatWallMs',
      'eligible', 'activeEndWallMs', 'activeEndProvenance',
    ], path)
    assertNonEmptyString(value.appInstanceId, path + '.appInstanceId')
    assertNonEmptyString(value.localDeviceId, path + '.localDeviceId')
  } else {
    failSchema('invalid_schema', path + '.kind', 'unknown coverage survivor kind')
  }
  requireNonNegativeInteger(value.lastHeartbeatWallMs, path + '.lastHeartbeatWallMs')
  if (typeof value.eligible !== 'boolean') failSchema('invalid_schema', path + '.eligible', 'expected a boolean')
  assertOptionalNonNegativeInteger(value.activeEndWallMs, path + '.activeEndWallMs')
  if (value.activeEndProvenance !== undefined) {
    assertCoverageProvenance(value.activeEndProvenance, path + '.activeEndProvenance')
  }
}

function assertCoverageReopen(value: unknown, path: string): asserts value is CoverageReopen {
  requireRecord(value, path)
  assertRequiredKeys(value, ['operationId', 'commitWallMs', 'survivors', 'state'], path)
  assertOnlyKeys(value, ['operationId', 'commitWallMs', 'survivors', 'state', 'suspendedAtWallMs'], path)
  assertNonEmptyString(value.operationId, path + '.operationId')
  requireNonNegativeInteger(value.commitWallMs, path + '.commitWallMs')
  if (Array.isArray(value.survivors) === false) failSchema('invalid_schema', path + '.survivors', 'expected survivors')
  value.survivors.forEach((survivor, index) => assertCoverageSurvivor(survivor, path + '.survivors[' + index + ']'))
  if (isEnum(value.state, ['pending', 'suspended'] as const) === false) failSchema('invalid_schema', path + '.state', 'invalid reopen state')
  assertOptionalNonNegativeInteger(value.suspendedAtWallMs, path + '.suspendedAtWallMs')
}

function assertWeatherDay(value: unknown, path: string): asserts value is WeatherDayRecord {
  requireRecord(value, path)
  assertRequiredKeys(value, ['dayKey', 'condition', 'conditionCode', 'minC', 'maxC', 'tomorrowMax', 'hours', 'provenance', 'fetchedAtMs'], path)
  assertOnlyKeys(value, [
    'dayKey', 'condition', 'conditionCode', 'minC', 'maxC', 'tomorrowMax',
    'hours', 'provenance', 'fetchedAtMs', 'sourceLabel',
  ], path)
  if (isDayKey(value.dayKey as string) === false) failSchema('invalid_schema', path + '.dayKey', 'invalid day key')
  if (typeof value.condition !== 'string') failSchema('invalid_schema', path + '.condition', 'expected a string')
  requireSafeInteger(value.conditionCode, path + '.conditionCode')
  for (const key of ['minC', 'maxC', 'tomorrowMax'] as const) {
    if (typeof value[key] !== 'number' || Number.isFinite(value[key] as number) === false) {
      failSchema('invalid_schema', path + '.' + key, 'expected a finite number')
    }
  }
  if (Array.isArray(value.hours) === false) failSchema('invalid_schema', path + '.hours', 'expected hours')
  value.hours.forEach((hour, index) => {
    const hourPath = path + '.hours[' + index + ']'
    requireRecord(hour, hourPath)
    assertRequiredKeys(hour, ['hour', 'code', 'wind'], hourPath)
    assertOnlyKeys(hour, ['hour', 'code', 'wind'], hourPath)
    requireNonNegativeInteger(hour.hour, hourPath + '.hour')
    if ((hour.hour as number) > 23) failSchema('invalid_schema', hourPath + '.hour', 'hour must be between 0 and 23')
    requireSafeInteger(hour.code, hourPath + '.code')
    if (typeof hour.wind !== 'number' || Number.isFinite(hour.wind) === false || hour.wind < 0) {
      failSchema('invalid_schema', hourPath + '.wind', 'expected a non-negative finite number')
    }
  })
  if (isEnum(value.provenance, WEATHER_PROVENANCE) === false) failSchema('invalid_schema', path + '.provenance', 'invalid weather provenance')
  requireNonNegativeInteger(value.fetchedAtMs, path + '.fetchedAtMs')
  assertOptionalString(value.sourceLabel, path + '.sourceLabel')
}

function assertCalendarDay(value: unknown, path: string): asserts value is CalendarInput {
  requireRecord(value, path)
  assertRequiredKeys(value, ['date', 'lunar', 'term', 'holiday'], path)
  assertOnlyKeys(value, ['date', 'lunar', 'term', 'holiday'], path)
  if (isDayKey(value.date as string) === false) failSchema('invalid_schema', path + '.date', 'invalid day key')
  if (typeof value.lunar !== 'string') failSchema('invalid_schema', path + '.lunar', 'expected a string')
  if (value.term !== null && typeof value.term !== 'string') failSchema('invalid_schema', path + '.term', 'expected a string or null')
  if (value.holiday !== null) {
    requireRecord(value.holiday, path + '.holiday')
    assertRequiredKeys(value.holiday, ['name', 'off'], path + '.holiday')
    assertOnlyKeys(value.holiday, ['name', 'off'], path + '.holiday')
    if (typeof value.holiday.name !== 'string') failSchema('invalid_schema', path + '.holiday.name', 'expected a string')
    if (typeof value.holiday.off !== 'boolean') failSchema('invalid_schema', path + '.holiday.off', 'expected a boolean')
  }
}

function assertEnvironment(value: unknown, path: string): asserts value is EnvironmentInputs {
  requireRecord(value, path)
  assertRequiredKeys(value, ['weatherByDay'], path)
  assertOnlyKeys(value, ['calendarByDay', 'weatherByDay'], path)
  requireRecord(value.weatherByDay, path + '.weatherByDay')
  for (const [dayKey, record] of Object.entries(value.weatherByDay)) {
    const recordPath = path + '.weatherByDay.' + dayKey
    assertWeatherDay(record, recordPath)
    if (record.dayKey !== dayKey) failSchema('invalid_schema', recordPath + '.dayKey', 'weather day key does not match its map key')
  }
  if (value.calendarByDay !== undefined) {
    requireRecord(value.calendarByDay, path + '.calendarByDay')
    for (const [dayKey, record] of Object.entries(value.calendarByDay)) {
      const recordPath = path + '.calendarByDay.' + dayKey
      assertCalendarDay(record, recordPath)
      if (record.date !== dayKey) failSchema('invalid_schema', recordPath + '.date', 'calendar day key does not match its map key')
    }
  }
}

export function assertEngineState(value: unknown): asserts value is EngineState {
  try {
    assertJsonSafe(value)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'engine state is not JSON-safe'
    failSchema('invalid_schema', '$.engine', message)
  }
  requireRecord(value, '$.engine')
  assertRequiredKeys(value, ENGINE_REQUIRED_KEYS, '$.engine')
  assertOnlyKeys(value, ENGINE_STATE_KEYS, '$.engine')
  assertNoNeverUpload(value, '$.engine')
  assertNoForbiddenJsonKey(value, '$.engine', { includeSessionAnswerKeys: false })
  assertSchemaVersion(value.schemaVersion, RUNTIME_SCHEMA_VERSION, '$.engine.schemaVersion', 'runtime')
  assertSharedSaveData(value.save)
  requireNonNegativeInteger(value.gameTimeMs, '$.engine.gameTimeMs')
  requireSafeInteger(value.lastSchedulerWallMs, '$.engine.lastSchedulerWallMs')
  assertNonEmptyString(value.timeZone, '$.engine.timeZone')
  try {
    assertTimeZone(value.timeZone)
  } catch {
    failSchema('invalid_schema', '$.engine.timeZone', 'invalid IANA timezone')
  }
  if (typeof value.weatherLocation !== 'string') failSchema('invalid_schema', '$.engine.weatherLocation', 'expected a string')
  if (typeof value.advanceWhileEmpty !== 'boolean') failSchema('invalid_schema', '$.engine.advanceWhileEmpty', 'expected a boolean')
  assertRng(value.rng, '$.engine.rng')
  if (Array.isArray(value.scheduledJobs) === false) failSchema('invalid_schema', '$.engine.scheduledJobs', 'expected jobs')
  value.scheduledJobs.forEach((job, index) => assertScheduledJob(job, '$.engine.scheduledJobs[' + index + ']'))
  requireNonNegativeInteger(value.nextScheduledJobId, '$.engine.nextScheduledJobId')
  if (Array.isArray(value.gameSessions) === false) failSchema('invalid_schema', '$.engine.gameSessions', 'expected sessions')
  value.gameSessions.forEach((session, index) => assertGameSession(session, '$.engine.gameSessions[' + index + ']'))
  if (Array.isArray(value.sessionCoverage) === false) failSchema('invalid_schema', '$.engine.sessionCoverage', 'expected coverage intervals')
  value.sessionCoverage.forEach((interval, index) => assertCoverageInterval(interval, '$.engine.sessionCoverage[' + index + ']'))
  if (value.coverageReopen !== undefined) assertCoverageReopen(value.coverageReopen, '$.engine.coverageReopen')
  if (isDayKey(value.lastProcessedDayBoundaryKey as string) === false) {
    failSchema('invalid_schema', '$.engine.lastProcessedDayBoundaryKey', 'invalid day key')
  }
  requireNonNegativeInteger(value.nextDailyBoundaryMs, '$.engine.nextDailyBoundaryMs')
  if (typeof value.importClamped !== 'boolean') failSchema('invalid_schema', '$.engine.importClamped', 'expected a boolean')
  requireSafeInteger(value.clockSkippedMs, '$.engine.clockSkippedMs')
  assertEnvironment(value.environment, '$.engine.environment')
}

export function validateEngineState(value: unknown): value is EngineState {
  try {
    assertEngineState(value)
    return true
  } catch {
    return false
  }
}

export function assertPortablePetBundle(value: unknown): asserts value is PortablePetBundleV1 {
  requireRecord(value, '$.bundle')
  if (value.schemaVersion !== PORTABLE_BUNDLE_SCHEMA_VERSION) {
    assertSchemaVersion(value.schemaVersion, PORTABLE_BUNDLE_SCHEMA_VERSION, '$.bundle.schemaVersion', 'portable bundle')
  }
  if (value.format !== PORTABLE_BUNDLE_FORMAT) {
    failSchema('unsupported_format', '$.bundle.format', 'expected ' + PORTABLE_BUNDLE_FORMAT)
  }
  try {
    assertJsonSafe(value)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'portable bundle is not JSON-safe'
    failSchema('invalid_schema', '$.bundle', message)
  }
  assertRequiredKeys(value, ['format', 'schemaVersion', 'exportedAtWallMs', 'authority', 'shared', 'engine'], '$.bundle')
  assertOnlyKeys(value, ['format', 'schemaVersion', 'exportedAtWallMs', 'authority', 'originLocalDeviceId', 'shared', 'engine'], '$.bundle')
  assertNoForbiddenJsonKey(value, '$.bundle', { includeSessionAnswerKeys: false })
  requireNonNegativeInteger(value.exportedAtWallMs, '$.bundle.exportedAtWallMs')
  assertAuthorityStamp(value.authority, '$.bundle.authority')
  if (value.originLocalDeviceId !== undefined) assertNonEmptyString(value.originLocalDeviceId, '$.bundle.originLocalDeviceId')
  if (value.authority.owner === 'local' && value.originLocalDeviceId === undefined) {
    failSchema('missing_field', '$.bundle.originLocalDeviceId', 'local-authority bundle requires originLocalDeviceId')
  }
  assertSharedSaveData(value.shared)
  assertEngineState(value.engine)
  if (stableStringify(value.shared) !== stableStringify(value.engine.save)) {
    failSchema('invalid_schema', '$.bundle', 'bundle shared snapshot does not match engine.save')
  }
}

export function validatePortablePetBundle(value: unknown): value is PortablePetBundleV1 {
  try {
    assertPortablePetBundle(value)
    return true
  } catch {
    return false
  }
}

const LEGACY_ENGINE_REQUIRED_KEYS = [
  'save', 'gameTimeMs', 'lastSchedulerWallMs', 'timeZone', 'weatherLocation', 'advanceWhileEmpty',
  'rng', 'scheduledJobs', 'nextScheduledJobId', 'gameSessions', 'sessionCoverage', 'environment',
] as const

/**
 * Backfills canonical defaults added after an older bundle was written. A bundle carries the
 * canonical snapshot twice (`shared` and `engine.save`); both copies get the same default so the
 * bundle's shared/engine identity assertion still holds.
 */
function backfillPortableBundleDefaults(bundle: Record<string, unknown>): string[] {
  const filled = backfillLegacySharedPetInfo(bundle.shared)
  if (isRecord(bundle.engine)) filled.push(...backfillLegacySharedPetInfo(bundle.engine.save))
  return filled
}

/**
 * In-place upgrade for local v2 documents written before `petInfo.diamond` (#75) existed.
 * Validation stays strict; this only fills fields a pre-upgrade document could not have.
 */
export function backfillLegacyLocalPetDocumentDefaults(value: unknown): string[] {
  if (isRecord(value) === false || isRecord(value.bundle) === false) return []
  return backfillPortableBundleDefaults(value.bundle)
}

function legacySaveCandidate(value: unknown): SaveData {
  requireRecord(value, '$.legacySave')
  const candidate: Record<string, unknown> = isRecord(value.petInfoData)
    ? { ...value.petInfoData }
    : { ...value }
  if (isRecord(value.petInfoData)) {
    for (const key of [
      'havePet', 'isBury', 'saveNum', 'nowTimeLine', 'petInfo', 'petComputedlInfo', 'studyInfo',
      'activeOption', 'selfGoodDatas', 'selfGoodUseOption', 'gameSaveDatas', 'illustrated',
      'saveJsonData', 'settings',
    ] as const) {
      if (candidate[key] === undefined && value[key] !== undefined) candidate[key] = value[key]
    }
  }
  // Mirrors petOf normalization: original config.json machine identity fields are never canonical.
  delete candidate.machineId
  delete candidate.oId
  // A save.json written before #75 has no petInfo.diamond; repair it to the same default startSave uses.
  backfillLegacySharedPetInfo(candidate)
  return candidate as unknown as SaveData
}

/** Deterministic migration of a legacy bare SaveData/config.json into a v1 portable bundle. */
export function migrateLegacySaveDataToPortableBundle(
  legacy: unknown,
  options: LegacySaveMigrationOptions,
): PortablePetBundleV1 {
  try {
    assertJsonSafe(legacy)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'legacy save is not JSON-safe'
    failSchema('invalid_schema', '$.legacySave', message)
  }
  requireRecord(options, '$.legacyMigration.options')
  requireNonNegativeInteger(options.nowMs, '$.legacyMigration.options.nowMs')
  if (options.advanceWhileEmpty !== undefined) requireBoolean(options.advanceWhileEmpty, '$.legacyMigration.options.advanceWhileEmpty')
  assertNonEmptyString(options.localDeviceId, '$.legacyMigration.options.localDeviceId')
  assertNonEmptyString(options.timeZone, '$.legacyMigration.options.timeZone')
  try {
    assertTimeZone(options.timeZone)
  } catch {
    failSchema('invalid_schema', '$.legacyMigration.options.timeZone', 'invalid IANA timezone')
  }
  assertAuthorityStamp(options.authority, '$.legacyMigration.options.authority')
  if (options.weatherLocation !== undefined && typeof options.weatherLocation !== 'string') {
    failSchema('invalid_schema', '$.legacyMigration.options.weatherLocation', 'expected a string')
  }
  let rng
  try {
    rng = createRngState(options.seedHex)
  } catch {
    failSchema('invalid_schema', '$.legacyMigration.options.seedHex', 'invalid non-zero 128-bit RNG seed')
  }
  const shared = toSharedSaveData(legacySaveCandidate(legacy))
  const engine: EngineState = {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    save: shared,
    gameTimeMs: options.nowMs,
    lastSchedulerWallMs: options.nowMs,
    timeZone: options.timeZone,
    weatherLocation: options.weatherLocation ?? '',
    advanceWhileEmpty: options.advanceWhileEmpty ?? true,
    rng,
    scheduledJobs: [],
    nextScheduledJobId: 1,
    gameSessions: [],
    sessionCoverage: [],
    lastProcessedDayBoundaryKey: dayKeyAt(options.nowMs, options.timeZone),
    nextDailyBoundaryMs: nextDailyBoundaryMs(options.nowMs, options.timeZone),
    importClamped: false,
    clockSkippedMs: 0,
    environment: { calendarByDay: {}, weatherByDay: {} },
  }
  const bundle: PortablePetBundleV1 = {
    format: PORTABLE_BUNDLE_FORMAT,
    schemaVersion: PORTABLE_BUNDLE_SCHEMA_VERSION,
    exportedAtWallMs: options.nowMs,
    authority: options.authority,
    originLocalDeviceId: options.localDeviceId,
    shared,
    engine,
  }
  assertPortablePetBundle(bundle)
  return bundle
}

function migratePortablePetBundleV0(value: Record<string, unknown>): PortablePetBundleV1 {
  if (value.format !== LEGACY_PORTABLE_BUNDLE_FORMAT) {
    failSchema('unsupported_format', '$.bundle.format', 'expected ' + LEGACY_PORTABLE_BUNDLE_FORMAT)
  }
  assertRequiredKeys(value, ['format', 'schemaVersion', 'exportedAtMs', 'authority', 'shared', 'engine'], '$.bundle')
  assertOnlyKeys(value, ['format', 'schemaVersion', 'exportedAtMs', 'authority', 'originLocalDeviceId', 'shared', 'engine'], '$.bundle')
  requireNonNegativeInteger(value.exportedAtMs, '$.bundle.exportedAtMs')
  assertAuthorityStamp(value.authority, '$.bundle.authority')
  if (value.originLocalDeviceId !== undefined) assertNonEmptyString(value.originLocalDeviceId, '$.bundle.originLocalDeviceId')
  backfillPortableBundleDefaults(value)
  assertSharedSaveData(value.shared)
  requireRecord(value.engine, '$.bundle.engine')
  assertRequiredKeys(value.engine, LEGACY_ENGINE_REQUIRED_KEYS, '$.bundle.engine')
  requireNonNegativeInteger(value.engine.gameTimeMs, '$.bundle.engine.gameTimeMs')
  assertNonEmptyString(value.engine.timeZone, '$.bundle.engine.timeZone')
  assertTimeZone(value.engine.timeZone)
  const engine: Record<string, unknown> = {
    ...value.engine,
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    lastProcessedDayBoundaryKey: value.engine.lastProcessedDayBoundaryKey ?? dayKeyAt(value.engine.gameTimeMs as number, value.engine.timeZone),
    nextDailyBoundaryMs: value.engine.nextDailyBoundaryMs ?? nextDailyBoundaryMs(value.engine.gameTimeMs as number, value.engine.timeZone),
    importClamped: value.engine.importClamped ?? false,
    clockSkippedMs: value.engine.clockSkippedMs ?? 0,
  }
  const bundle: PortablePetBundleV1 = {
    format: PORTABLE_BUNDLE_FORMAT,
    schemaVersion: PORTABLE_BUNDLE_SCHEMA_VERSION,
    exportedAtWallMs: value.exportedAtMs as number,
    authority: value.authority,
    originLocalDeviceId: value.originLocalDeviceId as string | undefined,
    shared: value.shared,
    engine: engine as unknown as EngineState,
  }
  assertPortablePetBundle(bundle)
  return bundle
}

/** Pure migration for legacy local v2 documents carrying a duplicate runtime.localDeviceId. */
export function migrateLegacyLocalPetDocumentV2(value: unknown): LocalPetDocumentV2 {
  try {
    assertJsonSafe(value)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'local document is not JSON-safe'
    failSchema('invalid_schema', '$.local', message)
  }
  requireRecord(value, '$.local')
  requireRecord(value.device, '$.local.device')
  assertNonEmptyString(value.device.localDeviceId, '$.local.device.localDeviceId')
  if (value.idempotency !== undefined) assertLocalIdempotencyCache(value.idempotency, '$.local.idempotency')
  requireRecord(value.runtime, '$.local.runtime')
  const runtime: Record<string, unknown> = { ...value.runtime }
  if (Object.prototype.hasOwnProperty.call(runtime, 'localDeviceId')) {
    if (runtime.localDeviceId !== value.device.localDeviceId) {
      failSchema('identity_mismatch', '$.local.runtime.localDeviceId', 'runtime.localDeviceId must match device.localDeviceId')
    }
    delete runtime.localDeviceId
  }
  const migrated = { ...value, runtime }
  backfillLegacyLocalPetDocumentDefaults(migrated)
  assertLocalPetDocumentV2(migrated)
  return migrated as unknown as LocalPetDocumentV2
}

export function migratePortablePetBundle(value: unknown): PortablePetBundleV1 {
  try {
    assertJsonSafe(value)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'portable bundle is not JSON-safe'
    failSchema('invalid_schema', '$.bundle', message)
  }
  requireRecord(value, '$.bundle')
  if (value.schemaVersion === LEGACY_PORTABLE_BUNDLE_SCHEMA_VERSION) return migratePortablePetBundleV0(value)
  if (value.schemaVersion !== PORTABLE_BUNDLE_SCHEMA_VERSION) {
    failSchema(
      'unsupported_schema_version',
      '$.bundle.schemaVersion',
      'unsupported portable bundle schemaVersion: ' + String(value.schemaVersion),
    )
  }
  backfillPortableBundleDefaults(value)
  assertPortablePetBundle(value)
  return value as PortablePetBundleV1
}

export function serializePortablePetBundle(bundle: PortablePetBundleV1): string {
  assertPortablePetBundle(bundle)
  return stableStringify(bundle)
}

export function deserializePortablePetBundle(serialized: string): PortablePetBundleV1 {
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch {
    failSchema('invalid_schema', '$.bundle', 'portable bundle is not valid JSON')
  }
  try {
    assertJsonSafe(parsed)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'portable bundle is not JSON-safe'
    failSchema('invalid_schema', '$.bundle', message)
  }
  return migratePortablePetBundle(parsed)
}

const LOCAL_OP_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
function assertLocalBoundedString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) failSchema('invalid_schema', path, 'expected a non-empty bounded string')
}
function assertLocalIdempotencyCache(value: unknown, path: string): void {
  requireRecord(value, path)
  assertOnlyKeys(value, ['schemaVersion', 'records'], path)
  if (value.schemaVersion !== 2) failSchema('unsupported_schema_version', path + '.schemaVersion', 'expected idempotency schema version 2')
  if (Array.isArray(value.records) === false) failSchema('invalid_schema', path + '.records', 'expected array')
  const seen = new Set<string>()
  for (const record of value.records) {
    requireRecord(record, path + '.records[]')
    assertRequiredKeys(record, ['petId', 'deviceId', 'opId', 'commandType', 'resultPresent'], path + '.records[]')
    assertOnlyKeys(record, ['petId', 'deviceId', 'opId', 'commandType', 'resultPresent', 'result', 'error'], path + '.records[]')

    assertLocalBoundedString(record.petId, path + '.records[].petId')
    assertLocalBoundedString(record.deviceId, path + '.records[].deviceId')
    if (typeof record.opId !== 'string' || LOCAL_OP_ID_PATTERN.test(record.opId) === false) failSchema('invalid_schema', path + '.records[].opId', 'invalid opId')
    if (typeof record.commandType !== 'string' || isCommandKey(record.commandType) === false) failSchema('invalid_schema', path + '.records[].commandType', 'unknown command type')
    if (typeof record.resultPresent !== 'boolean') failSchema('invalid_schema', path + '.records[].resultPresent', 'expected boolean')
    const hasResult = Object.prototype.hasOwnProperty.call(record, 'result')
    const hasError = Object.prototype.hasOwnProperty.call(record, 'error')
    if (hasResult && hasError) failSchema('invalid_schema', path + '.records[]', 'result and error are mutually exclusive')
    if (record.resultPresent) {
      if (hasResult === false) failSchema('invalid_schema', path + '.records[]', 'resultPresent requires result')
      if (hasError) failSchema('invalid_schema', path + '.records[]', 'resultPresent cannot have error')
    } else if (hasResult) {
      failSchema('invalid_schema', path + '.records[]', 'resultPresent=false cannot have result')
    } else if (hasError) {
      requireRecord(record.error, path + '.records[].error')
      assertRequiredKeys(record.error, ['code', 'message', 'refreshProjection'], path + '.records[].error')
      assertOnlyKeys(record.error, ['code', 'message', 'refreshProjection', 'retryable'], path + '.records[].error')
      if (typeof record.error.code !== 'string' || COMMAND_ERROR_CODES.includes(record.error.code as never) === false) failSchema('invalid_schema', path + '.records[].error.code', 'unknown command error code')
      assertNonEmptyString(record.error.message, path + '.records[].error.message')
      if (typeof record.error.refreshProjection !== 'boolean') failSchema('invalid_schema', path + '.records[].error.refreshProjection', 'expected boolean')
      if (record.error.retryable !== undefined && typeof record.error.retryable !== 'boolean') failSchema('invalid_schema', path + '.records[].error.retryable', 'expected boolean')
    }
    const key = JSON.stringify([record.petId, record.deviceId, record.opId])
    if (seen.has(key)) failSchema('invalid_schema', path + '.records', 'duplicate idempotency key')
    seen.add(key)
  }
}

export function assertLocalPetDocumentV2(value: unknown): asserts value is LocalPetDocumentV2 {
  try {
    assertJsonSafe(value)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'local document is not JSON-safe'
    failSchema('invalid_schema', '$.local', message)
  }
  requireRecord(value, '$.local')
  assertNoForbiddenJsonKey({
    format: value.format,
    schemaVersion: value.schemaVersion,
    revision: value.revision,
    eventSeq: value.eventSeq,
    authority: value.authority,
    runtime: value.runtime,
  }, '$.local')
  assertNoForbiddenJsonKey(value.bundle, '$.local.bundle', { includeSessionAnswerKeys: false })
  assertNoForbiddenJsonKey(value.device, '$.local.device', { includeNeverUpload: false })
  assertSchemaVersion(value.schemaVersion, LOCAL_DOCUMENT_SCHEMA_VERSION, '$.local.schemaVersion', 'local document')
  if (value.format !== LOCAL_DOCUMENT_FORMAT) failSchema('unsupported_format', '$.local.format', 'expected ' + LOCAL_DOCUMENT_FORMAT)
  assertRequiredKeys(value, ['format', 'schemaVersion', 'revision', 'eventSeq', 'authority', 'bundle', 'runtime', 'device'], '$.local')
  assertOnlyKeys(value, ['format', 'schemaVersion', 'revision', 'eventSeq', 'authority', 'bundle', 'runtime', 'device', 'idempotency', 'eventHistory'], '$.local')
  requireNonNegativeInteger(value.revision, '$.local.revision')
  requireNonNegativeInteger(value.eventSeq, '$.local.eventSeq')
  requireRecord(value.authority, '$.local.authority')
  assertRequiredKeys(value.authority, ['state', 'stamp'], '$.local.authority')
  assertOnlyKeys(value.authority, ['state', 'stamp'], '$.local.authority')
  if (isEnum(value.authority.state, ['active', 'handoff_pending', 'archived'] as const) === false) {
    failSchema('invalid_schema', '$.local.authority.state', 'invalid local authority state')
  }
  assertAuthorityStamp(value.authority.stamp, '$.local.authority.stamp')
  assertPortablePetBundle(value.bundle)
  if (stableStringify(value.authority.stamp) !== stableStringify(value.bundle.authority)) {
    failSchema('identity_mismatch', '$.local.authority.stamp', 'local authority stamp must exactly match bundle.authority')
  }
  if (value.revision !== value.bundle.authority.revision || value.eventSeq !== value.bundle.authority.eventSeq) {
    failSchema('invalid_schema', '$.local', 'local revision/eventSeq must match the bundle authority stamp')
  }
  if (value.idempotency !== undefined) assertLocalIdempotencyCache(value.idempotency, '$.local.idempotency')
  if (value.eventHistory !== undefined) {
    if (Array.isArray(value.eventHistory) === false) failSchema('invalid_schema', '$.local.eventHistory', 'expected array')
    let previousEventSeq = 0
    for (const event of value.eventHistory) {
      requireRecord(event, '$.local.eventHistory[]')
      assertRequiredKeys(event, ['eventSeq', 'type', 'payload'], '$.local.eventHistory[]')
      assertOnlyKeys(event, ['eventSeq', 'type', 'payload', 'revision', 'gameTimeMs', 'commandSeq'], '$.local.eventHistory[]')
      requireNonNegativeInteger(event.eventSeq, '$.local.eventHistory[].eventSeq')
      if (event.eventSeq <= previousEventSeq || event.eventSeq <= 0) failSchema('invalid_schema', '$.local.eventHistory', 'event sequence must increase')
      previousEventSeq = event.eventSeq
      if (event.revision !== undefined) requireNonNegativeInteger(event.revision, '$.local.eventHistory[].revision')
      if (event.gameTimeMs !== undefined) requireNonNegativeInteger(event.gameTimeMs, '$.local.eventHistory[].gameTimeMs')
      if (event.commandSeq !== undefined) requireNonNegativeInteger(event.commandSeq, '$.local.eventHistory[].commandSeq')
      if (typeof event.type !== 'string' || ORDERED_EVENT_TYPES.includes(event.type as never) === false) failSchema('invalid_schema', '$.local.eventHistory[].type', 'unknown ordered event type')
      requireRecord(event.payload, '$.local.eventHistory[].payload')
    }
    if (previousEventSeq > value.eventSeq) failSchema('invalid_schema', '$.local.eventHistory', 'event history exceeds document eventSeq')
  }
  requireRecord(value.runtime, '$.local.runtime')
  assertRequiredKeys(value.runtime, ['appInstanceId', 'startedAtWallMs'], '$.local.runtime')
  assertOnlyKeys(value.runtime, ['appInstanceId', 'startedAtWallMs'], '$.local.runtime')
  assertNonEmptyString(value.runtime.appInstanceId, '$.local.runtime.appInstanceId')
  requireNonNegativeInteger(value.runtime.startedAtWallMs, '$.local.runtime.startedAtWallMs')
  assertDeviceLocalOverlay(value.device)
  const activeLocalAuthority = value.authority.state === 'active'
  if (activeLocalAuthority && value.authority.stamp.owner !== 'local') {
    failSchema('identity_mismatch', '$.local.authority.stamp.owner', 'active local authority requires local-owned authority')
  }
  if (activeLocalAuthority && value.bundle.authority.owner !== 'local') {
    failSchema('identity_mismatch', '$.local.bundle.authority.owner', 'active local authority requires local-owned bundle authority')
  }
  if (activeLocalAuthority && value.bundle.originLocalDeviceId === undefined) {
    failSchema('missing_field', '$.local.bundle.originLocalDeviceId', 'active local authority requires originLocalDeviceId')
  }
  if (value.bundle.originLocalDeviceId !== undefined && value.device.localDeviceId !== value.bundle.originLocalDeviceId) {
    failSchema('identity_mismatch', '$.local.device.localDeviceId', 'localDeviceId must match bundle originLocalDeviceId')
  }
}

export function validateLocalPetDocumentV2(value: unknown): value is LocalPetDocumentV2 {
  try {
    assertLocalPetDocumentV2(value)
    return true
  } catch {
    return false
  }
}

export function assertRemoteProjectionCacheV2(value: unknown): asserts value is RemoteProjectionCacheV2 {
  requireRecord(value, '$.cache')
  assertSchemaVersion(value.schemaVersion, REMOTE_PROJECTION_CACHE_SCHEMA_VERSION, '$.cache.schemaVersion', 'remote projection cache')
  if (value.format !== REMOTE_PROJECTION_CACHE_FORMAT) {
    failSchema('unsupported_format', '$.cache.format', 'expected ' + REMOTE_PROJECTION_CACHE_FORMAT)
  }
  assertRequiredKeys(value, [
    'format', 'schemaVersion', 'petId', 'deviceId', 'revision', 'eventSeq', 'gameTimeMs',
    'timeZone', 'advanceWhileEmpty', 'authority', 'shared', 'device',
  ], '$.cache')
  assertOnlyKeys(value, [
    'format', 'schemaVersion', 'petId', 'deviceId', 'revision', 'eventSeq', 'gameTimeMs',
    'timeZone', 'advanceWhileEmpty', 'weatherLocation', 'authority', 'shared', 'device',
  ], '$.cache')
  assertNonEmptyString(value.petId, '$.cache.petId')
  assertNonEmptyString(value.deviceId, '$.cache.deviceId')
  requireNonNegativeInteger(value.revision, '$.cache.revision')
  requireNonNegativeInteger(value.eventSeq, '$.cache.eventSeq')
  requireNonNegativeInteger(value.gameTimeMs, '$.cache.gameTimeMs')
  assertNonEmptyString(value.timeZone, '$.cache.timeZone')
  if (typeof value.advanceWhileEmpty !== 'boolean') failSchema('invalid_schema', '$.cache.advanceWhileEmpty', 'expected a boolean')
  if (value.weatherLocation !== undefined && typeof value.weatherLocation !== 'string') {
    failSchema('invalid_schema', '$.cache.weatherLocation', 'expected a string')
  }
  assertWireAuthority(value.authority, '$.cache.authority')
  assertSharedSaveData(value.shared)
  assertDeviceLocalOverlay(value.device)
}

export function validateRemoteProjectionCacheV2(value: unknown): value is RemoteProjectionCacheV2 {
  try {
    assertRemoteProjectionCacheV2(value)
    return true
  } catch {
    return false
  }
}

export type { SchemaError }
