import type { SaveData } from './save'
import type { OrderedEvent } from './pet-runtime/events'
import type { RuntimeOutcome } from './pet-runtime/runtime-types'
import {
  composeSaveWithOverlay,
  type DeviceLocalOverlay,
  type SharedSaveData,
} from './sync/data-boundary'
import type { CommandKey, CommandResult, PetCommand, WireAuthority } from './sync/protocol'
import type { AuthorityStamp } from './sync/portable'

/** The ordered data contract every renderer host receives, local or remote. */
export interface RendererProjection {
  /** Renderer-ready canonical state with the device overlay already applied. */
  save: SaveData
  /** Canonical shared state only; never contains device settings or session answer keys. */
  shared: SharedSaveData
  revision: number
  eventSeq: number
  gameTimeMs: number
  timeZone: string
  advanceWhileEmpty: boolean
  authority: WireAuthority
  /** Host-only diagnostics; renderers must not branch canonical rules on these. */
  device?: DeviceLocalOverlay
  status?: RendererRepositoryStatus
}

/** Unified repository status; connection is local for every C6a host. */
export interface RendererRepositoryStatus {
  mode: 'local' | 'server'
  connection: 'local' | 'connecting' | 'online' | 'offline' | 'catching_up' | 'error'
  revision: number
  eventSeq: number
  gameTimeMs: number
  timeZone: string
  advanceWhileEmpty: boolean
  authority: WireAuthority
  lastError?: string
  /** Host lifecycle detail retained for diagnostics/compatibility. */
  state?: string
  offline?: boolean
  serverMode?: false
  role?: string
  readOnly?: boolean
  catchingUp?: boolean
  authorityState?: 'active' | 'handoff_pending' | 'archived'
  commandSeq?: number
  localDeviceId?: string
  appInstanceId?: string
  notice?: string
  error?: string
}

export interface RendererRuntimeInfo {
  localRepositoryV2: boolean
  serverMode: false
  reason?: string
}

export interface ProjectionCursor {
  revision: number
  eventSeq: number
  owner?: 'local' | 'server'
  authorityId?: string
  authorityEpoch?: number
  restoreGeneration?: number
}

export interface OrderedProjectionDelivery {
  projection: RendererProjection
  events: OrderedEvent[]
}

export type ProjectionDeliveryKind = 'projection' | 'resync' | 'stale'

export interface ProjectionDeliveryClassification {
  kind: ProjectionDeliveryKind
  reason?: 'initial' | 'event_gap' | 'event_after_head' | 'event_order' | 'authority_changed' | 'stale'
}

export interface LocalProjectionSource {
  save?: SaveData
  shared: SharedSaveData
  device?: DeviceLocalOverlay
  revision: number
  eventSeq: number
  gameTimeMs: number
  timeZone: string
  advanceWhileEmpty: boolean
  authority: { state: 'active' | 'handoff_pending' | 'archived'; stamp: AuthorityStamp } | WireAuthority
  status?: RendererRepositoryStatus
}

export interface LocalStatusSource {
  mode: 'local'
  state: string
  offline?: boolean
  serverMode?: false
  role?: string
  readOnly?: boolean
  catchingUp?: boolean
  authorityState?: 'active' | 'handoff_pending' | 'archived'
  revision: number
  eventSeq: number
  commandSeq?: number
  localDeviceId?: string
  appInstanceId?: string
  notice?: string
  error?: string
}

const EMPTY_AUTHORITY: WireAuthority = {
  owner: 'local',
  authorityId: '',
  restoreGeneration: 0,
  epoch: 0,
  state: 'archived',
}

export function wireAuthorityFromLocal(
  authority: { state: 'active' | 'handoff_pending' | 'archived'; stamp: AuthorityStamp } | WireAuthority,
): WireAuthority {
  if ('stamp' in authority) {
    return {
      owner: authority.stamp.owner,
      authorityId: authority.stamp.authorityId,
      restoreGeneration: authority.stamp.restoreGeneration,
      epoch: authority.stamp.epoch,
      state: authority.state === 'active' ? 'active' : 'archived',
    }
  }
  return { ...authority }
}

export function createRendererProjection(source: LocalProjectionSource): RendererProjection {
  let save = source.save
  if (save === undefined) {
    if (source.device === undefined) throw new Error('renderer projection requires save or device overlay')
    save = composeSaveWithOverlay(source.shared, source.device)
  }
  return {
    save,
    shared: source.shared,
    revision: source.revision,
    eventSeq: source.eventSeq,
    gameTimeMs: source.gameTimeMs,
    timeZone: source.timeZone,
    advanceWhileEmpty: source.advanceWhileEmpty,
    authority: wireAuthorityFromLocal(source.authority),
    ...(source.device === undefined ? {} : { device: source.device }),
    ...(source.status === undefined ? {} : { status: source.status }),
  }
}

