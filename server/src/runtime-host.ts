import {
  createHeadlessRuntime,
  type DomainEvent,
  type EngineState,
  type RuntimeCommandContext,
  type RuntimeOutcome,
} from '../../src/shared/pet-runtime/index'
import type { PetCommand } from '../../src/shared/sync/protocol'

export interface RuntimeCommandInput {
  command: PetCommand
  deviceId: string
  role: 'owner' | 'player'
  gameTimeMs: number
}

export interface RuntimeCommandOutput {
  outcome: RuntimeOutcome
  engine: EngineState
}

export interface TickOutput {
  ok: true
  engine: EngineState
  events: DomainEvent[]
  ticks: number
}

/**
 * The host deliberately holds no mutable engine: every operation is computed
 * from the canonical snapshot supplied by the command service.
 */
export class RuntimeHost {
  execute(state: EngineState, input: RuntimeCommandInput): RuntimeCommandOutput {
    const context: RuntimeCommandContext = {
      gameTimeMs: input.gameTimeMs,
      environment: state.environment,
      activeClientCount: 1,
      sessionActive: true,
      actorDeviceId: input.deviceId,
      actorRole: input.role,
    }
    const runtime = createHeadlessRuntime(state)
    const outcome = runtime.execute(input.command, context)
    return { outcome, engine: runtime.snapshot() }
  }

  advance(state: EngineState, minutes: number, activeClientCount: number): TickOutput {
    const runtime = createHeadlessRuntime(state)
    const outcome = runtime.advance({
      gameTimeMs: state.gameTimeMs,
      environment: state.environment,
      activeClientCount,
      sessionActive: activeClientCount > 0,
      actorDeviceId: null,
    }, minutes)
    if (outcome.ok === false) throw new Error(outcome.error.code + ': ' + outcome.error.message)
    return { ok: true, engine: outcome.state, events: outcome.events, ticks: minutes }
  }
}
