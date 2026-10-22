import {
  dayKeyAt,
  nextDailyBoundaryMs,
  rebindOrCancelImportedSessions,
  type EngineState,
  type SessionCoverageInterval,
} from '../../src/shared/pet-runtime/index'
import { assertEngineState } from '../../src/shared/sync/portable'
import type { AuthorityRecord } from './db'
import type { PortablePetBundleV1 } from '../../src/shared/sync/index'
import { finalizeSurvivor, stableCoverageId, survivorDeviceId } from './coverage'
import { COVERAGE_CRASH_GRACE_MS } from './db'

/** Default anchor policy from the design (§6.5): reject stale/future anchors unless the owner explicitly clamps. */
export const MAX_IMPORT_ANCHOR_PAST_MS = 48 * 60 * 60 * 1000
export const MAX_IMPORT_FUTURE_SKEW_MS = 5 * 60 * 1000

export type ImportPlanErrorCode = 'anchor_out_of_bounds' | 'authority_fork_risk' | 'invalid_payload' | 'authority_not_active'

export interface ImportPlan {
  engine: EngineState
  importedCoverage: SessionCoverageInterval[]
  authorityId: string
  restoreGeneration: number
  adoptedIncomingAuthority: boolean
  nextEpoch: number
  effectiveAnchorWallMs: number
  clockSkippedMs: number
  importClamped: boolean
}

export type ImportPlanResult =
  | { ok: true; plan: ImportPlan }
  | { ok: false; code: ImportPlanErrorCode; message: string }

export interface ImportPlanOptions {
  bundle: PortablePetBundleV1
  current: AuthorityRecord
  wallNowMs: number
  allowClamp: boolean
  resumeMode: boolean
  uploaderDeviceId: string
  rebindLocalSessions: boolean
  /** True only when the destination has no applied command/canonical claim. */
  destinationHasNoAppliedCommands: boolean
  expectedEpoch?: number
}

