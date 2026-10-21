import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite } from './atomic-write'
import { IPC } from '../shared/ipc'
import type { SaveData, SavePatch } from '../shared/save'
import type { OrderedEvent } from '../shared/pet-runtime/events'
import { assertTimeZone } from '../shared/pet-runtime/time'
import type { CommandKey, CommandResult, DeviceInfo, PetCommand } from '../shared/sync/protocol'
import type { PortablePetBundleV1 } from '../shared/sync/portable'
import { migratePortablePetBundle } from '../shared/sync/portable'
import type { DeviceLocalOverlay } from '../shared/sync/data-boundary'
import type { RendererProjection, RendererRepositoryStatus, RendererRuntimeInfo } from '../shared/renderer-api'
import {
  defaultStorageConfig,
  emptyHandoffReport,
  parseStorageConfig,
  STORAGE_CONFIG_FILE,
  STORAGE_CONFIG_FORMAT,
  STORAGE_CONFIG_SCHEMA_VERSION,
  type StorageBackupStatus,
  type StorageDeviceListView,
  type StorageExportReport,
  type StorageHandoffReport,
  type StorageImportReport,
  type StorageMigrationStatus,
  type StorageMode,
  type StoragePairInput,
  type StorageSetModeInput,
  type StorageStatusView,
} from '../shared/storage'
import type { RemoteSyncConfig, RemoteTokenStore } from './remote-repository'
import { desktopServerModeCapability } from './renderer-runtime-flags'

export interface StorageLocalAuthority {
  getStatus(): RendererRepositoryStatus
  getProjection(): RendererProjection | null
  start(): Promise<unknown>
  loadFenced(): Promise<unknown>
  stop(): Promise<void>
  flush(): Promise<void>
  load(): Promise<SaveData>
  command<K extends CommandKey>(
    command: Extract<PetCommand, { type: K }>,
    options?: { opId?: string },
  ): Promise<CommandResult<K>>
  setAdvanceWhileEmpty(enabled: boolean): Promise<void>
  exportForDetach(incomingEpoch: number): Promise<PortablePetBundleV1>
  rollbackDetach(): Promise<unknown>
  archiveAuthority(reason: 'use_server' | 'mode_switch'): Promise<unknown>
  importPortableBundle(
    bundle: PortablePetBundleV1 | string,
    options?: {
      opId?: string
      expectedAuthorityId?: string
      expectedRestoreGeneration?: number
      expectedEpoch?: number
      expectedRevision?: number
      expectedEventSeq?: number
    },
  ): Promise<unknown | null>
  createBackup(reason: 'import' | 'manual' | 'mode_switch'): string | null
  getMigrationStatus(): StorageMigrationStatus
  getBackupStatus(): StorageBackupStatus
  exportPortableBundle(): PortablePetBundleV1 | null
  getWeatherCity?(): string
  setSendEnabled(enabled: boolean): void
  info(): RendererRuntimeInfo
  requestResync(): void
  loadLocalSettings(): DeviceLocalOverlay
  updateLocalSettings(value: unknown): Promise<DeviceLocalOverlay>
  savePatch?(patch: SavePatch): Promise<void>
  reset?(): Promise<void>
  attachWindow?(window: unknown): void
  onView?(listener: (save: SaveData) => void): () => void
}

export interface StorageRemoteAuthority {
  start(): Promise<RendererProjection | null>
  stop(): Promise<void>
  flush(): Promise<void>
  load(): Promise<SaveData>
  getStatus(): RendererRepositoryStatus
  getProjection(): RendererProjection | null
  command<K extends CommandKey>(
    command: Extract<PetCommand, { type: K }>,
    options?: { opId?: string },
  ): Promise<CommandResult<K>>
  setAdvanceWhileEmpty(enabled: boolean): Promise<void>
  exportBundle(): Promise<PortablePetBundleV1>
  requestResync(): void
  loadLocalSettings(): Promise<DeviceLocalOverlay>
  updateLocalSettings(value: unknown): Promise<DeviceLocalOverlay>
  onProjection(listener: (projection: RendererProjection, events: OrderedEvent[]) => void): () => void
  onResync(listener: (projection: RendererProjection, events: OrderedEvent[]) => void): () => void
  onCommandResult(listener: (result: CommandResult) => void): () => void
  onSyncStatus(listener: (status: RendererRepositoryStatus) => void): () => void
}

export interface StorageRemoteFactoryOptions {
  serverUrl: string
  appVersion: string
  tokenStore: RemoteTokenStore
  pair?: { code: string; deviceLabel: string }
}

export interface StorageWindowLike {
  isDestroyed?(): boolean
  webContents: { send(channel: string, ...args: unknown[]): void }
}

export interface DesktopStorageControllerOptions {
  userDataPath: string
  appVersion: string
  local: StorageLocalAuthority
  createRemote: (options: StorageRemoteFactoryOptions) => StorageRemoteAuthority
  createTokenStore: () => RemoteTokenStore
  nowMs?: () => number
  platform?: string
  env?: NodeJS.ProcessEnv
}

interface PendingUpload {
  bundle: PortablePetBundleV1
  opId: string
  command: Extract<PetCommand, { type: 'admin.importPortableBundle' | 'admin.resumeServer' }>
  requestedRebind: boolean
}

type UploadOutcome = 'applied' | 'rolled_back' | 'frozen'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCodeOf(error: unknown): string {
  const match = /^([a-z_]+):/.exec(messageOf(error))
  return match === null ? 'storage_error' : match[1]
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : {}
}

function validatePairInput(value: unknown): StoragePairInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid_payload: pairing input must be an object')
  }
  const record = value as Record<string, unknown>
  if (typeof record.serverUrl !== 'string' || (record.serverUrl.startsWith('wss://') === false && record.serverUrl.startsWith('ws://') === false)) {
    throw new Error('invalid_payload: serverUrl must be a ws:// or wss:// URL')
  }
  if (typeof record.code !== 'string' || record.code.length === 0) throw new Error('invalid_payload: pairing code is required')
  if (typeof record.deviceLabel !== 'string' || record.deviceLabel.length === 0) throw new Error('invalid_payload: device label is required')
  return { serverUrl: record.serverUrl, code: record.code, deviceLabel: record.deviceLabel }
}

