import type { CommandError, PetCommand } from '../sync/protocol'
import type { RuntimeOutcome, RuntimeCommandContext } from './runtime-types'
import { executeCommand } from './runtime'
import { reject } from './runtime-helpers'
import type { EngineState, JsonValue } from './types'

/** Host-persistable opId record. Events/state are intentionally not duplicated here. */
export interface IdempotencyRecord {
  petId: string
  deviceId: string
  opId: string
  commandType: PetCommand['type']
  result?: JsonValue
  error?: CommandError
}

/** Serializable, prototype-safe cache. Never use an object keyed by client opId. */
export type OpIdCache = readonly IdempotencyRecord[]

export interface RuntimeCommit {
  state: EngineState
  cache: OpIdCache
}

export interface IdempotentCommandOutcome {
  outcome: RuntimeOutcome
  commit: RuntimeCommit
  duplicate: boolean
}

const OP_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

function validateScope(value: string, name: string): void {
  if (value.length === 0 || value.length > 256) reject('invalid_payload', name + ' must be a non-empty bounded string')
}

function validateOpId(opId: string): void {
  if (OP_ID_PATTERN.test(opId) === false) reject('invalid_payload', 'opId must be 1-128 safe identifier characters')
}

function findRecord(cache: readonly IdempotencyRecord[], petId: string, deviceId: string, opId: string): IdempotencyRecord | undefined {
  return cache.find(record => record.petId === petId && record.deviceId === deviceId && record.opId === opId)
}

/**
 * Pure opId cache wrapper. Callers must serialize command execution (one
 * command at a time per pet) and atomically persist commit.state with
 * commit.cache; this function never mutates its input cache/state.
 */
export function executeCommandIdempotent(
  petId: string,
  deviceId: string,
  state: EngineState,
  command: PetCommand,
  ctx: RuntimeCommandContext,
  opId: string,
  cache: OpIdCache = [],
): IdempotentCommandOutcome {
  validateScope(petId, 'petId')
  validateScope(deviceId, 'deviceId')
  validateOpId(opId)
  const existing = findRecord(cache, petId, deviceId, opId)
  if (existing !== undefined) {
    if (existing.commandType !== command.type) {
      return {
        duplicate: true,
        commit: { state, cache },
        outcome: {
          ok: false,
          events: [],
          error: { code: 'invalid_payload', message: 'opId was already used for a different command', refreshProjection: false },
        },
      }
    }
    if (existing.error !== undefined) {
      return { duplicate: true, commit: { state, cache }, outcome: { ok: false, events: [], error: existing.error } }
    }
    return {
      duplicate: true,
      commit: { state, cache },
      outcome: { ok: true, state, events: [], ...(existing.result === undefined ? {} : { result: existing.result }) },
    }
  }
  const outcome = executeCommand(state, command, ctx)
  const record: IdempotencyRecord = outcome.ok
    ? {
        petId, deviceId, opId, commandType: command.type,
        ...(outcome.result === undefined ? {} : { result: outcome.result }),
      }
    : { petId, deviceId, opId, commandType: command.type, error: outcome.error }
  const nextCache = [...cache, record]
  return {
    duplicate: false,
    commit: { state: outcome.ok ? outcome.state : state, cache: nextCache },
    outcome,
  }
}

/**
 * Minimal synchronous serialized executor for hosts that do not already own a
 * command queue. It keeps one state/cache pair and must not be shared across
 * concurrent async workers without an external queue around it.
 */
export class SerializedIdempotentExecutor {
  private readonly petId: string
  private readonly deviceId: string
  private state: EngineState
  private cache: OpIdCache

  constructor(petId: string, deviceId: string, initialState: EngineState, initialCache: OpIdCache = []) {
    this.petId = petId
    this.deviceId = deviceId
    this.state = initialState
    this.cache = initialCache
  }

  execute(command: PetCommand, ctx: RuntimeCommandContext, opId: string): IdempotentCommandOutcome {
    const result = executeCommandIdempotent(this.petId, this.deviceId, this.state, command, ctx, opId, this.cache)
    this.state = result.commit.state
    this.cache = result.commit.cache
    return result
  }

  snapshot(): RuntimeCommit {
    return { state: this.state, cache: this.cache }
  }
}
