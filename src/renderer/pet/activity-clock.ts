import type { OrderedEvent } from '../../shared/pet-runtime/events'
import type { RendererProjection } from '../../shared/renderer-api'

export type ActivityKind = 'work' | 'study' | 'trip'

export interface ActivityClockSample {
  kind: ActivityKind
  /** Game time when the host committed the activity start. */
  startedAtGameMs: number
  /** Game time when the host will complete the activity. */
  dueAtGameMs: number
}

export interface ActivityClockDeps {
  onProjection(listener: (projection: RendererProjection, events: OrderedEvent[]) => void): () => void
  onEvent(listener: (event: OrderedEvent) => void): () => void
}

export interface ActivityClock {
  /** Whole game minutes since the host started `kind`, or null when unknown. */
  elapsedMinutes(kind: ActivityKind): number | null
  sample(kind: ActivityKind): ActivityClockSample | null
}

function kindOf(value: unknown): ActivityKind | null {
  if (value === 'work' || value === 'study') return value
  if (value === 'trip' || value === 'travel') return 'trip'
  return null
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** Reads the authoritative start/due times from an ordered activity.started event. */
export function activitySampleFromEvent(event: Pick<OrderedEvent, 'type' | 'gameTimeMs' | 'payload'>): ActivityClockSample | null {
  if (event.type !== 'activity.started') return null
  const payload = recordOf(event.payload)
  if (payload === null) return null
  const kind = kindOf(payload.kind)
  const dueAtGameMs = payload.dueAtGameMs
  if (kind === null || typeof dueAtGameMs !== 'number' || Number.isFinite(dueAtGameMs) === false) return null
  return { kind, startedAtGameMs: event.gameTimeMs, dueAtGameMs }
}

/** Elapsed whole minutes clamped to the scheduled duration; null when no sample/time is known. */
export function activityElapsedMinutes(sample: ActivityClockSample | null, gameTimeMs: number | null): number | null {
  if (sample === null || gameTimeMs === null || Number.isFinite(gameTimeMs) === false) return null
  const elapsed = Math.floor((gameTimeMs - sample.startedAtGameMs) / 60_000)
  const duration = Math.max(0, Math.ceil((sample.dueAtGameMs - sample.startedAtGameMs) / 60_000))
  return Math.max(0, Math.min(elapsed, duration))
}

/**
 * Tracks the host's running activity from ordered events and authoritative
 * projections. The renderer never owns the clock: a sample only exists after
 * an `activity.started` event, and a projection that no longer reports the
 * activity clears it.
 */
export function createActivityClock(deps: ActivityClockDeps): ActivityClock {
  let sample: ActivityClockSample | null = null
  let gameTimeMs: number | null = null
  deps.onEvent((event) => {
    const started = activitySampleFromEvent(event)
    if (started !== null) {
      sample = started
      return
    }
    if (event.type !== 'activity.completed') return
    const payload = recordOf(event.payload)
    const kind = payload === null ? null : kindOf(payload.kind)
    if (kind === null || sample === null || sample.kind === kind) sample = null
  })
  deps.onProjection((projection) => {
    gameTimeMs = projection.gameTimeMs
    if (sample === null) return
    const active = projection.save.activeOption
    const value = sample.kind === 'trip' ? active.trip : active[sample.kind]
    if (value === null || value === undefined) sample = null
  })
  return {
    elapsedMinutes(kind) {
      if (sample === null || sample.kind !== kind) return null
      return activityElapsedMinutes(sample, gameTimeMs)
    },
    sample(kind) {
      return sample !== null && sample.kind === kind ? { ...sample } : null
    },
  }
}
