import type { SaveData } from '../save'
import { startSave } from '../save-logic'
import { sessionActivityForInterval } from '../pet-runtime/coverage'
import { orderedDomainEvent, type DomainEvent, type OrderedDomainEvent } from '../pet-runtime/events'
import { advanceSchedulerChunk, CATCHUP_CHUNK_TICKS, GAME_TICK_MS } from '../pet-runtime/scheduler'
import {
  emptyOpIdCache,
  executeCommandIdempotent,
  migrateOpIdCache,
  validateOpIdCache,
  validatePersistedRuntimeState,
  type IdempotencyRecord,
  type OpIdCache,
  type PersistedRuntimeState,
} from '../pet-runtime/idempotency'
import type { RuntimeCommandContext, RuntimeOutcome } from '../pet-runtime/runtime-types'
import type {
  CoverageEndProvenance,
  CoverageReopen,
  CoverageSurvivor,
  SessionCoverageInterval,
} from '../pet-runtime/types'
import type { OrderedEvent } from '../pet-runtime/events'
import { reconcileImportedSessionActors } from '../pet-runtime/sessions'
import type { CommandError, CommandKey, CommandResult, CommandRole, PetCommand } from '../sync/protocol'
import {
  composeSaveWithOverlay,
  mergeDeviceLocalOverlay,
  sanitizeDeviceLocalOverlayPatch,
  toDeviceLocalOverlay,
  type DeviceLocalOverlay,
  type DeviceLocalSettings,
  type SharedSaveData,
} from '../sync/data-boundary'
import {
  assertLocalPetDocumentV2,
  backfillLegacyLocalPetDocumentDefaults,
  LOCAL_DOCUMENT_FORMAT,
  LOCAL_DOCUMENT_SCHEMA_VERSION,
  migrateLegacyLocalPetDocumentV2,
  migrateLegacySaveDataToPortableBundle,
  migratePortablePetBundle,
  serializePortablePetBundle,
  type AuthorityStamp,
  type LocalEventHistoryEntry,
  type LocalPetDocumentV2,
  type PortablePetBundleV1,
} from '../sync/portable'

export const LOCAL_REPOSITORY_HOST_POLL_MS = 1_000
export const LOCAL_REPOSITORY_HOST_CATCHUP_CHUNK_TICKS = CATCHUP_CHUNK_TICKS
export const LOCAL_REPOSITORY_HOST_HEARTBEAT_MS = 10_000
export const LOCAL_REPOSITORY_HOST_COVERAGE_GRACE_MS = 60_000
export const LOCAL_REPOSITORY_HOST_PROJECTION_FORMAT = 'qqpet-local-projection-v1' as const
export const LOCAL_REPOSITORY_HOST_PROJECTION_SCHEMA_VERSION = 1 as const
export const LOCAL_REPOSITORY_HOST_EVENT_HISTORY_LIMIT = 512

export type LocalRepositoryHostState =
  | 'loading'
  | 'ready'
  | 'catching_up'
  | 'read_only'
  | 'handoff_pending'
  | 'suspended'
  | 'stopped'

export type LocalRepositoryHostRole = CommandRole

export interface LocalRepositoryHostStatus {
  mode: 'local'
  state: LocalRepositoryHostState
  offline: true
  serverMode: false
  role: LocalRepositoryHostRole
  readOnly: boolean
  catchingUp: boolean
  authorityState: 'active' | 'handoff_pending' | 'archived'
  revision: number
  eventSeq: number
  commandSeq: number
  localDeviceId?: string
  appInstanceId?: string
  notice?: string
  error?: string
}

export interface LocalRepositoryHostProjection {
  format: typeof LOCAL_REPOSITORY_HOST_PROJECTION_FORMAT
  schemaVersion: typeof LOCAL_REPOSITORY_HOST_PROJECTION_SCHEMA_VERSION
  status: LocalRepositoryHostStatus
  revision: number
  eventSeq: number
  commandSeq: number
  gameTimeMs: number
  timeZone: string
  advanceWhileEmpty: boolean
  authority: {
    state: 'active' | 'handoff_pending' | 'archived'
    stamp: AuthorityStamp
  }
  /** Renderer-facing save with the device-local overlay applied. */
  save: SaveData
  /** Canonical shared state; never contains device settings or session answer keys. */
  shared: SharedSaveData
  device: DeviceLocalOverlay
  runtime: { appInstanceId: string; startedAtWallMs: number; localDeviceId: string }
}

export type LocalRepositoryHostEvent = OrderedEvent

export interface LocalRepositoryHostStorageCapability {
  /** Descriptive host tag used by status and tests, e.g. android-native-file. */
  kind: string
  /** True only when the host can replace the document in one atomic step. */
  atomicDocument: boolean
  /** True only when the host can retain the previous/migration/corrupt bytes. */
  backup: boolean
}

/**
 * Host storage is deliberately file-shaped rather than path-shaped. Mobile
 * bridges only receive the operations they need and cannot be tricked into
 * writing outside the app-private state directory.
 */
export interface LocalRepositoryHostStorage {
  readonly capability: LocalRepositoryHostStorageCapability
  readDocument(): Promise<string | null>
  /** Must either commit the complete UTF-8 document or reject; never write in place. */
  writeDocumentAtomic(text: string): Promise<void>
  readLegacySave(): Promise<string | null>
  /** Preserve the original legacy bytes before migration. Called once per file. */
  backupLegacySave(text: string, reason: 'migration' | 'corrupt'): Promise<void>
  /** Preserve the previous v2/mismatched bytes before rewriting. Called once per file. */
  backupDocument(text: string, reason: 'migration' | 'corrupt' | 'identity_mismatch' | 'import'): Promise<void>
  /** Preserve bytes under a unique, non-authoritative recovery name. */
  preserveCorruptDocument(text: string): Promise<void>
}

export interface LocalRepositoryHostTimerRuntime {
  start(tick: () => void, intervalMs: number): unknown
  clear(handle: unknown): void
}

export interface LocalRepositoryHostOptions {
  storage: LocalRepositoryHostStorage
  nowMs: () => number
  randomUUID: () => string
  /** Required only when a legacy save/initial save has to be migrated. */
  seedHex?: string
  randomSeedHex?: () => string
  timeZone?: string
  localDeviceId?: string
  appInstanceId?: string
  advanceWhileEmpty?: boolean
  initialSave?: unknown
  pollIntervalMs?: number
  maxChunkTicks?: number
  /** Defaults to false so constructing a host never starts an ambient timer. */
  autoScheduler?: boolean
  timer?: LocalRepositoryHostTimerRuntime
  yieldToEventLoop?: () => Promise<void>
  onProjection?: (projection: LocalRepositoryHostProjection, events: LocalRepositoryHostEvent[]) => void
  onStatus?: (status: LocalRepositoryHostStatus) => void
  onCommandResult?: (result: CommandResult) => void
}

export interface LocalRepositoryHostActivation {
  devRuntimeFlag: boolean
  rendererCapability: boolean
  /** Mobile hosts must not expose a server authority path. */
  serverMode?: false
  storage?: LocalRepositoryHostStorageCapability
}

export type LocalRepositoryHostActivationReason =
  | 'dev_flag_disabled'
  | 'renderer_capability_missing'
  | 'server_mode_forbidden'
  | 'storage_capability_missing'
  | 'storage_atomic_write_missing'
  | 'storage_backup_missing'

export interface LocalRepositoryHostActivationResult {
  enabled: boolean
  canActivate: boolean
  serverMode: false
  reason?: LocalRepositoryHostActivationReason
}

export interface LocalRepositoryHostCommandOptions {
  opId?: string
  role?: LocalRepositoryHostRole
}

export interface LocalRepositoryHostImportOptions {
  opId?: string
  expectedAuthorityId?: string
  expectedRestoreGeneration?: number
  expectedEpoch?: number
  expectedRevision?: number
  expectedEventSeq?: number
}

export interface LocalRepositoryHostMutationResult {
  projection: LocalRepositoryHostProjection | null
  events: LocalRepositoryHostEvent[]
}

interface LoadedDocument {
  document: LocalPetDocumentV2
  idempotency: OpIdCache
  notice?: string
}

interface MutationContext {
  base: LocalPetDocumentV2
  survivors: CoverageSurvivor[]
  coverage: SessionCoverageInterval[]
  operationId: string
  commitWallMs: number
}

const ACTIVATION_TOKEN = Symbol('portable-local-repository-activation')
type LocalCoverageSurvivor = Extract<CoverageSurvivor, { kind: 'local_app' }>
const OP_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

function activationError(reason: LocalRepositoryHostActivationReason): Error {
  return new Error('local repository v2 activation denied: ' + reason)
}

