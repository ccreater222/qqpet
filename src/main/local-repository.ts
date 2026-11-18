import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { atomicWrite } from './atomic-write'
import { startSave } from '../shared/save-logic'
import { STORAGE_CONFIG_FILE, parseStorageConfig } from '../shared/storage'
import { sessionActivityForInterval } from '../shared/pet-runtime/coverage'
import type { CoverageReopen, CoverageSurvivor, EngineState, SessionCoverageInterval } from '../shared/pet-runtime/types'
import { orderedDomainEvent, type DomainEvent } from '../shared/pet-runtime/events'
import { advanceSchedulerChunk, CATCHUP_CHUNK_TICKS } from '../shared/pet-runtime/scheduler'
import {
  emptyOpIdCache, executeCommandIdempotent, migrateOpIdCache, validateOpIdCache, OP_ID_CACHE_SCHEMA_VERSION,
  validatePersistedRuntimeState, type IdempotencyRecord, type OpIdCache, type PersistedRuntimeState,
} from '../shared/pet-runtime/idempotency'
import type { CommandError, CommandRole, PetCommand } from '../shared/sync/protocol'
import type { RuntimeCommandContext, RuntimeOutcome } from '../shared/pet-runtime/runtime-types'
import type { SaveData } from '../shared/save'
import {
  composeSaveWithOverlay, mergeDeviceLocalOverlay, sanitizeDeviceLocalOverlayPatch,
  toDeviceLocalOverlay, type DeviceLocalOverlay, type DeviceLocalSettings,
  type SharedSaveData,
} from '../shared/sync/data-boundary'
import {
  assertLocalPetDocumentV2, backfillLegacyLocalPetDocumentDefaults, migrateLegacyLocalPetDocumentV2,
  migrateLegacySaveDataToPortableBundle, migratePortablePetBundle, validateRemoteProjectionCacheV2,
  LOCAL_DOCUMENT_FORMAT, LOCAL_DOCUMENT_SCHEMA_VERSION,
  type AuthorityStamp, type LocalEventHistoryEntry, type LocalPetDocumentV2, type PortablePetBundleV1,
} from '../shared/sync/portable'
import type { StorageBackupStatus, StorageMigrationStatus } from '../shared/storage'

export const LOCAL_REPOSITORY_ENV_FLAG = 'QQPET_LOCAL_REPOSITORY_V2'
export const LOCAL_V2_ACTIVE_ENV_FLAG = 'QQPET_LOCAL_V2_ACTIVE'
export const LOCAL_SCHEDULER_POLL_MS = 1000
export const LOCAL_COVERAGE_GRACE_MS = 60_000
const LOCAL_REPOSITORY_ACTIVATION_TOKEN = Symbol('local-repository-activation')

export type LocalRepositoryState = 'loading' | 'ready' | 'catching_up' | 'read_only' | 'handoff_pending' | 'suspended' | 'stopped'
export type LocalRepositoryRole = CommandRole

export interface LocalRepositoryStatus {
  mode: 'local'
  state: LocalRepositoryState
  offline: true
  role: LocalRepositoryRole
  readOnly: boolean
  catchingUp: boolean
  authorityState: 'active' | 'handoff_pending' | 'archived'
  revision: number
  eventSeq: number
  error?: string
}

export interface LocalPetProjection {
  format: 'qqpet-local-projection-v1'
  schemaVersion: 1
  status: LocalRepositoryStatus
  revision: number
  eventSeq: number
  gameTimeMs: number
  timeZone: string
  advanceWhileEmpty: boolean
  authority: { state: 'active' | 'handoff_pending' | 'archived'; stamp: AuthorityStamp }
  /** Renderer-ready shared state with the device overlay applied. */
  save: SaveData
  shared: SharedSaveData
  device: DeviceLocalOverlay
  runtime: { appInstanceId: string; startedAtWallMs: number; localDeviceId: string }
}

export interface LocalCommandResult {
  outcome: RuntimeOutcome
  events: LocalEventHistoryEntry[]
  projection: LocalPetProjection | null
  duplicate: boolean
}

export interface LocalRepositoryOptions {
  documentPath: string
  legacySavePath?: string
  legacyBackupPath?: string
  documentBackupPath?: string
  rollbackSnapshotPath?: string
  nowMs?: () => number
  randomUUID?: () => string
  seedHex?: string
  timeZone?: string
  localDeviceId?: string
  appInstanceId?: string
  advanceWhileEmpty?: boolean
  pollIntervalMs?: number
  maxChunkTicks?: number
  autoScheduler?: boolean
  initialSave?: unknown
  onProjection?: (projection: LocalPetProjection) => void
  onStatus?: (status: LocalRepositoryStatus) => void
  yieldToEventLoop?: () => Promise<void>
  writeDocument?: (file: string, text: string) => void
  startTimer?: (tick: () => void, intervalMs: number) => () => void
  /** Set true when the caller still owns the legacy authority; activation then fails closed. */
  legacyAuthorityActive?: boolean
  rendererCapability?: boolean
  authorityState?: 'legacy-active' | 'local-v2-active'
}

export interface LocalRepositoryCapability {
  flagEnabled: boolean
  canActivate: boolean
  activation: 'default-local-v2'
  reason?: 'flag_disabled' | 'renderer_capability_missing' | 'legacy_authority_active' | 'rollback_flag'
}

export function localRepositoryCapability(env: NodeJS.ProcessEnv = process.env, legacyAuthorityActive = false, rendererCapability = false): LocalRepositoryCapability {
  const legacyFlagDisabled = env[LOCAL_REPOSITORY_ENV_FLAG] === '0'
  const flagEnabled = localRepositoryEnabled(env)
  const activation = 'default-local-v2' as const
  if (legacyFlagDisabled) return { flagEnabled, canActivate: false, activation, reason: 'flag_disabled' }
  if (rendererCapability === false) return { flagEnabled, canActivate: false, activation, reason: 'renderer_capability_missing' }
  if (legacyAuthorityActive) return { flagEnabled, canActivate: false, activation, reason: 'legacy_authority_active' }
  return { flagEnabled, canActivate: true, activation }
}

export interface LocalImportOptions {
  opId?: string
  expectedAuthorityId?: string
  expectedRestoreGeneration?: number
  expectedEpoch?: number
  expectedRevision?: number
  expectedEventSeq?: number
}

interface LoadedDocument {
  document: LocalPetDocumentV2
  idempotency: OpIdCache
}
interface MutationContext {
  base: LocalPetDocumentV2
  survivors: CoverageSurvivor[]
  coverage: SessionCoverageInterval[]
}

function commandError(message: string, code: CommandError['code'] = 'invalid_payload'): RuntimeOutcome {
  return { ok: false, events: [], error: { code, message, refreshProjection: true } }
}

function cloneDocument(value: LocalPetDocumentV2): LocalPetDocumentV2 { return JSON.parse(JSON.stringify(value)) as LocalPetDocumentV2 }
function cloneProjection(value: LocalPetProjection): LocalPetProjection { return JSON.parse(JSON.stringify(value)) as LocalPetProjection }

