import type { CommandError, PetCommand } from '../sync/protocol'
import { isCommandKey } from '../sync/command-validation'
import { assertEngineState } from '../sync/portable'
import type { RuntimeOutcome, RuntimeCommandContext } from './runtime-types'
import { executeCommand } from './runtime'
import { reject } from './runtime-helpers'
import { stableStringify } from './serialization'
import type { EngineState, JsonValue } from './types'

export const OP_ID_CACHE_SCHEMA_VERSION = 2
export const PERSISTED_RUNTIME_SCHEMA_VERSION = 2
export const LEGACY_OP_ID_CACHE_SCHEMA_VERSION = 1
export const LEGACY_PERSISTED_RUNTIME_SCHEMA_VERSION = 1

/** Host-persistable opId record. Events/state are intentionally not duplicated here. */
export interface IdempotencyRecord {
  petId: string
  deviceId: string
  opId: string
  commandType: PetCommand['type']
  /** True means result is present (including explicit null); false means no-result success. */
  resultPresent: boolean
  result?: JsonValue
  error?: CommandError
}

/** Serializable, prototype-safe cache. Never use an object keyed by client opId. */
export interface OpIdCache {
  schemaVersion: typeof OP_ID_CACHE_SCHEMA_VERSION
  records: IdempotencyRecord[]
}

/** Host-persistable runtime document. Engine and idempotency cache commit atomically together. */
export interface PersistedRuntimeState {
  schemaVersion: typeof PERSISTED_RUNTIME_SCHEMA_VERSION
  engine: EngineState
  idempotency: OpIdCache
}

export interface IdempotentCommandOutcome {
  outcome: RuntimeOutcome
  document: PersistedRuntimeState
  duplicate: boolean
}

const OP_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
const RECORD_KEYS = ['petId', 'deviceId', 'opId', 'commandType', 'resultPresent', 'result', 'error'] as const
const ERROR_KEYS = ['code', 'message', 'refreshProjection', 'retryable'] as const
const COMMAND_ERROR_CODES = new Set([
  'invalid_payload', 'no_pet', 'pet_dead', 'paused', 'busy', 'insufficient_funds',
  'insufficient_item', 'not_available', 'wrong_phase', 'already_claimed', 'cooldown',
  'unauthorized', 'offline', 'server_catching_up', 'authority_not_active',
  'authority_fork_risk', 'authority_reset_required', 'anchor_out_of_bounds', 'internal',
])

function validateBoundedString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    reject('invalid_payload', name + ' must be a non-empty bounded string')
  }
}

function validateOpId(value: unknown): asserts value is string {
  if (typeof value !== 'string') reject('invalid_payload', 'opId must be a string')
  if (OP_ID_PATTERN.test(value) === false) reject('invalid_payload', 'opId must be 1-128 safe identifier characters')
}

function validateError(value: unknown): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) reject('invalid_payload', 'idempotency error must be an object')
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (ERROR_KEYS.includes(key as typeof ERROR_KEYS[number]) === false) reject('invalid_payload', 'unknown idempotency error field')
  }
  if (typeof record.code !== 'string' || COMMAND_ERROR_CODES.has(record.code) === false) reject('invalid_payload', 'invalid idempotency error code')
  if (typeof record.message !== 'string' || record.message.length === 0) reject('invalid_payload', 'invalid idempotency error message')
  if (typeof record.refreshProjection !== 'boolean') reject('invalid_payload', 'invalid idempotency refreshProjection')
  if (record.retryable !== undefined && typeof record.retryable !== 'boolean') reject('invalid_payload', 'invalid idempotency retryable')
}