export function localRepositoryHostCapability(
  activation: LocalRepositoryHostActivation,
): LocalRepositoryHostActivationResult {
  const base = { enabled: false, canActivate: false, serverMode: false as const }
  if (activation.devRuntimeFlag !== true) return { ...base, reason: 'dev_flag_disabled' }
  if (activation.rendererCapability !== true) return { ...base, reason: 'renderer_capability_missing' }
  if ((activation as { serverMode?: boolean }).serverMode === true) return { ...base, reason: 'server_mode_forbidden' }
  if (activation.storage === undefined) return { ...base, reason: 'storage_capability_missing' }
  if (activation.storage.atomicDocument !== true) return { ...base, reason: 'storage_atomic_write_missing' }
  if (activation.storage.backup !== true) return { ...base, reason: 'storage_backup_missing' }
  return { enabled: true, canActivate: true, serverMode: false }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function changed<T>(left: T, right: T): boolean {
  return JSON.stringify(left) !== JSON.stringify(right)
}

function requireSafeWall(value: unknown, name: string): number {
  if (typeof value !== 'number' || Number.isSafeInteger(value) === false || value < 0) {
    throw new Error(name + ' must be a non-negative safe integer')
  }
  return value
}

function requireBoundedId(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new Error(name + ' must be a non-empty bounded string')
  }
  return value
}

function requireOpId(value: unknown): string {
  if (typeof value !== 'string' || OP_ID_PATTERN.test(value) === false) {
    throw new Error('opId must be 1-128 safe identifier characters')
  }
  return value
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(label + " is not valid JSON: " + message)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  return true
}

/** Mirrors the legacy migration adapter normalization of config.json-shaped data. */
function legacySaveCandidate(value: unknown): SaveData {
  if (isRecord(value) === false) throw new Error("legacy save is not a JSON object")
  const candidate: Record<string, unknown> = isRecord(value.petInfoData)
    ? { ...value.petInfoData }
    : { ...value }
  if (isRecord(value.petInfoData)) {
    for (const key of [
      "havePet", "isBury", "saveNum", "nowTimeLine", "petInfo", "petComputedlInfo", "studyInfo",
      "activeOption", "selfGoodDatas", "selfGoodUseOption", "gameSaveDatas", "illustrated",
      "saveJsonData", "settings",
    ]) {
      if (candidate[key] === undefined && value[key] !== undefined) candidate[key] = value[key]
    }
  }
  delete candidate.machineId
  delete candidate.oId
  return candidate as unknown as SaveData
}

/** Applies the device-local overlay to canonical shared state for renderer load(). */
export function composeLocalRepositorySave(shared: SharedSaveData, device: DeviceLocalOverlay): SaveData {
  return composeSaveWithOverlay(shared, device)
}

export function normalizeLocalRepositoryDocument(raw: unknown): LoadedDocument {
  let value = raw
  const record = isRecord(value) ? value : null
  const runtime = record !== null && isRecord(record.runtime) ? record.runtime : null
  if (runtime !== null && Object.prototype.hasOwnProperty.call(runtime, "localDeviceId")) {
    value = migrateLegacyLocalPetDocumentV2(value)
  }
  // Documents written before #75 predate petInfo.diamond; backfill the startSave repair default.
  backfillLegacyLocalPetDocumentDefaults(value)
  assertLocalPetDocumentV2(value)
  const document = value as LocalPetDocumentV2
  const idempotency = document.idempotency === undefined ? emptyOpIdCache() : migrateOpIdCache(document.idempotency)
  validateOpIdCache(idempotency)
  validatePersistedRuntimeState({ schemaVersion: 2, engine: document.bundle.engine, idempotency })
  const eventHistory = document.eventHistory?.map(event => ({
    ...event,
    revision: event.revision ?? document.revision,
    gameTimeMs: event.gameTimeMs ?? document.bundle.engine.gameTimeMs,
  }))
  return { document: { ...document, idempotency, ...(eventHistory === undefined ? {} : { eventHistory }) }, idempotency }
}

export function createLocalRepositoryHost(
  options: LocalRepositoryHostOptions,
  activation: LocalRepositoryHostActivation,
): LocalRepositoryHost {
  const capability = localRepositoryHostCapability({
    ...activation,
    storage: activation.storage ?? options.storage.capability,
  })
  if (capability.canActivate === false) throw activationError(capability.reason ?? "storage_capability_missing")
  if (activation.storage !== undefined && (
    activation.storage.kind !== options.storage.capability.kind
    || activation.storage.atomicDocument !== options.storage.capability.atomicDocument
    || activation.storage.backup !== options.storage.capability.backup
  )) {
    throw activationError("storage_capability_missing")
  }
  return new LocalRepositoryHost(options, ACTIVATION_TOKEN)
}

/**
 * Portable local authority host. Deliberately free of Node, Electron, DOM and
 * WebSocket imports so Android, Harmony and iOS execute the same runtime and
 * persistence state machine.
 */
export class LocalRepositoryHost {
  private readonly options: LocalRepositoryHostOptions & {
    pollIntervalMs: number
    maxChunkTicks: number
    autoScheduler: boolean
  }
  private readonly now: () => number
  private readonly newUuid: () => string
  private readonly yieldToEventLoop: () => Promise<void>
  private readonly timer: LocalRepositoryHostTimerRuntime | undefined
  private localDocument: LocalPetDocumentV2 | null = null
  private idempotency: OpIdCache = emptyOpIdCache()
  private localDeviceIdValue = ''
  private appInstanceIdValue = ''
  private state: LocalRepositoryHostState = 'loading'
  private role: LocalRepositoryHostRole = 'owner'
  private error: string | undefined
  private notice: string | undefined
  private loaded = false
  private openCoverageId: string | undefined
  private schedulerHandle: unknown
  private schedulerRunning = false
  private queue: Promise<void> = Promise.resolve()
  private lastProjectionValue: LocalRepositoryHostProjection | null = null
  private eventHistory: LocalEventHistoryEntry[] = []
  private lastReopenValue: CoverageReopen | undefined
  private stopped = false
  private lastHeartbeatPersistedAt = 0

  constructor(options: LocalRepositoryHostOptions, activationToken: symbol) {
    if (activationToken !== ACTIVATION_TOKEN) throw new Error('LocalRepositoryHost activation token required')
    if (options.storage === undefined) throw new Error('LocalRepositoryHost storage is required')
    if (options.storage.capability.atomicDocument !== true) throw activationError('storage_atomic_write_missing')
    if (options.storage.capability.backup !== true) throw activationError('storage_backup_missing')
    if (typeof options.nowMs !== 'function') throw new Error('LocalRepositoryHost nowMs is required')
    if (typeof options.randomUUID !== 'function') throw new Error('LocalRepositoryHost randomUUID is required')
    const pollIntervalMs = options.pollIntervalMs ?? LOCAL_REPOSITORY_HOST_POLL_MS
    const maxChunkTicks = options.maxChunkTicks ?? LOCAL_REPOSITORY_HOST_CATCHUP_CHUNK_TICKS
    requireSafeWall(pollIntervalMs, 'pollIntervalMs')
    requireSafeWall(maxChunkTicks, 'maxChunkTicks')
    if (pollIntervalMs <= 0) throw new Error('pollIntervalMs must be positive')
    if (maxChunkTicks <= 0) throw new Error('maxChunkTicks must be positive')
    this.options = { ...options, pollIntervalMs, maxChunkTicks, autoScheduler: options.autoScheduler ?? false }
    this.now = options.nowMs
    this.newUuid = options.randomUUID
    this.timer = options.timer
    this.yieldToEventLoop = options.yieldToEventLoop ?? (() => Promise.resolve())
    if (this.options.autoScheduler && this.timer === undefined) {
      throw new Error('LocalRepositoryHost autoScheduler requires injected timer runtime')
    }
  }

  get currentDeviceId(): string { return this.localDeviceIdValue }
  get lastReopen(): CoverageReopen | undefined {
    return this.lastReopenValue === undefined ? undefined : clone(this.lastReopenValue)
  }
  isSchedulerRunning(): boolean { return this.schedulerRunning }

  getStatus(): LocalRepositoryHostStatus {
    return {
      mode: 'local',
      state: this.state,
      offline: true,
      serverMode: false,
      role: this.role,
      readOnly: this.isReadOnly(),
      catchingUp: this.state === 'catching_up',
      authorityState: this.localDocument?.authority.state ?? 'active',
      revision: this.localDocument?.revision ?? 0,
      eventSeq: this.localDocument?.eventSeq ?? 0,
      commandSeq: this.commandCount(),
      ...(this.localDeviceIdValue ? { localDeviceId: this.localDeviceIdValue } : {}),
      ...(this.appInstanceIdValue ? { appInstanceId: this.appInstanceIdValue } : {}),
      ...(this.notice === undefined ? {} : { notice: this.notice }),
      ...(this.error === undefined ? {} : { error: this.error }),
    }
  }

  getProjection(): LocalRepositoryHostProjection | null {
    return this.lastProjectionValue === null ? null : clone(this.lastProjectionValue)
  }

  getDocument(): LocalPetDocumentV2 | null {
    return this.localDocument === null ? null : clone(this.localDocument)
  }