export interface LocalDeviceOverlayPreviewOptions {
  documentPath: string
  legacySavePath?: string
  storageConfigPath?: string
}

function cloneDeviceOverlay(device: DeviceLocalOverlay): DeviceLocalOverlay {
  return JSON.parse(JSON.stringify(device)) as DeviceLocalOverlay
}

function storageModeForStartup(path: string): 'local' | 'server' {
  if (existsSync(path) === false) return 'local'
  try {
    return parseStorageConfig(JSON.parse(readFileSync(path, 'utf8')) as unknown).mode
  } catch {
    return 'local'
  }
}

/**
 * C7 startup: synchronously read only the device-local overlay so the first
 * window and its request headers use the persisted display/HD settings before
 * the asynchronous repository load finishes. In server mode save.json is the
 * RemoteProjectionCacheV2, not a legacy local save, so its validated device
 * overlay takes precedence over the archived local document. Local mode falls
 * back to a legacy save the repository would migrate on its first start. Never
 * mutates anything.
 */
export function readLocalDeviceOverlayPreview(options: LocalDeviceOverlayPreviewOptions): DeviceLocalOverlay | null {
  const directory = dirname(options.documentPath)
  const legacySavePath = options.legacySavePath ?? join(directory, 'save.json')
  const storageConfigPath = options.storageConfigPath ?? join(directory, STORAGE_CONFIG_FILE)
  try {
    if (storageModeForStartup(storageConfigPath) === 'server' && existsSync(legacySavePath)) {
      const cache = JSON.parse(readFileSync(legacySavePath, 'utf8')) as unknown
      if (validateRemoteProjectionCacheV2(cache) && cache.authority.state !== 'reset') {
        return cloneDeviceOverlay(cache.device)
      }
    }
    if (existsSync(options.documentPath)) {
      const parsed = JSON.parse(readFileSync(options.documentPath, 'utf8')) as unknown
      const loaded = normalizeLocalPetDocument(parsed)
      return cloneDeviceOverlay(loaded.document.device)
    }
    if (storageModeForStartup(storageConfigPath) === 'local' && existsSync(legacySavePath)) {
      const parsed = JSON.parse(readFileSync(legacySavePath, 'utf8')) as Record<string, unknown>
      return toDeviceLocalOverlay(startSave(parsed), 'startup-preview')
    }
  } catch {
    // The real loader owns recovery/error reporting; a preview must never block startup.
  }
  return null
}

export function normalizeLocalPetDocument(raw: unknown): LoadedDocument {
  let value = raw
  const record = value as Record<string, unknown> | null
  const runtime = record && typeof record.runtime === 'object' ? record.runtime as Record<string, unknown> : null
  if (runtime && 'localDeviceId' in runtime) value = migrateLegacyLocalPetDocumentV2(value)
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
  return {
    document: { ...document, idempotency, ...(eventHistory === undefined ? {} : { eventHistory }) },
    idempotency,
  }
}

export interface LocalRepositoryActivation {
  authorityState: 'legacy-active' | 'local-v2-active'
  rendererCapability: boolean
  env?: NodeJS.ProcessEnv
}

export function createLocalRepository(options: LocalRepositoryOptions, activation: LocalRepositoryActivation): LocalRepository {
  const env = activation.env ?? process.env
  const capability = localRepositoryCapability(env, activation.authorityState === 'legacy-active', activation.rendererCapability)
  if (capability.canActivate === false) throw new Error('local repository activation denied: ' + (capability.reason ?? 'unknown'))
  return new LocalRepository(options, LOCAL_REPOSITORY_ACTIVATION_TOKEN)
}

export class LocalRepository {
  private readonly options: Required<Pick<LocalRepositoryOptions, 'documentPath' | 'pollIntervalMs' | 'maxChunkTicks' | 'autoScheduler'>> & LocalRepositoryOptions
  private readonly now: () => number
  private readonly newUuid: () => string
  private localDocument: LocalPetDocumentV2 | null = null
  private idempotency: OpIdCache = emptyOpIdCache()
  private localDeviceIdValue = ''
  private state: LocalRepositoryState = 'loading'
  private role: LocalRepositoryRole = 'owner'
  private error: string | undefined
  private loaded = false
  private openCoverageId: string | undefined
  private schedulerTimer: (() => void) | undefined
  private queue: Promise<void> = Promise.resolve()
  private lastProjectionValue: LocalPetProjection | null = null
  private events: LocalEventHistoryEntry[] = []
  private lastReopenValue: CoverageReopen | undefined
  private stopped = false
  private appInstanceId = ''
  private detachRollback: LocalPetDocumentV2 | null = null
  private migrationStatus: StorageMigrationStatus = { state: 'unavailable' }
  private backupStatus: StorageBackupStatus = { available: false }
  private yieldToEventLoop: () => Promise<void>
  private startTimer: (tick: () => void, intervalMs: number) => () => void

  constructor(options: LocalRepositoryOptions, activationToken: symbol) {
    if (activationToken !== LOCAL_REPOSITORY_ACTIVATION_TOKEN) throw new Error('LocalRepository activation token required')
    if (typeof options.documentPath !== 'string' || options.documentPath.length === 0) throw new Error('LocalRepository documentPath is required')
    this.options = {
      ...options,
      pollIntervalMs: options.pollIntervalMs ?? LOCAL_SCHEDULER_POLL_MS,
      maxChunkTicks: options.maxChunkTicks ?? CATCHUP_CHUNK_TICKS,
      autoScheduler: options.autoScheduler ?? true,
    }
    this.now = options.nowMs ?? (() => Date.now())
    this.newUuid = options.randomUUID ?? randomUUID
    this.yieldToEventLoop = options.yieldToEventLoop ?? (() => new Promise<void>(resolve => { setTimeout(resolve, 0) }))
    this.startTimer = options.startTimer ?? ((tick, intervalMs) => {
      const handle = setInterval(tick, intervalMs)
      if (typeof handle.unref === 'function') handle.unref()
      return () => clearInterval(handle)
    })
    if (Number.isSafeInteger(this.options.pollIntervalMs) === false || this.options.pollIntervalMs <= 0) throw new Error('pollIntervalMs must be a positive safe integer')
    if (Number.isSafeInteger(this.options.maxChunkTicks) === false || this.options.maxChunkTicks <= 0) throw new Error('maxChunkTicks must be a positive safe integer')
  }