export function createRendererStatus(
  status: LocalStatusSource,
  projection: RendererProjection | null,
): RendererRepositoryStatus {
  const connection: RendererRepositoryStatus['connection'] =
    status.state === 'catching_up' ? 'catching_up'
      : status.state === 'read_only' || status.state === 'stopped' ? 'offline'
        : status.state === 'handoff_pending' ? 'offline'
          : 'local'
  return {
    mode: status.mode,
    connection,
    revision: projection?.revision ?? status.revision,
    eventSeq: projection?.eventSeq ?? status.eventSeq,
    gameTimeMs: projection?.gameTimeMs ?? 0,
    timeZone: projection?.timeZone ?? 'UTC',
    advanceWhileEmpty: projection?.advanceWhileEmpty ?? true,
    authority: projection?.authority ?? EMPTY_AUTHORITY,
    ...(status.error === undefined ? {} : { lastError: status.error, error: status.error }),
    state: status.state,
    ...(status.offline === undefined ? {} : { offline: status.offline }),
    serverMode: false,
    ...(status.role === undefined ? {} : { role: status.role }),
    ...(status.readOnly === undefined ? {} : { readOnly: status.readOnly }),
    ...(status.catchingUp === undefined ? {} : { catchingUp: status.catchingUp }),
    ...(status.authorityState === undefined ? {} : { authorityState: status.authorityState }),
    ...(status.commandSeq === undefined ? {} : { commandSeq: status.commandSeq }),
    ...(status.localDeviceId === undefined ? {} : { localDeviceId: status.localDeviceId }),
    ...(status.appInstanceId === undefined ? {} : { appInstanceId: status.appInstanceId }),
    ...(status.notice === undefined ? {} : { notice: status.notice }),
  }
}

export function legacyRendererStatus(): RendererRepositoryStatus {
  return {
    mode: 'local',
    connection: 'local',
    revision: 0,
    eventSeq: 0,
    gameTimeMs: 0,
    timeZone: 'UTC',
    advanceWhileEmpty: true,
    authority: EMPTY_AUTHORITY,
    state: 'legacy',
    offline: true,
    serverMode: false,
    readOnly: false,
  }
}

/**
 * A renderer may apply a projection only when every delivered event fills the
 * cursor gap exactly. Anything else is a full-snapshot resync; stale snapshots
 * are ignored so a late event cannot roll the UI back.
 */
export function classifyProjectionDelivery(
  cursor: ProjectionCursor | null,
  projection: Pick<RendererProjection, 'revision' | 'eventSeq'> & {
    authority?: Pick<WireAuthority, 'owner' | 'authorityId' | 'epoch' | 'restoreGeneration'>
  },
  events: readonly Pick<OrderedEvent, 'eventSeq'>[],
): ProjectionDeliveryClassification {
  if (cursor === null) return { kind: 'resync', reason: 'initial' }
  if (projection.authority !== undefined && cursor.authorityId !== undefined) {
    const sameAuthority = projection.authority.authorityId === cursor.authorityId
      && (cursor.owner === undefined || projection.authority.owner === cursor.owner)
    if (sameAuthority === false) return { kind: 'resync', reason: 'authority_changed' }
    if (
      projection.authority.epoch > (cursor.authorityEpoch ?? 0)
      || projection.authority.restoreGeneration > (cursor.restoreGeneration ?? 0)
    ) return { kind: 'resync', reason: 'authority_changed' }
    if (
      projection.authority.epoch < (cursor.authorityEpoch ?? 0)
      || projection.authority.restoreGeneration < (cursor.restoreGeneration ?? 0)
    ) return { kind: 'stale', reason: 'stale' }
  }
  if (projection.revision < cursor.revision || projection.eventSeq < cursor.eventSeq) {
    return { kind: 'stale', reason: 'stale' }
  }
  if (events.length === 0) {
    return projection.eventSeq === cursor.eventSeq
      ? { kind: 'projection' }
      : { kind: 'resync', reason: 'event_gap' }
  }
  let previous = cursor.eventSeq
  for (const event of events) {
    if (event.eventSeq !== previous + 1) {
      return { kind: 'resync', reason: event.eventSeq <= previous ? 'event_order' : 'event_gap' }
    }
    previous = event.eventSeq
  }
  if (projection.eventSeq !== previous) {
    return { kind: 'resync', reason: projection.eventSeq > previous ? 'event_gap' : 'event_after_head' }
  }
  return { kind: 'projection' }
}

export interface RuntimeCommandResultInput<K extends CommandKey> {
  command: Extract<PetCommand, { type: K }>
  opId: string
  commandSeq: number
  revision: number
  eventSeq: number
  outcome: RuntimeOutcome
  duplicate: boolean
}

/** Converts a host runtime outcome to the typed wire/command result contract. */
export function toCommandResult<K extends CommandKey>(input: RuntimeCommandResultInput<K>): CommandResult<K> {
  const base = {
    commandType: input.command.type,
    opId: input.opId,
    commandSeq: input.commandSeq,
    revision: input.revision,
    eventSeq: input.eventSeq,
  }
  if (input.duplicate) {
    if (input.outcome.ok) {
      return {
        ...base,
        status: 'duplicate',
        original: 'applied',
        ...(Object.prototype.hasOwnProperty.call(input.outcome, 'result')
          ? { result: input.outcome.result as never }
          : {}),
      }
    }
    return {
      ...base,
      status: 'duplicate',
      original: 'rejected',
      error: input.outcome.error,
    }
  }
  if (input.outcome.ok) {
    return {
      ...base,
      status: 'applied',
      ...(Object.prototype.hasOwnProperty.call(input.outcome, 'result')
        ? { result: input.outcome.result as never }
        : {}),
    }
  }
  return { ...base, status: 'rejected', error: input.outcome.error }
}

/** Legacy/not-activated hosts keep the same typed surface but reject gameplay commands. */
export function rejectedCommandResult<K extends CommandKey>(
  command: Extract<PetCommand, { type: K }>,
  opId: string,
  message = 'local runtime v2 is not active',
): CommandResult<K> {
  return toCommandResult({
    command,
    opId,
    commandSeq: 0,
    revision: 0,
    eventSeq: 0,
    duplicate: false,
    outcome: {
      ok: false,
      events: [],
      error: { code: 'authority_not_active', message, refreshProjection: true },
    },
  })
}
