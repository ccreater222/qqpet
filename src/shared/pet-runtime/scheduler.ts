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
  /** Legacy live-count hint; historical freeze decisions use coverage/per-minute hooks only. */
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
  resumeAtWallMs: number
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
  nonNegativeInteger(state.lastSchedulerWallMs, 'lastSchedulerWallMs')
  nonNegativeInteger(state.gameTimeMs, 'gameTimeMs')

  const candidate = cloneEngine(state)
  const anchor = candidate.lastSchedulerWallMs
  if (targetWallMs <= anchor) {
    candidate.lastSchedulerWallMs = targetWallMs
    return {
      ok: true, state: candidate, events: [], ticks: 0,
      targetWallMs, catchingUp: false, frozen: false, resumeAtWallMs: targetWallMs,
    }
  }

  const due = wholeFixedTicksBetween(anchor, targetWallMs)
  const ticks = Math.min(due, maxChunkTicks)
  const horizonWallMs = anchor + ticks * GAME_MINUTE_MS
  const events: DomainEvent[] = []
  let completed = 0
  const activityAt = (fromWallMs: number, toWallMs: number): SessionActivity =>
    options.coverageAtWallMs?.(fromWallMs, toWallMs) ??
    sessionActivityForInterval(candidate.sessionCoverage, fromWallMs, toWallMs)
  const liveAt = (wallMs: number): number =>
    options.liveActiveClientCountAtWallMs?.(wallMs) ?? 0
  const nextActiveWall = (fromWallMs: number): number => {
    if (options.coverageAtWallMs === undefined) {
      let exactStart = horizonWallMs
      for (const interval of candidate.sessionCoverage) {
        if (interval.disconnectedAtWallMs !== undefined && interval.disconnectedAtWallMs <= fromWallMs) continue
        if (interval.connectedAtWallMs > fromWallMs && interval.connectedAtWallMs < exactStart) {
          exactStart = interval.connectedAtWallMs
        }
      }
      if (exactStart < horizonWallMs) return exactStart
    }
    for (let wallMs = fromWallMs; wallMs < horizonWallMs; wallMs += GAME_MINUTE_MS) {
      const activity = activityAt(wallMs, wallMs + GAME_MINUTE_MS)
      if (activity.activeClientCount > 0 || liveAt(wallMs) > 0) return wallMs
    }
    return horizonWallMs
  }
  for (let index = 0; index < ticks; index++) {
    const fromWallMs = anchor + index * GAME_MINUTE_MS
    const toWallMs = fromWallMs + GAME_MINUTE_MS
    const liveAtMinute = liveAt(fromWallMs)
    nonNegativeInteger(liveAtMinute, 'liveActiveClientCountAtWallMs')
    const activity = activityAt(fromWallMs, toWallMs)
    const activeAtMinute = Math.max(activity.activeClientCount, liveAtMinute)
    if (candidate.advanceWhileEmpty === false && activeAtMinute === 0) {
      const resumeAtWallMs = nextActiveWall(fromWallMs)
      candidate.lastSchedulerWallMs = resumeAtWallMs
      return {
        ok: true, state: candidate, events, ticks: completed,
        targetWallMs, catchingUp: false, frozen: true, resumeAtWallMs,
      }
    }
    const tickCtx: RuntimeContext = {
      ...ctx,
      gameTimeMs: candidate.gameTimeMs,
      activeClientCount: activeAtMinute,
      sessionActive: activeAtMinute > 0,
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
    resumeAtWallMs: candidate.lastSchedulerWallMs,
  }
}

export const advanceScheduler = advanceSchedulerChunk