  getRecentEvents(): LocalRepositoryHostEvent[] {
    return this.eventHistory.map(event => ({
      eventSeq: event.eventSeq,
      revision: event.revision ?? this.currentRevision(),
      ...(event.commandSeq === undefined ? {} : { commandSeq: event.commandSeq }),
      gameTimeMs: event.gameTimeMs ?? this.eventGameTimeMs(),
      type: event.type,
      payload: clone(event.payload),
    }))
  }

  async load(): Promise<LocalRepositoryHostProjection | null> {
    return this.enqueue(() => this.loadOnce())
  }

  async start(): Promise<LocalRepositoryHostProjection | null> {
    return this.enqueue(async () => {
      if (this.stopped) throw new Error('LocalRepositoryHost has been stopped')
      const projection = await this.loadOnce()
      if (projection !== null && this.isReadOnly() === false && this.state !== 'suspended') this.startScheduler()
      return this.getProjection()
    })
  }

  async flush(): Promise<void> {
    return this.enqueue(async () => {
      if (this.stopped || this.localDocument === null || this.isReadOnly()) return
      const at = this.now()
      const candidate = clone(this.localDocument)
      this.touchCoverageOn(candidate, at)
      this.syncAuthorityOn(candidate, at)
      if (changed(candidate, this.localDocument) === false) return
      await this.persistDocument(candidate)
      this.localDocument = candidate
      this.idempotency = candidate.idempotency ?? this.idempotency
      this.lastHeartbeatPersistedAt = at
      this.emitProjection()
    })
  }

  async stop(): Promise<void> {
    return this.enqueue(async () => {
      if (this.stopped) return
      if (this.localDocument !== null && this.isReadOnly() === false) {
        const at = this.now()
        const candidate = clone(this.localDocument)
        this.finalizeCoverageReopenOn(candidate, at, 'app_shutdown', true)
        this.closeAllOpenCoverageOn(candidate, at, 'app_shutdown')
        this.syncAuthorityOn(candidate, at)
        await this.persistDocument(candidate)
        this.localDocument = candidate
        this.idempotency = candidate.idempotency ?? this.idempotency
        this.openCoverageId = undefined
      }
      this.stopped = true
      this.stopScheduler()
      this.state = 'stopped'
      this.emitProjection()
    })
  }

  pump(): Promise<void> {
    return this.enqueue(async () => { await this.pollScheduler() })
  }

  setRole(role: LocalRepositoryHostRole): LocalRepositoryHostStatus {
    this.role = role
    this.emitProjection()
    return this.getStatus()
  }

  async setAdvanceWhileEmpty(enabled: boolean): Promise<LocalRepositoryHostProjection | null> {
    return this.enqueue(async () => {
      if (this.localDocument === null || this.isReadOnly() || this.state === 'suspended') throw new Error('local repository is read-only')
      const candidate = clone(this.localDocument)
      candidate.bundle.engine.advanceWhileEmpty = enabled
      this.syncAuthorityOn(candidate, this.now())
      await this.persistDocument(candidate)
      this.localDocument = candidate
      this.idempotency = candidate.idempotency ?? this.idempotency
      this.emitProjection()
      return this.getProjection()
    })
  }

  async setLocalSettings(patch: Partial<DeviceLocalSettings>): Promise<LocalRepositoryHostProjection | null> {
    return this.updateDeviceOverlay({ settings: patch })
  }

  /** Local-only position/settings/presentation update; never touches canonical shared state. */
  async updateDeviceOverlay(value: unknown): Promise<LocalRepositoryHostProjection | null> {
    return this.enqueue(async () => {
      if (this.localDocument === null || this.isReadOnly() || this.state === 'suspended') throw new Error('local repository is read-only')
      const patch = sanitizeDeviceLocalOverlayPatch(value)
      const candidate = clone(this.localDocument)
      candidate.device = mergeDeviceLocalOverlay(candidate.device, patch)
      this.syncAuthorityOn(candidate, this.now())
      await this.persistDocument(candidate)
      this.localDocument = candidate
      this.idempotency = candidate.idempotency ?? this.idempotency
      this.emitProjection()
      return this.getProjection()
    })
  }

  command<K extends CommandKey>(
    command: Extract<PetCommand, { type: K }>,
    options: LocalRepositoryHostCommandOptions = {},
  ): Promise<CommandResult<K>> {
    const opId = options.opId ?? this.newUuid()
    return this.enqueue(() => this.executeCommandNow(command, opId, options.role ?? this.role))
  }

  reset(opId: string = this.newUuid()): Promise<CommandResult<'pet.reset'>> {
    return this.command({ type: 'pet.reset', payload: {} }, { opId, role: 'owner' })
  }

  exportPortableBundle(): PortablePetBundleV1 | null {
    if (this.localDocument === null) return null
    return clone(this.localDocument.bundle)
  }

  exportPortableBundleJson(): string | null {
    const bundle = this.exportPortableBundle()
    return bundle === null ? null : serializePortablePetBundle(bundle)
  }

  async importPortableBundle(
    value: PortablePetBundleV1 | string,
    options: LocalRepositoryHostImportOptions = {},
  ): Promise<LocalRepositoryHostProjection> {
    const opId = options.opId ?? this.newUuid()
    return this.enqueue(async () => {
      if (this.localDocument === null || this.stopped || this.state === 'loading') {
        throw new Error('authority_not_active: local repository is not active')
      }
      requireOpId(opId)
      if (this.state === 'read_only' || this.state === 'handoff_pending') {
        throw new Error('authority_not_active: local repository is read-only')
      }
      if (this.state === 'catching_up') throw new Error('server_catching_up: local repository is catching up')
      if (this.state === 'suspended') throw new Error('not_available: local repository is suspended')
      if (
        this.localDocument.authority.state !== 'active'
        || this.localDocument.authority.stamp.owner !== 'local'
      ) {
        throw new Error('authority_not_active: local repository authority is not active')
      }
      const priorState = this.state
      const cached = this.findCachedCommands(opId)
      const duplicateImport = cached.find(record =>
        record.petId === this.localDeviceIdValue
        && record.deviceId === this.localDeviceIdValue
        && record.commandType === 'admin.importPortableBundle')
      if (duplicateImport !== undefined) {
        const current = this.getProjection()
        if (current === null) throw new Error('internal: imported projection is unavailable')
        return current
      }
      if (cached.length > 0) throw new Error('op_id_conflict: opId is already used by another import scope or command')

      const at = this.now()
      const parsed = typeof value === 'string' ? parseJson(value, 'portable bundle') : value
      const bundle = this.parseImportBundle(parsed, at)
      this.validateImportedBundle(bundle, options)
      const current = this.localDocument
      const candidate = clone(current)
      const operationId = this.newUuid()
      requireBoundedId(operationId, 'coverage operationId')
      const survivors = this.captureSurvivorsOn(candidate)
      this.closeAllOpenCoverageOn(candidate, at, 'import_replaced')

      let importedEngine = clone(bundle.engine)
      for (const interval of importedEngine.sessionCoverage) {
        if (interval.disconnectedAtWallMs !== undefined) continue
        this.closeCoverageInterval(interval, at, 'import_replaced')
      }
      importedEngine = reconcileImportedSessionActors(importedEngine, {
        localActorDeviceId: bundle.originLocalDeviceId ?? this.localDeviceIdValue,
        newActorDeviceId: this.localDeviceIdValue,
        rebindLocalSessions: true,
        nowMs: importedEngine.gameTimeMs,
      })
      delete importedEngine.coverageReopen

      const incoming = bundle.authority
      const currentStamp = current.authority.stamp
      const stamp: AuthorityStamp = {
        owner: 'local',
        authorityId: incoming.owner === 'server' ? incoming.authorityId : currentStamp.authorityId,
        epoch: Math.max(currentStamp.epoch, incoming.epoch) + 1,
        restoreGeneration: incoming.owner === 'server'
          ? incoming.restoreGeneration
          : Math.max(currentStamp.restoreGeneration, incoming.restoreGeneration),
        revision: incoming.revision,
        eventSeq: incoming.eventSeq,
        handoffId: incoming.handoffId || currentStamp.handoffId,
        detachedAtWallMs: incoming.detachedAtWallMs,
      }
      const marker: CoverageReopen = {
        operationId,
        commitWallMs: at,
        survivors: clone(survivors),
        state: 'pending',
      }
      importedEngine.coverageReopen = marker
      candidate.bundle = {
        ...bundle,
        originLocalDeviceId: this.localDeviceIdValue,
        engine: importedEngine,
        shared: importedEngine.save,
        authority: stamp,
        exportedAtWallMs: at,
      }
      candidate.authority = { state: 'active', stamp }
      candidate.revision = stamp.revision
      candidate.eventSeq = stamp.eventSeq
      candidate.eventHistory = []
      candidate.idempotency = {
        schemaVersion: 2,
        records: [{
          petId: this.localDeviceIdValue,
          deviceId: this.localDeviceIdValue,
          opId,
          commandType: 'admin.importPortableBundle',
          resultPresent: true,
          result: {
            authorityId: stamp.authorityId,
            epoch: stamp.epoch,
            revision: stamp.revision,
            eventSeq: stamp.eventSeq,
          },
        }],
      }
      const reopenedCoverageId = this.completeCoverageReopenOn(candidate, at)
      this.syncAuthorityOn(candidate, at)

      const currentText = await this.readStorage('readDocument', 'local v2 document')
      await this.options.storage.backupDocument(currentText ?? JSON.stringify(current, null, 2), 'import')
      try {
        await this.persistDocument(candidate)
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
        const stillActive = this.localDocument !== null
          && this.localDocument.authority.state === 'active'
          && this.localDocument.authority.stamp.owner === 'local'
        if (stillActive) {
          this.state = priorState
        } else {
          this.state = 'read_only'
          this.stopScheduler()
        }
        this.emitProjection()
        throw error
      }

      this.localDocument = candidate
      this.idempotency = candidate.idempotency ?? emptyOpIdCache()
      this.eventHistory = []
      this.lastReopenValue = clone(marker)
      this.openCoverageId = reopenedCoverageId
      this.lastHeartbeatPersistedAt = at
      this.state = 'ready'
      this.error = undefined
      this.startScheduler()
      this.emitProjection()
      const projection = this.getProjection()
      if (projection === null) throw new Error('internal: imported projection is unavailable')
      return projection
    })
  }