function validateModeInput(value: unknown): StorageSetModeInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid_payload: mode input must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.mode !== 'local' && record.mode !== 'server') throw new Error('invalid_payload: mode must be local or server')
  if (record.initialSource !== undefined && record.initialSource !== 'upload-local' && record.initialSource !== 'use-server') {
    throw new Error('invalid_payload: initialSource must be upload-local or use-server')
  }
  if (record.serverUrl !== undefined && typeof record.serverUrl !== 'string') throw new Error('invalid_payload: serverUrl must be a string')
  if (record.pairingCode !== undefined && typeof record.pairingCode !== 'string') throw new Error('invalid_payload: pairingCode must be a string')
  if (record.deviceLabel !== undefined && typeof record.deviceLabel !== 'string') throw new Error('invalid_payload: deviceLabel must be a string')
  if (record.expectedEpoch !== undefined && (typeof record.expectedEpoch !== 'number' || Number.isSafeInteger(record.expectedEpoch) === false)) {
    throw new Error('invalid_payload: expectedEpoch must be a safe integer')
  }
  return {
    mode: record.mode,
    ...(record.serverUrl === undefined ? {} : { serverUrl: record.serverUrl }),
    ...(record.pairingCode === undefined ? {} : { pairingCode: record.pairingCode }),
    ...(record.deviceLabel === undefined ? {} : { deviceLabel: record.deviceLabel }),
    ...(record.initialSource === undefined ? {} : { initialSource: record.initialSource }),
    ...(record.allowClamp === undefined ? {} : { allowClamp: record.allowClamp === true }),
    ...(record.rebindLocalSessions === undefined ? {} : { rebindLocalSessions: record.rebindLocalSessions === true }),
    ...(record.expectedEpoch === undefined ? {} : { expectedEpoch: record.expectedEpoch }),
  }
}

/**
 * C11 desktop storage coordinator. It owns the requested/active storage mode,
 * pairing and owner admin flows, authority fencing, portable import/export,
 * backups and unified command routing. It imports no Electron symbols so the
 * behavior tests can drive it with an in-process fake transport.
 */
export class DesktopStorageController {
  private readonly userDataPath: string
  private readonly appVersion: string
  private readonly local: StorageLocalAuthority
  private readonly createRemote: (options: StorageRemoteFactoryOptions) => StorageRemoteAuthority
  private readonly createTokenStore: () => RemoteTokenStore
  private readonly now: () => number
  private readonly platform: string
  private readonly env: NodeJS.ProcessEnv

  private mode: StorageMode = 'local'
  private activeMode: StorageMode = 'local'
  private remote: StorageRemoteAuthority | null = null
  private tokenStore: RemoteTokenStore | null = null
  private pairedFlag = false
  private serverUrl: string | undefined
  private deviceLabel: string | undefined
  private remoteConfig: RemoteSyncConfig | null = null
  private lastWeatherCity = ''
  private handoffValue: StorageHandoffReport = emptyHandoffReport()
  private pendingUpload: PendingUpload | null = null
  private pendingServerBundle: { bundle: PortablePetBundleV1 } | null = null
  private capturedEvents: OrderedEvent[] = []
  private initialized = false
  private window: StorageWindowLike | null = null
  private remoteUnsubscribes: Array<() => void> = []
  private readonly statusListeners = new Set<(status: StorageStatusView) => void>()
  private readonly devicesListeners = new Set<(view: StorageDeviceListView) => void>()
  private readonly viewListeners = new Set<(save: SaveData) => void>()

  constructor(options: DesktopStorageControllerOptions) {
    if (typeof options.userDataPath !== 'string' || options.userDataPath.length === 0) throw new Error('storage controller userDataPath is required')
    if (typeof options.appVersion !== 'string' || options.appVersion.length === 0) throw new Error('storage controller appVersion is required')
    this.userDataPath = options.userDataPath
    this.appVersion = options.appVersion
    this.local = options.local
    this.createRemote = options.createRemote
    this.createTokenStore = options.createTokenStore
    this.now = options.nowMs ?? (() => Date.now())
    this.platform = options.platform ?? process.platform
    this.env = options.env ?? process.env
    if (this.local.onView !== undefined) this.local.onView(save => this.emitView(save))
  }

  get storageConfigPath(): string {
    return join(this.userDataPath, STORAGE_CONFIG_FILE)
  }

  get requestedMode(): StorageMode {
    return this.mode
  }

  get authorityMode(): StorageMode {
    return this.activeMode
  }

  get handoff(): StorageHandoffReport {
    return clone(this.handoffValue)
  }

  info(): RendererRuntimeInfo {
    return { localRepositoryV2: true, serverMode: this.activeMode === 'server' }
  }

  acceptsSender(sender: unknown): boolean {
    return this.window !== null && sender === this.window.webContents
  }

  attachWindow(window: StorageWindowLike): void {
    this.window = window
    this.local.attachWindow?.(window)
  }

  onStatus(listener: (status: StorageStatusView) => void): () => void {
    this.statusListeners.add(listener)
    return () => { this.statusListeners.delete(listener) }
  }

  onDevices(listener: (view: StorageDeviceListView) => void): () => void {
    this.devicesListeners.add(listener)
    return () => { this.devicesListeners.delete(listener) }
  }

  onView(listener: (save: SaveData) => void): () => void {
    this.viewListeners.add(listener)
    return () => { this.viewListeners.delete(listener) }
  }

