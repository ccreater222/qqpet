import type { CommandError, PetCommand } from '../sync/protocol'
import type { RuntimeOutcome, RuntimeCommandContext } from './runtime-types'
import { executeCommand } from './runtime'
import { reject } from './runtime-helpers'
import type { EngineState, JsonValue } from './types'

/** Host-persistable opId record. Event/state payloads are intentionally not duplicated here. */
export interface IdempotencyRecord {
  commandType: PetCommand['type']
  result?: JsonValue
  error?: CommandError
}

export type OpIdCache = Record<string, IdempotencyRecord>

export interface IdempotentCommandOutcome {
  outcome: RuntimeOutcome
  cache: OpIdCache
  duplicate: boolean
}

/** Pure opId cache wrapper: a duplicate returns the stored result and never re-executes the command. */
export function executeCommandIdempotent(
  state: EngineState,
  command: PetCommand,
  ctx: RuntimeCommandContext,
  opId: string,
  cache: OpIdCache = {},
): IdempotentCommandOutcome {
  if (typeof opId !== 'string' || opId.length === 0) reject('invalid_payload', 'opId must be a non-empty string')
  const existing = cache[opId]
  if (existing !== undefined) {
    if (existing.commandType !== command.type) {
      return {
        cache,
        duplicate: true,
        outcome: {
          ok: false,
          events: [],
          error: { code: 'invalid_payload', message: 'opId was already used for a different command', refreshProjection: false },
        },
      }
    }
    if (existing.error !== undefined) {
      return { cache, duplicate: true, outcome: { ok: false, events: [], error: existing.error } }
    }
    return {
      cache,
      duplicate: true,
      outcome: { ok: true, state, events: [], ...(existing.result === undefined ? {} : { result: existing.result }) },
    }
  }
  const outcome = executeCommand(state, command, ctx)
  const record: IdempotencyRecord = outcome.ok
    ? { commandType: command.type, ...(outcome.result === undefined ? {} : { result: outcome.result }) }
    : { commandType: command.type, error: outcome.error }
  return { outcome, cache: { ...cache, [opId]: record }, duplicate: false }
}