  private parseImportBundle(value: unknown, at: number): PortablePetBundleV1 {
    if (isRecord(value) && value.format === LOCAL_DOCUMENT_FORMAT) {
      assertLocalPetDocumentV2(value)
      if (value.authority.state !== 'active') throw new Error('authority_not_active: imported local document is not active')
      return clone(value.bundle)
    }
    if (isRecord(value) && typeof value.format === 'string' && value.format.startsWith('qqpet-portable-')) {
      return migratePortablePetBundle(value)
    }
    if (this.localDocument === null) throw new Error('authority_not_active: local repository is unavailable')
    const current = this.localDocument
    const authority: AuthorityStamp = {
      ...current.authority.stamp,
      owner: 'local',
      revision: current.revision,
      eventSeq: current.eventSeq,
    }
    return migrateLegacySaveDataToPortableBundle(value, {
      nowMs: at,
      localDeviceId: this.localDeviceIdValue,
      timeZone: current.bundle.engine.timeZone,
      seedHex: this.seedHex(),
      authority,
      advanceWhileEmpty: current.bundle.engine.advanceWhileEmpty,
    })
  }

  private validateImportedBundle(bundle: PortablePetBundleV1, options: LocalRepositoryHostImportOptions): void {
    if (this.localDocument === null) throw new Error('authority_not_active: local repository is unavailable')
    const incoming = bundle.authority
    if (bundle.originLocalDeviceId !== undefined && bundle.originLocalDeviceId !== this.localDeviceIdValue) {
      throw new Error('identity_mismatch: originLocalDeviceId')
    }
    if (incoming.owner === 'server' && (
      options.expectedAuthorityId === undefined
      || options.expectedRestoreGeneration === undefined
      || options.expectedEpoch === undefined
      || options.expectedRevision === undefined
      || options.expectedEventSeq === undefined
    )) {
      throw new Error('invalid_payload: handoff import requires exact authority fields')
    }
    if (options.expectedAuthorityId !== undefined && incoming.authorityId !== options.expectedAuthorityId) throw new Error('identity_mismatch: authorityId')
    if (options.expectedRestoreGeneration !== undefined && incoming.restoreGeneration !== options.expectedRestoreGeneration) throw new Error('identity_mismatch: restoreGeneration')
    if (options.expectedEpoch !== undefined && incoming.epoch !== options.expectedEpoch) throw new Error('identity_mismatch: epoch')
    if (options.expectedRevision !== undefined && incoming.revision !== options.expectedRevision) throw new Error('identity_mismatch: revision')
    if (options.expectedEventSeq !== undefined && incoming.eventSeq !== options.expectedEventSeq) throw new Error('identity_mismatch: eventSeq')
    const currentStamp = this.localDocument.authority.stamp
    if (incoming.owner === 'local' && incoming.authorityId !== currentStamp.authorityId) {
      throw new Error('identity_mismatch: local authorityId')
    }
  }


  async suspend(): Promise<LocalRepositoryHostProjection | null> {
    return this.enqueue(async () => {
      if (this.localDocument === null || this.isReadOnly() || this.stopped) throw new Error('local repository is read-only')
      if (this.state === 'suspended') return this.getProjection()
      const candidate = clone(this.localDocument)
      const at = this.now()
      const pending = candidate.bundle.engine.coverageReopen?.state === 'pending'
        ? candidate.bundle.engine.coverageReopen
        : undefined
      const open = this.openCoverage(candidate)
      const closeAt = pending !== undefined || open === undefined
        ? at
        : Math.min(at, open.lastHeartbeatWallMs + LOCAL_REPOSITORY_HOST_COVERAGE_GRACE_MS)
      const survivors = pending !== undefined ? clone(pending.survivors) : this.captureSurvivorsOn(candidate)
      if (pending !== undefined) {
        for (const survivor of survivors) {
          if (survivor.eligible === false) continue
          this.materializeSurvivorInterval(candidate, pending, survivor, at, 'suspend', false)
        }
      }
      for (const interval of candidate.bundle.engine.sessionCoverage) {
        if (interval.disconnectedAtWallMs !== undefined) continue
        this.closeCoverageInterval(interval, closeAt, 'suspend')
      }
      const marker: CoverageReopen = {
        operationId: pending?.operationId ?? this.newUuid(),
        commitWallMs: pending?.commitWallMs ?? closeAt,
        survivors,
        state: 'suspended',
        suspendedAtWallMs: at,
      }
      candidate.bundle.engine.coverageReopen = marker
      this.syncAuthorityOn(candidate, at)
      await this.persistDocument(candidate)
      this.localDocument = candidate
      this.idempotency = candidate.idempotency ?? this.idempotency
      this.lastReopenValue = clone(marker)
      this.openCoverageId = undefined
      this.stopScheduler()
      this.state = 'suspended'
      this.error = undefined
      this.emitProjection()
      return this.getProjection()
    })
  }

  async resume(): Promise<LocalRepositoryHostProjection | null> {
    return this.enqueue(async () => {
      if (this.localDocument === null || this.isReadOnly() || this.stopped) throw new Error('local repository is read-only')
      if (this.state !== 'suspended') return this.getProjection()
      const candidate = clone(this.localDocument)
      const at = this.now()
      const marker = candidate.bundle.engine.coverageReopen
      let coverageId: string
      if (marker !== undefined) {
        const exact = marker.survivors.find((survivor): survivor is LocalCoverageSurvivor =>
          survivor.eligible
          && survivor.kind === 'local_app'
          && survivor.appInstanceId === candidate.runtime.appInstanceId
          && survivor.localDeviceId === this.localDeviceIdValue)
        coverageId = exact !== undefined
          ? marker.operationId + ':' + exact.appInstanceId + ':resume'
          : this.newUuid()
        this.upsertOpenCoverage(candidate, coverageId, at)
        delete candidate.bundle.engine.coverageReopen
        this.lastReopenValue = clone(marker)
      } else {
        coverageId = this.newUuid()
        this.upsertOpenCoverage(candidate, coverageId, at)
      }
      this.syncAuthorityOn(candidate, at)
      await this.persistDocument(candidate)
      this.localDocument = candidate
      this.idempotency = candidate.idempotency ?? this.idempotency
      this.openCoverageId = coverageId
      this.lastHeartbeatPersistedAt = at
      this.state = 'ready'
      this.error = undefined
      this.startScheduler()
      this.emitProjection()
      return this.getProjection()
    })
  }