  /** Loads the persisted mode and starts exactly one authority path. */
  async initialize(): Promise<StorageStatusView> {
    if (this.initialized) return this.status()
    this.initialized = true
    const config = this.readConfig()
    this.mode = config.mode
    this.serverUrl = config.serverUrl
    this.deviceLabel = config.deviceLabel
    if (this.mode === 'server') {
      const paired = await this.connectStoredRemote()
      if (paired) {
        await this.local.loadFenced()
        this.activeMode = 'server'
        this.local.setSendEnabled(false)
      } else {
        // Requested server mode without a token: local remains the writer until pairing and explicit choice.
        this.activeMode = 'local'
        await this.local.start()
        this.local.setSendEnabled(true)
      }
    } else {
      this.activeMode = 'local'
      await this.local.start()
      this.local.setSendEnabled(true)
    }
    this.emitStatus()
    return this.status()
  }

  status(): StorageStatusView {
    const capability = desktopServerModeCapability(this.env, this.platform)
    const localStatus = this.local.getStatus()
    const remoteStatus = this.remote === null ? null : this.remote.getStatus()
    const serverFallback = this.mode === 'server' && this.pairedFlag && this.remote === null
    const activeStatus: RendererRepositoryStatus = this.activeMode === 'server'
      ? remoteStatus ?? { ...localStatus, mode: 'server', serverMode: true, connection: 'offline' }
      : localStatus
    const activeProjection = this.activeMode === 'server'
      ? this.remote?.getProjection() ?? null
      : this.local.getProjection()
    const authority = activeProjection?.authority ?? {
      owner: this.activeMode === 'server' ? 'server' as const : 'local' as const,
      authorityId: '',
      restoreGeneration: 0,
      epoch: 0,
      state: 'archived' as const,
    }
    const localDeviceId = localStatus.localDeviceId ?? activeProjection?.device?.localDeviceId
    const weatherCity = this.weatherCity()
    return {
      mode: this.mode,
      activeMode: this.activeMode,
      serverModeAvailable: capability.canActivate && capability.serverMode,
      ...(capability.reason === undefined ? {} : { serverModeReason: capability.reason }),
      connection: serverFallback ? 'offline' : activeStatus.connection,
      ...(this.serverUrl === undefined ? {} : { serverUrl: this.serverUrl }),
      paired: this.pairedFlag,
      ...(this.remoteConfig?.petId === undefined || this.remoteConfig.petId.length === 0 ? {} : { petId: this.remoteConfig.petId }),
      ...(this.remoteConfig?.deviceId === undefined || this.remoteConfig.deviceId.length === 0 ? {} : { deviceId: this.remoteConfig.deviceId }),
      ...(remoteStatus?.role === undefined ? {} : { deviceRole: remoteStatus.role as StorageStatusView['deviceRole'] }),
      ...(this.deviceLabel === undefined ? {} : { deviceLabel: this.deviceLabel }),
      authority: {
        ...authority,
        revision: activeProjection?.revision ?? activeStatus.revision,
        eventSeq: activeProjection?.eventSeq ?? activeStatus.eventSeq,
        ...(localDeviceId === undefined ? {} : { localDeviceId }),
      },
      revision: activeProjection?.revision ?? activeStatus.revision,
      eventSeq: activeProjection?.eventSeq ?? activeStatus.eventSeq,
      gameTimeMs: activeProjection?.gameTimeMs ?? activeStatus.gameTimeMs,
      timeZone: activeProjection?.timeZone ?? activeStatus.timeZone,
      weatherCity,
      advanceWhileEmpty: activeProjection?.advanceWhileEmpty ?? activeStatus.advanceWhileEmpty,
      readOnly: activeProjection?.authority.state !== 'active' || activeStatus.readOnly === true,
      catchingUp: activeStatus.catchingUp === true || activeStatus.connection === 'catching_up',
      ...(activeStatus.lastError === undefined ? {} : { lastError: activeStatus.lastError }),
      ...(activeStatus.notice === undefined ? {} : { notice: activeStatus.notice }),
      migration: this.local.getMigrationStatus(),
      backup: this.local.getBackupStatus(),
      handoff: clone(this.handoffValue),
    }
  }

  async setMode(input: unknown): Promise<StorageStatusView> {
    const parsed = validateModeInput(input)
    if (parsed.mode === 'local') return this.switchToLocal()
    if (this.activeMode === 'server') {
      this.mode = 'server'
      this.persistConfig()
      this.emitStatus()
      return this.status()
    }
    if (this.remote === null) {
      if (parsed.pairingCode !== undefined && parsed.serverUrl !== undefined && parsed.deviceLabel !== undefined) {
        await this.pair({ serverUrl: parsed.serverUrl, code: parsed.pairingCode, deviceLabel: parsed.deviceLabel })
      } else {
        const paired = await this.connectStoredRemote()
        if (paired === false) throw new Error('pairing_required: pair this device with a server before switching to server mode')
      }
    }
    this.requireRemoteReady()
    const source = parsed.initialSource ?? this.inferInitialSource()
    if (source === 'upload-local') {
      const outcome = await this.uploadLocalToServer({
        allowClamp: parsed.allowClamp === true,
        rebindLocalSessions: parsed.rebindLocalSessions === true,
      })
      if (outcome !== 'applied') {
        this.mapModeLocal()
        this.persistConfig()
        this.emitStatus()
        return this.status()
      }
    } else {
      await this.useServerAuthority()
    }
    this.mode = 'server'
    this.activeMode = 'server'
    this.local.setSendEnabled(false)
    this.persistConfig()
    this.pushActiveProjection()
    this.emitStatus()
    return this.status()
  }

