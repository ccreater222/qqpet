import type { DomainEvent } from './events'
import { sessionActivityForInterval } from './coverage'
import { cloneEngine, reject } from './runtime-helpers'
import { advanceMinuteInPlace } from './tick'
import { wholeFixedTicksBetween, GAME_MINUTE_MS } from './time'
import type { EngineState, RuntimeContext } from './types'

export const SCHEDULER_POLL_MS = 1000
export const GAME_TICK_MS = GAME_MINUTE_MS
export const CATCHUP_CHUNK_TICKS = 1440

export interface SchedulerAdvanceOptions {
  /** Defaults to the persisted 1440-minute bounded catch-up chunk. */
  maxChunkTicks?: number
  /** Actual live authenticated clients; defaults to ctx.activeClientCount. */
  liveActiveClientCount?: number
}

export interface SchedulerAdvanceOutcome {
  ok: true
  state: EngineState
  events: DomainEvent[]
  ticks: number
  targetWallMs: number
  catchingUp: boolean
  frozen: boolean
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || Number.isSafeInteger(value) === false || value < 0) {
    reject('invalid_payload', name + ' must be a non-negative safe integer')
  }
  return value
}

/**
 * Advances one bounded scheduler chunk from the persisted game/wall anchors.
 * The host calls this repeatedly; each call is one atomic catch-up commit.
 */
export function advanceSchedulerChunk(
  state: EngineState,
  ctx: RuntimeContext,
  wallNowMs: number,
  options: SchedulerAdvanceOptions = {},
): SchedulerAdvanceOutcome {
  const targetWallMs = nonNegativeInteger(wallNowMs, 'wallNowMs')
  const maxChunkTicks = options.maxChunkTicks ?? CATCHUP_CHUNK_TICKS
  if (Number.isSafeInteger(maxChunkTicks) === false || maxChunkTicks <= 0) {
    reject('invalid_payload', 'maxChunkTicks must be a positive safe integer')
  }
  const liveClients = options.liveActiveClientCount ?? ctx.activeClientCount
  nonNegativeInteger(liveClients, 'liveActiveClientCount')
  nonNegativeInteger(state.lastSchedulerWallMs, 'lastSchedulerWallMs')
  nonNegativeInteger(state.gameTimeMs, 'gameTimeMs')

  const candidate = cloneEngine(state)
  const anchor = candidate.lastSchedulerWallMs
  if (targetWallMs <= anchor) {
    candidate.lastSchedulerWallMs = targetWallMs
    return {
      ok: true, state: candidate, events: [], ticks: 0,
      targetWallMs, catchingUp: false, frozen: false,
    }
  }

  if (candidate.advanceWhileEmpty === false && liveClients === 0) {
    candidate.lastSchedulerWallMs = targetWallMs
    return {
      ok: true, state: candidate, events: [], ticks: 0,
      targetWallMs, catchingUp: false, frozen: true,
    }
  }

  const due = wholeFixedTicksBetween(anchor, targetWallMs)
  const ticks = Math.min(due, maxChunkTicks)
  const events: DomainEvent[] = []
  for (let index = 0; index < ticks; index++) {
    const fromWallMs = anchor + index * GAME_MINUTE_MS
    const toWallMs = fromWallMs + GAME_MINUTE_MS
    const activity = sessionActivityForInterval(candidate.sessionCoverage, fromWallMs, toWallMs)
    const tickCtx: RuntimeContext = {
      ...ctx,
      gameTimeMs: candidate.gameTimeMs,
      activeClientCount: activity.activeClientCount,
      sessionActive: activity.sessionActive,
      actorDeviceId: null,
    }
    events.push(...advanceMinuteInPlace(candidate, tickCtx))
  }
  candidate.lastSchedulerWallMs = ticks < due ? anchor + ticks * GAME_MINUTE_MS : targetWallMs
  return {
    ok: true,
    state: candidate,
    events,
    ticks,
    targetWallMs,
    catchingUp: ticks < due,
    frozen: false,
  }
}

export const advanceScheduler = advanceSchedulerChunk