  private enqueue<T>(task: () => T | Promise<T>): Promise<T> {
    const run = this.queue.then(task)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  private isReadOnly(): boolean {
    return this.state === 'loading'
      || this.state === 'read_only'
      || this.state === 'handoff_pending'
      || this.state === 'stopped'
      || this.localDocument === null
      || this.localDocument.authority.state !== 'active'
      || this.localDocument.authority.stamp.owner !== 'local'
  }

  private commandCount(): number {
    return this.localDocument?.idempotency?.records.length ?? this.idempotency.records.length
  }

  private currentRevision(): number {
    return this.localDocument?.revision ?? 0
  }

  private findCachedCommands(opId: string): IdempotencyRecord[] {
    return (this.localDocument?.idempotency ?? this.idempotency).records.filter(record => record.opId === opId)
  }

  private seedHex(): string {
    const injected = this.options.seedHex ?? this.options.randomSeedHex?.()
    if (typeof injected !== 'string' || injected.length === 0) throw new Error('local repository seed is not available')
    return injected
  }

  private async loadOnce(): Promise<LocalRepositoryHostProjection | null> {
    if (this.loaded) return this.getProjection()
    try {
      const loaded = await this.loadOrMigrate()
      this.localDocument = loaded.document
      this.idempotency = loaded.idempotency
      this.localDeviceIdValue = loaded.document.device.localDeviceId
      this.appInstanceIdValue = loaded.document.runtime.appInstanceId
      this.eventHistory = (loaded.document.eventHistory ?? [])
        .filter(event => event.eventSeq <= loaded.document.eventSeq)
        .slice(-LOCAL_REPOSITORY_HOST_EVENT_HISTORY_LIMIT)
      this.notice = loaded.notice
      this.loaded = true
      if (loaded.document.authority.state !== 'active' || loaded.document.authority.stamp.owner !== 'local') {
        this.state = loaded.document.authority.state === 'handoff_pending' ? 'handoff_pending' : 'read_only'
        this.error = 'authority_not_active'
        this.emitProjection()
        return this.getProjection()
      }

      const at = this.now()
      const candidate = clone(loaded.document)
      const appInstanceId = this.options.appInstanceId ?? this.newUuid()
      requireBoundedId(appInstanceId, 'appInstanceId')
      candidate.runtime = { appInstanceId, startedAtWallMs: at }
      this.appInstanceIdValue = appInstanceId
      this.repairCoverageOn(candidate, at)
      if (candidate.bundle.engine.advanceWhileEmpty === false && candidate.bundle.engine.lastSchedulerWallMs < at) {
        candidate.bundle.engine.lastSchedulerWallMs = at
      }
      const coverageId = this.openCoverageOn(candidate, at)
      this.syncAuthorityOn(candidate, at)
      await this.persistDocument(candidate)
      this.localDocument = candidate
      this.idempotency = candidate.idempotency ?? this.idempotency
      this.openCoverageId = coverageId
      this.lastHeartbeatPersistedAt = at
      this.eventHistory = (candidate.eventHistory ?? []).slice(-LOCAL_REPOSITORY_HOST_EVENT_HISTORY_LIMIT)
      this.state = 'ready'
      this.error = undefined
      this.emitProjection()
      await this.catchUp(at)
      return this.getProjection()
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      this.state = 'read_only'
      this.stopScheduler()
      this.emitProjection()
      return null
    }
  }

  private async loadOrMigrate(): Promise<LoadedDocument> {
    const documentText = await this.readStorage('readDocument', 'local v2 document')
    if (documentText !== null) {
      let raw: unknown
      try {
        raw = parseJson(documentText, 'local v2 document')
      } catch (error) {
        await this.options.storage.backupDocument(documentText, 'corrupt')
        await this.options.storage.preserveCorruptDocument(documentText)
        throw error
      }
      const record = isRecord(raw) ? raw : null
      const runtime = record !== null && isRecord(record.runtime) ? record.runtime : null
      const duplicateIdentity = runtime !== null && Object.prototype.hasOwnProperty.call(runtime, 'localDeviceId')
      const missingIdempotency = record !== null && record.idempotency === undefined
      const missingEventMetadata = record !== null
        && Array.isArray(record.eventHistory)
        && record.eventHistory.some(event => isRecord(event) === false || event.revision === undefined || event.gameTimeMs === undefined)
      if (duplicateIdentity && record !== null) {
        const expected = isRecord(record.device) && typeof record.device.localDeviceId === 'string'
          ? record.device.localDeviceId
          : ''
        if (typeof runtime.localDeviceId !== 'string' || runtime.localDeviceId !== expected) {
          await this.options.storage.backupDocument(documentText, 'identity_mismatch')
          await this.options.storage.preserveCorruptDocument(documentText)
          throw new Error('identity_mismatch: runtime.localDeviceId must match device.localDeviceId')
        }
      }
      if (duplicateIdentity || missingIdempotency || missingEventMetadata) {
        await this.options.storage.backupDocument(documentText, 'migration')
      }
      let loaded: LoadedDocument
      try {
        loaded = normalizeLocalRepositoryDocument(raw)
      } catch (error) {
        if (duplicateIdentity === false) {
          await this.options.storage.backupDocument(documentText, 'corrupt')
          await this.options.storage.preserveCorruptDocument(documentText)
        }
        throw error
      }
      loaded.document.runtime = {
        appInstanceId: this.options.appInstanceId ?? this.newUuid(),
        startedAtWallMs: this.now(),
      }
      loaded.notice = duplicateIdentity
        ? 'legacy-local-device-id-migrated'
        : missingIdempotency
          ? 'legacy-idempotency-cache-migrated'
          : missingEventMetadata
            ? 'legacy-event-history-migrated'
            : undefined
      return loaded
    }

    const legacyText = await this.readStorage('readLegacySave', 'legacy save')
    if (legacyText !== null) return this.migrateLegacy(legacyText, 'legacy-save-migrated')
    if (this.options.initialSave !== undefined) {
      return this.migrateLegacy(JSON.stringify(this.options.initialSave), 'initial-save-migrated', false)
    }
    return this.migrateLegacy(JSON.stringify(startSave(null)), 'new-local-document', false)
  }

  private async readStorage(method: 'readDocument' | 'readLegacySave', label: string): Promise<string | null> {
    const value = await this.options.storage[method]()
    if (value === null) return null
    if (typeof value !== 'string') throw new Error(label + ' read returned a non-string value')
    return value
  }

  private async migrateLegacy(text: string, notice: string, backup = true): Promise<LoadedDocument> {
    let raw: unknown
    if (backup) await this.options.storage.backupLegacySave(text, 'migration')
    try {
      raw = parseJson(text, 'legacy save')
    } catch (error) {
      if (backup) await this.options.storage.backupLegacySave(text, 'corrupt')
      throw error
    }
    const at = this.now()
    const localDeviceId = this.options.localDeviceId ?? this.newUuid()
    requireBoundedId(localDeviceId, 'localDeviceId')
    const candidate = legacySaveCandidate(raw)
    const authority: AuthorityStamp = {
      owner: 'local',
      authorityId: this.newUuid(),
      epoch: 1,
      restoreGeneration: 1,
      revision: 0,
      eventSeq: 0,
      handoffId: this.newUuid(),
      detachedAtWallMs: 0,
    }
    const timeZone = this.options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'Asia/Shanghai'
    const bundle = migrateLegacySaveDataToPortableBundle(raw, {
      nowMs: at,
      localDeviceId,
      timeZone,
      seedHex: this.seedHex(),
      authority,
      advanceWhileEmpty: this.options.advanceWhileEmpty !== false,
    })
    const save = startSave(candidate as unknown as Record<string, unknown>)
    const device = toDeviceLocalOverlay(save, localDeviceId)
    const appInstanceId = this.options.appInstanceId ?? this.newUuid()
    requireBoundedId(appInstanceId, 'appInstanceId')
    const document: LocalPetDocumentV2 = {
      format: LOCAL_DOCUMENT_FORMAT,
      schemaVersion: LOCAL_DOCUMENT_SCHEMA_VERSION,
      revision: authority.revision,
      eventSeq: authority.eventSeq,
      authority: { state: 'active', stamp: authority },
      bundle,
      runtime: { appInstanceId, startedAtWallMs: at },
      device,
      idempotency: emptyOpIdCache(),
    }
    assertLocalPetDocumentV2(document)
    await this.persistDocument(document)
    this.localDeviceIdValue = localDeviceId
    this.appInstanceIdValue = appInstanceId
    const normalized = normalizeLocalRepositoryDocument(document)
    return { ...normalized, notice }
  }

  private repairCoverageOn(document: LocalPetDocumentV2, at: number): void {
    const marker = document.bundle.engine.coverageReopen
    if (marker !== undefined) {
      this.lastReopenValue = clone(marker)
      this.finalizeCoverageReopenOn(document, at, 'crash_repaired', true)
    }
    for (const interval of document.bundle.engine.sessionCoverage) {
      if (interval.disconnectedAtWallMs !== undefined) continue
      const end = Math.max(
        interval.connectedAtWallMs,
        Math.min(at, interval.lastHeartbeatWallMs + LOCAL_REPOSITORY_HOST_COVERAGE_GRACE_MS),
      )
      this.closeCoverageInterval(interval, end, 'crash_repaired')
    }
    this.openCoverageId = undefined
  }

  private openCoverage(document: LocalPetDocumentV2): SessionCoverageInterval | undefined {
    if (this.openCoverageId !== undefined) {
      const exact = document.bundle.engine.sessionCoverage.find(interval => interval.coverageId === this.openCoverageId)
      if (exact !== undefined && exact.disconnectedAtWallMs === undefined) return exact
    }
    return document.bundle.engine.sessionCoverage.find(interval => interval.disconnectedAtWallMs === undefined)
  }

  private openCoverageOn(document: LocalPetDocumentV2, at: number): string {
    const coverageId = this.newUuid()
    requireBoundedId(coverageId, 'coverageId')
    document.bundle.engine.sessionCoverage.push({
      coverageId,
      deviceId: this.localDeviceIdValue,
      connectedAtWallMs: at,
      lastHeartbeatWallMs: at,
    })
    this.openCoverageId = coverageId
    return coverageId
  }

  private upsertOpenCoverage(document: LocalPetDocumentV2, coverageId: string, at: number): void {
    requireBoundedId(coverageId, 'coverageId')
    const existing = document.bundle.engine.sessionCoverage.find(interval => interval.coverageId === coverageId)
    if (existing !== undefined) {
      existing.connectedAtWallMs = Math.min(existing.connectedAtWallMs, at)
      existing.lastHeartbeatWallMs = Math.max(existing.lastHeartbeatWallMs, at)
      delete existing.disconnectedAtWallMs
      delete existing.closeReason
      return
    }
    document.bundle.engine.sessionCoverage.push({
      coverageId,
      deviceId: this.localDeviceIdValue,
      connectedAtWallMs: at,
      lastHeartbeatWallMs: at,
    })
  }

  private touchCoverageOn(document: LocalPetDocumentV2, at: number): void {
    const open = this.openCoverage(document)
    if (open !== undefined && open.lastHeartbeatWallMs < at) open.lastHeartbeatWallMs = at
  }

  private closeCoverageInterval(interval: SessionCoverageInterval, at: number, reason: CoverageEndProvenance): void {
    const end = Math.max(interval.connectedAtWallMs, at)
    if (interval.disconnectedAtWallMs === undefined || end < interval.disconnectedAtWallMs) {
      interval.disconnectedAtWallMs = end
      if (interval.closeReason === undefined) interval.closeReason = reason
    }
    interval.lastHeartbeatWallMs = Math.max(interval.lastHeartbeatWallMs, interval.disconnectedAtWallMs)
    if (interval.closeReason === undefined) interval.closeReason = reason
  }

  private closeAllOpenCoverageOn(document: LocalPetDocumentV2, at: number, reason: CoverageEndProvenance): void {
    for (const interval of document.bundle.engine.sessionCoverage) {
      if (interval.disconnectedAtWallMs !== undefined) continue
      this.closeCoverageInterval(interval, at, reason)
    }
  }

  private stableSurvivorCoverageId(operation: CoverageReopen, survivor: CoverageSurvivor): string {
    return survivor.kind === 'local_app'
      ? operation.operationId + ':' + survivor.appInstanceId
      : operation.operationId + ':' + survivor.connectionId
  }

  private captureSurvivorsOn(document: LocalPetDocumentV2): CoverageSurvivor[] {
    const open = this.openCoverage(document)
    if (open === undefined) return []
    return [{
      kind: 'local_app',
      appInstanceId: document.runtime.appInstanceId,
      localDeviceId: document.device.localDeviceId,
      lastHeartbeatWallMs: open.lastHeartbeatWallMs,
      eligible: true,
    }]
  }

  private prepareMutation(): MutationContext | null {
    if (this.localDocument === null) return null
    const base = clone(this.localDocument)
    const at = this.now()
    this.touchCoverageOn(base, at)
    const survivors = this.captureSurvivorsOn(base)
    const operationId = this.newUuid()
    requireBoundedId(operationId, 'coverage operationId')
    this.closeAllOpenCoverageOn(base, at, 'pet_reset')
    const coverage = clone(base.bundle.engine.sessionCoverage)
    return { base, survivors, coverage, operationId, commitWallMs: at }
  }

  private survivorInterval(
    document: LocalPetDocumentV2,
    operation: CoverageReopen,
    survivor: CoverageSurvivor,
  ): SessionCoverageInterval | undefined {
    const coverageId = this.stableSurvivorCoverageId(operation, survivor)
    return document.bundle.engine.sessionCoverage.find(interval => interval.coverageId === coverageId)
  }

  private finalizeCoverageReopenOn(
    document: LocalPetDocumentV2,
    eventBoundary: number,
    eventReason: CoverageEndProvenance,
    terminal: boolean,
  ): void {
    const operation = document.bundle.engine.coverageReopen
    if (operation === undefined) return
    for (const survivor of operation.survivors) {
      if (survivor.eligible === false) continue
      const existing = this.survivorInterval(document, operation, survivor)
      if (survivor.activeEndWallMs !== undefined) {
        if (terminal) survivor.eligible = false
        continue
      }
      let end = eventBoundary
      if (eventReason === 'crash_repaired') {
        end = Math.min(end, survivor.lastHeartbeatWallMs + LOCAL_REPOSITORY_HOST_COVERAGE_GRACE_MS)
      }
      if (survivor.activeEndWallMs !== undefined) end = Math.min(end, survivor.activeEndWallMs)
      if (existing?.disconnectedAtWallMs !== undefined) end = Math.min(end, existing.disconnectedAtWallMs)
      if (operation.suspendedAtWallMs !== undefined) end = Math.min(end, operation.suspendedAtWallMs)
      end = Math.max(operation.commitWallMs, end)
      const cappedBySuspend = operation.suspendedAtWallMs !== undefined && end >= operation.suspendedAtWallMs
      const effectiveReason: CoverageEndProvenance =
        operation.state === 'suspended' || cappedBySuspend || existing?.closeReason === 'suspend'
          ? 'suspend'
          : eventReason
      this.materializeSurvivorInterval(document, operation, survivor, end, effectiveReason, terminal)
      if (terminal) {
        survivor.activeEndWallMs ??= end
        survivor.activeEndProvenance ??= effectiveReason
        survivor.eligible = false
      }
    }
    if (terminal || operation.survivors.every(survivor => survivor.eligible === false)) {
      delete document.bundle.engine.coverageReopen
    } else {
      operation.state = 'suspended'
      operation.suspendedAtWallMs ??= eventBoundary
    }
  }

  private materializeSurvivorInterval(
    document: LocalPetDocumentV2,
    operation: CoverageReopen,
    survivor: CoverageSurvivor,
    endAt: number,
    reason: CoverageEndProvenance,
    terminal: boolean,
  ): void {
    const coverageId = this.stableSurvivorCoverageId(operation, survivor)
    const saturated = Math.max(operation.commitWallMs, endAt)
    const existing = document.bundle.engine.sessionCoverage.find(interval => interval.coverageId === coverageId)
    if (existing !== undefined) {
      if (existing.closeReason === 'suspend') {
        existing.lastHeartbeatWallMs = Math.max(existing.lastHeartbeatWallMs, existing.disconnectedAtWallMs ?? saturated)
        if (terminal) {
          survivor.activeEndWallMs = existing.disconnectedAtWallMs
            ?? Math.min(saturated, operation.suspendedAtWallMs ?? saturated)
          survivor.activeEndProvenance = 'suspend'
        }
        return
      }
      if (existing.disconnectedAtWallMs === undefined || saturated < existing.disconnectedAtWallMs) {
        existing.disconnectedAtWallMs = saturated
        if (existing.closeReason === undefined) existing.closeReason = reason
      }
      existing.lastHeartbeatWallMs = Math.max(existing.lastHeartbeatWallMs, existing.disconnectedAtWallMs)
      if (terminal) {
        survivor.activeEndWallMs = existing.disconnectedAtWallMs
        survivor.activeEndProvenance = existing.closeReason ?? reason
      }
      return
    }
    document.bundle.engine.sessionCoverage.push({
      coverageId,
      deviceId: survivor.kind === 'local_app' ? survivor.localDeviceId : survivor.deviceId,
      connectedAtWallMs: operation.commitWallMs,
      disconnectedAtWallMs: saturated,
      lastHeartbeatWallMs: Math.max(survivor.lastHeartbeatWallMs, saturated),
      closeReason: reason,
    })
    if (terminal) {
      survivor.activeEndWallMs = saturated
      survivor.activeEndProvenance = reason
    }
  }

  private completeCoverageReopenOn(document: LocalPetDocumentV2, at: number): string | undefined {
    const operation = document.bundle.engine.coverageReopen
    if (operation === undefined) return undefined
    const exact = operation.survivors.find((survivor): survivor is LocalCoverageSurvivor =>
      survivor.eligible
      && survivor.kind === 'local_app'
      && survivor.appInstanceId === document.runtime.appInstanceId
      && survivor.localDeviceId === document.device.localDeviceId)
    if (exact === undefined) return undefined
    const coverageId = operation.operationId + ':' + exact.appInstanceId
    this.upsertOpenCoverage(document, coverageId, operation.commitWallMs)
    const interval = document.bundle.engine.sessionCoverage.find(item => item.coverageId === coverageId)
    if (interval !== undefined && interval.lastHeartbeatWallMs < at) interval.lastHeartbeatWallMs = at
    delete document.bundle.engine.coverageReopen
    return coverageId
  }

  private async executeCommandNow<K extends CommandKey>(
    command: Extract<PetCommand, { type: K }>,
    opId: string,
    role: LocalRepositoryHostRole,
  ): Promise<CommandResult<K>> {
    const commandSeqFallback = this.commandCount() + 1
    try {
      requireOpId(opId)
    } catch (error) {
      const rejected = this.rejectedCommandResult(command, opId, commandSeqFallback, {
        code: 'invalid_payload',
        message: error instanceof Error ? error.message : String(error),
        refreshProjection: false,
      })
      this.options.onCommandResult?.(clone(rejected))
      return rejected
    }
    if (this.localDocument === null || this.stopped || this.state === 'loading') {
      const rejected = this.rejectedCommandResult(command, opId, commandSeqFallback, {
        code: 'authority_not_active', message: 'local repository is not active', refreshProjection: true,
      })
      this.options.onCommandResult?.(clone(rejected))
      return rejected
    }
    if (this.state === 'read_only' || this.state === 'handoff_pending') {
      const rejected = this.rejectedCommandResult(command, opId, commandSeqFallback, {
        code: 'authority_not_active', message: 'local repository is read-only', refreshProjection: true,
      })
      this.options.onCommandResult?.(clone(rejected))
      return rejected
    }
    if (this.state === 'catching_up') {
      const rejected = this.rejectedCommandResult(command, opId, commandSeqFallback, {
        code: 'server_catching_up', message: 'local repository is catching up', refreshProjection: true,
      })
      this.options.onCommandResult?.(clone(rejected))
      return rejected
    }
    if (this.state === 'suspended') {
      const rejected = this.rejectedCommandResult(command, opId, commandSeqFallback, {
        code: 'not_available', message: 'local repository is suspended', refreshProjection: false,
      })
      this.options.onCommandResult?.(clone(rejected))
      return rejected
    }
    if (
      this.localDocument.authority.state !== 'active'
      || this.localDocument.authority.stamp.owner !== 'local'
    ) {
      const rejected = this.rejectedCommandResult(command, opId, commandSeqFallback, {
        code: 'authority_not_active', message: 'local repository authority is not active', refreshProjection: true,
      })
      this.options.onCommandResult?.(clone(rejected))
      return rejected
    }
    const cached = this.findCachedCommands(opId)
    const duplicateRecord = cached.find(record =>
      record.petId === this.localDeviceIdValue
      && record.deviceId === this.localDeviceIdValue
      && record.commandType === command.type)
    if (duplicateRecord !== undefined) {
      const duplicate = this.duplicateCommandResult(command, opId, duplicateRecord)
      this.options.onCommandResult?.(clone(duplicate))
      return duplicate
    }
    if (cached.length > 0) {
      const conflict = this.rejectedCommandResult(command, opId, commandSeqFallback, {
        code: 'op_id_conflict',
        message: 'opId conflicts with a cached command in another scope or command type',
        refreshProjection: true,
      })
      this.options.onCommandResult?.(clone(conflict))
      return conflict
    }

    const baseDocument = this.localDocument
    const at = this.now()
    const mutation = command.type === 'pet.reset' ? this.prepareMutation() : null
    const candidate = mutation !== null ? clone(mutation.base) : clone(baseDocument)
    this.touchCoverageOn(candidate, at)
    const idempotentDocument: PersistedRuntimeState = {
      schemaVersion: 2,
      engine: candidate.bundle.engine,
      idempotency: candidate.idempotency ?? emptyOpIdCache(),
    }
    const ctx: RuntimeCommandContext = {
      gameTimeMs: candidate.bundle.engine.gameTimeMs,
      environment: candidate.bundle.engine.environment,
      activeClientCount: 1,
      sessionActive: true,
      actorDeviceId: this.localDeviceIdValue,
      actorRole: role,
      wallNowMs: at,
    }
    let outcome
    try {
      outcome = executeCommandIdempotent(
        this.localDeviceIdValue,
        this.localDeviceIdValue,
        idempotentDocument,
        command,
        ctx,
        opId,
      )
    } catch (error) {
      const rejected = this.rejectedCommandResult(command, opId, commandSeqFallback, {
        code: 'invalid_payload',
        message: error instanceof Error ? error.message : String(error),
        refreshProjection: false,
      })
      this.options.onCommandResult?.(clone(rejected))
      return rejected
    }
    const record = candidate.idempotency?.records.find(item =>
      item.deviceId === this.localDeviceIdValue && item.opId === opId)
      ?? outcome.document.idempotency.records.find(item =>
        item.deviceId === this.localDeviceIdValue && item.opId === opId)
    if (outcome.duplicate) {
      if (record === undefined) throw new Error('duplicate command is missing its idempotency record')
      const duplicate = this.duplicateCommandResult(command, opId, record, outcome.outcome)
      this.options.onCommandResult?.(clone(duplicate))
      return duplicate
    }
    if (record === undefined) throw new Error('committed command is missing its idempotency record')

    const accepted = outcome.outcome.ok
    let commitReopen: CoverageReopen | undefined
    let reopenedCoverageId: string | undefined
    if (mutation !== null) {
      if (accepted) {
        const candidateEngine = outcome.outcome.ok ? outcome.outcome.state : candidate.bundle.engine
        candidateEngine.sessionCoverage = clone(mutation.coverage)
        const marker: CoverageReopen = {
          operationId: mutation.operationId,
          commitWallMs: mutation.commitWallMs,
          survivors: clone(mutation.survivors),
          state: 'pending',
        }
        candidateEngine.coverageReopen = marker
        candidate.bundle.engine = candidateEngine
        reopenedCoverageId = this.completeCoverageReopenOn(candidate, at)
        commitReopen = marker
      } else {
        candidate.bundle.engine = clone(baseDocument.bundle.engine)
      }
    } else {
      candidate.bundle.engine = outcome.document.engine
    }
    candidate.bundle.shared = candidate.bundle.engine.save
    candidate.revision = accepted ? baseDocument.revision + 1 : baseDocument.revision
    candidate.eventSeq = baseDocument.eventSeq + (outcome.outcome.ok ? outcome.outcome.events.length : 0)
    candidate.idempotency = outcome.document.idempotency
    const commandSeq = candidate.idempotency.records.findIndex(item =>
      item.deviceId === this.localDeviceIdValue && item.opId === opId) + 1
    const ordered: LocalEventHistoryEntry[] = outcome.outcome.ok
      ? outcome.outcome.events.map((event: DomainEvent, index: number) => ({
          ...orderedDomainEvent(baseDocument.eventSeq + index + 1, event),
          revision: candidate.revision,
          gameTimeMs: candidate.bundle.engine.gameTimeMs,
          commandSeq,
        }))
      : []
    candidate.eventHistory = [...(baseDocument.eventHistory ?? []), ...ordered]
      .slice(-LOCAL_REPOSITORY_HOST_EVENT_HISTORY_LIMIT)
    this.syncAuthorityOn(candidate, at)
    try {
      await this.persistDocument(candidate)
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      this.state = 'read_only'
      this.stopScheduler()
      this.emitProjection()
      const rejected = this.rejectedCommandResult(command, opId, commandSeqFallback, {
        code: 'internal', message: 'local persistence failed', refreshProjection: true,
      })
      this.options.onCommandResult?.(clone(rejected))
      return rejected
    }
    this.localDocument = candidate
    this.idempotency = candidate.idempotency ?? emptyOpIdCache()
    this.eventHistory = (candidate.eventHistory ?? []).slice(-LOCAL_REPOSITORY_HOST_EVENT_HISTORY_LIMIT)
    this.lastHeartbeatPersistedAt = at
    if (reopenedCoverageId !== undefined) this.openCoverageId = reopenedCoverageId
    if (commitReopen !== undefined) this.lastReopenValue = clone(commitReopen)
    const projectedEvents = ordered.map(event =>
      this.projectEvent(event, event.revision ?? candidate.revision, event.gameTimeMs ?? candidate.bundle.engine.gameTimeMs, event.commandSeq))
    const commandResult = this.appliedOrRejectedResult(
      command,
      opId,
      commandSeq,
      candidate.revision,
      candidate.eventSeq,
      outcome.outcome,
    )
    this.emitProjection(projectedEvents)
    this.options.onCommandResult?.(clone(commandResult))
    return commandResult
  }

  private appliedOrRejectedResult<K extends CommandKey>(
    command: Extract<PetCommand, { type: K }>,
    opId: string,
    commandSeq: number,
    revision: number,
    eventSeq: number,
    outcome: RuntimeOutcome,
  ): CommandResult<K> {
    if (outcome.ok) {
      return {
        status: 'applied',
        commandType: command.type,
        opId,
        commandSeq,
        revision,
        eventSeq,
        ...(Object.prototype.hasOwnProperty.call(outcome, 'result') ? { result: outcome.result as never } : {}),
      }
    }
    return {
      status: 'rejected',
      commandType: command.type,
      opId,
      commandSeq,
      revision,
      eventSeq,
      error: outcome.error,
    }
  }

  private rejectedCommandResult<K extends CommandKey>(
    command: Extract<PetCommand, { type: K }>,
    opId: string,
    commandSeq: number,
    error: CommandError,
  ): CommandResult<K> {
    return {
      status: 'rejected',
      commandType: command.type,
      opId,
      commandSeq,
      revision: this.localDocument?.revision ?? 0,
      eventSeq: this.localDocument?.eventSeq ?? 0,
      error,
    }
  }

  private duplicateCommandResult<K extends CommandKey>(
    command: Extract<PetCommand, { type: K }>,
    opId: string,
    record: IdempotencyRecord,
    duplicateOutcome?: RuntimeOutcome,
  ): CommandResult<K> {
    const index = (this.localDocument?.idempotency ?? this.idempotency).records.findIndex(item =>
      item.petId === record.petId && item.deviceId === record.deviceId && item.opId === record.opId)
    const duplicateBase = {
      status: 'duplicate' as const,
      commandType: command.type,
      opId,
      commandSeq: index >= 0 ? index + 1 : this.commandCount(),
      revision: this.localDocument?.revision ?? 0,
      eventSeq: this.localDocument?.eventSeq ?? 0,
    }
    if (duplicateOutcome?.ok === false) {
      return { ...duplicateBase, original: 'rejected', error: duplicateOutcome.error }
    }
    if (record.error !== undefined) {
      return { ...duplicateBase, original: 'rejected', error: record.error }
    }
    if (record.resultPresent) {
      return { ...duplicateBase, original: 'applied', result: record.result as never }
    }
    return { ...duplicateBase, original: 'applied' }
  }

  private async catchUp(target: number): Promise<void> {
    if (this.localDocument === null || this.isReadOnly() || this.stopped) return
    const anchor = this.localDocument.bundle.engine.lastSchedulerWallMs
    // The scheduler polls every second but may only commit whole game minutes.
    // Never advance the persisted anchor for a partial minute, or a live 1s
    // poll loop would continuously swallow the due whole-minute tick.
    if (target - anchor < GAME_TICK_MS) return
    this.state = 'catching_up'
    this.emitProjection()
    let rounds = 0
    while (this.localDocument !== null
      && this.localDocument.bundle.engine.lastSchedulerWallMs < target
      && rounds++ < 1_000_000) {
      const candidate: LocalPetDocumentV2 = clone(this.localDocument)
      this.touchCoverageOn(candidate, target)
      const current = candidate.bundle.engine
      const ctx: RuntimeCommandContext = {
        gameTimeMs: current.gameTimeMs,
        environment: current.environment,
        activeClientCount: 0,
        sessionActive: false,
        actorDeviceId: null,
      }
      const coverageAtWallMs = (from: number, to: number) =>
        sessionActivityForInterval(candidate.bundle.engine.sessionCoverage, from, to)
      const outcome = advanceSchedulerChunk(current, ctx, target, {
        maxChunkTicks: this.options.maxChunkTicks,
        coverageAtWallMs,
      })
      candidate.bundle.engine = outcome.state
      candidate.bundle.shared = outcome.state.save
      if (outcome.ticks > 0) candidate.revision += 1
      const ordered: LocalEventHistoryEntry[] = outcome.events.map((event: DomainEvent, index: number) => ({
        ...orderedDomainEvent(candidate.eventSeq + index + 1, event),
        revision: candidate.revision,
        gameTimeMs: candidate.bundle.engine.gameTimeMs,
      }))
      candidate.eventSeq += ordered.length
      candidate.eventHistory = [...(candidate.eventHistory ?? []), ...ordered]
        .slice(-LOCAL_REPOSITORY_HOST_EVENT_HISTORY_LIMIT)
      const at = this.now()
      this.syncAuthorityOn(candidate, at)
      try {
        await this.persistDocument(candidate)
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
        this.state = 'read_only'
        this.stopScheduler()
        this.emitProjection()
        return
      }
      this.localDocument = candidate
      this.idempotency = candidate.idempotency ?? this.idempotency
      this.lastHeartbeatPersistedAt = at
      this.eventHistory = (candidate.eventHistory ?? []).slice(-LOCAL_REPOSITORY_HOST_EVENT_HISTORY_LIMIT)
      const events = ordered.map(event =>
        this.projectEvent(event, event.revision ?? candidate.revision, event.gameTimeMs ?? candidate.bundle.engine.gameTimeMs))
      this.emitProjection(events)
      if (outcome.frozen || outcome.ticks === 0) break
      await this.yieldToEventLoop()
    }
    if (this.state === 'catching_up') {
      this.state = 'ready'
      this.emitProjection()
    }
  }

  private async pollScheduler(): Promise<void> {
    if (this.localDocument === null || this.isReadOnly() || this.stopped || this.state === 'suspended') return
    const at = this.now()
    const anchor = this.localDocument.bundle.engine.lastSchedulerWallMs
    const heartbeatDue = at - this.lastHeartbeatPersistedAt >= LOCAL_REPOSITORY_HOST_HEARTBEAT_MS
    if (at - anchor < GAME_TICK_MS) {
      if (heartbeatDue === false) return
      const candidate = clone(this.localDocument)
      this.touchCoverageOn(candidate, at)
      this.syncAuthorityOn(candidate, at)
      try {
        await this.persistDocument(candidate)
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
        this.state = 'read_only'
        this.stopScheduler()
        this.emitProjection()
        return
      }
      this.localDocument = candidate
      this.idempotency = candidate.idempotency ?? this.idempotency
      this.lastHeartbeatPersistedAt = at
      this.emitProjection()
      return
    }
    await this.catchUp(at)
  }

  private startScheduler(): void {
    if (this.options.autoScheduler === false || this.schedulerRunning || this.stopped) return
    if (this.isReadOnly() || this.state === 'suspended') return
    if (this.timer === undefined) throw new Error('scheduler timer runtime is not available')
    this.schedulerHandle = this.timer.start(() => {
      void this.pump().catch((error) => {
        this.error = error instanceof Error ? error.message : String(error)
        this.state = 'read_only'
        this.stopScheduler()
        this.emitProjection()
      })
    }, this.options.pollIntervalMs)
    this.schedulerRunning = true
  }

  private stopScheduler(): void {
    if (this.schedulerRunning === false) return
    if (this.timer !== undefined) this.timer.clear(this.schedulerHandle)
    this.schedulerHandle = undefined
    this.schedulerRunning = false
  }

  private syncAuthorityOn(document: LocalPetDocumentV2, at: number): void {
    const stamp = document.authority.stamp
    stamp.revision = document.revision
    stamp.eventSeq = document.eventSeq
    document.bundle.authority = stamp
    document.bundle.shared = document.bundle.engine.save
    document.bundle.exportedAtWallMs = at
  }

  private async persistDocument(document: LocalPetDocumentV2): Promise<void> {
    assertLocalPetDocumentV2(document)
    const idempotency = document.idempotency ?? emptyOpIdCache()
    validateOpIdCache(idempotency)
    validatePersistedRuntimeState({ schemaVersion: 2, engine: document.bundle.engine, idempotency })
    await this.options.storage.writeDocumentAtomic(JSON.stringify(document, null, 2))
  }

  private eventGameTimeMs(): number {
    return this.localDocument?.bundle.engine.gameTimeMs ?? 0
  }

  private projectEvent(
    event: OrderedDomainEvent,
    revision: number,
    gameTimeMs: number,
    commandSeq?: number,
  ): LocalRepositoryHostEvent {
    return {
      eventSeq: event.eventSeq,
      revision,
      ...(commandSeq === undefined ? {} : { commandSeq }),
      gameTimeMs,
      type: event.type,
      payload: clone(event.payload),
    }
  }

  private emitProjection(events: LocalRepositoryHostEvent[] = []): void {
    if (this.localDocument === null) {
      this.options.onStatus?.(clone(this.getStatus()))
      return
    }
    const engine = this.localDocument.bundle.engine
    const projection: LocalRepositoryHostProjection = {
      format: LOCAL_REPOSITORY_HOST_PROJECTION_FORMAT,
      schemaVersion: LOCAL_REPOSITORY_HOST_PROJECTION_SCHEMA_VERSION,
      status: this.getStatus(),
      revision: this.localDocument.revision,
      eventSeq: this.localDocument.eventSeq,
      commandSeq: this.commandCount(),
      gameTimeMs: engine.gameTimeMs,
      timeZone: engine.timeZone,
      advanceWhileEmpty: engine.advanceWhileEmpty,
      authority: {
        state: this.localDocument.authority.state,
        stamp: clone(this.localDocument.authority.stamp),
      },
      save: composeLocalRepositorySave(engine.save, this.localDocument.device),
      shared: clone(engine.save),
      device: clone(this.localDocument.device),
      runtime: {
        appInstanceId: this.localDocument.runtime.appInstanceId,
        startedAtWallMs: this.localDocument.runtime.startedAtWallMs,
        localDeviceId: this.localDeviceIdValue,
      },
    }
    this.lastProjectionValue = clone(projection)
    this.options.onStatus?.(clone(projection.status))
    this.options.onProjection?.(clone(projection), clone(events))
  }
}