  get currentDeviceId(): string { return this.localDeviceIdValue }
  private isReadOnly(): boolean {
    return this.state === 'read_only' || this.state === 'handoff_pending' || this.state === 'stopped' || this.state === 'loading' || this.localDocument === null || this.localDocument.authority.state !== 'active' || this.localDocument.authority.stamp.owner !== 'local'
  }
  get lastReopen(): CoverageReopen | undefined { return this.lastReopenValue === undefined ? undefined : JSON.parse(JSON.stringify(this.lastReopenValue)) as CoverageReopen }
  private hasActiveAuthority(): boolean {
    return this.localDocument !== null && this.localDocument.authority.state === 'active' && this.localDocument.authority.stamp.owner === 'local'
  }
  private findCached(opId: string): boolean {
    return this.idempotency.records.some(record => record.petId === this.localDeviceIdValue && record.deviceId === this.localDeviceIdValue && record.opId === opId)
  }
  private importRecord(opId: string, stamp: AuthorityStamp): IdempotencyRecord {
    return {
      petId: this.localDeviceIdValue, deviceId: this.localDeviceIdValue, opId,
      commandType: 'admin.importPortableBundle', resultPresent: true,
      result: { authorityId: stamp.authorityId, epoch: stamp.epoch, revision: stamp.revision, eventSeq: stamp.eventSeq },
    }
  }
  getStatus(): LocalRepositoryStatus {
    return {
      mode: 'local', state: this.state, offline: true, role: this.role,
      readOnly: this.isReadOnly(), catchingUp: this.state === 'catching_up',
      authorityState: this.localDocument?.authority.state ?? 'active',
      revision: this.localDocument?.revision ?? 0, eventSeq: this.localDocument?.eventSeq ?? 0,
      ...(this.error === undefined ? {} : { error: this.error }),
    }
  }
  getProjection(): LocalPetProjection | null { return this.lastProjectionValue === null ? null : cloneProjection(this.lastProjectionValue) }
  getDocument(): LocalPetDocumentV2 | null { return this.localDocument === null ? null : JSON.parse(JSON.stringify(this.localDocument)) as LocalPetDocumentV2 }
  getRecentEvents(): LocalEventHistoryEntry[] { return JSON.parse(JSON.stringify(this.events)) as LocalEventHistoryEntry[] }
  getMigrationStatus(): StorageMigrationStatus { return JSON.parse(JSON.stringify(this.migrationStatus)) as StorageMigrationStatus }
  getBackupStatus(): StorageBackupStatus {
    const fallback = this.options.documentBackupPath || this.options.documentPath + '.bak'
    const path = this.backupStatus.path ?? fallback
    return {
      ...this.backupStatus,
      available: existsSync(path),
      path,
    }
  }

  /** Writes the current committed document to the backup slot before a destructive replacement. */
  createBackup(reason: 'import' | 'manual' | 'mode_switch' = 'manual'): string | null {
    if (this.localDocument === null) return null
    const base = this.options.documentBackupPath || this.options.documentPath + '.bak'
    const target = reason === 'import' ? base : base.replace(/\.bak$/, '.' + reason + '.bak')
    this.writeDocumentAt(target, this.localDocument)
    this.backupStatus = { available: true, path: target, reason, createdAtWallMs: this.now() }
    return target
  }

  async load(): Promise<LocalPetProjection | null> {
    if (this.loaded) return this.getProjection()
    try {
      const loaded = this.loadOrMigrate()
      this.localDocument = loaded.document
      this.idempotency = loaded.idempotency
      this.localDeviceIdValue = loaded.document.device.localDeviceId
      this.events = (loaded.document.eventHistory ?? [])
        .filter(event => event.eventSeq <= loaded.document.eventSeq)
        .map(event => ({
          ...event,
          revision: event.revision ?? loaded.document.revision,
          gameTimeMs: event.gameTimeMs ?? loaded.document.bundle.engine.gameTimeMs,
        }))
        .slice(-512)
      this.loaded = true
      if (loaded.document.authority.state !== 'active' || loaded.document.authority.stamp.owner !== 'local') {
        if (loaded.document.authority.state === 'handoff_pending') this.detachRollback = this.loadDetachRollback()
        this.state = 'read_only'
        this.error = 'authority_not_active'
        this.emitProjection()
        return this.getProjection()
      }

      this.repairCoverage(this.now(), 'crash_repaired')
      if (loaded.document.bundle.engine.advanceWhileEmpty === false && loaded.document.bundle.engine.lastSchedulerWallMs < this.now()) {
        loaded.document.bundle.engine.lastSchedulerWallMs = this.now()
      }
      this.openCoverage(this.now())
      this.syncAuthority(this.now())
      this.persist()
      this.state = 'ready'
      this.emitProjection()
      await this.catchUp(this.now())
      return this.getProjection()
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      this.state = 'read_only'
      this.emitProjection()
      return null
    }
  }

  /**
   * C11: load the local v2 document without becoming the running authority.
   * Used while server mode owns canonical state; the scheduler stays stopped and
   * the projection is served read-only until a validated import replaces it.
   */
  async loadFenced(): Promise<LocalPetProjection | null> {
    return this.enqueue(() => this.loadFencedNow())
  }

  private async loadFencedNow(): Promise<LocalPetProjection | null> {
    if (this.stopped) throw new Error('LocalRepository has been stopped')
    if (this.loaded) {
      this.stopScheduler()
      this.state = 'read_only'
      this.error = 'authority_fenced'
      this.emitProjection()
      return this.getProjection()
    }
    try {
      const loaded = this.loadOrMigrate()
      this.localDocument = loaded.document
      this.idempotency = loaded.idempotency
      this.localDeviceIdValue = loaded.document.device.localDeviceId
      this.events = (loaded.document.eventHistory ?? [])
        .filter(event => event.eventSeq <= loaded.document.eventSeq)
        .map(event => ({
          ...event,
          revision: event.revision ?? loaded.document.revision,
          gameTimeMs: event.gameTimeMs ?? loaded.document.bundle.engine.gameTimeMs,
        }))
        .slice(-512)
      this.loaded = true
      if (loaded.document.authority.state === 'handoff_pending') this.detachRollback = this.loadDetachRollback()
      this.stopScheduler()
      this.state = 'read_only'
      this.error = 'authority_fenced'
      this.emitProjection()
      return this.getProjection()
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      this.state = 'read_only'
      this.emitProjection()
      return null
    }
  }

  /**
   * C11 "use server pet": archive the local authority without an upload. The
   * cache is backed up first and the scheduler never ticks while archived.
   */
  archiveAuthority(reason: 'use_server' | 'mode_switch' = 'use_server'): Promise<LocalPetProjection | null> {
    return this.enqueue(async () => {
      if (this.localDocument === null) {
        if (this.loaded) return this.getProjection()
        const loadedProjection = await this.loadFencedNow()
        if (loadedProjection === null || this.localDocument === null) return loadedProjection
      }
      const document = this.localDocument
      if (document === null) return null
      if (document.authority.state === 'archived') {
        this.stopScheduler()
        this.state = 'read_only'
        this.emitProjection()
        return this.getProjection()
      }
      this.createBackup(reason === 'use_server' ? 'mode_switch' : reason)
      const candidate = cloneDocument(document)
      const at = this.now()
      this.closeAllOpenCoverageOn(candidate, at, 'authority_handoff')
      candidate.authority.state = 'archived'
      this.syncAuthorityOn(candidate, at)
      this.persistCandidate(candidate)
      this.localDocument = candidate
      this.idempotency = candidate.idempotency ?? this.idempotency
      this.openCoverageId = undefined
      this.detachRollback = null
      this.stopScheduler()
      this.state = 'read_only'
      this.error = undefined
      this.emitProjection()
      return this.getProjection()
    })
  }