function validateRecord(value: unknown): asserts value is IdempotencyRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) reject('invalid_payload', 'idempotency record must be an object')
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (RECORD_KEYS.includes(key as typeof RECORD_KEYS[number]) === false) reject('invalid_payload', 'unknown idempotency record field')
  }
  validateBoundedString(record.petId, 'idempotency petId')
  validateBoundedString(record.deviceId, 'idempotency deviceId')
  validateOpId(record.opId)
  if (typeof record.commandType !== 'string' || isCommandKey(record.commandType) === false) reject('invalid_payload', 'invalid idempotency commandType')
  if (typeof record.resultPresent !== 'boolean') reject('invalid_payload', 'idempotency resultPresent must be boolean')
  const hasResult = Object.prototype.hasOwnProperty.call(record, 'result')
  const hasError = Object.prototype.hasOwnProperty.call(record, 'error')
  if (hasResult && hasError) reject('invalid_payload', 'idempotency result and error are mutually exclusive')
  if (record.resultPresent) {
    if (hasResult === false) reject('invalid_payload', 'resultPresent=true requires a result property')
    if (hasError) reject('invalid_payload', 'resultPresent=true cannot carry an error')
    if (record.result === undefined) reject('invalid_payload', 'idempotency result must be present')
    try { stableStringify(record.result) } catch { reject('invalid_payload', 'idempotency result is not JSON-safe') }
  } else {
    if (hasResult) reject('invalid_payload', 'resultPresent=false cannot carry a result property')
    if (hasError) validateError(record.error)
  }
}

function validateLegacyRecord(value: unknown): asserts value is Omit<IdempotencyRecord, 'resultPresent'> & { resultPresent?: never } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) reject('invalid_payload', 'legacy idempotency record must be an object')
  const record = value as Record<string, unknown>
  const legacyKeys = ['petId', 'deviceId', 'opId', 'commandType', 'result', 'error']
  for (const key of Object.keys(record)) {
    if (legacyKeys.includes(key) === false) reject('invalid_payload', 'unknown legacy idempotency record field')
  }
  validateBoundedString(record.petId, 'idempotency petId')
  validateBoundedString(record.deviceId, 'idempotency deviceId')
  validateOpId(record.opId)
  if (typeof record.commandType !== 'string' || isCommandKey(record.commandType) === false) reject('invalid_payload', 'invalid idempotency commandType')
  const hasResult = Object.prototype.hasOwnProperty.call(record, 'result')
  const hasError = Object.prototype.hasOwnProperty.call(record, 'error')
  if (hasResult && hasError) reject('invalid_payload', 'legacy idempotency result and error are mutually exclusive')
  if (hasResult) {
    if (record.result === undefined) reject('invalid_payload', 'legacy idempotency result must be present')
    try { stableStringify(record.result) } catch { reject('invalid_payload', 'legacy idempotency result is not JSON-safe') }
  }
  if (hasError) validateError(record.error)
}

function migrateLegacyRecord(value: unknown): IdempotencyRecord {
  validateLegacyRecord(value)
  const record = value as Record<string, unknown>
  return {
    petId: record.petId as string,
    deviceId: record.deviceId as string,
    opId: record.opId as string,
    commandType: record.commandType as PetCommand['type'],
    resultPresent: Object.prototype.hasOwnProperty.call(record, 'result'),
    ...(Object.prototype.hasOwnProperty.call(record, 'result') ? { result: record.result as JsonValue } : {}),
    ...(Object.prototype.hasOwnProperty.call(record, 'error') ? { error: record.error as CommandError } : {}),
  }
}

function validateCurrentCache(value: unknown): asserts value is OpIdCache {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) reject('invalid_payload', 'idempotency cache must be an object')
  const cache = value as Record<string, unknown>
  if (Object.keys(cache).some(key => key !== 'schemaVersion' && key !== 'records')) reject('invalid_payload', 'unknown idempotency cache field')
  if (cache.schemaVersion !== OP_ID_CACHE_SCHEMA_VERSION) reject('invalid_payload', 'unsupported idempotency cache schema version')
  if (Array.isArray(cache.records) === false) reject('invalid_payload', 'idempotency cache records must be an array')
  const keys = new Set<string>()
  for (const record of cache.records) {
    validateRecord(record)
    const key = JSON.stringify([record.petId, record.deviceId, record.opId])
    if (keys.has(key)) reject('invalid_payload', 'duplicate idempotency cache key')
    keys.add(key)
  }
}