  async pair(input: unknown): Promise<StorageStatusView> {
    const pairing = validatePairInput(input)
    await this.stopRemote()
    const tokenStore = this.createTokenStore()
    const remote = this.createRemote({
      serverUrl: pairing.serverUrl,
      appVersion: this.appVersion,
      tokenStore,
      pair: { code: pairing.code, deviceLabel: pairing.deviceLabel },
    })
    try {
      await remote.start()
    } catch (error) {
      try { await remote.stop() } catch { /* best effort */ }
      throw error
    }
    this.remote = remote
    this.tokenStore = tokenStore
    this.pairedFlag = true
    this.serverUrl = pairing.serverUrl
    this.deviceLabel = pairing.deviceLabel
    this.remoteConfig = await this.loadRemoteConfig(tokenStore)
    this.bindRemote(remote)
    this.persistConfig()
    this.emitStatus()
    return this.status()
  }

  async unpair(): Promise<StorageStatusView> {
    if (this.activeMode === 'server') {
      throw new Error('authority_active: switch back to local mode before unpairing this device')
    }
    await this.stopRemote()
    try { await this.tokenStore?.clear() } catch { /* best effort */ }
    this.tokenStore = null
    this.remoteConfig = null
    this.pairedFlag = false
    this.serverUrl = undefined
    if (this.mode === 'server') this.mode = 'local'
    this.mapModeLocal()
    this.persistConfig()
    this.emitStatus()
    return this.status()
  }

  async listDevices(): Promise<StorageDeviceListView> {
    const empty: StorageDeviceListView = { devices: [], owner: false, canRevoke: false }
    if (this.remote === null) return { ...empty, error: 'offline: pair a server first' }
    const role = this.remote.getStatus().role
    if (role !== 'owner') return { ...empty, error: 'unauthorized: only an owner device can list devices' }
    try {
      const result = await this.remote.command({ type: 'device.list', payload: {} })
      if (result.status === 'rejected') return { ...empty, error: result.error.message }
      const devices = (result.result as { devices?: DeviceInfo[] } | undefined)?.devices ?? []
      const view: StorageDeviceListView = {
        devices: [...devices].sort((a, b) => a.createdAtMs - b.createdAtMs || a.deviceId.localeCompare(b.deviceId)),
        owner: true,
        canRevoke: true,
      }
      this.emitDevices(view)
      return view
    } catch (error) {
      return { ...empty, error: messageOf(error) }
    }
  }

  async revokeDevice(deviceId: unknown): Promise<StorageDeviceListView> {
    if (typeof deviceId !== 'string' || deviceId.length === 0) throw new Error('invalid_payload: deviceId is required')
    if (this.remote === null) throw new Error('offline: pair a server first')
    if (this.remote.getStatus().role !== 'owner') throw new Error('unauthorized: only an owner device can revoke devices')
    const result = await this.remote.command({ type: 'device.revoke', payload: { deviceId } })
    if (result.status === 'rejected') throw new Error(result.error.code + ': ' + result.error.message)
    return this.listDevices()
  }

  async setAdvanceWhileEmpty(enabled: boolean): Promise<StorageStatusView> {
    if (this.activeMode === 'server' && this.remote !== null) {
      await this.remote.setAdvanceWhileEmpty(enabled)
    } else {
      await this.local.setAdvanceWhileEmpty(enabled)
    }
    this.emitStatus()
    return this.status()
  }

  async setTimeZone(timeZone: unknown): Promise<StorageStatusView> {
    if (typeof timeZone !== 'string' || timeZone.length === 0) throw new Error('invalid_payload: timeZone is required')
    assertTimeZone(timeZone)
    const result = await this.commandAuthority({ type: 'server.setTimeZone', payload: { timeZone } })
    if (result.status === 'rejected') throw new Error(result.error.code + ': ' + result.error.message)
    this.emitStatus()
    return this.status()
  }

  async setWeatherCity(city: unknown): Promise<StorageStatusView> {
    if (typeof city !== 'string') throw new Error('invalid_payload: city must be a string')
    const next = city.trim()
    const result = await this.commandAuthority({ type: 'server.setWeatherCity', payload: { city: next } })
    if (result.status === 'rejected') throw new Error(result.error.code + ': ' + result.error.message)
    this.lastWeatherCity = next
    this.emitStatus()
    return this.status()
  }

  async exportBundle(): Promise<StorageExportReport> {
    const bundle = this.activeMode === 'server' && this.remote !== null
      ? await this.remote.exportBundle()
      : this.local.exportPortableBundle()
    if (bundle === null) throw new Error('portable_bundle_unavailable: no committed document to export')
    const day = new Date(this.now()).toISOString().slice(0, 10)
    return { json: JSON.stringify(bundle), fileName: `QQPet-portable-${day}.json`, mode: this.activeMode }
  }