  pump(): Promise<void> { return this.enqueue(async () => { await this.pollScheduler() }) }

  async start(): Promise<LocalPetProjection | null> {
    return this.enqueue(async () => {
      if (this.stopped) throw new Error('LocalRepository has been stopped')
      const projection = await this.load()
      if (projection === null) return null
      if (this.isReadOnly() === false) this.startScheduler()
      return this.getProjection()
    })
  }

  async flush(): Promise<void> {
    await this.queue
    if (this.localDocument !== null && this.isReadOnly() === false && this.state !== 'stopped') this.persist()
  }

  async stop(): Promise<void> {
    return this.enqueue(async () => {
      if (this.stopped) return
      if (this.localDocument !== null && this.isReadOnly() === false) {
        const candidate = cloneDocument(this.localDocument)
        const at = this.now()
        this.touchCoverageOn(candidate, at)
        this.closeOpenCoverageOn(candidate, at, 'app_shutdown')
        this.syncAuthorityOn(candidate, at)
        this.persistCandidate(candidate)
        this.localDocument = candidate
        this.idempotency = candidate.idempotency ?? this.idempotency
      }
      this.stopped = true
      this.stopScheduler()
      this.state = 'stopped'
      this.emitProjection()
    })
  }

  isSchedulerRunning(): boolean { return this.schedulerTimer !== undefined }
  private startScheduler(): void {
    if (this.stopped || this.isReadOnly() || this.options.autoScheduler === false || this.schedulerTimer !== undefined) return
    this.schedulerTimer = this.startTimer(() => { void this.pump() }, this.options.pollIntervalMs)
  }
  private stopScheduler(): void {
    if (this.schedulerTimer !== undefined) { this.schedulerTimer(); this.schedulerTimer = undefined }
  }

  setRole(role: LocalRepositoryRole): LocalRepositoryStatus { this.role = role; this.emitProjection(); return this.getStatus() }

  setAdvanceWhileEmpty(enabled: boolean): Promise<LocalPetProjection | null> {
    return this.enqueue(async () => {
      if (this.localDocument === null || this.isReadOnly()) throw new Error('local repository is read-only')
      const candidate = cloneDocument(this.localDocument)
      candidate.bundle.engine.advanceWhileEmpty = enabled
      this.persistCandidate(candidate)
      this.localDocument = candidate
      this.emitProjection()
      return this.getProjection()
    })
  }

  setLocalSettings(patch: Partial<DeviceLocalSettings>): Promise<LocalPetProjection | null> {
    return this.updateDeviceOverlay({ settings: patch })
  }

  /** Device-only position/settings/presentation update; canonical gameplay never changes. */
  updateDeviceOverlay(value: unknown): Promise<LocalPetProjection | null> {
    return this.enqueue(async () => {
      if (this.localDocument === null || this.isReadOnly()) throw new Error('local repository is read-only')
      const patch = sanitizeDeviceLocalOverlayPatch(value)
      const candidate = cloneDocument(this.localDocument)
      candidate.device = mergeDeviceLocalOverlay(candidate.device, patch)
      this.syncAuthorityOn(candidate, this.now())
      this.persistCandidate(candidate)
      this.localDocument = candidate
      this.emitProjection()
      return this.getProjection()
    })
  }

  getDeviceOverlay(): DeviceLocalOverlay | null {
    return this.localDocument === null ? null : JSON.parse(JSON.stringify(this.localDocument.device)) as DeviceLocalOverlay
  }

  command(command: PetCommand, opId: string, role: LocalRepositoryRole = 'owner'): Promise<LocalCommandResult> {
    return this.enqueue(() => this.executeCommandNow(command, opId, role))
  }

  reset(opId: string = this.newUuid()): Promise<LocalCommandResult> {
    return this.enqueue(async () => {
      if (this.localDocument === null || this.isReadOnly()) return { outcome: commandError('local repository is read-only', 'not_available'), events: [], projection: this.getProjection(), duplicate: false }
      if (this.findCached(opId)) return this.executeCommandNow({ type: 'pet.reset', payload: {} }, opId, 'owner')
      const mutation = this.prepareMutation('pet_reset')
      return this.executeCommandNow({ type: 'pet.reset', payload: {} }, opId, 'owner', mutation)
    })
  }

  exportPortableBundle(): PortablePetBundleV1 | null {
    if (this.localDocument === null) return null
    this.syncAuthority(this.now())
    return JSON.parse(JSON.stringify(this.localDocument.bundle)) as PortablePetBundleV1
  }

  async exportForDetach(incomingEpoch: number = 0): Promise<PortablePetBundleV1> {
    return this.enqueue(async () => {
      if (this.stopped || this.state === 'stopped') throw new Error('local repository is stopped')
      if (this.localDocument === null || this.hasActiveAuthority() === false) throw new Error('authority_not_active')
      if (Number.isSafeInteger(incomingEpoch) === false || incomingEpoch < 0) throw new Error('incomingEpoch must be a non-negative safe integer')
      const previous = cloneDocument(this.localDocument)
      const candidate = cloneDocument(this.localDocument)
      const at = this.now()
      this.closeAllOpenCoverageOn(candidate, at, 'authority_handoff')
      candidate.authority.stamp.epoch = Math.max(candidate.authority.stamp.epoch, incomingEpoch) + 1
      // Every new handoff attempt gets a fresh idempotency identity. A
      // definitive rejection records the old opId in the server command log;
      // retrying that rejected op would be an op_id_conflict even though the
      // local rollback restored a writable authority.
      candidate.authority.stamp.handoffId = this.newUuid()
      candidate.authority.stamp.detachedAtWallMs = at
      candidate.authority.state = 'handoff_pending'
      candidate.revision += 1
      this.syncAuthorityOn(candidate, at)
      this.writeDocumentAt(this.rollbackSnapshotPath(), previous)
      this.persistCandidate(candidate)
      this.stopScheduler()
      this.localDocument = candidate
      this.idempotency = candidate.idempotency ?? this.idempotency
      this.detachRollback = previous
      this.state = 'handoff_pending'
      this.openCoverageId = undefined
      this.emitProjection()
      return JSON.parse(JSON.stringify(candidate.bundle)) as PortablePetBundleV1
    })
  }

  async rollbackDetach(): Promise<LocalPetProjection | null> {
    return this.enqueue(async () => {
      if (this.stopped || this.state === 'stopped') throw new Error('local repository is stopped')
      if (this.localDocument === null || this.localDocument.authority.state !== 'handoff_pending') return this.getProjection()
      if (this.detachRollback === null) this.detachRollback = this.loadDetachRollback()
      if (this.detachRollback === null) return this.getProjection()
      const restored = cloneDocument(this.detachRollback)
      if (restored.authority.state !== 'active' || restored.authority.stamp.owner !== 'local') {
        throw new Error('authority_not_active: rollback snapshot did not restore a local active authority')
      }
      this.persistCandidate(restored)
      this.localDocument = restored
      this.idempotency = restored.idempotency ?? this.idempotency
      this.openCoverageId = restored.bundle.engine.sessionCoverage.find(interval => interval.disconnectedAtWallMs === undefined)?.coverageId
      this.detachRollback = null
      this.state = 'ready'
      this.error = undefined
      this.startScheduler()
      this.emitProjection()
      return this.getProjection()
    })
  }

