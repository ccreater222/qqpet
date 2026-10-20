import type { DomainEvent } from './events'
import { sessionActivityForInterval, type SessionActivity } from './coverage'
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
  /** Per-minute live client count hook for mid-catch-up connects/disconnects. */
  liveActiveClientCountAtWallMs?: (wallMs: number) => number
  /** Per-minute coverage override for hosts that update coverage as catch-up proceeds. */
  coverageAtWallMs?: (fromWallMs: number, toWallMs: number) => SessionActivity
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

  if (candidate.advanceWhileEmpty === false && liveClients === 0 && options.liveActiveClientCountAtWallMs === undefined) {
    candidate.lastSchedulerWallMs = targetWallMs
    return {
      ok: true, state: candidate, events: [], ticks: 0,
      targetWallMs, catchingUp: false, frozen: true,
    }
  }

  const due = wholeFixedTicksBetween(anchor, targetWallMs)
  const ticks = Math.min(due, maxChunkTicks)
  const events: DomainEvent[] = []
  let completed = 0
  for (let index = 0; index < ticks; index++) {
    const fromWallMs = anchor + index * GAME_MINUTE_MS
    const toWallMs = fromWallMs + GAME_MINUTE_MS
    const liveAtMinute = options.liveActiveClientCountAtWallMs?.(fromWallMs) ?? liveClients
    nonNegativeInteger(liveAtMinute, 'liveActiveClientCountAtWallMs')
    const activity = options.coverageAtWallMs?.(fromWallMs, toWallMs) ??
      sessionActivityForInterval(candidate.sessionCoverage, fromWallMs, toWallMs)
    if (candidate.advanceWhileEmpty === false && liveAtMinute === 0 && activity.activeClientCount === 0) {
      candidate.lastSchedulerWallMs = fromWallMs
      return {
        ok: true, state: candidate, events, ticks: completed,
        targetWallMs, catchingUp: false, frozen: true,
      }
    }
    const tickCtx: RuntimeContext = {
      ...ctx,
      gameTimeMs: candidate.gameTimeMs,
      activeClientCount: activity.activeClientCount,
      sessionActive: activity.sessionActive,
      actorDeviceId: null,
    }
    events.push(...advanceMinuteInPlace(candidate, tickCtx))
    completed++
  }
  candidate.lastSchedulerWallMs = completed < due ? anchor + completed * GAME_MINUTE_MS : targetWallMs
  return {
    ok: true,
    state: candidate,
    events,
    ticks: completed,
    targetWallMs,
    catchingUp: completed < due,
    frozen: false,
  }
}

export const advanceScheduler = advanceSchedulerChunk