  /**
   * Portable import with validation before mutation. Local mode backs up the
   * destination document first; server mode sends the owner-only admin command
   * and reports validation/authority/clamp outcomes.
   */
  async importBundle(input: unknown): Promise<StorageImportReport> {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('invalid_payload: import input must be an object')
    const record = input as Record<string, unknown>
    if (typeof record.json !== 'string' || record.json.length === 0) throw new Error('invalid_payload: bundle json is required')
    const before = this.currentRestoreGeneration()
    const base: StorageImportReport = { status: 'invalid', mode: this.activeMode, restoreGenerationReset: false }
    let bundle: PortablePetBundleV1
    try {
      bundle = migratePortablePetBundle(JSON.parse(record.json) as unknown)
    } catch (error) {
      return { ...base, status: 'invalid', message: messageOf(error), errorCode: errorCodeOf(error) }
    }
    const restoreGenerationReset = bundle.authority.restoreGeneration > before
    if (this.activeMode === 'server' && this.remote !== null) {
      if (this.remote.getStatus().role !== 'owner') {
        return { ...base, status: 'rejected', errorCode: 'unauthorized', message: 'only an owner device may import a portable bundle', restoreGenerationReset }
      }
      this.capturedEvents = []
      const allowClamp = record.allowClamp === true
      const rebindLocalSessions = record.rebindLocalSessions === true
      const command = {
        type: 'admin.importPortableBundle' as const,
        payload: { bundle, ...(allowClamp ? { allowClamp: true } : {}), ...(rebindLocalSessions ? { rebindLocalSessions: true } : {}) },
      }
      const result = await this.remote.command(command)
      const report = this.importReportFromResult(result, bundle, before, restoreGenerationReset, 'server')
      if (report.status === 'applied') this.pushActiveProjection()
      return report
    }
    if (this.local.getStatus().authorityState === 'handoff_pending') {
      return {
        ...base,
        status: 'rejected',
        errorCode: 'authority_not_active',
        message: 'local authority is frozen in a pending handoff; retry or roll back first',
        restoreGenerationReset,
      }
    }
    let backupPath: string | undefined
    try {
      backupPath = this.local.createBackup('import') ?? undefined
    } catch (error) {
      return { ...base, status: 'rejected', errorCode: 'backup_failed', message: 'backup before overwrite failed: ' + messageOf(error), restoreGenerationReset }
    }
    const projection = await this.local.importPortableBundle(bundle)
    if (projection === null) {
      return {
        ...base,
        status: 'rejected',
        errorCode: errorCodeOf(new Error(this.local.getStatus().lastError ?? 'import failed')),
        message: this.local.getStatus().lastError ?? 'portable bundle import failed',
        ...(backupPath === undefined ? {} : { backupPath }),
        restoreGenerationReset,
      }
    }
    this.mode = 'local'
    this.mapModeLocal()
    this.persistConfig()
    this.pushActiveProjection()
    this.emitStatus()
    return {
      status: 'applied',
      mode: 'local',
      ...(backupPath === undefined ? {} : { backupPath }),
      restoreGenerationReset,
      restoreGenerationBefore: before,
      restoreGenerationAfter: bundle.authority.restoreGeneration,
      ...(bundle.engine.importClamped ? { importClamped: true, clockSkippedMs: bundle.engine.clockSkippedMs } : {}),
      ...(projection === null ? {} : {}),
    }
  }

  /** Retries a frozen upload or failed server-detach import; never issues a fresh epoch. */
  async retryHandoff(): Promise<StorageStatusView> {
    if (this.pendingUpload !== null && this.remote !== null && this.local.getStatus().authorityState === 'handoff_pending') {
      const result = await this.remote.command(this.pendingUpload.command, { opId: this.pendingUpload.opId })
      const outcome = await this.applyUploadResult(result, this.pendingUpload.bundle, this.pendingUpload.requestedRebind)
      if (outcome === 'applied') this.activateServerMode()
      this.emitStatus()
      return this.status()
    }
    if (this.pendingServerBundle !== null) {
      await this.retryServerImport()
      this.emitStatus()
      return this.status()
    }
    return this.status()
  }

  /**
   * Explicit owner rollback. Reconciles an uncertain upload first (same opId),
   * unfreezes local only on a definitive rejection, and retries a failed
   * server-detach import. Unknown outcomes stay frozen.
   */
  async rollbackHandoff(): Promise<StorageStatusView> {
    if (this.pendingUpload !== null && this.remote !== null && this.local.getStatus().authorityState === 'handoff_pending') {
      let result: CommandResult
      try {
        result = await this.remote.command(this.pendingUpload.command, { opId: this.pendingUpload.opId })
      } catch (error) {
        this.handoffValue = {
          direction: 'local_to_server',
          state: 'frozen',
          retryable: true,
          message: '交接结果未知（' + messageOf(error) + '），保持冻结，未回滚。',
          atWallMs: this.now(),
        }
        this.emitStatus()
        return this.status()
      }
      if (result.status === 'rejected') {
        await this.local.rollbackDetach()
        this.pendingUpload = null
        this.handoffValue = {
          direction: 'local_to_server',
          state: 'rolled_back',
          reason: result.error.code,
          message: '服务器拒绝导入，本机已恢复活动权威：' + result.error.message,
          atWallMs: this.now(),
        }
        this.mapModeLocal()
        this.persistConfig()
        this.pushActiveProjection()
      } else {
        await this.applyUploadResult(result, this.pendingUpload.bundle, this.pendingUpload.requestedRebind)
        this.activateServerMode()
      }
      this.emitStatus()
      return this.status()
    }
    if (this.pendingServerBundle !== null) {
      await this.retryServerImport()
      this.emitStatus()
      return this.status()
    }
    return this.status()
  }

  async createBackup(): Promise<StorageStatusView> {
    this.local.createBackup('manual')
    this.emitStatus()
    return this.status()
  }

  /** Flushes and stops both authorities; safe to call once on quit. */
  async stop(): Promise<void> {
    await this.stopRemote()
    try { await this.local.stop() } catch { /* best effort */ }
  }

  // --- RendererRuntimeHost surface -------------------------------------------------

  async command<K extends CommandKey>(
    command: Extract<PetCommand, { type: K }>,
    options?: { opId?: string },
  ): Promise<CommandResult<K>> {
    if (this.activeMode === 'server' && this.remote !== null) {
      const result = await this.remote.command(command, options)
      this.emitStatus()
      return result
    }
    return this.local.command(command, options)
  }

  async flush(): Promise<void> {
    if (this.activeMode === 'server' && this.remote !== null) return this.remote.flush()
    return this.local.flush()
  }

  async load(): Promise<SaveData> {
    if (this.activeMode === 'server' && this.remote !== null) return this.remote.load()
    return this.local.load()
  }

  getProjection(): RendererProjection | null {
    if (this.activeMode === 'server' && this.remote !== null) return this.remote.getProjection()
    return this.local.getProjection()
  }

  getStatus(): RendererRepositoryStatus {
    if (this.activeMode === 'server' && this.remote !== null) {
      const status = this.remote.getStatus()
      return { ...status, authorityState: status.authority.state === 'active' ? 'active' : 'archived' }
    }
    return this.local.getStatus()
  }

  requestResync(): void {
    if (this.activeMode === 'server' && this.remote !== null) return this.remote.requestResync()
    return this.local.requestResync()
  }