export function migrateOpIdCache(value: unknown): OpIdCache {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) reject('invalid_payload', 'idempotency cache must be an object')
  const cache = value as Record<string, unknown>
  if (cache.schemaVersion === LEGACY_OP_ID_CACHE_SCHEMA_VERSION) {
    if (Object.keys(cache).some(key => key !== 'schemaVersion' && key !== 'records')) reject('invalid_payload', 'unknown legacy idempotency cache field')
    if (Array.isArray(cache.records) === false) reject('invalid_payload', 'legacy idempotency cache records must be an array')
    const records = cache.records.map(migrateLegacyRecord)
    const keys = new Set<string>()
    for (const record of records) {
      const key = JSON.stringify([record.petId, record.deviceId, record.opId])
      if (keys.has(key)) reject('invalid_payload', 'duplicate idempotency cache key')
      keys.add(key)
    }
    return { schemaVersion: OP_ID_CACHE_SCHEMA_VERSION, records }
  }
  if (cache.schemaVersion === OP_ID_CACHE_SCHEMA_VERSION) {
    validateCurrentCache(cache)
    return { schemaVersion: OP_ID_CACHE_SCHEMA_VERSION, records: cache.records as IdempotencyRecord[] }
  }
  reject('invalid_payload', 'unsupported idempotency cache schema version')
}

export function migratePersistedRuntimeState(value: unknown): PersistedRuntimeState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) reject('invalid_payload', 'persisted runtime state must be an object')
  const document = value as Record<string, unknown>
  if (Object.keys(document).some(key => key !== 'schemaVersion' && key !== 'engine' && key !== 'idempotency')) {
    reject('invalid_payload', 'unknown persisted runtime state field')
  }
  if (document.schemaVersion !== PERSISTED_RUNTIME_SCHEMA_VERSION && document.schemaVersion !== LEGACY_PERSISTED_RUNTIME_SCHEMA_VERSION) {
    reject('invalid_payload', 'unsupported persisted runtime schema version')
  }
  assertEngineState(document.engine)
  const idempotency = migrateOpIdCache(document.idempotency)
  return {
    schemaVersion: PERSISTED_RUNTIME_SCHEMA_VERSION,
    engine: document.engine as EngineState,
    idempotency,
  }
}

export function emptyOpIdCache(): OpIdCache {
  return { schemaVersion: OP_ID_CACHE_SCHEMA_VERSION, records: [] }
}

export function validateOpIdCache(value: unknown): asserts value is OpIdCache {
  migrateOpIdCache(value)
}

export function validatePersistedRuntimeState(value: unknown): asserts value is PersistedRuntimeState {
  migratePersistedRuntimeState(value)
}

export function clonePersistedRuntimeState(document: PersistedRuntimeState): PersistedRuntimeState {
  const current = migratePersistedRuntimeState(document)
  return JSON.parse(stableStringify(current)) as PersistedRuntimeState
}

export function serializePersistedRuntimeState(document: PersistedRuntimeState): string {
  const current = migratePersistedRuntimeState(document)
  return stableStringify(current)
}

export function deserializePersistedRuntimeState(text: string): PersistedRuntimeState {
  if (typeof text !== 'string') reject('invalid_payload', 'persisted runtime state must be a string')
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { reject('invalid_payload', 'persisted runtime state must be valid JSON') }
  const current = migratePersistedRuntimeState(parsed)
  validatePersistedRuntimeState(current)
  return current
}

function findRecord(document: PersistedRuntimeState, petId: string, deviceId: string, opId: string): IdempotencyRecord | undefined {
  return document.idempotency.records.find(record => record.petId === petId && record.deviceId === deviceId && record.opId === opId)
}

