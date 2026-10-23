import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite } from './atomic-write'
import { IPC } from '../shared/ipc'
import type { SaveData, SavePatch } from '../shared/save'
import type { OrderedEvent } from '../shared/pet-runtime/events'
import { assertTimeZone } from '../shared/pet-runtime/time'
import type { CommandKey, CommandResult, DeviceInfo, PetCommand } from '../shared/sync/protocol'
import type { PortablePetBundleV1 } from '../shared/sync/portable'
import { migratePortablePetBundle } from '../shared/sync/portable'
import { commandResultData, commandResultError } from '../shared/sync/command-result'
import { planPortableImportPlan, type PortableImportCurrentAuthority } from '../shared/sync/portable-import-plan'
import { assertDeviceLocalOverlay, type DeviceLocalOverlay } from '../shared/sync/data-boundary'
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
  type StorageHandoffDirection,
  type StorageHandoffReport,
  type StorageHandoffState,
  type StorageImportInput,
  type StorageImportReport,
  type StorageMigrationStatus,
  type StorageMode,
  type StoragePairInput,
  type StorageSetModeInput,
  type StorageStatusView,
} from '../shared/storage'
import type { RemoteSyncConfig, RemoteTokenStore } from './remote-repository'
import { assertRemoteServerUrl } from './remote-endpoint'
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
  getWeatherCity(): string
  command<K extends CommandKey>(
    command: Extract<PetCommand, { type: K }>,
    options?: { opId?: string },
  ): Promise<CommandResult<K>>
  setAdvanceWhileEmpty(enabled: boolean): Promise<void>
  exportBundle(): Promise<PortablePetBundleV1>
  requestResync(): void
  loadLocalSettings(): Promise<DeviceLocalOverlay>
  updateLocalSettings(value: unknown): Promise<DeviceLocalOverlay>
  /** True when startup restored the persisted RemoteProjectionCacheV2 overlay. */
  hasProjectionCache?(): boolean
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
  /** Device-local presentation/settings seeded into the remote projection cache. */
  deviceOverlay?: DeviceLocalOverlay
}

export interface StorageWindowLike {
  isDestroyed?(): boolean
  webContents: {
    send(channel: string, ...args: unknown[]): void
    mainFrame?: unknown
    getURL?(): string
  }
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
  archiveReason: 'use_server' | 'mode_switch'
}

interface PendingServerBundle {
  bundle: PortablePetBundleV1
  /** Device-local values read from the remote before detach; merged after a successful local import. */
  remoteOverlay: DeviceLocalOverlay | null
}

const STORAGE_HANDOFF_FILE = 'storage-handoff.json'
const STORAGE_HANDOFF_FORMAT = 'qqpet-storage-handoff' as const
const STORAGE_HANDOFF_SCHEMA_VERSION = 1 as const

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

function requiredObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid_payload: ' + label + ' must be an object')
  }
  return value as Record<string, unknown>
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error('invalid_payload: ' + key + ' must be a boolean')
  return value
}

function optionalNonNegativeInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || Number.isSafeInteger(value) === false || value < 0) {
    throw new Error('invalid_payload: ' + key + ' must be a non-negative safe integer')
  }
  return value
}

export function validateStoragePairInput(value: unknown): StoragePairInput {
  const record = requiredObject(value, 'pairing input')
  if (typeof record.serverUrl !== 'string' || record.serverUrl.length === 0) {
    throw new Error('invalid_payload: serverUrl must be a ws:// or wss:// URL')
  }
  assertRemoteServerUrl(record.serverUrl)
  if (typeof record.code !== 'string' || record.code.length === 0) throw new Error('invalid_payload: pairing code is required')
  if (typeof record.deviceLabel !== 'string' || record.deviceLabel.length === 0) throw new Error('invalid_payload: device label is required')
  return { serverUrl: record.serverUrl, code: record.code, deviceLabel: record.deviceLabel }
}

export function validateStorageSetModeInput(value: unknown): StorageSetModeInput {
  const record = requiredObject(value, 'mode input')
  if (record.mode !== 'local' && record.mode !== 'server') throw new Error('invalid_payload: mode must be local or server')
  if (record.initialSource !== undefined && record.initialSource !== 'upload-local' && record.initialSource !== 'use-server') {
    throw new Error('invalid_payload: initialSource must be upload-local or use-server')
  }
  if (record.serverUrl !== undefined) {
    if (typeof record.serverUrl !== 'string' || record.serverUrl.length === 0) throw new Error('invalid_payload: serverUrl must be a string')
    assertRemoteServerUrl(record.serverUrl)
  }
  if (record.pairingCode !== undefined && (typeof record.pairingCode !== 'string' || record.pairingCode.length === 0)) {
    throw new Error('invalid_payload: pairingCode must be a non-empty string')
  }
  if (record.deviceLabel !== undefined && (typeof record.deviceLabel !== 'string' || record.deviceLabel.length === 0)) {
    throw new Error('invalid_payload: deviceLabel must be a non-empty string')
  }
  const allowClamp = optionalBoolean(record, 'allowClamp')
  const rebindLocalSessions = optionalBoolean(record, 'rebindLocalSessions')
  const expectedEpoch = optionalNonNegativeInteger(record, 'expectedEpoch')
  return {
    mode: record.mode,
    ...(record.serverUrl === undefined ? {} : { serverUrl: record.serverUrl }),
    ...(record.pairingCode === undefined ? {} : { pairingCode: record.pairingCode }),
    ...(record.deviceLabel === undefined ? {} : { deviceLabel: record.deviceLabel }),
    ...(record.initialSource === undefined ? {} : { initialSource: record.initialSource }),
    ...(allowClamp === undefined ? {} : { allowClamp }),
    ...(rebindLocalSessions === undefined ? {} : { rebindLocalSessions }),
    ...(expectedEpoch === undefined ? {} : { expectedEpoch }),
  }
}