  loadLocalSettings(): DeviceLocalOverlay | Promise<DeviceLocalOverlay> {
    if (this.activeMode === 'server' && this.remote !== null) return this.remote.loadLocalSettings()
    return this.local.loadLocalSettings()
  }

  async updateLocalSettings(value: unknown): Promise<DeviceLocalOverlay> {
    if (this.activeMode === 'server' && this.remote !== null) return this.remote.updateLocalSettings(value)
    return this.local.updateLocalSettings(value)
  }

  async savePatch(patch: SavePatch): Promise<void> {
    if (this.activeMode === 'server') throw new Error('canonical_mutation_blocked: server mode never accepts a SavePatch')
    if (this.local.savePatch === undefined) throw new Error('canonical_mutation_blocked: local runtime does not accept patches')
    await this.local.savePatch(patch)
  }

  async resetPet(): Promise<void> {
    if (this.activeMode === 'server' && this.remote !== null) {
      const result = await this.remote.command({ type: 'pet.reset', payload: {} })
      if (result.status === 'rejected') throw new Error(result.error.code + ': ' + result.error.message)
      return
    }
    if (this.local.reset === undefined) throw new Error('local reset is unavailable')
    await this.local.reset()
  }

  // --- internals -------------------------------------------------------------------

  private weatherCity(): string {
    if (this.activeMode === 'local') {
      const local = this.local.getWeatherCity?.()
      if (typeof local === 'string' && local.length > 0) return local
    }
    return this.lastWeatherCity
  }

  private currentRestoreGeneration(): number {
    if (this.activeMode === 'server' && this.remote !== null) return this.remote.getStatus().authority.restoreGeneration
    return this.local.getStatus().authority.restoreGeneration
  }

  private inferInitialSource(): 'upload-local' | 'use-server' {
    const localHasPet = this.local.getProjection()?.save.havePet === true
    const remoteHasPet = this.remote?.getProjection()?.save.havePet === true
    if (localHasPet && remoteHasPet) {
      throw new Error('initial_source_required: both local and server hold a pet; explicitly choose upload-local or use-server')
    }
    if (localHasPet) return 'upload-local'
    return 'use-server'
  }

  private requireRemoteReady(): void {
    if (this.remote === null) throw new Error('pairing_required: pair this device with a server first')
    if (this.remote.getProjection() === null || this.remote.getStatus().connection !== 'online') {
      throw new Error('offline: the server connection is not ready; wait for online status before switching')
    }
  }

  private async loadRemoteConfig(tokenStore: RemoteTokenStore): Promise<RemoteSyncConfig | null> {
    try {
      return await tokenStore.loadConfig()
    } catch {
      return null
    }
  }

  private async connectStoredRemote(): Promise<boolean> {
    const tokenStore = this.createTokenStore()
    let token: string | null = null
    let config: RemoteSyncConfig | null = null
    try {
      token = await tokenStore.loadToken()
      config = await tokenStore.loadConfig()
    } catch {
      return false
    }
    const serverUrl = this.serverUrl ?? config?.serverUrl
    if (token === null || config === null || serverUrl === undefined || serverUrl.length === 0) {
      this.serverUrl = serverUrl
      return false
    }
    this.pairedFlag = true
    this.tokenStore = tokenStore
    this.remoteConfig = config
    this.serverUrl = serverUrl
    const remote = this.createRemote({ serverUrl, appVersion: this.appVersion, tokenStore })
    try {
      await remote.start()
    } catch {
      try { await remote.stop() } catch { /* best effort */ }
      this.remote = null
      return true // paired but offline: server remains the intended authority
    }
    this.remote = remote
    this.bindRemote(remote)
    return true
  }

  private async stopRemote(): Promise<void> {
    const remote = this.remote
    this.remote = null
    for (const unsubscribe of this.remoteUnsubscribes.splice(0)) {
      try { unsubscribe() } catch { /* best effort */ }
    }
    if (remote !== null) {
      try { await remote.stop() } catch { /* best effort */ }
    }
  }

  private bindRemote(remote: StorageRemoteAuthority): void {
    this.remoteUnsubscribes.push(
      remote.onProjection((projection, events) => {
        if (this.activeMode !== 'server') {
          // Events emitted while an upload is pending still drive the rebind/cancel report.
          if (this.pendingUpload !== null) this.capturedEvents.push(...events)
          return
        }
        this.capturedEvents.push(...events)
        this.noteCancelledSessions(events)
        this.emitView(projection.save)
        this.send(IPC.projection, projection, events)
      }),
      remote.onResync((projection, events) => {
        if (this.activeMode !== 'server') return
        this.capturedEvents.push(...events)
        this.emitView(projection.save)
        this.send(IPC.resync, projection, events)
      }),
      remote.onCommandResult(result => {
        if (this.activeMode !== 'server') return
        this.send(IPC.commandResult, result)
      }),
      remote.onSyncStatus(status => {
        if (this.activeMode !== 'server') return
        this.send(IPC.syncStatus, status)
        this.emitStatus()
      }),
    )
  }

  private activateServerMode(): void {
    this.mode = 'server'
    this.activeMode = 'server'
    this.local.setSendEnabled(false)
    this.persistConfig()
    this.pushActiveProjection()
  }

  private async useServerAuthority(): Promise<void> {
    if (this.local.getStatus().authorityState === 'handoff_pending') {
      await this.local.rollbackDetach()
    }
    await this.local.archiveAuthority('use_server')
    this.handoffValue = {
      direction: 'none',
      state: 'applied',
      message: '使用服务器宠物：本机权威已归档，未上传本机数据。',
      atWallMs: this.now(),
    }
  }