/**
 * Executes one command against one atomic persisted document. Callers must
 * serialize command execution (one command at a time per pet) and persist the
 * returned document in one transaction; engine and cache must never be split.
 */
export function executeCommandIdempotent(
  petId: string,
  deviceId: string,
  document: PersistedRuntimeState,
  command: PetCommand,
  ctx: RuntimeCommandContext,
  opId: string,
): IdempotentCommandOutcome {
  validateBoundedString(petId, 'petId')
  validateBoundedString(deviceId, 'deviceId')
  validateOpId(opId)
  const current = migratePersistedRuntimeState(document)
  validatePersistedRuntimeState(current)
  const existing = findRecord(current, petId, deviceId, opId)
  if (existing !== undefined) {
    if (existing.commandType !== command.type) {
      return {
        duplicate: true,
        document: current,
        outcome: {
          ok: false,
          events: [],
          error: { code: 'invalid_payload', message: 'opId was already used for a different command', refreshProjection: false },
        },
      }
    }
    if (existing.error !== undefined) {
      return { duplicate: true, document: current, outcome: { ok: false, events: [], error: existing.error } }
    }
    return {
      duplicate: true,
      document: current,
      outcome: existing.resultPresent
        ? { ok: true, state: current.engine, events: [], result: existing.result as JsonValue }
        : { ok: true, state: current.engine, events: [] },
    }
  }
  const outcome = executeCommand(current.engine, command, ctx)
  const record: IdempotencyRecord = outcome.ok
    ? outcome.result === undefined
      ? { petId, deviceId, opId, commandType: command.type, resultPresent: false }
      : { petId, deviceId, opId, commandType: command.type, resultPresent: true, result: outcome.result }
    : { petId, deviceId, opId, commandType: command.type, resultPresent: false, error: outcome.error }
  return {
    duplicate: false,
    document: {
      schemaVersion: PERSISTED_RUNTIME_SCHEMA_VERSION,
      engine: outcome.ok ? outcome.state : current.engine,
      idempotency: { schemaVersion: OP_ID_CACHE_SCHEMA_VERSION, records: [...current.idempotency.records, record] },
    },
    outcome,
  }
}

/**
 * Minimal synchronous serialized executor for hosts that do not already own a
 * command queue. It holds one combined persisted document, clones on
 * construction/snapshot, and rejects reentrant execution explicitly.
 */
export class SerializedIdempotentExecutor {
  private readonly petId: string
  private readonly deviceId: string
  private document: PersistedRuntimeState
  private executing = false
  private tail: Promise<void> = Promise.resolve()

  constructor(petId: string, deviceId: string, initialDocument: PersistedRuntimeState) {
    validateBoundedString(petId, 'petId')
    validateBoundedString(deviceId, 'deviceId')
    this.petId = petId
    this.deviceId = deviceId
    this.document = clonePersistedRuntimeState(initialDocument)
  }

  execute(command: PetCommand, ctx: RuntimeCommandContext, opId: string): IdempotentCommandOutcome {
    if (this.executing) reject('busy', 'serialized idempotent executor is already executing')
    this.executing = true
    try {
      const result = executeCommandIdempotent(this.petId, this.deviceId, this.document, command, ctx, opId)
      this.document = clonePersistedRuntimeState(result.document)
      return { ...result, document: clonePersistedRuntimeState(result.document) }
    } finally {
      this.executing = false
    }
  }

  /** Serializes concurrent async callers through this executor. */
  executeSerialized(command: PetCommand, ctx: RuntimeCommandContext, opId: string): Promise<IdempotentCommandOutcome> {
    const run = this.tail.then(() => this.execute(command, ctx, opId))
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  snapshot(): PersistedRuntimeState {
    return clonePersistedRuntimeState(this.document)
  }
}

export function createPersistedRuntimeState(engine: EngineState, idempotency: OpIdCache = emptyOpIdCache()): PersistedRuntimeState {
  return { schemaVersion: PERSISTED_RUNTIME_SCHEMA_VERSION, engine, idempotency }
}