export function validateStorageImportInput(value: unknown): StorageImportInput {
  const record = requiredObject(value, 'import input')
  if (typeof record.json !== 'string' || record.json.length === 0) throw new Error('invalid_payload: bundle json is required')
  const allowClamp = optionalBoolean(record, 'allowClamp')
  const rebindLocalSessions = optionalBoolean(record, 'rebindLocalSessions')
  const expectedEpoch = optionalNonNegativeInteger(record, 'expectedEpoch')
  return {
    json: record.json,
    ...(allowClamp === undefined ? {} : { allowClamp }),
    ...(rebindLocalSessions === undefined ? {} : { rebindLocalSessions }),
    ...(expectedEpoch === undefined ? {} : { expectedEpoch }),
  }
}

export interface StorageImportDialogOptions {
  allowClamp?: boolean
  rebindLocalSessions?: boolean
}

export function validateStorageImportDialogOptions(value: unknown): StorageImportDialogOptions {
  if (value === undefined) return {}
  const record = requiredObject(value, 'import options')
  const allowClamp = optionalBoolean(record, 'allowClamp')
  const rebindLocalSessions = optionalBoolean(record, 'rebindLocalSessions')
  return {
    ...(allowClamp === undefined ? {} : { allowClamp }),
    ...(rebindLocalSessions === undefined ? {} : { rebindLocalSessions }),
  }
}

export function validateStorageDeviceId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('invalid_payload: deviceId is required')
  return value
}

export function validateStorageTimeZone(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('invalid_payload: timeZone is required')
  assertTimeZone(value)
  return value
}