  private async uploadLocalToServer(options: { allowClamp: boolean; rebindLocalSessions: boolean }): Promise<UploadOutcome> {
    const localProjection = this.local.getProjection()
    if (localProjection === null || localProjection.save.havePet === false) {
      throw new Error('local_pet_unavailable: local authority has no pet to upload')
    }
    if (this.remote === null) throw new Error('pairing_required: pair this device with a server first')
    const remoteEpoch = this.remote.getStatus().authority.epoch
    const bundle = await this.local.exportForDetach(remoteEpoch)
    const opId = `handoff-${bundle.authority.handoffId}`
    const authorityState = this.remote.getStatus().authority.state
    const payloadBase = {
      bundle,
      ...(options.allowClamp ? { allowClamp: true } : {}),
      ...(options.rebindLocalSessions ? { rebindLocalSessions: true } : {}),
    }
    const command = authorityState === 'archived'
      ? { type: 'admin.resumeServer' as const, payload: { ...payloadBase, expectedEpoch: bundle.authority.epoch } }
      : { type: 'admin.importPortableBundle' as const, payload: payloadBase }
    this.pendingUpload = { bundle, opId, command, requestedRebind: options.rebindLocalSessions }
    this.capturedEvents = []
    this.handoffValue = {
      direction: 'local_to_server',
      state: 'pending',
      requestedRebind: options.rebindLocalSessions,
      message: authorityState === 'archived'
        ? '本机已冻结，正在通过 admin.resumeServer 恢复服务器权威…'
        : '本机已冻结，正在上传到服务器…',
      atWallMs: this.now(),
    }
    let result: CommandResult
    try {
      result = await this.remote.command(command, { opId })
    } catch (error) {
      this.handoffValue = {
        ...this.handoffValue,
        state: 'frozen',
        retryable: true,
        message: '上传结果未知（' + messageOf(error) + '），本机保持冻结；可重试或回滚。',
        atWallMs: this.now(),
      }
      return 'frozen'
    }
    return this.applyUploadResult(result, bundle, options.rebindLocalSessions)
  }

  private async applyUploadResult(result: CommandResult, _bundle: PortablePetBundleV1, requestedRebind: boolean): Promise<UploadOutcome> {
    if (result.status === 'rejected') {
      this.pendingUpload = null
      await this.local.rollbackDetach()
      this.handoffValue = {
        direction: 'local_to_server',
        state: 'rolled_back',
        reason: result.error.code,
        message: '服务器拒绝导入（' + result.error.code + '），本机已恢复活动权威。',
        atWallMs: this.now(),
      }
      this.mapModeLocal()
      this.persistConfig()
      return 'rolled_back'
    }
    const data = recordOf(result.result)
    this.pendingUpload = null
    this.handoffValue = {
      direction: 'local_to_server',
      state: 'applied',
      requestedRebind,
      rebindReported: requestedRebind,
      cancelledSessionKinds: this.cancelledSessionKinds(),
      ...(typeof data.importClamped === 'boolean' ? { importClamped: data.importClamped } : {}),
      ...(typeof data.clockSkippedMs === 'number' ? { clockSkippedMs: data.clockSkippedMs } : {}),
      ...(typeof data.epoch === 'number' ? { nextEpoch: data.epoch } : {}),
      message: '上传完成，服务器已接管权威。',
      atWallMs: this.now(),
    }
    const nextProjection = this.remote?.getProjection() ?? null
    if (nextProjection !== null) this.emitView(nextProjection.save)
    return 'applied'
  }

  private cancelledSessionKinds(): string[] {
    const kinds = this.cancelledKindsFrom(this.capturedEvents)
    this.capturedEvents = []
    return kinds
  }

  private cancelledKindsFrom(events: readonly OrderedEvent[]): string[] {
    const kinds: string[] = []
    for (const event of events) {
      if (event.type !== 'game.sessionSettled') continue
      const payload = event.payload as { status?: string; kind?: string } | null
      if (payload === null || payload.status === 'active') continue
      const kind = payload.kind ?? 'session'
      if (kinds.includes(kind) === false) kinds.push(kind)
    }
    return kinds
  }

  /** Late-replayed session settlements still reach the local actor rebind/cancel report. */
  private noteCancelledSessions(events: readonly OrderedEvent[]): void {
    const kinds = this.cancelledKindsFrom(events)
    if (kinds.length === 0) return
    const existing = this.handoffValue.cancelledSessionKinds ?? []
    const merged = [...existing]
    for (const kind of kinds) if (merged.includes(kind) === false) merged.push(kind)
    this.handoffValue = { ...this.handoffValue, rebindReported: true, cancelledSessionKinds: merged }
  }

  private importReportFromResult(
    result: CommandResult,
    bundle: PortablePetBundleV1,
    before: number,
    restoreGenerationReset: boolean,
    mode: StorageMode,
  ): StorageImportReport {
    if (result.status === 'rejected') {
      return { status: 'rejected', mode, errorCode: result.error.code, message: result.error.message, restoreGenerationReset }
    }
    const data = recordOf(result.result)
    return {
      status: 'applied',
      mode,
      restoreGenerationReset,
      restoreGenerationBefore: before,
      restoreGenerationAfter: bundle.authority.restoreGeneration,
      ...(typeof data.importClamped === 'boolean' ? { importClamped: data.importClamped } : {}),
      ...(typeof data.clockSkippedMs === 'number' ? { clockSkippedMs: data.clockSkippedMs } : {}),
      ...(typeof data.effectiveAnchorWallMs === 'number' ? { effectiveAnchorWallMs: data.effectiveAnchorWallMs } : {}),
      ...(typeof data.epoch === 'number' ? { nextEpoch: data.epoch } : {}),
    }
  }