  async importPortableBundle(value: PortablePetBundleV1 | string, options: string | LocalImportOptions = {}): Promise<LocalPetProjection | null> {
    const opts: LocalImportOptions = typeof options === 'string' ? { opId: options } : options
    const opId = opts.opId ?? this.newUuid()
    return this.enqueue(async () => {
      if (this.localDocument === null || this.state === 'stopped' || this.state === 'loading') throw new Error('local repository is not active')
      if (this.findCached(opId)) return this.getProjection()
      const priorState = this.state
      const activeBefore = this.localDocument.authority.state === 'active' && this.localDocument.authority.stamp.owner === 'local'
      try {
        const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value
        const bundle = migratePortablePetBundle(parsed)
        const incoming = bundle.authority
        if (incoming.owner === 'server') {
          if (opts.expectedAuthorityId === undefined || opts.expectedRestoreGeneration === undefined || opts.expectedEpoch === undefined || opts.expectedRevision === undefined || opts.expectedEventSeq === undefined) throw new Error('invalid_payload: handoff import requires exact authority fields')
        }
        if (bundle.originLocalDeviceId !== undefined && bundle.originLocalDeviceId !== this.localDeviceIdValue) throw new Error('identity_mismatch: originLocalDeviceId')
        if (opts.expectedAuthorityId !== undefined && incoming.authorityId !== opts.expectedAuthorityId) throw new Error('identity_mismatch: authorityId')
        if (opts.expectedRestoreGeneration !== undefined && incoming.restoreGeneration !== opts.expectedRestoreGeneration) throw new Error('identity_mismatch: restoreGeneration')
        if (opts.expectedEpoch !== undefined && incoming.epoch !== opts.expectedEpoch) throw new Error('identity_mismatch: epoch')
        if (opts.expectedRevision !== undefined && incoming.revision !== opts.expectedRevision) throw new Error('identity_mismatch: revision')
        if (opts.expectedEventSeq !== undefined && incoming.eventSeq !== opts.expectedEventSeq) throw new Error('identity_mismatch: eventSeq')
        const currentStamp = this.localDocument.authority.stamp
        if (incoming.owner === 'local' && incoming.authorityId !== currentStamp.authorityId) throw new Error('identity_mismatch: local authorityId')

        const stamp: AuthorityStamp = {
          owner: 'local',
          authorityId: incoming.owner === 'server' ? incoming.authorityId : currentStamp.authorityId,
          epoch: Math.max(currentStamp.epoch, incoming.epoch) + 1,
          restoreGeneration: incoming.owner === 'server' ? incoming.restoreGeneration : Math.max(currentStamp.restoreGeneration, incoming.restoreGeneration),
          revision: incoming.revision, eventSeq: incoming.eventSeq,
          handoffId: incoming.handoffId || currentStamp.handoffId,
          detachedAtWallMs: incoming.detachedAtWallMs,
        }
        const at = this.now()
        const candidate = cloneDocument(this.localDocument)
        const survivors = this.captureSurvivorsOn(candidate, 'import_replaced', at)
        this.closeAllOpenCoverageOn(candidate, at, 'import_replaced')

        const importedEngine = JSON.parse(JSON.stringify(bundle.engine)) as EngineState
        const hostCoverage: SessionCoverageInterval = {
          coverageId: this.newUuid(), deviceId: this.localDeviceIdValue,
          connectedAtWallMs: at, lastHeartbeatWallMs: at,
        }
        importedEngine.sessionCoverage = [...importedEngine.sessionCoverage, hostCoverage]
        importedEngine.coverageReopen = { operationId: this.newUuid(), commitWallMs: at, survivors, state: 'pending' }
        candidate.bundle = {
          ...bundle, originLocalDeviceId: bundle.originLocalDeviceId || this.localDeviceIdValue,
          engine: importedEngine, shared: importedEngine.save, authority: stamp, exportedAtWallMs: at,
        }
        candidate.authority = { state: 'active', stamp }
        candidate.revision = stamp.revision
        candidate.eventSeq = stamp.eventSeq
        candidate.eventHistory = []
        candidate.idempotency = {
          schemaVersion: OP_ID_CACHE_SCHEMA_VERSION,
          records: [this.importRecord(opId, stamp)],
        }

        this.backup(this.options.documentBackupPath || this.options.documentPath + '.bak', this.options.documentPath)
        this.persistCandidate(candidate)
        this.localDocument = candidate
        this.idempotency = candidate.idempotency ?? emptyOpIdCache()
        this.openCoverageId = hostCoverage.coverageId
        this.lastReopenValue = importedEngine.coverageReopen
        this.events = (candidate.eventHistory ?? []).slice(-512)
        this.state = 'ready'
        this.error = undefined
        this.startScheduler()
        this.emitProjection()
        return this.getProjection()
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
        const stillActive = this.localDocument !== null
          && this.localDocument.authority.state === 'active'
          && this.localDocument.authority.stamp.owner === 'local'
        this.state = activeBefore && stillActive ? priorState : 'read_only'
        if (this.state === 'read_only') this.stopScheduler()
        this.emitProjection()
        return null
      }
    })
  }

  suspend(): Promise<LocalPetProjection | null> {
    return this.enqueue(async () => {
      if (this.localDocument === null || this.isReadOnly() || this.state === 'stopped') throw new Error('local repository is read-only')
      const candidate = cloneDocument(this.localDocument)
      const at = this.now()
      const open = candidate.bundle.engine.sessionCoverage.find(item => item.coverageId === this.openCoverageId)
      const pendingReopen = candidate.bundle.engine.coverageReopen?.state === 'pending'
      const closeAt = pendingReopen || open === undefined ? at : Math.min(at, open.lastHeartbeatWallMs + LOCAL_COVERAGE_GRACE_MS)
      const survivors = this.captureSurvivorsOn(candidate, 'suspend', closeAt)
      this.closeOpenCoverageOn(candidate, closeAt, 'suspend')
      const marker: CoverageReopen = { operationId: this.newUuid(), commitWallMs: closeAt, survivors, state: 'suspended', suspendedAtWallMs: at }
      candidate.bundle.engine.coverageReopen = marker
      this.syncAuthorityOn(candidate, at)
      this.persistCandidate(candidate)
      this.stopScheduler()
      this.localDocument = candidate
      this.idempotency = candidate.idempotency ?? this.idempotency
      this.lastReopenValue = marker
      this.openCoverageId = undefined
      this.state = 'suspended'
      this.error = undefined
      this.emitProjection()
      return this.getProjection()
    })
  }

