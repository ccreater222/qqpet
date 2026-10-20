import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { atomicWrite } from './atomic-write'
import { startSave } from '../shared/save-logic'
import { sessionActivityForInterval } from '../shared/pet-runtime/coverage'
import type { CoverageReopen, CoverageSurvivor, SessionCoverageInterval } from '../shared/pet-runtime/types'
import { orderedDomainEvent, type DomainEvent, type OrderedDomainEvent } from '../shared/pet-runtime/events'
import { advanceSchedulerChunk, CATCHUP_CHUNK_TICKS } from '../shared/pet-runtime/scheduler'
import {
  emptyOpIdCache, executeCommandIdempotent, migrateOpIdCache, validateOpIdCache,
  validatePersistedRuntimeState, type OpIdCache, type PersistedRuntimeState,
} from '../shared/pet-runtime/idempotency'
import type { CommandError, CommandRole, PetCommand } from '../shared/sync/protocol'
import type { RuntimeCommandContext, RuntimeOutcome } from '../shared/pet-runtime/runtime-types'
import {
  assertDeviceLocalOverlay, toDeviceLocalOverlay, type DeviceLocalOverlay, type DeviceLocalSettings,
  type SharedSaveData,
} from '../shared/sync/data-boundary'
import {
  assertLocalPetDocumentV2, migrateLegacyLocalPetDocumentV2, migrateLegacySaveDataToPortableBundle,
  migratePortablePetBundle, LOCAL_DOCUMENT_FORMAT, LOCAL_DOCUMENT_SCHEMA_VERSION,
  type AuthorityStamp, type LocalPetDocumentV2, type PortablePetBundleV1,
} from '../shared/sync/portable'

export const LOCAL_REPOSITORY_ENV_FLAG = 'QQPET_LOCAL_REPOSITORY_V2'
export const LOCAL_SCHEDULER_POLL_MS = 1000
export const LOCAL_COVERAGE_GRACE_MS = 60_000

export type LocalRepositoryState = 'loading' | 'ready' | 'catching_up' | 'read_only' | 'suspended' | 'stopped'
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
  shared: SharedSaveData
  device: DeviceLocalOverlay
  runtime: { appInstanceId: string; startedAtWallMs: number; localDeviceId: string }
}

export interface LocalCommandResult {
  outcome: RuntimeOutcome
  events: OrderedDomainEvent[]
  projection: LocalPetProjection | null
  duplicate: boolean
}

export interface LocalRepositoryOptions {
  documentPath: string
  legacySavePath?: string
  legacyBackupPath?: string
  documentBackupPath?: string
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
}

interface LoadedDocument {
  document: LocalPetDocumentV2
  idempotency: OpIdCache
}

function commandError(message: string, code: CommandError['code'] = 'invalid_payload'): RuntimeOutcome {
  return { ok: false, events: [], error: { code, message, refreshProjection: true } }
}