  private async switchToLocal(): Promise<StorageStatusView> {
    if (this.activeMode === 'local') {
      this.mode = 'local'
      this.mapModeLocal()
      this.persistConfig()
      this.emitStatus()
      return this.status()
    }
    const remote = this.remote
    if (remote === null) {
      if (this.pairedFlag) {
        throw new Error('offline: owner detach requires a connected server; local stays fenced read-only')
      }
      this.mode = 'local'
      this.mapModeLocal()
      this.persistConfig()
      this.emitStatus()
      return this.status()
    }
    if (remote.getStatus().role !== 'owner') {
      throw new Error('unauthorized: only an owner device can switch the pet back to local mode')
    }
    let result: CommandResult
    try {
      result = await remote.command({ type: 'admin.exportForDetach', payload: {} })
    } catch (error) {
      this.handoffValue = {
        direction: 'server_to_local',
        state: 'failed',
        retryable: true,
        message: '拉取服务器分离包失败：' + messageOf(error),
        atWallMs: this.now(),
      }
      this.emitStatus()
      return this.status()
    }
    if (result.status === 'rejected') {
      this.handoffValue = {
        direction: 'server_to_local',
        state: 'failed',
        reason: result.error.code,
        retryable: true,
        message: '服务器拒绝分离：' + result.error.message,
        atWallMs: this.now(),
      }
      this.emitStatus()
      return this.status()
    }
    let bundle: PortablePetBundleV1
    try {
      bundle = migratePortablePetBundle(recordOf(result.result).bundle)
    } catch (error) {
      this.handoffValue = {
        direction: 'server_to_local',
        state: 'frozen',
        retryable: true,
        message: '服务器分离包校验失败，未写入本机：' + messageOf(error),
        atWallMs: this.now(),
      }
      this.emitStatus()
      return this.status()
    }
    this.pendingServerBundle = { bundle }
    await this.stopRemote()
    this.activeMode = 'local'
    this.local.setSendEnabled(true)
    await this.local.loadFenced()
    this.handoffValue = {
      direction: 'server_to_local',
      state: 'pending',
      message: '服务器已归档，正在把分离包导入本机…',
      atWallMs: this.now(),
    }
    const applied = await this.importDetachedBundle(bundle)
    if (applied) {
      this.pendingServerBundle = null
      this.mode = 'local'
      this.mapModeLocal()
    } else {
      // Keep the requested mode on server so a restart never starts the stale local authority;
      // the server stays archived and the local projection stays read-only for a retry.
      this.mode = 'server'
      this.activeMode = 'local'
      this.local.setSendEnabled(true)
    }
    this.persistConfig()
    this.pushActiveProjection()
    this.emitStatus()
    return this.status()
  }

  private async importDetachedBundle(bundle: PortablePetBundleV1): Promise<boolean> {
    try {
      this.local.createBackup('import')
    } catch (error) {
      this.handoffValue = {
        direction: 'server_to_local',
        state: 'frozen',
        retryable: true,
        message: '导入前备份失败，本机保持只读：' + messageOf(error),
        atWallMs: this.now(),
      }
      return false
    }
    const projection = await this.local.importPortableBundle(bundle, {
      expectedAuthorityId: bundle.authority.authorityId,
      expectedRestoreGeneration: bundle.authority.restoreGeneration,
      expectedEpoch: bundle.authority.epoch,
      expectedRevision: bundle.authority.revision,
      expectedEventSeq: bundle.authority.eventSeq,
    })
    if (projection === null) {
      this.handoffValue = {
        direction: 'server_to_local',
        state: 'frozen',
        retryable: true,
        reason: 'local_import_failed',
        message: '本机导入失败，保持只读；服务器保持归档：' + (this.local.getStatus().lastError ?? 'unknown'),
        atWallMs: this.now(),
      }
      return false
    }
    this.handoffValue = {
      direction: 'server_to_local',
      state: 'applied',
      nextEpoch: this.local.getStatus().authority.epoch,
      restoreGenerationBefore: bundle.authority.restoreGeneration,
      restoreGenerationAfter: bundle.authority.restoreGeneration,
      message: '服务器已归档，本机已接管权威。',
      atWallMs: this.now(),
    }
    return true
  }

  private async retryServerImport(): Promise<void> {
    const pending = this.pendingServerBundle
    if (pending === null) return
    const applied = await this.importDetachedBundle(pending.bundle)
    if (applied) this.pendingServerBundle = null
    this.emitStatus()
  }

  private mapModeLocal(): void {
    this.activeMode = 'local'
    this.local.setSendEnabled(true)
  }

  private pushActiveProjection(): void {
    const projection = this.getProjection()
    if (projection === null) return
    this.emitView(projection.save)
    this.send(IPC.resync, projection, [])
  }

  private emitView(save: SaveData): void {
    for (const listener of this.viewListeners) listener(clone(save))
  }

  private emitStatus(): void {
    const status = this.status()
    for (const listener of this.statusListeners) listener(clone(status))
    this.send(IPC.storageStatusEvent, status)
  }

  private emitDevices(view: StorageDeviceListView): void {
    for (const listener of this.devicesListeners) listener(clone(view))
    this.send(IPC.storageDevicesEvent, view)
  }

  private send(channel: string, ...payload: unknown[]): void {
    if (this.window === null) return
    if (this.window.isDestroyed?.() === true) return
    this.window.webContents.send(channel, ...payload)
  }

  private readConfig() {
    const path = this.storageConfigPath
    if (existsSync(path) === false) return defaultStorageConfig()
    try {
      return parseStorageConfig(JSON.parse(readFileSync(path, 'utf8')) as unknown)
    } catch {
      return defaultStorageConfig()
    }
  }

  private persistConfig(): void {
    atomicWrite(this.storageConfigPath, JSON.stringify({
      format: STORAGE_CONFIG_FORMAT,
      schemaVersion: STORAGE_CONFIG_SCHEMA_VERSION,
      mode: this.mode,
      ...(this.serverUrl === undefined ? {} : { serverUrl: this.serverUrl }),
      ...(this.deviceLabel === undefined ? {} : { deviceLabel: this.deviceLabel }),
    }, null, 2))
  }

  private async commandAuthority<K extends CommandKey>(command: Extract<PetCommand, { type: K }>): Promise<CommandResult<K>> {
    if (this.activeMode === 'server' && this.remote !== null) return this.remote.command(command)
    return this.local.command(command)
  }
}