export function validateStorageWeatherCity(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invalid_payload: city must be a string')
  return value
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
  private pendingServerBundle: PendingServerBundle | null = null
  private capturedEvents: OrderedEvent[] = []
  private initialized = false
  private initialization: Promise<StorageStatusView> | null = null
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

  get pendingHandoffPath(): string {
    return join(this.userDataPath, STORAGE_HANDOFF_FILE)
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

  /**
   * Admin IPC additionally requires the trusted window's main frame and,
   * when both URLs are available, the same origin as the current renderer.
   */
  acceptsSenderFrame(sender: unknown, frame: unknown): boolean {
    if (this.acceptsSender(sender) === false) return false
    if (typeof frame !== 'object' || frame === null) return false
    const candidate = frame as { parent?: unknown; url?: unknown }
    if (candidate.parent !== null && candidate.parent !== undefined) return false
    const windowMainFrame = this.window?.webContents.mainFrame
    if (windowMainFrame !== undefined && frame !== windowMainFrame) return false
    const senderMainFrame = (sender as { mainFrame?: unknown }).mainFrame
    if (senderMainFrame !== undefined && frame !== senderMainFrame) return false
    if (typeof candidate.url !== 'string' || candidate.url.length === 0) return false
    let frameOrigin: string
    try {
      frameOrigin = new URL(candidate.url).origin
    } catch {
      return false
    }
    const getURL = (sender as { getURL?: () => string }).getURL
    if (typeof getURL === 'function') {
      const current = getURL.call(sender)
      if (typeof current === 'string' && current.length > 0) {
        try {
          if (frameOrigin !== new URL(current).origin) return false
        } catch {
          return false
        }
      }
    }
    return true
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
  initialize(): Promise<StorageStatusView> {
    if (this.initialization !== null) return this.initialization
    this.initialized = true
    this.initialization = this.initializeNow()
    return this.initialization
  }

  /** Resolves once the single authority has been chosen and started. */
  private async whenReady(): Promise<void> {
    if (this.initialized === false) {
      await this.initialize()
      return
    }
    if (this.initialization !== null) await this.initialization
  }

  private async initializeNow(): Promise<StorageStatusView> {
    this.restorePendingHandoffState()
    const pendingAtStartup = this.pendingUpload !== null || this.pendingServerBundle !== null
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
        // A restored RemoteProjectionCacheV2 already holds the newest device-local
        // values; the archived local document may be older after a server-mode
        // restart. Seed only when there is no cache to protect.
        if (pendingAtStartup === false && this.remote !== null && this.remote.hasProjectionCache?.() !== true) {
          await this.seedRemoteOverlay(this.remote, true)
        }
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
    await this.reconcilePendingHandoffAfterStartup()
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
    const parsed = validateStorageSetModeInput(input)
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
    if (this.remote !== null) await this.seedRemoteOverlay(this.remote)
    const source = parsed.initialSource ?? this.inferInitialSource()
    if (source === 'upload-local') {
      const outcome = await this.uploadLocalToServer({
        allowClamp: parsed.allowClamp === true,
        rebindLocalSessions: parsed.rebindLocalSessions === true,
        archiveReason: 'mode_switch',
      })
      if (outcome !== 'applied') {
        this.mapModeLocal()
        this.persistConfig()
        this.emitStatus()
        return this.status()
      }
    } else {
      const outcome = await this.useServerAuthority({
        allowClamp: parsed.allowClamp === true,
        rebindLocalSessions: parsed.rebindLocalSessions === true,
        ...(parsed.expectedEpoch === undefined ? {} : { expectedEpoch: parsed.expectedEpoch }),
      })
      if (outcome !== 'applied') {
        this.mapModeLocal()
        this.persistConfig()
        this.emitStatus()
        return this.status()
      }
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
    const pairing = validateStoragePairInput(input)
    await this.stopRemote()
    const tokenStore = this.createTokenStore()
    const localOverlay = this.localOverlayForRemote()
    const remote = this.createRemote({
      serverUrl: pairing.serverUrl,
      appVersion: this.appVersion,
      tokenStore,
      pair: { code: pairing.code, deviceLabel: pairing.deviceLabel },
      ...(localOverlay === null ? {} : { deviceOverlay: localOverlay }),
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
    // Welcome handling persists the server-assigned device id asynchronously;
    // flush it before reading the config back into the status surface.
    await remote.flush()
    this.remoteConfig = await this.loadRemoteConfig(tokenStore)
    this.bindRemote(remote)
    await this.seedRemoteOverlay(remote)
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
      const error = commandResultError(result)
      if (error !== null) return { ...empty, error: error.message }
      const devices = (commandResultData(result) as { devices?: DeviceInfo[] } | undefined)?.devices ?? []
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
    const targetDeviceId = validateStorageDeviceId(deviceId)
    if (this.remote === null) throw new Error('offline: pair a server first')
    if (this.remote.getStatus().role !== 'owner') throw new Error('unauthorized: only an owner device can revoke devices')
    const result = await this.remote.command({ type: 'device.revoke', payload: { deviceId: targetDeviceId } })
    const error = commandResultError(result)
    if (error !== null) throw new Error(error.code + ': ' + error.message)
    return this.listDevices()
  }

  async setAdvanceWhileEmpty(enabled: boolean): Promise<StorageStatusView> {
    await this.whenReady()
    if (this.activeMode === 'server' && this.remote !== null) {
      await this.remote.setAdvanceWhileEmpty(enabled)
    } else {
      await this.local.setAdvanceWhileEmpty(enabled)
    }
    this.emitStatus()
    return this.status()
  }

  async setTimeZone(timeZone: unknown): Promise<StorageStatusView> {
    const next = validateStorageTimeZone(timeZone)
    const result = await this.commandAuthority({ type: 'server.setTimeZone', payload: { timeZone: next } })
    const error = commandResultError(result)
    if (error !== null) throw new Error(error.code + ': ' + error.message)
    this.emitStatus()
    return this.status()
  }

  async setWeatherCity(city: unknown): Promise<StorageStatusView> {
    const next = validateStorageWeatherCity(city).trim()
    const result = await this.commandAuthority({ type: 'server.setWeatherCity', payload: { city: next } })
    const error = commandResultError(result)
    if (error !== null) throw new Error(error.code + ': ' + error.message)
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
    const parsed = validateStorageImportInput(input)
    const before = this.currentRestoreGeneration()
    const base: StorageImportReport = { status: 'invalid', mode: this.activeMode, restoreGenerationReset: false }
    let bundle: PortablePetBundleV1
    try {
      bundle = migratePortablePetBundle(JSON.parse(parsed.json) as unknown)
    } catch (error) {
      return { ...base, status: 'invalid', message: messageOf(error), errorCode: errorCodeOf(error) }
    }
    const restoreGenerationReset = bundle.authority.restoreGeneration > before
    if (this.activeMode === 'server' && this.remote !== null) {
      if (this.remote.getStatus().role !== 'owner') {
        return { ...base, status: 'rejected', errorCode: 'unauthorized', message: 'only an owner device may import a portable bundle', restoreGenerationReset }
      }
      this.capturedEvents = []
      const allowClamp = parsed.allowClamp === true
      const rebindLocalSessions = parsed.rebindLocalSessions === true
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
    const current = this.localPortableImportAuthority(bundle.originLocalDeviceId)
    if (current === null) {
      return { ...base, status: 'rejected', errorCode: 'authority_not_active', message: 'local authority is not loaded', restoreGenerationReset }
    }
    const allowClamp = parsed.allowClamp === true
    const rebindLocalSessions = parsed.rebindLocalSessions === true
    const planned = planPortableImportPlan({
      bundle,
      current,
      wallNowMs: this.now(),
      allowClamp,
      rebindLocalSessions,
      destinationLocalDeviceId: current.localDeviceId,
      ...(parsed.expectedEpoch === undefined ? {} : { expectedEpoch: parsed.expectedEpoch }),
    })
    if (planned.ok === false) {
      return { ...base, status: 'rejected', errorCode: planned.code, message: planned.message, restoreGenerationReset }
    }
    const plan = planned.plan
    const plannedBundle: PortablePetBundleV1 = {
      ...bundle,
      engine: plan.engine,
      shared: plan.engine.save,
    }
    let backupPath: string | undefined
    try {
      backupPath = this.local.createBackup('import') ?? undefined
    } catch (error) {
      return { ...base, status: 'rejected', errorCode: 'backup_failed', message: 'backup before overwrite failed: ' + messageOf(error), restoreGenerationReset }
    }
    const projection = await this.local.importPortableBundle(plannedBundle)
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
      restoreGenerationAfter: plan.restoreGeneration,
      ...(plan.importClamped ? { importClamped: true, clockSkippedMs: plan.clockSkippedMs } : {}),
      effectiveAnchorWallMs: plan.effectiveAnchorWallMs,
      rebindRequested: rebindLocalSessions,
      cancelledSessionKinds: plan.cancelledSessionKinds,
      nextEpoch: plan.nextEpoch,
    }
  }

  /** Retries a frozen upload or failed server-detach import; never issues a fresh epoch. */
  async retryHandoff(): Promise<StorageStatusView> {
    if (this.pendingUpload !== null && this.local.getStatus().authorityState === 'handoff_pending') {
      if (await this.ensurePendingUploadRemote() === false) {
        this.emitStatus()
        return this.status()
      }
      const remote = this.remote
      if (remote !== null) {
        const pending = this.pendingUpload
        let result: CommandResult
        try {
          result = await remote.command(pending.command, { opId: pending.opId })
        } catch (error) {
          this.handoffValue = {
            direction: 'local_to_server',
            state: 'frozen',
            retryable: true,
            message: '交接结果未知（' + messageOf(error) + '），保持冻结，可重试或回滚。',
            atWallMs: this.now(),
          }
          try { this.persistPendingHandoffState() } catch { /* keep the in-memory frozen state */ }
          this.emitStatus()
          return this.status()
        }
        await this.applyUploadResult(result, pending.archiveReason, pending.requestedRebind)
      }
      this.emitStatus()
      return this.status()
    }
    if (this.pendingUpload !== null && this.local.getStatus().authorityState === 'archived') {
      await this.finalizeArchivedPendingUpload()
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
    if (this.pendingUpload !== null && this.local.getStatus().authorityState === 'handoff_pending') {
      if (await this.ensurePendingUploadRemote() === false) {
        this.emitStatus()
        return this.status()
      }
      const remote = this.remote
      if (remote === null) {
        this.emitStatus()
        return this.status()
      }
      let result: CommandResult
      try {
        result = await remote.command(this.pendingUpload.command, { opId: this.pendingUpload.opId })
      } catch (error) {
        this.handoffValue = {
          direction: 'local_to_server',
          state: 'frozen',
          retryable: true,
          message: '交接结果未知（' + messageOf(error) + '），保持冻结，未回滚。',
          atWallMs: this.now(),
        }
        try { this.persistPendingHandoffState() } catch { /* keep the in-memory frozen state */ }
        this.emitStatus()
        return this.status()
      }
      const resultError = commandResultError(result)
      if (resultError !== null) {
        await this.local.rollbackDetach()
        this.pendingUpload = null
        this.clearPersistedPendingHandoffState()
        this.handoffValue = {
          direction: 'local_to_server',
          state: 'rolled_back',
          reason: resultError.code,
          message: '服务器拒绝导入，本机已恢复活动权威：' + resultError.message,
          atWallMs: this.now(),
        }
        this.mapModeLocal()
        this.persistConfig()
        this.pushActiveProjection()
      } else {
        const pending = this.pendingUpload
        await this.applyUploadResult(result, pending.archiveReason, pending.requestedRebind)
      }
      this.emitStatus()
      return this.status()
    }
    if (this.pendingUpload !== null && this.local.getStatus().authorityState === 'archived') {
      await this.finalizeArchivedPendingUpload()
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
    await this.whenReady()
    if (this.activeMode === 'server' && this.remote !== null) {
      const result = await this.remote.command(command, options)
      this.emitStatus()
      return result
    }
    return this.local.command(command, options)
  }

  async flush(): Promise<void> {
    await this.whenReady()
    if (this.activeMode === 'server' && this.remote !== null) return this.remote.flush()
    return this.local.flush()
  }

  async load(): Promise<SaveData> {
    await this.whenReady()
    if (this.activeMode === 'server' && this.remote !== null) {
      try {
        return await this.remote.load()
      } catch (error) {
        if (this.remote.getStatus().notice === 'device_revoked') {
          // A revoked reconnect is a terminal authority rejection, not a
          // transient offline state. Keep the window usable for the explicit
          // error/read-only banner, but never fall back to a remote writer.
          return await this.local.load()
        }
        throw error
      }
    }
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
    void this.whenReady().then(() => {
      if (this.activeMode === 'server' && this.remote !== null) return this.remote.requestResync()
      return this.local.requestResync()
    })
  }

  /** C7 compatibility: replay the accepted status after a renderer resync ask. */
  replayStatus(): void {
    if (this.activeMode === 'server' && this.remote !== null) this.send(IPC.syncStatus, this.remote.getStatus())
    else this.send(IPC.syncStatus, this.local.getStatus())
  }

  async loadLocalSettings(): Promise<DeviceLocalOverlay> {
    await this.whenReady()
    if (this.activeMode === 'server' && this.remote !== null) return this.remote.loadLocalSettings()
    return this.local.loadLocalSettings()
  }

  async updateLocalSettings(value: unknown): Promise<DeviceLocalOverlay> {
    await this.whenReady()
    if (this.activeMode === 'server' && this.remote !== null) return this.remote.updateLocalSettings(value)
    return this.local.updateLocalSettings(value)
  }

  async savePatch(patch: SavePatch): Promise<void> {
    await this.whenReady()
    if (this.activeMode === 'server') throw new Error('canonical_mutation_blocked: server mode never accepts a SavePatch')
    if (this.local.savePatch === undefined) throw new Error('canonical_mutation_blocked: local runtime does not accept patches')
    await this.local.savePatch(patch)
  }

  async resetPet(): Promise<void> {
    await this.whenReady()
    if (this.activeMode === 'server' && this.remote !== null) {
      const result = await this.remote.command({ type: 'pet.reset', payload: {} })
      const error = commandResultError(result)
      if (error !== null) throw new Error(error.code + ': ' + error.message)
      return
    }
    if (this.local.reset === undefined) throw new Error('local reset is unavailable')
    await this.local.reset()
  }

  // --- internals -------------------------------------------------------------------

  private weatherCity(): string {
    if (this.activeMode === 'server') {
      if (this.remote !== null) {
        const canonical = this.remote.getWeatherCity()
        this.lastWeatherCity = canonical
        return canonical
      }
      return this.lastWeatherCity
    }
    const local = this.local.getWeatherCity?.()
    return typeof local === 'string' ? local : this.lastWeatherCity
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

  private localOverlayForRemote(): DeviceLocalOverlay | null {
    try {
      return clone(this.local.loadLocalSettings())
    } catch {
      return null
    }
  }

  private overlayPatch(overlay: DeviceLocalOverlay): {
    petInfo: DeviceLocalOverlay['petInfo']
    settings: DeviceLocalOverlay['settings']
    presentation?: NonNullable<DeviceLocalOverlay['presentation']>
  } {
    return {
      petInfo: clone(overlay.petInfo),
      settings: clone(overlay.settings),
      ...(overlay.presentation === undefined ? {} : { presentation: clone(overlay.presentation) }),
    }
  }

  /** Device-local values ride only through the RemoteProjectionCacheV2, never a canonical command. */
  private async seedRemoteOverlay(remote: StorageRemoteAuthority, flush = false): Promise<void> {
    const overlay = this.localOverlayForRemote()
    if (overlay === null) return
    try {
      await remote.updateLocalSettings(this.overlayPatch(overlay))
      if (flush) await remote.flush()
    } catch {
      // Overlay persistence is defense-in-depth; it must never block authority pairing.
    }
  }

  private async mergeRemoteOverlayIntoLocal(overlay: DeviceLocalOverlay): Promise<void> {
    try {
      await this.local.updateLocalSettings(this.overlayPatch(overlay))
    } catch {
      // The imported canonical authority remains valid even if a device-only merge fails.
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
    try {
      assertRemoteServerUrl(serverUrl)
    } catch {
      // An unsafe persisted endpoint is treated as unpaired; never hand it to a transport.
      return false
    }
    this.pairedFlag = true
    this.tokenStore = tokenStore
    this.remoteConfig = config
    this.serverUrl = serverUrl
    const localOverlay = this.localOverlayForRemote()
    const remote = this.createRemote({
      serverUrl,
      appVersion: this.appVersion,
      tokenStore,
      ...(localOverlay === null ? {} : { deviceOverlay: localOverlay }),
    })
    try {
      await remote.start()
    } catch {
      const status = remote.getStatus()
      if (status.notice === 'device_revoked') {
        // Keep the terminal auth failure visible to the renderer. Dropping the
        // repository here would turn a definitive reconnect rejection into a
        // generic offline status and hide the server's revoked-device verdict.
        this.remote = remote
        this.bindRemote(remote)
        return true
      }
      try { await remote.stop() } catch { /* best effort */ }
      this.remote = null
      return true // paired but offline: server remains the intended authority
    }
    this.remote = remote
    this.bindRemote(remote)
    return true
  }

  /**
   * A restart may have restored an upload journal while the initial dial was
   * offline. Retry/rollback are user-visible recovery entry points, so they
   * make one fresh dial attempt and surface the still-offline state instead of
   * silently returning the unchanged frozen status forever.
   */
  private async ensurePendingUploadRemote(): Promise<boolean> {
    if (this.remote === null) {
      try { await this.connectStoredRemote() } catch { /* reported as offline below */ }
    }
    if (this.remote !== null && this.remote.getStatus().connection === 'online') return true
    this.handoffValue = {
      ...this.handoffValue,
      direction: this.handoffValue.direction === 'none' ? 'local_to_server' : this.handoffValue.direction,
      state: 'frozen',
      retryable: true,
      message: '仍处于离线状态，无法连接服务器；本机保持冻结，恢复连接后可重试或回滚。',
      atWallMs: this.now(),
    }
    try { this.persistPendingHandoffState() } catch { /* keep the in-memory frozen state */ }
    return false
  }

  /** Complete an upload that already archived local but lost its config write. */
  private async finalizeArchivedPendingUpload(): Promise<void> {
    const pending = this.pendingUpload
    if (pending === null) return
    if (await this.ensurePendingUploadRemote() === false) return
    if (this.remote === null || this.remote.getStatus().authority.state !== 'active') {
      this.handoffValue = {
        ...this.handoffValue,
        direction: 'local_to_server',
        state: 'frozen',
        retryable: true,
        message: '本机已归档，但服务器权威尚未恢复为活动状态；保持冻结，待服务器可用后重试。',
        atWallMs: this.now(),
      }
      try { this.persistPendingHandoffState() } catch { /* keep the in-memory frozen state */ }
      return
    }
    await this.finalizeAppliedUpload(pending.requestedRebind)
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

  private async useServerAuthority(options: {
    allowClamp: boolean
    rebindLocalSessions: boolean
    expectedEpoch?: number
  }): Promise<UploadOutcome> {
    if (this.local.getStatus().authorityState === 'handoff_pending') {
      await this.local.rollbackDetach()
    }
    if (this.remote === null) throw new Error('pairing_required: pair this device with a server first')
    const authorityState = this.remote.getStatus().authority.state
    if (authorityState === 'active') {
      await this.local.archiveAuthority('use_server')
      this.clearPersistedPendingHandoffState()
      this.handoffValue = {
        direction: 'none',
        state: 'applied',
        message: '使用服务器宠物：本机权威已归档，未上传本机数据。',
        atWallMs: this.now(),
      }
      return 'applied'
    }
    if (authorityState === 'archived') {
      // Never archive the only active local copy just because the server cache
      // exists. The archived server must first accept admin.resumeServer with
      // this exact local bundle; only an applied result permits local archiving.
      const outcome = await this.uploadLocalToServer({
        allowClamp: options.allowClamp,
        rebindLocalSessions: options.rebindLocalSessions,
        archiveReason: 'use_server',
        ...(options.expectedEpoch === undefined ? {} : { expectedEpoch: options.expectedEpoch }),
      })
      if (outcome === 'applied') {
        this.handoffValue = {
          ...this.handoffValue,
          message: '服务器权威已恢复，本机权威已归档。',
        }
      }
      return outcome
    }
    throw new Error('authority_not_active: server authority is not active or archived')
  }

  private async uploadLocalToServer(options: {
    allowClamp: boolean
    rebindLocalSessions: boolean
    archiveReason: 'use_server' | 'mode_switch'
    expectedEpoch?: number
  }): Promise<UploadOutcome> {
    const localProjection = this.local.getProjection()
    if (localProjection === null || localProjection.save.havePet === false) {
      throw new Error('local_pet_unavailable: local authority has no pet to upload')
    }
    if (this.remote === null) throw new Error('pairing_required: pair this device with a server first')
    const authorityState = this.remote.getStatus().authority.state
    if (authorityState !== 'active' && authorityState !== 'archived') {
      throw new Error('authority_not_active: server authority cannot accept a portable bundle')
    }
    const remoteEpoch = this.remote.getStatus().authority.epoch
    const bundle = await this.local.exportForDetach(remoteEpoch)
    const opId = `handoff-${bundle.authority.handoffId}`
    const payloadBase = {
      bundle,
      ...(options.allowClamp ? { allowClamp: true } : {}),
      ...(options.rebindLocalSessions ? { rebindLocalSessions: true } : {}),
    }
    const expectedEpoch = options.expectedEpoch ?? bundle.authority.epoch
    const command = authorityState === 'archived'
      ? { type: 'admin.resumeServer' as const, payload: { ...payloadBase, expectedEpoch } }
      : { type: 'admin.importPortableBundle' as const, payload: payloadBase }
    this.pendingUpload = {
      bundle,
      opId,
      command,
      requestedRebind: options.rebindLocalSessions,
      archiveReason: options.archiveReason,
    }
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
    try {
      this.persistPendingHandoffState()
    } catch (error) {
      this.pendingUpload = null
      await this.local.rollbackDetach()
      this.handoffValue = {
        direction: 'local_to_server',
        state: 'failed',
        retryable: false,
        message: '无法持久化交接状态，本机已恢复活动权威：' + messageOf(error),
        atWallMs: this.now(),
      }
      this.mapModeLocal()
      this.persistConfig()
      throw new Error('storage_persistence_failed: ' + messageOf(error))
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
      try { this.persistPendingHandoffState() } catch { /* keep the in-memory frozen state */ }
      return 'frozen'
    }
    return this.applyUploadResult(result, options.archiveReason, options.rebindLocalSessions)
  }

  private async applyUploadResult(
    result: CommandResult,
    archiveReason: 'use_server' | 'mode_switch',
    requestedRebind: boolean,
  ): Promise<UploadOutcome> {
    const resultError = commandResultError(result)
    if (resultError !== null) {
      await this.local.rollbackDetach()
      this.pendingUpload = null
      this.clearPersistedPendingHandoffState()
      this.handoffValue = {
        direction: 'local_to_server',
        state: 'rolled_back',
        reason: resultError.code,
        message: '服务器拒绝导入（' + resultError.code + '），本机已恢复活动权威。',
        atWallMs: this.now(),
      }
      this.mapModeLocal()
      this.persistConfig()
      // The local repository restored its pre-freeze active projection. Push
      // it through the renderer immediately so status/read-only state cannot
      // remain pinned to the frozen handoff_pending snapshot after rollback.
      this.pushActiveProjection()
      return 'rolled_back'
    }
    try {
      await this.local.archiveAuthority(archiveReason)
    } catch (error) {
      this.handoffValue = {
        direction: 'local_to_server',
        state: 'frozen',
        retryable: true,
        message: '服务器已接管权威，但本机归档失败：' + messageOf(error) + '；请重试交接。',
        atWallMs: this.now(),
      }
      try { this.persistPendingHandoffState() } catch { /* keep the in-memory frozen state */ }
      return 'frozen'
    }
    return this.finalizeAppliedUpload(requestedRebind, recordOf(commandResultData(result)))
  }

  /**
   * Once the server accepts and the local authority is archived, persist the
   * server mode while the handoff envelope still exists. Only then is it safe
   * to delete the journal: a crash before this write restarts with the pending
   * envelope and reconciles the already-archived local authority.
   */
  private async finalizeAppliedUpload(
    requestedRebind: boolean,
    data: Record<string, unknown> = {},
  ): Promise<UploadOutcome> {
    const provisional: StorageHandoffReport = {
      direction: 'local_to_server',
      state: 'applied',
      requestedRebind,
      rebindReported: requestedRebind,
      message: '服务器已接管权威，正在持久化服务器模式。',
      atWallMs: this.now(),
    }
    this.handoffValue = provisional
    try { this.persistPendingHandoffState() } catch { /* the prior pending envelope still fences recovery */ }
    const previousMode = this.mode
    const previousActiveMode = this.activeMode
    this.mode = 'server'
    try {
      this.persistConfig()
    } catch (error) {
      this.mode = previousMode
      this.activeMode = previousActiveMode
      this.handoffValue = {
        ...provisional,
        state: 'frozen',
        retryable: true,
        message: '服务器已接管权威，但无法持久化服务器模式：' + messageOf(error) + '；请重试完成交接。',
        atWallMs: this.now(),
      }
      try { this.persistPendingHandoffState() } catch { /* keep the in-memory frozen state */ }
      return 'frozen'
    }
    this.activeMode = 'server'
    this.local.setSendEnabled(false)
    this.pendingUpload = null
    this.handoffValue = {
      ...provisional,
      cancelledSessionKinds: this.cancelledSessionKinds(),
      ...(typeof data.importClamped === 'boolean' ? { importClamped: data.importClamped } : {}),
      ...(typeof data.clockSkippedMs === 'number' ? { clockSkippedMs: data.clockSkippedMs } : {}),
      ...(typeof data.epoch === 'number' ? { nextEpoch: data.epoch } : {}),
      message: '上传完成，服务器已接管权威。',
    }
    this.clearPersistedPendingHandoffState()
    this.pushActiveProjection()
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

  private localPortableImportAuthority(fallbackLocalDeviceId?: string): (PortableImportCurrentAuthority & { localDeviceId: string }) | null {
    const projection = this.local.getProjection()
    if (projection === null) return null
    const status = this.local.getStatus()
    const authority = projection.authority as unknown as {
      owner: 'local' | 'server'
      authorityId?: string
      restoreGeneration?: number
      epoch?: number
      state?: 'active' | 'archived' | 'reset'
      stamp?: {
        owner: 'local' | 'server'
        authorityId: string
        restoreGeneration: number
        epoch: number
      }
    }
    const stamp = authority.stamp ?? authority
    if (stamp.authorityId === undefined
      || stamp.restoreGeneration === undefined
      || stamp.epoch === undefined) return null
    const statusState = status.authorityState
    const state = statusState ?? (authority.state === 'active' ? 'active' : 'archived')
    const localDeviceId = status.localDeviceId ?? projection.device?.localDeviceId ?? fallbackLocalDeviceId
    if (localDeviceId === undefined || localDeviceId.length === 0) return null
    return {
      owner: stamp.owner,
      authorityId: stamp.authorityId,
      restoreGeneration: stamp.restoreGeneration,
      epoch: stamp.epoch,
      state,
      revision: projection.revision,
      eventSeq: projection.eventSeq,
      localDeviceId,
    }
  }

  private importReportFromResult(
    result: CommandResult,
    bundle: PortablePetBundleV1,
    before: number,
    restoreGenerationReset: boolean,
    mode: StorageMode,
  ): StorageImportReport {
    const error = commandResultError(result)
    if (error !== null) {
      return { status: 'rejected', mode, errorCode: error.code, message: error.message, restoreGenerationReset }
    }
    const data = recordOf(commandResultData(result))
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
    let remoteOverlay: DeviceLocalOverlay | null = null
    try { remoteOverlay = await remote.loadLocalSettings() } catch { /* best effort */ }
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
    const detachError = commandResultError(result)
    if (detachError !== null) {
      this.handoffValue = {
        direction: 'server_to_local',
        state: 'failed',
        reason: detachError.code,
        retryable: true,
        message: '服务器拒绝分离：' + detachError.message,
        atWallMs: this.now(),
      }
      this.emitStatus()
      return this.status()
    }
    let bundle: PortablePetBundleV1
    try {
      bundle = migratePortablePetBundle(recordOf(commandResultData(result)).bundle)
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
    this.pendingServerBundle = { bundle, remoteOverlay }
    this.handoffValue = {
      direction: 'server_to_local',
      state: 'pending',
      message: '服务器已归档，正在把分离包导入本机…',
      atWallMs: this.now(),
    }
    // Persist the detached bundle before stopping the connection or mutating
    // local state so an app restart can finish this exact handoff.
    this.persistPendingHandoffState()
    await this.stopRemote()
    this.activeMode = 'local'
    this.local.setSendEnabled(true)
    await this.local.loadFenced()
    const applied = await this.importDetachedBundle(bundle)
    if (applied) {
      this.pendingServerBundle = null
      this.clearPersistedPendingHandoffState()
      this.mode = 'local'
      this.mapModeLocal()
      if (remoteOverlay !== null) await this.mergeRemoteOverlayIntoLocal(remoteOverlay)
    } else {
      // Keep the requested mode on server so a restart never starts the stale local authority;
      // the server stays archived and the local projection stays read-only for a retry.
      this.mode = 'server'
      this.activeMode = 'local'
      this.local.setSendEnabled(true)
      this.persistPendingHandoffState()
    }
    this.persistConfig()
    this.pushActiveProjection()
    this.emitStatus()
    return this.status()
  }

  private async importDetachedBundle(bundle: PortablePetBundleV1): Promise<boolean> {
    const current = this.localPortableImportAuthority(bundle.originLocalDeviceId)
    if (current === null) {
      this.handoffValue = {
        direction: 'server_to_local',
        state: 'frozen',
        retryable: true,
        reason: 'authority_not_active',
        message: '本机权威尚未加载，保持只读；服务器保持归档。',
        atWallMs: this.now(),
      }
      return false
    }
    const planned = planPortableImportPlan({
      bundle,
      current,
      wallNowMs: this.now(),
      allowClamp: false,
      rebindLocalSessions: true,
      destinationLocalDeviceId: current.localDeviceId,
      exactHandoff: true,
      allowServerOwner: true,
      adoptIncomingAuthority: current.state === 'archived',
    })
    if (planned.ok === false) {
      this.handoffValue = {
        direction: 'server_to_local',
        state: 'frozen',
        retryable: true,
        reason: planned.code,
        message: '服务器分离包校验失败，本机保持只读：' + planned.message,
        atWallMs: this.now(),
      }
      return false
    }
    const plan = planned.plan
    const plannedBundle: PortablePetBundleV1 = {
      ...bundle,
      engine: plan.engine,
      shared: plan.engine.save,
    }
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
    const projection = await this.local.importPortableBundle(plannedBundle, {
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
      nextEpoch: plan.nextEpoch,
      restoreGenerationBefore: current.restoreGeneration,
      restoreGenerationAfter: plan.restoreGeneration,
      requestedRebind: true,
      rebindReported: true,
      cancelledSessionKinds: plan.cancelledSessionKinds,
      ...(plan.importClamped ? { importClamped: true, clockSkippedMs: plan.clockSkippedMs } : {}),
      message: '服务器已归档，本机已接管权威。',
      atWallMs: this.now(),
    }
    return true
  }

  private async retryServerImport(): Promise<void> {
    const pending = this.pendingServerBundle
    if (pending === null) return
    const applied = await this.importDetachedBundle(pending.bundle)
    if (applied) {
      await this.stopRemote()
      if (pending.remoteOverlay !== null) await this.mergeRemoteOverlayIntoLocal(pending.remoteOverlay)
      this.pendingServerBundle = null
      this.mode = 'local'
      this.mapModeLocal()
      this.clearPersistedPendingHandoffState()
      this.persistConfig()
      this.pushActiveProjection()
    } else {
      // The server remains archived. Persist the requested server mode and
      // the pending bundle so a later retry/restart cannot start a stale
      // local writer over the fenced projection.
      this.mode = 'server'
      this.activeMode = 'local'
      this.local.setSendEnabled(true)
      this.persistPendingHandoffState()
      this.persistConfig()
    }
    this.emitStatus()
  }

  private restoredHandoffReport(value: unknown, fallbackDirection: StorageHandoffDirection): StorageHandoffReport {
    const record = recordOf(value)
    const direction: StorageHandoffDirection = record.direction === 'local_to_server' || record.direction === 'server_to_local' || record.direction === 'none'
      ? record.direction
      : fallbackDirection
    let state: StorageHandoffState | null = null
    if (record.state === 'idle' || record.state === 'pending' || record.state === 'applied' || record.state === 'rolled_back' || record.state === 'frozen' || record.state === 'failed') {
      state = record.state
    }
    if (state === null) {
      return {
        direction: fallbackDirection,
        state: 'frozen',
        retryable: true,
        message: '检测到未完成的权威交接，正在重启对账…',
      }
    }
    const report: StorageHandoffReport = { direction, state }
    for (const key of ['message', 'reason'] as const) {
      if (typeof record[key] === 'string') report[key] = record[key]
    }
    for (const key of ['atWallMs', 'clockSkippedMs', 'nextEpoch', 'restoreGenerationBefore', 'restoreGenerationAfter'] as const) {
      if (typeof record[key] === 'number' && Number.isSafeInteger(record[key])) report[key] = record[key]
    }
    for (const key of ['requestedRebind', 'rebindReported', 'importClamped', 'retryable'] as const) {
      if (typeof record[key] === 'boolean') report[key] = record[key]
    }
    if (Array.isArray(record.cancelledSessionKinds) && record.cancelledSessionKinds.every(kind => typeof kind === 'string')) {
      report.cancelledSessionKinds = [...record.cancelledSessionKinds] as string[]
    }
    return report
  }

  /** Restore only the non-secret handoff envelope and authenticated bundle copies. */
  private restorePendingHandoffState(): void {
    if (existsSync(this.pendingHandoffPath) === false) return
    try {
      const raw = recordOf(JSON.parse(readFileSync(this.pendingHandoffPath, 'utf8')) as unknown)
      if (raw.format !== STORAGE_HANDOFF_FORMAT || raw.schemaVersion !== STORAGE_HANDOFF_SCHEMA_VERSION) {
        throw new Error('unsupported handoff journal')
      }
      if (raw.kind === 'local_to_server') {
        const upload = recordOf(raw.upload)
        const bundle = migratePortablePetBundle(upload.bundle)
        if (typeof upload.opId !== 'string' || upload.opId.length === 0) throw new Error('missing handoff opId')
        const commandType = upload.commandType
        if (commandType !== 'admin.importPortableBundle' && commandType !== 'admin.resumeServer') {
          throw new Error('invalid handoff command')
        }
        const requestedRebind = upload.rebindLocalSessions === true
        const payloadBase = {
          bundle,
          ...(upload.allowClamp === true ? { allowClamp: true as const } : {}),
          ...(requestedRebind ? { rebindLocalSessions: true as const } : {}),
        }
        let command: PendingUpload['command']
        if (commandType === 'admin.resumeServer') {
          if (typeof upload.expectedEpoch !== 'number' || Number.isSafeInteger(upload.expectedEpoch) === false || upload.expectedEpoch < 0) {
            throw new Error('invalid resume epoch')
          }
          command = { type: 'admin.resumeServer', payload: { ...payloadBase, expectedEpoch: upload.expectedEpoch } }
        } else {
          command = { type: 'admin.importPortableBundle', payload: payloadBase }
        }
        this.pendingUpload = {
          bundle,
          opId: upload.opId,
          command,
          requestedRebind,
          archiveReason: upload.archiveReason === 'use_server' ? 'use_server' : 'mode_switch',
        }
        this.handoffValue = this.restoredHandoffReport(raw.handoff, 'local_to_server')
        return
      }
      if (raw.kind === 'server_to_local') {
        const bundle = migratePortablePetBundle(raw.bundle)
        let remoteOverlay: DeviceLocalOverlay | null = null
        const overlayCandidate = raw.remoteOverlay
        if (overlayCandidate !== undefined && overlayCandidate !== null) {
          assertDeviceLocalOverlay(overlayCandidate)
          remoteOverlay = clone(overlayCandidate)
        }
        this.pendingServerBundle = { bundle, remoteOverlay }
        this.handoffValue = this.restoredHandoffReport(raw.handoff, 'server_to_local')
        return
      }
      throw new Error('unknown handoff direction')
    } catch {
      this.pendingUpload = null
      this.pendingServerBundle = null
      try { rmSync(this.pendingHandoffPath, { force: true }) } catch { /* corrupt journal is not authoritative */ }
    }
  }

  /** Durably record enough state to resume the exact operation after restart. */
  private persistPendingHandoffState(): void {
    if (this.pendingUpload !== null) {
      const pending = this.pendingUpload
      const command = pending.command
      atomicWrite(this.pendingHandoffPath, JSON.stringify({
        format: STORAGE_HANDOFF_FORMAT,
        schemaVersion: STORAGE_HANDOFF_SCHEMA_VERSION,
        kind: 'local_to_server',
        upload: {
          bundle: pending.bundle,
          opId: pending.opId,
          commandType: command.type,
          allowClamp: command.payload.allowClamp === true,
          rebindLocalSessions: pending.requestedRebind,
          archiveReason: pending.archiveReason,
          ...(command.type === 'admin.resumeServer' ? { expectedEpoch: command.payload.expectedEpoch } : {}),
        },
        handoff: clone(this.handoffValue),
      }, null, 2))
      return
    }
    if (this.pendingServerBundle !== null) {
      atomicWrite(this.pendingHandoffPath, JSON.stringify({
        format: STORAGE_HANDOFF_FORMAT,
        schemaVersion: STORAGE_HANDOFF_SCHEMA_VERSION,
        kind: 'server_to_local',
        bundle: this.pendingServerBundle.bundle,
        remoteOverlay: this.pendingServerBundle.remoteOverlay,
        handoff: clone(this.handoffValue),
      }, null, 2))
      return
    }
    this.clearPersistedPendingHandoffState()
  }

  private clearPersistedPendingHandoffState(): void {
    try { rmSync(this.pendingHandoffPath, { force: true }) } catch { /* the next startup will validate and clear it */ }
  }

  private async reconcilePendingHandoffAfterStartup(): Promise<void> {
    if (this.pendingUpload !== null) {
      const localState = this.local.getStatus().authorityState
      if (localState === 'handoff_pending') {
        if (await this.ensurePendingUploadRemote() === false) return
        const remote = this.remote
        const pending = this.pendingUpload
        if (remote === null || pending === null) return
        let result: CommandResult
        try {
          result = await remote.command(pending.command, { opId: pending.opId })
        } catch (error) {
          this.handoffValue = {
            ...this.handoffValue,
            direction: 'local_to_server',
            state: 'frozen',
            retryable: true,
            message: '重启对账时上传结果未知：' + messageOf(error) + '；本机保持冻结。',
            atWallMs: this.now(),
          }
          try { this.persistPendingHandoffState() } catch { /* keep the in-memory frozen state */ }
          return
        }
        await this.applyUploadResult(result, pending.archiveReason, pending.requestedRebind)
        return
      }
      if (localState === 'archived') {
        await this.finalizeArchivedPendingUpload()
        return
      }
      // The local authority is active, so the uncertain upload no longer owns
      // a fenced copy. Drop a stale journal instead of replaying it.
      this.pendingUpload = null
      this.clearPersistedPendingHandoffState()
      this.mode = 'local'
      this.mapModeLocal()
      this.persistConfig()
      return
    }
    if (this.pendingServerBundle !== null) {
      await this.retryServerImport()
    }
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
