import type { DomainEvent } from './events'
import type { EngineState, JsonValue } from './types'
import type { RuntimeCommandContext } from './runtime-types'
import type { RuntimeRng } from './runtime-helpers'

export interface HandlerResult {
  result?: JsonValue
  events: DomainEvent[]
}

export interface HandlerContext {
  state: EngineState
  ctx: RuntimeCommandContext
  rng: RuntimeRng
}

export type CommandHandler<P> = (context: HandlerContext, payload: P) => HandlerResult