function fail(code: ImportPlanErrorCode, message: string): ImportPlanResult {
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

/**
 * Deterministically plans a portable import: authority fencing, anchor
 * realignment, deadline shifting, actor rebind and source coverage closure.
 * The caller commits the returned plan atomically.
 */
export function planPortableImport(options: ImportPlanOptions): ImportPlanResult {
  const { bundle, current, wallNowMs } = options
  if (Number.isSafeInteger(wallNowMs) === false || wallNowMs < 0) {
    return fail('invalid_payload', 'wallNowMs must be a non-negative safe integer')
  }
  const stamp = bundle.authority
  if (stamp.owner !== 'local') return fail('invalid_payload', 'portable import requires a local-authority bundle')
  if (options.resumeMode === false && current.state !== 'active') {
    return fail('authority_not_active', 'importPortableBundle requires an active server authority')
  }
  if (options.resumeMode && current.state !== 'archived') {
    return fail('authority_not_active', 'resumeServer requires an archived server authority')
  }
  const sameLineage = stamp.authorityId === current.authorityId && stamp.restoreGeneration === current.restoreGeneration
  // A freshly initialized server has a placeholder server lineage (epoch 0,
  // generation 0) and no applied command. Adopting the first genuine local
  // bundle is the primary local-to-server migration path. Once any command has
  // committed, or the destination lineage has advanced, a lineage mismatch is
  // a real fork and remains fenced.
  const adoptIncomingAuthority = options.resumeMode === false
    && options.destinationHasNoAppliedCommands
    && current.owner === 'server'
    && current.state === 'active'
    && current.epoch === 0
    && current.restoreGeneration === 0
  if (sameLineage === false && adoptIncomingAuthority === false) {
    return fail('authority_fork_risk', 'bundle authority lineage does not match the server authority')
  }
  if (options.expectedEpoch !== undefined && options.expectedEpoch !== stamp.epoch) {
    return fail('authority_fork_risk', 'expected epoch does not match the uploaded bundle epoch')
  }
  if (stamp.epoch < current.epoch) {
    return fail('authority_fork_risk', 'uploaded bundle epoch is stale')
  }
  if (adoptIncomingAuthority === false && stamp.epoch === current.epoch) {
    const exactArchivedHandoff = options.resumeMode && current.state === 'archived' && stamp.handoffId === current.handoffId
    if (exactArchivedHandoff === false) {
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
  if (isSafeNonNegative(importedAnchor) === false) return fail('invalid_payload', 'imported scheduler anchor is invalid')
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
    engine.importClamped = true
    engine.clockSkippedMs = clockSkippedMs
  } else if (importedAnchor > wallNowMs) {
    // Future skew inside the accepted window: start at wall now and run no catch-up.
    effectiveAnchorWallMs = wallNowMs
  }
  engine.lastSchedulerWallMs = effectiveAnchorWallMs

  if (engine.advanceWhileEmpty === false) {
    // Disabled mode never backfills the import gap; pending deadlines keep their remaining duration.
    effectiveAnchorWallMs = wallNowMs
    engine.lastSchedulerWallMs = wallNowMs
  }

  const localActorDeviceId = bundle.originLocalDeviceId ?? ''
  const rebound = rebindOrCancelImportedSessions(engine, {
    localActorDeviceId,
    newActorDeviceId: options.uploaderDeviceId,
    rebindLocalSessions: options.rebindLocalSessions,
    nowMs: engine.gameTimeMs,
  })
  const importedCoverage = materializeImportedCoverage(rebound, wallNowMs)
  rebound.sessionCoverage = importedCoverage
  delete rebound.coverageReopen

  try {
    assertEngineState(rebound)
  } catch {
    return fail('invalid_payload', 'imported engine plan is invalid')
  }
  const nextEpoch = Math.max(current.epoch, stamp.epoch) + 1
  return {
    ok: true,
    plan: {
      engine: rebound,
      importedCoverage,
      authorityId: adoptIncomingAuthority ? stamp.authorityId : current.authorityId,
      restoreGeneration: adoptIncomingAuthority ? stamp.restoreGeneration : current.restoreGeneration,
      adoptedIncomingAuthority: adoptIncomingAuthority,
      nextEpoch,
      effectiveAnchorWallMs,
      clockSkippedMs,
      importClamped,
    },
  }
}

/** Close imported open intervals and source pending-operation survivors into closed history. */
export function materializeImportedCoverage(engine: EngineState, wallNowMs: number): SessionCoverageInterval[] {
  const rows = new Map<string, SessionCoverageInterval>()
  for (const interval of engine.sessionCoverage) {
    if (interval.disconnectedAtWallMs !== undefined) {
      rows.set(interval.coverageId, interval)
      continue
    }
    const heartbeatBound = Math.max(
      interval.connectedAtWallMs,
      Math.min(wallNowMs, interval.lastHeartbeatWallMs + COVERAGE_CRASH_GRACE_MS),
    )
    rows.set(interval.coverageId, {
      ...interval,
      disconnectedAtWallMs: heartbeatBound,
      closeReason: 'import_replaced',
    })
  }
  const operation = engine.coverageReopen
  if (operation !== undefined) {
    // A known suspend is an explicit persisted boundary, not a crash-repair
    // heartbeat grace estimate. Reusing suspendedAt prevents a stale heartbeat
    // from shortening a stable suspend interval on import.
    const suspendedAt = operation.state === 'suspended' ? operation.suspendedAtWallMs : undefined
    const knownSuspend = operation.state === 'suspended'
    for (const survivor of operation.survivors) {
      const coverageId = stableCoverageId(operation.operationId, survivor)
      const existing = rows.get(coverageId)
      const existingEndWallMs = existing?.disconnectedAtWallMs
      const existingCloseReason = existing?.closeReason
      if (survivor.eligible === false) continue
      if (survivor.activeEndWallMs !== undefined) {
        // A terminal survivor's own active end is authoritative. Keep the
        // persisted row (including its close reason) if one already exists.
        const endWallMs = Math.max(operation.commitWallMs, survivor.activeEndWallMs)
        const closeReason = existingCloseReason ?? survivor.activeEndProvenance ?? 'suspend'
        rows.set(coverageId, {
          coverageId,
          deviceId: existing?.deviceId ?? survivorDeviceId(survivor),
          connectedAtWallMs: existing?.connectedAtWallMs ?? operation.commitWallMs,
          disconnectedAtWallMs: existingEndWallMs ?? endWallMs,
          lastHeartbeatWallMs: Math.max(
            existing?.lastHeartbeatWallMs ?? operation.commitWallMs,
            survivor.lastHeartbeatWallMs,
            existingEndWallMs ?? endWallMs,
          ),
          closeReason,
        })
        continue
      }
      const heartbeatBound = Math.max(
        operation.commitWallMs,
        Math.min(wallNowMs, survivor.lastHeartbeatWallMs + COVERAGE_CRASH_GRACE_MS),
      )
      const boundary = suspendedAt ?? heartbeatBound
      const result = finalizeSurvivor(survivor, {
        commitWallMs: operation.commitWallMs,
        eventBoundaryMs: boundary,
        eventReason: knownSuspend ? 'suspend' : 'import_replaced',
        terminal: true,
        ...(suspendedAt === undefined ? {} : { suspendedAtMs: suspendedAt }),
        ...(existingCloseReason === undefined ? {} : { existingCloseReason }),
        ...(existingEndWallMs === undefined ? {} : { existingEndWallMs }),
      })
      if (result.materialize === false && existing === undefined) continue
      const endWallMs = existingEndWallMs ?? result.endWallMs
      rows.set(coverageId, {
        coverageId,
        deviceId: existing?.deviceId ?? survivorDeviceId(survivor),
        connectedAtWallMs: existing?.connectedAtWallMs ?? operation.commitWallMs,
        disconnectedAtWallMs: endWallMs,
        lastHeartbeatWallMs: Math.max(
          existing?.lastHeartbeatWallMs ?? operation.commitWallMs,
          survivor.lastHeartbeatWallMs,
          endWallMs,
        ),
        closeReason: existingCloseReason ?? result.provenance,
      })
    }
  }
  return [...rows.values()].sort((a, b) => a.connectedAtWallMs - b.connectedAtWallMs || a.coverageId.localeCompare(b.coverageId))
}
