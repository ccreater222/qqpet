import type { CoverageEndProvenance, CoverageSurvivor } from '../../src/shared/pet-runtime/index'

export interface FinalizeSurvivorOptions {
  commitWallMs: number
  eventBoundaryMs: number
  eventReason: CoverageEndProvenance
  terminal: boolean
  suspendedAtMs?: number
  existingCloseReason?: CoverageEndProvenance
  existingEndWallMs?: number
}

export interface FinalizeSurvivorResult {
  survivor: CoverageSurvivor
  skipped: boolean
  materialize: boolean
  endWallMs: number
  provenance: CoverageEndProvenance
}

export function survivorKey(survivor: CoverageSurvivor): string {
  return survivor.kind === 'server_connection' ? survivor.connectionId : survivor.appInstanceId
}

export function survivorDeviceId(survivor: CoverageSurvivor): string {
  return survivor.kind === 'server_connection' ? survivor.deviceId : survivor.localDeviceId
}

export function stableCoverageId(operationId: string, survivor: CoverageSurvivor): string {
  return operationId + ':' + survivorKey(survivor)
}

export function finalizeSurvivor(
  survivor: CoverageSurvivor,
  options: FinalizeSurvivorOptions,
): FinalizeSurvivorResult {
  if (survivor.activeEndWallMs !== undefined || survivor.eligible === false) {
    return {
      survivor,
      skipped: true,
      materialize: false,
      endWallMs: survivor.activeEndWallMs === undefined ? options.commitWallMs : survivor.activeEndWallMs,
      provenance: survivor.activeEndProvenance === undefined ? options.eventReason : survivor.activeEndProvenance,
    }
  }
  const suspendedAt = options.suspendedAtMs
  const suspended = suspendedAt !== undefined
  const cappedBySuspend = suspended && options.eventBoundaryMs > suspendedAt
  let end: number
  if (options.existingEndWallMs !== undefined) {
    // A persisted end is authoritative; replay/finalization must never extend it.
    end = Math.max(options.commitWallMs, options.existingEndWallMs)
  } else {
    end = Math.max(options.commitWallMs, options.eventBoundaryMs)
    if (suspended) end = Math.min(end, suspendedAt)
    end = Math.max(options.commitWallMs, end)
  }

  const provenance: CoverageEndProvenance =
    options.existingCloseReason ??
    (suspended || cappedBySuspend
      ? 'suspend'
      : options.eventReason)

  if (options.terminal) {
    return {
      survivor: {
        ...survivor,
        eligible: false,
        activeEndWallMs: end,
        activeEndProvenance: provenance,
      },
      skipped: false,
      materialize: true,
      endWallMs: end,
      provenance,
    }
  }
  return {
    survivor: { ...survivor, eligible: true },
    skipped: false,
    materialize: true,
    endWallMs: end,
    provenance: 'suspend',
  }
}