export function normalizeLocalPetDocument(raw: unknown): LoadedDocument {
  let value = raw
  const record = value as Record<string, unknown> | null
  const runtime = record && typeof record.runtime === 'object' ? record.runtime as Record<string, unknown> : null
  if (runtime && 'localDeviceId' in runtime) value = migrateLegacyLocalPetDocumentV2(value)
  assertLocalPetDocumentV2(value)
  const document = value as LocalPetDocumentV2
  const idempotency = document.idempotency === undefined ? emptyOpIdCache() : migrateOpIdCache(document.idempotency)
  validateOpIdCache(idempotency)
  validatePersistedRuntimeState({ schemaVersion: 2, engine: document.bundle.engine, idempotency })
  return { document: { ...document, idempotency }, idempotency }
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
  private schedulerTimer: ReturnType<typeof setInterval> | undefined
  private queue: Promise<void> = Promise.resolve()
  private lastProjectionValue: LocalPetProjection | null = null
  private events: OrderedDomainEvent[] = []
  private lastReopenValue: CoverageReopen | undefined
  private mutationCoverage: SessionCoverageInterval[] = []
  private stopped = false
  private appInstanceId = ''

  constructor(options: LocalRepositoryOptions) {
    if (typeof options.documentPath !== 'string' || options.documentPath.length === 0) throw new Error('LocalRepository documentPath is required')
    this.options = {
      ...options,
      pollIntervalMs: options.pollIntervalMs ?? LOCAL_SCHEDULER_POLL_MS,
      maxChunkTicks: options.maxChunkTicks ?? CATCHUP_CHUNK_TICKS,
      autoScheduler: options.autoScheduler ?? true,
    }
    this.now = options.nowMs ?? (() => Date.now())
    this.newUuid = options.randomUUID ?? randomUUID
    if (Number.isSafeInteger(this.options.pollIntervalMs) === false || this.options.pollIntervalMs <= 0) throw new Error('pollIntervalMs must be a positive safe integer')
    if (Number.isSafeInteger(this.options.maxChunkTicks) === false || this.options.maxChunkTicks <= 0) throw new Error('maxChunkTicks must be a positive safe integer')
  }

  get currentDeviceId(): string { return this.localDeviceIdValue }
  get lastReopen(): CoverageReopen | undefined { return this.lastReopenValue }
  getStatus(): LocalRepositoryStatus {
    return {
      mode: 'local', state: this.state, offline: true, role: this.role,
      readOnly: this.state === 'read_only', catchingUp: this.state === 'catching_up',
      authorityState: this.localDocument?.authority.state ?? 'active',
      revision: this.localDocument?.revision ?? 0, eventSeq: this.localDocument?.eventSeq ?? 0,
      ...(this.error === undefined ? {} : { error: this.error }),
    }
  }
  getProjection(): LocalPetProjection | null { return this.lastProjectionValue }
  getDocument(): LocalPetDocumentV2 | null { return this.localDocument === null ? null : JSON.parse(JSON.stringify(this.localDocument)) as LocalPetDocumentV2 }
  getRecentEvents(): OrderedDomainEvent[] { return [...this.events] }

  load(): LocalPetProjection | null {
    if (this.loaded) return this.lastProjectionValue
    try {
      const loaded = this.loadOrMigrate()
      this.localDocument = loaded.document
      this.idempotency = loaded.idempotency
      this.localDeviceIdValue = loaded.document.device.localDeviceId
      this.repairCoverage(this.now(), 'crash_repaired')
      if (loaded.document.bundle.engine.advanceWhileEmpty === false && loaded.document.bundle.engine.lastSchedulerWallMs < this.now()) {
        loaded.document.bundle.engine.lastSchedulerWallMs = this.now()
      }
      this.openCoverage(this.now())
      this.syncAuthority(this.now())
      this.persist()
      this.loaded = true
      this.state = 'ready'
      this.emitProjection()
      this.catchUp(this.now())
      this.emitProjection()
      return this.lastProjectionValue
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      this.state = 'read_only'
      this.emitProjection()
      return null
    }
  }

  pump(): Promise<void> { return this.enqueue(() => this.pollScheduler()) }

  start(): LocalPetProjection | null {
    if (this.stopped) throw new Error('LocalRepository has been stopped')
    const projection = this.load()
    if (projection === null) return null
    if (this.options.autoScheduler && this.schedulerTimer === undefined) {
      this.schedulerTimer = setInterval(() => { void this.pump() }, this.options.pollIntervalMs)
      if (typeof this.schedulerTimer.unref === 'function') this.schedulerTimer.unref()
    }
    return this.lastProjectionValue
  }

  flush(): void { if (this.localDocument !== null && this.state !== 'read_only') this.persist() }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.schedulerTimer !== undefined) { clearInterval(this.schedulerTimer); this.schedulerTimer = undefined }
    if (this.localDocument !== null && this.state !== 'read_only' && this.state !== 'stopped') {
      const at = this.now()
      this.touchCoverage(at)
      this.closeOpenCoverage(at, 'app_shutdown')
      this.syncAuthority(at)
      this.persist()
    }
    this.state = 'stopped'
    this.emitProjection()
  }

  setRole(role: LocalRepositoryRole): LocalRepositoryStatus { this.role = role; this.emitProjection(); return this.getStatus() }

  setAdvanceWhileEmpty(enabled: boolean): LocalPetProjection | null {
    if (this.localDocument === null || this.state === 'read_only') return this.lastProjectionValue
    this.localDocument.bundle.engine.advanceWhileEmpty = enabled
    this.persist()
    this.emitProjection()
    return this.lastProjectionValue
  }

  setLocalSettings(patch: Partial<DeviceLocalSettings>): LocalPetProjection | null {
    if (this.localDocument === null || this.state === 'read_only') return this.lastProjectionValue
    this.localDocument.device = { ...this.localDocument.device, settings: { ...this.localDocument.device.settings, ...patch } }
    assertDeviceLocalOverlay(this.localDocument.device)
    this.persist()
    this.emitProjection()
    return this.lastProjectionValue
  }

  command(command: PetCommand, opId: string, role: LocalRepositoryRole = 'owner'): Promise<LocalCommandResult> {
    return this.enqueue(() => this.executeCommandNow(command, opId, role))
  }

  reset(opId: string = this.newUuid()): Promise<LocalCommandResult> {
    return this.enqueue(() => {
      const survivors = this.closeForMutation('pet_reset')
      return this.executeCommandNow({ type: 'pet.reset', payload: {} }, opId, 'owner', survivors)
    })
  }

  exportPortableBundle(): PortablePetBundleV1 | null {
    if (this.localDocument === null) return null
    this.syncAuthority(this.now())
    return JSON.parse(JSON.stringify(this.localDocument.bundle)) as PortablePetBundleV1
  }

  importPortableBundle(value: PortablePetBundleV1 | string, _opId: string = this.newUuid()): LocalPetProjection | null {
    if (this.localDocument === null || this.state === 'read_only') return this.lastProjectionValue
    const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value
    const bundle = migratePortablePetBundle(parsed)
    if (bundle.originLocalDeviceId !== undefined && bundle.originLocalDeviceId !== this.localDeviceIdValue) throw new Error('identity_mismatch: imported bundle originLocalDeviceId does not match local device')
    if (bundle.authority.owner !== 'local') throw new Error('identity_mismatch: only local-authority bundles can import locally')
    const survivors = this.closeForMutation('import_replaced')
    this.localDocument.bundle = { ...bundle, originLocalDeviceId: bundle.originLocalDeviceId ?? this.localDeviceIdValue, authority: this.localDocument.authority.stamp }
    this.localDocument.bundle.shared = bundle.engine.save
    this.localDocument.bundle.engine = bundle.engine
    this.localDocument.revision = this.localDocument.authority.stamp.revision
    this.localDocument.eventSeq = this.localDocument.authority.stamp.eventSeq
    this.openCoverageAfterMutation(survivors, this.now())
    this.persist()
    this.emitProjection()
    return this.lastProjectionValue
  }

  suspend(): LocalPetProjection | null {
    if (this.localDocument === null || this.state === 'read_only') return this.lastProjectionValue
    const at = this.now()
    this.touchCoverage(at)
    const survivors = this.captureSurvivors('suspend', at)
    this.closeOpenCoverage(at, 'suspend')
    this.lastReopenValue = { operationId: this.newUuid(), commitWallMs: at, survivors, state: 'suspended', suspendedAtWallMs: at }
    this.localDocument.bundle.engine.coverageReopen = this.lastReopenValue
    this.state = 'suspended'
    this.syncAuthority(at)
    this.persist()
    this.emitProjection()
    return this.lastProjectionValue
  }

  resume(): LocalPetProjection | null {
    if (this.localDocument === null || this.state === 'read_only' || this.state === 'stopped') return this.lastProjectionValue
    const at = this.now()
    if (this.localDocument.bundle.engine.coverageReopen !== undefined) {
      this.lastReopenValue = this.localDocument.bundle.engine.coverageReopen
      delete this.localDocument.bundle.engine.coverageReopen
    }
    this.openCoverage(at)
    this.state = 'ready'
    this.touchCoverage(at)
    this.syncAuthority(at)
    this.persist()
    this.emitProjection()
    return this.lastProjectionValue
  }

  private enqueue<T>(task: () => T | Promise<T>): Promise<T> {
    const run = this.queue.then(task)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  private executeCommandNow(command: PetCommand, opId: string, role: LocalRepositoryRole, reopenSurvivors?: CoverageSurvivor[]): LocalCommandResult {
    if (this.localDocument === null || this.state === 'read_only') return { outcome: commandError('local repository is read-only', 'not_available'), events: [], projection: this.lastProjectionValue, duplicate: false }
    if (this.state !== 'ready' && this.state !== 'suspended') return { outcome: commandError('local repository is catching up', 'server_catching_up'), events: [], projection: this.lastProjectionValue, duplicate: false }
    const at = this.now()
    this.touchCoverage(at)
    const engine = this.localDocument.bundle.engine
    const idempotentDocument: PersistedRuntimeState = { schemaVersion: 2, engine, idempotency: this.idempotency }
    const ctx: RuntimeCommandContext = {
      gameTimeMs: engine.gameTimeMs, environment: engine.environment, activeClientCount: 1, sessionActive: true,
      actorDeviceId: this.localDeviceIdValue, actorRole: role, wallNowMs: at,
    }
    const result = executeCommandIdempotent(this.localDeviceIdValue, this.localDeviceIdValue, idempotentDocument, command, ctx, opId)
    if (result.duplicate) return { outcome: result.outcome, events: [], projection: this.lastProjectionValue, duplicate: true }
    const newRevision = this.localDocument.revision + 1
    const eventStart = this.localDocument.eventSeq
    const ordered = result.outcome.events.map((event: DomainEvent, index: number) => orderedDomainEvent(eventStart + index + 1, event))
    this.localDocument.revision = newRevision
    this.localDocument.eventSeq = eventStart + ordered.length
    this.localDocument.bundle.engine = result.document.engine
    this.localDocument.bundle.shared = result.document.engine.save
    this.localDocument.bundle.exportedAtWallMs = at
    this.localDocument.authority.stamp.revision = this.localDocument.revision
    this.localDocument.authority.stamp.eventSeq = this.localDocument.eventSeq
    this.localDocument.bundle.authority = this.localDocument.authority.stamp
    this.idempotency = result.document.idempotency
    if (reopenSurvivors !== undefined) this.openCoverageAfterMutation(reopenSurvivors, at)
    this.syncAuthority(at)
    this.persist()
    if (result.outcome.events.length > 0) this.events.push(...ordered)
    this.emitProjection()
    return { outcome: result.outcome, events: ordered, projection: this.lastProjectionValue, duplicate: false }
  }

  private loadOrMigrate(): LoadedDocument {
    const documentPath = this.options.documentPath
    if (existsSync(documentPath)) {
      const text = readFileSync(documentPath, 'utf8')
      let raw: unknown
      try { raw = JSON.parse(text) } catch (error) { throw new Error('local document is not valid JSON: ' + String(error)) }
      const loaded = normalizeLocalPetDocument(raw)
      const rawRecord = raw as Record<string, unknown>
      const runtime = rawRecord.runtime as Record<string, unknown> | null
      const duplicateIdentity = runtime !== null && typeof runtime === 'object' && 'localDeviceId' in runtime
      const missingIdempotency = rawRecord.idempotency === undefined
      if (duplicateIdentity) this.backup(this.options.documentBackupPath || documentPath + '.bak', documentPath)
      if (duplicateIdentity || missingIdempotency) this.writeDocument(loaded.document)
      this.appInstanceId = this.options.appInstanceId || this.newUuid()
      loaded.document.runtime = { appInstanceId: this.appInstanceId, startedAtWallMs: this.now() }
      loaded.document.bundle.originLocalDeviceId = loaded.document.device.localDeviceId
      return loaded
    }
    const legacyPath = this.options.legacySavePath
    if (legacyPath !== undefined && existsSync(legacyPath)) {
      const raw = JSON.parse(readFileSync(legacyPath, 'utf8')) as unknown
      this.backup(this.options.legacyBackupPath || legacyPath + '.bak', legacyPath)
      return this.migrateLegacy(raw)
    }
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
    const coverage: SessionCoverageInterval = { coverageId: this.newUuid(), deviceId: this.localDeviceIdValue, connectedAtWallMs: at, lastHeartbeatWallMs: at }
    this.localDocument.bundle.engine.sessionCoverage.push(coverage)
    this.openCoverageId = coverage.coverageId
  }
  private touchCoverage(at: number): void {
    if (this.localDocument === null || this.openCoverageId === undefined) return
    const interval = this.localDocument.bundle.engine.sessionCoverage.find(item => item.coverageId === this.openCoverageId)
    if (interval !== undefined && interval.lastHeartbeatWallMs < at) interval.lastHeartbeatWallMs = at
  }
  private closeOpenCoverage(at: number, reason: 'app_shutdown' | 'suspend' | 'pet_reset' | 'import_replaced'): void {
    if (this.localDocument === null || this.openCoverageId === undefined) return
    const interval = this.localDocument.bundle.engine.sessionCoverage.find(item => item.coverageId === this.openCoverageId)
    if (interval !== undefined) {
      interval.disconnectedAtWallMs = Math.max(interval.connectedAtWallMs, at)
      interval.lastHeartbeatWallMs = Math.max(interval.lastHeartbeatWallMs, interval.disconnectedAtWallMs)
      interval.closeReason = reason
    }
    this.openCoverageId = undefined
  }
  private captureSurvivors(reason: 'suspend' | 'pet_reset' | 'import_replaced', at: number): CoverageSurvivor[] {
    if (this.localDocument === null) return []
    const open = this.localDocument.bundle.engine.sessionCoverage.find(item => (this.openCoverageId === undefined || item.coverageId === this.openCoverageId) && item.disconnectedAtWallMs === undefined)
    if (open === undefined) return []
    return [{ kind: 'local_app', appInstanceId: this.localDocument.runtime.appInstanceId, localDeviceId: this.localDeviceIdValue, lastHeartbeatWallMs: open.lastHeartbeatWallMs, eligible: true, activeEndWallMs: at, activeEndProvenance: reason }]
  }
  private closeForMutation(reason: 'pet_reset' | 'import_replaced'): CoverageSurvivor[] {
    const at = this.now()
    this.touchCoverage(at)
    const survivors = this.captureSurvivors(reason, at)
    this.closeOpenCoverage(at, reason)
    this.mutationCoverage = JSON.parse(JSON.stringify(this.localDocument?.bundle.engine.sessionCoverage ?? [])) as SessionCoverageInterval[]
    this.lastReopenValue = { operationId: this.newUuid(), commitWallMs: at, survivors, state: 'pending' }
    if (this.localDocument !== null) this.localDocument.bundle.engine.coverageReopen = this.lastReopenValue
    return survivors
  }
  private openCoverageAfterMutation(survivors: CoverageSurvivor[], at: number): void {
    if (this.localDocument === null) return
    this.localDocument.bundle.engine.sessionCoverage = [...this.mutationCoverage]
    this.openCoverage(at)
    this.localDocument.bundle.engine.coverageReopen = { operationId: this.newUuid(), commitWallMs: at, survivors, state: 'pending' }
    this.lastReopenValue = this.localDocument.bundle.engine.coverageReopen
  }
  private catchUp(target: number): void {
    if (this.localDocument === null) return
    const engine = this.localDocument.bundle.engine
    if (target <= engine.lastSchedulerWallMs) { this.syncAuthority(target); this.persist(); return }
    let rounds = 0
    this.state = 'catching_up'
    this.emitProjection()
    while (this.localDocument.bundle.engine.lastSchedulerWallMs < target && rounds++ < 100000) {
      const current = this.localDocument.bundle.engine
      const ctx: RuntimeCommandContext = { gameTimeMs: current.gameTimeMs, environment: current.environment, activeClientCount: 1, sessionActive: true, actorDeviceId: null }
      const coverageAtWallMs = (from: number, to: number) => sessionActivityForInterval((this.localDocument as LocalPetDocumentV2).bundle.engine.sessionCoverage, from, to)
      const outcome = advanceSchedulerChunk(current, ctx, target, { maxChunkTicks: this.options.maxChunkTicks, coverageAtWallMs })
      this.localDocument.bundle.engine = outcome.state
      this.localDocument.bundle.shared = outcome.state.save
      this.localDocument.bundle.exportedAtWallMs = target
      this.syncAuthority(target)
      this.persist()
      if (outcome.frozen || outcome.ticks === 0 || outcome.catchingUp === false) break
    }
    this.state = 'ready'
    this.syncAuthority(target)
    this.persist()
    this.emitProjection()
  }
  private pollScheduler(): void {
    if (this.localDocument === null || this.state === 'read_only' || this.state === 'stopped' || this.state === 'suspended') return
    const at = this.now()
    this.touchCoverage(at)
    this.catchUp(at)
  }
  private syncAuthority(at: number): void {
    if (this.localDocument === null) return
    const stamp = this.localDocument.authority.stamp
    stamp.revision = this.localDocument.revision
    stamp.eventSeq = this.localDocument.eventSeq
    this.localDocument.bundle.authority = stamp
    this.localDocument.bundle.shared = this.localDocument.bundle.engine.save
    this.localDocument.bundle.exportedAtWallMs = at
  }
  private writeDocument(document: LocalPetDocumentV2): void {
    assertLocalPetDocumentV2(document)
    validateOpIdCache(document.idempotency || emptyOpIdCache())
    mkdirSync(dirname(this.options.documentPath), { recursive: true })
    atomicWrite(this.options.documentPath, JSON.stringify(document, null, 2))
  }
  private persist(): void {
    if (this.localDocument === null) return
    this.localDocument.idempotency = this.idempotency
    this.syncAuthority(this.now())
    this.writeDocument(this.localDocument)
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
      shared: engine.save, device: this.localDocument.device,
      runtime: { appInstanceId: this.localDocument.runtime.appInstanceId, startedAtWallMs: this.localDocument.runtime.startedAtWallMs, localDeviceId: this.localDeviceIdValue },
    }
    this.lastProjectionValue = projection
    this.options.onStatus?.(projection.status)
    this.options.onProjection?.(projection)
  }
}

export function localRepositoryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LOCAL_REPOSITORY_ENV_FLAG] === '1'
}

export function startLocalRepositoryIfEnabled(options: LocalRepositoryOptions, env: NodeJS.ProcessEnv = process.env): LocalRepository | null {
  if (localRepositoryEnabled(env) === false) return null
  const repository = new LocalRepository(options)
  repository.start()
  return repository
}

export interface LocalRepositoryLifecycleEvents {
  onReady(listener: () => void): void
  onQuit(listener: () => void): void
}

/** Registers start-on-ready/stop-on-quit only when the explicit flag is enabled. */
export function registerLocalRepositoryLifecycle(options: LocalRepositoryOptions, events: LocalRepositoryLifecycleEvents, env: NodeJS.ProcessEnv = process.env): LocalRepository | null {
  if (localRepositoryEnabled(env) === false) return null
  const repository = new LocalRepository(options)
  events.onReady(() => { repository.start() })
  events.onQuit(() => { repository.flush(); repository.stop() })
  return repository
}
