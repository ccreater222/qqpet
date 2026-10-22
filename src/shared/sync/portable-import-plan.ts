import {
  dayKeyAt,
  nextDailyBoundaryMs,
  rebindOrCancelImportedSessions,
  type EngineState,
} from '../pet-runtime/index'
import { assertEngineState, type PortablePetBundleV1 } from './portable'

/** Same default anchor policy as the server portable-import planner. */
export const MAX_IMPORT_ANCHOR_PAST_MS = 48 * 60 * 60 * 1000
export const MAX_IMPORT_FUTURE_SKEW_MS = 5 * 60 * 1000

export type PortableImportPlanErrorCode =
  | 'anchor_out_of_bounds'
  | 'authority_fork_risk'
  | 'invalid_payload'
  | 'authority_not_active'

export interface PortableImportCurrentAuthority {
  owner: 'local' | 'server'
  authorityId: string
  restoreGeneration: number
  epoch: number
  state: 'active' | 'archived' | 'handoff_pending' | 'reset'
  revision: number
  eventSeq: number
  handoffId?: string
}

export interface PortableImportPlanOptions {
  bundle: PortablePetBundleV1
  current: PortableImportCurrentAuthority
  wallNowMs: number
  allowClamp: boolean
  rebindLocalSessions: boolean
  /** Destination's stable local device id; foreign active sessions are rebound or cancelled. */
  destinationLocalDeviceId: string
  expectedEpoch?: number
  /** Server->local detach imports carry the exact archived handoff stamp. */
  exactHandoff?: boolean
  /** Only the owner-detach path may plan a server-owned bundle. */
  allowServerOwner?: boolean
  /** Mirrors the server's first-import adoption rule for an unclaimed destination. */
  adoptIncomingAuthority?: boolean
}

export interface PortableImportPlan {
  engine: EngineState
  authorityId: string
  restoreGeneration: number
  adoptedIncomingAuthority: boolean
  nextEpoch: number
  effectiveAnchorWallMs: number
  clockSkippedMs: number
  importClamped: boolean
  cancelledSessionKinds: string[]
}

export type PortableImportPlanResult =
  | { ok: true; plan: PortableImportPlan }
  | { ok: false; code: PortableImportPlanErrorCode; message: string }

function fail(code: PortableImportPlanErrorCode, message: string): PortableImportPlanResult {
  return { ok: false, code, message }
}

