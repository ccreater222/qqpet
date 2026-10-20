import type { CommandError, CommandRole } from '../sync/protocol'
import type { DomainEvent } from './events'
import type { EngineState, JsonValue, RuntimeContext } from './types'

export type RuntimeOutcome =
  | { ok: true; state: EngineState; events: DomainEvent[]; result?: JsonValue }
  | { ok: false; error: CommandError; events: [] }

export interface RuntimeCommandContext extends RuntimeContext {
  /** Host-resolved role. The runtime repeats authorization as defense in depth. */
  actorRole?: CommandRole
  /** Optional host wall anchor, used for coverage bookkeeping when needed. */
  wallNowMs?: number
}

export interface RuntimeBatchOutcome {
  ok: true
  state: EngineState
  events: DomainEvent[]
  ticks: number
}

export interface HeadlessRuntimeOptions {
  /** Maximum minutes accepted by one advance() call. */
  maxBatchMinutes?: number
}