  resume(): Promise<LocalPetProjection | null> {
    return this.enqueue(async () => {
      if (this.localDocument === null || this.isReadOnly() || this.state === 'stopped') return this.getProjection()
      if (this.state !== 'suspended') return this.getProjection()
      const candidate = cloneDocument(this.localDocument)
      const at = this.now()
      if (candidate.bundle.engine.coverageReopen !== undefined) {
        this.lastReopenValue = candidate.bundle.engine.coverageReopen
        delete candidate.bundle.engine.coverageReopen
      }
      const coverageId = this.openCoverageOn(candidate, at)
      this.touchCoverageOn(candidate, at, coverageId)
      this.syncAuthorityOn(candidate, at)
      this.persistCandidate(candidate)
      this.localDocument = candidate
      this.idempotency = candidate.idempotency ?? this.idempotency
      this.openCoverageId = coverageId
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

  private executeCommandNow(command: PetCommand, opId: string, role: LocalRepositoryRole, mutation?: MutationContext): LocalCommandResult {
    if (this.localDocument === null || this.isReadOnly()) return { outcome: commandError('local repository is read-only', 'not_available'), events: [], projection: this.getProjection(), duplicate: false }
    if (this.state !== 'ready' && this.state !== 'suspended') return { outcome: commandError('local repository is catching up', 'server_catching_up'), events: [], projection: this.getProjection(), duplicate: false }
    const at = this.now()
    const candidate = mutation ? cloneDocument(mutation.base) : cloneDocument(this.localDocument)
    this.touchCoverageOn(candidate, at)
    const engine = candidate.bundle.engine
    const idempotentDocument: PersistedRuntimeState = { schemaVersion: 2, engine, idempotency: candidate.idempotency ?? emptyOpIdCache() }

    const ctx: RuntimeCommandContext = {
      gameTimeMs: engine.gameTimeMs, environment: engine.environment, activeClientCount: 1, sessionActive: true,
      actorDeviceId: this.localDeviceIdValue, actorRole: role, wallNowMs: at,
    }
    const result = executeCommandIdempotent(this.localDeviceIdValue, this.localDeviceIdValue, idempotentDocument, command, ctx, opId)
    if (result.duplicate) return { outcome: result.outcome, events: [], projection: this.getProjection(), duplicate: true }
    const accepted = result.outcome.ok
    const eventStart = candidate.eventSeq
    candidate.revision = accepted ? this.localDocument.revision + 1 : this.localDocument.revision
    candidate.bundle.engine = result.document.engine
    candidate.bundle.shared = result.document.engine.save
    candidate.idempotency = result.document.idempotency
    const commandSeq = candidate.idempotency.records.findIndex(record =>
      record.petId === this.localDeviceIdValue && record.deviceId === this.localDeviceIdValue && record.opId === opId) + 1
    const ordered: LocalEventHistoryEntry[] = accepted
      ? result.outcome.events.map((event: DomainEvent, index: number) => ({
          ...orderedDomainEvent(eventStart + index + 1, event),
          revision: candidate.revision,
          gameTimeMs: candidate.bundle.engine.gameTimeMs,
          ...(commandSeq > 0 ? { commandSeq } : {}),
        }))
      : []
    candidate.eventSeq = eventStart + ordered.length
    let openedCoverageId: string | undefined
    let reopenMarker: CoverageReopen | undefined
    if (mutation !== undefined && accepted) {
      candidate.bundle.engine.sessionCoverage = [...mutation.coverage]
      openedCoverageId = this.openCoverageOn(candidate, at)
      reopenMarker = { operationId: this.newUuid(), commitWallMs: at, survivors: mutation.survivors, state: 'pending' }
      candidate.bundle.engine.coverageReopen = reopenMarker
    }
    candidate.eventHistory = [...this.events, ...ordered].slice(-512)
    this.syncAuthorityOn(candidate, at)
    try {
      this.persistCandidate(candidate)
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      return { outcome: commandError('local persistence failed', 'internal'), events: [], projection: this.getProjection(), duplicate: false }
    }
    this.localDocument = candidate
    this.idempotency = candidate.idempotency ?? emptyOpIdCache()
    if (openedCoverageId !== undefined) this.openCoverageId = openedCoverageId
    if (reopenMarker !== undefined) this.lastReopenValue = reopenMarker
    if (accepted && ordered.length > 0) this.events.push(...ordered)
    this.events = (candidate.eventHistory ?? this.events).slice(-512)
    this.emitProjection()
    return { outcome: result.outcome, events: ordered, projection: this.getProjection(), duplicate: false }
  }

  private loadOrMigrate(): LoadedDocument {
    const documentPath = this.options.documentPath
    if (existsSync(documentPath)) {
      const text = readFileSync(documentPath, 'utf8')
      let raw: unknown
      try { raw = JSON.parse(text) } catch (error) {
        this.backup(this.options.documentBackupPath || documentPath + '.bak', documentPath)
        throw new Error('local document is not valid JSON: ' + String(error))
      }
      const loaded = normalizeLocalPetDocument(raw)
      const rawRecord = raw as Record<string, unknown>
      const rawAuthority = rawRecord.authority as Record<string, unknown> | null
      const rawStamp = rawAuthority && typeof rawAuthority.stamp === 'object' ? rawAuthority.stamp as Record<string, unknown> : null
      this.migrationStatus = { state: 'native_v2', source: 'save.v2.json' }
      if (rawAuthority === null || rawAuthority.state !== 'active' || rawStamp === null || rawStamp.owner !== 'local') return loaded
      const runtime = rawRecord.runtime as Record<string, unknown> | null
      const duplicateIdentity = runtime !== null && typeof runtime === 'object' && 'localDeviceId' in runtime
      const missingIdempotency = rawRecord.idempotency === undefined
      const missingEventMetadata = Array.isArray(rawRecord.eventHistory) && rawRecord.eventHistory.some(event => {
        const record = event as Record<string, unknown> | null
        return record === null || typeof record !== 'object' || record.revision === undefined || record.gameTimeMs === undefined
      })
      if (duplicateIdentity || missingIdempotency || missingEventMetadata) {
        this.backup(this.options.documentBackupPath || documentPath + '.bak', documentPath)
        this.writeDocument(loaded.document)
        this.migrationStatus = {
          state: 'migrated_v2',
          source: 'save.v2.json',
          backupPath: this.options.documentBackupPath || documentPath + '.bak',
          migratedAtWallMs: this.now(),
        }
        this.backupStatus = { available: true, path: this.migrationStatus.backupPath, reason: 'migration', createdAtWallMs: this.now() }
      }
      this.appInstanceId = this.options.appInstanceId || this.newUuid()
      loaded.document.runtime = { appInstanceId: this.appInstanceId, startedAtWallMs: this.now() }
      loaded.document.bundle.originLocalDeviceId = loaded.document.device.localDeviceId
      return loaded
    }
    const legacyPath = this.options.legacySavePath
    if (legacyPath !== undefined && existsSync(legacyPath)) {
      const text = readFileSync(legacyPath, 'utf8')
      let raw: unknown
      try { raw = JSON.parse(text) as unknown } catch (error) {
        this.backup(this.options.legacyBackupPath || legacyPath + '.bak', legacyPath)
        throw new Error('legacy save is not valid JSON: ' + String(error))
      }
      const legacyBackup = this.options.legacyBackupPath || legacyPath + '.bak'
      this.backup(legacyBackup, legacyPath)
      this.migrationStatus = {
        state: 'migrated_legacy',
        source: 'save.json',
        backupPath: legacyBackup,
        migratedAtWallMs: this.now(),
      }
      this.backupStatus = { available: true, path: legacyBackup, reason: 'migration', createdAtWallMs: this.now() }
      return this.migrateLegacy(raw)
    }
    this.migrationStatus = { state: 'fresh', migratedAtWallMs: this.now() }
    if (this.options.initialSave !== undefined) return this.migrateLegacy(this.options.initialSave)
    return this.migrateLegacy(startSave(null))
  }

  private migrateLegacy(raw: unknown): LoadedDocument {
    const now = this.now()
    const localDeviceId = this.options.localDeviceId || this.newUuid()
    const authority: AuthorityStamp = {
      owner: 'local', authorityId: this.newUuid(), epoch: 1, restoreGeneration: 1,
      revision: 0, eventSeq: 0, handoffId: this.newUuid(), detachedAtWallMs: 0,
    }
    const bundle = migrateLegacySaveDataToPortableBundle(raw, {
      nowMs: now, localDeviceId,
      timeZone: this.options.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
      seedHex: this.options.seedHex || randomBytes(16).toString('hex'),
      authority, advanceWhileEmpty: this.options.advanceWhileEmpty !== false,
    })
    const save = startSave(raw as Record<string, unknown> | null)
    const device = toDeviceLocalOverlay(save, localDeviceId)
    this.appInstanceId = this.options.appInstanceId || this.newUuid()
    const document: LocalPetDocumentV2 = {
      format: LOCAL_DOCUMENT_FORMAT, schemaVersion: LOCAL_DOCUMENT_SCHEMA_VERSION,
      revision: authority.revision, eventSeq: authority.eventSeq,
      authority: { state: 'active', stamp: authority }, bundle,
      runtime: { appInstanceId: this.appInstanceId, startedAtWallMs: now },
      device, idempotency: emptyOpIdCache(),
    }
    assertLocalPetDocumentV2(document)
    this.writeDocument(document)
    this.localDeviceIdValue = localDeviceId
    return normalizeLocalPetDocument(document)
  }

  private repairCoverage(now: number, reason: 'crash_repaired' | 'app_shutdown'): void {
    if (this.localDocument === null) return
    for (const interval of this.localDocument.bundle.engine.sessionCoverage) {
      if (interval.disconnectedAtWallMs !== undefined) continue
      const end = Math.min(now, interval.lastHeartbeatWallMs + LOCAL_COVERAGE_GRACE_MS)
      interval.disconnectedAtWallMs = Math.max(interval.connectedAtWallMs, end)
      interval.lastHeartbeatWallMs = Math.max(interval.lastHeartbeatWallMs, interval.disconnectedAtWallMs)
      interval.closeReason = reason
    }
    this.openCoverageId = undefined
  }

  private openCoverage(at: number): void {
    if (this.localDocument === null) return
    this.openCoverageId = this.openCoverageOn(this.localDocument, at)
  }
  private openCoverageOn(document: LocalPetDocumentV2, at: number): string {
    const coverage: SessionCoverageInterval = { coverageId: this.newUuid(), deviceId: this.localDeviceIdValue, connectedAtWallMs: at, lastHeartbeatWallMs: at }
    document.bundle.engine.sessionCoverage.push(coverage)
    return coverage.coverageId
  }
  private touchCoverage(at: number): void {
    if (this.localDocument !== null) this.touchCoverageOn(this.localDocument, at)
  }
  private touchCoverageOn(document: LocalPetDocumentV2, at: number, coverageId: string | undefined = this.openCoverageId): void {
    if (coverageId === undefined) return
    const interval = document.bundle.engine.sessionCoverage.find(item => item.coverageId === coverageId)
    if (interval !== undefined && interval.lastHeartbeatWallMs < at) interval.lastHeartbeatWallMs = at
  }
  private closeOpenCoverageOn(document: LocalPetDocumentV2, at: number, reason: 'app_shutdown' | 'suspend' | 'pet_reset' | 'import_replaced' | 'authority_handoff', coverageId: string | undefined = this.openCoverageId): void {
    if (coverageId === undefined) return
    const interval = document.bundle.engine.sessionCoverage.find(item => item.coverageId === coverageId)
    if (interval !== undefined) {
      interval.disconnectedAtWallMs = Math.max(interval.connectedAtWallMs, at)
      interval.lastHeartbeatWallMs = Math.max(interval.lastHeartbeatWallMs, interval.disconnectedAtWallMs)
      interval.closeReason = reason
    }
  }
  private closeAllOpenCoverageOn(document: LocalPetDocumentV2, at: number, reason: 'authority_handoff' | 'import_replaced'): SessionCoverageInterval[] {
    for (const interval of document.bundle.engine.sessionCoverage) {
      if (interval.disconnectedAtWallMs !== undefined) continue
      interval.disconnectedAtWallMs = Math.max(interval.connectedAtWallMs, at)
      interval.lastHeartbeatWallMs = Math.max(interval.lastHeartbeatWallMs, interval.disconnectedAtWallMs)
      interval.closeReason = reason
    }
    return document.bundle.engine.sessionCoverage
  }
  private captureSurvivorsOn(document: LocalPetDocumentV2, reason: 'suspend' | 'pet_reset' | 'import_replaced', at: number): CoverageSurvivor[] {
    const open = document.bundle.engine.sessionCoverage.find(item => (this.openCoverageId === undefined || item.coverageId === this.openCoverageId) && item.disconnectedAtWallMs === undefined)
    if (open === undefined) return []
    return [{ kind: 'local_app', appInstanceId: document.runtime.appInstanceId, localDeviceId: this.localDeviceIdValue, lastHeartbeatWallMs: open.lastHeartbeatWallMs, eligible: true, activeEndWallMs: at, activeEndProvenance: reason }]
  }
  private prepareMutation(reason: 'pet_reset' | 'import_replaced'): MutationContext {
    const base = cloneDocument(this.localDocument as LocalPetDocumentV2)
    const at = this.now()
    this.touchCoverageOn(base, at)
    const survivors = this.captureSurvivorsOn(base, reason, at)
    this.closeOpenCoverageOn(base, at, reason)
    const coverage = JSON.parse(JSON.stringify(base.bundle.engine.sessionCoverage)) as SessionCoverageInterval[]
    return { base, survivors, coverage }
  }
  private async catchUp(target: number): Promise<void> {
    if (this.localDocument === null || this.isReadOnly()) return
    const anchor = this.localDocument.bundle.engine.lastSchedulerWallMs
    if (target <= anchor) return
    let rounds = 0
    this.state = 'catching_up'
    this.emitProjection()
    while (this.localDocument.bundle.engine.lastSchedulerWallMs < target && rounds++ < 100000) {
      const candidate = cloneDocument(this.localDocument)
      const current = candidate.bundle.engine
      const ctx: RuntimeCommandContext = { gameTimeMs: current.gameTimeMs, environment: current.environment, activeClientCount: 1, sessionActive: true, actorDeviceId: null }
      const coverageAtWallMs = (from: number, to: number) => sessionActivityForInterval(candidate.bundle.engine.sessionCoverage, from, to)
      const outcome = advanceSchedulerChunk(current, ctx, target, { maxChunkTicks: this.options.maxChunkTicks, coverageAtWallMs })
      candidate.bundle.engine = outcome.state
      candidate.bundle.shared = outcome.state.save
      if (outcome.ticks > 0) candidate.revision += 1
      const ordered: LocalEventHistoryEntry[] = outcome.events.map((event: DomainEvent, index: number) => ({
        ...orderedDomainEvent(candidate.eventSeq + index + 1, event),
        revision: candidate.revision,
        gameTimeMs: outcome.state.gameTimeMs,
      }))
      candidate.eventSeq += ordered.length
      candidate.eventHistory = [...this.events, ...ordered].slice(-512)
      this.syncAuthorityOn(candidate, target)
      try {
        this.persistCandidate(candidate)
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
        this.state = 'read_only'
        this.emitProjection()
        return
      }
      this.localDocument = candidate
      this.idempotency = candidate.idempotency ?? this.idempotency
      if (ordered.length > 0) this.events.push(...ordered)
      this.events = (candidate.eventHistory ?? this.events).slice(-512)
      this.emitProjection()
      if (outcome.frozen || outcome.ticks === 0 || outcome.catchingUp === false) break
      await this.yieldToEventLoop()
    }
    this.state = 'ready'
    this.emitProjection()
  }
  private async pollScheduler(): Promise<void> {
    if (this.localDocument === null || this.isReadOnly() || this.state === 'stopped' || this.state === 'suspended') return
    const at = this.now()
    this.touchCoverage(at)
    await this.catchUp(at)
  }
  private syncAuthority(at: number): void {
    if (this.localDocument !== null) this.syncAuthorityOn(this.localDocument, at)
  }
  private syncAuthorityOn(document: LocalPetDocumentV2, at: number): void {
    const stamp = document.authority.stamp
    stamp.revision = document.revision
    stamp.eventSeq = document.eventSeq
    document.bundle.authority = stamp
    document.bundle.shared = document.bundle.engine.save
    document.bundle.exportedAtWallMs = at
  }
  private writeDocument(document: LocalPetDocumentV2): void {
    this.writeDocumentAt(this.options.documentPath, document)
  }
  private writeDocumentAt(file: string, document: LocalPetDocumentV2): void {
    assertLocalPetDocumentV2(document)
    const cache = document.idempotency || emptyOpIdCache()
    validateOpIdCache(cache)
    validatePersistedRuntimeState({ schemaVersion: 2, engine: document.bundle.engine, idempotency: cache })
    mkdirSync(dirname(file), { recursive: true })
    const text = JSON.stringify(document, null, 2)
    if (this.options.writeDocument !== undefined) this.options.writeDocument(file, text)
    else atomicWrite(file, text)
  }
  private rollbackSnapshotPath(): string {
    return this.options.rollbackSnapshotPath || this.options.documentPath + '.pre-detach.json'
  }
  private loadDetachRollback(): LocalPetDocumentV2 | null {
    const path = this.rollbackSnapshotPath()
    if (existsSync(path) === false) return null
    try {
      const loaded = normalizeLocalPetDocument(JSON.parse(readFileSync(path, 'utf8')) as unknown)
      if (loaded.document.authority.state !== 'active' || loaded.document.authority.stamp.owner !== 'local') return null
      return loaded.document
    } catch {
      return null
    }
  }
  private persistCandidate(candidate: LocalPetDocumentV2): void {
    candidate.idempotency = candidate.idempotency ?? emptyOpIdCache()
    this.syncAuthorityOn(candidate, this.now())
    this.writeDocument(candidate)
  }
  private persist(): void {
    if (this.localDocument === null) return
    const candidate = cloneDocument(this.localDocument)
    candidate.idempotency = this.idempotency
    this.persistCandidate(candidate)
    this.localDocument = candidate
    this.emitProjection()
  }
  private backup(backupPath: string, sourcePath: string): void {
    if (existsSync(backupPath) === false) copyFileSync(sourcePath, backupPath)
  }
  private emitProjection(): void {
    if (this.localDocument === null) { this.options.onStatus?.(this.getStatus()); return }
    const engine = this.localDocument.bundle.engine
    const projection: LocalPetProjection = {
      format: 'qqpet-local-projection-v1', schemaVersion: 1, status: this.getStatus(),
      revision: this.localDocument.revision, eventSeq: this.localDocument.eventSeq,
      gameTimeMs: engine.gameTimeMs, timeZone: engine.timeZone, advanceWhileEmpty: engine.advanceWhileEmpty,
      authority: { state: this.localDocument.authority.state, stamp: this.localDocument.authority.stamp },
      save: composeSaveWithOverlay(engine.save, this.localDocument.device),
      shared: engine.save, device: this.localDocument.device,
      runtime: { appInstanceId: this.localDocument.runtime.appInstanceId, startedAtWallMs: this.localDocument.runtime.startedAtWallMs, localDeviceId: this.localDeviceIdValue },
    }
    this.lastProjectionValue = cloneProjection(projection)
    this.options.onStatus?.({ ...projection.status })
    this.options.onProjection?.(cloneProjection(projection))
  }
}

export function localRepositoryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LOCAL_REPOSITORY_ENV_FLAG] !== '0'
}

export function startLocalRepositoryIfEnabled(options: LocalRepositoryOptions, env: NodeJS.ProcessEnv = process.env): LocalRepository | null {
  if (options.authorityState === undefined) return null
  if (localRepositoryCapability(env, options.authorityState === 'legacy-active', options.rendererCapability === true).canActivate === false) return null
  const repository = createLocalRepository(options, { authorityState: options.authorityState, rendererCapability: options.rendererCapability === true, env })
  void repository.start()
  return repository
}

export interface LocalRepositoryLifecycleEvents {
  onReady(listener: () => void): void
  onQuit(listener: () => void): void
}

/** Registers start-on-ready/stop-on-quit only when the explicit C6 flag is enabled.
 * src/main/index.ts uses DesktopRendererRuntime directly; this helper stays for
 * host tests and programmatic lifecycle reconciliation. */
export function registerLocalRepositoryLifecycle(options: LocalRepositoryOptions, events: LocalRepositoryLifecycleEvents, env: NodeJS.ProcessEnv = process.env): LocalRepository | null {
  if (options.authorityState === undefined) return null
  if (localRepositoryCapability(env, options.authorityState === 'legacy-active', options.rendererCapability === true).canActivate === false) return null
  const repository = createLocalRepository(options, { authorityState: options.authorityState, rendererCapability: options.rendererCapability === true, env })
  events.onReady(() => { void repository.start() })
  events.onQuit(async () => { await repository.flush(); await repository.stop() })
  return repository
}