function isSafeNonNegative(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function hasCanonicalDailyBoundaryMetadata(engine: EngineState): boolean {
  try {
    return engine.lastProcessedDayBoundaryKey === dayKeyAt(engine.gameTimeMs, engine.timeZone)
      && engine.nextDailyBoundaryMs === nextDailyBoundaryMs(engine.gameTimeMs, engine.timeZone)
      && engine.nextDailyBoundaryMs > engine.gameTimeMs
  } catch {
    return false
  }
}

function closeImportedCoverage(engine: EngineState, wallNowMs: number): void {
  engine.sessionCoverage = engine.sessionCoverage.map(interval => {
    if (interval.disconnectedAtWallMs !== undefined) return interval
    const closeAt = Math.max(
      interval.connectedAtWallMs,
      Math.min(wallNowMs, interval.lastHeartbeatWallMs + 60_000),
    )
    return {
      ...interval,
      disconnectedAtWallMs: closeAt,
      lastHeartbeatWallMs: Math.max(interval.lastHeartbeatWallMs, closeAt),
      closeReason: 'import_replaced',
    }
  })
}

function activeSessionsByToken(engine: EngineState): Map<string, string> {
  const active = new Map<string, string>()
  for (const session of engine.gameSessions) {
    if (session.status === 'active') active.set(session.sessionToken, session.payload.kind)
  }
  return active
}

/**
 * Deterministic portable-import planner shared by local mode and the server's
 * equivalent policy: fence authority lineage/epoch, validate anchor bounds,
 * optionally realign clocks and deadlines, and settle foreign active sessions.
 */
export function planPortableImportPlan(options: PortableImportPlanOptions): PortableImportPlanResult {
  const { bundle, current, wallNowMs } = options
  if (Number.isSafeInteger(wallNowMs) === false || wallNowMs < 0) {
    return fail('invalid_payload', 'wallNowMs must be a non-negative safe integer')
  }
  const stamp = bundle.authority
  if (stamp.owner !== 'local' && options.allowServerOwner !== true) {
    return fail('invalid_payload', 'portable import requires a local-authority bundle')
  }
  if (options.expectedEpoch !== undefined && options.expectedEpoch !== stamp.epoch) {
    return fail('authority_fork_risk', 'expected epoch does not match the imported bundle epoch')
  }
  const sameLineage = stamp.authorityId === current.authorityId
    && stamp.restoreGeneration === current.restoreGeneration
  // Callers set this only for a fenced owner detach (or the server's unclaimed-
  // destination migration); ordinary portable imports still require lineage.
  const adoptIncomingAuthority = options.adoptIncomingAuthority === true
  if (sameLineage === false && adoptIncomingAuthority === false) {
    return fail('authority_fork_risk', 'bundle authority lineage does not match the destination authority')
  }
  if (stamp.epoch < current.epoch) {
    return fail('authority_fork_risk', 'uploaded bundle epoch is stale')
  }
  if (stamp.epoch === current.epoch) {
    const exactArchivedHandoff = options.exactHandoff === true
      && (current.handoffId === undefined || stamp.handoffId === current.handoffId)
    const nonRegressingActiveReimport = options.exactHandoff !== true
      && current.state === 'active'
      && stamp.revision >= current.revision
      && stamp.eventSeq >= current.eventSeq
    if (exactArchivedHandoff === false && nonRegressingActiveReimport === false) {
      return fail('authority_fork_risk', 'equal epoch is only accepted for the exact archived handoff being resumed')
    }
  }
  if (isSafeNonNegative(stamp.revision) === false || isSafeNonNegative(stamp.eventSeq) === false) {
    return fail('invalid_payload', 'bundle authority revision/eventSeq is invalid')
  }

  let engine: EngineState
  try {
    engine = JSON.parse(JSON.stringify(bundle.engine)) as EngineState
    assertEngineState(engine)
  } catch {
    return fail('invalid_payload', 'bundle engine is invalid')
  }
  const importedAnchor = engine.lastSchedulerWallMs
  if (isSafeNonNegative(importedAnchor) === false) {
    return fail('invalid_payload', 'imported scheduler anchor is invalid')
  }
  if (hasCanonicalDailyBoundaryMetadata(engine) === false) {
    return fail('invalid_payload', 'imported daily-boundary metadata is invalid')
  }

  const pastBound = wallNowMs - MAX_IMPORT_ANCHOR_PAST_MS
  const futureBound = wallNowMs + MAX_IMPORT_FUTURE_SKEW_MS
  let effectiveAnchorWallMs = importedAnchor
  let clockSkippedMs = 0
  let importClamped = false
  if (importedAnchor < pastBound || importedAnchor > futureBound) {
    if (options.allowClamp === false) {
      return fail(
        'anchor_out_of_bounds',
        'imported scheduler anchor is outside the accepted window; explicit allowClamp is required',
      )
    }
    if (importedAnchor < pastBound) {
      effectiveAnchorWallMs = pastBound
      clockSkippedMs = pastBound - importedAnchor
    } else {
      effectiveAnchorWallMs = wallNowMs
      clockSkippedMs = wallNowMs - importedAnchor
    }
    engine.gameTimeMs += clockSkippedMs
    if (isSafeNonNegative(engine.gameTimeMs) === false) {
      return fail('invalid_payload', 'clock realignment would move game time before the epoch')
    }
    for (const job of engine.scheduledJobs) {
      job.dueAtGameMs += clockSkippedMs
      if (typeof job.payload.startedAtGameMs === 'number') job.payload.startedAtGameMs += clockSkippedMs
    }
    for (const session of engine.gameSessions) {
      session.startedAtGameMs += clockSkippedMs
      session.expiresAtGameMs += clockSkippedMs
    }
    engine.lastProcessedDayBoundaryKey = dayKeyAt(engine.gameTimeMs, engine.timeZone)
    engine.nextDailyBoundaryMs = nextDailyBoundaryMs(engine.gameTimeMs, engine.timeZone)
    engine.save.nowTimeLine = Math.floor(engine.gameTimeMs / 1000)
    importClamped = true
    engine.importClamped = true
    engine.clockSkippedMs = clockSkippedMs
  } else if (importedAnchor > wallNowMs) {
    // Future skew inside the accepted window starts at wall now and runs no catch-up.
    effectiveAnchorWallMs = wallNowMs
  }
  engine.lastSchedulerWallMs = effectiveAnchorWallMs

  if (engine.advanceWhileEmpty === false) {
    effectiveAnchorWallMs = wallNowMs
    engine.lastSchedulerWallMs = wallNowMs
  }

  const beforeActive = activeSessionsByToken(engine)
  const localActorDeviceId = bundle.originLocalDeviceId ?? ''
  const rebound = rebindOrCancelImportedSessions(engine, {
    localActorDeviceId,
    newActorDeviceId: options.destinationLocalDeviceId,
    rebindLocalSessions: options.rebindLocalSessions,
    nowMs: engine.gameTimeMs,
  })
  closeImportedCoverage(rebound, wallNowMs)
  delete rebound.coverageReopen
  const afterActive = activeSessionsByToken(rebound)
  const cancelledSessionKinds: string[] = []
  for (const [sessionToken, kind] of beforeActive) {
    if (afterActive.has(sessionToken) === false && cancelledSessionKinds.includes(kind) === false) {
      cancelledSessionKinds.push(kind)
    }
  }

  try {
    assertEngineState(rebound)
  } catch {
    return fail('invalid_payload', 'imported engine plan is invalid')
  }
  return {
    ok: true,
    plan: {
      engine: rebound,
      authorityId: adoptIncomingAuthority ? stamp.authorityId : current.authorityId,
      restoreGeneration: adoptIncomingAuthority ? stamp.restoreGeneration : current.restoreGeneration,
      adoptedIncomingAuthority: adoptIncomingAuthority,
      nextEpoch: Math.max(current.epoch, stamp.epoch) + 1,
      effectiveAnchorWallMs,
      clockSkippedMs,
      importClamped,
      cancelledSessionKinds,
    },
  }
}
